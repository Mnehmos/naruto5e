import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";
import { actorAC } from "./rules/actor.js";
import { hasBuffAdvantage } from "./rules/buffs.js";

/**
 * Phase B — technique disposition + effect-branch tests.
 *
 * The bug we are closing here is the SILENT NO-OP path in castJutsu:
 * non-healing utility/buff techniques used to charge chakra and return with
 * zero IR effect.  Now every cast lands in exactly one of four disposition
 * buckets: commit (effect applied), reject_inert (gate rejected, no cost),
 * no_op_spoken (resource refunded by default, explicit noop IR), unknown
 * (not reached in this suite — that's Phase C).
 *
 * The buff branch grew real effects: AC bonus, temp HP, condition grant,
 * advantage flag, aura, and a generic mod bag.  Re-casting the same buff
 * refreshes its slot (matching the concentration replacement rule).
 *
 * Invariant pinned: healing techniques (regression bug_1780153780675) MUST
 * keep working — see regression.test.ts for the canonical Healing Hands case
 * plus the additional case here.
 */

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "tdr"; // technique-disposition room

beforeEach(() => {
  engine = createEngine({ dbDriver: "memory" }).engine;
});

function run(type: string, params: Record<string, unknown>, actorId?: string) {
  return engine.resolveIntent({
    intentId: `i_${type}_${Math.random()}`,
    roomId: ROOM,
    type,
    params,
    actorId,
    ...base,
  } as any);
}

function mkPC(name: string): string {
  const r = run("character_create", {
    name,
    clan: "Non-Clan",
    className: "Taijutsu Specialist",
    background: "Hard Worker",
    abilities: { method: "manual", scores: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 } },
    abilityChoices: ["str", "dex", "con"],
    bgAbilityChoice: "str",
    clanSkillChoices: ["Athletics", "Intimidation"],
    classSkillChoices: ["Acrobatics", "Survival"],
  }) as any;
  if (r.status !== "resolved") throw new Error("mkPC rejected: " + JSON.stringify(r.reason));
  return r.events[0].data.character.id as string;
}

function defineJutsu(extras: Record<string, any>): string {
  const id = `td-${Math.random().toString(36).slice(2, 8)}`;
  engine.content.addJutsu({
    id,
    name: extras.name ?? id,
    classification: "Ninjutsu",
    rank: "E",
    castingTime: "1 Action",
    range: "Self",
    duration: "1 minute",
    components: [],
    cost: 2,
    keywords: [],
    description: "Test jutsu.",
    atHigherRanks: null,
    ...extras,
  } as any);
  return id;
}

// ---------------------------------------------------------------------------
// no-op disposition
// ---------------------------------------------------------------------------

describe("Phase B — silent no-op replaced with technique_noop_spoken (with refund)", () => {
  it("a utility jutsu with no observable effect emits noop_spoken and refunds chakra", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({ name: "Hollow Seal", effect: { delivery: "utility" } });
    const before = engine.getEntity("characters", caster) as any;
    const ckBefore = before.chakra.current;
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r.status).toBe("resolved");
    const noop = r.events.find((e: any) => e.type === "technique_noop_spoken");
    expect(noop).toBeTruthy();
    expect(noop.data.disposition).toBe("no_op_spoken");
    expect(noop.data.refunded).toBe(true);
    expect(noop.data.reason).toBe("utility_no_observable_effect");
    // no damage / heal / condition / buff events landed
    expect(r.events.find((e: any) => e.type === "damage")).toBeFalsy();
    expect(r.events.find((e: any) => e.type === "heal")).toBeFalsy();
    expect(r.events.find((e: any) => e.type === "condition")).toBeFalsy();
    expect(r.events.find((e: any) => e.type === "buff")).toBeFalsy();
    // chakra was refunded
    const after = engine.getEntity("characters", caster) as any;
    expect(after.chakra.current).toBe(ckBefore);
  });

  it("a no-effect jutsu with `nonRefundable: true` emits noop_spoken WITHOUT refund", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({
      name: "Bound Seal",
      effect: { delivery: "utility" },
      nonRefundable: true,
    });
    const before = engine.getEntity("characters", caster) as any;
    const ckBefore = before.chakra.current;
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r.status).toBe("resolved");
    const noop = r.events.find((e: any) => e.type === "technique_noop_spoken");
    expect(noop).toBeTruthy();
    expect(noop.data.refunded).toBe(false);
    expect(noop.data.nonRefundable).toBe(true);
    const after = engine.getEntity("characters", caster) as any;
    expect(after.chakra.current).toBe(ckBefore - 2);
  });

  it("a damage jutsu with NO targets also emits noop_spoken (with refund)", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({
      name: "Targetless Bolt",
      effect: { delivery: "attack", damage: { dice: "1d8", type: "fire" } },
    });
    const before = engine.getEntity("characters", caster) as any;
    const ckBefore = before.chakra.current;
    const r = run("cast", { jutsu: jId, force: true }, caster) as any; // no targets passed
    expect(r.status).toBe("resolved");
    const noop = r.events.find((e: any) => e.type === "technique_noop_spoken");
    expect(noop).toBeTruthy();
    expect(noop.data.reason).toBe("no_targets_specified");
    expect(noop.data.refunded).toBe(true);
    const after = engine.getEntity("characters", caster) as any;
    expect(after.chakra.current).toBe(ckBefore);
  });
});

