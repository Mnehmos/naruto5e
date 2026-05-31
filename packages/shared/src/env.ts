import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Zero-dependency .env loader. Node does NOT read .env on its own (short of the
 * --env-file flag), so the controller/harness entrypoints call loadEnv() once at
 * startup to populate process.env from the repo-root .env.
 *
 * Real environment variables WIN: a key already present in process.env is never
 * overwritten, so a shell/CI export overrides the file.
 *
 * Format: KEY=VALUE per line. `#` comments and blank lines are ignored; wrapping
 * single/double quotes are stripped. No interpolation, no multiline — boring on purpose.
 */
export function loadEnv(startDir: string = process.cwd()): { path: string; loaded: number } | null {
  const file = findEnv(startDir);
  if (!file) return null;
  let loaded = 0;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue; // real env wins over the file
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    process.env[key] = val;
    loaded++;
  }
  return { path: file, loaded };
}

/** Walk up from startDir (max 6 levels) to find the repo-root .env. */
function findEnv(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
