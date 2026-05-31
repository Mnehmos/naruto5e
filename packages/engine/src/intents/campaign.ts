import { newId, reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import { CampaignSchema, type Campaign } from "../domain/campaign.js";
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
    campaigns(ctx).put(c);
    ctx.ir.emit("campaign_updated", { data: { campaign: c }, narration: `Campaign "${c.name}" updated (${c.arc}, day ${c.day}).` });
  });

  engine.registerHandler("campaign_advance_day", (ctx) => {
    const c = loadCampaign(ctx);
    const days = Math.max(1, Number(ctx.op.params.days ?? 1));
    c.day += days;
    if (ctx.op.params.arc) c.arc = String(ctx.op.params.arc);
    campaigns(ctx).put(c);
    ctx.ir.emit("campaign_day", { data: { campaignId: c.id, day: c.day, arc: c.arc }, narration: `${days} day(s) pass — day ${c.day} (${c.arc}).` });
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
    ctx.ir.emit("campaign", {
      data: { campaign: c, party, activeMissions, standings, recentJournal },
      narration: `${c.name} — ${c.arc}, day ${c.day}. Party of ${party.length}; ${activeMissions.length} active mission(s); ${c.scenes.length} scene(s).`,
    });
  });
}
