import { randomUUID, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

function generateJoinCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

const CreateSessionSchema = z.object({
  expiresIn: z.number().optional().default(3600), // seconds
});

const JoinSessionSchema = z.object({
  displayName: z.string().min(1),
  city: z.record(z.string(), z.any()).optional().default({}),
});

export async function sessionRoutes(fastify: FastifyInstance): Promise<void> {
  const { store } = fastify;

  fastify.post("/api/sessions", async (request, reply) => {
    const { expiresIn } = CreateSessionSchema.parse(request.body || {});
    const id = randomUUID();
    const code = generateJoinCode();
    const expiresAt = Date.now() + expiresIn * 1000;

    store.createSession(id, code, "active", expiresAt);

    return reply.status(201).send({ id, code, expiresAt });
  });

  fastify.get("/api/sessions/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const state = store.getSessionState(id);

    if (!state) {
      return reply.status(404).send({ error: "Session not found" });
    }

    if (state.session.status !== "active") {
      return reply.status(410).send({ error: "Session is no longer active" });
    }

    if (state.session.expires_at < Date.now()) {
      store.expireSession(id);
      return reply.status(410).send({ error: "Session has expired" });
    }

    return state;
  });

  fastify.post("/api/sessions/:id/join", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { displayName, city } = JoinSessionSchema.parse(request.body);

    const session = store.getSession(id);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    if (session.status !== "active") {
      return reply.status(410).send({ error: "Session not active" });
    }

    const peers = store.getPeers(id);
    if (peers.length >= 2) {
      return reply.status(409).send({ error: "Session full" });
    }

    const role = peers.length === 0 ? "a" : "b";
    const peerId = randomUUID();

    store.addPeer(peerId, id, role, displayName, JSON.stringify(city));

    return reply.status(200).send({ peerId, role });
  });

  fastify.post("/api/sessions/:id/leave", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { peerId } = z.object({ peerId: z.string() }).parse(request.body);

    const peer = store.getPeer(peerId);
    if (!peer || peer.session_id !== id) {
      return reply.status(404).send({ error: "Peer not found in this session" });
    }

    store.removePeer(peerId);

    // If no more peers, maybe close session? The instructions don't strictly say to close it automatically on leave, but keep it active.

    return reply.status(200).send({ ok: true });
  });
}
