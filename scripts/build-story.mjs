#!/usr/bin/env node
/**
 * build-story.mjs — render the canonical playtest chapters into the static reading site.
 *
 * Reads playtest-dustrelease/chapters/*.md (+ the debrief), parses the
 * TITLE/DATES/body/---LOG--- shape, converts the markdown body to HTML, and applies a
 * bespoke chapter template (docs/assets/story.css): hero + prev/next/index/journey nav +
 * the story body + a collapsible Engine Log (the ---LOG--- footer, preserved but secondary)
 * + per-chapter callouts. Also emits docs/story.html (the Volume One index) from a curated
 * manifest. Output is committed static HTML — GitHub Pages serves docs/ with NO build step.
 *
 * Re-run after adding/editing a chapter:  node scripts/build-story.mjs
 * The MANIFEST below is the curation layer (arc grouping, order, teasers, tags, callouts);
 * the story text itself is never rewritten — only TITLE/DATES/body/log are read from the .md.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SRC = join(ROOT, "playtest-dustrelease");
const DOCS = join(ROOT, "docs");
const OUTCH = join(DOCS, "chapters");

/* ---- curation manifest: ordered, arc-grouped. teaser/tags/callout are bespoke; any
   chapter without a teaser falls back to its opening sentence. ------------------------- */
const ARCS = {
  academy: { ord: "I", title: "Academy Arc", sub: "Year One — the leaf, the trust wound, and the awakening that wasn't" },
  genin: { ord: "II", title: "Genin & Mission Arc", sub: "The headband earned, the work of D-ranks, and the true Dust awakening" },
  chunin: { ord: "III", title: "Chūnin Exam Arc", sub: "Paper, wasteland, and the loss that proved the engine would not lie" },
  afterword: { ord: "✦", title: "Afterword — The Audit Trail", sub: "How the deterministic engine constrained the AI Dungeon Master" },
  actii: { ord: "ACT II", title: "Act II — The Associate", sub: "A Genin field-assistant, the world opening up, and a region quietly beginning to tighten" },
};

const PROOF_TAGS = new Set(["Engine Proof", "Dice-over-plan"]);

