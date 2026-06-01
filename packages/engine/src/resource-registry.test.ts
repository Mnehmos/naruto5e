import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";
import { applyResourceRegistry, deriveCharacter } from "./rules/character.js";
import { CharacterSchema, type Character } from "./domain/character.js";

/**
 * Phase A — generalized resource pools.
 *
 * These tests pin THREE invariants:
 *  1. Naruto-as-DLC: an existing jutsu still casts and the chakra pool still
 *     debits (regression smoke).
 *  2. Coexistence: a second named resource registered at runtime gets its own
 *     pool and the chakra pool is left untouched.
 *  3. Affordability gate is generic: a technique costing a non-chakra resource
 *     rejects with `resource_affordability_gate` when the pool is empty.
 */

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;

beforeEach(() => {
  engine = createEngine({ dbDriver: "memory" }).engine;
});

function run(type: string, params: Record<string, unknown>, actorId?: string, roomId = "rrm") {
  return engine.resolveIntent({ intentId: `i_${type}_${Math.random()}`, roomId, type, params, actorId, ...base } as any);
}

function mkHaku(): string {
  const r = run("character_create", {
    name: "Haku",
    clan: "Yuki",
    className: "Ninjutsu Specialist",
    background: "Hard Worker",
    abilities: { method: "manual", scores: { str: 10, dex: 14, con: 14, int: 14, wis: 12, cha: 8 } },
    bgAbilityChoice: "str",
    classSkillChoices: ["Nature", "Stealth", "Perception"],
  }) as any;
  if (r.status !== "resolved") throw new Error("character_create rejected: " + JSON.stringify(r.reason));
  return r.events[0].data.character.id as string;
}

describe("Phase A — Naruto regression smoke (DLC binding preserved)", () => {
  it("the chakra resource is registered by default and a known jutsu casts + debits chakra", () => {
    const chakraDef = engine.content.getResource("chakra");
    expect(chakraDef).toBeDefined();
    expect(chakraDef!.poolField).toBe("chakra"); // bound to legacy field
    expect(engine.content.listResources().some((r) => r.id === "chakra")).toBe(true);

    const haku = mkHaku();
    const c = engine.getEntity("characters", haku) as any;
    const ckBefore = c.chakra.current;

    // Pick a cheap jutsu with an observable effect that resolves WITHOUT a
    // target list (healing self-targets the caster; damage with no targets
    // becomes a noop_spoken under Phase B).  A pure-utility no-effect jutsu
    // would, post-Phase B, refund its cost via technique_noop_spoken — see the
    // technique-disposition test suite for that branch.  Here we want to verify
    // the affordability + debit path stays wired end-to-end.
    const cheap =
      engine.content.jutsu.find(
        (j: any) => (j.cost ?? 0) >= 1 && (j.cost ?? 0) <= 4 && j.effect && j.effect.healing,
      ) ??
      engine.content.jutsu.find(
        (j: any) =>
          (j.cost ?? 0) >= 1 &&
          (j.cost ?? 0) <= 4 &&
          j.effect &&
          (j.effect.damage || (j.effect.conditions && j.effect.conditions.length) || j.effect.buff),
      ) ??
      engine.content.jutsu[0];
    const targets = cheap.effect?.damage || cheap.effect?.conditions ? [haku] : undefined;
    const r = run("cast", { jutsu: cheap.id, force: true, ...(targets ? { targets } : {}) }, haku) as any;
    expect(r.status).toBe("resolved");
    const cAfter = engine.getEntity("characters", haku) as any;
    expect(cAfter.chakra.current).toBe(ckBefore - (cheap.cost ?? 0));
  });

  it("the legacy chakra_affordability rule string is preserved on chakra rejection", () => {
    const haku = mkHaku();
    const expensive = engine.content.jutsu.find((j: any) => j.rank === "S" && (j.cost ?? 0) > 20)!;
    expect(expensive).toBeTruthy();
    const r = run("cast", { jutsu: expensive.id, force: true }, haku) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("chakra_affordability");
  });
});

