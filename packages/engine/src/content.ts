import fs from "node:fs";
import path from "node:path";

/**
 * Content pack loader (Architecture: engine/content separation — "The engine
 * treats content as data behind a loader interface"). The Naruto 5e data
 * (jutsu catalog, clans, classes, backgrounds, equipment, adversaries, feats,
 * bingo book) loads from a local content directory. Missing files are
 * tolerated so the pack fills in as phases land their data.
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
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

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

  private jutsuById = new Map<string, JutsuRecord>();
  private jutsuByName = new Map<string, JutsuRecord>();
  private clanByName = new Map<string, any>();
  private classByName = new Map<string, any>();
  private backgroundByName = new Map<string, any>();
  private itemByKey = new Map<string, any>();

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

  static load(dir: string): ContentPack {
    return new ContentPack(dir);
  }
}
