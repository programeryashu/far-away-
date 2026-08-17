import { randomUUID, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CityPayloadSchema } from "../../shared/protocol.js";
import { hashPeerToken, issuePeerToken, peerTokenMatches } from "../security/peer-token.js";

// Human-friendly but unambiguous: no I/O/0/1. Six characters from a 32-char
// alphabet = 30 bits of entropy (~1.07B codes) — a large step up from the old
// 24-bit hex, while staying just as easy to read out and type.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function generateJoinCode(): string {
  const bytes = randomBytes(CODE_LENGTH * 2);
  let code = "";
  for (const byte of bytes) {
    if (code.length === CODE_LENGTH) break;
    // Rejection sampling keeps the uniform distribution of randomBytes.
    if (byte < 256 - (256 % CODE_ALPHABET.length)) {
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return code.length === CODE_LENGTH ? code : generateJoinCode();
}

// A peer seat is reclaimable when its socket is gone AND its last contact is
// older than this. The client backs off up to ~34s before giving up on a
// reconnect, so 60s of silence means the device is genuinely gone — the seat
// must not stay locked forever.
const STALE_PEER_MS = 60_000;

const CreateSessionSchema = z.object({
  expiresIn: z.number().optional().default(3600), // seconds
});

const JoinSessionSchema = z.object({
  displayName: z.string().min(1).max(40),
  city: CityPayloadSchema.optional(),
});

const JoinByCodeSchema = JoinSessionSchema.extend({
  code: z.string().min(4).max(8),
});

type JoinInput = z.infer<typeof JoinSessionSchema>;

type JoinResult =
  | { ok: true; peerId: string; role: "a" | "b"; token: string }
  | { ok: false; status: 404 | 409 | 410; error: string };

/**
 * Shared join logic for both the UUID route and the code route: session
 * existence/activity/expiry checks, two-peer cap with stale-seat reclaim, and
 * server-authoritative A/B role assignment. The role is always derived from
 * existing peers — a client can never choose its own. The returned token is
 * the joining peer's session-scoped secret (the server persists only its
 * hash); it authorizes that peer's WebSocket and leave requests.
 */
function joinPeer(
  fastify: FastifyInstance,
  sessionId: string,
  { displayName, city }: JoinInput,
): JoinResult {
  const session = fastify.store.getSession(sessionId);
  if (!session) {
    return { ok: false, status: 404, error: "Session not found" };
  }
  if (session.status !== "active") {
    return { ok: false, status: 410, error: "Session not active" };
  }
  if (session.expires_at < Date.now()) {
    fastify.store.expireSession(sessionId);
    return { ok: false, status: 410, error: "Session has expired" };
  }

  let role: "a" | "b";
  const peers = fastify.store.getPeers(sessionId);
  if (peers.length >= 2) {
    // No permanent seat lockout: a peer whose socket is gone and whose last
    // contact predates the reconnect window is dead weight — reclaim its seat
    // (and its role) for the new joiner. Live peers are never touched, and a
    // peer that merely reconnected recently is never reclaimed.
    const reclaimable = peers
      .filter(
        (peer) =>
          !fastify.sessionHub.isPeerOnline(peer.id) &&
          peer.last_seen < Date.now() - STALE_PEER_MS,
      )
      .sort((a, b) => a.last_seen - b.last_seen);
    const stale = reclaimable[0];
    if (!stale) {
      return { ok: false, status: 409, error: "Session full" };
    }
    fastify.store.removePeer(stale.id);
    fastify.sessionHub.kickPeer(stale.id);
    role = stale.role;
  } else {
    role = peers.length === 0 ? "a" : "b";
  }

  const peerId = randomUUID();
  const token = issuePeerToken();
  fastify.store.addPeer(peerId, sessionId, role, displayName, JSON.stringify(city ?? {}), hashPeerToken(token));
  return { ok: true, peerId, role, token };
}

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
    const input = JoinSessionSchema.parse(request.body);
    const result = joinPeer(fastify, id, input);
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }
    return reply.status(200).send({ peerId: result.peerId, role: result.role, token: result.token });
  });

  // Human-friendly join: the 6-char session code instead of the UUID. The code
  // and the UUID stay conceptually separate — the code is what gets shared,
  // the UUID is the internal session identity.
  //
  // The code is typeable, so failed attempts are rate limited per IP: a lock
  // window after repeated failures makes continuous guessing impractical
  // without ever inconveniencing a legitimate user (successes don't count,
  // and a success clears the counter).
  fastify.post("/api/sessions/join-by-code", async (request, reply) => {
    const { code, ...input } = JoinByCodeSchema.parse(request.body);

    const key = `join:${request.ip}`;
    const gate = fastify.joinLimiter.check(key);
    if (gate.blocked) {
      return reply
        .status(429)
        .header("Retry-After", String(gate.retryAfterSec))
        .send({ error: "Too many attempts — try again in a moment.", retryAfterSec: gate.retryAfterSec });
    }

    const session = store.getSessionByCode(code.toUpperCase());
    if (!session) {
      fastify.joinLimiter.recordFailure(key);
      return reply.status(404).send({ error: "Session not found" });
    }
    const result = joinPeer(fastify, session.id, input);
    if (!result.ok && (result.status === 404 || result.status === 410)) {
      fastify.joinLimiter.recordFailure(key);
    }
    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }
    fastify.joinLimiter.recordSuccess(key);
    return reply
      .status(200)
      .send({ sessionId: session.id, peerId: result.peerId, role: result.role, token: result.token });
  });

  fastify.post("/api/sessions/:id/leave", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { peerId, token } = z
      .object({ peerId: z.string(), token: z.string().optional() })
      .parse(request.body);

    const peer = store.getPeer(peerId);
    if (!peer || peer.session_id !== id) {
      return reply.status(404).send({ error: "Peer not found in this session" });
    }

    // Only the peer that holds the token may leave as that peer: knowing a
    // peerId must never be enough to kick someone out of a session.
    if (!peerTokenMatches(token, peer.token_hash)) {
      return reply.status(403).send({ error: "Not authorized to leave as this peer" });
    }

    store.removePeer(peerId);
    // Close the leaving peer's sockets so the other side sees peer-left right
    // away instead of waiting for the client to tear down its socket.
    fastify.sessionHub.kickPeer(peerId);

    // When the last peer leaves, the session has served its purpose: close it
    // (and drop its event log) so it can never be revived into a half-state.
    if (store.getPeers(id).length === 0) {
      store.closeSession(id);
    }

    return reply.status(200).send({ ok: true });
  });
}
