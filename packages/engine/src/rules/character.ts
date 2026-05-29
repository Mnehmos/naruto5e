/**
 * Character derivation + build (Ch.1-6). Pure, deterministic.
 *
 * Key Naruto rules encoded here:
 *  - Dual pools: HP keyed to the class Hit Die, Chakra keyed to the class
 *    Chakra Die; both add the CON modifier per level (per the verified Genjutsu
 *    template: HP@1 = die + CON, CK@1 = die + CON).
 *  - Casting modifier is keyed to jutsu TYPE, not class: Ninjutsu=INT,
 *    Genjutsu=WIS, Taijutsu=STR/DEX. attack = prof + mod; saveDC = 8 + prof + mod.
 */
import { reject, type Rng } from "@naruto5e/shared";
import {
  abilityMod,
  dieAverage,
  emptyScores,
  pointBuyCost,
  proficiencyBonus,
  rankFromLevel,
  roll4d6DropLowest,
  STANDARD_ARRAY,
  type AbilityScores,
} from "./abilities.js";
import { ABILITIES, canonicalSkill, type Ability } from "./skills.js";
import type { Character } from "../domain/character.js";

export type Archetype = "caster" | "hybrid" | "martial";

/**
 * Jutsu Known cap. Anchored on the verified Genjutsu progression
 * (3 at L2, +1 at L4/6/8/10/12/15/18 ≈ 2 + ceil(L/2)); generalized per
 * archetype (caster richest, martial leanest). Logged as a rules-faithful
 * default where the per-class grids were "NEEDS VISUAL READ".
 */
export function jutsuKnownCap(archetype: Archetype, level: number): number {
  switch (archetype) {
    case "caster":
      return 2 + Math.ceil(level / 2);
    case "hybrid":
      return 1 + Math.ceil(level / 2);
    case "martial":
    default:
      return 1 + Math.ceil(level / 3);
  }
}

function addBonus(char: Character, ability: Ability, amount: number): void {
  char.abilityBonuses[ability] = (char.abilityBonuses[ability] ?? 0) + amount;
}

export interface AbilityChoice {
  amount: number;
  options: Ability[];
}

/** Apply an abilityIncrease descriptor {fixed?, choices?} given player selections. */
export function applyAbilityIncrease(
  char: Character,
  increase: { fixed?: Partial<AbilityScores>; choices?: AbilityChoice[] } | undefined,
  selections: Ability[] = [],
  label = "increase",
): void {
  if (!increase) return;
  if (increase.fixed) {
    for (const [ab, amt] of Object.entries(increase.fixed)) addBonus(char, ab as Ability, amt as number);
  }
  const choices = increase.choices ?? [];
  let si = 0;
  for (const choice of choices) {
    const pick = selections[si++];
    if (!pick || !choice.options.includes(pick)) {
      throw reject(
        "ability_choice_required",
        `${label} requires a choice of one of [${choice.options.join(", ")}] (got "${pick ?? "none"}").`,
        { options: choice.options, got: pick },
        [`Provide abilityChoices including one of: ${choice.options.join(", ")}`],
      );
    }
    addBonus(char, pick, choice.amount);
  }
}

function grantSkills(
  char: Character,
  prof: { fixed?: string[]; chooseN?: number; from?: string[] } | undefined,
  chosen: string[],
  label: string,
): void {
  if (!prof) return;
  const add = (s: string) => {
    const canon = canonicalSkill(s);
    if (!canon) throw reject("unknown_skill", `"${s}" is not a valid skill (from ${label}).`, { skill: s });
    if (!char.proficiencies.skills.includes(canon)) char.proficiencies.skills.push(canon);
  };
  for (const s of prof.fixed ?? []) add(s);
  if (prof.chooseN && prof.chooseN > 0) {
    const pool = (prof.from ?? []).map((s) => canonicalSkill(s)).filter(Boolean) as string[];
    const picks = chosen.filter((s) => {
      const c = canonicalSkill(s);
      return c && pool.includes(c);
    });
    if (picks.length < prof.chooseN) {
      throw reject(
        "skill_choice_required",
        `${label} requires choosing ${prof.chooseN} skill(s) from [${(prof.from ?? []).join(", ")}]; got ${picks.length}.`,
        { need: prof.chooseN, from: prof.from, got: picks },
        [`Provide skillChoices with ${prof.chooseN} of: ${(prof.from ?? []).join(", ")}`],
      );
    }
    for (const s of picks.slice(0, prof.chooseN)) add(s);
  }
}

