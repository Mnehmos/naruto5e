import { createRequire } from "node:module";
import type { EngineConfig } from "../config.js";
import { MemoryStore } from "./memory.js";
import { SqliteStore } from "./sqlite.js";
import type { Store } from "./types.js";

export * from "./types.js";
export { MemoryStore } from "./memory.js";
export { SqliteStore } from "./sqlite.js";

const require = createRequire(import.meta.url);

/**
 * Pick a store driver. "sqlite" is the spec default but auto-falls-back to a
 * JSON-backed memory store if the native module isn't built — so the system
 * always runs (Stack: "SQLite default — zero-setup so it runs tonight").
 */
export function createStore(config: EngineConfig): { store: Store; driver: string } {
  if (config.dbDriver === "memory") {
    return { store: new MemoryStore(undefined), driver: "memory" };
  }
  if (config.dbDriver === "sqlite") {
    try {
      const Database = require("better-sqlite3");
      return { store: new SqliteStore(Database, config.dbPath), driver: "sqlite" };
    } catch (err) {
      const jsonPath = config.dbPath.replace(/\.db$/, "") + ".json";
      // eslint-disable-next-line no-console
      console.warn(
        `[store] better-sqlite3 unavailable (${(err as Error).message}); ` +
          `falling back to JSON-backed memory store at ${jsonPath}`,
      );
      return { store: new MemoryStore(jsonPath), driver: "memory(json)" };
    }
  }
  // postgres: not yet implemented as a native driver; degrade to durable memory
  // rather than failing to boot (the doc-store shape ports to a jsonb column).
  // eslint-disable-next-line no-console
  console.warn("[store] postgres driver not yet implemented; using JSON-backed memory store");
  const jsonPath = config.dbPath.replace(/\.db$/, "") + ".json";
  return { store: new MemoryStore(jsonPath), driver: "memory(json)" };
}
