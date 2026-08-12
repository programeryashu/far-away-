import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyEnv from "@fastify/env";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import { envSchema, type EnvConfig } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { sessionRoutes } from "./routes/sessions.js";
import { parseEnvelope } from "../shared/protocol.js";
import { Store } from "./db/store.js";

declare module "fastify" {
  interface FastifyInstance {
    config: EnvConfig;
    store: Store;
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

  fastify.get("/ws", { websocket: true }, (socket) => {
    const connectionId = randomUUID();
    fastify.log.info({ connectionId }, "websocket client connected");

    socket.on("message", (raw) => {
      const text = raw.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        fastify.log.warn({ connectionId }, "websocket received malformed JSON");
        socket.send(JSON.stringify({ error: "malformed JSON" }));
        return;
      }

      const envelope = parseEnvelope(parsed);
      if (!envelope) {
        fastify.log.warn({ connectionId }, "websocket received invalid envelope");
        socket.send(JSON.stringify({ error: "invalid envelope" }));
        return;
      }

      fastify.log.debug(
        { connectionId, event: envelope.event },
        "websocket received valid envelope",
      );
    });

    socket.on("close", () => {
      fastify.log.info({ connectionId }, "websocket client disconnected");
    });
  });

  return fastify;
}
