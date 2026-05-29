import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { newId, type IREvent } from "@naruto5e/shared";
import type { Engine } from "../engine.js";

/**
 * The engine's HTTP + WebSocket surface (Architecture §2.2):
 *   POST /v1/rooms/:roomId/intent      submit a structured intent (the seam)
 *   GET  /v1/rooms/:roomId/state       scoped room snapshot (hydration)
 *   GET  /v1/rooms/:roomId/encounter   combat state
 *   GET  /v1/characters/:id            character record
 *   GET  /v1/jutsu[?...]               jutsu catalog (read model)
 *   GET  /v1/entities/:coll/:id        generic scoped entity read (§9.4)
 *   WS   /v1/rooms/:roomId/stream      live IR event stream
 */
export interface BuiltServer {
  app: Express;
  httpServer: Server;
  wss: WebSocketServer;
  /** start listening; resolves with the bound port. */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

export function buildServer(engine: Engine): BuiltServer {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/v1/health", (_req, res) => {
    res.json({ ok: true, actions: engine.knownActions().length });
  });

  app.get("/v1/actions", (_req, res) => {
    res.json({ actions: engine.knownActions() });
  });

  // The universal intent seam.
  app.post("/v1/rooms/:roomId/intent", (req, res) => {
    const intent = {
      intentId: req.body?.intentId ?? newId("intent"),
      roomId: req.params.roomId,
      actorId: req.body?.actorId,
      submittedBy: req.body?.submittedBy ?? { clientType: "ui", role: "dm" },
      type: req.body?.type,
      params: req.body?.params ?? {},
      cost: req.body?.cost,
      clientTime: req.body?.clientTime,
    };
    try {
      const result = engine.resolveIntent(intent as any);
      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ status: "rejected", reason: { rule: "malformed_intent", explain: err.message }, suggestions: ["Fix the intent envelope and resubmit."] });
        return;
      }
      // eslint-disable-next-line no-console
      console.error("[intent] unexpected error", err);
      res.status(500).json({ status: "error", message: (err as Error).message });
    }
  });

  app.get("/v1/rooms/:roomId/state", (req, res) => {
    res.json(engine.getRoomState(req.params.roomId));
  });

  app.get("/v1/rooms/:roomId/encounter", (req, res) => {
    const room = engine.getRoom(req.params.roomId);
    const enc = room?.encounterId ? engine.getEntity("encounters", room.encounterId) : undefined;
    res.json({ encounter: enc ?? null });
  });

  // Convenience: create/build a character (wraps a character_create intent, §2.2).
  app.post("/v1/characters", (req, res) => {
    const roomId = req.body?.roomId;
    if (!roomId) {
      res.status(400).json({ status: "rejected", reason: { rule: "room_required", explain: "POST /v1/characters requires body.roomId." } });
      return;
    }
    const result = engine.resolveIntent({
      intentId: newId("intent"),
      roomId,
      submittedBy: req.body?.submittedBy ?? { clientType: "ui", role: "dm" },
      type: "character_create",
      params: req.body ?? {},
    } as any);
    res.json(result);
  });

  app.get("/v1/characters/:id", (req, res) => {
    const c = engine.getEntity("characters", req.params.id);
    if (!c) {
      res.status(404).json({ status: "rejected", reason: { rule: "entity_not_found", explain: `No character "${req.params.id}".` } });
      return;
    }
    res.json(c);
  });

  app.get("/v1/jutsu", (req, res) => {
    const { rank, classification, q } = req.query as Record<string, string>;
    let list = engine.content.jutsu;
    if (rank) list = list.filter((j) => j.rank === rank.toUpperCase());
    if (classification) list = list.filter((j) => j.classification.toLowerCase() === classification.toLowerCase());
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((j) => (j.name ?? "").toLowerCase().includes(needle));
    }
    res.json({ count: list.length, jutsu: list.slice(0, 500) });
  });

  app.get("/v1/jutsu/:id", (req, res) => {
    const j = engine.content.getJutsu(req.params.id);
    if (!j) {
      res.status(404).json({ status: "rejected", reason: { rule: "entity_not_found", explain: `No jutsu "${req.params.id}".` } });
      return;
    }
    res.json(j);
  });

  // Content reads (clan/class/background rosters, for build planning).
  app.get("/v1/content/clans", (_req, res) => res.json({ clans: engine.content.clans }));
  app.get("/v1/content/classes", (_req, res) => res.json({ classes: engine.content.classes }));
  app.get("/v1/content/backgrounds", (_req, res) => res.json({ backgrounds: engine.content.backgrounds }));

  // Generic scoped entity read (§9.4 — each read is a bounded request).
  app.get("/v1/entities/:coll/:id", (req, res) => {
    const e = engine.getEntity(req.params.coll, req.params.id);
    if (!e) {
      res.status(404).json({ status: "rejected", reason: { rule: "entity_not_found", explain: `No ${req.params.coll} "${req.params.id}".` } });
      return;
    }
    res.json(e);
  });

  const httpServer = createServer(app);

  // ---- websocket IR stream ---------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  // roomId -> set of sockets
  const subscriptions = new Map<string, Set<WebSocket>>();

  const unsubscribeIR = engine.onIR(({ roomId, events }) => {
    const subs = subscriptions.get(roomId);
    if (!subs || subs.size === 0) return;
    const payload = JSON.stringify({ type: "ir", roomId, events });
    for (const ws of subs) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const m = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/stream$/);
    if (!m) {
      socket.destroy();
      return;
    }
    const roomId = decodeURIComponent(m[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = subscriptions.get(roomId);
      if (!set) {
        set = new Set();
        subscriptions.set(roomId, set);
      }
      set.add(ws);
      ws.send(JSON.stringify({ type: "subscribed", roomId }));
      ws.on("close", () => set!.delete(ws));
    });
  });

  return {
    app,
    httpServer,
    wss,
    listen: (port: number) =>
      new Promise<number>((resolve) => {
        httpServer.listen(port, () => {
          const addr = httpServer.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        unsubscribeIR();
        for (const set of subscriptions.values()) for (const ws of set) ws.close();
        wss.close();
        httpServer.close(() => resolve());
      }),
  };
}

export type { IREvent };