export const MANIFEST = [
  { path: "chapters/day01.md", slug: "day01", arc: "academy", tags: ["Academy", "Dust Release"],
    teaser: "A leaf falls open in four clean pieces where the lesson asked for one — and the Hidden Stone sees the Third Tsuchikage's dead bloodline alive again in a child." },
  { path: "chapters/day02.md", slug: "day02", arc: "academy", tags: ["Academy", "Engine Proof"] },
  { path: "chapters/day03.md", slug: "day03", arc: "academy", tags: ["Academy", "Dust Release"] },
  { path: "chapters/day04.md", slug: "day04", arc: "academy", tags: ["Academy", "Training"] },
  { path: "chapters/day05.md", slug: "day05", arc: "academy", tags: ["Academy"] },
  { path: "chapters/day06.md", slug: "day06", arc: "academy", tags: ["Academy", "Training"],
    teaser: "Three steps blind: the prodigy who fears his own hands is made to trust the people beside him — the wound that becomes his whole arc." },
  { path: "chapters/day07.md", slug: "day07", arc: "academy", tags: ["Academy", "Will of Stone"] },
  { path: "chapters/day08.md", slug: "day08", arc: "academy", tags: ["Academy", "Engine Proof"] },
  { path: "chapters/day09.md", slug: "day09", arc: "academy", tags: ["Academy", "Training"] },
  { path: "chapters/day10-20_midterm.md", slug: "day10-20-midterm", arc: "academy", tags: ["Academy", "Dice-over-plan"],
    teaser: "The mid-term: Iwao's plan fails under pressure — and the cell he didn't trust carries him through the gap. He passes by the creed, not by control.",
    callout: { kind: "proof", label: "Theme discovered through play", text: "Iwao's plan failed its check, but the team succeeded because the other characters covered the gaps. The engine refused to let him win by being smart; it let him win by not being alone." } },
  { path: "chapters/day23_awakening.md", slug: "day23-awakening", arc: "academy", tags: ["Dust Release", "Dice-over-plan"],
    teaser: "The first sanctioned Dust awakening, before the Third Tsuchikage himself — and the bloodline refuses him.",
    callout: { kind: "proof", label: "Dice-over-plan proof", text: "The Dust awakening was expected narratively, but the engine returned a natural 1. The failure was honored, not retconned — and Ōnoki turned the fumble into the real lesson: hold the natures like a frame, not a fist." } },
  { path: "chapters/day24-28_graduation.md", slug: "day24-28-graduation", arc: "academy", tags: ["Academy", "Team"],
    teaser: "Graduation — the headband earned, and Team Kurikara formed: the heir, his rival, and the friend who keeps him human." },
  { path: "chapters/day29-45_dranks.md", slug: "day29-45-dranks", arc: "genin", tags: ["Mission", "Caravan", "Training"],
    teaser: "The work of genin: D-ranks that forge a squad into one animal — and the eastern-road escalation that promises the work is about to get real." },
  { path: "chapters/day46_truedust.md", slug: "day46-truedust", arc: "genin", tags: ["Dust Release", "Engine Proof"],
    teaser: "The frame holds: the true Dust awakening — wielding the deadliest bloodline in history not to crush, but to shield a fallen teammate." },
  { path: "chapters/day47-58_exhibition.md", slug: "day47-58-exhibition", arc: "genin", tags: ["Dust Release", "Chūnin Exam"],
    teaser: "The Exhibition: controlled Dust unveiled to the village — and the foreign eyes that don't weep, but calculate. Team Kurikara is entered in the Chūnin Exam." },
  { path: "chapters/day61-70_chunin_written_survival.md", slug: "day61-70-chunin", arc: "chunin", tags: ["Chūnin Exam", "Mission", "Engine Proof"],
    teaser: "Paper and wasteland: passed on the courage of the tenth question, then a controlled Honed Detachment routs a foreign hunter sent for the dust." },
  { path: "chapters/day85-90_finals.md", slug: "day85-90-finals", arc: "chunin", tags: ["Chūnin Exam", "Dice-over-plan"],
    teaser: "The climax: one boy, one ring, the whole continent watching — and the honest dice.",
    callout: { kind: "proof", label: "The protagonist lost", text: "Iwao failed the save against Hayato's Rock Tank, dropped to 0 HP, and was not promoted. The engine refused the expected climax — and the story is sharper for the scar." } },
  { path: "week99_debrief.md", slug: "debrief-volume-one", arc: "afterword", debrief: true, badge: "Debrief", tags: ["Engine Proof", "Audit Trail"],
    teaser: "Not a chapter — the reason the story is trustworthy. The thesis, the three dice-over-plan proofs, the five findings, and the verdict: the engine held." },
  { path: "chapters/act2_ch01_the_assistant.md", slug: "act2-ch01-the-assistant", arc: "actii", tags: ["Teaching", "Dice-over-plan", "Engine Proof"],
    teaser: "The Academy sends for the heir — not as a student, as help. A boy molds chakra like a fist, and Iwao learns he cannot teach by control.",
    callout: { kind: "proof", label: "Dice-over-plan proof", text: "Iwao's Chakra Control check to defuse + teach the boy came up 11 vs DC 15 — a failure. The prodigy can't teach by control; the resolution was a human turn (he showed the boy his scarred hands and named his finals loss), not a re-rolled win." } },
  { path: "chapters/act2_ch02_the_mission_desk.md", slug: "act2-ch02-the-mission-desk", arc: "actii", tags: ["Mission Desk", "Intrigue", "Engine Proof"],
    teaser: "A clerk's day at the mission desk — and the eastern-road reports don't add up. Iwao sees the thing the village has decided not to know yet.",
    callout: { kind: "proof", label: "The world the DM didn't script", text: "Both NPCs — Raido the Cloud envoy and Kazan the mission clerk — took their own turns: real model declarations conformed and resolved through the engine. The DM set the pressure; the characters chose their own words." } },
  { path: "chapters/act2_ch03_the_little_escort.md", slug: "act2-ch03-the-little-escort", arc: "actii", tags: ["Mission", "Intrigue", "Engine Proof"],
    teaser: "The board gives him children to walk to the training ground — and a 'broken cart' at the blind bend that's really a stopwatch. Iwao gives the watchers a blank page.",
    callout: { kind: "proof", label: "Restraint the dice left to him", text: "Iwao made the Perception catch (16 vs 15) — but his growth was a CHOICE the engine handed back: he declined to answer the probe with power, removed the children, and gave the measurers nothing to read. The missing-nin's withdraw declaration hit needs_dm_repair and stayed mere narration, not canon." } },
  { path: "chapters/act2_ch04_road_work.md", slug: "act2-ch04-road-work", arc: "actii", tags: ["Mission", "Intrigue", "Dice-over-plan"],
    teaser: "Sent east to fix a road, Iwao can't read the tampered ground — but his scholar's mind recognizes the reshaped bend as textbook ambush geometry. A true warning, easily discounted.",
    callout: { kind: "proof", label: "Two rolls, one character", text: "Nature 12 vs 15 (fail) + History 23 vs 14 (success): the dice drew Iwao exactly — no woodsman's eye, but the boy who loves the battle-histories finds the war before the trackers do." } },
  { path: "chapters/act2_ch05_caravan_under_rain.md", slug: "act2-ch05-caravan-under-rain", arc: "actii", tags: ["Combat", "Caravan", "Engine Proof", "Dice-over-plan"],
    teaser: "The geometry comes off the page. An ambush at the killing-bend, a hired blade faster than him — and Iwao wins not by crushing but by holding the frame. Then he finds the planted token.",
    callout: { kind: "proof", label: "The fight the dice fought", text: "Every blow rolled live: Ren's two DEX saves (22, 20), the 15-slash that took Iwao to 15 HP, the 41-rolled Sand-Coffin. Iwao out-lasted a +20 blade through control — no kills — then read the wreck (Perception 16) and found a planted Cloud token: a manufactured war." } },
  { path: "chapters/act2_ch06_the_report_nobody_wants.md", slug: "act2-ch06-the-report-nobody-wants", arc: "actii", tags: ["Intrigue", "Politics", "Dice-over-plan"],
    teaser: "Iwao holds the proof a war was forged — and must decide whose hand to put it in. He can't sway the room (he never could), but the truth he lays down is undeniable, and the old man on the terrace is finally listening.",
    callout: { kind: "proof", label: "He loses the room, wins the record", text: "Persuasion 11 vs 15 (fail) + Ninshou 24 vs 15 (success): the same soul as Road Work — Iwao can't charm a frightened hall, but his evidence is airtight. Ōnoki's 'measure the heir' goal completed on the tick; the verdict came from played deeds, not authorial fiat." } },
  { path: "chapters/act2_ch07_the_hand_behind_the_token.md", slug: "act2-ch07-the-hand-behind-the-token", arc: "actii", tags: ["Intrigue", "Alliance", "Dice-over-plan"],
    teaser: "Charged to find the framer, Iwao hits the library's far wall — the forgery's too good to trace — so he trusts an enemy to catch a worse one. Raido's lead: the token was forged by someone who knows the Cloud from the inside.",
    callout: { kind: "proof", label: "The third wall, and borrowed eyes", text: "Ninshou 14 vs 16 — the scholar can't crack it; the answer isn't in any archive. So the hunt turns on trust, not intellect: the framed Cloud envoy (his own model-driven turn) gives the thread the book couldn't — a Cloud-connected forger." } },
  { path: "chapters/act2_ch08_the_rot_inside.md", slug: "act2-ch08-the-rot-inside", arc: "actii", tags: ["Intrigue", "Investigation", "Engine Proof"],
    teaser: "The thread Iwao expected to run east turns around and runs home. With Akemi's sensing he traces the disaster's money and muscle to a broker wearing a chain of office — inside the wall.",
    callout: { kind: "proof", label: "He stopped bringing his weaknesses to the work", text: "Perception 19 (Iwao can't track, so he borrows Akemi's sensing and reads the pattern). Dosu's model-driven turn gives up the inside broker. The rot is in the Stone, not beyond it." } },
  { path: "chapters/act2_ch09_the_name_and_the_chain.md", slug: "act2-ch09-the-name-and-the-chain", arc: "actii", tags: ["Intrigue", "Investigation", "Dice-over-plan"],
    teaser: "Off the official channel, Iwao reads a traitor out of the registry — a natural 20 names Administrator Jōzen, a true-believer who'd burn the village to forge it harder. But knowing isn't proving, and naming him early forces his hand.",
    callout: { kind: "proof", label: "The crit that crowned the scholar", text: "Ninshou nat-20 (27 vs DC 16) — after a week of analysis walls, the dice finally let Iwao be exactly as good as he is, naming the broker with total certainty. Jōzen's model-driven turn hides behind office; being right out loud forces the climax." } },
];

