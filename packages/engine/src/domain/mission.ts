import { z } from "zod";

/** Missions (Ch.7) — the proto-MMO grind/rank-up loop, ranked D->S by ninja rank. */
export const MissionSchema = z.object({
  id: z.string(),
  kind: z.literal("mission").default("mission"),
  roomId: z.string(),
  title: z.string(),
  rank: z.enum(["D", "C", "B", "A", "S"]),
  requiredRank: z.string().default("Genin"),
  rewardRyo: z.number().int().default(0),
  rewardMissionPoints: z.number().int().default(0),
  status: z.enum(["posted", "accepted", "active", "resolved", "failed"]).default("posted"),
  assignedTo: z.array(z.string()).default([]),
  locale: z.string().optional(),
  brief: z.string().optional(),
});
export type Mission = z.infer<typeof MissionSchema>;

/** Default reward bands by rank (rules-faithful defaults; exact tables flagged). */
export const MISSION_REWARDS: Record<string, { ryo: number; mp: number; requiredRank: string }> = {
  D: { ryo: 50, mp: 100, requiredRank: "Genin" },
  C: { ryo: 200, mp: 300, requiredRank: "Genin" },
  B: { ryo: 500, mp: 600, requiredRank: "Chunin" },
  A: { ryo: 1000, mp: 1000, requiredRank: "Jonin" },
  S: { ryo: 2500, mp: 1500, requiredRank: "Jonin" },
};

export const RANK_ORDER = ["Academy", "Genin", "Chunin", "Jonin", "Kage", "Legendary"];
