import type { Engine } from "../engine.js";
import { registerCoreIntents } from "./core.js";
import { registerCharacterIntents } from "./character.js";
import { registerCheckIntents } from "./checks.js";
import { registerJutsuIntents } from "./jutsu.js";
import { registerCombatIntents } from "./combat.js";
import { registerMissionIntents } from "./mission.js";
import { registerRestIntents } from "./rest.js";
import { registerEquipmentIntents } from "./equipment.js";

/**
 * Wire every phase's intent handlers onto the engine. Each phase adds its
 * registrar here; handlers compose behind the same `resolveIntent` seam.
 */
export function registerAllHandlers(engine: Engine): void {
  registerCoreIntents(engine); // Phase 0
  registerCharacterIntents(engine); // Phase 1
  registerCheckIntents(engine); // Phase 1 (Ch.6 checks)
  registerJutsuIntents(engine); // Phase 2 (Ch.9 jutsu casting)
  registerCombatIntents(engine); // Phase 2 (Ch.8 combat)
  registerMissionIntents(engine); // Phase 3 (Ch.7 missions + rank-up)
  registerRestIntents(engine); // Phase 3 (Ch.7 rest + downtime)
  registerEquipmentIntents(engine); // Phase 3 (Ch.5 equipment + economy)
}
