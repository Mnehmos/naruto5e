import type { Rng } from "@naruto5e/shared";
import type { CostHint, IRStream, SubmittedBy } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { Store } from "../store/types.js";
import type { Room } from "../domain/room.js";

/** A single operation to resolve (a standalone intent, or one step of a batch). */
export interface ResolveOp {
  type: string;
  actorId?: string;
  params: Record<string, unknown>;
  cost?: CostHint;
  /** In a batch: bind this op's produced id under a name later ops can reference as "$name". */
  bind?: string;
}

/**
 * The context every intent handler receives. Handlers:
 *  - read/mutate state via `store` (mutations are inside a transaction),
 *  - emit ordered IR via `ir.emit(...)`,
 *  - roll dice via `rng` (the engine owns all dice),
 *  - throw `EngineError` to reject with an educational failure.
 */
export interface ResolveContext {
  engine: Engine;
  store: Store;
  room: Room;
  rng: Rng;
  ir: IRStream;
  op: ResolveOp;
  submittedBy: SubmittedBy;
}

export type IntentHandler = (ctx: ResolveContext) => void;

export interface HandlerModule {
  /** action types this module handles, for diagnostics / "did you mean". */
  types: string[];
  register(engine: Engine): void;
}
