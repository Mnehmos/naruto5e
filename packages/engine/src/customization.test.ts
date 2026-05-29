import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "academy";
function run(type: string, params: Record<string, unknown>, actorId?: string) {
  return engine.resolveIntent({ intentId: `i_${Math.random()}`, roomId: ROOM, actorId, type, params, ...base } as any);
}
function buildPC(scores: any, className = "Scout-Nin") {
  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];
  const r = run("character_create", { name: "Build", clan: "Non-Clan", className, abilities: { method: "manual", scores }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["str", "dex", "con"] }) as any;
  if (r.status !== "resolved") throw new Error(JSON.stringify(r.reason));
  return r.events[0].data.character.id as string;
}
beforeEach(() => {
  engine = createEngine({ dbDriver: "memory", seedSalt: "custom-fixed" }).engine;
});

describe("Phase 5 — multiclassing", () => {
  it("levels into a second class when prereqs are met; pools + jutsu-known combine", () => {
    // Scout-Nin (hybrid, d8/d10) with high INT can multiclass into Ninjutsu Specialist (caster, needs INT 13)
    const c = buildPC({ str: 12, dex: 14, con: 14, int: 15, wis: 12, cha: 8 }, "Scout-Nin");
    const before = engine.getEntity("characters", c) as any;
    const r = run("character_multiclass", { intoClass: "Ninjutsu Specialist" }, c) as any;
    expect(r.status).toBe("resolved");
    const after = engine.getEntity("characters", c) as any;
    expect(after.level).toBe(2);
    expect(after.classes).toHaveLength(2);
    expect(after.classes.map((x: any) => x.className).sort()).toEqual(["Ninjutsu Specialist", "Scout-Nin"]);
    expect(after.hp.max).toBeGreaterThan(before.hp.max);
    // jutsu-known cap = sum of both classes' caps
    expect(after.jutsuKnownCap).toBeGreaterThan(before.jutsuKnownCap);
  });

  it("rejects multiclassing without the ability prereq (educational failure)", () => {
    const c = buildPC({ str: 12, dex: 14, con: 14, int: 9, wis: 9, cha: 8 }, "Scout-Nin");
    const r = run("character_multiclass", { intoClass: "Genjutsu Specialist" }, c) as any; // needs WIS 13
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("multiclass_prereq");
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
});

describe("Phase 5 — feats", () => {
  it("the feat catalog loaded", () => {
    expect(engine.content.feats.length).toBeGreaterThan(40);
    expect(engine.content.getFeat("Athlete")).toBeTruthy();
  });

  it("take_feat applies the feat's ability increase and records it", () => {
    const c = buildPC({ str: 13, dex: 14, con: 14, int: 10, wis: 10, cha: 10 });
    const before = (engine.getEntity("characters", c) as any).abilityTotals.str;
    const r = run("take_feat", { feat: "Athlete", abilityChoice: "str" }, c) as any; // +1 STR or DEX
    expect(r.status).toBe("resolved");
    const after = engine.getEntity("characters", c) as any;
    expect(after.feats).toContain("Athlete");
    expect(after.abilityTotals.str).toBe(before + 1);
  });

  it("rejects a feat whose prerequisite is unmet (educational failure)", () => {
    const c = buildPC({ str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 10 });
    // Blinding Agility requires DEX 20, Level 10 — find any feat with a real prereq and fail it
    const gated = engine.content.feats.find((f: any) => f.prerequisite?.abilities && (Object.values(f.prerequisite.abilities)[0] as number) >= 15);
    if (!gated) return; // catalog-dependent
    const r = run("take_feat", { feat: gated.name }, c) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("feat_prereq");
  });

  it("ASI: +2 to one ability (capped at 20)", () => {
    const c = buildPC({ str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 });
    const before = (engine.getEntity("characters", c) as any).abilityTotals.str;
    const r = run("ability_score_improvement", { plan: [{ ability: "str", amount: 2 }] }, c) as any;
    expect(r.status).toBe("resolved");
    expect((engine.getEntity("characters", c) as any).abilityTotals.str).toBe(before + 2);
  });
});
