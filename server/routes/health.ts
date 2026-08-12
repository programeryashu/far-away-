import type { FastifyInstance } from "fastify";
import { VERSION } from "../version.js";

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/health", async () => {
    let dbStatus: "connected" | "error" = "connected";
    let activeSessions = 0;
    try {
      activeSessions = fastify.store.countActiveSessions();
    } catch {
      dbStatus = "error";
    }

    return {
      ok: true,
      version: VERSION,
      uptime: process.uptime(),
      database: dbStatus,
      activeSessions,
      wsConnections: fastify.sessionHub.activeConnections,
    };

  });
}
