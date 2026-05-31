import { z } from "zod";

/**
 * A Campaign is the layer ABOVE rooms: it groups scenes (rooms) into one arc,
 * holds the world clock (day), the party roster, a journal of beats, named
 * locations, and the factions it cares about. It owns no dice and no per-scene
 * state — it references rooms/characters/missions/ledgers by id and composes a
 * dashboard from them. Stored in the top-level `campaigns` collection (not
 * room-scoped), so one campaign spans many rooms.
 */
/**
 * A sub-day TIME BLOCK — the unit of "lived time" the strict-temporal guard protects.
 * A day is broken into scheduled blocks (dawn drills, the academy periods, sensei training,
 * evening, …). A block flagged requiredAttention must be RESOLVED (narrated/played/logged)
 * before the day can advance in strict mode — the concrete anti-time-compression mechanism.
 */
export const TimeBlockSchema = z.object({
  id: z.string(),
  day: z.number().int(),
  label: z.string(), // e.g. "08:00 Chakra Control", "afternoon — caravan road"
  location: z.string().optional(),
  startsAt: z.string().optional(), // free-form clock label ("08:00")
  endsAt: z.string().optional(),
  requiredAttention: z.boolean().default(true), // must be resolved before time advances (strict mode)
  resolved: z.boolean().default(false),
  actorsInScope: z.array(z.string()).default([]),
  resolvedIntents: z.number().int().default(0), // how many engine ops were resolved in this block
  digest: z.string().optional(), // what happened (a one-line played/logged summary)
});
export type TimeBlock = z.infer<typeof TimeBlockSchema>;

export const CampaignSchema = z.object({
  id: z.string(),
  kind: z.literal("campaign").default("campaign"),
  name: z.string(),
  arc: z.string().default("Prologue"), // current chapter/arc title
  day: z.number().int().default(1), // world clock; advanced by rest/tick or explicitly
  party: z.array(z.string()).default([]), // character ids
  scenes: z.array(z.string()).default([]), // room ids belonging to this campaign
  activeRoomId: z.string().optional(),
  locations: z.array(z.object({ name: z.string(), note: z.string().optional() })).default([]),
  journal: z.array(z.object({ day: z.number(), arc: z.string(), beat: z.string() })).default([]),
  factionsOfNote: z.array(z.string()).default([]), // authorityIds the campaign tracks

  // ---- strict temporal mode (anti-time-compression) ----
  // When strictTemporal is on, the DM cannot skip time past unresolved required blocks or
  // jump more than maxUnauthorizedDays without compressionAuthorized:true — lived time stays
  // lived. Off by default (back-compatible); a life-sim campaign turns it on.
  strictTemporal: z.boolean().default(false),
  maxUnauthorizedDays: z.number().int().default(1), // largest day-jump allowed without explicit authorization
  blocks: z.array(TimeBlockSchema).default([]), // the current day's scheduled attention blocks
});
export type Campaign = z.infer<typeof CampaignSchema>;
