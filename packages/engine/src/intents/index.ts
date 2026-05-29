import type { Engine } from "../engine.js";
import { registerCoreIntents } from "./core.js";

/**
 * Wire every phase's intent handlers onto the engine. Each phase adds its
 * registrar here; handlers compose behind the same `resolveIntent` seam.
 */
export function registerAllHandlers(engine: Engine): void {
  registerCoreIntents(engine);
}
