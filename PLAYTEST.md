# Naruto 5e — Playtest Guide

How to run the engine, drive it, and what's playable right now.

## Run it

```bash
npm install          # installs deps (better-sqlite3 is optional; engine falls back if it fails)
npm run build        # typecheck gate (tsc --noEmit)
npm test             # full Vitest suite — proves the current playable loop
npm run dev          # start the engine (REST + WS) on http://localhost:8787
```

- **Engine** (tier 1): `http://localhost:8787`
  - `POST /v1/rooms/{roomId}/intent` — the universal write seam
  - `GET  /v1/rooms/{roomId}/state` — scoped room snapshot
  - `GET  /v1/jutsu?rank=C&classification=Ninjutsu&q=fire` — catalog read
  - `WS   ws://localhost:8787/v1/rooms/{roomId}/stream` — live IR event stream
- **MCP controller** (tier 2): `NARUTO_ENGINE_URL=http://localhost:8787 npm run mcp`
  (stdio MCP server; point an MCP-capable client at it).

Environment:
- `PORT` (default 8787), `NARUTO_DB` = `sqlite|memory` (default sqlite),
  `NARUTO_DB_PATH`, `NARUTO_CONTENT` (content dir), `NARUTO_SEED` (dice salt).

## Try it (curl)

```bash
# narrate (a trivial intent that emits IR)
curl -s localhost:8787/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"type":"narrate","params":{"text":"A masked nin drops from the bridge."}}'

# set the scene
curl -s localhost:8787/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"type":"scene","params":{"location":"The Great Naruto Bridge","mode":"scene"}}'

# read room state
curl -s localhost:8787/v1/rooms/demo/state
```

## Sample beat (batch — one narrated turn, many ops)

```json
POST /v1/rooms/demo/intent
{
  "type": "batch",
  "params": { "ops": [
    { "type": "scene",   "params": { "location": "Training Ground 3" } },
    { "type": "narrate", "params": { "text": "Mist rolls in across the water." } }
  ]}
}
```

Returns an ordered IR stream; the same IR streams to every WS subscriber.

## What's playable now (Phase 0)

- The full intent pipeline: validate → resolve → emit ordered IR, over REST and WS.
- Batch beats (stop-on-failure + atomic), with educational failures on rejection.
- Scoped state reads. Deterministic, reproducible dice (seeded per room).
- The jutsu catalog is queryable (399 techniques).

## Current limits

- No characters / combat / jutsu casting yet (Phases 1–2).
- Renderers and the DM-brain harness come in Phases 10–11.

## What's next

Phase 1: build any legal character (dual pools, 6 abilities, 8 classes + subclasses,
20 clans, 10 backgrounds, Will of Fire, casting-by-jutsu-type).
