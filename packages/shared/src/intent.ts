/**
 * The Intent Payload Contract (Architecture §6) — the universal submission
 * envelope. Both the MCP controller (LLM-parsed) and the web app (UI-generated)
 * POST the same structured intent to /v1/rooms/{roomId}/intent. The engine
 * validates and resolves identically; it cannot tell whether intent came from
 * an LLM parse or a button click. Intent is intent.
 *
 * The action surface IS the ruleset (Architecture §9.3): `type` is an open
 * string validated per-handler, not a closed enum. The engine NEVER escalates
 * (§9.1) — status is "resolved" | "rejected" only.
 */
import { z } from "zod";
import { IREventSchema } from "./ir.js";

export const SubmittedBySchema = z.object({
  clientType: z.enum(["llm", "ui", "system"]).default("system"),
  userId: z.string().optional(),
  role: z.enum(["player", "dm"]).default("dm"),
});
export type SubmittedBy = z.infer<typeof SubmittedBySchema>;

/** Optional client hint; the engine recomputes affordability authoritatively (§6). */
export const CostHintSchema = z
  .object({
    action: z.number().optional(),
    bonus: z.number().optional(),
    reaction: z.number().optional(),
    movement: z.number().optional(),
    chakra: z.number().optional(),
  })
  .partial();
export type CostHint = z.infer<typeof CostHintSchema>;

export const IntentSchema = z.object({
  intentId: z.string().min(1),
  roomId: z.string().min(1),
  actorId: z.string().optional(),
  submittedBy: SubmittedBySchema.default({ clientType: "system", role: "dm" }),
  type: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  cost: CostHintSchema.optional(),
  clientTime: z.string().optional(),
});
export type Intent = z.infer<typeof IntentSchema>;

/** A sub-operation inside a batch (Architecture §10): no own envelope. */
export const BatchOpSchema = z.object({
  type: z.string().min(1),
  actorId: z.string().optional(),
  params: z.record(z.unknown()).default({}),
  cost: CostHintSchema.optional(),
});
export type BatchOp = z.infer<typeof BatchOpSchema>;

/** The four-part educational failure (Architecture §11). No bare rejections. */
export const RejectionReasonSchema = z.object({
  /** The specific named rule, never a generic code. */
  rule: z.string(),
  /** Why, with actual numbers. */
  explain: z.string(),
  /** Structured values behind the explanation. */
  values: z.record(z.unknown()).optional(),
});
export type RejectionReason = z.infer<typeof RejectionReasonSchema>;

export const IntentResultSchema = z.discriminatedUnion("status", [
  z.object({
    intentId: z.string(),
    status: z.literal("resolved"),
    events: z.array(IREventSchema),
    /** Scoped state-after snapshot for the submitting client's convenience. */
    stateAfter: z.record(z.unknown()).optional(),
  }),
  z.object({
    intentId: z.string(),
    status: z.literal("rejected"),
    /** Which op failed (index in a batch; absent for a single op). */
    failedAt: z.object({ index: z.number(), op: z.unknown() }).optional(),
    reason: RejectionReasonSchema,
    /** IR of the ops that DID apply before the failure. */
    committed: z.array(IREventSchema).default([]),
    /** Where the world stands at the stop point. */
    stateAfter: z.record(z.unknown()).optional(),
    /** Unexecuted ops, for the DM to re-conform. */
    remaining: z.array(z.unknown()).default([]),
    /** Concrete actionable redirects. */
    suggestions: z.array(z.string()).default([]),
  }),
]);
export type IntentResult = z.infer<typeof IntentResultSchema>;
