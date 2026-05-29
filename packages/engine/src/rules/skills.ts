/**
 * Ch.6 — the complete, verified custom skill list keyed to its governing
 * ability. This is a fixed engine mechanic (an enum), not content. Includes the
 * Naruto-specific additions: Martial Arts (STR), Chakra Control (CON, the only
 * CON skill), Crafting & Ninshou (INT), Illusions (WIS).
 */
export type Ability = "str" | "dex" | "con" | "int" | "wis" | "cha";
export const ABILITIES: Ability[] = ["str", "dex", "con", "int", "wis", "cha"];

export const SKILLS_BY_ABILITY: Record<Ability, string[]> = {
  str: ["Athletics", "Martial Arts"],
  dex: ["Acrobatics", "Sleight of Hand", "Stealth"],
  con: ["Chakra Control"],
  int: ["Crafting", "History", "Investigation", "Nature", "Ninshou"],
  wis: ["Animal Handling", "Illusions", "Insight", "Medicine", "Perception", "Survival"],
  cha: ["Deception", "Intimidation", "Performance", "Persuasion"],
};

export const SKILL_ABILITY: Record<string, Ability> = (() => {
  const m: Record<string, Ability> = {};
  for (const ab of ABILITIES) for (const sk of SKILLS_BY_ABILITY[ab]) m[sk] = ab;
  return m;
})();

export const ALL_SKILLS: string[] = Object.keys(SKILL_ABILITY);

/** Case-insensitive resolve to the canonical skill name (or undefined). */
export function canonicalSkill(name: string): string | undefined {
  const lower = name.trim().toLowerCase();
  return ALL_SKILLS.find((s) => s.toLowerCase() === lower);
}

export function abilityForSkill(name: string): Ability | undefined {
  const canon = canonicalSkill(name);
  return canon ? SKILL_ABILITY[canon] : undefined;
}
