import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../server/app.js";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";

const TEST_DB = "./data/test_api.db";

describe("Session API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    process.env.DATABASE_PATH = TEST_DB;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("should create a session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.id).toBeDefined();
    expect(body.code).toBeDefined();
  });

  it("should join a session", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id } = JSON.parse(createRes.payload);

    const joinRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice" },
    });
    expect(joinRes.statusCode).toBe(200);
    const joinBody = JSON.parse(joinRes.payload);
    expect(joinBody.role).toBe("a");
  });

  it("should assign role b to the second peer", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id } = JSON.parse(createRes.payload);

    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Bob" },
    });
    expect(JSON.parse(first.payload).role).toBe("a");
    expect(JSON.parse(second.payload).role).toBe("b");
  });

  it("should join by human-friendly session code", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id, code } = JSON.parse(createRes.payload);

    const joinRes = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code, displayName: "Alice" },
    });
    expect(joinRes.statusCode).toBe(200);
    const body = JSON.parse(joinRes.payload);
    expect(body.sessionId).toBe(id);
    expect(body.role).toBe("a");
  });

  it("should assign role b to a second code joiner", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id, code } = JSON.parse(createRes.payload);

    const first = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code, displayName: "Alice" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code, displayName: "Bob" },
    });
    expect(JSON.parse(first.payload).role).toBe("a");
    expect(JSON.parse(second.payload).role).toBe("b");
    expect(JSON.parse(second.payload).sessionId).toBe(id);
  });

  it("should normalize code case and reject an unknown code with 404", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { code } = JSON.parse(createRes.payload);

    const lower = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code: code.toLowerCase(), displayName: "Alice" },
    });
    expect(lower.statusCode).toBe(200);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code: "ZZZZZZ", displayName: "Alice" },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("should reject a code join to an expired session with 410", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { expiresIn: 0 },
    });
    const { code } = JSON.parse(createRes.payload);

    const joinRes = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code, displayName: "Alice" },
    });
    expect(joinRes.statusCode).toBe(410);
  });

  it("should keep a fresh seat and reject a third peer with 409", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id } = JSON.parse(createRes.payload);

    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice" },
    });
    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Bob" },
    });

    // Both peers are recent (last_seen fresh) — even though neither has a live
    // socket in this test, a recent peer must never be reclaimed.
    const joinRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Charlie" },
    });
    expect(joinRes.statusCode).toBe(409);
  });

  it("should reclaim a stale peer's seat and keep its role", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id } = JSON.parse(createRes.payload);

    const first = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/sessions/${id}/join`,
          payload: { displayName: "Alice" },
        })
      ).payload,
    );
    const second = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/sessions/${id}/join`,
          payload: { displayName: "Bob" },
        })
      ).payload,
    );

    // Bob's device is gone: no live socket and last contact over 60s ago.
    app.store.updatePeerLastSeen(second.peerId, Date.now() - 120_000);

    const joinRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Charlie" },
    });
    expect(joinRes.statusCode).toBe(200);
    const body = JSON.parse(joinRes.payload);
    // The newcomer takes over Bob's seat — and Bob's role.
    expect(body.role).toBe("b");
    expect(body.peerId).not.toBe(second.peerId);

    const state = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/sessions/${id}`,
        })
      ).payload,
    );
    expect(state.peers.map((p: { role: string }) => p.role).sort()).toEqual(["a", "b"]);
    expect(state.peers.some((p: { id: string }) => p.id === second.peerId)).toBe(false);
    expect(state.peers.some((p: { id: string }) => p.id === first.peerId)).toBe(true);
  });

  it("should close the session when the last peer leaves", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id, code } = JSON.parse(createRes.payload);

    const joinRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice" },
    });
    const { peerId, token } = JSON.parse(joinRes.payload);

    const leaveRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/leave`,
      payload: { peerId, token },
    });
    expect(leaveRes.statusCode).toBe(200);

    const stateRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${id}`,
    });
    expect(stateRes.statusCode).toBe(410);

    // A closed session must not accept new joins — not even by code.
    const codeJoin = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code, displayName: "Bob" },
    });
    expect(codeJoin.statusCode).toBe(410);
  });

  it("should reject join to an expired session with 410", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { expiresIn: 0 },
    });
    const { id } = JSON.parse(createRes.payload);

    const joinRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice" },
    });
    expect(joinRes.statusCode).toBe(410);
    expect(JSON.parse(joinRes.payload).error).toBe("Session has expired");
  });

  it("should reject 3rd peer", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id } = JSON.parse(createRes.payload);

    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice" },
    });
    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Bob" },
    });

    const joinRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Charlie" },
    });
    expect(joinRes.statusCode).toBe(409);
  });

  it("should reject leave without peerId", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id } = JSON.parse(createRes.payload);

    const leaveRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/leave`,
      payload: {},
    });
    expect(leaveRes.statusCode).toBe(400);
  });

  it("should allow a peer to leave and keep the session active for the other", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id } = JSON.parse(createRes.payload);

    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice" },
    });
    const bob = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/sessions/${id}/join`,
          payload: { displayName: "Bob" },
        })
      ).payload,
    );

    const leaveRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/leave`,
      payload: { peerId: bob.peerId, token: bob.token },
    });
    expect(leaveRes.statusCode).toBe(200);

    // Bob leaves; Alice remains, so the session stays active.
    const stateRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${id}`,
    });
    expect(stateRes.statusCode).toBe(200);
    const state = JSON.parse(stateRes.payload);
    expect(state.peers.length).toBe(1);
    expect(state.peers[0].role).toBe("a");
  });

  it("issues a session-scoped token at join and never leaks it in state reads", async () => {
    const createRes = await app.inject({ method: "POST", url: "/api/sessions" });
    const { id } = JSON.parse(createRes.payload);

    const joinRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice" },
    });
    const body = JSON.parse(joinRes.payload);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThanOrEqual(24);

    const stateRes = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
    expect(stateRes.payload).not.toContain(body.token);
  });

  it("rejects a leave with the wrong token — a leaked peerId cannot kick a peer", async () => {
    const createRes = await app.inject({ method: "POST", url: "/api/sessions" });
    const { id } = JSON.parse(createRes.payload);

    const alice = JSON.parse(
      (
        await app.inject({ method: "POST", url: `/api/sessions/${id}/join`, payload: { displayName: "Alice" } })
      ).payload,
    );

    const forged = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/leave`,
      payload: { peerId: alice.peerId, token: "not-the-token" },
    });
    expect(forged.statusCode).toBe(403);

    // Alice survived: the leave was refused and she is still a member.
    const stateRes = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
    expect(stateRes.statusCode).toBe(200);
    expect(JSON.parse(stateRes.payload).peers.length).toBe(1);

    const noToken = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/leave`,
      payload: { peerId: alice.peerId },
    });
    expect(noToken.statusCode).toBe(403);
  });

  it("generates 6-char codes from the unambiguous alphabet with high entropy", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const createRes = await app.inject({ method: "POST", url: "/api/sessions" });
      const { code } = JSON.parse(createRes.payload);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
      seen.add(code);
    }
    // 30 draws from ~1.07B codes must not collide (and each is random).
    expect(seen.size).toBe(30);
  });

  it("rate-limits repeated failed code joins with 429 and Retry-After", async () => {
    // 5 failures lock the IP for the window.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/join-by-code",
        payload: { code: "ZZZZZZ", displayName: "Alice" },
      });
      expect(res.statusCode).toBe(404);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code: "ZZZZZZ", displayName: "Alice" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    // Even a VALID code is refused while locked — the lock is on attempts,
    // not on the specific code being guessed.
    const createRes = await app.inject({ method: "POST", url: "/api/sessions" });
    const { code } = JSON.parse(createRes.payload);
    const validButBlocked = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code, displayName: "Alice" },
    });
    expect(validButBlocked.statusCode).toBe(429);
  });

  it("does not count successful code joins toward the rate limit", async () => {
    for (let i = 0; i < 8; i++) {
      const createRes = await app.inject({ method: "POST", url: "/api/sessions" });
      const { code } = JSON.parse(createRes.payload);
      const join = await app.inject({
        method: "POST",
        url: "/api/sessions/join-by-code",
        payload: { code, displayName: "Alice" },
      });
      expect(join.statusCode).toBe(200);
    }
  });
});
