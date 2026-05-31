import { z } from "zod";

/**
 * A Campaign is the layer ABOVE rooms: it groups scenes (rooms) into one arc,
 * holds the world clock (day), the party roster, a journal of beats, named
 * locations, and the factions it cares about. It owns no dice and no per-scene
 * state — it references rooms/characters/missions/ledgers by id and composes a
 * dashboard from them. Stored in the top-level `campaigns` collection (not
 * room-scoped), so one campaign spans many rooms.
 */
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
});
export type Campaign = z.infer<typeof CampaignSchema>;