export interface BuildSelections {
  abilityChoices?: Ability[]; // for clan ability-increase choices
  bgAbilityChoice?: Ability; // background +1 choice
  clanSkillChoices?: string[];
  classSkillChoices?: string[];
  backgroundSkillChoices?: string[];
}

export function applyClan(char: Character, clan: any, sel: BuildSelections): void {
  char.clan = clan.name;
  applyAbilityIncrease(char, clan.abilityIncrease, sel.abilityChoices ?? [], `${clan.name} clan`);
  char.speed = clan.speed ?? char.speed;
  grantSkills(char, clan.skillProficiencies, sel.clanSkillChoices ?? [], `${clan.name} clan`);
  if (clan.signatureTrait && !char.clanTraits.includes(clan.signatureTrait)) char.clanTraits.push(clan.signatureTrait);
  for (const f of clan.features ?? []) char.clanTraits.push(f);
  for (const el of clan.affinity ?? []) if (!char.affinity.includes(el)) char.affinity.push(el);
  if (clan.uniqueResource) {
    char.resources[clan.uniqueResource.key] = { ...clan.uniqueResource };
  }
}

export function applyBackground(char: Character, bg: any, sel: BuildSelections): void {
  char.background = bg.name;
  grantSkills(char, bg.skillProficiencies, sel.backgroundSkillChoices ?? [], `${bg.name} background`);
  for (const t of bg.toolProficiencies ?? []) if (!char.proficiencies.tools.includes(t)) char.proficiencies.tools.push(t);
  for (const e of bg.startingEquipment ?? []) char.equipment.push({ name: e, source: "background" });
  if (bg.feature) char.classFeatures.push({ name: bg.feature.name, level: 0, description: bg.feature.description });
  // +1 ability increase (choice of two)
  const inc = bg.abilityIncrease;
  if (inc && inc.options) {
    const pick = sel.bgAbilityChoice;
    if (!pick || !inc.options.includes(pick)) {
      throw reject(
        "bg_ability_choice_required",
        `${bg.name} grants +${inc.amount} to one of [${inc.options.join(", ")}] (got "${pick ?? "none"}").`,
        { options: inc.options, got: pick },
        [`Provide bgAbilityChoice as one of: ${inc.options.join(", ")}`],
      );
    }
    addBonus(char, pick, inc.amount ?? 1);
  }
}

export function applyClass(char: Character, cls: any, sel: BuildSelections): void {
  char.className = cls.name;
  char.classes = [{ className: cls.name, level: char.level, hitDie: cls.hitDie, chakraDie: cls.chakraDie, archetype: cls.archetype }];
  char.hitDice = { type: cls.hitDie, total: char.level, remaining: char.level };
  char.chakraDice = { type: cls.chakraDie, total: char.level, remaining: char.level };
  char.proficiencies.savingThrows = [...(cls.savingThrows ?? [])];
  const p = cls.proficiencies ?? {};
  char.proficiencies.armor = [...(p.armor ?? [])];
  char.proficiencies.weapons = [...(p.weapons ?? [])];
  for (const t of p.tools ?? []) if (!char.proficiencies.tools.includes(t)) char.proficiencies.tools.push(t);
  grantSkills(char, p.skills, sel.classSkillChoices ?? [], `${cls.name} class`);
  // class features available at or below this level
  for (const f of cls.features ?? []) {
    if (f.level <= char.level) char.classFeatures.push({ name: f.name, level: f.level, description: f.description });
  }
  char.jutsuKnownCap = jutsuKnownCap((cls.archetype as Archetype) ?? "hybrid", char.level);
  (char as any).archetype = cls.archetype;
}