// ---------------------------------------------------------------------------
// effect branches
// ---------------------------------------------------------------------------

describe("Phase B — buff effect branches", () => {
  it("AC bonus: caster's AC reflects the +2 buff after cast", () => {
    const caster = mkPC("Caster");
    const baseAc = (engine.getEntity("characters", caster) as any).ac;
    const jId = defineJutsu({
      name: "Stone Armor",
      effect: { delivery: "utility", buff: { name: "Stone Armor", kind: "ac_bonus", mod: { ac: 2 } } },
    });
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r.status).toBe("resolved");
    const buff = r.events.find((e: any) => e.type === "buff");
    expect(buff).toBeTruthy();
    expect(buff.data.kind).toBe("ac_bonus");
    expect(buff.data.mod.ac).toBe(2);
    expect(buff.data.disposition).toBe("commit");
    // confirm AC actually reads as base + 2 (via the helper)
    const doc = engine.getEntity("characters", caster) as any;
    expect(actorAC(doc)).toBe(baseAc + 2);
    // no noop fired because the buff is observable
    expect(r.events.find((e: any) => e.type === "technique_noop_spoken")).toBeFalsy();
  });

  it("temp HP: caster gains the rolled temp HP", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({
      name: "Spirit Shield",
      effect: {
        delivery: "utility",
        buff: { name: "Spirit Shield", kind: "temp_hp", tempHpAmount: 8 },
      },
    });
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r.status).toBe("resolved");
    const buff = r.events.find((e: any) => e.type === "buff");
    expect(buff).toBeTruthy();
    expect(buff.data.tempHp).toBe(8);
    const after = engine.getEntity("characters", caster) as any;
    expect(after.hp.temp).toBe(8);
  });

  it("condition grant: caster gains Invisible from the buff", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({
      name: "Cloak of Shadows",
      effect: {
        delivery: "utility",
        buff: { name: "Cloak of Shadows", kind: "condition_grant", conditionGranted: "Invisible", rounds: 10 },
      },
    });
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r.status).toBe("resolved");
    const cond = r.events.find((e: any) => e.type === "condition" && e.data.condition === "Invisible");
    expect(cond).toBeTruthy();
    expect(cond.data.granted).toBe(true);
    const after = engine.getEntity("characters", caster) as any;
    expect(after.conditions).toContain("Invisible");
  });

  it("advantage flag: buff records advantageOn for downstream check readers", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({
      name: "Sharpened Senses",
      effect: {
        delivery: "utility",
        buff: { name: "Sharpened Senses", kind: "advantage_flag", advantageOn: ["perception", "investigation"] },
      },
    });
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r.status).toBe("resolved");
    const buff = r.events.find((e: any) => e.type === "buff");
    expect(buff).toBeTruthy();
    expect(buff.data.advantageOn).toEqual(["perception", "investigation"]);
    // active buff is recorded on the doc
    const after = engine.getEntity("characters", caster) as any;
    const entry = after.activeBuffs.find((b: any) => b.name === "Sharpened Senses");
    expect(entry).toBeTruthy();
    expect(entry.advantageOn).toContain("perception");
    // helper exposes the flag
    expect(hasBuffAdvantage(after, "perception")).toBe(true);
    expect(hasBuffAdvantage(after, "athletics")).toBe(false);
  });

  it("aura: buff carries aura radius + grants", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({
      name: "Aura of Resolve",
      effect: {
        delivery: "utility",
        buff: {
          name: "Aura of Resolve",
          kind: "aura",
          aura: { radius: 10, shape: "sphere", grants: { saveBonus: 1 } },
        },
      },
    });
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r.status).toBe("resolved");
    const buff = r.events.find((e: any) => e.type === "buff");
    expect(buff).toBeTruthy();
    expect(buff.data.aura).toBeDefined();
    expect(buff.data.aura.radius).toBe(10);
    expect(buff.data.aura.grants.saveBonus).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// refresh semantics
