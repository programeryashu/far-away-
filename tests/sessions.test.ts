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

  it("should allow a peer to leave", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
    });
    const { id } = JSON.parse(createRes.payload);

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
    const state = JSON.parse(stateRes.payload);
    expect(state.peers.length).toBe(0);
  });
});
