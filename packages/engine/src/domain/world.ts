import { z } from "zod";

/**
 * The world-consequence systems (integrated: memory · economy · theft · corpse).
 * Not standalone features — each is a surface of the currency spine, routing
 * deltas into per-authority Standing. They share knownFacts/identity.
 */

// A) NPC memory — the in-fiction surface of Standing.
export const NpcRelationshipSchema = z.object({
  id: z.string(), // `${npcId}:${actorId}`
  kind: z.literal("npc_relationship").default("npc_relationship"),
  npcId: z.string(),
  actorId: z.string(),
  authorityId: z.string().optional(),
  familiarity: z.number().default(0), // 0..100
  disposition: z.number().default(0), // -100..100
  memories: z
    .array(
      z.object({
        eventId: z.string(),
        summary: z.string(),
        importance: z.enum(["low", "notable", "defining"]).default("low"),
        standingDelta: z.object({ authorityId: z.string(), reputation: z.number().optional(), favor: z.number().optional() }).optional(),
        sentiment: z.number().default(0),
        timestamp: z.string().optional(),
        witnessed: z.boolean().default(true),
      }),
    )
    .default([]),
  knownFacts: z.array(z.string()).default([]),
});
export type NpcRelationship = z.infer<typeof NpcRelationshipSchema>;

export const NpcSchema = z.object({
  id: z.string(),
  kind: z.literal("npc").default("npc"),
  roomId: z.string(),
  name: z.string(),
  authorityId: z.string().optional(),
  knownFacts: z.array(z.string()).default([]),
});
export type Npc = z.infer<typeof NpcSchema>;

// B) Economy — Ryo gated by Standing.
export const VendorSchema = z.object({
  id: z.string(),
  kind: z.literal("vendor").default("vendor"),
  roomId: z.string(),
  name: z.string(),
  authorityId: z.string().optional(),
  openStock: z.array(z.object({ itemId: z.string(), ryoPrice: z.number().optional() })).default([]),
  gatedStock: z.array(z.object({ itemId: z.string(), ryoPrice: z.number().optional(), requires: z.object({ authorityId: z.string(), minReputation: z.number() }) })).default([]),
  buyRate: z.number().default(1),
  sellRate: z.number().default(0.5),
  heatCapacity: z.number().default(0),
});
export type Vendor = z.infer<typeof VendorSchema>;

// C) Theft — where Ryo, Standing, and the rogue path collide.
export const StolenItemSchema = z.object({
  id: z.string(),
  kind: z.literal("stolen_item").default("stolen_item"),
  itemId: z.string(),
  originalOwnerId: z.string().optional(),
  stolenBy: z.string(),
  jurisdictionAuthorityId: z.string(),
  heat: z.enum(["burning", "hot", "warm", "cold"]).default("hot"),
  witnesses: z.array(z.object({ npcId: z.string(), recognizes: z.boolean() })).default([]),
  recognizable: z.boolean().default(true),
});
export type StolenItem = z.infer<typeof StolenItemSchema>;

export const HeatStateSchema = z.object({
  id: z.string(), // `${actorId}:${authorityId}`
  kind: z.literal("heat").default("heat"),
  actorId: z.string(),
  authorityId: z.string(),
  level: z.number().default(0), // accumulating heat; thresholds trigger reports / rogue path
  incidents: z.number().default(0),
  rogueTriggered: z.boolean().default(false),
});
export type HeatState = z.infer<typeof HeatStateSchema>;

// D) Corpse — death, secrets, and Standing.
export const CorpseSchema = z.object({
  id: z.string(),
  kind: z.literal("corpse").default("corpse"),
  roomId: z.string(),
  deceasedId: z.string().optional(),
  name: z.string().optional(),
  deceasedAuthorityId: z.string().optional(),
  clan: z.string().optional(),
  decayStage: z.enum(["fresh", "cooling", "decayed", "skeletal"]).default("fresh"),
  carries: z
    .array(
      z.object({
        type: z.enum(["ryo", "gear", "scroll", "intel", "kkg", "clan_secret"]),
        itemId: z.string().optional(),
        amount: z.number().optional(),
        tabooSeverity: z.number().optional(), // 0..1
        taken: z.boolean().default(false),
      }),
    )
    .default([]),
  identity: z.object({ knownToAuthorities: z.boolean().default(false) }).default({ knownToAuthorities: false }),
  recovered: z.boolean().default(false),
});
export type Corpse = z.infer<typeof CorpseSchema>;

export const DECAY_ORDER = ["fresh", "cooling", "decayed", "skeletal"] as const;
