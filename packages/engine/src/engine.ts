import {
  EngineError,
  IRStream,
  IntentSchema,
  Rng,
  seedFromString,
  type CostHint,
  type IREvent,
  type Intent,
  type IntentResult,
  type SubmittedBy,
} from "@naruto5e/shared";
import type { EngineConfig } from "./config.js";
import type { ContentPack } from "./content.js";
import { RoomSchema, type Room } from "./domain/room.js";
import type { IntentHandler, ResolveContext, ResolveOp } from "./intents/registry.js";
import type { Store } from "./store/types.js";

export interface EngineDeps {
  store: Store;
  config: EngineConfig;
  content: ContentPack;
}

type IRListener = (msg: { roomId: string; events: IREvent[] }) => void;

/** Replace "$name" (whole value) and "${name}" (interpolated) refs with bound ids. */
function resolveRefs<T>(value: T, bindings: Record<string, string>): T {
  if (typeof value === "string") {
    if (/^\$[A-Za-z0-9_]+$/.test(value)) return (bindings[value.slice(1)] ?? value) as unknown as T;
    return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (m, k) => bindings[k] ?? m) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, bindings)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveRefs(v, bindings);
    return out as unknown as T;
  }
  return value;
}

/** The id a batch op "produced" (created entity or acting actor), for ref-threading. */
function producedId(events: IREvent[]): string | undefined {
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, any>;
    const cand =
      d.character?.id ?? d.npc?.id ?? d.adversary?.id ?? d.corpse?.id ?? d.vendor?.id ?? d.mission?.id ?? d.encounterId ?? d.id ?? (e as { actor?: string }).actor;
    if (typeof cand === "string") return cand;
  }
  return undefined;
}

/**
 * The Engine (Architecture tier 1): the authoritative, deterministic game
 * server. Owns all state, dice, and rules. Knows nothing of MCP or LLMs.
 *
 * The single seam is `resolveIntent`: validate -> resolve deterministically ->
 * emit ordered IR. It NEVER escalates (§9.1). Every "no" is an educational
 * failure (§11).
 */
