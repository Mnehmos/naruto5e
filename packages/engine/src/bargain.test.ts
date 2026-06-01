import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

/**
 * Phase C — bargain surface tests.
 *
 * Pins the invariants:
 *  - Bargain commits grant AND price atomically. No silently free deals.
 *  - If the price would NOT log, the bargain is rejected; nothing posts.
 *  - A bargain CAN grant a foreign resource (+entry) — the only doorway
 *    between rulesets. After acquisition, foreign-ruleset native teaching
 *    takes over (verified here by debiting that pool via cast).
 *  - call_favor fires from BOTH an NPC action AND the world-tick.
 *  - incur_debt opens a debt; discharge_debt closes it.
 *  - Every emitted bargain IR carries a `disposition` field.
 */

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "bargain-room";

function run(type: string, params: Record<string, unknown>, actorId?: string, roomId = ROOM) {
  return engine.resolveIntent({ intentId: `i_${type}_${Math.random()}`, roomId, actorId, type, params, ...base } as any);
}

function pc(): string {
  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];
  const r = run("character_create", {
    name: "Sasuke",
    clan: "Non-Clan",
    className: "Ninjutsu Specialist",
    abilities: { method: "manual", scores: { str: 10, dex: 14, con: 12, int: 15, wis: 12, cha: 10 } },
    classSkillChoices: broad,
    clanSkillChoices: broad,
    abilityChoices: ["int", "dex", "con"],
  }) as any;
  if (r.status !== "resolved") throw new Error("character_create rejected: " + JSON.stringify(r.reason));
  return r.events[0].data.character.id as string;
}

beforeEach(() => {
  engine = createEngine({ dbDriver: "memory", seedSalt: "bargain-fixed" }).engine;
});

describe("Phase C — strike_bargain", () => {
  it("commits grant AND price atomically and emits a `bargain` IR with disposition='commit'", () => {
    const c = pc();
    // seed reputation so we can spend some
    run("grant_reputation", { authorityId: "leaf_village", amount: 30 }, c);
    run("grant_favor", { authorityId: "leaf_village", amount: 5 }, c);

    const r = run(
      "strike_bargain",
      {
        counterparty: "leaf_village",
        grants: { reputation: 10, access: "Chunin exam slot" },
        price: { favor: 3 },
        grantsDesc: "an exam slot + +10 standing",
        priceDesc: "3 favor",
      },
      c,
    ) as any;
    expect(r.status).toBe("resolved");
    const ev = (r.events as any[]).find((e) => e.type === "bargain");
    expect(ev).toBeDefined();
    expect(ev.data.disposition).toBe("commit");
    expect(ev.data.counterparty).toBe("leaf_village");

    const ledger = run("get_ledgers", {}, c) as any;
    const leaf = ledger.events[0].data.ledgers.find((l: any) => l.authorityId === "leaf_village");
    expect(leaf.favor).toBe(5 - 3); // price posted
    expect(leaf.reputation).toBe(30 + 10); // grant posted
    expect(leaf.bargains.length).toBe(1);
    expect(leaf.bargains[0].pricePosted).toBe(true);
  });

  it("rejects with disposition='reject_inert' when the price side is unaffordable; nothing posts", () => {
    const c = pc();
    run("grant_reputation", { authorityId: "leaf_village", amount: 20 }, c);
    // only 0 favor — bargain demands 3
    const r = run(
      "strike_bargain",
      {
        counterparty: "leaf_village",
        grants: { reputation: 10 },
        price: { favor: 3 },
      },
      c,
    ) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("insufficient_favor");
    // disposition rides on the rejection reason (engine drops IR on reject; the
    // inert state surfaces via reason.values per the atomic invariant)
    expect(r.reason.values.disposition).toBe("reject_inert");
    expect(r.reason.values.bargainOp).toBe("strike_bargain");

    // nothing posted: reputation is still 20
    const ledger = run("get_ledgers", {}, c) as any;
    const leaf = ledger.events[0].data.ledgers.find((l: any) => l.authorityId === "leaf_village");
    expect(leaf.reputation).toBe(20);
    expect(leaf.favor).toBe(0);
    expect(leaf.bargains?.length ?? 0).toBe(0);
  });

  it("rejects a 'silently free' deal — bargain requires BOTH a grant and a price side", () => {
    const c = pc();
    const r = run(
      "strike_bargain",
      {
        counterparty: "leaf_village",
        grants: { reputation: 10 },
        price: {}, // no price
      },
      c,
    ) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("bargain_requires_both_sides");
  });

  it("price=debt opens a debt on the ledger; grant posts; pricePosted=true", () => {
    const c = pc();
    const r = run(
      "strike_bargain",
      {
        counterparty: "konoha_underground",
        grants: { reputation: 15, info: "the location of the hidden cache" },
        price: { debt: "owe a favor: silence about the source" },
      },
      c,
    ) as any;
    expect(r.status).toBe("resolved");
    const ev = (r.events as any[]).find((e) => e.type === "bargain");
    expect(ev.data.disposition).toBe("commit");
    expect(ev.data.debtId).toBeDefined();

    const ledger = run("get_ledgers", {}, c) as any;
    const led = ledger.events[0].data.ledgers.find((l: any) => l.authorityId === "konoha_underground");
    expect(led.reputation).toBe(15);
    expect(led.debts.length).toBe(1);
    expect(led.debts[0].discharged).toBe(false);
    expect(led.bargains[0].priceBreakdown.debt).toBe(led.debts[0].id);
  });
});

