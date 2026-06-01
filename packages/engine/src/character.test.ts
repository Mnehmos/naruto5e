import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
beforeEach(() => {
  engine = createEngine({ dbDriver: "memory" }).engine;
});

function build(params: Record<string, unknown>, roomId = "r1") {
  return engine.resolveIntent({ intentId: "c", roomId, type: "character_create", params, ...base } as any);
}

describe("Phase 1 CHECKPOINT — build any legal character end-to-end", () => {
  it("builds a Yuki Ninjutsu Specialist with correct dual pools, saves, and type-keyed casting mods", () => {
    const r = build({
      name: "Haku",
      clan: "Yuki",
      className: "Ninjutsu Specialist",
      background: "Hard Worker",
      abilities: { method: "manual", scores: { str: 10, dex: 14, con: 14, int: 14, wis: 12, cha: 8 } },
      bgAbilityChoice: "str",
      classSkillChoices: ["Nature", "Stealth", "Perception"],
    });
    expect(r.status).toBe("resolved");
    const id = (r as any).events[0].data.character.id;
    const c = engine.getEntity("characters", id) as any;

    // clan ability increases applied (Yuki +2 DEX, +1 INT) + Hard Worker +1 STR
    expect(c.abilityTotals).toEqual({ str: 11, dex: 16, con: 14, int: 15, wis: 12, cha: 8 });
    // dual pools: HP = hitDie(6) + CON(+2); Chakra = chakraDie(12) + CON(+2)
    expect(c.hp.max).toBe(8);
    expect(c.chakra.max).toBe(14);
    expect(c.hitDice.type).toBe(6);
    expect(c.chakraDice.type).toBe(12);
    // proficiency +3 at L1; rank Genin
    expect(c.proficiencyBonus).toBe(3);
    expect(c.rank).toBe("Genin");
    // type-keyed casting: Nin=INT(+2), Gen=WIS(+1), Tai=STR/DEX(max=+3)
    expect(c.casting.ninjutsu).toMatchObject({ mod: 2, attack: 5, saveDC: 13 });
    expect(c.casting.genjutsu).toMatchObject({ mod: 1, attack: 4, saveDC: 12 });
    expect(c.casting.taijutsu).toMatchObject({ mod: 3, attack: 6, saveDC: 14 });
    // AC = 10 + DEX(+3)
    expect(c.ac).toBe(13);
    // class saves Ninjutsu Specialist = INT, WIS
    expect(c.proficiencies.savingThrows.sort()).toEqual(["int", "wis"]);
    // skills include clan (Chakra Control, Ninshou), class fixed + 3 chosen, bg (Acrobatics, Athletics)
    expect(c.proficiencies.skills).toEqual(expect.arrayContaining(["Chakra Control", "Ninshou", "Nature", "Stealth", "Perception", "Acrobatics", "Athletics"]));
    expect(c.willOfFire).toBe(true);
    // genesis: Yuki's canonical Ice expands to its base natures (Water+Wind), which
    // derive the Ice (Hyoton) KKG. (Extra rolled natures may add more.)
    expect(c.affinity).toEqual(expect.arrayContaining(["Water", "Wind"]));
    expect(c.kkg).toEqual(expect.arrayContaining(["Ice (Hyoton)"]));
  });

  it("builds a tanky Taijutsu Specialist with Unarmored Defense (AC = 10 + DEX + CON)", () => {
    const r = build({
      name: "Rock Lee",
      clan: "Non-Clan",
      className: "Taijutsu Specialist",
      background: "Hard Worker",
      abilities: { method: "manual", scores: { str: 15, dex: 14, con: 14, int: 8, wis: 12, cha: 10 } },
      abilityChoices: ["str", "dex", "con"],
      bgAbilityChoice: "dex",
      clanSkillChoices: ["Athletics", "Intimidation"],
      classSkillChoices: ["Acrobatics", "Survival"],
    });
    expect(r.status).toBe("resolved");
    const c = engine.getEntity("characters", (r as any).events[0].data.character.id) as any;
    // Non-Clan three +1 (str,dex,con) + Hard Worker +1 dex => str16,dex16,con15
    expect(c.abilityTotals.str).toBe(16);
    expect(c.abilityTotals.dex).toBe(16); // 14 +1 (clan) +1 (bg)
    expect(c.abilityTotals.con).toBe(15);
    expect(c.hitDice.type).toBe(12);
    expect(c.chakraDice.type).toBe(6);
    // Unarmored Defense: 10 + DEX(+3) + CON(+2) = 15
    expect(c.ac).toBe(15);
  });

  it("rejects an unknown clan with an educational failure listing the roster", () => {
    const r = build({ name: "X", clan: "Senju", className: "Scout-Nin", abilities: { method: "manual", scores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } } });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.reason.rule).toBe("unknown_clan");
      expect(r.suggestions[0]).toMatch(/Uchiha/);
    }
  });

  it("rejects invalid point-buy with the cost breakdown", () => {
    const r = build({ name: "X", clan: "Nara", className: "Intelligence Operative", abilities: { method: "point_buy", scores: { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 } } });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason.rule).toBe("point_buy_invalid");
  });

  it("Will of Fire: spend once, then a second spend is an educational rejection", () => {
    const r = build({ name: "Naruto", clan: "Uzumaki", className: "Taijutsu Specialist", classSkillChoices: ["Athletics", "Acrobatics"], abilities: { method: "manual", scores: { str: 14, dex: 12, con: 15, int: 8, wis: 10, cha: 13 } } });
    const id = (r as any).events[0].data.character.id;
    const spend1 = engine.resolveIntent({ intentId: "w1", roomId: "r1", actorId: id, type: "will_of_fire", params: { op: "spend", use: "auto-succeed a death save" }, ...base } as any);
    expect(spend1.status).toBe("resolved");
    const spend2 = engine.resolveIntent({ intentId: "w2", roomId: "r1", actorId: id, type: "will_of_fire", params: { op: "spend" }, ...base } as any);
    expect(spend2.status).toBe("rejected");
    if (spend2.status === "rejected") expect(spend2.reason.rule).toBe("no_will_of_fire");
  });

  it("Uzumaki vitality boosts max HP; level-up scales pools and proficiency", () => {
    const r = build({ name: "Naruto", clan: "Uzumaki", className: "Taijutsu Specialist", classSkillChoices: ["Athletics", "Acrobatics"], abilities: { method: "manual", scores: { str: 14, dex: 12, con: 14, int: 8, wis: 10, cha: 12 } } });
    const id = (r as any).events[0].data.character.id;
    const c0 = engine.getEntity("characters", id) as any;
    // Taijutsu d12 + CON(Uzumaki +2 CON => con16 => +3) = 15; + Uzumaki vitality flat2 + perLevel1 = +3 => 18
    expect(c0.abilityTotals.con).toBe(16);
    expect(c0.hp.max).toBe(15 + 3);
    // level to 5 -> proficiency +4
    for (let i = 0; i < 4; i++) engine.resolveIntent({ intentId: `lu${i}`, roomId: "r1", actorId: id, type: "character_level_up", params: {}, ...base } as any);
    const c5 = engine.getEntity("characters", id) as any;
    expect(c5.level).toBe(5);
    expect(c5.proficiencyBonus).toBe(4);
    // rank decouple (bug_1780247960181): the in-world TITLE is NOT auto-promoted by leveling —
    // it stays the genesis default until the exam (rank_up). The level-derived jutsu-cap TIER
    // does advance to Chunin, so a strong Genin can still grow their jutsu ladder.
    expect(c5.rank).toBe("Genin");
    expect(c5.rankTier).toBe("Chunin");
    expect(c5.hp.max).toBeGreaterThan(c0.hp.max);
  });

  it("rolled abilities are deterministic for a fixed seed", () => {
    const a = createEngine({ dbDriver: "memory", seedSalt: "fixed" }).engine;
    const b = createEngine({ dbDriver: "memory", seedSalt: "fixed" }).engine;
    const mk = (e: Engine) =>
      e.resolveIntent({ intentId: "c", roomId: "r", type: "character_create", params: { name: "Roll", clan: "Sarutobi", className: "Scout-Nin", abilities: { method: "roll_4d6" }, clanSkillChoices: ["Athletics", "Perception"], classSkillChoices: ["Acrobatics", "Stealth", "Nature"] }, ...base } as any);
    const ra = mk(a) as any;
    const rb = mk(b) as any;
    expect(ra.events[0].data.character.abilities).toEqual(rb.events[0].data.character.abilities);
  });
});

