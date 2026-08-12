import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../server/app.js";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import fs from "node:fs";

const TEST_DB = "./data/test_ws.db";

describe("WebSocket", () => {
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    process.env.DATABASE_PATH = TEST_DB;
    process.env.PORT = "0";
    app = await buildApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("should reject connection without session", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const closePromise = new Promise((resolve) => ws.on("close", resolve));
    await closePromise;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
