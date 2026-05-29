import { newId, reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { JutsuRecord, JutsuEffect } from "../content.js";
import { priceEffects, verdict, RANK_BUDGET, type Rank } from "../rules/pricing.js";

const RANKS: Rank[] = ["E", "D", "C", "B", "A", "S"];

interface DraftInput {
  damage?: string;
  damageType?: string;
  range?: number;
  area?: { size: number; shape?: string };
  save?: string;
  conditions?: string[];
  concentration?: boolean;
  delivery?: JutsuEffect["delivery"];
}

function buildEffect(input: DraftInput): JutsuEffect {
  const delivery: JutsuEffect["delivery"] = input.delivery ?? (input.save ? "save" : input.area ? "auto" : input.damage ? "attack" : "utility");
  const eff: JutsuEffect = { delivery };
  if (input.save) eff.saveAbility = input.save.toLowerCase() as any;
  if (input.damage) eff.damage = { dice: input.damage, type: (input.damageType ?? "force").toLowerCase() };
  if (input.save && input.damage) eff.halfOnSave = true;
  if (input.conditions?.length) eff.conditions = input.conditions.map((c) => ({ name: c, save: input.save }));
  if (input.area) eff.area = input.area;
  if (input.concentration) eff.concentration = true;
  return eff;
}

function buildRecord(rank: Rank, classification: string, input: DraftInput, opts: { name?: string; id?: string }): { record: JutsuRecord; points: number; verdict: ReturnType<typeof verdict> } {
  const priced = priceEffects(rank, input);
  const cost = Math.max(1, Math.round(priced.spend));
  const v = verdict(rank, priced.spend);
  const range = input.range ? `${input.range} feet` : input.area ? `Self (${input.area.size}-foot ${input.area.shape ?? "sphere"})` : "Self";
  const desc = [
    input.damage ? `Deals ${input.damage} ${input.damageType ?? "force"} damage` : "A shaping of chakra",
    input.save ? `(${input.save.toUpperCase()} save${input.damage ? " for half" : " negates"})` : input.damage ? "(on a hit)" : "",
    input.area ? `in a ${input.area.size}-foot ${input.area.shape ?? "sphere"}` : input.range ? `at up to ${input.range} feet` : "",
    input.conditions?.length ? `; on a failure the target is ${input.conditions.join(", ")}` : "",
    input.concentration ? " (Concentration)" : "",
  ].filter(Boolean).join(" ").trim() + ".";
  const record: JutsuRecord = {
    id: opts.id ?? newId("jutsu"),
    name: opts.name ?? "Unnamed Technique",
    classification,
    rank,
    castingTime: "1 Action",
    range,
    duration: input.concentration ? "Concentration, up to 1 minute" : "Instant",
    components: ["HS", "CM"],
    cost,
    keywords: [classification],
    description: desc,
    atHigherRanks: null,
    effect: buildEffect(input),
    nameVerified: !!opts.name,
    rankVerified: true,
    costVerified: true,
    classificationVerified: true,
    componentsVerified: true,
    builtBy: "jutsu_build",
  } as any;
  return { record, points: priced.spend, verdict: v };
}

function inferRank(spend: number): Rank {
  for (const r of RANKS) if (spend <= RANK_BUDGET[r] + 0.5) return r;
  return "S";
}

/** Phase 8 — jutsu_build (the empirical governor) + the freeform resolver. */
export function registerContentToolIntents(engine: Engine): void {
  engine.registerHandler("jutsu_build", (ctx) => {
    const sub = String(ctx.op.params.op ?? "draft");
    const rank = String(ctx.op.params.rank ?? "C").toUpperCase() as Rank;
    if (!RANK_BUDGET[rank] && sub !== "price") throw reject("bad_rank", `rank must be E|D|C|B|A|S (got "${rank}").`, { rank });
    const input = (ctx.op.params.effects as DraftInput) ?? {};

    if (sub === "price") {
      const r = (ctx.op.params.rank ? rank : inferRank(priceEffects("S", input).spend));
      const priced = priceEffects(r as Rank, input);
      ctx.ir.emit("jutsu_price", { data: { rank: r, points: Number(priced.spend.toFixed(2)), breakdown: priced.breakdown, ...verdict(r as Rank, priced.spend) } });
      return;
    }

    if (sub === "rerank") {
      const target = String(ctx.op.params.targetRank ?? rank).toUpperCase() as Rank;
      const priced = priceEffects(target, input);
      ctx.ir.emit("jutsu_rerank", { data: { targetRank: target, points: Number(priced.spend.toFixed(2)), ...verdict(target, priced.spend) }, narration: `At ${target}-rank: ${verdict(target, priced.spend).note}` });
      return;
    }

    if (sub === "commit") {
      const rec = ctx.op.params.record as JutsuRecord;
      if (!rec || !rec.id || !rec.name) throw reject("bad_record", "jutsu_build.commit requires params.record (a drafted jutsu).", {}, ["Draft first, then commit the returned record."]);
      ctx.engine.content.addJutsu(rec);
      ctx.ir.emit("jutsu_committed", { data: { jutsu: rec.id, name: rec.name }, narration: `${rec.name} (${rec.rank}-rank) is added to the world's jutsu catalog — learnable and castable.` });
      return;
    }

    // draft (default)
    const { record, points, verdict: v } = buildRecord(rank, String(ctx.op.params.classification ?? "Ninjutsu"), input, { name: ctx.op.params.name as string, id: ctx.op.params.id as string });
    ctx.ir.emit("jutsu_draft", {
      data: { record, points: Number(points.toFixed(2)), budget: v.budget, verdict: v.verdict, note: v.note },
      narration: `Drafted ${record.name} (${record.rank}): ${points.toFixed(1)} / budget ${v.budget} — ${v.verdict}. ${v.note}`,
    });
  });

  engine.registerHandler("freeform", (ctx) => {
    const sub = String(ctx.op.params.op ?? "resolve");
    const input = (ctx.op.params.effects as DraftInput) ?? {};
    if (sub === "cost") {
      const r = ctx.op.params.rank ? (String(ctx.op.params.rank).toUpperCase() as Rank) : inferRank(priceEffects("S", input).spend);
      const priced = priceEffects(r, input);
      ctx.ir.emit("freeform_cost", { data: { rank: r, points: Number(priced.spend.toFixed(2)), ...verdict(r, priced.spend) } });
      return;
    }
    // resolve: conform the improv into a priced, castable (ephemeral) primitive op
    const rank = ctx.op.params.rank ? (String(ctx.op.params.rank).toUpperCase() as Rank) : inferRank(priceEffects("S", input).spend);
    const name = String(ctx.op.params.description ?? "Improvised Technique").slice(0, 48);
    const { record, points, verdict: v } = buildRecord(rank, String(ctx.op.params.classification ?? "Ninjutsu"), input, { name, id: newId("freeform") });
    // register ephemerally so it can be cast once (not part of canon authoring)
    ctx.engine.content.addJutsu(record);
    const proposedOp = { type: "cast", actorId: ctx.op.actorId, params: { jutsu: record.id, targets: ctx.op.params.targets ?? [], force: true } };
    ctx.ir.emit("freeform_resolved", {
      actor: ctx.op.actorId,
      data: { record, points: Number(points.toFixed(2)), budget: v.budget, verdict: v.verdict, proposedOp, description: ctx.op.params.description },
      narration: `Improv conformed: "${ctx.op.params.description ?? name}" → a ${rank}-rank primitive (${points.toFixed(1)} pts, ${v.verdict}). Submit the proposed cast to resolve it.`,
    });
  });
}
