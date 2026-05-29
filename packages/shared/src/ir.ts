/**
 * The Intermediate Representation (IR) event stream — the engine's single
 * output language (Architecture §2.2, §6). Every resolved intent yields an
 * ordered `events[]`; those same events stream over the websocket, so the
 * submitting client and all observers converge on identical state.
 *
 * The IR is intentionally a flexible typed envelope rather than a closed union:
 * each phase adds event kinds (move/attack/cast/damage/condition/down/advance/
 * narrate/roll/heal/resource/spawn/standing/...), and the renderer switches on
 * `type`. `seq` orders events within a single resolution (and across a batch).
 */
import { z } from "zod";

export const IREventSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative(),
  actor: z.string().optional(),
  /** Type-specific payload. Renderer/narrator reads this by event type. */
  data: z.record(z.unknown()).default({}),
  /** Human-readable line the narration feed can append directly. */
  narration: z.string().optional(),
});

export type IREvent = z.infer<typeof IREventSchema>;

/**
 * Helper for building an ordered IR stream inside a single resolution.
 * Hands out monotonically increasing `seq` values.
 */
export class IRStream {
  private seq = 0;
  readonly events: IREvent[] = [];

  constructor(start = 0) {
    this.seq = start;
  }

  emit(type: string, init: Partial<Omit<IREvent, "type" | "seq">> = {}): IREvent {
    const ev: IREvent = {
      type,
      seq: this.seq++,
      actor: init.actor,
      data: init.data ?? {},
      narration: init.narration,
    };
    this.events.push(ev);
    return ev;
  }

  /** Continue numbering from where this stream left off (for batch sequencing). */
  get nextSeq(): number {
    return this.seq;
  }

  push(events: IREvent[]): void {
    for (const e of events) {
      // re-stamp seq to keep the merged stream monotonic
      this.events.push({ ...e, seq: this.seq++ });
    }
  }
}
