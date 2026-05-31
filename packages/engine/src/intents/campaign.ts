import { newId, reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import { CampaignSchema, TimeBlockSchema, type Campaign } from "../domain/campaign.js";
import type { Mission } from "../domain/mission.js";
import { getLedger } from "../rules/standing.js";

/**
 * Campaign/world layer. A campaign unifies the things we already model — rooms
 * (scenes), characters (party), missions (quests), and per-authority Standing
 * (factions) — under one arc + world clock + journal, and composes a dashboard.
 */
function campaigns(ctx: ResolveContext) {
  return ctx.store.collection<Campaign>("campaigns");
}
function loadCampaign(ctx: ResolveContext): Campaign {
  const id = String(ctx.op.params.campaignId ?? ctx.op.params.id ?? "");
  const c = campaigns(ctx).get(id);
  if (!c) throw reject("entity_not_found", `No campaign "${id}".`, { campaignId: id }, ["Create one with campaign_create."]);
  return c;
}

export function registerCampaignIntents(engine: Engine): void {
  engine.registerHandler("campaign_create", (ctx) => {
    const p = ctx.op.params;
    const c = CampaignSchema.parse({
      id: (p.id as string) || newId("camp"),
      name: String(p.name ?? "Untitled Campaign"),
      arc: p.arc as string,
      party: (p.party as string[]) ?? [],
      scenes: (p.scenes as string[]) ?? (p.activeRoomId ? [String(p.activeRoomId)] : []),
      activeRoomId: p.activeRoomId as string,
      factionsOfNote: (p.factionsOfNote as string[]) ?? [],
      locations: (p.locations as any) ?? [],
      strictTemporal: p.strictTemporal === true,
      maxUnauthorizedDays: p.maxUnauthorizedDays != null ? Number(p.maxUnauthorizedDays) : undefined,
    });
    campaigns(ctx).put(c);
    ctx.ir.emit("campaign_created", { data: { campaign: c }, narration: `Campaign "${c.name}" begins — ${c.arc}, day ${c.day}.` });
  });

  engine.registerHandler("campaign_set", (ctx) => {
    const c = loadCampaign(ctx);
    const p = ctx.op.params;
    if (p.arc !== undefined) c.arc = String(p.arc);
    if (p.activeRoomId !== undefined) {
      c.activeRoomId = String(p.activeRoomId);
      if (!c.scenes.includes(c.activeRoomId)) c.scenes.push(c.activeRoomId);
    }
    if (p.addParty) for (const id of p.addParty as string[]) if (!c.party.includes(id)) c.party.push(id);
    if (p.removeParty) c.party = c.party.filter((id) => !(p.removeParty as string[]).includes(id));
    if (p.addScene) for (const id of p.addScene as string[]) if (!c.scenes.includes(id)) c.scenes.push(id);
    if (p.addLocation) {
      const loc = p.addLocation as any;
      c.locations.push(typeof loc === "string" ? { name: loc } : { name: String(loc.name), note: loc.note });
    }
    if (p.factionsOfNote) c.factionsOfNote = p.factionsOfNote as string[];
    if (p.strictTemporal !== undefined) c.strictTemporal = p.strictTemporal === true;
    if (p.maxUnauthorizedDays !== undefined) c.maxUnauthorizedDays = Number(p.maxUnauthorizedDays);
    campaigns(ctx).put(c);
    ctx.ir.emit("campaign_updated", { data: { campaign: c }, narration: `Campaign "${c.name}" updated (${c.arc}, day ${c.day}${c.strictTemporal ? ", strict time" : ""}).` });
  });

  // campaign_plan_day — lay out the current day's attention blocks (the schedule). In strict
  // mode each requiredAttention block must be resolved before time advances. The DM authors
  // the schedule; the engine enforces that lived time gets lived.
  engine.registerHandler("campaign_plan_day", (ctx) => {
    const c = loadCampaign(ctx);
    const blocksIn = (ctx.op.params.blocks as any[]) ?? [];
    if (!blocksIn.length) throw reject("blocks_required", "campaign_plan_day needs params.blocks (the day's schedule).", {}, ['Pass blocks:[{label, location?, requiredAttention?, actorsInScope?, startsAt?}]']);
    const replace = ctx.op.params.replace !== false; // default: replace the day's plan
    const planned = blocksIn.map((b) =>
      TimeBlockSchema.parse({
        id: b.id ?? newId("block"),
        day: c.day,
        label: String(b.label ?? "an unscheduled block"),
        location: b.location != null ? String(b.location) : undefined,
        startsAt: b.startsAt != null ? String(b.startsAt) : undefined,
        endsAt: b.endsAt != null ? String(b.endsAt) : undefined,
        requiredAttention: b.requiredAttention !== false,
        actorsInScope: (b.actorsInScope as string[]) ?? [],
      }),
    );
    c.blocks = replace ? planned : [...(c.blocks ?? []), ...planned];
    campaigns(ctx).put(c);
    ctx.ir.emit("campaign_day_planned", { data: { campaignId: c.id, day: c.day, blocks: c.blocks }, narration: `Day ${c.day} planned: ${c.blocks.length} block(s) (${c.blocks.filter((b) => b.requiredAttention).length} require attention).` });
  });

  // campaign_resolve_block — mark a scheduled block as lived: a played/narrated/logged beat,
  // optionally noting how many engine ops resolved in it. Unblocks time advancement.
  engine.registerHandler("campaign_resolve_block", (ctx) => {
    const c = loadCampaign(ctx);
    const blockId = String(ctx.op.params.blockId ?? "");
    const block = (c.blocks ?? []).find((b) => b.id === blockId);
    if (!block) throw reject("entity_not_found", `No time block "${blockId}" on day ${c.day}.`, { open: (c.blocks ?? []).filter((b) => !b.resolved).map((b) => ({ id: b.id, label: b.label })) }, ["Plan the day first (campaign_plan_day), or resolve an existing block id."]);
    block.resolved = true;
    if (ctx.op.params.digest != null) block.digest = String(ctx.op.params.digest);
    if (ctx.op.params.resolvedIntents != null) block.resolvedIntents = Number(ctx.op.params.resolvedIntents);
    campaigns(ctx).put(c);
    const open = (c.blocks ?? []).filter((b) => b.requiredAttention && !b.resolved);
    ctx.ir.emit("campaign_block_resolved", { data: { campaignId: c.id, blockId, openRequired: open.length }, narration: `Block "${block.label}" resolved${block.digest ? `: ${block.digest}` : ""}. ${open.length} required block(s) still open.` });
  });

  engine.registerHandler("campaign_advance_day", (ctx) => {
    const c = loadCampaign(ctx);
    const days = Math.max(1, Number(ctx.op.params.days ?? 1));
    const authorized = ctx.op.params.compressionAuthorized === true;
    // ---- strict-temporal guard (anti-time-compression) ----
    if (c.strictTemporal && !authorized) {
      const maxDays = c.maxUnauthorizedDays ?? 1;
      if (days > maxDays) {
        throw reject(
          "time_compression",
          `Strict time is on: you can't skip ${days} days at once (max ${maxDays} without authorization). Time here is meant to be lived hour by hour, not summarized.`,
          { requested: days, maxUnauthorizedDays: maxDays, day: c.day },
          ["Play/narrate the intervening days block by block (campaign_plan_day + resolve), or pass compressionAuthorized:true for a deliberate, logged time-skip."],
        );
      }
      const openRequired = (c.blocks ?? []).filter((b) => b.requiredAttention && !b.resolved);
      if (openRequired.length) {
        throw reject(
          "unresolved_blocks",
          `Day ${c.day} has ${openRequired.length} unresolved required block(s) — resolve them before time advances. The day isn't over until it's been lived.`,
          { open: openRequired.map((b) => ({ id: b.id, label: b.label })), day: c.day },
          ["Resolve each block (campaign_resolve_block) as you play/narrate it, or pass compressionAuthorized:true to skip deliberately."],
        );
      }
    }
    c.day += days;
    c.blocks = []; // a new day starts with a fresh (unplanned) schedule
    if (ctx.op.params.arc) c.arc = String(ctx.op.params.arc);
    campaigns(ctx).put(c);
    ctx.ir.emit("campaign_day", { data: { campaignId: c.id, day: c.day, arc: c.arc, compressionAuthorized: authorized }, narration: `${days} day(s) pass — day ${c.day} (${c.arc})${authorized ? " [authorized skip]" : ""}.` });
  });

  engine.registerHandler("campaign_log", (ctx) => {
    const c = loadCampaign(ctx);
    const beat = String(ctx.op.params.beat ?? "");
    if (!beat) throw reject("beat_required", "campaign_log needs the journal line (params.beat).", {}, ["Pass params.beat."]);
    const entry = { day: c.day, arc: c.arc, beat };
    c.journal.push(entry);
    campaigns(ctx).put(c);
    ctx.ir.emit("campaign_logged", { data: { campaignId: c.id, entry }, narration: `Journal (day ${c.day}): ${beat}` });
  });

  engine.registerHandler("campaign_get", (ctx) => {
    const c = loadCampaign(ctx);
    const chars = ctx.store.collection<any>("characters");
    const party = c.party.map((id) => {
      const ch = chars.get(id);
      return ch ? { id: ch.id, name: ch.name, rank: ch.rank, level: ch.level, hp: ch.hp, chakra: ch.chakra, room: ch.roomId } : { id, missing: true };
    });
    const activeMissions = ctx.store
      .collection<Mission>("missions")
      .find((m) => ["posted", "accepted", "active"].includes(m.status) && (c.scenes.length ? c.scenes.includes(m.roomId) : true))
      .map((m) => ({ id: m.id, title: m.title, rank: m.rank, status: m.status, room: m.roomId }));
    const standings: any[] = [];
    for (const charId of c.party)
      for (const auth of c.factionsOfNote) {
        const l = getLedger(ctx.store, charId, auth);
        if (l) standings.push({ charId, authorityId: auth, reputation: l.reputation, favor: l.favor, hostile: l.hostile });
      }
    const recentJournal = c.journal.slice(-Number(ctx.op.params.journalLimit ?? 8));
    const openBlocks = (c.blocks ?? []).filter((b) => !b.resolved);
    const openRequired = openBlocks.filter((b) => b.requiredAttention);
    ctx.ir.emit("campaign", {
      data: { campaign: c, party, activeMissions, standings, recentJournal, openBlocks, openRequiredCount: openRequired.length },
      narration: `${c.name} — ${c.arc}, day ${c.day}${c.strictTemporal ? " [strict time]" : ""}. Party of ${party.length}; ${activeMissions.length} active mission(s); ${c.scenes.length} scene(s).` + (openRequired.length ? ` ${openRequired.length} required block(s) still to live this day.` : ""),
    });
  });
}
