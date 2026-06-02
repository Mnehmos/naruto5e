# Hidden Hand 5e â€” Playtest Guide

How to run the engine, drive it, and what's playable right now.

## Run it

```bash
npm install          # installs deps (better-sqlite3 is optional; engine falls back if it fails)
npm run build        # typecheck gate (tsc --noEmit)
npm test             # full Vitest suite â€” proves the current playable loop
npm run dev          # start the engine (REST + WS) on http://localhost:8970
```

- **Engine** (tier 1): `http://localhost:8970`
  - `POST /v1/rooms/{roomId}/intent` â€” the universal write seam
  - `GET  /v1/rooms/{roomId}/state` â€” scoped room snapshot
  - `GET  /v1/jutsu?rank=C&classification=Ninjutsu&q=fire` â€” catalog read
  - `WS   ws://localhost:8970/v1/rooms/{roomId}/stream` â€” live IR event stream
- **MCP controller** (tier 2): `NARUTO_ENGINE_URL=http://localhost:8970 npm run mcp`
  (stdio MCP server; point an MCP-capable client at it).

Environment:
- `PORT` (default 8970), `NARUTO_DB` = `sqlite|memory` (default sqlite),
  `NARUTO_DB_PATH`, `NARUTO_CONTENT` (content dir), `NARUTO_SEED` (dice salt).

## Try it (curl)

```bash
# narrate (a trivial intent that emits IR)
curl -s localhost:8970/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"type":"narrate","params":{"text":"A masked nin drops from the bridge."}}'

# set the scene
curl -s localhost:8970/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"type":"scene","params":{"location":"The Great Bridge","mode":"scene"}}'

# read room state
curl -s localhost:8970/v1/rooms/demo/state
```

## Sample beat (batch â€” one narrated turn, many ops)

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
curl -s localhost:8970/v1/characters -H 'content-type: application/json' -d '{
  "roomId":"demo","name":"Haku","clan":"Yuki","className":"Ninjutsu Specialist",
  "background":"Hard Worker",
  "abilities":{"method":"manual","scores":{"str":10,"dex":14,"con":14,"int":14,"wis":12,"cha":8}},
  "bgAbilityChoice":"str",
  "classSkillChoices":["Nature","Stealth","Perception"]
}'
# -> resolved: a finalized sheet (HP 8, Chakra 14, casting Nin+5/Gen+4/Tai+6, ...)

curl -s localhost:8970/v1/content/clans     # the 20 clan options
curl -s localhost:8970/v1/content/classes   # the 8 classes
```

A skill check: `{"type":"skill_check","actorId":"<charId>","params":{"skill":"Stealth","dc":15}}`.

## Run a fight (Phase 2)

```bash
# build two characters (see above), then teach one a jutsu and fight:
curl -s localhost:8970/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"actorId":"<casterId>","type":"jutsu_learn","params":{"jutsu":"chakra-pulse"}}'
curl -s localhost:8970/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"type":"combat_start","params":{"combatants":[{"actorId":"<a>","team":"pc"},{"actorId":"<b>","team":"enemy"}]}}'
# on the caster's turn:
curl -s localhost:8970/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"actorId":"<casterId>","type":"cast","params":{"jutsu":"chakra-pulse","targets":["<b>"]}}'
curl -s localhost:8970/v1/rooms/demo/intent -H 'content-type: application/json' \
  -d '{"type":"advance"}'
```

Watch the IR live on `ws://localhost:8970/v1/rooms/demo/stream` (cast â†’ save â†’
damage â†’ down â†’ advance). Two jutsu can collide via `jutsu_clash`.

## What's playable now (through Phase 2)