// ---- ability methods --------------------------------------------------

export function setAbilitiesByMethod(
  char: Character,
  method: string,
  params: Record<string, unknown>,
  rng: Rng,
): void {
  const assign = (params.assign as Partial<AbilityScores>) ?? (params.scores as Partial<AbilityScores>);
  switch (method) {
    case "manual": {
      const scores = params.scores as AbilityScores | undefined;
      if (!scores) throw reject("abilities_missing", "manual method requires params.scores {str,dex,...}.", {}, ["Provide params.scores."]);
      char.abilities = { ...emptyScores(), ...scores };
      return;
    }
    case "point_buy": {
      const scores = params.scores as AbilityScores | undefined;
      if (!scores) throw reject("abilities_missing", "point_buy requires params.scores (8..15 each).", {}, ["Provide params.scores."]);
      const { total, ok, errors } = pointBuyCost(scores);
      if (!ok) {
        throw reject("point_buy_invalid", `Point-buy invalid: ${errors.join(" ")}`, { total, errors }, [
          "Keep each score 8..15 and total cost <= 27.",
        ]);
      }
      char.abilities = { ...emptyScores(), ...scores };
      return;
    }
    case "standard_array": {
      // params.assign maps each ability to one of [15,14,13,12,10,8] (each used once)
      if (!assign) {
        throw reject("assignment_required", `standard_array requires params.assign mapping abilities to ${STANDARD_ARRAY.join("/")}.`, {}, [
          "Provide params.assign, e.g. {str:14,dex:15,con:13,int:12,wis:10,cha:8}.",
        ]);
      }
      const vals = ABILITIES.map((a) => (assign as any)[a]).sort((a, b) => b - a);
      if (JSON.stringify(vals) !== JSON.stringify([...STANDARD_ARRAY])) {
        throw reject(
          "standard_array_invalid",
          `standard_array assignment must use each of ${STANDARD_ARRAY.join(", ")} exactly once.`,
          { got: vals, expected: STANDARD_ARRAY },
          ["Assign 15,14,13,12,10,8 across the six abilities."],
        );
      }
      char.abilities = { ...emptyScores(), ...(assign as AbilityScores) };
      return;
    }
    case "roll_4d6":
    default: {
      const rolled = roll4d6DropLowest(rng);
      // assign in the order given (params.order) or default str..cha
      const order = (params.order as Ability[]) ?? ABILITIES;
      const scores = emptyScores();
      order.forEach((ab, i) => {
        if (ABILITIES.includes(ab)) scores[ab] = rolled[i] ?? 10;
      });
      char.abilities = scores;
      (char as any).rolled = rolled;
      return;
    }
  }
}

// ---- derivation -------------------------------------------------------