export class Engine {
  readonly store: Store;
  readonly config: EngineConfig;
  readonly content: ContentPack;
  private handlers = new Map<string, IntentHandler>();
  private rngs = new Map<string, Rng>();
  private irListeners = new Set<IRListener>();

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.content = deps.content;
  }

  // ---- handler registry ------------------------------------------------

  registerHandler(type: string, handler: IntentHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`Duplicate intent handler for "${type}"`);
    }
    this.handlers.set(type, handler);
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type) || type === "batch";
  }

  /** Read a registered handler (used for re-entrant sub-ops, e.g. legendary actions). */
  getHandler(type: string): IntentHandler | undefined {
    return this.handlers.get(type);
  }

  knownActions(): string[] {
    return [...this.handlers.keys(), "batch"].sort();
  }

  // ---- IR subscription (the websocket layer wires onto this) -----------

  onIR(listener: IRListener): () => void {
    this.irListeners.add(listener);
    return () => this.irListeners.delete(listener);
  }

  private broadcast(roomId: string, events: IREvent[]): void {
    if (events.length === 0) return;
    for (const l of this.irListeners) l({ roomId, events });
  }

  // ---- rooms + rng -----------------------------------------------------

  ensureRoom(roomId: string, init: Partial<Room> = {}): Room {
    const rooms = this.store.collection<Room>("rooms");
    let room = rooms.get(roomId);
    if (!room) {
      const seed = (seedFromString(roomId) ^ seedFromString(this.config.seedSalt)) >>> 0;
      room = RoomSchema.parse({
        id: roomId,
        createdAt: new Date(0).toISOString(),
        seed,
        rngState: seed,
        mode: "scene",
        ...init,
      });
      rooms.put(room);
    }
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.store.collection<Room>("rooms").get(roomId);
  }

  private getRng(room: Room): Rng {
    let rng = this.rngs.get(room.id);
    if (!rng) {
      rng = Rng.restore(room.rngState);
      this.rngs.set(room.id, rng);
    }
    return rng;
  }

  // ---- the resolution seam --------------------------------------------

  resolveIntent(input: Intent): IntentResult {
    const intent = IntentSchema.parse(input);
    const room = this.ensureRoom(intent.roomId);
    const rng = this.getRng(room);
    const submittedBy = intent.submittedBy;

    if (intent.type === "batch") {
      return this.resolveBatch(intent, room, rng, submittedBy);
    }

    const op: ResolveOp = {
      type: intent.type,
      actorId: intent.actorId,
      params: intent.params,
      cost: intent.cost,
    };
    const ir = new IRStream();
    const rngBefore = rng.snapshot();
    try {
      this.store.transaction(() => {
        this.dispatch(op, room, rng, ir, submittedBy);
        this.persistRng(room, rng);
      });
    } catch (err) {
      Rng.restore(rngBefore); // local, discard
      this.rngs.set(room.id, Rng.restore(rngBefore));
      if (err instanceof EngineError) {
        return {
          intentId: intent.intentId,
          status: "rejected",
          reason: err.reason,
          committed: [],
          stateAfter: this.scopedStateAfter(room.id, op.actorId),
          remaining: [],
          suggestions: err.suggestions,
        };
      }
      throw err;
    }
    this.broadcast(room.id, ir.events);
    return {
      intentId: intent.intentId,
      status: "resolved",
      events: ir.events,
      stateAfter: this.scopedStateAfter(room.id, op.actorId),
    };
  }

  /**
   * Batch (Architecture §10): an ordered, sequenced transaction against
   * evolving state. Default stop-on-failure (commit up to the failure, return
   * remaining + reason). `atomic: true` => all-or-nothing.
   */
  private resolveBatch(intent: Intent, room: Room, rng: Rng, submittedBy: SubmittedBy): IntentResult {
    // accept either `ops` or `intents` as the sub-op list (callers used both); a
    // batch with neither is a caller error, not a silent no-op success.
    const rawOps = (intent.params.ops as unknown[]) ?? (intent.params.intents as unknown[]) ?? [];
    if (!Array.isArray(rawOps) || rawOps.length === 0) {
      return {
        intentId: intent.intentId,
        status: "rejected",
        reason: { rule: "empty_batch", explain: "A batch must carry a non-empty `ops` (or `intents`) array.", values: {} },
        committed: [],
        stateAfter: this.scopedStateAfter(room.id),
        remaining: [],
        suggestions: ["Pass params.ops: [{ type, actorId?, params }] — at least one sub-intent."],
      } as IntentResult;
    }
    const atomic = intent.params.atomic === true;
    const ops: ResolveOp[] = rawOps.map((o) => {
      const r = o as Record<string, unknown>;
      return {
        type: String(r.type),
        actorId: r.actorId as string | undefined,
        params: (r.params as Record<string, unknown>) ?? {},
        cost: r.cost as CostHint | undefined,
        bind: r.bind as string | undefined,
      };
    });

    const ir = new IRStream();
    // ref-threading: later ops can reference an earlier op's produced id as "$name"
    // (when that op set `bind: "name"`) or positionally as "$0", "$1", ... This is
    // what makes ORDER ergonomic — create-then-use in one batch, no round-trip.
    const bindings: Record<string, string> = {};

    // dry-run preview: run the ordered ops in a transaction, capture the IR, then
    // ALWAYS roll back (state + rng) and return the preview. Lets the DM validate a
    // multi-step plan — where op ORDER matters — before committing it for real.
    if (intent.params.dryRun === true) {
      const rngBefore = rng.snapshot();
      const DRY_RUN_ROLLBACK = Symbol("dry_run_rollback");
      let failedIndex = -1;
      try {
        this.store.transaction(() => {
          ops.forEach((op, i) => {
            failedIndex = i;
            this.dispatchBatchOp(op, i, room, rng, ir, submittedBy, bindings);
          });
          throw DRY_RUN_ROLLBACK; // discard all mutations — this was only a preview
        });
      } catch (err) {
        this.rngs.set(room.id, Rng.restore(rngBefore)); // un-advance the dice too
        if (err === DRY_RUN_ROLLBACK) {
          return {
            intentId: intent.intentId,
            status: "resolved",
            events: ir.events,
            stateAfter: this.scopedStateAfter(room.id),
            dryRun: true,
            note: "Dry-run preview: ops ran in order and rolled back — NOTHING was committed. Resubmit without dryRun to apply.",
          } as IntentResult;
        }
        if (err instanceof EngineError) {
          return {
            intentId: intent.intentId,
            status: "rejected",
            failedAt: { index: failedIndex, op: ops[failedIndex] },
            reason: err.reason,
            committed: [],
            stateAfter: this.scopedStateAfter(room.id),
            remaining: ops.slice(failedIndex),
            suggestions: [...err.suggestions, "Dry-run preview: nothing was applied. Fix the failing op's ordering/params and re-preview."],
            dryRun: true,
          } as IntentResult;
        }
        throw err;
      }
    }

    if (atomic) {
      const rngBefore = rng.snapshot();
      let failedIndex = -1;
      try {
        this.store.transaction(() => {
          ops.forEach((op, i) => {
            failedIndex = i;
            this.dispatchBatchOp(op, i, room, rng, ir, submittedBy, bindings);
          });
          this.persistRng(room, rng);
        });
      } catch (err) {
        this.rngs.set(room.id, Rng.restore(rngBefore));
        if (err instanceof EngineError) {
          return {
            intentId: intent.intentId,
            status: "rejected",
            failedAt: { index: failedIndex, op: ops[failedIndex] },
            reason: err.reason,
            committed: [], // atomic: nothing applied
            stateAfter: this.scopedStateAfter(room.id, ops[failedIndex]?.actorId),
            remaining: ops.slice(failedIndex),
            suggestions: [
              ...err.suggestions,
              "This was an atomic batch: nothing was applied. Re-conform the failing op and resubmit.",
            ],
          };
        }
        throw err;
      }
      this.broadcast(room.id, ir.events);
      return { intentId: intent.intentId, status: "resolved", events: ir.events, stateAfter: this.scopedStateAfter(room.id) };
    }

    // stop-on-failure (default)
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const rngBefore = rng.snapshot();
      try {
        this.store.transaction(() => {
          this.dispatchBatchOp(op, i, room, rng, ir, submittedBy, bindings);
          this.persistRng(room, rng);
        });
      } catch (err) {
        this.rngs.set(room.id, Rng.restore(rngBefore));
        if (err instanceof EngineError) {
          this.broadcast(room.id, ir.events); // committed ops already mutated + streamed
          return {
            intentId: intent.intentId,
            status: "rejected",
            failedAt: { index: i, op },
            reason: err.reason,
            committed: ir.events,
            stateAfter: this.scopedStateAfter(room.id, op.actorId),
            remaining: ops.slice(i),
            suggestions: err.suggestions,
          };
        }
        throw err;
      }
    }
    this.broadcast(room.id, ir.events);
    return { intentId: intent.intentId, status: "resolved", events: ir.events, stateAfter: this.scopedStateAfter(room.id) };
  }

  private dispatch(op: ResolveOp, room: Room, rng: Rng, ir: IRStream, submittedBy: SubmittedBy): void {
    const handler = this.handlers.get(op.type);
    if (!handler) {
      // surface the FULL action vocabulary + nearest matches (don't truncate — the
      // verb the caller wants must be discoverable from the rejection).
      const all = this.knownActions();
      const near = all.filter((a) => a.includes(op.type) || op.type.includes(a) || a.split("_").some((p) => op.type.includes(p)));
      throw new EngineError("unknown_action", `No engine action "${op.type}" exists.`, {
        values: { requested: op.type, didYouMean: near.slice(0, 8) },
        suggestions: [
          near.length ? `Did you mean: ${near.slice(0, 8).join(", ")}?` : `No close match for "${op.type}".`,
          `All ${all.length} actions: ${all.join(", ")}`,
        ],
      });
    }
    const ctx: ResolveContext = { engine: this, store: this.store, room, rng, ir, op, submittedBy };
    handler(ctx);
  }

  /** Dispatch one batch op: resolve "$ref" tokens against `bindings`, run it, then
   *  bind the id it produced under "$<index>" and (if set) its `bind` name. */
  private dispatchBatchOp(op: ResolveOp, i: number, room: Room, rng: Rng, ir: IRStream, submittedBy: SubmittedBy, bindings: Record<string, string>): void {
    const resolved: ResolveOp = {
      ...op,
      actorId: resolveRefs(op.actorId, bindings),
      params: resolveRefs(op.params, bindings),
    };
    const before = ir.events.length;
    this.dispatch(resolved, room, rng, ir, submittedBy);
    const made = producedId(ir.events.slice(before));
    if (made) {
      bindings[String(i)] = made;
      if (op.bind) bindings[op.bind] = made;
    }
  }

  private persistRng(room: Room, rng: Rng): void {
    const rooms = this.store.collection<Room>("rooms");
    const r = rooms.get(room.id);
    if (r) {
      r.rngState = rng.snapshot();
      rooms.put(r);
    }
  }

  // ---- scoped reads (Architecture §9.4) --------------------------------

  /**
   * A small, scoped state-after snapshot for the rejection/resolution return.
   * Later phases enrich this (chakra, TurnBudget, position) per §11.2.
   */
  scopedStateAfter(roomId: string, actorId?: string): Record<string, unknown> {
    const room = this.getRoom(roomId);
    const out: Record<string, unknown> = { roomId, mode: room?.mode ?? "scene" };
    if (actorId) {
      const actor = (this.store.collection("characters").get(actorId) ?? this.store.collection("adversaries").get(actorId)) as
        | Record<string, unknown>
        | undefined;
      if (actor) {
        out.actor = {
          id: actorId,
          hp: actor.hp,
          chakra: actor.chakra,
          conditions: actor.conditions,
          position: actor.position,
        };
      }
    }
    return out;
  }

  /** Scoped room state read (for client hydration). */
  getRoomState(roomId: string): Record<string, unknown> {
    const room = this.ensureRoom(roomId);
    const characters = this.store.collection("characters").find((c) => (c as any).roomId === roomId);
    const adversaries = this.store.collection("adversaries").find((a) => (a as any).roomId === roomId);
    const encounter = room.encounterId
      ? this.store.collection("encounters").get(room.encounterId)
      : undefined;
    return { room, characters, adversaries, encounter };
  }

  getEntity(collection: string, id: string): Record<string, unknown> | undefined {
    return this.store.collection(collection).get(id) as Record<string, unknown> | undefined;
  }
}
