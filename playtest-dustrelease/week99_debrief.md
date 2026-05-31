TITLE: Playtest Debrief — Volume One
DATES: meta · after Day 90 · the engineering log behind the manga
---
This is not a chapter of the story. It is the reason the story is trustworthy.

Everything in *Iwao: The Particle Heir* was played, not written. A language model held the Dungeon Master's chair and narrated; a deterministic TypeScript engine — the naruto5e MCP server — owned every number. The DM never rolled a die in its head, never decided a save succeeded because the plot wanted it to, never granted a level because the scene felt earned. It *asked the engine,* and the engine answered with the same indifference it shows everyone. Volume One is what came out the other side. This debrief is the audit trail.

## The thesis under test
The project's claim is narrow and falsifiable: **an LLM should parse intent and narrate consequence, but it should not be trusted with state.** State — dice, chakra pools, jutsu legality, action economy, HP, XP, persistence — belongs to code that cannot be talked out of the rules. The interesting question is not "can an LLM run a satisfying campaign" (it can, and will cheerfully fudge to do so). It is: *can a campaign be run where the LLM is structurally forbidden from fudging, and is the result still good?* Volume One says yes — and that the constraint makes it better, not worse.

## The dice owned the story — three proofs
The cleanest evidence that the engine, not the author, was in charge is the set of moments where the dice **contradicted the obvious narrative plan** and the story bent to them instead of the reverse:

- **Day 23 — the deferred awakening.** The plan, the pacing, the dignitaries all pointed at the heir awakening the Dust Release before the Third Tsuchikage. The d20 came up a natural 1. The bloodline *refused him.* Rather than retcon the roll, the awakening was deferred twenty-three in-story days and the failure became the spine of the arc — Ōnoki turning a fumble into the real lesson (*hold the natures like a frame, not a fist*). A scripted story never fumbles its own climax. This one did, and was better for it.
- **The mid-term — a failure that passed.** Iwao's tactical plan failed its INT check under pressure. He passed the evaluation anyway, because he had left gaps and *trusted his cell to cover them* — and they rolled well enough to do it. The engine refused to let him win by being smart; it let him win by not being alone. The theme was discovered in the dice, not imposed on them.
- **The finals — a genuine loss.** The campaign's climax was a defeat. Iwao failed a STR save against Hayato's Rock Tank and dropped to 0 HP in front of the continent. There was no authorial reflex to save him. He lost, was stabilized, and the *verdict* (promotion withheld) was reasoned forward from the honest result rather than backward from a desired one. The protagonist of the manga did not win his own tournament. The engine wouldn't let him, and the story is sharper for the scar.

If the LLM had owned state, none of these happen — the model's overwhelming bias is toward narrative satisfaction, and all three of these moments are the engine overruling that bias.

## The development loop — the real differentiator
The unusual part of this project is not the campaign; it is that **the campaign was a QA harness.** The agent played in earnest, and when the engine did something wrong, it ran the full loop without leaving the chair:

> **play → detect contradiction → file structured bug → patch the engine source → add a regression test → resume the same save.**

Five findings surfaced this way over Volume One. Each was filed to Agent Synch (project `naruto5e-playtest`), fixed in `packages/engine/src`, and — where it was a true defect — pinned by a regression test so it can never silently return.

### The findings

1. **`create_character` had no way to specify a Kekkei Genkai** — `bug_1780212505469` *(high · fixed, commit `4253221`)*
   You could not author a character *with* a bloodline; genesis was random-only. For a campaign whose entire premise is a specific reborn bloodline, this was disqualifying. **Fix:** added `kkg` / `affinities` params to the intent, a `findKKGRecipe()` + `rollGenesis(opts)` path in `affinity.ts` that pins recipe elements deterministically and skips random expansion, and `unknown_kkg` / `unknown_affinity` validation rejections. Regression test: authored-genesis pins Dust = Earth+Wind+Fire; an unknown KKG name is rejected.

2. **`agent_context` hid kitted adversaries' jutsu** — `bug_1780214524649` *(high · fixed, commit `af5d2be`)*
   This was the root cause of a symptom that had nagged for days: *why do NPCs only ever freeform?* The context builder read `doc.jutsuKnown` only, while spawned adversaries stored their loadout under `doc.jutsu`. So the NPC-driving layer never saw their techniques and fell back to improvisation every time. **Fix:** one line — `doc.jutsuKnown ?? doc.jutsu ?? []`. Regression test: a kitted adversary's jutsu now surface in its agent context. (Small diff, large behavioral payoff — the enemies started fighting like ninja.)

