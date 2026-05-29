/**
 * The DB layer (Architecture §2.1: "Hold and persist all game state"). Modeled
 * as a document store: named collections of JSON documents keyed by `id`. This
 * keeps schema migrations trivial (Zod owns the shape) and lets the same core
 * run over SQLite (default), pure memory (tests), or Postgres (if configured).
 */

export interface Doc {
  id: string;
  [k: string]: unknown;
}

export interface Collection<T extends Doc = Doc> {
  get(id: string): T | undefined;
  put(doc: T): T;
  delete(id: string): boolean;
  list(): T[];
  find(pred: (doc: T) => boolean): T[];
}

export interface Store {
  collection<T extends Doc = Doc>(name: string): Collection<T>;
  /**
   * Run `fn` atomically: commit on normal return, roll back ALL mutations on a
   * thrown error. Powers the atomic-batch flag and keeps a rejected single
   * intent from leaving partial state ("validation precedes mutation", §9.1).
   * Nested calls join the outermost transaction.
   */
  transaction<T>(fn: () => T): T;
  /** Force a durable flush (no-op for pure memory). */
  flush(): void;
  close(): void;
}
