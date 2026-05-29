# Naruto 5e — Build Log

Decisions, real-vs-stub status, and "next" at every phase boundary. The
discipline: **the system RUNS at every checkpoint.** Authoritative sources are
`naruto5e_architecture_UPDATED.pdf` (system shape) and
`naruto5e_rules_spec_UPDATED.pdf` (the ruleset). Both were read in full before
coding; extracted to `_extracted_architecture.txt` / `_extracted_rules_spec.txt`.

## Architecture decisions (carried across all phases)

- **Three tiers, separately hosted.** `packages/engine` (tier 1, authoritative
  deterministic resolver: REST + WS + scoped reads), `packages/mcp-controller`
  (tier 2, thin stateless adapter → engine REST, no game logic), `packages/shared`
  (the contract: dice, IR, intent envelope, errors). The DM/LLM harness (tier 3)
  lands in Phase 11.
- **The engine NEVER escalates** (Architecture §9.1, which supersedes the §0/§2.3
  escalation framing). Intent flows one way in; the engine is a pure deterministic
  resolver of conformed, validated operations. `IntentResult.status` is
  `"resolved" | "rejected"` only.
- **Action surface = the ruleset** (§9.3). `Intent.type` is an open string
  validated per-handler, not a closed enum. Handlers register onto the engine.
- **Educational failures** (§11): every rejection carries what/why (named rule +
  actual numbers)/state-at-stop/how-to-fix. Implemented as `EngineError` →
  four-part rejection in the pipeline. No bare rejections anywhere.
- **Batch** (§10): ordered, sequenced transaction; default stop-on-failure
  (commit prior ops, return remaining + reason), `atomic:true` = all-or-nothing.
- **Deterministic dice**: seedable mulberry32 RNG per room, state persisted on the
  room doc so playtests reproduce and survive restart. The engine owns ALL dice.
- **Stack**: TypeScript + Node, ESM, Zod at all boundaries, Vitest. Dev runs via
  `tsx` (no compile step needed to run); `npm run build` = `tsc --noEmit` (full
  typecheck gate).
- **DB layer**: a *document store* (named collections of JSON docs keyed by id) so
  schema migrations stay trivial and Zod owns shape. Driver is **SQLite by default**
  (`better-sqlite3`), auto-falling-back to a JSON-backed in-memory store if the
  native module is unavailable — so it always runs. Tests use pure `memory`.
  Postgres detection (DATABASE_URL) is wired but currently degrades to the durable
  memory store (the doc-store shape ports cleanly to a jsonb column later).

## Roster reconciliation (logged divergences)

- The build brief said "ALL 18 clans"; the UPDATED rules spec corrects this to
  **20 playable Chapter 2 entries** and explicitly excludes elemental-release /
  adversary clans. **Following the UPDATED spec: 20 clans.**
- "Nine classes" vs **8 confirmed base classes**: the spec flags an unresolved
  ninth-class statement. Building the 8 confirmed; ninth tracked as a TODO.

---

## Phase 0 — Substrate ✅ (RUNNABLE, COMMITTED)

**Spec:** Architecture §1–§11 (tiers, intent contract, batch, educational failures);
Stack section.

**Built (real):**
- `packages/shared`: seedable `Rng` + dice (`rollExpression`, `rollD20` with
  adv/dis/crit), `IREvent` + `IRStream` (ordered, monotonic seq), the `Intent`
  envelope + `IntentResult` (Zod), `EngineError`/`reject` (educational failures),
  ids.
- `packages/engine`: `Store` doc-store interface + `MemoryStore` (with JSON
  persistence + transactional rollback) + `SqliteStore` (better-sqlite3, one table
  per collection, BEGIN/COMMIT/ROLLBACK) + `createStore` driver picker w/ fallback.
  `ContentPack` loader (loads `content/jutsu_catalog.json`, tolerant of missing
  files). `Engine` class: handler registry, per-room RNG, `resolveIntent` (single +
  `batch`, atomic + stop-on-failure), RNG rollback on reject, IR broadcast,
  scoped reads. REST + WS server (`api/http.ts`). Core intents: `narrate`, `scene`,
  `ping`.
- `packages/mcp-controller`: `EngineClient` (HTTP adapter), MCP tool surface
  (`submit_intent`, `batch`, `narrate`, `get_room_state`, `get_character`,
  `list_jutsu`) on the `@modelcontextprotocol/sdk` `McpServer` over stdio.
- Content: `tools/extract_jutsu.py` deterministically parses **399 jutsu** from the
  source PDF (Ch.10–12) into `content/jutsu_catalog.json` — 386 cleanly named, 13
  honestly null-flagged (never fabricated), all 5 ranks + 4 classifications.

**Checkpoint proven:** a trivial intent round-trips through REST and the SAME IR
streams over the websocket (`tests/phase0.ws.test.ts`); the MCP controller drives
the engine over REST (`tests/e2e.test.ts`). Dev server boots on SQLite. 11 tests pass.

**Stubbed / deferred:** Postgres native driver (degrades to durable memory).
Full jutsu catalog is 399/708 (clan-tree jutsu scattered in clan sections are a
later extraction pass; mechanically complete for play).

**Next:** Phase 1 — character system.
