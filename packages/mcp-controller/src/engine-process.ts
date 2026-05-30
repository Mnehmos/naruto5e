/**
 * Engine server lifecycle (tier-2 dev ergonomics): start / stop / restart /
 * status the tier-1 engine process from the MCP controller. The engine is
 * spawned DETACHED so it outlives the controller (the controller stays thin and
 * restartable); its PID is tracked in data/engine.pid so stop/restart survive a
 * controller restart, with a kill-by-port fallback so we can also stop an engine
 * the tool didn't start.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/mcp-controller/src -> repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PID_FILE = path.join(REPO_ROOT, "data", "engine.pid");
const LOG_FILE = path.join(REPO_ROOT, "data", "engine.out.log");

export interface LifecycleResult {
  action: "status" | "start" | "stop" | "restart";
  running: boolean;
  url: string;
  port: number;
  [k: string]: unknown;
}

export function portFromUrl(url: string): number {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return 8970;
  }
}

async function pingHealth(baseUrl: string, timeoutMs = 1500): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function readPid(): number | null {
  try {
    const n = Number(fs.readFileSync(PID_FILE, "utf-8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
function writePid(pid: number): void {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid), "utf-8");
}
function clearPid(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* already gone */
  }
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process and its children (tsx spawns an esbuild child). */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM"); // the detached child is its own group leader
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }
  }
}

/** Best-effort: PIDs LISTENING on a TCP port (so stop works for untracked engines). */
function pidsOnPort(port: number): number[] {
  try {
    if (process.platform === "win32") {
      const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf-8" }).stdout ?? "";
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
        const cols = line.trim().split(/\s+/);
        const pid = Number(cols[cols.length - 1]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    }
    const out = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" }).stdout ?? "";
    return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function status(baseUrl: string): Promise<LifecycleResult> {
  const health = await pingHealth(baseUrl);
  const tracked = readPid();
  return {
    action: "status",
    running: !!health,
    url: baseUrl,
    port: portFromUrl(baseUrl),
    ...(health ? { health } : {}),
    ...(tracked ? { trackedPid: tracked, trackedPidAlive: pidAlive(tracked) } : {}),
  };
}

export async function start(baseUrl: string, opts: { dbDriver?: string; waitMs?: number } = {}): Promise<LifecycleResult> {
  const port = portFromUrl(baseUrl);
  const existing = await pingHealth(baseUrl);
  if (existing) {
    return { action: "start", running: true, alreadyRunning: true, url: baseUrl, port, health: existing };
  }
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const serverEntry = path.join(REPO_ROOT, "packages", "engine", "src", "server.ts");
  if (!fs.existsSync(tsxCli) || !fs.existsSync(serverEntry)) {
    return { action: "start", running: false, url: baseUrl, port, error: "could not locate tsx or the engine entrypoint", tsxCli, serverEntry };
  }
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const logFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [tsxCli, serverEntry], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PORT: String(port), ...(opts.dbDriver ? { NARUTO_DB: opts.dbDriver } : {}) },
  });
  child.unref();
  if (child.pid) writePid(child.pid);

  const deadline = Date.now() + (opts.waitMs ?? 15000);
  let health: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    await sleep(500);
    health = await pingHealth(baseUrl);
    if (health) break;
  }
  return {
    action: "start",
    running: !!health,
    url: baseUrl,
    port,
    pid: child.pid,
    logFile: LOG_FILE,
    ...(health ? { health } : { note: `spawned (pid ${child.pid}) but not healthy within ${(opts.waitMs ?? 15000) / 1000}s — check logFile` }),
  };
}

export async function stop(baseUrl: string): Promise<LifecycleResult> {
  const port = portFromUrl(baseUrl);
  const killed: number[] = [];
  const tracked = readPid();
  if (tracked && pidAlive(tracked)) {
    killTree(tracked);
    killed.push(tracked);
  }
  for (const pid of pidsOnPort(port)) {
    if (pid === process.pid) continue; // never kill the controller itself
    if (!killed.includes(pid)) {
      killTree(pid);
      killed.push(pid);
    }
  }
  clearPid();
  await sleep(700);
  const health = await pingHealth(baseUrl, 800);
  return {
    action: "stop",
    running: !!health,
    url: baseUrl,
    port,
    killed,
    ...(health ? { note: "something is still answering on the port" } : {}),
  };
}

export async function restart(baseUrl: string, opts: { dbDriver?: string; waitMs?: number } = {}): Promise<LifecycleResult> {
  await stop(baseUrl);
  await sleep(500);
  const r = await start(baseUrl, opts);
  return { ...r, action: "restart" };
}

export async function manage(action: string, baseUrl: string, opts: { dbDriver?: string } = {}): Promise<LifecycleResult> {
  switch (action) {
    case "status":
      return status(baseUrl);
    case "start":
      return start(baseUrl, opts);
    case "stop":
      return stop(baseUrl);
    case "restart":
      return restart(baseUrl, opts);
    default:
      return { action: "status", running: false, url: baseUrl, port: portFromUrl(baseUrl), error: `unknown action "${action}" (use status|start|stop|restart)` };
  }
}
