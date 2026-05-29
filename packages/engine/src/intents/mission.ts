import { newId, reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import { MISSION_REWARDS, MissionSchema, RANK_ORDER, type Mission } from "../domain/mission.js";

function missions(ctx: ResolveContext) {
  return ctx.store.collection<Mission>("missions");
}
function chars(ctx: ResolveContext) {
  return ctx.store.collection<Character>("characters");
}

/** Ch.7 — the mission board: post, accept, resolve(rewards), fail, rank_up. */
export function registerMissionIntents(engine: Engine): void {
  engine.registerHandler("mission_post", (ctx) => {
    const p = ctx.op.params;
    const rank = String(p.rank ?? "D").toUpperCase() as Mission["rank"];
    if (!MISSION_REWARDS[rank]) throw reject("bad_rank", `Mission rank must be D|C|B|A|S (got "${rank}").`, { rank });
    const band = MISSION_REWARDS[rank];
    const m = MissionSchema.parse({
      id: (p.id as string) || newId("mission"),
      roomId: ctx.room.id,
      title: String(p.title ?? `${rank}-rank mission`),
      rank,
      requiredRank: (p.requiredRank as string) ?? band.requiredRank,
      rewardRyo: p.rewardRyo !== undefined ? Number(p.rewardRyo) : band.ryo,
      rewardMissionPoints: p.rewardMissionPoints !== undefined ? Number(p.rewardMissionPoints) : band.mp,
      locale: p.locale as string | undefined,
      brief: p.brief as string | undefined,
      status: "posted",
    });
    missions(ctx).put(m);
    ctx.ir.emit("mission_posted", { data: { mission: m }, narration: `Mission board: "${m.title}" (${m.rank}-rank, ${m.rewardRyo} Ryo).` });
  });

  engine.registerHandler("mission_list", (ctx) => {
    const board = missions(ctx).find((m) => m.roomId === ctx.room.id && (ctx.op.params.all === true || m.status === "posted"));
    ctx.ir.emit("mission_board", { data: { count: board.length, missions: board } });
  });

  engine.registerHandler("mission_accept", (ctx) => {
    const m = missions(ctx).get(String(ctx.op.params.missionId ?? ""));
    if (!m) throw reject("entity_not_found", `No mission "${ctx.op.params.missionId}".`, {}, ["Post one (mission_post) or list the board."]);
    const squad = (ctx.op.params.squad as string[]) ?? (ctx.op.actorId ? [ctx.op.actorId] : []);
    if (squad.length === 0) throw reject("squad_required", "mission_accept requires a squad (params.squad or actorId).", {}, ["Provide params.squad: [characterIds]."]);
    // rank gate
    for (const id of squad) {
      const c = chars(ctx).get(id);
      if (!c) throw reject("entity_not_found", `No character "${id}".`, { id });
      if (RANK_ORDER.indexOf(c.rank) < RANK_ORDER.indexOf(m.requiredRank)) {
        throw reject("rank_too_low", `${c.name} is ${c.rank}; "${m.title}" requires ${m.requiredRank}.`, { has: c.rank, needs: m.requiredRank }, ["Take a lower-rank mission, or earn promotion first."]);
      }
    }
    m.assignedTo = squad;
    m.status = "active";
    rooms_setMission(ctx, m.id);
    missions(ctx).put(m);
    ctx.ir.emit("mission_accepted", { data: { mission: m.id, squad }, narration: `The squad accepts "${m.title}".` });
  });

  engine.registerHandler("mission_resolve", (ctx) => {
    const m = missions(ctx).get(String(ctx.op.params.missionId ?? ctx.room.missionId ?? ""));
    if (!m) throw reject("entity_not_found", "No mission to resolve (params.missionId).", {}, ["Accept a mission first."]);
    if (m.status === "resolved") throw reject("already_resolved", `"${m.title}" is already resolved.`, {});
    const success = ctx.op.params.outcome !== "failure";
    if (!success) {
      m.status = "failed";
      missions(ctx).put(m);
      ctx.ir.emit("mission_resolved", { data: { mission: m.id, outcome: "failure" }, narration: `The squad fails "${m.title}".` });
      return;
    }
    // over-rank command-impressed bonus
    const bonus = Number(ctx.op.params.bonusMultiplier ?? 1);
    const ryo = Math.round(m.rewardRyo * bonus);
    const mp = Math.round(m.rewardMissionPoints * bonus);
    const perRyo = Math.floor(ryo / Math.max(1, m.assignedTo.length));
    for (const id of m.assignedTo) {
      const c = chars(ctx).get(id);
      if (!c) continue;
      c.ryo += perRyo;
      c.missionPoints += mp;
      chars(ctx).put(c);
      ctx.ir.emit("reward", { actor: id, data: { ryo: perRyo, missionPoints: mp, total: { ryo: c.ryo, missionPoints: c.missionPoints } } });
    }
    m.status = "resolved";
    missions(ctx).put(m);
    rooms_setMission(ctx, undefined);
    ctx.ir.emit("mission_resolved", { data: { mission: m.id, outcome: "success", ryo, missionPoints: mp }, narration: `Mission "${m.title}" complete — ${ryo} Ryo and ${mp} mission points awarded.` });
  });

  engine.registerHandler("mission_fail", (ctx) => {
    const m = missions(ctx).get(String(ctx.op.params.missionId ?? ctx.room.missionId ?? ""));
    if (!m) throw reject("entity_not_found", "No mission to fail.", {});
    m.status = "failed";
    missions(ctx).put(m);
    ctx.ir.emit("mission_resolved", { data: { mission: m.id, outcome: "failure" }, narration: `"${m.title}" is marked failed.` });
  });

  engine.registerHandler("rank_up", (ctx) => {
    const c = chars(ctx).get(String(ctx.op.actorId));
    if (!c) throw reject("actor_required", "rank_up requires a valid actorId.", {});
    const idx = RANK_ORDER.indexOf(c.rank);
    if (idx < 0 || idx >= RANK_ORDER.length - 1) throw reject("max_rank", `${c.name} cannot be promoted beyond ${c.rank}.`, {});
    const to = (ctx.op.params.to as string) ?? RANK_ORDER[idx + 1];
    c.rank = to;
    chars(ctx).put(c);
    ctx.ir.emit("rank_up", { actor: c.id, data: { rank: c.rank }, narration: `${c.name} is promoted to ${c.rank}.` });
  });
}

function rooms_setMission(ctx: ResolveContext, missionId: string | undefined): void {
  const room = ctx.store.collection<any>("rooms").get(ctx.room.id);
  if (room) {
    room.missionId = missionId;
    ctx.store.collection<any>("rooms").put(room);
  }
}