export function deriveCharacter(char: Character): Character {
  // ability totals = base + bonuses
  const totals = emptyScores();
  for (const ab of ABILITIES) totals[ab] = char.abilities[ab] + (char.abilityBonuses[ab] ?? 0);
  char.abilityTotals = totals;

  const conMod = abilityMod(totals.con);
  const dexMod = abilityMod(totals.dex);
  const strMod = abilityMod(totals.str);
  const intMod = abilityMod(totals.int);
  const wisMod = abilityMod(totals.wis);

  char.proficiencyBonus = proficiencyBonus(char.level);
  char.rank = char.rank && char.rank !== "Genin" ? char.rank : rankFromLevel(char.level);
  if (!char.rank) char.rank = rankFromLevel(char.level);

  // pools (take-average leveling, deterministic). Multiclass-aware: the very
  // first character level uses the max die; every later level (any class) uses
  // that class level's die average. Falls back to the single hitDice.type if
  // classes[] isn't populated (legacy/adversary path).
  let hpMax = 0;
  let ckMax = 0;
  const classList = char.classes && char.classes.length ? char.classes : null;
  if (classList) {
    let first = true;
    for (const cl of classList) {
      const hd = cl.hitDie ?? char.hitDice.type ?? 6;
      const cd = cl.chakraDie ?? char.chakraDice.type ?? 6;
      for (let l = 0; l < cl.level; l++) {
        if (first) {
          hpMax += hd + conMod;
          ckMax += cd + conMod;
          first = false;
        } else {
          hpMax += Math.max(1, dieAverage(hd) + conMod);
          ckMax += Math.max(1, dieAverage(cd) + conMod);
        }
      }
    }
    hpMax = Math.max(1, hpMax);
    ckMax = Math.max(1, ckMax);
  } else {
    const hpDie = char.hitDice.type || 6;
    const ckDie = char.chakraDice.type || 6;
    hpMax = Math.max(1, hpDie + conMod);
    ckMax = Math.max(1, ckDie + conMod);
    for (let l = 2; l <= char.level; l++) {
      hpMax += Math.max(1, dieAverage(hpDie) + conMod);
      ckMax += Math.max(1, dieAverage(ckDie) + conMod);
    }
  }
  // unique clan resource bonuses
  for (const res of Object.values(char.resources)) {
    const r = res as any;
    if (r.type === "hpBonus") hpMax += (r.flat ?? 0) + (r.perLevel ?? 0) * char.level;
    if (r.type === "chakraBonus") ckMax += (r.flat ?? 0) + (r.perLevel ?? 0) * char.level;
  }

  const wasUnbuilt = !char.built;
  char.hp = { current: wasUnbuilt ? hpMax : Math.min(char.hp.current, hpMax), max: hpMax, temp: char.hp.temp ?? 0 };
  char.chakra = { current: wasUnbuilt ? ckMax : Math.min(char.chakra.current, ckMax), max: ckMax, temp: char.chakra.temp ?? 0 };

  // AC: equipped armor (light = base+DEX, medium = base+min(DEX,2), heavy = base) wins;
  // else Taijutsu Unarmored Defense = 10 + DEX + CON; else 10 + DEX.
  const armor = (char.equipment ?? []).find((e: any) => e?.equipped && e?.type === "armor") as any;
  const hasUnarmored = char.classFeatures.some((f) => f.name === "Unarmored Defense");
  if (armor) {
    if (armor.acRule === "medium") char.ac = armor.acBase + Math.min(dexMod, 2);
    else if (armor.acRule === "heavy") char.ac = armor.acBase;
    else char.ac = armor.acBase + dexMod; // light
  } else if (hasUnarmored) {
    char.ac = 10 + dexMod + conMod;
  } else {
    char.ac = 10 + dexMod;
  }

  // casting tracks (type-keyed). Taijutsu uses the better of STR/DEX (STR/DEX physical).
  const taiMod = Math.max(strMod, dexMod);
  const pb = char.proficiencyBonus;
  char.casting = {
    ninjutsu: { ability: "int", mod: intMod, attack: pb + intMod, saveDC: 8 + pb + intMod },
    genjutsu: { ability: "wis", mod: wisMod, attack: pb + wisMod, saveDC: 8 + pb + wisMod },
    taijutsu: { ability: "str/dex", mod: taiMod, attack: pb + taiMod, saveDC: 8 + pb + taiMod },
  };

  // dice pools track level
  char.hitDice.total = char.level;
  char.chakraDice.total = char.level;
  if (wasUnbuilt) {
    char.hitDice.remaining = char.level;
    char.chakraDice.remaining = char.level;
  }

  // jutsu-known cap: sum each class's cap at its class level (multiclass tracks
  // each casting track), per the "Jutsu Known & Highest Rank Known" rule.
  if (classList) {
    char.jutsuKnownCap = classList.reduce(
      (sum, cl) => sum + jutsuKnownCap((cl.archetype as Archetype) ?? "hybrid", cl.level),
      0,
    );
  } else if ((char as any).archetype) {
    char.jutsuKnownCap = jutsuKnownCap((char as any).archetype as Archetype, char.level);
  }
  return char;
}
