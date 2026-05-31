import { z } from "zod";

/**
 * Adversary (Ch.14) — a trimmed sheet, not a PC build. Shares the actor shape
 * (hp/ac/conditions/position) so it submits intent into the same combat_action
 * surface as players. Tier drives scaling; jutsu are rank-capped by tier.
 */
const PoolSchema = z.object({ current: z.number().int(), max: z.number().int(), temp: z.number().int().default(0) });

export const AdversarySchema = z.object({
  id: z.string(),
  kind: z.literal("adversary").default("adversary"),
  roomId: z.string(),
  name: z.string(),
  isPC: z.literal(false).default(false),
  team: z.string().default("enemy"),

  tier: z.enum(["minion", "elite", "solo"]),
  role: z.string().default("striker"),
  clan: z.string().optional(),
  level: z.number().int(),

  ac: z.number().int(),
  hp: PoolSchema,
  chakra: PoolSchema,
  speed: z.number().int().default(30),
  abilityMods: z.record(z.number()).default({}),
  proficiencyBonus: z.number().int().default(3),
  saveBonus: z.number().int().default(0),
  attack: z.number().int().default(5), // primary freeform attack bonus
  damage: z.number().int().default(7), // damage/round budget
  jutsuDC: z.number().int().default(11),
  initiativeBonus: z.number().int().default(0),

  traits: z.array(z.string()).default([]),
  roleAbilities: z.array(z.string()).default([]),
  jutsu: z.array(z.string()).default([]),
  attacks: z.array(z.object({ name: z.string(), bonus: z.number(), damage: z.string(), type: z.string().optional() })).default([]),
  affinity: z.array(z.string()).default([]),

  conditions: z.array(z.string()).default([]),
  conditionStates: z
    .array(z.object({ name: z.string(), saveAbility: z.string().default("con"), dc: z.number().default(13), saveToEnd: z.boolean().default(false), rounds: z.number().optional() }))
    .default([]),
  dead: z.boolean().default(false),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  initiative: z.number().optional(),
  turnBudget: z
    .object({ action: z.number(), bonus: z.number(), reaction: z.number(), movement: z.number(), freeInteraction: z.number() })
    .optional(),
  concentration: z.array(z.object({ jutsuId: z.string(), name: z.string(), targets: z.array(z.string()).default([]) })).default([]),

  // Elite
  eliteAction: z.boolean().default(false),
  eliteTenacity: z.number().default(0), // pool of d4s for saves per combat
  // Solo
  legendary: z.object({ actions: z.number(), max: z.number(), resistance: z.number() }).optional(),
  phases: z.object({ thresholds: z.array(z.number()), crossed: z.array(z.number()), current: z.number() }).optional(),

  xpMultiplier: z.number().default(1),
});
export type Adversary = z.infer<typeof AdversarySchema>;
