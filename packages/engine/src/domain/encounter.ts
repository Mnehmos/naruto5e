import { z } from "zod";

/**
 * Encounter state (Ch.8). Initiative is the engine's turn authority — the thing
 * that decides whose intent resolves when (the multiplayer concurrency control,
 * per the architecture: initiative + TurnBudget make "whose turn" enforceable).
 */
export const CombatantSchema = z.object({
  actorId: z.string(),
  /** which collection the actor lives in: characters | adversaries. */
  kind: z.enum(["character", "adversary"]).default("character"),
  initiative: z.number(),
  isPC: z.boolean(),
  team: z.string(),
  /** elite/solo extra-action bookkeeping (Phase 4). */
  extraActions: z.number().default(0),
});
export type Combatant = z.infer<typeof CombatantSchema>;

export const EncounterSchema = z.object({
  id: z.string(),
  kind: z.literal("encounter").default("encounter"),
  roomId: z.string(),
  combatants: z.array(CombatantSchema),
  /** actorIds sorted by initiative desc — the turn order. */
  order: z.array(z.string()),
  round: z.number().int().default(1),
  activeIndex: z.number().int().default(0),
  status: z.enum(["active", "ended"]).default("active"),
  log: z.array(z.string()).default([]),
});
export type Encounter = z.infer<typeof EncounterSchema>;
