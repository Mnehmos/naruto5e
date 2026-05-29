import fs from "node:fs";
import path from "node:path";
import type { Collection, Doc, Store } from "./types.js";

/**
 * SQLite document store (the spec's default persistent driver). One table per
 * collection: (id TEXT PRIMARY KEY, doc TEXT JSON). Uses better-sqlite3's
 * synchronous API, which matches the engine's deterministic, single-writer
 * model. Atomic transactions map straight onto SQLite BEGIN/COMMIT/ROLLBACK.
 *
 * Constructed only after better-sqlite3 is confirmed loadable (see store/index).
 */
export class SqliteStore implements Store {
  private db: any;
  private tables = new Set<string>();
  private txDepth = 0;

  constructor(Database: any, dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
  }

  private ensureTable(name: string): string {
    const table = `c_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    if (!this.tables.has(table)) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
      this.tables.add(table);
    }
    return table;
  }

  collection<T extends Doc = Doc>(name: string): Collection<T> {
    const table = this.ensureTable(name);
    const db = this.db;
    return {
      get: (id) => {
        const row = db.prepare(`SELECT doc FROM ${table} WHERE id = ?`).get(id) as { doc: string } | undefined;
        return row ? (JSON.parse(row.doc) as T) : undefined;
      },
      put: (doc) => {
        db.prepare(`INSERT INTO ${table} (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc`).run(
          doc.id,
          JSON.stringify(doc),
        );
        return doc;
      },
      delete: (id) => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0,
      list: () =>
        (db.prepare(`SELECT doc FROM ${table}`).all() as { doc: string }[]).map((r) => JSON.parse(r.doc) as T),
      find: (pred) =>
        (db.prepare(`SELECT doc FROM ${table}`).all() as { doc: string }[])
          .map((r) => JSON.parse(r.doc) as T)
          .filter(pred),
    };
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn(); // join the outermost transaction
    this.txDepth++;
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this.txDepth--;
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.txDepth--;
      throw err;
    }
  }

  flush(): void {
    /* WAL autocommits; nothing to do */
  }

  close(): void {
    this.db.close();
  }
}
