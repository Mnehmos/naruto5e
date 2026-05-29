import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// repo root is three levels up from packages/engine/src
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface EngineConfig {
  port: number;
  /** "sqlite" (default, with auto-fallback) | "memory" | "postgres" (if DATABASE_URL). */
  dbDriver: "sqlite" | "memory" | "postgres";
  /** Path for the sqlite file or the json fallback snapshot. */
  dbPath: string;
  /** Directory holding the content pack (jutsu catalog, etc.). */
  contentDir: string;
  /** Optional master seed; rooms derive their own seed from roomId + this. */
  seedSalt: string;
}

export function loadConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const driver: EngineConfig["dbDriver"] = databaseUrl
    ? "postgres"
    : (process.env.NARUTO_DB as EngineConfig["dbDriver"]) || "sqlite";
  return {
    port: Number(process.env.PORT ?? 8787),
    dbDriver: overrides.dbDriver ?? driver,
    dbPath: overrides.dbPath ?? process.env.NARUTO_DB_PATH ?? path.join(REPO_ROOT, "data", "naruto5e.db"),
    contentDir: overrides.contentDir ?? process.env.NARUTO_CONTENT ?? path.join(REPO_ROOT, "content"),
    seedSalt: overrides.seedSalt ?? process.env.NARUTO_SEED ?? "naruto5e",
    ...overrides,
  };
}

export { REPO_ROOT };
