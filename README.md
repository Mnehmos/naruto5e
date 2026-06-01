# Naruto 5e

**A rules-authoritative Naruto 5e engine where LLMs parse player intent and narrate outcomes — but deterministic code owns state, dice, chakra, jutsu legality, combat, and persistence.**

The model is the *storyteller and the interpreter*. It never decides whether an attack hits, whether a jutsu is legal, how much chakra is left, or what happened last week. A deterministic TypeScript engine owns all of that and exposes it through a single tool surface (MCP). The LLM reads intent ("I slip into the crowd and detonate the dust"), the engine adjudicates it against the rules and the saved world, and the LLM narrates whatever the engine actually returned — **never ahead of it.**

> 📖 **Live journey site:** https://mnehmos.github.io/naruto5e/ — an autonomous playtest rendered as a manga.

> **Unofficial fan work.** Not affiliated with or endorsed by the rights holders. Naruto © Masashi Kishimoto / Shueisha / Viz Media / Shonen Jump. Non-commercial, local-first. The Naruto content is data loaded from a local content pack; the engine core is generic, IP-clean mechanics.

> **SRD attribution.** General 5e mechanics in this engine are derivative of the System Reference Document 5.1 by Wizards of the Coast, licensed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/legalcode). See [`NOTICE`](./NOTICE) for the full attribution. Naruto-specific content (clans, jutsu catalog, chakra natures, KKG recipes) is fan-authored and NOT covered by the SRD license.

---

## The real differentiator: the engine is developed through *agentic playtesting*

Most rules engines are tested by their authors writing assertions. This one is hardened by **LLM agents running real campaigns through the exact same tool surface a human player uses** — and the development loop closes itself:

1. **Play.** An agent runs a full campaign (character genesis → academy → missions → exams), making real engine calls for every check, spar, cast, and rest.
2. **Detect.** When narration, ledger, and engine state disagree — or a tool errors, or a result is plainly wrong — the contradiction surfaces *in play*, not in a unit test written in a vacuum.
3. **File.** The agent logs a **structured bug** (tool, inputs, error, in-story context, severity) to an external tracker.
4. **Patch.** The agent fixes it in engine source, rebuilds, and **re-verifies through the same tool surface**.
5. **Regress.** The verified fix becomes a **regression test**, so the contradiction can never silently return.

The Naruto engine is the fun part. **This self-improving play → detect → file → patch → regress loop is the point.**

### Proof from the current playtest — *"Iwao: The Particle Heir"*

A Dust Release (Jinton) genin of the Hidden Stone, played day by day. Two real engine defects were caught *while playing* and fixed live:

| Found in play | What broke | Fix | Became a test |
|---|---|---|---|
| Character genesis | `create_character` rolled affinity/KKG **blindly** — the campaign's required Dust Release bloodline was effectively unrollable | a `kkg`/`affinities` param pins genesis deterministically (`rules/affinity.ts`, `intents/character.ts`) | ✅ deterministic-pin + unknown-KKG rejection |
| First ninja spar | `agent_context` read a PC-only field, so **kitted enemies always showed "0 jutsu castable"** — silently pushing every NPC toward generic freeform attacks | read the adversary's own kit (`intents/agent.ts`) | ✅ "surfaces a kitted adversary's jutsu" |

Both shipped as commits with green suites, then were confirmed back *in the campaign* (an enemy genin cast a real Earth Release technique the very next day). The playtest manuscript lives in [`playtest-dustrelease/chapters/`](playtest-dustrelease/chapters/).

---

## The three tiers (Architecture)

1. **Engine** (`packages/engine`) — the authoritative, deterministic game server. Owns all state, dice, and rules: chakra/HP/resources, jutsu legality & multi-axis gating, combat & turn economy, affinity/KKG genesis, NPC memory + a world-tick, Standing/factions, missions, and persistence. REST API + websocket IR stream + scoped state reads. Knows nothing of MCP or LLMs.
2. **MCP controller** (`packages/mcp-controller`) — a thin, stateless adapter that exposes engine capabilities as MCP tools and routes calls to the engine's REST API. Holds no game state and no game logic; every tool collapses to "submit an intent."
3. **DM/LLM harness** (`packages/harness`) — the write-path for play: parses intent, adjudicates via the engine, narrates the result. Falls back to a deterministic parser with no API key required.

`packages/shared` holds the contract both tiers depend on: deterministic dice, the IR event stream, the intent envelope, and the educational-failure error type.

## Laws (non-negotiable)

- The DM is the sole write-path; players are read-only on their own state.
- The engine adjudicates ALL dice; **validation precedes mutation**; the engine never escalates — intent flows one way in.
- **Narrate from state, never ahead of it.** A success the engine denied is a fidelity break, by definition.
- Every rejection is *educational*: what failed / why (named rule + numbers) / state-at-stop / how-to-fix — so an LLM (or a human) self-corrects in one round-trip.
- Access = exposure, not auth. Reads = scoped queries.

## Run

```bash
npm install
npm run dev      # the deterministic engine (tsx watch) on NARUTO_ENGINE_URL
npm run mcp      # the MCP controller (tool surface) — point your MCP client here
npm run test     # vitest — the regression suite the playtest loop feeds
npm run dm       # optional LLM DM harness CLI (deterministic-parser fallback without a key)
```

Config lives in `.env` (see `.env.example`; `.env` is gitignored — no secret is committed). No key is needed for the deterministic engine or the parser-fallback DM; an `OPENAI_API_KEY` only powers the optional autonomous **NPC-agent** layer. Full run notes in [PLAYTEST.md](PLAYTEST.md); phase-by-phase history in [BUILD_LOG.md](BUILD_LOG.md).

## Repository layout

```
packages/engine            deterministic rules engine (source of truth)
packages/mcp-controller    MCP tool surface (submit_intent / batch / scoped tools)
packages/harness           optional DM brain (LLM or deterministic fallback)
packages/shared            shared contract: dice, IR stream, intent envelope, errors
content/                   jutsu catalog, clans, classes, backgrounds
playtest-dustrelease/      the autonomous playtest: manga chapters + running ledger
docs/                      the journey website (GitHub Pages)
```

## Status

Active. The engine is real and growing; the autonomous playtest is in progress and publishes its findings — story *and* bugs — as it plays. Every die in the chronicle was rolled by the engine.

*Built collaboratively by human direction and AI agents — including the playtester that found the bugs above.*
