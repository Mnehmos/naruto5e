import { reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import { loadActor } from "../rules/actor.js";
import { activeEncounter } from "../rules/turn.js";
import { blockedComponents, INCAPACITATING } from "../rules/conditions.js";
import { jutsuElement } from "../rules/combat.js";
import { RESOURCE_HINTS, tipLines, spendHints } from "../rules/hints.js";

/**
 * The LLM-agent seam (tier-3 ergonomics). agent_context is a READ-ONLY tool that
 * assembles everything an LLM needs to play one actor's turn — identity, vitals,
 * the scene (allies/threats with distance), and the LEGAL/affordable moves
 * (which known jutsu are castable right now, plus basic actions) — and frames the
 * request "decide this actor's move". The MOVE is produced by the calling LLM,
 * not the engine; it comes back as an ordinary intent (cast/attack/...) which the
 * engine adjudicates. The engine stays deterministic and hosts no LLM.
 */
function chebyshevFt(a?: { x: number; y: number }, b?: { x: number; y: number }): number | undefined {
  if (!a || !b) return undefined;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 5;
}

function teamOf(doc: any, coll: string): string {
  return doc.team ?? (coll === "characters" || doc.isPC ? "pc" : "enemy");
}

export function registerAgentIntents(engine: Engine): void {
  engine.registerHandler("agent_context", (ctx) => {
    const actorId = String(ctx.op.actorId ?? ctx.op.params.actorId ?? "");
    const ref = loadActor(ctx.store, actorId);
    if (!ref) {
      throw reject("actor_required", "agent_context needs a character or adversary actorId (use npc_context for NPC roleplay).", { actorId }, ["Set actorId to a combatant in the room."]);
    }
    const doc = ref.doc;
    const room = ctx.room.id;
    const enc = activeEncounter(ctx.store, room);
    const inCombat = !!enc;
    const myTurn = inCombat ? enc!.order[enc!.activeIndex] === actorId : true;
    const myTeam = teamOf(doc, ref.coll);

    // scene: living others, split into allies / threats with distance from me
    const others = [
      ...ctx.store.collection<any>("characters").find((c) => c.roomId === room),
      ...ctx.store.collection<any>("adversaries").find((a) => a.roomId === room),
    ].filter((o) => o.id !== actorId && !o.dead);
    const peer = (o: any) => ({ id: o.id, name: o.name, hp: o.hp, conditions: o.conditions ?? [], team: teamOf(o, o.kind === "adversary" ? "adversaries" : "characters"), distanceFt: chebyshevFt(doc.position, o.position) });
    const allies = others.filter((o) => teamOf(o, o.kind === "adversary" ? "adversaries" : "characters") === myTeam).map(peer);
    const threats = others.filter((o) => teamOf(o, o.kind === "adversary" ? "adversaries" : "characters") !== myTeam).map(peer);

    // affordances: which known jutsu are castable right now. PCs hold their kit
    // in `jutsuKnown`; adversaries (DM-authored) hold theirs in `jutsu`. Read
    // whichever this actor uses so a kitted adversary surfaces its real jutsu
    // instead of falling through to "0 castable" (which nudged DMs to freeform).
    const blocked = [...blockedComponents(doc.conditions ?? [])];
    const jutsu = (doc.jutsuKnown ?? doc.jutsu ?? [])
      .map((id: string) => {
        const j = ctx.engine.content.getJutsu(id);
        if (!j) return null;
        const enoughChakra = (doc.chakra?.current ?? 0) >= (j.cost ?? 0);
        const missing = (j.components ?? []).filter((c: string) => blocked.includes(c));
        const castable = enoughChakra && missing.length === 0;
        return {
          id: j.id,
          name: j.name,
          rank: j.rank,
          cost: j.cost,
          classification: j.classification,
          delivery: j.effect?.delivery,
          element: jutsuElement(j),
          castable,
          ...(castable ? {} : { blockedBy: !enoughChakra ? "chakra" : `components:${missing.join(",")}` }),
        };
      })
      .filter(Boolean);

    const incap = (doc.conditions ?? []).find((c: string) => INCAPACITATING.has(c));
    const canAct = !incap && (!inCombat || myTurn);
    const basicActions = canAct
      ? inCombat
        ? ["attack {target}", "cast {jutsu,targets}", "move {to|distance}", "dash", "dodge", "disengage", "advance (end turn)"]
        : ["cast {jutsu,targets}", "narrate / social_speak", "rest (out of combat)"]
      : [];

    ctx.ir.emit("agent_context", {
      actor: actorId,
      data: {
        identity: { id: doc.id, name: doc.name, kind: ref.coll, clan: doc.clan, className: doc.className, rank: doc.rank, level: doc.level, tier: doc.tier, team: myTeam, traits: [...(doc.traits ?? []), ...(doc.clanTraits ?? [])], affinity: doc.affinity ?? [] },
        vitals: { hp: doc.hp, chakra: doc.chakra, ac: doc.ac, conditions: doc.conditions ?? [], position: doc.position, turnBudget: doc.turnBudget },
        scene: { mode: inCombat ? "combat" : "scene", myTurn, round: enc?.round, activeTurn: enc ? enc.order[enc.activeIndex] : undefined, allies, threats },
        affordances: { canAct, jutsu, basicActions, spendHints: spendHints(inCombat ? "combat" : "scene"), ...(incap ? { incapacitatedBy: incap } : {}) },
        casting: doc.casting,
      },
      narration:
        `${doc.name} — ${inCombat ? (myTurn ? `round ${enc!.round}, THEIR turn` : `round ${enc!.round}, waiting`) : "scene"}. ` +
        `HP ${doc.hp?.current ?? "?"}/${doc.hp?.max ?? "?"}, chakra ${doc.chakra?.current ?? "?"}/${doc.chakra?.max ?? "?"}. ` +
        `${threats.length} threat(s), ${allies.length} ally(ies); ${jutsu.filter((j: any) => j.castable).length}/${jutsu.length} jutsu castable. ` +
        (canAct ? "Decide their move and submit it (cast/attack/...)." : `Cannot act${incap ? ` (${incap})` : " (not their turn)"}.`),
    });
  });

  // hints — context FRONTLOADING: a queryable guide to every resource and HOW TO SPEND IT.
  // The DM/LLM reads this once to learn the verbs ("you can buy slots with fame", "a teacher
  // can lift the clan lock", "strict time needs plan_day/resolve_block") instead of guessing.
  engine.registerHandler("hints", (ctx) => {
    const topic = ctx.op.params.topic ? String(ctx.op.params.topic).toLowerCase() : undefined;
    const resources = topic ? RESOURCE_HINTS.filter((h) => h.resource.toLowerCase().includes(topic) || h.via.some((v) => v.toLowerCase().includes(topic))) : RESOURCE_HINTS;
    ctx.ir.emit("hints", {
      data: { resources, tips: tipLines() },
      narration: "Resources & how to spend them — " + resources.map((h) => `${h.resource}: ${h.via[0]}`).join(" · ") + ".",
    });
  });
}
