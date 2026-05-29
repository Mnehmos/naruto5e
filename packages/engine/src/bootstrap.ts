import { loadConfig, type EngineConfig } from "./config.js";
import { ContentPack } from "./content.js";
import { Engine } from "./engine.js";
import { registerAllHandlers } from "./intents/index.js";
import { createStore } from "./store/index.js";

export interface CreatedEngine {
  engine: Engine;
  config: EngineConfig;
  driver: string;
}

/**
 * Build a fully-wired engine: store driver (sqlite default, memory fallback),
 * content pack, all intent handlers registered. Tests pass `{ dbDriver:
 * "memory" }` for a deterministic, isolated instance.
 */
export function createEngine(overrides: Partial<EngineConfig> = {}): CreatedEngine {
  const config = loadConfig(overrides);
  const { store, driver } = createStore(config);
  const content = ContentPack.load(config.contentDir);
  const engine = new Engine({ store, config, content });
  registerAllHandlers(engine);
  return { engine, config, driver };
}
