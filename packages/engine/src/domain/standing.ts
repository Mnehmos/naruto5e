import { z } from "zod";

/**
 * The Merit Economy — Standing & Favor (RPP). Standing is tracked PER AUTHORITY
 * (village/clan/patron/faction), not as one number. reputation is the slow,
 * semi-permanent THRESHOLD ("how trusted"); favor is the smaller SPENDABLE pool
 * (capped) cashed for being taught/granted gated content. It gates access, not
 * power — decoupled from level/mission-points.
 */
/**
 * Phase C — debts and bargain audit trail. `debts[]` are open promises the
 * authority/counterparty can later collect; `bargains[]` is an append-only
 * audit log of every strike_bargain / call_favor / incur_debt so the IR
 * isn't the only place provenance lives (the world-tick + NPC callers can
 * inspect the ledger directly).
 */
const StandingDebtSchema = z.object({
  id: z.string(),
  /** The party owed (authority/clan/npc id). */
  to: z.string(),
  /** Free-form description of what is owed. */
  terms: z.string(),
  /** Wall-clock or world-tick stamp at which the debt was incurred. */
  incurredAt: z.number().default(0),
  /** Has the debt been called / collected / forgiven? */
  discharged: z.boolean().default(false),
  /** "called" by call_favor, "forgiven" by discharge, "expired" by tick. */
  dischargedReason: z.string().optional(),
  /** Bound bargain id (links debt → originating bargain entry). */
  bargainId: z.string().optional(),
});
export type StandingDebt = z.infer<typeof StandingDebtSchema>;

const StandingBargainEntrySchema = z.object({
  id: z.string(),
  counterparty: z.string(),
  /** Free-form description of the grant side (what the character receives). */
  grants: z.string(),
  /** Free-form description of the price side (what the character owes / spends). */
  price: z.string(),
  /** Numeric breakdown of the price for atomic checks: favor / reputation / ryo / debt. */
  priceBreakdown: z
    .object({
      favor: z.number().int().optional(),
      reputation: z.number().int().optional(),
      ryo: z.number().int().optional(),
      debt: z.string().optional(),
    })
    .default({}),
  at: z.number().default(0),
  /** Has the price side been logged + applied? */
  pricePosted: z.boolean().default(false),
});
export type StandingBargainEntry = z.infer<typeof StandingBargainEntrySchema>;

export const StandingLedgerSchema = z.object({
  id: z.string(), // `${charId}:${authorityId}`
  kind: z.literal("standing").default("standing"),
  charId: z.string(),
  authorityId: z.string(),
  authorityType: z.enum(["village", "clan", "patron", "faction"]).default("village"),
  reputation: z.number().default(0), // threshold (can go negative => hostile)
  favor: z.number().default(0), // spendable, capped
  favorCap: z.number().default(10),
  obligations: z.array(z.object({ duty: z.string(), leaveCost: z.number().default(1) })).default([]),
  hostile: z.boolean().default(false),
  /** Phase C — open debts. Each one is firable by NPC action or world-tick. */
  debts: z.array(StandingDebtSchema).default([]),
  /** Phase C — audit log of bargains struck against this ledger. */
  bargains: z.array(StandingBargainEntrySchema).default([]),
});
export type StandingLedger = z.infer<typeof StandingLedgerSchema>;

/** Soft, diegetic descriptor of a reputation value (the number is hard; presentation is in-fiction). */
export function softDescriptor(reputation: number, hostile: boolean): string {
  if (hostile || reputation < 0) return "hostile — you are a marked enemy here";
  if (reputation < 20) return "unknown — a face in the crowd";
  if (reputation < 40) return "recognized — a known quantity";
  if (reputation < 60) return "trusted — vouched for";
  if (reputation < 80) return "honored — held in high regard";
  return "revered — a legend in their eyes";
}
