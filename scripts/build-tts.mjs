#!/usr/bin/env node
/**
 * build-tts.mjs — generate OpenAI TTS narration for chapters (and, later, chronicle entries).
 *
 *   node scripts/build-tts.mjs <slug> [<slug> ...]   # generate specific chapters
 *   node scripts/build-tts.mjs --all                 # generate every chapter (the backlog pass)
 *
 * For each target it takes the chapter's clean STORY prose (narrationText from build-story.mjs —
 * title + body, no OOC brackets, no ---LOG--- ledger), chunks it under the API's 4096-char limit,
 * calls POST /v1/audio/speech per chunk, concatenates the mp3, and writes docs/audio/<slug>.mp3.
 * Idempotent: a content+voice hash in docs/audio/.hashes.json means unchanged chapters are skipped.
 * Output is committed static audio; the page player is native <audio> (no JS, no key client-side).
 * Reads OPENAI_API_KEY (+ optional NARUTO_TTS_MODEL / NARUTO_TTS_VOICE) from .env or the env.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { MANIFEST, SRC, narrationText } from "./build-story.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUDIO = join(ROOT, "docs", "audio");
const HASHES = join(AUDIO, ".hashes.json");

function loadEnv() {
  const env = { ...process.env };
  const p = join(ROOT, ".env");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}
const ENV = loadEnv();
const KEY = ENV.OPENAI_API_KEY;
const MODEL = ENV.NARUTO_TTS_MODEL || "gpt-4o-mini-tts";
const VOICE = ENV.NARUTO_TTS_VOICE || "onyx";
const INSTRUCTIONS =
  "Narrate like the reader of a literary shinobi audiobook: measured, weighty, unhurried. Stone, dust, and quiet gravity; let the sentences breathe. Warm but restrained — never melodramatic.";

if (!KEY) { console.error("✗ OPENAI_API_KEY not found (.env or env). Aborting."); process.exit(1); }

function chunkText(text, max = 3800) {
  const paras = text.split(/\n\n+/);
  const chunks = [];
  let cur = "";
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > max) {
      push();
      if (p.length > max) {
        const sents = p.match(/[^.!?]+[.!?]+["']?|\S[^.!?]*$/g) || [p];
        let s = "";
        for (const se of sents) { if ((s + se).length > max) { if (s) chunks.push(s.trim()); s = se; } else s += se; }
        if (s.trim()) cur = s; else cur = "";
      } else cur = p;
    } else cur = cur ? cur + "\n\n" + p : p;
  }
  push();
  return chunks;
}

async function tts(input) {
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, voice: VOICE, input, response_format: "mp3", instructions: INSTRUCTIONS }),
  });
  if (!resp.ok) throw new Error(`OpenAI TTS ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function generate(entry) {
  const p = join(SRC, entry.path);
  if (!existsSync(p)) { console.warn(`! ${entry.slug}: source missing — skipped`); return false; }
  const text = narrationText(readFileSync(p, "utf8"));
  if (!text.trim()) { console.warn(`! ${entry.slug}: no narratable prose — skipped`); return false; }
  const hash = createHash("sha256").update(`${MODEL}|${VOICE}|${text}`).digest("hex").slice(0, 16);
  const hashes = existsSync(HASHES) ? JSON.parse(readFileSync(HASHES, "utf8")) : {};
  const out = join(AUDIO, `${entry.slug}.mp3`);
  if (hashes[entry.slug] === hash && existsSync(out)) { console.log(`= ${entry.slug}: up to date`); return false; }

  const chunks = chunkText(text);
  process.stdout.write(`▸ ${entry.slug}: ${text.length} chars in ${chunks.length} chunk(s)… `);
  const buffers = [];
  for (let i = 0; i < chunks.length; i++) { buffers.push(await tts(chunks[i])); process.stdout.write(`${i + 1} `); }
  if (!existsSync(AUDIO)) mkdirSync(AUDIO, { recursive: true });
  writeFileSync(out, Buffer.concat(buffers));
  hashes[entry.slug] = hash;
  writeFileSync(HASHES, JSON.stringify(hashes, null, 2));
  const kb = Math.round(Buffer.concat(buffers).length / 1024);
  console.log(`→ docs/audio/${entry.slug}.mp3 (${kb} KB)`);
  return true;
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log("usage: node scripts/build-tts.mjs <slug> [<slug> ...] | --all");
  console.log("slugs:", MANIFEST.map((e) => e.slug).join(", "));
  process.exit(0);
}
const targets = args.includes("--all") ? MANIFEST : MANIFEST.filter((e) => args.includes(e.slug));
if (!targets.length) { console.error("no matching slugs in the manifest."); process.exit(1); }

let made = 0;
for (const entry of targets) { try { if (await generate(entry)) made++; } catch (e) { console.error(`✗ ${entry.slug}: ${e.message}`); } }
console.log(`\n✓ TTS done — ${made} file(s) generated/updated, ${targets.length - made} unchanged/skipped (model ${MODEL}, voice ${VOICE}).`);