- Everything in Phase 1, plus a **full combat encounter with jutsu**:
  - initiative as the turn authority; TurnBudget action economy; off-turn lockout.
  - jutsu casting: chakra cost + components + budget gate, then attack/save/auto
    delivery, type-keyed casting (Nin/Gen/Tai), elemental advantage, upcast,
    conditions, healing, â‰¤2 concentration slots, concentration-break checks.
  - conditions, death saves (auto on a downed PC's turn), clashing jutsu.
  - batch turns emitting ordered IR; educational rejection on unaffordable actions.

## The mission loop (Phase 3)

```bash
# post a mission, accept it with a squad, resolve for rewards:
curl -s localhost:8970/v1/rooms/demo/intent -d '{"type":"mission_post","params":{"title":"Find Tora","rank":"D"}}' -H 'content-type: application/json'
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"mission_accept","params":{"missionId":"<mid>"}}' -H 'content-type: application/json'
curl -s localhost:8970/v1/rooms/demo/intent -d '{"type":"mission_resolve","params":{"missionId":"<mid>","outcome":"success"}}' -H 'content-type: application/json'
# rest, shop, equip:
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"rest","params":{"type":"long","missionBoundary":true}}' -H 'content-type: application/json'
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"buy","params":{"item":"flak-jacket"}}' -H 'content-type: application/json'
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"equip","params":{"item":"flak-jacket"}}' -H 'content-type: application/json'
```

## What's playable now (through Phase 3)

- Everything in Phases 1â€“2, plus:
  - the **mission board**: post (ranked Dâ€“S), accept (rank-gated), resolve (Ryo +
    mission-point rewards), fail, rank-up.
  - **rest**: short (spend Hit/Chakra Dice) and long (full pools + dice recovery +
    Stone Oath refresh); downtime (train/research/recuperate/shop).
  - **equipment & Ryo economy**: 21 weapons / 6 armor tiers / consumables, buy/sell,
    equip/unequip with armor-aware AC, consumable effects, equipment packs.

## Spawn enemies / a boss (Phase 4)

```bash
# a scaled minion, and a premade Solo boss from the Bingo Book:
curl -s localhost:8970/v1/rooms/demo/intent -d '{"type":"adversary_spawn","params":{"name":"Bandit","tier":"minion","level":3}}' -H 'content-type: application/json'
curl -s localhost:8970/v1/rooms/demo/intent -d '{"type":"from_bingo_book","params":{"name":"Zabuza","partySize":4}}' -H 'content-type: application/json'
# the boss acts off-turn with a Legendary Action:
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<bossId>","type":"legendary_action","params":{"action":"freeform_attack","params":{"target":"<pcId>"}}}' -H 'content-type: application/json'
```

## What's playable now (through Phase 4)

- Everything in Phases 1â€“3, plus the **adversary engine**:
  - tier baselines L1â€“30; Minion/Elite/Solo scaling; the Bingo Book roster.
  - Solo bosses: Legendary Actions (off-turn, refresh per player turn), Legendary
    Resistance (auto-saves), Phase Transitions at 60%/30% HP.
  - adversaries fight on the same combat surface as PCs (initiative, damage,
    death) â€” `from_bingo_book`, `adversary_scale`, `freeform_attack`.

### Encounter balance (design note)

The adversary attack/damage curve is the source Ch.14 table verbatim (the book
rules). It is calibrated for a full ~4-PC party (action economy in the party's
favor) - so elite/solo foes hit hard and often against a single PC. This is
intentional, not a bug. For off-table fights (a lone PC, or custom difficulty)
use the step-7 personalize knob on the build:
`{ acMod, attackMod, hpMult, damageMult, dcMod }` (e.g. `adversary_spawn` /
`from_bingo_book` params.personalize). Minions are low-damage by design (chip/
swarm); elite and solo attack/damage are the high-end of the table and assume a
squad.

## Customize (Phase 5)

```bash
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"character_multiclass","params":{"intoClass":"Ninjutsu Specialist"}}' -H 'content-type: application/json'
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"take_feat","params":{"feat":"Athlete","abilityChoice":"str"}}' -H 'content-type: application/json'
curl -s "localhost:8970/v1/content/feats?q=alert"   # browse the 112-feat catalog
```

## What's playable now (through Phase 5)

- Everything in Phases 1â€“4, plus **customization**: multiclassing (combined pools
  + jutsu-known, ability prereqs) and the **112-feat catalog** (take_feat with
  prereq validation + ability increases; ASI).

## Standing / RPP (Phase 6)

```bash
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"grant_reputation","params":{"authorityId":"leaf_village","amount":50}}' -H 'content-type: application/json'
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"check_access","params":{"authorityId":"leaf_village","minReputation":40,"what":"Chunin exam"}}' -H 'content-type: application/json'
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"defect","params":{"fromAuthority":"leaf_village","toAuthority":"orochimaru"}}' -H 'content-type: application/json'
```

## What's playable now (through Phase 6)

- Everything in Phases 1â€“5, plus **Standing / RPP**: per-authority reputation
  (gates access) + capped favor (spent to be taught gated content), obligations,
  and the rogue **defect** path (ledger swap â†’ missing-nin).

## What's playable now (through Phase 7)

- Everything in Phases 1â€“6, plus the **world-consequence web** (all moving
  Standing): NPC memory (a defining memory raises reputation), economy with
  Standing-gated stock + discounts, theft (heat â†’ reported â†’ Standing hit â†’ rogue
  trigger â†’ defect), corpse harvest (bloodline/secret = patron-positive / authority-
  negative, gated to a fresh body) vs. honorable recovery.

## Author a jutsu / price an improv (Phase 8)

```bash
# draft a B-rank jutsu and see the green/yellow/red verdict, then commit it:
curl -s localhost:8970/v1/rooms/demo/intent -H 'content-type: application/json' -d '{"type":"jutsu_build","params":{"op":"draft","rank":"B","classification":"Ninjutsu","name":"Test Inferno","effects":{"damage":"6d8","range":60,"area":{"size":20,"shape":"sphere"},"save":"dex","conditions":["prone"]}}}'
# price a one-off improvised action on the same scale:
curl -s localhost:8970/v1/rooms/demo/intent -H 'content-type: application/json' -d '{"actorId":"<id>","type":"freeform","params":{"op":"resolve","description":"freeze handholds and hurl ice shards","effects":{"damage":"2d6","range":30,"save":"dex","damageType":"ice"},"targets":["<t>"]}}'
```

## What's playable now (through Phase 8)

- Everything in Phases 1â€“7, plus **content tools**: jutsu_build (the empirical
  point governor â€” draft/price/rerank/commit, green/yellow/red) producing canon
  Ch.9 records that are immediately learnable + castable, and the freeform
  resolver (improv conformed into a priced, castable primitive).

## The world tick (Phase 9)

Resting embeds the world advancement automatically â€” one call returns all three
layers:

```bash
curl -s localhost:8970/v1/rooms/demo/intent -d '{"actorId":"<id>","type":"rest","params":{"type":"downtime"}}' -H 'content-type: application/json'
# -> events include a "rest" event carrying { restResult, tick, playerDigest }
```

## The web app (Phase 10)

Open **http://localhost:8970/** in a browser. Enter a room id and connect:
- left: character sheet + party/field (HP/Chakra bars, conditions),
- center: the top-down tactical map â€” click a tile to **move**, click an enemy
  token to **attack**, arm a Jutsu card then click a target to **cast**; action
  bar for advance/begin/end combat; a raw-intent Console (DM),
- right: the live narration/IR feed.

Everything round-trips through the engine; the client only proposes (the symmetry).

## The DM harness (Phase 11)

```bash
# start the engine, then in another shell:
NARUTO_ENGINE_URL=http://localhost:8970 npm run dm demo
player> Yuki casts Chakra Pulse at Bandit
player> narrate: Mist rolls across the bridge.
```

Runs offline with a deterministic parser; set `ANTHROPIC_API_KEY` (and install
`@anthropic-ai/sdk`) for the Claude-backed DM brain (tool-use loop over the engine).

## What's playable now (ALL phases)

The full spec: build characters â†’ equip â†’ take missions â†’ spawn tiered
adversaries/bosses â†’ run jutsu combat â†’ rest (which advances the world) â†’
customize (multiclass/feats) â†’ move Standing through play (NPC memory, economy,
theft, corpse) â†’ author jutsu / resolve improv â€” all driven by NL through the DM
harness or directly via REST/the web app, streamed as IR.

## Run commands (summary)

```bash
npm install            # deps (better-sqlite3 + @anthropic-ai/sdk are optional)
npm run build          # full typecheck gate
npm test               # 63 Vitest tests (the playable loop + every phase checkpoint)
npm run dev            # engine: REST + WS + the web app at http://localhost:8970
npm run mcp            # the MCP controller (stdio) -> engine
npm run dm <room>      # the DM harness REPL
```

