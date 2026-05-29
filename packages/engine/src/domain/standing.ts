import { z } from "zod";

/**
 * The Merit Economy — Standing & Favor (RPP). Standing is tracked PER AUTHORITY
 * (village/clan/patron/faction), not as one number. reputation is the slow,
 * semi-permanent THRESHOLD ("how trusted"); favor is the smaller SPENDABLE pool
 * (capped) cashed for being taught/granted gated content. It gates access, not
 * power — decoupled from level/mission-points.
 */
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
