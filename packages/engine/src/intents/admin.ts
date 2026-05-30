import { reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import { activeEncounter } from "../rules/turn.js";

/** Every collection the engine writes to (for a full world wipe). */
const ALL_COLLECTIONS = [
  "rooms", "characters", "adversaries", "encounters", "missions", "npcs",
  "npc_relationships", "vendors", "stolen_items", "heat_states", "corpses", "standings",
];
/** Room-scoped collections (have a roomId) for a per-room wipe. */
const ROOM_SCOPED = ["characters", "adversaries", "encounters", "missions", "npcs", "vendors", "corpses"];

/** Admin / state-management seam: clear game state (the "reset world / room" tools). */
export function registerAdminIntents(engine: Engine): void {
  engine.registerHandler("world_reset", (ctx) => {
    let removed = 0;
    for (const name of ALL_COLLECTIONS) {
      const c = ctx.store.collection(name);
      for (const d of c.list()) {
        c.delete(d.id);
        removed++;
      }
    }
    ctx.ir.emit("world_reset", { data: { removed, collections: ALL_COLLECTIONS.length }, narration: `World reset — ${removed} records cleared. Fresh slate.` });
  });

  engine.registerHandler("room_reset", (ctx) => {
    const room = ctx.room.id;
    let removed = 0;
    for (const name of ROOM_SCOPED) {
      const c = ctx.store.collection(name);
      for (const d of c.find((x: any) => x.roomId === room)) {
        c.delete(d.id);
        removed++;
      }
    }
    const rooms = ctx.store.collection<any>("rooms");
    const rm = rooms.get(room);
    if (rm) {
      rm.mode = "scene";
      delete rm.encounterId;
      delete rm.missionId;
      rooms.put(rm);
    }
    ctx.ir.emit("room_reset", { data: { room, removed }, narration: `Room "${room}" cleared — ${removed} records removed; back to scene mode.` });
  });

  engine.registerHandler("character_delete", (ctx) => {
    const id = String(ctx.op.params.id ?? ctx.op.actorId ?? "");
    const chars = ctx.store.collection<any>("characters");
    const advs = ctx.store.collection<any>("adversaries");
    const existed = chars.get(id) ?? advs.get(id);
    if (!existed) throw reject("entity_not_found", `No character/adversary "${id}" to delete.`, { id });
    chars.delete(id);
    advs.delete(id);
    // drop it from the active encounter if present
    const enc = activeEncounter(ctx.store, ctx.room.id);
    if (enc) {
      const i = enc.combatants.findIndex((x) => x.actorId === id);
      if (i >= 0) {
        const activeId = enc.order[enc.activeIndex];
        enc.combatants.splice(i, 1);
        enc.order = enc.combatants.map((x) => x.actorId);
        enc.activeIndex = Math.max(0, enc.order.indexOf(activeId));
        ctx.store.collection("encounters").put(enc);
      }
    }
    ctx.ir.emit("character_deleted", { data: { id }, narration: `${existed.name ?? id} removed from the world.` });
  });
}
