# Naruto 5e — a three-tier deterministic RPG engine

A feature-complete, playtestable engine for the Naruto 5e tabletop conversion,
built in dependency order with a runnable checkpoint after every phase.

> **Unofficial fan work.** Not affiliated with or endorsed by the rights holders.
> Naruto © Masashi Kishimoto / Shueisha / Viz Media / Shonen Jump. Non-commercial,
> local-first. The Naruto content is data loaded from a local content pack; the
> engine core is generic, IP-clean mechanics.

## The three tiers (Architecture)

1. **Engine** (`packages/engine`) — the authoritative, deterministic game server.
   Owns all state, dice, and rules. REST API + websocket IR stream + scoped state
   reads. Knows nothing of MCP or LLMs.
2. **MCP controller** (`packages/mcp-controller`) — a thin, stateless adapter that
   exposes engine capabilities as MCP tools and routes calls to the engine's REST
   API. Holds no game state, no game logic.
3. **DM/LLM harness** (Phase 11) — the sole write-path for play: parses intent,
   adjudicates, drives the controller.

`packages/shared` holds the contract both tiers depend on: deterministic dice, the
IR event stream, the intent envelope, and the educational-failure error type.

## Laws (non-negotiable)

- The DM is the sole write-path; players read-only on their own state.
- The engine adjudicates ALL dice; validation precedes mutation; **the engine never
  escalates** — intent flows one way in.
- Every rejection is *educational*: what failed / why (named rule + numbers) /
  state-at-stop / how-to-fix.
- Access = exposure, not auth. Reads = scoped queries.

## Run

See [PLAYTEST.md](PLAYTEST.md). TL;DR: `npm install && npm run build && npm run dev`.

## Build status

See [BUILD_LOG.md](BUILD_LOG.md) for the phase-by-phase log. Each phase ends
runnable, tested, and committed.