describe("Phase C — call_favor", () => {
  it("fires from an NPC action (calledBy='npc') and discharges a logged debt", () => {
    const c = pc();
    // open a debt via strike_bargain
    const sb = run(
      "strike_bargain",
      {
        counterparty: "elder_council",
        grants: { ryo: 500 },
        price: { debt: "be on call for an off-screen mission" },
      },
      c,
    ) as any;
    const debtId = sb.events.find((e: any) => e.type === "bargain").data.debtId;
    expect(debtId).toBeDefined();

    // an NPC calls the favor
    const r = run("call_favor", { counterparty: "elder_council", debtId, calledBy: "npc" }, c) as any;
    expect(r.status).toBe("resolved");
    const ev = r.events.find((e: any) => e.type === "bargain");
    expect(ev.data.disposition).toBe("commit");
    expect(ev.data.op).toBe("call_favor");
    expect(ev.data.calledBy).toBe("npc");

    // debt is now discharged
    const led = run("get_ledgers", {}, c) as any;
    const e = led.events[0].data.ledgers.find((l: any) => l.authorityId === "elder_council");
    const d = e.debts.find((x: any) => x.id === debtId);
    expect(d.discharged).toBe(true);
    expect(d.dischargedReason).toBe("called");
  });

  it("fires from world-tick on a large rest, calling outstanding debts", () => {
    const c = pc();
    // open a debt
    const sb = run(
      "strike_bargain",
      {
        counterparty: "elder_council",
        grants: { ryo: 500 },
        price: { debt: "owe a clandestine errand" },
      },
      c,
    ) as any;
    const debtId = sb.events.find((e: any) => e.type === "bargain").data.debtId;

    // a downtime (= "large") rest should trigger the world-tick to call the debt
    const r = run("rest", { type: "downtime" }, c) as any;
    expect(r.status).toBe("resolved");
    // either rest emits the tick IR or tick_run does — at minimum the debt is discharged
    const led = run("get_ledgers", {}, c) as any;
    const e = led.events[0].data.ledgers.find((l: any) => l.authorityId === "elder_council");
    const d = e.debts.find((x: any) => x.id === debtId);
    expect(d.discharged).toBe(true);
    expect(d.dischargedReason).toBe("called_by_tick");
  });

  it("fires directly from tick_run with calledBy='world_tick'", () => {
    const c = pc();
    const sb = run(
      "strike_bargain",
      {
        counterparty: "elder_council",
        grants: { ryo: 500 },
        price: { debt: "owe a favor (tick_run path)" },
      },
      c,
    ) as any;
    const debtId = sb.events.find((e: any) => e.type === "bargain").data.debtId;

    const r = run("tick_run", { magnitude: "large" }, c) as any;
    expect(r.status).toBe("resolved");
    const tick = r.events.find((e: any) => e.type === "tick").data.tick;
    expect(tick.consequenceDeltas.debtsCalled.length).toBeGreaterThan(0);
    expect(tick.consequenceDeltas.debtsCalled.find((d: any) => d.debtId === debtId)).toBeDefined();

    const led = run("get_ledgers", {}, c) as any;
    const e = led.events[0].data.ledgers.find((l: any) => l.authorityId === "elder_council");
    expect(e.debts.find((d: any) => d.id === debtId).discharged).toBe(true);
  });

  it("call_favor without a debtId spends favor (the generic favor-call); rejects if insufficient", () => {
    const c = pc();
    run("grant_favor", { authorityId: "leaf_village", amount: 4 }, c);

    const r = run("call_favor", { counterparty: "leaf_village", amount: 2, calledBy: "npc" }, c) as any;
    expect(r.status).toBe("resolved");
    const ev = r.events.find((e: any) => e.type === "bargain");
    expect(ev.data.disposition).toBe("commit");
    expect(ev.data.favorLeft).toBe(2);

    const reject = run("call_favor", { counterparty: "leaf_village", amount: 99, calledBy: "npc" }, c) as any;
    expect(reject.status).toBe("rejected");
    expect(reject.reason.rule).toBe("insufficient_favor");
  });
});

