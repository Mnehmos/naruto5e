/** The Ch.8 condition list (plus Exhaustion tracked as a level). */
export const CONDITIONS = [
  "Blinded",
  "Charmed",
  "Deafened",
  "Frightened",
  "Grappled",
  "Incapacitated",
  "Invisible",
  "Paralyzed",
  "Petrified",
  "Poisoned",
  "Prone",
  "Restrained",
  "Stunned",
  "Unconscious",
  // Naruto-specific damage-over-time conditions
  "Burned",
  "Bleeding",
] as const;

export type ConditionName = (typeof CONDITIONS)[number];

/**
 * Damage-over-time conditions tick at the START of the afflicted creature's turn.
 * (Defaults — flagged for exact-rulebook verification.) Burned: fire; Bleeding:
 * slashing. Cleared via the `condition` op or a healing/medical effect.
 */
export const CONDITION_DOT: Record<string, { dice: string; type: string }> = {
  Burned: { dice: "1d4", type: "fire" },
  Bleeding: { dice: "1d4", type: "slashing" },
};

export function isCondition(name: string): name is ConditionName {
  return (CONDITIONS as readonly string[]).includes(name);
}

/** Conditions that prevent taking actions at all (Incapacitated and worse). */
export const INCAPACITATING = new Set<string>(["Incapacitated", "Paralyzed", "Petrified", "Stunned", "Unconscious"]);

/** Components a condition blocks (mobility for restrained/grappled, etc.). */
export function blockedComponents(conditions: string[]): Set<string> {
  const blocked = new Set<string>();
  if (conditions.includes("Restrained") || conditions.includes("Paralyzed") || conditions.includes("Petrified")) {
    blocked.add("M"); // mobility
  }
  if (conditions.includes("Grappled")) blocked.add("M");
  return blocked;
}
