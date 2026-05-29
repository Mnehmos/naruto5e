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

## Build a character (Phase 1)

```bash
curl -s localhost:8787/v1/characters -H 'content-type: application/json' -d '{
  "roomId":"demo","name":"Haku","clan":"Yuki","className":"Ninjutsu Specialist",
  "background":"Hard Worker",
  "abilities":{"method":"manual","scores":{"str":10,"dex":14,"con":14,"int":14,"wis":12,"cha":8}},
  "bgAbilityChoice":"str",
  "classSkillChoices":["Nature","Stealth","Perception"]
}'
# -> resolved: a finalized sheet (HP 8, Chakra 14, casting Nin+5/Gen+4/Tai+6, ...)

curl -s localhost:8787/v1/content/clans     # the 20 clan options
curl -s localhost:8787/v1/content/classes   # the 8 classes
```

A skill check: `{"type":"skill_check","actorId":"<charId>","params":{"skill":"Stealth","dc":15}}`.

## Run a fight (Phase 2)

```bash
# build two characters (see above), then teach one a jutsu and fight:
curl -s localhost:8787/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"actorId":"<casterId>","type":"jutsu_learn","params":{"jutsu":"chakra-pulse"}}'
curl -s localhost:8787/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"type":"combat_start","params":{"combatants":[{"actorId":"<a>","team":"pc"},{"actorId":"<b>","team":"enemy"}]}}'
# on the caster's turn:
curl -s localhost:8787/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"actorId":"<casterId>","type":"cast","params":{"jutsu":"chakra-pulse","targets":["<b>"]}}'
curl -s localhost:8787/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"type":"advance"}'
```

Watch the IR live on `ws://localhost:8787/v1/rooms/demo/stream` (cast → save →
damage → down → advance). Two jutsu can collide via `jutsu_clash`.

## What's playable now (through Phase 2)

- Everything in Phase 1, plus a **full combat encounter with jutsu**:
  - initiative as the turn authority; TurnBudget action economy; off-turn lockout.
  - jutsu casting: chakra cost + components + budget gate, then attack/save/auto
    delivery, type-keyed casting (Nin/Gen/Tai), elemental advantage, upcast,
    conditions, healing, ≤2 concentration slots, concentration-break checks.
  - conditions, death saves (auto on a downed PC's turn), clashing jutsu.
  - batch turns emitting ordered IR; educational rejection on unaffordable actions.

## Current limits

- Enemies are currently characters on the "enemy" team; the tiered adversary
  engine + Bingo Book arrive in Phase 4. Missions/rest/economy in Phase 3.
- Renderers and the DM-brain harness come in Phases 10–11.

## What's next

Phase 3: missions (ranked D–S, rewards), rest (dual-pool recovery) + downtime,
equipment & the Ryo economy.
