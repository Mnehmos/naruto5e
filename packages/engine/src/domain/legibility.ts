import { z } from "zod";

/**
 * Generic hidden-state primitive (Phase C). The platform's investigation/clue
 * substrate: every entity field that can be HIDDEN, MISREAD, or LATER REVEALED
 * lives behind the same shape — so Stain, contraband, identity, intent, or any
 * downstream content's "what does the world *actually* know vs. what does it
 * *appear* to be?" rides on one primitive.
 *
 * Shape contract:
 *  - `actual`     — the ground truth. ONLY engine-internal helpers read this.
 *                   No `read_*` intent ever exposes it. Only `reveal_*` may
 *                   copy it into `apparent`.
 *  - `apparent`   — what an observer last saw / what `read_*` returns. `null`
 *                   means "engine answers UNKNOWN" — a first-class disposition.
 *  - `concealment` — the DC / opposed pool the read check competes against.
 *                   `mask_*` raises this; `reveal_*` does not change it.
 *  - `lastReadAs` — the most recent apparent value an observer committed to;
 *                   lets future reads detect "still consistent" vs. "anomaly".
 *  - `evidence[]` — append-only audit trail of every read/reveal/mask + by-whom.
 *                   The IR is the canonical truth but this gives entities a
 *                   per-field provenance the narrator can quote.
 *
 * The wrapper is OPT-IN: an entity field that isn't a HiddenField stays
 * fully legible (and migration is lazy — non-wrapped fields read as their
 * literal value with disposition=commit).
 */

export const HiddenEvidenceSchema = z.object({
  /** Kind of contact with the field. */
  kind: z.enum(["read", "reveal", "mask", "mark"]),
  /** Who/what acted. May be a character id, a npc id, or a system tag. */
  observerId: z.string().optional(),
  /** The apparent value the observer committed to (read), or the new apparent (reveal/mask). */
  apparent: z.unknown().optional(),
  /** Engine-decided disposition for this evidence point. */
  disposition: z.enum(["commit", "unknown", "no_op_spoken", "reject_inert"]).default("commit"),
  /** Free-form per-evidence explanation; rendered by the narrator. */
  note: z.string().optional(),
  /** Stamped at evidence time so audits can replay timelines. */
  at: z.number().int().optional(),
});
export type HiddenEvidence = z.infer<typeof HiddenEvidenceSchema>;

export const HiddenFieldSchema = z.object({
  /** Ground truth (engine-internal). */
  actual: z.unknown(),
  /** Observer-visible value. null === unknown. */
  apparent: z.unknown().nullable().default(null),
  /** DC / opposed-pool target a perception read must meet. */
  concealment: z.number().int().min(0).default(10),
  /** Most recent committed apparent (for anomaly detection). */
  lastReadAs: z.unknown().optional(),
  /** Audit trail. */
  evidence: z.array(HiddenEvidenceSchema).default([]),
  /** Engine sentinel so storage round-trips keep the wrapper recognizable. */
  __hidden: z.literal(true).default(true),
});
export type HiddenField = z.infer<typeof HiddenFieldSchema>;

/** Type guard: is this value a HiddenField wrapper (vs. a plain literal)? */
export function isHiddenField(v: unknown): v is HiddenField {
  return !!v && typeof v === "object" && (v as { __hidden?: unknown }).__hidden === true;
}

/** Disposition union for IR events that close out an intent. */
export type LegibilityDisposition = "commit" | "unknown" | "no_op_spoken" | "reject_inert";
