import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "village";

function run(type: string, params: Record<string, unknown>, actorId?: string) {
  return engine.resolveIntent({ intentId: `i_${Math.random()}`, roomId: ROOM, actorId, type, params, ...base } as any);
}
function buildPC(name: string, clan: string, className: string, scores: any) {
  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];
  const r = run("character_create", { name, clan, className, abilities: { method: "manual", scores }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["str", "dex", "con"] }) as any;
  if (r.status !== "resolved") throw new Error(`build failed: ${JSON.stringify(r.reason)}`);
  return r.events[0].data.character.id as string;
}

beforeEach(() => {
  engine = createEngine({ dbDriver: "memory", seedSalt: "econ-fixed" }).engine;
});

describe("Phase 3 CHECKPOINT — mission loop with rewards", () => {
  it("post -> accept -> resolve pays Ryo + mission points", () => {
    const c = buildPC("Konohamaru", "Sarutobi", "Scout-Nin", { str: 12, dex: 14, con: 13, int: 10, wis: 12, cha: 10 });
    const before = engine.getEntity("characters", c) as any;
    const post = run("mission_post", { title: "Find the lost cat Tora", rank: "D" }) as any;
    expect(post.status).toBe("resolved");
    const mid = post.events[0].data.mission.id;
    const acc = run("mission_accept", { missionId: mid }, c) as any;
    expect(acc.status).toBe("resolved");
    const res = run("mission_resolve", { missionId: mid, outcome: "success" }) as any;
    expect(res.status).toBe("resolved");
    const after = engine.getEntity("characters", c) as any;
    expect(after.ryo).toBe(before.ryo + 50);
    expect(after.missionPoints).toBe(before.missionPoints + 100);
  });

  it("rank gate: a Genin cannot accept a B-rank mission (educational failure)", () => {
    const c = buildPC("Genin", "Non-Clan", "Scout-Nin", { str: 12, dex: 14, con: 13, int: 10, wis: 12, cha: 10 });
    const post = run("mission_post", { title: "Assassinate a missing-nin", rank: "B" }) as any;
    const r = run("mission_accept", { missionId: post.events[0].data.mission.id }, c) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("rank_too_low");
  });

  it("rank_up promotes through the ladder", () => {
    const c = buildPC("Rising", "Non-Clan", "Scout-Nin", { str: 12, dex: 14, con: 13, int: 10, wis: 12, cha: 10 });
    run("rank_up", {}, c);
    expect((engine.getEntity("characters", c) as any).rank).toBe("Chunin");
  });
});

describe("Phase 3 — rest (dual-pool recovery)", () => {
  it("short rest spends Hit/Chakra Dice to recover both pools", () => {
    const c = buildPC("Tired", "Non-Clan", "Ninjutsu Specialist", { str: 10, dex: 12, con: 14, int: 15, wis: 10, cha: 8 });
    const doc = engine.getEntity("characters", c) as any;
    doc.hp.current = 1;
    doc.chakra.current = 1;
    engine.store.collection("characters").put(doc);
    const r = run("rest", { type: "short", spendHitDice: 1, spendChakraDice: 1 }, c) as any;
    expect(r.status).toBe("resolved");
    const after = engine.getEntity("characters", c) as any;
    expect(after.hp.current).toBeGreaterThan(1);
    expect(after.chakra.current).toBeGreaterThan(1);
    expect(after.hitDice.remaining).toBeLessThan(after.hitDice.total + 1);
  });

  it("long rest restores both pools to full and recovers dice", () => {
    const c = buildPC("Spent", "Non-Clan", "Ninjutsu Specialist", { str: 10, dex: 12, con: 14, int: 15, wis: 10, cha: 8 });
    const doc = engine.getEntity("characters", c) as any;
    doc.hp.current = 1;
    doc.chakra.current = 1;
    doc.hitDice.remaining = 0;
    engine.store.collection("characters").put(doc);
    run("rest", { type: "long", missionBoundary: true }, c);
    const after = engine.getEntity("characters", c) as any;
    expect(after.hp.current).toBe(after.hp.max);
    expect(after.chakra.current).toBe(after.chakra.max);
    expect(after.hitDice.remaining).toBeGreaterThan(0);
    expect(after.willOfFire).toBe(true);
  });
});

describe("Phase 3 — equipment & economy", () => {
  it("buy -> equip armor recomputes AC; insufficient Ryo is an educational failure", () => {
    const c = buildPC("Buyer", "Non-Clan", "Scout-Nin", { str: 12, dex: 14, con: 13, int: 10, wis: 12, cha: 10 });
    run("grant_starting_wealth", { bonus: 200 }, c); // hybrid 120 + 200 = 320
    const buy = run("buy", { item: "flak-jacket" }, c) as any; // 150
    expect(buy.status).toBe("resolved");
    const eq = run("equip", { item: "flak-jacket" }, c) as any;
    expect(eq.status).toBe("resolved");
    const doc = engine.getEntity("characters", c) as any;
    // medium armor: 14 + min(DEX +2, 2) = 16
    expect(doc.ac).toBe(16);
    // can't afford Shinobi Battle Armor (1500)
    const broke = run("buy", { item: "shinobi-battle-armor" }, c) as any;
    expect(broke.status).toBe("rejected");
    expect(broke.reason.rule).toBe("insufficient_ryo");
    expect(broke.suggestions.length).toBeGreaterThan(0);
  });

  it("use_consumable restores chakra", () => {
    const c = buildPC("Pills", "Non-Clan", "Ninjutsu Specialist", { str: 10, dex: 12, con: 14, int: 15, wis: 10, cha: 8 });
    const doc = engine.getEntity("characters", c) as any;
    doc.chakra.current = 1;
    engine.store.collection("characters").put(doc);
    run("item_give", { item: "soldier-pill" }, c);
    const r = run("use_consumable", { item: "soldier-pill" }, c) as any;
    expect(r.status).toBe("resolved");
    expect((engine.getEntity("characters", c) as any).chakra.current).toBeGreaterThan(1);
  });
});
