import { buildServer } from "./api/http.js";
import { createEngine } from "./bootstrap.js";

/**
 * Engine entrypoint (`npm run dev` / `npm start`). Boots the authoritative
 * game server: REST intent seam + scoped reads + the live IR websocket.
 */
async function main(): Promise<void> {
  const { engine, config, driver } = createEngine();
  const server = buildServer(engine);
  const port = await server.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(
    `\n  Naruto 5e engine listening on http://localhost:${port}` +
      `\n  store driver: ${driver}` +
      `\n  jutsu loaded: ${engine.content.jutsu.length}` +
      `\n  actions: ${engine.knownActions().length}` +
      `\n  WS stream: ws://localhost:${port}/v1/rooms/{roomId}/stream\n`,
  );

  const shutdown = async () => {
    await server.close();
    engine.store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("engine failed to start", err);
  process.exit(1);
});
