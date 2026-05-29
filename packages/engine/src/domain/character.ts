import { z } from "zod";

/**
 * The character record (Ch.1) — the dual-pool shinobi sheet. Two resource pools
 * (HP/Hit Dice + Chakra/Chakra Dice) are first-class; casting modifiers are
 * keyed to jutsu TYPE (Nin=INT, Gen=WIS, Tai=STR/DEX), so three casting mods
 * coexist on one sheet.
 */
const AbilityScoresSchema = z.object({
  str: z.number().int(),
  dex: z.number().int(),
  con: z.number().int(),
  int: z.number().int(),
  wis: z.number().int(),
  cha: z.number().int(),
});

const PoolSchema = z.object({ current: z.number().int(), max: z.number().int(), temp: z.number().int().default(0) });
const DicePoolSchema = z.object({ type: z.number().int(), total: z.number().int(), remaining: z.number().int() });

const CastingTrackSchema = z.object({ ability: z.string(), mod: z.number().int(), attack: z.number().int(), saveDC: z.number().int() });

export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string().optional(),
  roomId: z.string(),
  kind: z.literal("character").default("character"),
  isPC: z.boolean().default(true),

  clan: z.string().optional(),
  className: z.string().optional(),
  subclass: z.string().optional(),
  background: z.string().optional(),

  level: z.number().int().min(1).default(1),
  rank: z.string().default("Genin"),
  missionPoints: z.number().int().default(0),

  /** classes[] supports multiclassing (Phase 5); single-class fills [{class,level}]. */
  classes: z.array(z.object({ className: z.string(), level: z.number().int() })).default([]),

  abilities: AbilityScoresSchema, // base, before clan/background increases
  abilityBonuses: z.record(z.number()).default({}), // tracked separately for audit
  abilityTotals: AbilityScoresSchema.optional(), // derived

  hp: PoolSchema,
  chakra: PoolSchema.omit({ temp: true }).extend({ temp: z.number().int().default(0) }),
  hitDice: DicePoolSchema,
  chakraDice: DicePoolSchema,

  proficiencyBonus: z.number().int().default(3),
  ac: z.number().int().default(10),
  speed: z.number().int().default(30),

  casting: z
    .object({ ninjutsu: CastingTrackSchema, genjutsu: CastingTrackSchema, taijutsu: CastingTrackSchema })
    .optional(),

  proficiencies: z
    .object({
      armor: z.array(z.string()).default([]),
      weapons: z.array(z.string()).default([]),
      tools: z.array(z.string()).default([]),
      skills: z.array(z.string()).default([]),
      savingThrows: z.array(z.string()).default([]), // ability keys
    })
    .default({ armor: [], weapons: [], tools: [], skills: [], savingThrows: [] }),

  clanTraits: z.array(z.string()).default([]),
  classFeatures: z.array(z.object({ name: z.string(), level: z.number().int(), description: z.string().optional() })).default([]),
  feats: z.array(z.string()).default([]),

  conditions: z.array(z.string()).default([]),
  exhaustion: z.number().int().default(0),

  jutsuKnown: z.array(z.string()).default([]),
  jutsuKnownCap: z.number().int().default(0),

  equipment: z.array(z.any()).default([]),
  ryo: z.number().int().default(0),

  willOfFire: z.boolean().default(true),

  /** Unique clan resources (Akimichi Calories, dojutsu activation, ...). */
  resources: z.record(z.any()).default({}),
  affinity: z.array(z.string()).default([]),

  // combat fields (Phase 2)
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  team: z.string().optional(),
  initiative: z.number().optional(),
  turnBudget: z
    .object({
      action: z.number(),
      bonus: z.number(),
      reaction: z.number(),
      movement: z.number(),
      freeInteraction: z.number(),
    })
    .optional(),
  /** up to TWO concentration jutsu at once (divergence from 5e). */
  concentration: z.array(z.object({ jutsuId: z.string(), name: z.string(), targets: z.array(z.string()).default([]) })).default([]),
  deathSaves: z.object({ successes: z.number(), failures: z.number(), stable: z.boolean() }).default({ successes: 0, failures: 0, stable: false }),
  dead: z.boolean().default(false),
  readied: z.object({ trigger: z.string(), op: z.any() }).optional(),
  dodging: z.boolean().default(false),

  built: z.boolean().default(false),
});

export type Character = z.infer<typeof CharacterSchema>;
