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
  [k: string]: unknown;
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
  }

  getJutsu(idOrName: string): JutsuRecord | undefined {
    return this.jutsuById.get(idOrName) ?? this.jutsuByName.get(idOrName.toLowerCase());
  }

  static load(dir: string): ContentPack {
    return new ContentPack(dir);
  }
}
