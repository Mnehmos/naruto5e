import { z } from "zod";

/**
 * A "room" is a locus of attention — one writer / one adjudicator per room
 * (the consistency boundary, Architecture §7). It owns the seeded RNG so all
 * dice in the room are deterministic and reproducible.
 */
export const RoomSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  createdAt: z.string(),
  /** 32-bit seed the room's RNG was created from. */
  seed: z.number().int(),
  /** Current RNG state snapshot (persisted so the stream survives restart). */
  rngState: z.number().int(),
  /** "scene" out of combat; "combat" while an encounter is active (§ app shell). */
  mode: z.enum(["scene", "combat"]).default("scene"),
  /** Active encounter id when in combat. */
  encounterId: z.string().optional(),
  /** Current mission id, if a mission is active in this room. */
  missionId: z.string().optional(),
});

export type Room = z.infer<typeof RoomSchema>;
