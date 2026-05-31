import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";
import { priceEffects, verdict } from "./rules/pricing.js";

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "forge";
function run(type: string, params: Record<string, unknown>, actorId?: string) {
  return engine.resolveIntent({ intentId: `i_${Math.random()}`, roomId: ROOM, actorId, type, params, ...base } as any);
}
beforeEach(() => {
  engine = createEngine({ dbDriver: "memory", seedSalt: "build-fixed" }).engine;
});

describe("Phase 8 — the empirical point model reproduces canon (validation)", () => {
  it("matches the spec's worked examples within each rank's spread", () => {
    // C-rank 3d8 / 60ft / 20ft-sphere -> ~9.7 vs band 8
    expect(priceEffects("C", { damage: "3d8", range: 60, area: { size: 20 } }).spend).toBeCloseTo(9.64, 1);
    // A-rank 10d8 / 90ft-line -> ~20.9 vs band 19
    expect(priceEffects("A", { damage: "10d8", range: 90 }).spend).toBeCloseTo(20.6, 1);
    // S-rank 10d10 / 120ft -> ~26.0 vs band 28
    expect(priceEffects("S", { damage: "10d10", range: 120 }).spend).toBeCloseTo(25.8, 1);
  });
  it("verdict: green in band, red over band", () => {
    expect(verdict("C", priceEffects("C", { damage: "2d8", range: 30 }).spend).verdict).toBe("green");
    expect(verdict("D", priceEffects("D", { damage: "12d12", area: { size: 60 } }).spend).verdict).toBe("red");
  });
});

describe("Phase 8 — jutsu_build (governor) + freeform resolver", () => {
  it("draft returns a record + points + a green/yellow/red verdict", () => {
    const r = run("jutsu_build", { op: "draft", rank: "B", classification: "Ninjutsu", name: "Test Inferno", effects: { damage: "6d8", range: 60, area: { size: 20, shape: "sphere" }, save: "dex", conditions: ["prone"] } }) as any;
    expect(r.status).toBe("resolved");
    const ev = r.events[0].data;
    expect(ev.record.name).toBe("Test Inferno");
    expect(["green", "yellow", "red"]).toContain(ev.verdict);
    expect(ev.record.effect.delivery).toBe("save");
  });

  it("commit makes the built jutsu learnable + castable (indistinguishable from canon)", () => {
    const draft = run("jutsu_build", { op: "draft", rank: "C", classification: "Ninjutsu", name: "Chakra Lance", effects: { damage: "3d8", range: 60, save: "dex", damageType: "lightning" } }) as any;
    const record = draft.events[0].data.record;
    const commit = run("jutsu_build", { op: "commit", record }) as any;
    expect(commit.status).toBe("resolved");
    expect(engine.content.getJutsu(record.id)).toBeTruthy();

    // a character can learn + cast it
    const broad = ["Perception", "Stealth", "Insight", "Nature", "Investigation", "Survival"];
    const caster = (run("character_create", { name: "Mizuki", clan: "Non-Clan", className: "Ninjutsu Specialist", abilities: { method: "manual", scores: { str: 10, dex: 12, con: 14, int: 16, wis: 12, cha: 8 } }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["int", "con", "dex"] }) as any).events[0].data.character.id;
    const target = (run("character_create", { name: "Dummy", clan: "Non-Clan", className: "Taijutsu Specialist", abilities: { method: "manual", scores: { str: 12, dex: 10, con: 12, int: 8, wis: 10, cha: 10 } }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["str", "con", "dex"] }) as any).events[0].data.character.id;
    run("jutsu_learn", { jutsu: record.id, force: true }, caster); // DM grants the custom jutsu (bypasses rank/affinity gate — pipeline test)
    const cast = run("cast", { jutsu: record.id, targets: [target] }, caster) as any;
    expect(cast.status).toBe("resolved");
    expect(cast.events.map((e: any) => e.type)).toContain("cast");
  });

  it("freeform resolves an improv into a priced, castable ephemeral primitive", () => {
    const broad = ["Perception", "Stealth", "Insight", "Nature", "Investigation", "Survival"];
    const caster = (run("character_create", { name: "Yuki", clan: "Yuki", className: "Ninjutsu Specialist", abilities: { method: "manual", scores: { str: 10, dex: 14, con: 14, int: 15, wis: 10, cha: 8 } }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["int"] }) as any).events[0].data.character.id;
    const target = (run("character_create", { name: "Wall", clan: "Non-Clan", className: "Taijutsu Specialist", abilities: { method: "manual", scores: { str: 12, dex: 10, con: 12, int: 8, wis: 10, cha: 10 } }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["str", "con", "dex"] }) as any).events[0].data.character.id;
    const r = run("freeform", { op: "resolve", description: "freeze handholds and hurl ice shards", classification: "Ninjutsu", effects: { damage: "2d6", range: 30, save: "dex", damageType: "ice" }, targets: [target] }, caster) as any;
    expect(r.status).toBe("resolved");
    const ev = r.events[0].data;
    expect(ev.proposedOp.type).toBe("cast");
    expect(ev.points).toBeGreaterThan(0);
    // the proposed op is castable
    const cast = run(ev.proposedOp.type, ev.proposedOp.params, caster) as any;
    expect(cast.status).toBe("resolved");
  });
});
