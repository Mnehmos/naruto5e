import { reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { Room } from "../domain/room.js";

/**
 * Phase 0 core intents — the minimal surface that proves the pipeline:
 * an intent round-trips (validate -> resolve -> emit IR) and the IR streams.
 */
export function registerCoreIntents(engine: Engine): void {
  // narrate: the DM speaks. The simplest intent — emits one narrate IR event.
  engine.registerHandler("narrate", (ctx) => {
    const text = String(ctx.op.params.text ?? "").trim();
    if (!text) {
      throw reject("empty_narration", "narrate requires a non-empty params.text.", {}, [
        "Provide params.text with the line to narrate.",
      ]);
    }
    ctx.ir.emit("narrate", { actor: ctx.op.actorId, data: { text }, narration: text });
  });

  // scene: set the room's out-of-combat scene (location label / mode).
  engine.registerHandler("scene", (ctx) => {
    const rooms = ctx.store.collection<Room>("rooms");
    const room = rooms.get(ctx.room.id)!;
    const location = ctx.op.params.location as string | undefined;
    const mode = ctx.op.params.mode as Room["mode"] | undefined;
    if (mode && mode !== "scene" && mode !== "combat") {
      throw reject("bad_scene_mode", `mode must be "scene" or "combat", got "${mode}".`, { mode }, [
        'Use mode "scene" (out of combat) or "combat".',
      ]);
    }
    if (mode) room.mode = mode;
    if (location !== undefined) (room as any).location = location;
    rooms.put(room);
    ctx.ir.emit("scene", {
      data: { location: (room as any).location, mode: room.mode },
      narration: location ? `Scene: ${location}` : undefined,
    });
  });

  // ping: a no-state round-trip used by smoke checks.
  engine.registerHandler("ping", (ctx) => {
    ctx.ir.emit("pong", { data: { echo: ctx.op.params.echo ?? null } });
  });
}
