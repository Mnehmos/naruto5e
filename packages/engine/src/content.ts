import fs from "node:fs";
import path from "node:path";
import {
  ClassificationDefSchema,
  ResourceDefSchema,
  type ClassificationDef,
  type ResourceDef,
} from "./domain/resource.js";

/**
 * Content pack loader (Architecture: engine/content separation — "The engine
 * treats content as data behind a loader interface"). The Naruto 5e data
 * (jutsu catalog, clans, classes, backgrounds, equipment, adversaries, feats,
 * bingo book) loads from a local content directory. Missing files are
 * tolerated so the pack fills in as phases land their data.
 *
 * Phase A (platform generalization) adds two new registries:
 *  - resources  (ResourceDef[]) — named pools (chakra is just one).
 *  - technique_classifications (ClassificationDef[]) — Naruto's nin/gen/tai/buki.
 * Both are OPTIONAL files; if absent, the loader synthesizes the Naruto defaults
 * so existing tests / playtests see zero behavior change.
 */

export interface JutsuRecord {
  id: string;
  name: string | null;
  classification: string;
  rank: "E" | "D" | "C" | "B" | "A" | "S";
  castingTime: string | null;
  range: string | null;
  duration: string | null;
  components: string[];
  componentsRaw?: string | null;
  cost: number | null;
  keywords: string[];
  description: string | null;
  atHigherRanks: string | null;
  source?: { document: string; page: number };
  effect?: JutsuEffect;
  [k: string]: unknown;
}

/** Structured combat effect derived from the description (the resolvable 90%). */
export interface JutsuEffect {
  delivery: "attack" | "save" | "auto" | "utility";
  saveAbility?: "str" | "dex" | "con" | "int" | "wis" | "cha";
  damage?: { dice: string; type: string };
  healing?: { dice: string };
  halfOnSave?: boolean;
  conditions?: { name: string; save?: string }[];
  area?: { size: number; shape?: string };
  concentration?: boolean;
  /** number of separate attack rolls (multi-projectile jutsu, e.g. Phoenix Fire). */
  hits?: number;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** The chakra ResourceDef the engine synthesizes when no `resources.json` is present.
 *  Binds to the legacy `chakra` / `chakraDice` fields so existing characters keep working. */
const DEFAULT_CHAKRA: ResourceDef = ResourceDefSchema.parse({
  id: "chakra",
  label: "Chakra",
  poolField: "chakra",
  dicePoolField: "chakraDice",
  firstLevelFormula: "die+con",
  subsequentFormula: "avg+con",
  defaultDie: 6,
  adversaryScaling: { mode: "tier" },
  nonRefundable: false,
});

/** Naruto's classification defaults when no `technique_classifications.json` is present.
 *  Keeps actorCasting() bit-identical when the file is absent (Phase A risk mitigation). */
const DEFAULT_CLASSIFICATIONS: ClassificationDef[] = [
  ClassificationDefSchema.parse({ id: "ninjutsu", label: "Ninjutsu", castingAbility: "int", elementBound: true }),
  ClassificationDefSchema.parse({ id: "genjutsu", label: "Genjutsu", castingAbility: "wis" }),
  ClassificationDefSchema.parse({ id: "taijutsu", label: "Taijutsu", castingAbility: "str/dex" }),
  ClassificationDefSchema.parse({ id: "bukijutsu", label: "Bukijutsu", castingAbility: "str/dex" }),
];

export class ContentPack {
  readonly dir: string;
  jutsu: JutsuRecord[] = [];
  clans: any[] = [];
  classes: any[] = [];
  backgrounds: any[] = [];
  equipment: any[] = [];
  adversaries: any[] = [];
  feats: any[] = [];
  bingoBook: any[] = [];
  resources: ResourceDef[] = [];
  classifications: ClassificationDef[] = [];

  private jutsuById = new Map<string, JutsuRecord>();
  private jutsuByName = new Map<string, JutsuRecord>();
  private clanByName = new Map<string, any>();
  private classByName = new Map<string, any>();
  private backgroundByName = new Map<string, any>();
  private itemByKey = new Map<string, any>();
  private resourceById = new Map<string, ResourceDef>();
  private classificationById = new Map<string, ClassificationDef>();

  constructor(dir: string) {
    this.dir = dir;
    this.reload();
  }

