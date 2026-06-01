import { z } from "zod";

/**
 * Generic resource + technique-classification primitives (Phase A: platform
 * generalization). The engine speaks "resource" by name; "chakra" / "jutsu" /
 * "ninjutsu" become Naruto-DLC content layered on these schemas.
 *
 * Invariants (see plan):
 *  - ResourceDef.id is the stable wire identifier. Engine code MUST consult
 *    `content.getResource(id)` rather than reading `doc.chakra` directly.
 *  - Pools are `{ current, max, temp, dice? }` with current clamped to [0, max].
 *  - Multiple resources may coexist on one character (cross-DLC bargains).
 *  - Adversary scaling is opt-in per resource — Naruto's chakra retains its
 *    existing tuned scaling; second pools default to NO adversary scaling
 *    unless the DLC declares one.
 */

/** A pool of a named resource. Shape mirrors the existing chakra pool. */
export const ResourcePoolSchema = z.object({
  current: z.number().int(),
  max: z.number().int(),
  temp: z.number().int().default(0),
  /** Optional die-pool track (chakra dice / hit dice style). */
  dice: z
    .object({
      type: z.number().int(),
      total: z.number().int(),
      remaining: z.number().int(),
    })
    .optional(),
});
export type ResourcePool = z.infer<typeof ResourcePoolSchema>;

/**
 * Declares a resource to the engine.  `poolField` is set ONLY for the legacy
 * Naruto chakra mapping; new DLC resources live under `character.resources[id]`
 * (and `character.resources[id].dice` for any companion die track).
 */
export const ResourceDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  /** If set, the live pool is read from `doc[poolField]` instead of `doc.resources[id]`.
   *  Used to bind the existing `chakra` field. New resources must omit this. */
  poolField: z.string().optional(),
  /** Optional companion die-pool field path (legacy Naruto: `chakraDice`). */
  dicePoolField: z.string().optional(),
  /** Default first-level pool formula. "die+con" (default) → die size + CON mod. */
  firstLevelFormula: z.string().default("die+con"),
  /** Subsequent-level formula. "avg+con" (default) → die average + CON mod, min 1. */
  subsequentFormula: z.string().default("avg+con"),
  /** Default die size for the pool when no class declares one. */
  defaultDie: z.number().int().default(6),
  /** Adversary-pool computation (opt in). Naruto's chakra path remains hardcoded. */
  adversaryScaling: z
    .object({
      /** "tier" → use the existing adversary baseline+tier mul; "off" → no pool. */
      mode: z.enum(["tier", "off"]).default("off"),
    })
    .optional(),
  /** If true, no_op_spoken techniques on this resource do NOT refund by default. */
  nonRefundable: z.boolean().default(false),
});
export type ResourceDef = z.infer<typeof ResourceDefSchema>;

/**
 * Declares a technique classification (Naruto: ninjutsu/genjutsu/taijutsu/bukijutsu).
 * `castingAbility` keys the actor's casting track ("int", "wis", "str/dex", …).
 */
export const ClassificationDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  /** Ability key for attack mod + save DC. "str/dex" → best of STR and DEX. */
  castingAbility: z.string(),
  /** True if this classification rolls elemental advantage (Naruto: nin only). */
  elementBound: z.boolean().default(false),
});
export type ClassificationDef = z.infer<typeof ClassificationDefSchema>;
