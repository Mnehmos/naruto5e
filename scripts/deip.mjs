#!/usr/bin/env node
/**
 * Re-runnable public-copy rebrand pass.
 *
 * Scope is intentionally limited to story/site/docs surfaces. Engine internals,
 * package identifiers, route names, content IDs, and chakra/jutsu mechanics stay
 * as-is unless they appear in public prose.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROOT_FILES = [
  "README.md",
  "PLAYTEST.md",
  "BUILD_LOG.md",
  "apps/web/index.html",
];

const DIRECTORIES = [
  { path: "docs", extensions: new Set([".html", ".md", ".css"]) },
  { path: "playtest-dustrelease", extensions: new Set([".md", ".json"]) },
  { path: "playtest-borrowed-current", extensions: new Set([".md"]) },
  { path: "scripts", extensions: new Set([".mjs"]), exclude: new Set(["deip.mjs"]) },
];

const REPLACEMENTS = [
  [/\bNaruto 5e\b/g, "Hidden Hand 5e"],
  [/\bNaruto&nbsp;5e\b/g, "Hidden Hand&nbsp;5e"],
  [/\bGreat Naruto Bridge\b/g, "Great Bridge"],
  [/Naruto © Masashi Kishimoto \/ Shueisha \/ Viz Media \/ Shonen Jump\. ?/g, ""],
  [/Naruto-specific content \(clans, jutsu catalog, chakra natures, KKG recipes\) is fan-authored and NOT covered by the SRD license\./g, "Original setting content (clans, jutsu catalog, chakra natures, bloodline recipes) is fan-authored and NOT covered by the SRD license."],
  [/The Naruto engine is the fun part\. ?/g, "The engine is the fun part. "],

  [/\bthe Third Tsuchikage\b/g, "Vohl, the Third Stoneward"],
  [/\bThe Third Tsuchikage\b/g, "Vohl, the Third Stoneward"],
  [/\bThird Tsuchikage\b/g, "the Third Stoneward"],
  [/\bTsuchikage\b/g, "Stoneward"],
  [/Ōnoki/g, "Vohl"],
  [/\bOnoki\b/g, "Vohl"],
  [/\bOhnoki\b/g, "Vohl"],

  [/\bIwagakure\b/g, "Hidden Tor"],
  [/\bthe Hidden Stone\b/g, "the Hidden Tor"],
  [/\bThe Hidden Stone\b/g, "The Hidden Tor"],
  [/\bHidden Stone\b/g, "Hidden Tor"],
  [/\bIwa\b/g, "Tor"],
  [/\bKumogakure\b/g, "the Cloud"],
  [/\bkumogakure\b/g, "cloud"],
  [/\bKumo\b/g, "Cloud"],
  [/\bKage's\b/g, "village leader's"],
  [/\bKage\b/g, "village leader"],

  [/\bDust Release\b/g, "Particle Release"],
  [/\bDust:\s*Lesser Detachment\b/g, "Particle: Lesser Detachment"],
  [/\bDust:\s*Honed Detachment\b/g, "Particle: Honed Detachment"],
  [/\bDust \(Jinton\)/g, "Particle Release (Particle art)"],
  [/\bJinton\b/g, "Particle art"],
  [/\bthe Dust\b/g, "the Particle art"],
  [/\bThe Dust\b/g, "The Particle art"],
  [/\blethal Dust\b/g, "lethal Particle art"],
  [/\btrue Dust awakening\b/g, "true Particle awakening"],
  [/\bTRUE DUST AWAKENING\b/g, "TRUE PARTICLE AWAKENING"],
  [/\bDust awakening\b/g, "Particle awakening"],
  [/\bDust attempt\b/g, "Particle attempt"],
  [/\bDust must be EARNED\b/g, "Particle art must be EARNED"],
  [/\bDust ladder\b/g, "Particle ladder"],
  [/\bDust =/g, "Particle art ="],
  [/\bDust woke\b/g, "Particle art woke"],
  [/\bDust reach\b/g, "Particle reach"],

  [/\bKekkei Genkai\b/g, "bloodline art"],
  [/\bKKG-param\b/g, "bloodline-param"],
  [/\bKKG recipes\b/g, "bloodline recipes"],
  [/\bKKG recipe\b/g, "bloodline recipe"],
  [/\bunknown-KKG\b/g, "unknown-bloodline"],
  [/\bunknown KKG\b/g, "unknown bloodline"],
  [/\bKKG\b/g, "bloodline"],

  [/\bWill of Stone\b/g, "Stone Oath"],
  [/\bWill-of-Stone\b/g, "Stone-Oath"],
  [/\bWill of Fire\b/g, "Stone Oath"],

  [/Lava \(Yōton\)/g, "Lava"],
  [/\bLava \(Yoton\)/g, "Lava"],
  [/\bScorch \(Shakuton\)/g, "Scorch"],
  [/\bMagnet \(Jiton\)/g, "Magnet"],
  [/Yōton/g, "Lava"],
  [/\bYoton\b/g, "Lava"],
  [/\bShakuton\b/g, "Scorch"],
  [/\bJiton\b/g, "Magnet"],
];

const CLEANUPS = [
  [/Particle arthe\b/g, "Particle art; he"],
  [/Particle artholding\b/g, "Particle art, holding"],
  [/Particle artstill\b/g, "Particle art still"],
  [/Particle art, not softening it/g, "the yard, not softening it"],
  [/\bParticle Release \(Particle art\) was/g, "Particle Release was"],
  [/\bParticle \(Particle art\)/g, "Particle"],
  [/\bParticle Release \(Particle art\)/g, "Particle Release"],
  [/\bParticle art, the particle bloodline\b/g, "the Particle art, the particle bloodline"],
  [/\bBehind Particle art\b/g, "Behind the Particle Art"],
  [/\. the Particle art/g, ". The Particle art"],
  [/"the Particle art/g, "\"The Particle art"],
  [/\bthe Particle art is/g, "the Particle art is"],
  [/\bthe Particle art will/g, "the Particle art will"],
  [/\bthe Particle art shown/g, "the Particle art shown"],
  [/\bthe Particle art had/g, "the Particle art had"],
  [/\bthe Particle art\./g, "the Particle art."],
];

function applyReplacements(content) {
  let result = content;
  for (const [pattern, replacement] of REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of CLEANUPS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function processFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const next = applyReplacements(content);
  if (content === next) return false;
  writeFileSync(filePath, next, "utf8");
  console.log(`updated ${filePath}`);
  return true;
}

function processDirectory(dir, extensions, exclude = new Set()) {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    if (exclude.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      count += processDirectory(fullPath, extensions, exclude);
    } else if (extensions.has(extname(entry))) {
      if (processFile(fullPath)) count++;
    }
  }
  return count;
}

let changed = 0;
for (const file of ROOT_FILES) {
  const path = join(ROOT, file);
  if (existsSync(path) && processFile(path)) changed++;
}
for (const dir of DIRECTORIES) {
  const path = join(ROOT, dir.path);
  if (existsSync(path)) {
    changed += processDirectory(path, dir.extensions, dir.exclude ?? new Set());
  }
}

console.log(`de-IP pass complete: ${changed} file(s) changed`);
