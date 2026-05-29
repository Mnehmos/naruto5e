import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "village-tick";
function run(type: string, params: Record<string, unknown>, actorId?: string) {
  return engine.resolveIntent({ intentId: `i_${Math.random()}`, roomId: ROOM, actorId, type, params, ...base } as any);
}
function pc() {
  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];
  const r = run("character_create", { name: "Genin", clan: "Non-Clan", className: "Scout-Nin", abilities: { method: "manual", scores: { str: 12, dex: 14, con: 14, int: 10, wis: 12, cha: 10 } }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["str", "dex", "con"] }) as any;
  return r.events[0].data.character.id as string;
}
beforeEach(() => {
  engine = createEngine({ dbDriver: "memory", seedSalt: "tick-fixed" }).engine;
});

describe("Phase 9 CHECKPOINT — a long rest advances the world (restResult + tick + playerDigest)", () => {
  it("rest returns the three-layer bundle and the tick mutates world state", () => {
    const c = pc();
    run("npc_create", { id: "rin", name: "Sensei Rin", authorityId: "leaf_village" });
    run("npc_create", { id: "guard", name: "Gate Guard", authorityId: "leaf_village" });
    // spend the pools so the rest visibly recovers
    const doc = engine.getEntity("characters", c) as any;
    doc.hp.current = 1;
    doc.chakra.current = 1;
    engine.store.collection("characters").put(doc);
    // a stolen item with heat to be cooled by the tick
    const steal = run("theft_steal", { item: "kunai", jurisdictionAuthorityId: "leaf_village" }, c) as any;
    const stolenId = steal.events[0].data.stolenId;
    const heatBefore = (engine.getEntity("stolen_items", stolenId) as any).heat;

    const rest = run("rest", { type: "long", missionBoundary: true }, c) as any;
    expect(rest.status).toBe("resolved");
    const restEvent = rest.events.find((e: any) => e.type === "rest");
    expect(restEvent).toBeTruthy();
    // layer 1: restResult
    expect(restEvent.data.restResult.type).toBe("long");
    expect(restEvent.data.restResult.recovered.hp).toBeGreaterThan(0);
    expect(restEvent.data.restResult.willOfFire).toBe("refreshed");
    // layer 2: tick
    expect(restEvent.data.tick.magnitude).toBe("medium");
    expect(restEvent.data.tick.agentsCalled.length).toBeGreaterThan(0);
    // layer 3: playerDigest present
    expect(Array.isArray(restEvent.data.playerDigest)).toBe(true);
    // world advanced: heat cooled a step
    const heatAfter = (engine.getEntity("stolen_items", stolenId) as any).heat;
    const order = ["burning", "hot", "warm", "cold"];
    expect(order.indexOf(heatAfter)).toBeGreaterThan(order.indexOf(heatBefore));
  });

  it("downtime fires a LARGE tick (heat fully cools, more agents) and pools refill", () => {
    const c = pc();
    run("npc_create", { id: "a", name: "Rival", authorityId: "leaf_village" });
    run("npc_create", { id: "b", name: "Patron", authorityId: "akatsuki" });
    const steal = run("theft_steal", { item: "kunai", jurisdictionAuthorityId: "leaf_village" }, c) as any;
    const stolenId = steal.events[0].data.stolenId;
    const rest = run("rest", { type: "downtime" }, c) as any;
    const restEvent = rest.events.find((e: any) => e.type === "rest");
    expect(restEvent.data.tick.magnitude).toBe("large");
    // full cool
    expect((engine.getEntity("stolen_items", stolenId) as any).heat).toBe("cold");
    // economy restock noted at large magnitude
    expect(restEvent.data.tick.consequenceDeltas.economyDrift.length).toBeGreaterThan(0);
  });

  it("tick_preview reports in-scope agents without resolving", () => {
    pc();
    run("npc_create", { id: "x", name: "Elder", authorityId: "uchiha_clan" });
    const r = run("tick_preview", { trigger: "downtime" }) as any;
    expect(r.status).toBe("resolved");
    expect(r.events[0].data.magnitude).toBe("large");
    expect(r.events[0].data.agentsInScope.length).toBeGreaterThan(0);
  });
});