// ---------------------------------------------------------------------------

describe("Phase B — re-casting a buff refreshes rather than stacks", () => {
  it("two casts of the same buff yield one activeBuffs entry", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({
      name: "Stone Armor",
      effect: { delivery: "utility", buff: { name: "Stone Armor", kind: "ac_bonus", mod: { ac: 2 } } },
    });
    // give plenty of chakra
    const coll = (engine as any).store.collection("characters");
    const d = coll.get(caster);
    d.chakra.current = 99;
    d.chakra.max = 99;
    coll.put(d);

    run("cast", { jutsu: jId, force: true }, caster);
    const r2 = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r2.status).toBe("resolved");
    // second cast emits buff_refreshed (not buff)
    expect(r2.events.find((e: any) => e.type === "buff_refreshed")).toBeTruthy();
    const after = engine.getEntity("characters", caster) as any;
    const entries = after.activeBuffs.filter((b: any) => b.name === "Stone Armor");
    expect(entries.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// disposition tagging on every terminal event
// ---------------------------------------------------------------------------

describe("Phase B — disposition tagging", () => {
  it("commit: cast IR carries disposition='commit' when the technique resolves", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({
      name: "Useful Buff",
      effect: { delivery: "utility", buff: { name: "Useful Buff", kind: "ac_bonus", mod: { ac: 1 } } },
    });
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r.status).toBe("resolved");
    const castEv = r.events.find((e: any) => e.type === "cast");
    expect(castEv).toBeTruthy();
    expect(castEv.data.disposition).toBe("commit");
  });

  it("no_op_spoken: every utility-no-effect cast emits the disposition explicitly", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({ name: "Hollow Seal", effect: { delivery: "utility" } });
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    const noop = r.events.find((e: any) => e.type === "technique_noop_spoken");
    expect(noop.data.disposition).toBe("no_op_spoken");
  });

  it("reject_inert: an affordability rejection carries the rule (legacy + new alias)", () => {
    const caster = mkPC("Caster");
    const jId = defineJutsu({
      name: "Costly Effect",
      cost: 9999,
      effect: { delivery: "utility", buff: { name: "Costly Effect", kind: "ac_bonus" } },
    });
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r.status).toBe("rejected");
    // The chakra binding preserves the legacy rule string
    expect(r.reason.rule).toBe("chakra_affordability");
  });
});

// ---------------------------------------------------------------------------
// healing regression — confirm Phase B did not break the canonical heal path
// ---------------------------------------------------------------------------

describe("Phase B — healing techniques still heal (regression hardening)", () => {
  it("healing-hands self-heals when no targets are passed", () => {
    const medic = mkPC("Medic");
    const coll = (engine as any).store.collection("characters");
    const d = coll.get(medic);
    d.hp.current = 1;
    coll.put(d);

    const r = run("cast", { jutsu: "healing-hands", force: true }, medic) as any;
    expect(r.status).toBe("resolved");
    const healEv = r.events.find((e: any) => e.type === "heal");
    expect(healEv).toBeTruthy();
    expect(healEv.data.target).toBe(medic);
    // and no noop event fired
    expect(r.events.find((e: any) => e.type === "technique_noop_spoken")).toBeFalsy();
    const after = engine.getEntity("characters", medic) as any;
    expect(after.hp.current).toBeGreaterThan(1);
  });

  it("a hybrid jutsu (heal + buff) commits with no noop event", () => {
    const caster = mkPC("Healer");
    const jId = defineJutsu({
      name: "Bracing Hands",
      effect: {
        delivery: "utility",
        healing: { dice: "1d4" },
        buff: { name: "Bracing Hands", kind: "ac_bonus", mod: { ac: 1 } },
      },
    });
    const r = run("cast", { jutsu: jId, force: true }, caster) as any;
    expect(r.status).toBe("resolved");
    expect(r.events.find((e: any) => e.type === "heal")).toBeTruthy();
    expect(r.events.find((e: any) => e.type === "buff")).toBeTruthy();
    expect(r.events.find((e: any) => e.type === "technique_noop_spoken")).toBeFalsy();
  });
});