  reload(): void {
    const d = this.dir;
    this.jutsu = readJson<JutsuRecord[]>(path.join(d, "jutsu_catalog.json"), []);
    this.clans = readJson<any[]>(path.join(d, "clans.json"), []);
    this.classes = readJson<any[]>(path.join(d, "classes.json"), []);
    this.backgrounds = readJson<any[]>(path.join(d, "backgrounds.json"), []);
    this.equipment = readJson<any[]>(path.join(d, "equipment.json"), []);
    this.adversaries = readJson<any[]>(path.join(d, "adversaries.json"), []);
    this.feats = readJson<any[]>(path.join(d, "feats.json"), []);
    this.bingoBook = readJson<any[]>(path.join(d, "bingo_book.json"), []);

    // Phase A: optional resource + classification registries (Naruto-as-DLC).
    const rawResources = readJson<any[]>(path.join(d, "resources.json"), []);
    const rawClassifications = readJson<any[]>(path.join(d, "technique_classifications.json"), []);
    this.resources = rawResources.length
      ? rawResources.map((r) => ResourceDefSchema.parse(r))
      : [DEFAULT_CHAKRA];
    // Synthesize chakra if a custom resources.json forgot it (Naruto regression invariant).
    if (!this.resources.find((r) => r.id === "chakra")) this.resources.push(DEFAULT_CHAKRA);
    this.classifications = rawClassifications.length
      ? rawClassifications.map((c) => ClassificationDefSchema.parse(c))
      : [...DEFAULT_CLASSIFICATIONS];

    this.jutsuById.clear();
    this.jutsuByName.clear();
    for (const j of this.jutsu) {
      this.jutsuById.set(j.id, j);
      if (j.name) this.jutsuByName.set(j.name.toLowerCase(), j);
    }
    this.clanByName.clear();
    for (const c of this.clans) this.clanByName.set(String(c.name).toLowerCase(), c);
    this.classByName.clear();
    for (const c of this.classes) this.classByName.set(String(c.name).toLowerCase(), c);
    this.backgroundByName.clear();
    for (const b of this.backgrounds) this.backgroundByName.set(String(b.name).toLowerCase(), b);
    this.itemByKey.clear();
    for (const it of this.equipment) {
      if (it.id) this.itemByKey.set(String(it.id).toLowerCase(), it);
      if (it.name) this.itemByKey.set(String(it.name).toLowerCase(), it);
    }
    this.resourceById.clear();
    for (const r of this.resources) this.resourceById.set(r.id, r);
    this.classificationById.clear();
    for (const c of this.classifications) this.classificationById.set(c.id, c);
  }

  getItem(idOrName: string): any | undefined {
    return this.itemByKey.get(idOrName.toLowerCase());
  }

  getBingo(name: string): any | undefined {
    return this.bingoBook.find((b) => String(b.name).toLowerCase() === name.toLowerCase());
  }

  getFeat(idOrName: string): any | undefined {
    const k = idOrName.toLowerCase();
    return this.feats.find((f) => String(f.id).toLowerCase() === k || String(f.name).toLowerCase() === k);
  }

  getJutsu(idOrName: string): JutsuRecord | undefined {
    return this.jutsuById.get(idOrName) ?? this.jutsuByName.get(idOrName.toLowerCase());
  }

  /** Register/replace a jutsu at runtime (jutsu_manage.define / jutsu_build.commit). */
  addJutsu(rec: JutsuRecord): void {
    const existing = this.jutsuById.get(rec.id);
    if (existing) {
      Object.assign(existing, rec);
    } else {
      this.jutsu.push(rec);
    }
    this.jutsuById.set(rec.id, rec);
    if (rec.name) this.jutsuByName.set(rec.name.toLowerCase(), rec);
  }

  getClan(name: string): any | undefined {
    return this.clanByName.get(name.toLowerCase());
  }
  getClass(name: string): any | undefined {
    return this.classByName.get(name.toLowerCase());
  }
  getBackground(name: string): any | undefined {
    return this.backgroundByName.get(name.toLowerCase());
  }
  clanNames(): string[] {
    return this.clans.map((c) => c.name);
  }
  classNames(): string[] {
    return this.classes.map((c) => c.name);
  }
  backgroundNames(): string[] {
    return this.backgrounds.map((b) => b.name);
  }

  // ---- Phase A: resource + classification registries --------------------

  getResource(id: string): ResourceDef | undefined {
    return this.resourceById.get(id);
  }
  listResources(): ResourceDef[] {
    return [...this.resources];
  }
  /** Register or replace a ResourceDef at runtime (DLC layering). */
  addResource(rec: ResourceDef): void {
    const parsed = ResourceDefSchema.parse(rec);
    const existing = this.resourceById.get(parsed.id);
    if (existing) {
      Object.assign(existing, parsed);
    } else {
      this.resources.push(parsed);
    }
    this.resourceById.set(parsed.id, parsed);
  }

  getClassification(id: string): ClassificationDef | undefined {
    return this.classificationById.get(id.toLowerCase()) ?? this.classificationById.get(id);
  }
  listClassifications(): ClassificationDef[] {
    return [...this.classifications];
  }
  addClassification(rec: ClassificationDef): void {
    const parsed = ClassificationDefSchema.parse(rec);
    const existing = this.classificationById.get(parsed.id);
    if (existing) {
      Object.assign(existing, parsed);
    } else {
      this.classifications.push(parsed);
    }
    this.classificationById.set(parsed.id, parsed);
  }

  static load(dir: string): ContentPack {
    return new ContentPack(dir);
  }
}
