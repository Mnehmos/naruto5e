import type { Engine } from "../engine.js";
import { registerCoreIntents } from "./core.js";
import { registerCharacterIntents } from "./character.js";
import { registerCheckIntents } from "./checks.js";

/**
 * Wire every phase's intent handlers onto the engine. Each phase adds its
 * registrar here; handlers compose behind the same `resolveIntent` seam.
 */
export function registerAllHandlers(engine: Engine): void {
  registerCoreIntents(engine); // Phase 0
  registerCharacterIntents(engine); // Phase 1
  registerCheckIntents(engine); // Phase 1 (Ch.6 checks)
}
