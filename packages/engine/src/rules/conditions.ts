import type { Ability } from "./skills.js";

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

/** Default saving-throw ability used to RESIST (on apply) or SHAKE (save-to-end) a
 *  condition, when the jutsu/condition doesn't name one. Tunable. */
export const CONDITION_SAVE: Record<string, "str" | "dex" | "con" | "int" | "wis" | "cha"> = {
  Blinded: "con",
  Charmed: "wis",
  Deafened: "con",
  Frightened: "wis",
  Grappled: "str",
  Incapacitated: "con",
  Paralyzed: "con",
  Petrified: "con",
  Poisoned: "con",
  Restrained: "str",
  Stunned: "con",
  Burned: "con",
  Bleeding: "con",
};

/** Conditions a creature re-saves against at the START of its turn to end early
 *  (the "save to shake it" rule). Permanent/structural ones (Petrified, Prone,
 *  Unconscious, Grappled, Invisible, Incapacitated) are excluded. */
export const SAVE_TO_END = new Set<string>([
  "Blinded",
  "Charmed",
  "Deafened",
  "Frightened",
  "Paralyzed",
  "Poisoned",
  "Restrained",
  "Stunned",
  "Burned",
  "Bleeding",
]);

/**
 * SPECIAL STATUS conditions — the durable afflictions that require deliberate removal
 * (a cure, a quest, the GM). Everything NOT in this set is "transient": a combat/scene
 * effect that ends one of three ways — its duration expires (conditionStates.rounds),
 * the afflicted spends action economy to shake it (e.g. STAND from Prone), or the
 * encounter ends. Transient conditions therefore do NOT survive end_combat or a long rest;
 * special status ones do. (Petrified needs Greater-Restoration-tier removal — it is the
 * canonical "special" condition. Tunable: add long-curse/seal states here as the setting needs.)
 */
export const PERSISTENT_STATUS = new Set<string>(["Petrified"]);

/** A long rest / downtime resolves every transient condition (only special status survives). */
export function clearedByRest(condition: string): boolean {
  return !PERSISTENT_STATUS.has(condition);
}

/** Ending the encounter clears every transient condition (Prone, Stunned, Grappled, …);
 *  only special status conditions outlive the fight. */
export function clearedByCombatEnd(condition: string): boolean {
  return !PERSISTENT_STATUS.has(condition);
}

/** Resolve the save ability for a condition (explicit tag wins, else the default). */
export function conditionSaveAbility(name: string, explicit?: string): Ability {
  return (explicit ?? CONDITION_SAVE[name] ?? "con") as Ability;
}

/** Components a condition blocks (mobility for restrained/grappled, etc.). */
export function blockedComponents(conditions: string[]): Set<string> {
  const blocked = new Set<string>();
  if (conditions.includes("Restrained") || conditions.includes("Paralyzed") || conditions.includes("Petrified")) {
    blocked.add("M"); // mobility
  }
  if (conditions.includes("Grappled")) blocked.add("M");
  return blocked;
}