/* ----------------------------- markdown → html ----------------------------- */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function inline(s) {
  return esc(s)
    .replace(/`([^`]+?)`/g, "<code>$1</code>") // inline code first (protects its contents)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<em>$2</em>");
}
function firstSentence(body) {
  const m = body.replace(/^#+ .*$/gm, "").trim().match(/^.*?[.!?](\s|$)/s);
  return (m ? m[0] : body.slice(0, 160)).replace(/\s+/g, " ").trim();
}
/**
 * Clean narration plaintext for TTS: the title + body prose, with the ---LOG--- footer, the
 * inline [OOC …] brackets, and markdown syntax stripped — so the spoken narration is the STORY,
 * not the dice. Headings become soft pauses (sentence breaks).
 */
export function narrationText(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const title = (lines.find((l) => /^TITLE:/.test(l)) || "").replace(/^TITLE:\s*/, "").trim();
  const logIdx = lines.findIndex((l) => l.trim() === "---LOG---");
  const sepIdx = lines.findIndex((l, i) => i > 1 && l.trim() === "---");
  const body = lines.slice(sepIdx + 1, logIdx === -1 ? undefined : logIdx);
  const out = [];
  for (const line of body) {
    const t = line.trim();
    if (!t || t === "---") continue;
    if (/^\[OOC\b[\s\S]*\]$/i.test(t)) continue; // skip OOC brackets — story only
    const clean = t
      .replace(/^#{1,3}\s+/, "") // heading marker
      .replace(/^[-+]\s+/, "") // bullet
      .replace(/^\d+\.\s+/, "") // numbered
      .replace(/^>\s?/, "") // quote
      .replace(/`([^`]+?)`/g, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1");
    out.push(clean);
  }
  const prose = out.join("\n\n").replace(/[ \t]+/g, " ").trim();
  return title ? `${title}.\n\n${prose}` : prose;
}