describe("Phase A — coexistence: a second named resource lives side-by-side", () => {
  beforeEach(() => {
    // Register a second pool ("grace") as if a DLC content pack declared it.
    engine.content.addResource({
      id: "grace",
      label: "Grace",
      firstLevelFormula: "die+con",
      subsequentFormula: "avg+con",
      defaultDie: 8,
      nonRefundable: false,
    } as any);
  });

  it("deriveCharacter + applyResourceRegistry inits the grace pool on character_create", () => {
    const haku = mkHaku();
    const c = engine.getEntity("characters", haku) as any;
    // grace.max = die(8) + conMod(2) = 10 at level 1
    expect(c.resources.grace).toBeDefined();
    expect(c.resources.grace.max).toBe(10);
    expect(c.resources.grace.current).toBe(10);
    // chakra is unchanged — grace lives in `resources[id]`, not in `chakra`
    expect(c.chakra.max).toBe(14);
    expect(c.chakra.current).toBe(14);
  });

  it("character_spend_resource debits grace without touching chakra", () => {
    const haku = mkHaku();
    const before = engine.getEntity("characters", haku) as any;
    const chakraBefore = before.chakra.current;
    const r = run("character_spend_resource", { resourceId: "grace", amount: 3 }, haku) as any;
    expect(r.status).toBe("resolved");
    const after = engine.getEntity("characters", haku) as any;
    expect(after.resources.grace.current).toBe(7);
    expect(after.chakra.current).toBe(chakraBefore);
    // IR carries the resource id explicitly
    const ev = (r.events as any[]).find((e) => e.type === "resource");
    expect(ev).toBeDefined();
    expect(ev.data.resource).toBe("grace");
  });

  it("affordability gate uses the generic rule for non-chakra resources", () => {
    const haku = mkHaku();
    // try to spend more grace than the pool holds
    const r = run("character_spend_resource", { resourceId: "grace", amount: 99 }, haku) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("resource_affordability_gate");
    expect(r.reason.values.resource).toBe("grace");
  });

  it("a technique declared with `resource: 'grace'` casts against the grace pool", () => {
    const haku = mkHaku();
    // Register a tiny DLC jutsu that costs 3 grace.  Phase B: utility-delivery
    // techniques with no observable effect now refund their cost via
    // technique_noop_spoken — so we opt this test jutsu out via
    // `nonRefundable: true` to keep the debit-on-grace assertion meaningful.
    engine.content.addJutsu({
      id: "grace-test-1",
      name: "Grace Test 1",
      classification: "Ninjutsu",
      rank: "E",
      castingTime: "1 Action",
      range: "30 feet",
      duration: "Instant",
      components: [],
      cost: 3,
      keywords: [],
      description: "DLC technique bound to the grace pool.",
      atHigherRanks: null,
      effect: { delivery: "utility" },
      resource: "grace",
      nonRefundable: true,
    } as any);

    const r = run("cast", { jutsu: "grace-test-1", force: true }, haku) as any;
    expect(r.status).toBe("resolved");
    const c = engine.getEntity("characters", haku) as any;
    // grace was debited; chakra untouched
    expect(c.resources.grace.current).toBe(10 - 3);
    expect(c.chakra.current).toBe(14);
  });

  it("rest recovery refills grace on a long rest while leaving the chakra path intact", () => {
    const haku = mkHaku();
    // burn some grace first
    run("character_spend_resource", { resourceId: "grace", amount: 7 }, haku);
    let c = engine.getEntity("characters", haku) as any;
    expect(c.resources.grace.current).toBe(3);

    const r = run("rest", { type: "long" }, haku) as any;
    expect(r.status).toBe("resolved");
    c = engine.getEntity("characters", haku) as any;
    expect(c.resources.grace.current).toBe(c.resources.grace.max);
  });

  it("addResource is idempotent (registering grace twice does not break chakra)", () => {
    engine.content.addResource({
      id: "grace",
      label: "Grace (reloaded)",
      defaultDie: 10,
    } as any);
    expect(engine.content.getResource("grace")!.label).toBe("Grace (reloaded)");
    // chakra remains
    expect(engine.content.getResource("chakra")).toBeDefined();
  });
});

describe("Phase A — pure derivation helper (no engine needed)", () => {
  it("applyResourceRegistry computes per-level scaling for a non-chakra pool", () => {
    // build a level-3 character schema-pure (no DB round-trip)
    const char: Character = CharacterSchema.parse({
      id: "x",
      name: "Test",
      roomId: "r",
      level: 3,
      abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 10, cha: 10 },
      hp: { current: 1, max: 1, temp: 0 },
      chakra: { current: 1, max: 1, temp: 0 },
      hitDice: { type: 6, total: 3, remaining: 3 },
      chakraDice: { type: 6, total: 3, remaining: 3 },
    } as any);
    deriveCharacter(char);

    const engineLocal = createEngine({ dbDriver: "memory" }).engine;
    engineLocal.content.addResource({
      id: "fervor",
      label: "Fervor",
      defaultDie: 6,
    } as any);
    applyResourceRegistry(char, engineLocal.content);

    // level 1: 6 + 2 = 8; level 2: avg(6)=4 + 2 = 6; level 3: same. → 20
    // (dieAverage uses floor(sides/2)+1, so avg(d6)=4.)
    expect(char.resources.fervor).toBeDefined();
    const expected = 8 + 6 + 6;
    expect((char.resources.fervor as any).max).toBe(expected);
  });
});
