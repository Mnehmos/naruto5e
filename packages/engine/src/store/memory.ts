import fs from "node:fs";
import path from "node:path";
import type { Collection, Doc, Store } from "./types.js";

/**
 * In-memory document store with optional JSON-file durability. Default driver
 * for tests (no path => pure memory) and the zero-native-dependency fallback
 * for the dev server when better-sqlite3 is unavailable.
 *
 * Transactions snapshot the whole store via structuredClone and restore on
 * throw — correct for a single local table; not built for high concurrency
 * (the architecture's one-writer-per-room rule makes that a non-issue).
 */
export class MemoryStore implements Store {
  private data = new Map<string, Map<string, Doc>>();
  private txDepth = 0;
  private txBackup: Map<string, Map<string, Doc>> | null = null;
  private dirty = false;
  private readonly persistPath?: string;

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
    if (persistPath && fs.existsSync(persistPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(persistPath, "utf-8")) as Record<string, Doc[]>;
        for (const [name, docs] of Object.entries(raw)) {
          const m = new Map<string, Doc>();
          for (const d of docs) m.set(d.id, d);
          this.data.set(name, m);
        }
      } catch {
        // corrupt snapshot — start fresh rather than crash
      }
    }
  }

  private map(name: string): Map<string, Doc> {
    let m = this.data.get(name);
    if (!m) {
      m = new Map();
      this.data.set(name, m);
    }
    return m;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.txDepth === 0) this.flush();
  }

  collection<T extends Doc = Doc>(name: string): Collection<T> {
    const self = this;
    return {
      // clone on read so callers can't alias/mutate stored state (matches SqliteStore)
      get: (id) => {
        const d = self.map(name).get(id);
        return d ? (structuredClone(d) as T) : undefined;
      },
      put: (doc) => {
        self.map(name).set(doc.id, structuredClone(doc));
        self.markDirty();
        return doc;
      },
      delete: (id) => {
        const ok = self.map(name).delete(id);
        if (ok) self.markDirty();
        return ok;
      },
      list: () => [...self.map(name).values()].map((d) => structuredClone(d)) as T[],
      find: (pred) =>
        [...self.map(name).values()]
          .map((d) => structuredClone(d) as T)
          .filter(pred),
    };
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth === 0) {
      // deep snapshot for rollback
      this.txBackup = new Map();
      for (const [name, m] of this.data) {
        const copy = new Map<string, Doc>();
        for (const [id, doc] of m) copy.set(id, structuredClone(doc));
        this.txBackup.set(name, copy);
      }
    }
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      if (this.txDepth === 0) {
        this.txBackup = null;
        if (this.dirty) this.flush();
      }
      return result;
    } catch (err) {
      this.txDepth--;
      if (this.txDepth === 0 && this.txBackup) {
        this.data = this.txBackup;
        this.txBackup = null;
      }
      throw err;
    }
  }

  flush(): void {
    if (!this.persistPath || !this.dirty) return;
    const out: Record<string, Doc[]> = {};
    for (const [name, m] of this.data) out[name] = [...m.values()];
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    fs.writeFileSync(this.persistPath, JSON.stringify(out), "utf-8");
    this.dirty = false;
  }

  close(): void {
    this.flush();
  }
}