export function parseChapter(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const title = (lines.find((l) => /^TITLE:/.test(l)) || "TITLE: Untitled").replace(/^TITLE:\s*/, "").trim();
  const dates = (lines.find((l) => /^DATES:/.test(l)) || "DATES:").replace(/^DATES:\s*/, "").trim();
  const logIdx = lines.findIndex((l) => l.trim() === "---LOG---");
  const sepIdx = lines.findIndex((l, i) => i > 1 && l.trim() === "---"); // header separator (after DATES)
  const bodyLines = lines.slice(sepIdx + 1, logIdx === -1 ? undefined : logIdx);
  const logLines = logIdx === -1 ? [] : lines.slice(logIdx + 1);

  const html = [];
  let para = [];
  let listType = null; // 'ul' | 'ol'
  let quote = [];
  const flushPara = () => { if (para.length) { html.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = null; } };
  const flushQuote = () => { if (quote.length) { html.push(`<blockquote>${quote.map((q) => inline(q)).join("<br>")}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); closeList(); flushQuote(); };
  for (const line of bodyLines) {
    const t = line.trim();
    if (t === "") { flushAll(); continue; }
    if (t === "---") { flushAll(); html.push('<hr class="strata">'); continue; }
    // OOC interjection: a line wrapped in [OOC … ] — the dice/damage/HP, shown inline in the
    // reading flow but clearly set apart as out-of-character (never woven into the narrative).
    if (/^\[OOC\b[\s\S]*\]$/i.test(t)) { flushAll(); html.push(`<aside class="ooc">${inline(t.replace(/^\[\s*/, "").replace(/\s*\]$/, ""))}</aside>`); continue; }
    let m;
    if ((m = t.match(/^#{1,2}\s+(.*)/))) { flushAll(); html.push(`<h2>${inline(m[1])}</h2>`); continue; }
    if ((m = t.match(/^###\s+(.*)/))) { flushAll(); html.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = t.match(/^>\s?(.*)/))) { flushPara(); closeList(); quote.push(m[1]); continue; }
    if ((m = t.match(/^[-+]\s+(.*)/))) { flushPara(); flushQuote(); if (listType !== "ul") { closeList(); html.push("<ul>"); listType = "ul"; } html.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = t.match(/^(\d+)\.\s+(.*)/))) { flushPara(); flushQuote(); if (listType !== "ol") { closeList(); html.push(`<ol start="${m[1]}">`); listType = "ol"; } html.push(`<li>${inline(m[2])}</li>`); continue; }
    flushQuote(); closeList(); para.push(t);
  }
  flushAll();

  const bodyPlain = bodyLines.join("\n");
  const logHtml = logLines.map((l) => l.trim()).filter(Boolean).map((l) => `<p class="log-line">${inline(l)}</p>`).join("\n        ");
  return { title, dates, bodyHtml: html.join("\n        "), logHtml, teaserAuto: firstSentence(bodyPlain) };
}

/* ----------------------------- shared chrome ----------------------------- */
const HEAD = (title, desc) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Cinzel:wght@500;700;900&family=Shippori+Mincho:wght@500;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="ASSETS/story.css">
</head>`;
const PROGRESS = `<script>
addEventListener('scroll',()=>{const h=document.body.scrollHeight-innerHeight;document.getElementById('bar').style.width=(h>0?100*scrollY/h:0)+'%'});
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)e.target.classList.add('in')}),{threshold:.1});
document.querySelectorAll('.reveal').forEach(el=>io.observe(el));
</script>`;
const tagHtml = (tags = []) => tags.map((t) => `<span class="tag${PROOF_TAGS.has(t) ? " proof" : ""}">${esc(t)}</span>`).join("");

/* ----------------------------- chapter page ----------------------------- */
function renderChapter(entry, parsed, prev, next) {
  const navLinks = (cls = "") => `<nav class="chapter-nav ${cls}">
      <a class="${prev ? "" : "disabled"}" href="${prev ? prev.slug + ".html" : "#"}">← Previous</a>
      <a class="mid" href="../story.html">Index</a>
      <a class="${next ? "" : "disabled"}" href="${next ? next.slug + ".html" : "#"}">Next →</a>
    </nav>`;
  const callout = entry.callout
    ? `<div class="callout ${entry.callout.kind === "proof" ? "proof" : ""}"><span class="lbl">${esc(entry.callout.label)}</span><p>${esc(entry.callout.text)}</p></div>`
    : "";
  const dek = entry.teaser || parsed.teaserAuto;
  // OpenAI-generated narration (build-tts.mjs writes docs/audio/<slug>.mp3). Shown when present;
  // chapters without a file fall back to the Web Speech narrator in tts.js.
  const narration = existsSync(join(DOCS, "audio", `${entry.slug}.mp3`))
    ? `<div class="narration"><span class="narration-tag">🎧 Narration</span><audio class="tts-audio" controls preload="none"><source src="../audio/${entry.slug}.mp3" type="audio/mpeg">Your browser can't play audio.</audio></div>`
    : "";
  const head = HEAD(`${parsed.title} · Iwao — The Particle Heir`, dek).replace(/ASSETS\//g, "../assets/");
  const logBlock = parsed.logHtml
    ? `<section class="ooc-ledger">
      <div class="ooc-tag">OOC · State Ledger — the engine's truth for this chapter</div>
      <div class="ooc-body">
        ${parsed.logHtml}
      </div>
    </section>`
    : "";
  return `${head}
<body class="${entry.debrief ? "is-debrief" : ""}">
<div class="vignette"></div><div id="bar"></div>
<div class="topbar">
  <a class="home" href="../index.html"><b>◆</b> Iwao · The Particle Heir</a>
  <nav><a class="btn" href="../story.html">▣ Index</a><a class="btn" href="../index.html">↩ Journey</a></nav>
</div>
<article class="chapter-page">
  <header class="chapter-hero reveal">
    <a class="back-link" href="../story.html">← Volume One Index</a>
    <p class="eyebrow">${esc(parsed.dates)}</p>
    <h1>${esc(parsed.title)}</h1>
    <p class="chapter-dek">${esc(dek)}</p>
    <div class="tagrow">${tagHtml(entry.tags)}</div>
  </header>
  ${navLinks()}
  ${narration}
  ${callout}
  <section class="chapter-body reveal">
        ${parsed.bodyHtml}
  </section>
  ${logBlock}
  ${navLinks("bottom")}
  <footer class="chap-foot">Every die in these pages was rolled by the engine · <a href="https://github.com/Mnehmos/naruto5e" target="_blank" rel="noopener">github.com/Mnehmos/naruto5e</a></footer>
</article>
${PROGRESS}
</body>
</html>`;
}

/* ----------------------------- story index ----------------------------- */
function renderIndex(items) {
  const head = HEAD("Read Volume One · Iwao — The Particle Heir", "The full Volume One of Iwao the Particle Heir — a Naruto 5e AI-DM playtest manga, chapter by chapter, with the engine's audit trail preserved.").replace(/ASSETS\//g, "assets/");
  const firstSlug = items[0]?.slug;
  const debrief = items.find((x) => x.entry.debrief);
  let body = "";
  for (const key of Object.keys(ARCS)) {
    const arc = ARCS[key];
    const inArc = items.filter((x) => x.entry.arc === key);
    if (!inArc.length) continue;
    body += `
  <section class="arc reveal">
    <div class="arc-h"><span class="ord">${arc.ord}</span><h2>${esc(arc.title)}</h2></div>
    <p class="arc-sub">${esc(arc.sub)}</p>
    <div class="cards">`;
    for (const { entry, parsed } of inArc) {
      const dek = entry.teaser || parsed.teaserAuto;
      const badge = entry.badge ? `<span class="badge ${entry.badge.toLowerCase()}">${esc(entry.badge)}</span>` : `<span class="badge">${entry.debrief ? "Debrief" : "Story"}</span>`;
      body += `
      <a class="card" href="chapters/${entry.slug}.html">
        <div class="inner">
          <div class="eyebrow">${esc(parsed.dates)}</div>
          <h3>${esc(parsed.title)}</h3>
          <p>${esc(dek)}</p>
          <div class="meta">${tagHtml(entry.tags)}${badge}</div>
        </div>
      </a>`;
    }
    body += `
    </div>
  </section>`;
  }
  return `${head}
<body>
<div class="vignette"></div><div id="bar"></div>
<div class="topbar">
  <a class="home" href="index.html"><b>◆</b> Iwao · The Particle Heir</a>
  <nav><a class="btn" href="index.html">↩ Journey</a><a class="btn" href="https://github.com/Mnehmos/naruto5e" target="_blank" rel="noopener">★ Repo</a></nav>
</div>
<header class="idx-hero">
  <div class="eyebrow">A Naruto 5e AI-DM playtest manga</div>
  <h1>VOLUME ONE</h1>
  <div class="vol">The Particle Heir</div>
  <p class="blurb">Follow Iwao's first ninety days — from Academy prodigy to Genin finalist: the failed awakening, the team that taught him trust, the mission road, the Chūnin Exam, and the loss that proved the engine would not lie. <em>Act II is underway: the world opens up.</em></p>
  <div class="cta">
    ${firstSlug ? `<a class="btn solid" href="chapters/${firstSlug}.html">▶ Start Reading</a>` : ""}
    ${debrief ? `<a class="btn" href="chapters/${debrief.entry.slug}.html">✦ The Debrief</a>` : ""}
  </div>
  <div class="howto"><b>How to read this</b>Story chapters are the manga / web-novel experience. Each chapter's <em>Engine Log</em> is preserved as a collapsible audit trail — the deterministic state behind the prose. The debrief explains how the engine constrained the AI Dungeon Master.</div>
</header>
${body}
<footer class="chap-foot">Volume One · every die rolled by the engine · <a href="https://github.com/Mnehmos/naruto5e" target="_blank" rel="noopener">github.com/Mnehmos/naruto5e</a></footer>
${PROGRESS}
</body>
</html>`;
}

/* ----------------------------- run ----------------------------- */
function build() {
  if (!existsSync(OUTCH)) mkdirSync(OUTCH, { recursive: true });
  const items = [];
  for (const entry of MANIFEST) {
    const p = join(SRC, entry.path);
    if (!existsSync(p)) { console.warn(`! missing: ${entry.path} — skipped`); continue; }
    const parsed = parseChapter(readFileSync(p, "utf8"));
    items.push({ entry, parsed });
  }
  for (let i = 0; i < items.length; i++) {
    const { entry, parsed } = items[i];
    const html = renderChapter(entry, parsed, items[i - 1]?.entry, items[i + 1]?.entry);
    writeFileSync(join(OUTCH, `${entry.slug}.html`), html, "utf8");
  }
  writeFileSync(join(DOCS, "story.html"), renderIndex(items), "utf8");
  console.log(`✓ built ${items.length} chapter page(s) → docs/chapters/ + docs/story.html`);
}

// run only when invoked directly (so build-tts.mjs can import MANIFEST/narrationText)
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) build();