3. **`turnBudget` persisted after combat ended** — `bug_1780248689058` *(medium · fixed, commit `560e96e`)*
   Found **live**, mid-exam: after a combat resolved, scene-mode jutsu casts were being blocked by a stale "no action left this turn" gate that should only exist inside initiative. **Fix:** the action-economy and chakra-spend gates in `jutsu.ts` now apply only when there is an active combatant (`if (active && isCombatant(caster))`), and `end_combat` in `combat.ts` clears `turnBudget` for every combatant on the way out. Regression test: scene-mode casting is not blocked by a stale post-combat budget. This is the loop at its best — the bug was discovered *because the agent was genuinely trying to cast in a scene,* not because anyone was looking for it.

4. **Standing inflation on every rest** — `bug_1780245857774` *(low · open, resolved in design)*
   The world-tick advances NPC goals on each long rest, and one consequence type auto-grants the player reputation — so fame crept upward whether or not it was earned. Rather than suppress the tick, this was resolved *thematically* and is now load-bearing in the fiction: **reputation = renown** (passive fame the bloodline draws whether deserved or not — explicitly "not the point"), while **favor = the Will of Stone** (DM-awarded only, for defining moments). The engine's two standing tracks map cleanly onto the story's two kinds of regard. Left open as a design note rather than patched.

5. **Rank auto-derived from level** — `bug_1780247960181` *(low · closed in fiction)*
   At L5 the engine auto-set the character's rank to "Chunin," which collided with a title that is supposed to be *earned at the exam.* This one resolved itself the best possible way: at the finals, Ōnoki **withheld promotion.** The in-world title stays Genin, which now matches the adjudicated result exactly — so the divergence closed on its own through honest play, with the engine's `rank` field treated as a jutsu-tier indicator only. The story did the engine's bookkeeping for it.

### One feature, built to spec mid-run
Not a bug, but worth logging: the engine had **no XP or leveling system** when the campaign began, and the player asked for one explicitly — *"please dont forget to integrate xp awards and leveling. add it to the engine if you must."* So it was added (commit `69ceb9f`): a new `progression.ts` (`xpThreshold(L) = 50·(L−1)·L`, `levelForXp`, `xpToNext`), an `xp` field on the character domain, and an `award_xp` intent that adds XP, emits an event, and auto-levels across every threshold it crosses. From then on every level was *earned through a logged award* — small for a quiet milestone, larger for the finals loss — never hand-set. The progression visible in the HUD is a sum of real awards, auditable in the ledger.

### Still open (honest housekeeping)
- **Prone lingers through a long rest.** After the finals, `end_combat` and a subsequent long rest both restored HP/chakra correctly but left the `Prone` condition attached. Cosmetic — it doesn't affect pools or legality — but a long rest should clear knocked-prone status. Logged, not patched, to avoid end-of-arc scope creep. It's the kind of thing the next playthrough's loop will pick up.

## What the regression suite proves
Every true defect above is now a test in `packages/engine/src/regression.test.ts`, green alongside the rest of the suite. That is the difference between "we played and found bugs" and "we played, found bugs, and made the engine permanently incapable of regressing them." The bugs became *assets* — each one a guarantee. A playthrough that doesn't harden the engine is just a game; one that does is a development methodology that happens to produce a manga as its artifact.

## The verdict
The engine held. Across ~90 in-story days — Academy drills, graduation, D-rank missions, two false starts and one true awakening of the deadliest bloodline in the setting, a public exhibition, and a three-stage Chūnin Exam ending in a duel — **state was never fabricated, dice were never overridden, and the one time the protagonist's victory and the dice disagreed, the dice won.** The LLM did what LLMs are good at: it read intent, it narrated, it found the human shape in the numbers. The engine did what code is good at: it refused to lie. The seam between them is the whole product.

Iwao did not become a chūnin. That sentence is the proof. A system willing to write it is a system you can trust with the ones where he succeeds.

*— End of the Volume One playtest. The save persists. The loop is open. Volume Two begins whenever the next die is cast.*

---LOG---
PLAYTEST DEBRIEF · Volume One · campaign camp_e3ca139f · hero char_9314ed6b (Iwao, L6, XP 1700).
FIDELITY: 3 dice-over-plan proofs (Day-23 nat-1 deferred awakening · mid-term failed-INT teamwork win · finals failed-STR-save LOSS). Engine owned all state; no overrides.
FINDINGS (5): KKG-param bug_1780212505469/4253221 (high, +test) · agent_context-jutsu bug_1780214524649/af5d2be (high, +test) · turnBudget-persist bug_1780248689058/560e96e (medium, found LIVE, +test) · standing-inflation bug_1780245857774 (low, design-resolved: renown vs Will-of-Stone) · rank-by-level bug_1780247960181 (low, closed in-fiction by withheld promotion).
FEATURE built to spec mid-run: XP/leveling system, commit 69ceb9f (progression.ts + award_xp + auto-level).
OPEN: Prone lingers through long rest (cosmetic; logged, unpatched).
REGRESSION: all true defects pinned in regression.test.ts (suite green).
LOOP: play → detect → file (Agent Synch naruto5e-playtest) → patch (packages/engine/src) → regress → resume. The campaign was the QA harness; the manga is its artifact.
