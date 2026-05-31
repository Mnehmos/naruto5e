/**
 * Resource affordance hints — context FRONTLOADING for the LLM tier. The engine owns the
 * rules; this surfaces, in plain language, "you have THIS resource and can spend it THIS way
 * via THIS intent." Exposed two ways: the `hints` intent (a full queryable guide) and a
 * compact slice embedded in agent_context affordances (so the model sees the spend-paths
 * exactly when it's deciding a move). Keep each line short and verb-first.
 */
export interface ResourceHint {
  resource: string;
  what: string;
  gain: string;
  spend: string;
  via: string[]; // intent/tool names that spend or grow it
  scene?: "combat" | "scene" | "any"; // where it's most relevant (for filtering the compact slice)
}

export const RESOURCE_HINTS: ResourceHint[] = [
  { resource: "Chakra", what: "jutsu fuel pool (paired with Chakra Dice)", gain: "rest (short: spend dice; long: full)", spend: "cast jutsu — cost scales with rank + upcast", via: ["cast_jutsu", "rest"], scene: "any" },
  { resource: "Hit Points", what: "your life (paired with Hit Dice)", gain: "rest, healing, Medical jutsu", spend: "taking damage", via: ["rest", "cast_jutsu"], scene: "any" },
  { resource: "Action economy", what: "per-turn action / bonus / reaction / movement (combat only)", gain: "refreshes at the start of your turn; Dash adds movement", spend: "attack / cast / move; STAND from Prone costs half your speed; transient conditions also end at combat-end or by duration", via: ["attack", "cast_jutsu", "move", "dash", "dodge", "stand"], scene: "combat" },
  { resource: "Technique slots", what: "how many jutsu you can know (jutsuKnownCap)", gain: "level up, OR buy more with fame through a social leader", spend: "learning a jutsu fills a slot (free one with jutsu_forget)", via: ["jutsu_acquire(buy_slot)", "learn_jutsu", "jutsu_forget"], scene: "scene" },
  { resource: "Fame (Reputation)", what: "passive renown with an authority — deeds & bloodline draw it", gain: "missions, deeds, the world tick", spend: "BUY technique slots (political capital) or unlock gated vendor stock", via: ["jutsu_acquire(buy_slot)", "economy_buy", "check_access"], scene: "scene" },
  { resource: "Favor (earned honor)", what: "DM-granted standing for defining moments (capped)", gain: "granted for creed-defining acts (grant_favor)", spend: "unlock an off-affinity jutsu, or call in access", via: ["favor_unlock", "spend_favor"], scene: "scene" },
  { resource: "New jutsu", what: "growing your arsenal beyond self-study — each channel is distinct", gain: "—", spend: "TAUGHT by a teacher/Kage/school (relationship), drawn from a standing-gated VAULT, a SCROLL bought with Ryo, or OFF-AFFINITY unlocked with favor", via: ["jutsu_acquire(teach)", "jutsu_acquire(buy_scroll→study_scroll)", "favor_unlock", "learn_jutsu"], scene: "scene" },
  { resource: "Ryo", what: "money", gain: "missions, looting, fencing", spend: "buy gear (economy_buy/buy_item) and JUTSU SCROLLS at a market (jutsu_acquire buy_scroll)", via: ["economy_buy", "buy_item", "jutsu_acquire(buy_scroll)"], scene: "scene" },
  { resource: "Downtime", what: "between-mission time spent deliberately (a downtime rest / mission gaps)", gain: "the calendar — taken when missions pause or via a downtime rest", spend: "TRAIN a feat/tool/language, RECUPERATE a condition, RESEARCH a lead, or SHOP for discounts", via: ["rest(downtime)", "downtime_train", "downtime_recuperate", "downtime_research", "downtime_shop"], scene: "scene" },
  { resource: "Mission Points", what: "career progress with the village", gain: "completing missions", spend: "rank-up and rewards", via: ["mission_resolve", "rank_up"], scene: "scene" },
  { resource: "XP", what: "advancement toward the next level", gain: "award_xp for engine-grounded beats", spend: "auto-levels at thresholds (the TITLE is earned at the exam — leveling raises your jutsu tier, not your rank)", via: ["award_xp"], scene: "any" },
  { resource: "Will of Fire", what: "a once-per-rest heroic resolve", gain: "refreshed on a mission-boundary long rest", spend: "a DM-adjudicated clutch moment", via: ["will_of_fire", "rest(missionBoundary)"], scene: "any" },
  { resource: "Time", what: "the lived calendar (strict mode protects it)", gain: "—", spend: "plan the day into blocks and resolve each before the clock moves; deliberate skips need compressionAuthorized", via: ["campaign_manage(plan_day|resolve_block|advance_day)"], scene: "scene" },
];

/** One-line "spend X via Y" tips for the full guide. */
export function tipLines(): string[] {
  return RESOURCE_HINTS.map((h) => `${h.resource}: ${h.spend} — via ${h.via.join(" / ")}.`);
}

/** A compact, mode-filtered slice for agent_context affordances (verb-first spend paths). */
export function spendHints(mode: "combat" | "scene"): string[] {
  return RESOURCE_HINTS.filter((h) => h.scene === "any" || h.scene === mode).map((h) => `${h.resource} → ${h.spend} (${h.via[0]})`);
}
