import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyEnv from "@fastify/env";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import { makeEnvelope } from "../shared/protocol.js";
import { envSchema, type EnvConfig } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { sessionRoutes } from "./routes/sessions.js";
import { Store } from "./db/store.js";
import { SessionHub } from "./realtime/session-hub.js";

declare module "fastify" {
  interface FastifyInstance {
    config: EnvConfig;
    store: Store;
    sessionHub: SessionHub;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: "invalid request body" });
    }
    return reply.status(500).send({ error: "internal server error" });
  });

  await fastify.register(fastifyEnv, { schema: envSchema });
  fastify.decorate("store", new Store(fastify.config.DATABASE_PATH));
  fastify.decorate("sessionHub", new SessionHub(fastify));

  fastify.addHook("onClose", async (instance) => {
    instance.store.close();
  });

  const origins = fastify.config.ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  await fastify.register(fastifyCors, { origin: origins });

  await fastify.register(fastifyWebsocket);

  await fastify.register(healthRoutes);
  await fastify.register(sessionRoutes);

  fastify.get("/ws", { websocket: true }, (socket, request) => {
    const query = z
      .object({
        sessionId: z.string(),
        peerId: z.string(),
      })
      .safeParse(request.query);
    if (!query.success) {
      socket.close(4000, "invalid session");
      return;
    }
    const { sessionId, peerId } = query.data;

    const session = fastify.store.getSession(sessionId);
    if (!session || session.status !== "active") {
      socket.close(4000, "invalid session");
      return;
    }

    if (session.expires_at < Date.now()) {
      fastify.store.expireSession(sessionId);
      socket.close(4000, "session expired");
      return;
    }

    const peer = fastify.store.getPeer(peerId);
    if (!peer || peer.session_id !== sessionId) {
      socket.close(4000, "invalid peer");
      return;
    }

    fastify.sessionHub.addConnection(sessionId, peerId, socket);

    // The client drives catch-up: it sends `state-request { afterSeq }` on
    // open, and the hub answers with a replay of the missed event range or a
    // full state snapshot. The server no longer pushes state on connect, so a
    // client can never be double-snapshotted and its last applied seq decides
    // what it needs.
    socket.send(
      JSON.stringify(
        makeEnvelope({
          event: "connected",
          sessionId,
          peerId,
          payload: { sessionId, peerId, role: peer.role },
        }),
      ),
    );
  });

  return fastify;
}
