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
      payload: { displayName: "Alice", city: { name: "New York" } },
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
      payload: { displayName: "Alice", city: {} },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Bob", city: {} },
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
      payload: { code, displayName: "Alice", city: { name: "Paris" } },
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
      payload: { code, displayName: "Alice", city: {} },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code, displayName: "Bob", city: {} },
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
      payload: { code: code.toLowerCase(), displayName: "Alice", city: {} },
    });
    expect(lower.statusCode).toBe(200);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/sessions/join-by-code",
      payload: { code: "ZZZZZZ", displayName: "Alice", city: {} },
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
      payload: { code, displayName: "Alice", city: {} },
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
      payload: { displayName: "Alice", city: {} },
    });
    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Bob", city: {} },
    });

    // Both peers are recent (last_seen fresh) — even though neither has a live
    // socket in this test, a recent peer must never be reclaimed.
    const joinRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Charlie", city: {} },
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
          payload: { displayName: "Alice", city: {} },
        })
      ).payload,
    );
    const second = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/sessions/${id}/join`,
          payload: { displayName: "Bob", city: {} },
        })
      ).payload,
    );

    // Bob's device is gone: no live socket and last contact over 60s ago.
    app.store.updatePeerLastSeen(second.peerId, Date.now() - 120_000);

    const joinRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Charlie", city: {} },
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
      payload: { displayName: "Alice", city: {} },
    });
    const { peerId } = JSON.parse(joinRes.payload);

    const leaveRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/leave`,
      payload: { peerId },
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
      payload: { code, displayName: "Bob", city: {} },
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
      payload: { displayName: "Alice", city: {} },
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
      payload: { displayName: "Alice", city: {} },
    });
    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Bob", city: {} },
    });

    const joinRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Charlie", city: {} },
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
      payload: { displayName: "Alice", city: {} },
    });
    const bob = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/sessions/${id}/join`,
          payload: { displayName: "Bob", city: {} },
        })
      ).payload,
    );

    const leaveRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/leave`,
      payload: { peerId: bob.peerId },
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
});