// Regression — surfaced in the auto-mode campaign playtest: a medic's character_heal
// healed the ACTOR instead of the targetId ally, and a dice-expression amount
// ("2d8+8") was Number()'d to NaN and written into stored HP (current became null).
describe("character_heal — target routing, dice amounts, NaN guard, corruption repair", () => {
  function mkChar(name: string): string {
    const r = build({
      name,
      clan: "Non-Clan",
      className: "Taijutsu Specialist",
      background: "Hard Worker",
      abilities: { method: "manual", scores: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 } },
      abilityChoices: ["str", "dex", "con"],
      bgAbilityChoice: "str",
      clanSkillChoices: ["Athletics", "Intimidation"],
      classSkillChoices: ["Acrobatics", "Survival"],
    });
    if (r.status !== "resolved") throw new Error("mkChar rejected: " + JSON.stringify((r as any).reason));
    return (r as any).events[0].data.character.id as string;
  }
  const coll = () => (engine as any).store.collection("characters");
  const doc = (id: string) => engine.getEntity("characters", id) as any;
  function setCurrent(id: string, current: number) {
    const d = coll().get(id);
    d.hp.current = current;
    coll().put(d);
  }
  const heal = (actorId: string, params: Record<string, unknown>) =>
    engine.resolveIntent({ intentId: "h", roomId: "r1", actorId, type: "character_heal", params, ...base } as any);

  it("heals the targetId ally, not the acting medic", () => {
    const medic = mkChar("Medic");
    const ally = mkChar("Ally");
    const max = doc(ally).hp.max;
    const medicBefore = doc(medic).hp.current;
    setCurrent(ally, max - 10);
    const r = heal(medic, { targetId: ally, amount: 6 });
    expect(r.status).toBe("resolved");
    expect(doc(ally).hp.current).toBe(max - 4); // (max-10) + 6
    expect(doc(medic).hp.current).toBe(medicBefore); // the medic is untouched
  });

  it("rolls a dice-expression amount into a finite heal (no NaN corruption)", () => {
    const medic = mkChar("Medic");
    const ally = mkChar("Ally");
    setCurrent(ally, 1);
    const r = heal(medic, { targetId: ally, amount: "1d4+1" });
    expect(r.status).toBe("resolved");
    const after = doc(ally).hp.current;
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeGreaterThan(1); // 1d4+1 => +2..+5
    expect((r as any).events[0].data.amount).toBeGreaterThan(0);
  });

  it("rejects a non-numeric amount and leaves HP uncorrupted", () => {
    const medic = mkChar("Medic");
    const ally = mkChar("Ally");
    setCurrent(ally, 7);
    const r = heal(medic, { targetId: ally, amount: "banana" });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason.rule).toBe("invalid_amount");
    expect(doc(ally).hp.current).toBe(7); // unchanged, still finite
  });

  it("repairs a previously-corrupted (non-finite) current HP", () => {
    const medic = mkChar("Medic");
    const ally = mkChar("Ally");
    setCurrent(ally, NaN); // simulate the old build's NaN write (serializes to null)
    expect(Number.isFinite(doc(ally).hp.current)).toBe(false);
    const r = heal(medic, { targetId: ally, amount: 5 });
    expect(r.status).toBe("resolved");
    expect(doc(ally).hp.current).toBe(5); // repaired from 0, then +5
  });

  it("defaults to self-heal when no targetId is given", () => {
    const medic = mkChar("Medic");
    setCurrent(medic, 5);
    const r = heal(medic, { amount: 4 });
    expect(r.status).toBe("resolved");
    expect(doc(medic).hp.current).toBe(9);
  });

  // Regression — the courtyard-climax residue: a PC revived from 0 kept failures:1 /
  // stable:false into the next time they went down. 5e: regaining HP from 0 ends dying.
  it("resets death saves when a downed (0 HP) character is healed back up", () => {
    const ally = mkChar("Faller");
    const d = coll().get(ally);
    d.hp.current = 0;
    d.deathSaves = { successes: 0, failures: 2, stable: false };
    d.conditions = ["Unconscious"];
    coll().put(d);
    const r = heal(mkChar("Medic"), { targetId: ally, amount: 5 });
    expect(r.status).toBe("resolved");
    expect(doc(ally).hp.current).toBe(5);
    expect(doc(ally).deathSaves).toEqual({ successes: 0, failures: 0, stable: false });
    expect(doc(ally).conditions).not.toContain("Unconscious");
    expect((r as any).events[0].data.revived).toBe(true);
  });

  // A heal that does NOT bring HP up from 0 (already conscious) must not touch death saves.
  it("leaves death saves untouched when healing an already-conscious character", () => {
    const ally = mkChar("Wounded");
    const d = coll().get(ally);
    d.hp.current = 3;
    d.deathSaves = { successes: 1, failures: 1, stable: false };
    coll().put(d);
    const r = heal(mkChar("Medic"), { targetId: ally, amount: 4 });
    expect(r.status).toBe("resolved");
    expect(doc(ally).deathSaves).toEqual({ successes: 1, failures: 1, stable: false });
  });
});
