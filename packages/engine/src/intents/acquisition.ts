import { newId, reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import { learnGate } from "../rules/learn.js";
import { applyStandingDelta, getLedger } from "../rules/standing.js";
import { NpcRelationshipSchema, type NpcRelationship } from "../domain/world.js";

/**
 * Jutsu ACQUISITION — the social/world channels through which characters grow their
 * arsenals beyond what they could learn alone. The plain jutsu_learn (rules/learn gate)
 * answers "can I learn this on my own?"; these answer "who/what taught it to me?":
 *
 *   • jutsu_teach   — a tutor / teacher / special trainer / Kage / school imparts a
 *                     technique. A legitimate source LIFTS specific gates (a same-clan
 *                     tutor lifts the clan lock; a Medical sensei lifts the class lock;
 *                     a Kage grant lifts everything). Vaults/archives gate on standing.
 *   • study_scroll  — learn from a jutsu scroll the character is carrying (loot/buy/reward);
 *                     a forbidden scroll lifts clan/affinity. Consumed unless reusable.
 *   • jutsu_slot_buy— purchase additional technique SLOTS with FAME (reputation) through a
 *                     social leader — political capital expands your sanctioned repertoire.
 *
 * The deterministic gates still own legality: a source can lift the axes it legitimately
 * covers, but the engine — not the narrator — decides what each source is allowed to lift.
 */

const NINJA_RANKS = ["Academy", "Genin", "Chunin", "Jonin", "Kage", "Legendary"];
function rankMeets(rank: string | undefined, min: string): boolean {
  return NINJA_RANKS.indexOf(rank ?? "Genin") >= NINJA_RANKS.indexOf(min);
}

function chars(ctx: ResolveContext) {
  return ctx.store.collection<Character>("characters");
}
function loadStudent(ctx: ResolveContext): Character {
  const id = String(ctx.op.params.studentId ?? ctx.op.actorId ?? ctx.op.params.actorId ?? "");
  const c = chars(ctx).get(id);
  if (!c) throw reject("actor_required", "This requires a valid student characterId.", { id }, ["Set actorId (or params.studentId) to a character."]);
  return c;
}
function requireJutsu(ctx: ResolveContext, id: string): any {
  const j = ctx.engine.content.getJutsu(id);
  if (!j) throw reject("unknown_jutsu", `No jutsu "${id}" in the catalog.`, { id }, ["Use list_jutsu / jutsu_learnable to find a valid jutsu id."]);
  return j;
}

const GATE_AXIS: Record<string, string> = { rank_too_high: "rank", clan_locked: "clan", class_locked: "class", off_affinity: "affinity" };

/**
 * Core: impart a jutsu to a student through a SOURCE that lifts a given set of gate axes.
 * Mutates student.jutsuKnown (caller persists). Throws an educational rejection if a gate
 * the source does NOT cover still blocks it, or if there's no free slot. Records the
 * teacher↔student bond when a teacher is named.
 */
function teachJutsu(
  ctx: ResolveContext,
  student: Character,
  j: any,
  opts: { via: string; teacher?: any; bypass: Set<string>; force: boolean; viaFavor?: boolean },
): { already?: boolean } {
  if (student.jutsuKnown.includes(j.id)) return { already: true };
  const bypassAll = opts.force || opts.bypass.has("all");
  if (!bypassAll) {
    const gate = learnGate(student, j, (ctx.engine.content as any).clanNames?.() ?? []);
    if (!gate.ok) {
      const axis = GATE_AXIS[gate.rule!] ?? gate.rule!;
      const covered = opts.bypass.has(axis) || (axis === "affinity" && opts.viaFavor === true);
      if (!covered) {
        throw reject(
          gate.rule!,
          `${gate.explain} The "${opts.via}" source doesn't lift the ${axis} gate.`,
          { jutsu: j.id, axis, source: opts.via },
          [...(gate.suggestions ?? []), `Need a source that covers ${axis}: a matching-${axis} teacher, a Kage grant (via:"kage"), a forbidden scroll, viaFavor (off-affinity), or force:true.`],
        );
      }
    }
  }
  if (student.jutsuKnown.length >= (student.jutsuKnownCap ?? 0) && !opts.force) {
    throw reject(
      "jutsu_known_cap",
      `${student.name} has no free technique slot (${student.jutsuKnown.length}/${student.jutsuKnownCap}).`,
      { known: student.jutsuKnown.length, cap: student.jutsuKnownCap },
      ["Forget a jutsu (jutsu_forget), level up, or BUY a slot with fame (jutsu_slot_buy)."],
    );
  }
  student.jutsuKnown.push(j.id);
  // record the mentorship (the teacher remembers; the bond deepens) — feeds npc_context
  if (opts.teacher) {
    const rels = ctx.store.collection<NpcRelationship>("npc_relationships");
    const rid = `${opts.teacher.id}:${student.id}`;
    const rel = rels.get(rid) ?? NpcRelationshipSchema.parse({ id: rid, npcId: opts.teacher.id, actorId: student.id, authorityId: opts.teacher.authorityId });
    rel.familiarity = Math.min(100, (rel.familiarity ?? 0) + 8);
    rel.memories.push({ eventId: newId("mem"), summary: `taught ${student.name} the ${j.name}`, importance: "notable", topics: ["taught", "mentor"], sentiment: 4, witnessed: true });
    rels.put(rel);
  }
  return {};
}

export function registerAcquisitionIntents(engine: Engine): void {
  // jutsu_teach — tutor / teacher / special trainer / Kage / school / vault.
  engine.registerHandler("jutsu_teach", (ctx) => {
    const student = loadStudent(ctx);
    const j = requireJutsu(ctx, String(ctx.op.params.jutsu ?? ""));
    const force = ctx.op.params.force === true;
    const teacherId = ctx.op.params.teacherId ? String(ctx.op.params.teacherId) : undefined;
    const teacher = teacherId ? ctx.store.collection<any>("npcs").get(teacherId) : undefined;
    if (teacherId && !teacher) throw reject("entity_not_found", `No teacher NPC "${teacherId}".`, { teacherId }, ["Create the teacher (npc_create), or omit teacherId for a generic source."]);
    const via = String(ctx.op.params.via ?? (teacher ? "teacher" : "training"));

    // vault / archive / Kage repository: gate access on the student's standing / rank
    const requires = ctx.op.params.requires as { authorityId?: string; minReputation?: number; minRank?: string } | undefined;
    if (requires?.authorityId && !force) {
      const rep = getLedger(ctx.store, student.id, requires.authorityId)?.reputation ?? 0;
      if (requires.minReputation != null && rep < requires.minReputation) {
        throw reject("access_denied", `${j.name} is sealed in ${requires.authorityId}'s archive — ${requires.minReputation}+ standing required (you have ${rep}).`, { have: rep, need: requires.minReputation, authorityId: requires.authorityId }, ["Earn the village's trust (raise reputation), or have a leader grant access (force)."]);
      }
      if (requires.minRank && !rankMeets(student.rank, requires.minRank)) {
        throw reject("access_denied", `${j.name} is restricted to ${requires.minRank}+ — ${student.name} is ${student.rank}.`, { rank: student.rank, need: requires.minRank }, ["Earn the rank (the exam), or have a Kage grant it (force)."]);
      }
    }

    // which learn-gate axes does this SOURCE legitimately lift?
    const bypass = new Set<string>((ctx.op.params.bypass as string[]) ?? []);
    if (via === "kage") bypass.add("all"); // a Kage's grant is sanctioned override (logged)
    if (teacher) {
      bypass.add("access"); // a willing teacher answers "where would I even learn this"
      if (teacher.clan && teacher.clan === student.clan) bypass.add("clan"); // same-clan tutor passes the secret
      const tdesc = `${teacher.persona ?? ""} ${teacher.directive ?? ""}`;
      if (/medical|medic|iryō|iryo/i.test(tdesc)) bypass.add("class"); // a medical sensei passes the medical lock
    }

    const r = teachJutsu(ctx, student, j, { via, teacher, bypass, force, viaFavor: ctx.op.params.viaFavor === true });
    if (r.already) {
      ctx.ir.emit("jutsu_taught", { actor: student.id, data: { jutsu: j.id, already: true }, narration: `${student.name} already knows ${j.name}.` });
      return;
    }
    chars(ctx).put(student);
    ctx.ir.emit("jutsu_taught", {
      actor: student.id,
      data: { jutsu: j.id, name: j.name, via, teacherId: teacher?.id ?? null, known: student.jutsuKnown.length, cap: student.jutsuKnownCap },
      narration: `${teacher ? `${teacher.name} teaches ${student.name}` : `Through ${via}, ${student.name} learns`} ${j.name}.`,
    });
  });

  // study_scroll — learn from a jutsu scroll in the student's pack.
  engine.registerHandler("study_scroll", (ctx) => {
    const student = loadStudent(ctx);
    const wantJutsu = ctx.op.params.jutsu ? String(ctx.op.params.jutsu) : undefined;
    const ref = ctx.op.params.scroll ? String(ctx.op.params.scroll) : ctx.op.params.item ? String(ctx.op.params.item) : undefined;
    const equip: any[] = student.equipment ?? [];
    const idx = equip.findIndex((e) => (e?.type === "scroll" || e?.teaches) && (ref ? e.id === ref || e.name === ref : true) && (wantJutsu ? e.teaches === wantJutsu : true));
    if (idx < 0) throw reject("no_scroll", `${student.name} isn't carrying a matching jutsu scroll.`, { carrying: equip.filter((e) => e?.teaches).map((e) => e.teaches) }, ["Acquire a scroll first (loot / buy / reward / jutsu_scroll_grant), then study it."]);
    const scroll = equip[idx];
    const j = requireJutsu(ctx, String(scroll.teaches));
    const bypass = new Set<string>(scroll.forbidden ? ["clan", "affinity"] : []); // a forbidden scroll lifts clan/affinity
    const r = teachJutsu(ctx, student, j, { via: "scroll", bypass, force: ctx.op.params.force === true });
    if (!r.already && !scroll.reusable) equip.splice(idx, 1); // consume the scroll
    chars(ctx).put(student);
    ctx.ir.emit("scroll_studied", { actor: student.id, data: { jutsu: j.id, name: j.name, consumed: !r.already && !scroll.reusable, already: !!r.already, known: student.jutsuKnown.length, cap: student.jutsuKnownCap }, narration: r.already ? `${student.name} already knows ${j.name}.` : `${student.name} studies the scroll and learns ${j.name}${scroll.reusable ? "" : " (the scroll is spent)"}.` });
  });

  // jutsu_scroll_grant — mint a jutsu scroll into a character's pack (a reward, a vault
  // withdrawal, a found relic). The portable acquisition currency.
  engine.registerHandler("jutsu_scroll_grant", (ctx) => {
    const student = loadStudent(ctx);
    const j = requireJutsu(ctx, String(ctx.op.params.jutsu ?? ""));
    const scroll = { id: (ctx.op.params.id as string) || newId("scroll"), name: `Scroll: ${j.name}`, type: "scroll", teaches: j.id, forbidden: ctx.op.params.forbidden === true, reusable: ctx.op.params.reusable === true, qty: 1 };
    student.equipment = student.equipment ?? [];
    student.equipment.push(scroll);
    chars(ctx).put(student);
    ctx.ir.emit("scroll_granted", { actor: student.id, data: { scroll }, narration: `${student.name} receives a ${scroll.forbidden ? "forbidden " : ""}scroll teaching ${j.name}.` });
  });

  // jutsu_buy_scroll — the RYO/market path to a technique: buy a jutsu scroll for money
  // (price scales by rank), optionally gated by a village archive's standing. Distinct from
  // buy_slot (fame→capacity), favor_unlock (favor→off-affinity), and teach (relationship→tuition).
  const RANK_SCROLL_PRICE: Record<string, number> = { E: 50, D: 150, C: 400, B: 1200, A: 3000, S: 8000 };
  engine.registerHandler("jutsu_buy_scroll", (ctx) => {
    const student = loadStudent(ctx);
    const j = requireJutsu(ctx, String(ctx.op.params.jutsu ?? ""));
    const price = ctx.op.params.priceRyo != null ? Number(ctx.op.params.priceRyo) : RANK_SCROLL_PRICE[j.rank] ?? 200;
    const force = ctx.op.params.force === true;
    const requires = ctx.op.params.requires as { authorityId?: string; minReputation?: number } | undefined;
    if (requires?.authorityId && !force) {
      const rep = getLedger(ctx.store, student.id, requires.authorityId)?.reputation ?? 0;
      if (requires.minReputation != null && rep < requires.minReputation) {
        throw reject("access_denied", `The ${requires.authorityId} archive won't sell the ${j.name} scroll below ${requires.minReputation} standing (you have ${rep}).`, { have: rep, need: requires.minReputation }, ["Earn the village's trust, or find a black-market seller (a fence)."]);
      }
    }
    if (student.ryo < price && !force) {
      throw reject("insufficient_ryo", `The ${j.name} scroll costs ${price} Ryo; ${student.name} has ${student.ryo}.`, { price, have: student.ryo }, ["Earn Ryo (missions/loot/fencing), buy a lower-rank scroll, or get TAUGHT it instead (jutsu_teach)."]);
    }
    student.ryo = Math.max(0, student.ryo - price);
    const scroll = { id: newId("scroll"), name: `Scroll: ${j.name}`, type: "scroll", teaches: j.id, forbidden: ctx.op.params.forbidden === true, reusable: false, qty: 1 };
    student.equipment = student.equipment ?? [];
    student.equipment.push(scroll);
    chars(ctx).put(student);
    ctx.ir.emit("scroll_bought", { actor: student.id, data: { jutsu: j.id, name: j.name, price, ryoLeft: student.ryo, scroll }, narration: `${student.name} buys the ${j.name} scroll for ${price} Ryo (study it to learn).` });
  });

  // jutsu_slot_buy — purchase technique SLOTS with FAME (reputation) through a social leader.
  // Fame is political capital here: a leader expands your sanctioned repertoire, and it costs
  // standing. Escalates with how much capacity you've already been granted.
  engine.registerHandler("jutsu_slot_buy", (ctx) => {
    const student = loadStudent(ctx);
    const authorityId = String(ctx.op.params.authorityId ?? "");
    if (!authorityId) throw reject("authority_required", "jutsu_slot_buy needs the authorityId of the social leader who sponsors the slot.", {}, ["Name the village/clan/leader whose fame (reputation) you spend."]);
    const slots = Math.max(1, Number(ctx.op.params.slots ?? 1));
    const rep = getLedger(ctx.store, student.id, authorityId)?.reputation ?? 0;
    const currentCap = student.jutsuKnownCap ?? 0;
    const costPer = ctx.op.params.costPerSlot != null ? Number(ctx.op.params.costPerSlot) : 15 + 5 * Math.max(0, currentCap - 3);
    const cost = costPer * slots;
    if (rep < cost && ctx.op.params.force !== true) {
      throw reject("insufficient_fame", `Expanding ${student.name}'s repertoire by ${slots} slot(s) costs ${cost} fame with ${authorityId}; they have ${rep}.`, { need: cost, have: rep, costPerSlot: costPer }, ["Earn more renown with that authority, buy fewer slots, or have it granted (force)."]);
    }
    const spent = Math.min(rep, cost);
    if (spent > 0) applyStandingDelta(ctx.store, student.id, authorityId, { reputation: -spent, reason: `sponsored +${slots} technique slot(s)` });
    student.jutsuKnownCap = currentCap + slots;
    chars(ctx).put(student);
    const fameLeft = getLedger(ctx.store, student.id, authorityId)?.reputation ?? 0;
    ctx.ir.emit("jutsu_slot_bought", {
      actor: student.id,
      data: { authorityId, slots, cost: spent, newCap: student.jutsuKnownCap, fameLeft },
      narration: `A leader of ${authorityId} sponsors ${student.name}: +${slots} technique slot(s) for ${spent} fame (now ${student.jutsuKnownCap} slots, ${fameLeft} fame left).`,
    });
  });
}
