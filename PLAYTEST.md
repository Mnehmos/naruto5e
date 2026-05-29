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

## The mission loop (Phase 3)

```bash
# post a mission, accept it with a squad, resolve for rewards:
curl -s localhost:8787/v1/rooms/demo/intent -d '{"type":"mission_post","params":{"title":"Find Tora","rank":"D"}}' -H 'content-type: application/json'
curl -s localhost:8787/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"mission_accept","params":{"missionId":"<mid>"}}' -H 'content-type: application/json'
curl -s localhost:8787/v1/rooms/demo/intent -d '{"type":"mission_resolve","params":{"missionId":"<mid>","outcome":"success"}}' -H 'content-type: application/json'
# rest, shop, equip:
curl -s localhost:8787/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"rest","params":{"type":"long","missionBoundary":true}}' -H 'content-type: application/json'
curl -s localhost:8787/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"buy","params":{"item":"flak-jacket"}}' -H 'content-type: application/json'
curl -s localhost:8787/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"equip","params":{"item":"flak-jacket"}}' -H 'content-type: application/json'
```

## What's playable now (through Phase 3)

- Everything in Phases 1–2, plus:
  - the **mission board**: post (ranked D–S), accept (rank-gated), resolve (Ryo +
    mission-point rewards), fail, rank-up.
  - **rest**: short (spend Hit/Chakra Dice) and long (full pools + dice recovery +
    Will of Fire refresh); downtime (train/research/recuperate/shop).
  - **equipment & Ryo economy**: 21 weapons / 6 armor tiers / consumables, buy/sell,
    equip/unequip with armor-aware AC, consumable effects, equipment packs.

## Spawn enemies / a boss (Phase 4)

```bash
# a scaled minion, and a premade Solo boss from the Bingo Book:
curl -s localhost:8787/v1/rooms/demo/intent -d '{"type":"adversary_spawn","params":{"name":"Bandit","tier":"minion","level":3}}' -H 'content-type: application/json'
curl -s localhost:8787/v1/rooms/demo/intent -d '{"type":"from_bingo_book","params":{"name":"Zabuza","partySize":4}}' -H 'content-type: application/json'
# the boss acts off-turn with a Legendary Action:
curl -s localhost:8787/v1/rooms/demo/intent -d '{"actorId":"<bossId>","type":"legendary_action","params":{"action":"freeform_attack","params":{"target":"<pcId>"}}}' -H 'content-type: application/json'
```

## What's playable now (through Phase 4)

- Everything in Phases 1–3, plus the **adversary engine**:
  - tier baselines L1–30; Minion/Elite/Solo scaling; the Bingo Book roster.
  - Solo bosses: Legendary Actions (off-turn, refresh per player turn), Legendary
    Resistance (auto-saves), Phase Transitions at 60%/30% HP.
  - adversaries fight on the same combat surface as PCs (initiative, damage,
    death) — `from_bingo_book`, `adversary_scale`, `freeform_attack`.

## Customize (Phase 5)

```bash
curl -s localhost:8787/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"character_multiclass","params":{"intoClass":"Ninjutsu Specialist"}}' -H 'content-type: application/json'
curl -s localhost:8787/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"take_feat","params":{"feat":"Athlete","abilityChoice":"str"}}' -H 'content-type: application/json'
curl -s "localhost:8787/v1/content/feats?q=alert"   # browse the 112-feat catalog
```

## What's playable now (through Phase 5)

- Everything in Phases 1–4, plus **customization**: multiclassing (combined pools
  + jutsu-known, ability prereqs) and the **112-feat catalog** (take_feat with
  prereq validation + ability increases; ASI).

## Current limits

- Standing/RPP gating, the world-consequence systems, content tools, the world
  tick, renderers, and the DM-brain harness arrive in Phases 6–11.

## What's next

Phase 6: Standing / RPP — per-authority reputation + favor, gating, the rogue
defect path.
