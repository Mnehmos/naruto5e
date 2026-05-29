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

---

## Phase 1 — Character system ✅ (RUNNABLE, COMMITTED)

**Spec:** Ch.1 (character_manage), Ch.2 (20 clans), Ch.3 (backgrounds + Will of
Fire), Ch.4 (8 classes), Ch.6 (skills + checks), casting-by-jutsu-type rule.

**Built (real):**
- `domain/character.ts`: the dual-pool sheet (HP/Hit Dice + Chakra/Chakra Dice
  first-class), abilities (base + tracked bonuses + derived totals), three casting
  tracks, proficiencies, clan traits, class features, conditions, jutsuKnown +
  cap, ryo, Will of Fire, unique clan resources, affinities, `classes[]` (multiclass-ready).
- `rules/skills.ts`: the verified custom skill list by ability (Martial Arts/STR,
  Chakra Control/CON, Crafting+Ninshou/INT, Illusions/WIS, etc.).
- `rules/abilities.ts`: ability mod, **proficiency +3 at L1** scaling +1/4 levels,
  rank-from-level bands, point-buy (27) validation, standard array, 4d6-drop-lowest
  (seeded), take-average leveling.
- `rules/character.ts`: clan/class/background application (ability increases incl.
  choices, skill grants incl. chooseN, saves, features, unique resources), and
  `deriveCharacter` — computes totals, both pools (die + CON per level, + clan
  HP/chakra bonuses), AC (incl. Taijutsu Unarmored Defense = 10+DEX+CON), the three
  type-keyed casting tracks (Nin=INT, Gen=WIS, Tai=max(STR,DEX)), jutsuKnown cap.
- `intents/character.ts`: `character_create` (one-shot 7-step build), granular
  `character_set_{abilities,clan,class,background}`, `character_finalize`,
  `character_add_mission_points`, `character_level_up`, `will_of_fire`
  (grant/spend/gift/reset_mission), `character_spend_chakra`, `character_heal`.
- `intents/checks.ts`: `skill_check`, `saving_throw`, `ability_check` (Ch.6, all
  deterministic d20 math, adv/dis/bonus, vs-DC).
- Content: `content/classes.json` (8 classes), `content/clans.json` (20 clans),
  `content/backgrounds.json` (10 backgrounds). REST `/v1/content/{clans,classes,
  backgrounds}` reads + `POST /v1/characters`. MCP tools: `create_character`,
  `level_up`, `list_clans`, `list_classes`.

**Checkpoint proven:** builds any legal character end-to-end with correct dual
pools, ability totals, proficiency, rank, saves, AC, and the three type-keyed
casting mods; educational rejections for unknown clan / bad point-buy / missing
choices; Will of Fire spend/gift; deterministic rolled abilities; level-up scaling.
19 tests pass; E2E builds a character through the controller.