describe("Phase C — incur_debt + discharge_debt", () => {
  it("incur_debt opens an undischarged debt and emits commit disposition", () => {
    const c = pc();
    const r = run("incur_debt", { counterparty: "fence_master", terms: "owe a stolen relic, returnable" }, c) as any;
    expect(r.status).toBe("resolved");
    const ev = r.events.find((e: any) => e.type === "bargain");
    expect(ev.data.disposition).toBe("commit");
    expect(ev.data.op).toBe("incur_debt");

    const led = run("get_ledgers", {}, c) as any;
    const e = led.events[0].data.ledgers.find((l: any) => l.authorityId === "fence_master");
    expect(e.debts.length).toBe(1);
    expect(e.debts[0].discharged).toBe(false);
  });

  it("discharge_debt closes an open debt; second discharge is no_op_spoken", () => {
    const c = pc();
    const r = run("incur_debt", { counterparty: "fence_master", terms: "owe a stolen relic" }, c) as any;
    const debtId = r.events.find((e: any) => e.type === "bargain").data.debtId;

    const d1 = run("discharge_debt", { counterparty: "fence_master", debtId, reason: "forgiven" }, c) as any;
    expect(d1.status).toBe("resolved");
    expect(d1.events.find((e: any) => e.type === "bargain").data.disposition).toBe("commit");

    const d2 = run("discharge_debt", { counterparty: "fence_master", debtId, reason: "forgiven" }, c) as any;
    expect(d2.status).toBe("resolved");
    const ev2 = d2.events.find((e: any) => e.type === "bargain");
    expect(ev2.data.disposition).toBe("no_op_spoken");
  });
});

describe("Phase C — cross-ruleset acquisition (foreign resource grant)", () => {
  it("a bargain can grant a FOREIGN RESOURCE (+entry); after acquisition, native teaching takes over", () => {
    const c = pc();
    // Register a foreign resource as if a second ruleset (e.g. Bastion) declared it.
    engine.content.addResource({
      id: "grace",
      label: "Grace",
      firstLevelFormula: "die+con",
      subsequentFormula: "avg+con",
      defaultDie: 8,
    } as any);

    run("grant_favor", { authorityId: "abbey", amount: 4 }, c);
    const r = run(
      "strike_bargain",
      {
        counterparty: "abbey",
        grants: { foreignResource: { id: "grace", amount: 5 }, info: "an opening of a foreign tradition" },
        price: { favor: 2 },
      },
      c,
    ) as any;
    expect(r.status).toBe("resolved");

    // bargain IR + foreign_resource_grant IR both commit
    const evs = r.events as any[];
    const bargainEv = evs.find((e) => e.type === "bargain");
    expect(bargainEv.data.disposition).toBe("commit");
    const grantEv = evs.find((e) => e.type === "foreign_resource_grant");
    expect(grantEv).toBeDefined();
    expect(grantEv.data.disposition).toBe("commit");
    expect(grantEv.data.resource).toBe("grace");
    expect(grantEv.data.amount).toBe(5);

    // the +entry actually credited the foreign pool on the character
    const sheet = engine.getEntity("characters", c) as any;
    expect(sheet.resources.grace).toBeDefined();
    expect(sheet.resources.grace.current).toBe(5);

    // After acquisition, the foreign ruleset's NATIVE teaching takes over —
    // here that means: spending the foreign resource through the normal
    // generic verb works (no bargain seam needed for subsequent use).
    const spend = run("character_spend_resource", { resourceId: "grace", amount: 2 }, c) as any;
    expect(spend.status).toBe("resolved");
    const after = engine.getEntity("characters", c) as any;
    expect(after.resources.grace.current).toBe(3);
  });

  it("foreign resource grant is rejected when the resource is not registered in the content pack", () => {
    const c = pc();
    run("grant_favor", { authorityId: "void_court", amount: 4 }, c);
    const r = run(
      "strike_bargain",
      {
        counterparty: "void_court",
        grants: { foreignResource: { id: "void_essence_NEVER_REGISTERED", amount: 3 }, info: "a glimpse" },
        price: { favor: 1 },
      },
      c,
    ) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("unknown_resource");
  });
});

describe("Phase C — disposition is first-class on every bargain IR", () => {
  it("every emitted bargain IR carries a `disposition` field on its data", () => {
    const c = pc();
    run("grant_favor", { authorityId: "leaf_village", amount: 5 }, c);

    // commit
    const ok = run(
      "strike_bargain",
      { counterparty: "leaf_village", grants: { reputation: 5 }, price: { favor: 2 } },
      c,
    ) as any;
    expect(ok.events.find((e: any) => e.type === "bargain").data.disposition).toBe("commit");

    // reject_inert (insufficient favor) — disposition rides on reason.values
    const reject = run(
      "strike_bargain",
      { counterparty: "leaf_village", grants: { reputation: 5 }, price: { favor: 999 } },
      c,
    ) as any;
    expect(reject.status).toBe("rejected");
    expect(reject.reason.values.disposition).toBe("reject_inert");

    // commit (incur_debt)
    const incur = run("incur_debt", { counterparty: "x", terms: "y" }, c) as any;
    expect(incur.events.find((e: any) => e.type === "bargain").data.disposition).toBe("commit");
  });
});
