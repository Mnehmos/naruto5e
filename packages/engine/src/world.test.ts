import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "world";
function run(type: string, params: Record<string, unknown>, actorId?: string) {
  return engine.resolveIntent({ intentId: `i_${Math.random()}`, roomId: ROOM, actorId, type, params, ...base } as any);
}
function pc() {
  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];
  const r = run("character_create", { name: "Kabuto", clan: "Non-Clan", className: "Medical-Nin", abilities: { method: "manual", scores: { str: 10, dex: 14, con: 12, int: 15, wis: 13, cha: 12 } }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["int", "wis", "con"] }) as any;
  return r.events[0].data.character.id as string;
}
function rep(charId: string, authorityId: string): number {
  const l = engine.getEntity("standings", `${charId}:${authorityId}`) as any;
  return l?.reputation ?? 0;
}
beforeEach(() => {
  engine = createEngine({ dbDriver: "memory", seedSalt: "world-fixed" }).engine;
});

describe("Phase 7 — npc memory <-> Standing", () => {
  it("an NPC interaction with a standingDelta moves the authority ledger", () => {
    const c = pc();
    run("npc_create", { id: "rin", name: "Sensei Rin", authorityId: "leaf_village" });
    const before = rep(c, "leaf_village");
    const r = run("npc_interact", { npcId: "rin", actorId: c, beat: "saved her student", importance: "defining", standingDelta: { authorityId: "leaf_village", reputation: 10 } }, c) as any;
    expect(r.status).toBe("resolved");
    expect(rep(c, "leaf_village")).toBe(before + 10);
  });
});

describe("Phase 7 — economy gated by Standing", () => {
  it("gated stock is unbuyable without reputation, even with Ryo", () => {
    const c = pc();
    run("grant_starting_wealth", { bonus: 5000 }, c);
    run("vendor_create", { id: "scrolls", name: "Forbidden Scroll Keeper", authorityId: "leaf_village", gatedStock: [{ itemId: "soldier-pill", ryoPrice: 50, requires: { authorityId: "leaf_village", minReputation: 60 } }] });
    const blocked = run("economy_buy", { vendorId: "scrolls", item: "soldier-pill" }, c) as any;
    expect(blocked.status).toBe("rejected");
    expect(blocked.reason.rule).toBe("not_offered");
    // earn reputation, then it's purchasable
    run("grant_reputation", { authorityId: "leaf_village", amount: 70 }, c);
    const ok = run("economy_buy", { vendorId: "scrolls", item: "soldier-pill" }, c) as any;
    expect(ok.status).toBe("resolved");
  });
});

describe("Phase 7 CHECKPOINT — a theft and a corpse-harvest each move Standing", () => {
  it("theft: getting reported drops Standing with the jurisdiction (and can trigger the rogue path)", () => {
    const c = pc();
    const before = rep(c, "leaf_village");
    const steal = run("theft_steal", { item: "kunai", jurisdictionAuthorityId: "leaf_village", witnesses: ["rin"] }, c) as any;
    expect(steal.status).toBe("resolved");
    const stolenId = steal.events[0].data.stolenId;
    const report = run("theft_report", { stolenId, penalty: 20 }) as any;
    expect(report.status).toBe("resolved");
    expect(rep(c, "leaf_village")).toBe(before - 20); // Standing moved by the theft
    // repeated theft trips the rogue trigger
    let tripped = report.events[0].data.rogueTrigger;
    for (let i = 0; i < 3 && !tripped; i++) {
      const s = run("theft_steal", { item: "kunai", jurisdictionAuthorityId: "leaf_village", witnesses: ["rin"] }, c) as any;
      const rep2 = run("theft_report", { stolenId: s.events[0].data.stolenId, penalty: 20 }) as any;
      tripped = rep2.events[0].data.rogueTrigger;
    }
    expect(tripped).toBe(true);
  });

  it("corpse-harvest: taking a KKG craters the deceased's authority and spikes the patron's", () => {
    const c = pc();
    const beforeLeaf = rep(c, "uchiha_clan");
    const beforePatron = rep(c, "orochimaru");
    const corpse = run("corpse_create", { name: "Fallen Uchiha", authorityId: "uchiha_clan", clan: "Uchiha", carries: [{ type: "kkg", tabooSeverity: 0.9 }, { type: "ryo", amount: 30 }] }) as any;
    const corpseId = corpse.events[0].data.corpse.id;
    const harvest = run("corpse_harvest", { corpseId, what: "kkg", patronAuthorityId: "orochimaru" }, c) as any;
    expect(harvest.status).toBe("resolved");
    expect(rep(c, "uchiha_clan")).toBeLessThan(beforeLeaf); // authority craters
    expect(rep(c, "orochimaru")).toBeGreaterThan(beforePatron); // patron spikes
    // a KKG can't be harvested once the body decays
    run("corpse_advance_decay", { corpseId, steps: 1 });
    const corpse2 = run("corpse_create", { name: "Another", authorityId: "uchiha_clan", clan: "Uchiha", carries: [{ type: "kkg", tabooSeverity: 0.9 }] }) as any;
    run("corpse_advance_decay", { corpseId: corpse2.events[0].data.corpse.id, steps: 1 });
    const late = run("corpse_harvest", { corpseId: corpse2.events[0].data.corpse.id, what: "kkg" }, c) as any;
    expect(late.status).toBe("rejected");
    expect(late.reason.rule).toBe("decayed");
  });

  it("recovering a body is a Standing-positive (honor) act", () => {
    const c = pc();
    const corpse = run("corpse_create", { name: "Fallen Leaf-nin", authorityId: "leaf_village", carries: [] }) as any;
    const before = rep(c, "leaf_village");
    run("corpse_recover", { corpseId: corpse.events[0].data.corpse.id, toAuthorityId: "leaf_village", honor: 12 }, c);
    expect(rep(c, "leaf_village")).toBe(before + 12);
  });
});