**Logged divergences / rules-faithful defaults (data cells the spec flagged
NEEDS VISUAL READ — encoded as defensible defaults, easy to correct in content):**
- Save pairs: Genjutsu (CON/CHA ✓), Intel Op (DEX/INT ✓), Scout-Nin (STR/CON ✓),
  Weapon Spec (STR/DEX ✓) confirmed. **Defaulted/flagged**: Ninjutsu Spec
  (INT/WIS), Medical-Nin (WIS/CHA), Taijutsu Spec (STR/DEX — later OCR note over
  the Ch.4 table's STR/CON), Hunter-Nin (DEX/WIS — unverified). `savesVerified`
  flag on each class.
- Jutsu Known cap = a per-archetype formula anchored on the verified Genjutsu
  progression (caster 2+⌈L/2⌉, hybrid 1+⌈L/2⌉, martial 1+⌈L/3⌉).
- Hyuga/Non-Clan/Uchiha ability lines + several backgrounds' Feature/ASI cells were
  column-fused in the source; encoded as rules-faithful values with `verified:false`.
- Taijutsu casting uses max(STR,DEX) (spec says "STR/DEX"); Genjutsu Pledge WIS→CHA
  swap not yet wired (default WIS).

**Stubbed / deferred:** clan-jutsu trees + unique-resource mechanics (Calories,
dojutsu activation, ninken) are stored as descriptors; their active mechanics land
with combat/jutsu (Phase 2+). Subclass feature sets are descriptive.

**Next:** Phase 2 — jutsu casting + combat.

---

## Phase 2 — Jutsu casting + combat ✅ (RUNNABLE, COMMITTED)

**Spec:** Ch.8 (combat_manage + combat_action), Ch.9 (jutsu_manage — the
keystone), Action Economy (TurnBudget), clash_resolve + elemental_advantage_resolve.

**Built (real):**
- **Structured jutsu effects.** Extended `tools/extract_jutsu.py` to derive a
  structured `effect` per jutsu from the description (the resolvable 90%):
  delivery (attack/save/auto/utility), saveAbility, damage {dice,type},
  halfOnSave, conditions, area {size,shape}, concentration. Re-extracted: of 399
  jutsu, **149 save / 69 attack / 24 auto / 157 utility**, 127 with damage, 95
  with conditions, 85 with area — so casts resolve deterministically.
- `rules/turnBudget.ts`: TurnBudget {action,bonus,reaction,movement,
  freeInteraction}; cost-from-casting-time; the affordability gate (canAfford/
  spend) — action economy + chakra + components unified, checked BEFORE any dice.
- `rules/conditions.ts`: the Ch.8 condition list; incapacitating set; component
  blocking (Restrained/Grappled block mobility).
- `rules/combat.ts`: `elementalAdvantage` (Fire>Wind>Lightning>Earth>Water>Fire),
  `clashResolve` (opposed = casting mod + rank value + d20, advantage to the
  superior element, half on a close call / tie), crit-doubles-dice damage roll.
- `rules/actor.ts`: a unified actor view over characters (and adversaries in
  Phase 4) — casting tracks, AC, ability mods, affinity.
- `rules/resolve.ts`: pure damage application — temp HP, downed (PC -> death
  saves) vs. dead (NPC at 0 / PC overkill >= max HP), heal/revive.
- `domain/encounter.ts` + character combat fields (turnBudget, deathSaves,
  ≤2 concentration slots, dead, dodging).
- `intents/jutsu.ts` (**the keystone `castJutsu`**): known-check, component gate,
  chakra gate, off-turn lockout + budget gate (in combat), concentration cap (≤2),
  upcast/level-scaled damage (parses atHigherRanks), attack/save/auto delivery
  with type-keyed casting + elemental advantage, conditions, healing,
  concentration-break checks. Plus jutsu_learn (cap + keyword gates), forget,
  list_known, check_castable, concentration, define, and `jutsu_clash`.
- `intents/combat.ts`: combat_start (roll initiative -> turn authority), advance/
  end_turn (resets budget, auto death-saves the downed), combat_end, combat_add/
  remove; combat_action family — attack, move (grid Chebyshev + movement pool),
  dash, dodge, disengage, help/hide/search/use_object, ready, cast (delegates to
  the keystone), death_save, condition.
- MCP tools: learn_jutsu, cast_jutsu, attack, start_combat, advance_turn,
  get_encounter.

**Checkpoint proven:** a full encounter with jutsu — initiative order, a
chakra-deducted dice-resolved save-jutsu cast, an unaffordable cast rejected with
an educational `chakra_affordability` failure (required/available/shortfall +
suggestions), off-turn lockout, a batch turn emitting ordered (monotonic-seq) IR,
auto death saves, clash + elemental advantage. **The living E2E
(`tests/playable-loop.test.ts`) drives the whole loop through the MCP controller
and verifies WS IR == intent-response IR.** 26 tests pass.

**Logged decisions / defaults:**
- Jutsu effects are heuristically parsed from free text (the spec's "structure
  transfers, labels need a cleanup pass"). Utility jutsu with no parseable effect
  emit a `cast` IR for the DM to narrate (the exotic 10%). Damage type defaults to
  "force" when unstated near the dice.
- Upcast: explicit `atRank` adds +3 chakra/rank step and (if atHigherRanks names
  "rank") extra dice; "At Higher Levels" clauses scale damage by caster level
  thresholds (5/11/17).
- Concentration check on damage: CON save DC max(10, ⌊dealt/2⌋).
- Enemies in Phase 2 are characters on the "enemy" team (real adversaries land in
  Phase 4); being characters, they roll death saves rather than dying outright.

**Next:** Phase 3 — missions/rest/downtime + equipment/economy.

---

## Phase 3 — Missions/rest/downtime + equipment/economy ✅ (RUNNABLE, COMMITTED)

**Spec:** Ch.7 (mission_manage + rest + downtime), Ch.5 (equipment_manage + Ryo).

**Built (real):**
- `domain/mission.ts` + `intents/mission.ts`: the mission board — mission_post
  (ranked D–S, default reward bands), mission_list, mission_accept (rank gate via
  the rank ladder), mission_resolve (pays Ryo + mission points to the squad, with
  an over-rank bonus multiplier), mission_fail, rank_up (promotion ladder).
- `intents/rest.ts`: `rest` — short (spend Hit/Chakra Dice, roll die + CON each)
  and long (pools to full, recover half the dice, WoF refresh on a mission
  boundary). Returns a three-layer-ready `restResult` (tick + playerDigest embed
  in Phase 9). Downtime: downtime_train (25 wks × 50 Ryo → feat/tool/weapon/
  language), downtime_research, downtime_recuperate (DC 15 CON), downtime_shop
  (5d4% discount).
- `content/equipment.json` (Ch.5 sample data: 21 weapons w/ damage+properties+Ryo,
  6 armor tiers Padded→Shinobi Battle Armor w/ AC rules, 5 consumables w/ onUse,
  gear) + `intents/equipment.ts`: item_give/remove, equip/unequip (armor-aware AC
  recompute in deriveCharacter: light=base+DEX, medium=base+min(DEX,2), heavy=base),
  use_consumable (soldier/blood pill restore rolls), buy/sell (Ryo, discounts,
  sellRate), grant_starting_wealth (by archetype), choose_pack.
- MCP tools: post_mission, resolve_mission, rest, buy_item, equip_item.

**Fix:** `MemoryStore.get` now clones on read (matching `SqliteStore`) so reads
can't alias/mutate stored state — a real correctness fix surfaced by the tests.

**Checkpoint proven:** a full mission loop (post → accept w/ rank gate → resolve →
Ryo + mission-point rewards), rank-too-low educational rejection, rank_up; short
+ long rest dual-pool recovery; buy → equip → AC recompute; unaffordable-buy
educational failure; consumable chakra restore. 33 tests pass.

**Logged defaults:** mission reward bands, starting-wealth by archetype, and some
armor AC values are rules-faithful defaults (the source tables flatten in
extraction — flagged). Standing-gated stock + vendor heat + the full economy_manage
land in Phase 7; the embedded rest tick in Phase 9.

**Next:** Phase 4 — adversaries (tier baselines, Minion/Elite/Solo, Bingo Book).

---

## Phase 4 — Adversaries ✅ (RUNNABLE, COMMITTED)

**Spec:** Ch.14 (adversary_manage) — tier baselines L1–30, Minion/Elite/Solo
modifiers, Bingo Book roster, freeform attacks, the 8-step build.

**Built (real):**
- `rules/adversary.ts`: `adversaryBaseline(level)` — HP = 8+5·(L−1) (exact at all
  four verified anchors), AC/prof/attack piecewise-interpolated through the
  source anchors (L1 11/3/8/5 · L10 13/6/53/30 · L20 14/9/103/58 · L30 16/12/153/90).
  `tierMods` with the EXACT source modifiers (Minion AC−2/dmg×0.2/XP×0.25;
  Elite AC+2/HP×1.5/XP×2 + Elite Action + Tenacity; Solo AC+4/HP×players/XP×4 +
  Legendary Actions (players−1) + Legendary Resistance 3 + Phase Transitions).
  `jutsuRankCap` (minion D / elite B / solo S), `useLegendaryResistance`,
  `checkPhaseTransition` (60% / 30%).
- `domain/adversary.ts`: the trimmed sheet (shares the actor shape so it fights on
  the same combat_action surface as PCs — the architecture's symmetry principle).
- `content/bingo_book.json`: the verified roster — generics (Genin, Chunin, Jonin,
  Anbu, Bandit, Assassin, Monk, Samurai, Warlord) + named foes (Zabuza, Haku,
  Kisame, Itachi, Orochimaru, Kimimaro, Tayuya) with tier/role/clan/affinity/traits
  and "Using X as an Adversary" guidance.
- `intents/adversary.ts`: adversary_spawn/build (8-step), from_bingo_book,
  adversary_scale (the Scaling Enemy rule), freeform_attack (tier/level-scaled),
  legendary_action (off-turn, re-entrant via a `__legendary` bypass that exempts
  the sub-op from the off-turn lockout + budget spend).
- Combat integration: Solo legendary actions refresh +1 per other combatant's
  turn (capped); Legendary Resistance auto-converts a failed save in the jutsu
  save path; Phase Transition fires from both jutsu and weapon damage paths.
  Room state + scoped after-state now include adversaries.
- MCP tools: spawn_adversary, from_bingo_book, freeform_attack, legendary_action.

**Checkpoint proven:** spawns minion/elite/solo with correctly scaled stats;
instantiates a Bingo Book Solo (Zabuza); runs a Solo boss with legendary actions,
legendary resistance, and a phase transition; the living E2E fights a spawned
Solo through the controller. 39 tests pass.

**Logged defaults:** Chakra/damage-per-round scalings and per-level ability mods
are rules-faithful formulas (the full p341 grid flattens in extraction; AC/HP/
prof/attack anchors are exact). Named-foe signature jutsu are flavor traits;
mechanical jutsu assignment uses the catalog + tier rank cap.

**Next:** Phase 5 — customization (multiclass + the feat catalog).

---

## Phase 5 — Customization (multiclass + feats) ✅ (RUNNABLE, COMMITTED)

**Spec:** Ch.13 (character_manage level-up choices) — multiclassing + the feat catalog.

**Built (real):**
- `tools/extract_feats.py` → `content/feats.json`: **112 feats** parsed from the
  source (Acrobat, Actor, Advanced Study, Alert, Athlete, Blinding Agility, Apex
  Heritage, …) with name/category/prerequisite(abilities/level/clan)/abilityIncrease/
  benefits — 45 with a parsed +ASI, 30 with prereqs.
- Multiclass-aware **`deriveCharacter`**: pools now sum per-class-level dice
  (first character level = max die; later levels = die average), and jutsuKnownCap
  = the sum of each class's cap at its class level (the "Jutsu Known & Highest
  Rank Known" combining rule). `classes[]` entries carry hitDie/chakraDie/archetype.
- `rules/multiclass.ts`: ability-prereq gate (casters need 13 in their casting
  ability; martial/hybrid need 13 in a class ability).
- `intents/customization.ts`: `character_multiclass` (level into a new class with
  prereq check, recompute pools/prof/jutsu-known, grant the new class's L1
  features), `ability_score_improvement` (+2/one or +1/two, capped at 20),
  `take_feat` (prereq validation: ability mins/level/clan; applies the feat's
  ability-increase choice; records it). Feat levels L4/8/12/16/19 flagged.
- `/v1/content/feats|bingo|equipment` reads + MCP tools: multiclass, take_feat,
  list_feats.

**Checkpoint proven:** multiclass with combined pools + jutsu-known; multiclass
prereq educational rejection; the 112-feat catalog loads; take_feat applies an
ability increase + validates prereqs; ASI. 45 tests pass.

**Next:** Phase 6 — Standing / RPP (standing_manage).

---

## Phase 6 — Standing / RPP ✅ (RUNNABLE, COMMITTED)

**Spec:** The Merit Economy — standing_manage (per-authority reputation + favor,
gating, the rogue defect path).

**Built (real):**
- `domain/standing.ts`: per-authority `StandingLedger` (reputation threshold +
  capped spendable favor + obligations + hostile flag) and a `softDescriptor`
  (hard number, in-fiction presentation).
- `rules/standing.ts`: `applyStandingDelta` (the shared spine Phase 7 routes
  through — favor clamped to cap, hostility on negative rep), ensure/get helpers.
- `intents/standing.ts`: grant_reputation, grant_favor (respects favorCap),
  spend_favor (educational insufficient_favor), check_access (reputation
  threshold → offered?), add_obligation/discharge_obligation, **defect** (the
  rogue path = a ledger swap: old village craters to hostile, a patron ledger
  opens), get_ledgers (with descriptors).
- MCP tools: grant_standing, spend_favor, check_access, defect, get_ledgers.

**Checkpoint proven:** reputation gates access (offered vs not), favor is capped
+ spendable with educational over-spend rejection, the rogue defect swaps ledgers.
47 tests pass.

**Next:** Phase 7 — world-consequence systems (npc/economy/theft/corpse), all
routing deltas through standing_manage.

---

## Phase 7 — World-consequence systems ✅ (RUNNABLE, COMMITTED)

**Spec:** the integrated memory · economy · theft · corpse systems, all routing
deltas through standing_manage (the currency spine).

**Built (real):** `domain/world.ts` + `intents/world.ts`:
- **npc_manage**: npc_create, npc_interact (records a memory; a memory's
  standingDelta writes into the authority ledger — "the memory is the why"),
  npc_learn_fact, npc_get_relationship. familiarity/disposition tracked.
- **economy_manage**: vendor_create (open + gated stock), economy_list_stock
  (gated entries unlocked by Standing), economy_buy (gated stock unbuyable without
  the reputation — "Ryo buys; Standing permits" — plus a standing discount).
- **theft_manage**: theft_steal (heat + witnesses), theft_report (Standing hit
  with the jurisdiction, accumulating heat → the **rogue trigger** at a
  threshold/repeat), theft_heat_decay, theft_fence (launder via a heat-capacity
  vendor → builds patron Standing).
- **corpse_manage**: corpse_create, corpse_loot (mundane), corpse_harvest (a
  weighted KKG/secret/scroll → craters the deceased's authority, spikes the
  patron's; KKG gated to a *fresh* body — real time pressure), corpse_recover
  (honor → Standing-positive), corpse_advance_decay.
- All standing-affecting acts go through `applyStandingDelta`. MCP tools:
  npc_interact, economy_buy, steal, harvest_corpse, recover_corpse.

**Checkpoint proven:** a theft (reported → Standing drops, repeats → rogue
trigger) and a corpse-harvest (KKG → deceased authority craters + patron spikes;
decayed body rejects harvest) each move Standing; gated stock blocks/unblocks on
reputation; recovery raises Standing. 52 tests pass.

**Next:** Phase 8 — content tools (jutsu_build point model + freeform resolver).

---

## Phase 8 — Content tools (jutsu_build + freeform) ✅ (RUNNABLE, COMMITTED)

**Spec:** the empirical jutsu point-cost model, jutsu_build (governor), and the
freeform/improv resolver.

**Built (real):**
- `rules/pricing.ts`: the EXACT model — budget {E:2,D:4,C:8,B:14,A:19,S:28};
  spend = Σ(dice×per-die) + range×0.04 + areaDim×0.107 + 0.4×conditionTiers
  −10%(concentration); per-die d4 1.0 … d12 2.5; E/D floor discount. `verdict`
  green/yellow/red with a plain-language balance note. **Validated against the
  spec's worked examples**: C 3d8/60ft/20ft→9.6, A 10d8/90ft→20.6, S 10d10/120ft→25.8.
- `intents/content.ts`: `jutsu_build` (op draft|price|rerank|commit) — draft
  assembles a full Ch.9 record (envelope + structured effect) with points +
  verdict; commit adds it to the catalog (indistinguishable from canon —
  learnable + castable with zero special-casing). `freeform` (op resolve|cost) —
  conforms an improv into a priced, ephemeral, castable primitive sharing the same
  pricing engine (so a one-off can't out-power a real jutsu). MCP jutsu_build +
  freeform tools.

**Checkpoint proven:** the model reproduces canon within band; draft → verdict;
commit makes a built jutsu learnable + castable end-to-end; freeform resolves an
improv into a castable primitive op. 57 tests pass.

**Next:** Phase 9 — the tick system (rest-embedded multi-agent world advancement).

---

## Phase 9 — The tick system ✅ (RUNNABLE, COMMITTED)

**Spec:** Architecture §12-13 — rest-bounded multi-agent world advancement,
embedded in the rest/downtime return as restResult + tick + playerDigest.

**Built (real):** `intents/tick.ts`:
- `runEmbeddedTick(magnitude, playerIds)`: deterministic off-screen world
  advancement — theft heat decay (long: a step / downtime: fully cools), corpse
  decay, in-scope NPC "agents" acting (a deterministic, seeded stand-in for the
  LLM-tier agents — patrol / train / leverage standing / leave a message), economy
  drift/restock. Standing deltas route through `applyStandingDelta`. Builds the
  three-layer package; the **playerDigest is the narration filter** (only outcomes
  touching the player surface).
- The **`rest` handler now embeds the tick** (§13): one call → restResult (party
  benefit) + tick (full world advancement into state) + playerDigest (what the DM
  reads aloud). Magnitude keyed to rest type: short=small, long=medium,
  downtime=large. `downtime` recovers like a long rest + fires a large tick.
- Standalone `tick_preview` (scope without resolving), `tick_run`, `tick_resolve`
  (resolve a DM-conformed batch of agent/world ops — the LLM-supplied path).
  MCP tick tools.

**Note:** the engine hosts no LLM (§2.4), so per-NPC agent actions are a
deterministic stand-in here; in the full deployment the LLM tier supplies richer
agent intents via tick.run/agent.tick and the DM conforms them into tick.resolve.
This embedded path lets the world advance autonomously so the loop always runs.

**Checkpoint proven:** a long rest returns restResult + tick (medium) +
playerDigest and the tick mutates world state (heat cools, agents act); downtime
fires a large tick (heat fully cools, economy restock). 60 tests pass.

**Next:** Phase 10 — renderers (the tactical visualizer + role-aware app shell).

---

## Phase 10 — Renderers (tactical visualizer + app shell) ✅ (RUNNABLE, COMMITTED)

**Spec:** the 3D tactical visualizer (subscribes to the IR stream; click = intent
via direct REST) and the role-aware app shell (player|DM).

**Built (real):** `apps/web/index.html` — a self-contained, zero-build web client
the engine serves at `/` (`express.static`). It is a pure renderer of engine state
+ IR (never a source of truth):
- **App shell** (role-aware): top bar (scene · round/turn · Will of Fire · role
  toggle), left rail (character sheet + party/field cards with HP/Chakra bars +
  conditions), center tactical map, right rail (narration/IR feed as prose), bottom
  drawer tabs (Jutsu · Inventory · Console).
- **Tactical visualizer** (canvas, top-down): grid, team-colored tokens with HP +
  Chakra bars, active-turn glow, and the cast AoE shape drawn from the jutsu's area
  data. Subscribes to `ws://…/v1/rooms/{room}/stream`; every IR batch appends
  narration and re-hydrates state.
- **Interaction = intent submission** (the symmetry, made visual): click a tile →
  `move` intent; click a target token → `attack`; arm a jutsu card + click a
  target → `cast`; action bar (advance/begin/end combat/dodge/dash); a raw-intent
  Console (the DM write-path). Every commit round-trips through engine REST; the
  client only proposes.

**Decision (logged):** implemented as a vanilla canvas client rather than
Three.js/R3F so it runs with **zero install/build** (the "runs tonight" stack
goal). Because actions arrive as typed IR carrying classification + element +
area, the 3D/diorama upgrade is a later additive swap on the same IR contract —
the tactical layer never depends on it.

**Verified:** the engine serves the app at `/`; panels render live state; clicks
submit intents; the IR feed updates over the websocket.

**Next:** Phase 11 — the LLM DM client wired to the MCP controller.

---

## Phase 11 — LLM DM client ✅ (RUNNABLE, COMMITTED)

**Spec:** wire a real DM brain (parser + agent orchestration) to the MCP controller.

**Built (real):** `packages/harness` (tier 3 — the sole write-path):
- `DMBrain.respond(roomId, utterance)` — reads room state via the controller's
  `EngineClient` (the thin MCP adapter into engine REST), conforms the player's
  natural language into structured intents, submits them, and narrates the
  resulting IR. Surfaces educational rejections as re-conformable beats.
- **Two modes**: *LLM mode* (when `ANTHROPIC_API_KEY` is set and
  `@anthropic-ai/sdk` is available) — Claude (`claude-opus-4-8` by default) runs a
  tool-use loop with a `submit_intent` tool + a DM system prompt + a state digest,
  routing every tool call to the engine and feeding IR back. *Deterministic
  fallback* (offline) — `parser.ts` maps common phrasings (cast/attack/move/
  narrate/advance/rest/combat) onto intents, resolving actor/target names to ids
  from room state. The SDK import is dynamic so the harness runs with no key.
- `cli.ts` — a REPL DM (`npm run dm <roomId>`). The harness never holds
  authoritative state and never rolls dice; it declares intent, the engine decides.

**Checkpoint proven:** the brain parses NL into structured intents, drives the
engine through the controller's client, narrates resolved IR, and surfaces
educational rejections. 63 tests pass.

---

## FINAL STATUS — all 11 phases complete, runnable, committed

Engine (tier 1) + MCP controller (tier 2) + DM harness (tier 3) + a web renderer,
spanning all 14 rulebook chapters + the seven layered systems + the content tools
+ the tick. 63 Vitest tests pass; `npm run build` (full typecheck) is clean; the
dev server boots on SQLite and serves the app. See PLAYTEST.md to run it.
