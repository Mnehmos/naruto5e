/**
 * Ch.13 multiclassing — minimum-ability prereqs to enter a class (the standard
 * 5e gate, adapted to casting-by-type). Casters need 13 in their casting ability
 * (Nin=INT, Gen=WIS, Tai=STR); martials/hybrids need 13 in a class save ability.
 */
import { abilityMod } from "./abilities.js";
import type { Ability } from "./skills.js";
import type { Character } from "../domain/character.js";

const CASTING_ABILITY: Record<string, Ability> = { ninjutsu: "int", genjutsu: "wis", taijutsu: "str" };

export function classPrereqAbilities(cls: any): Ability[] {
  if (cls.archetype === "caster") return [CASTING_ABILITY[cls.primaryCasting] ?? "int"];
  if (cls.archetype === "martial") return ["str", "dex"]; // need 13 in one of these
  return (cls.savingThrows ?? ["dex"]) as Ability[]; // hybrid: a save ability
}

export interface PrereqCheck {
  ok: boolean;
  needed: { ability: Ability; min: number }[];
  detail: string;
}

export function checkMulticlassPrereq(char: Character, cls: any): PrereqCheck {
  const totals = char.abilityTotals ?? char.abilities;
  const abilities = classPrereqAbilities(cls);
  // martial/hybrid: meeting ANY listed ability at 13 suffices; caster: the casting ability
  const min = 13;
  const meets = cls.archetype === "caster"
    ? abilities.every((a) => totals[a] >= min)
    : abilities.some((a) => totals[a] >= min);
  return {
    ok: meets,
    needed: abilities.map((a) => ({ ability: a, min })),
    detail: `${cls.name} requires ${cls.archetype === "caster" ? "" : "one of "}${abilities.map((a) => a.toUpperCase()).join("/")} >= ${min}`,
  };
}

export { abilityMod };
