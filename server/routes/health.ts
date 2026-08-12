import type { FastifyInstance } from "fastify";
import { VERSION } from "../version.js";

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/health", async () => {
    return {
      ok: true,
      version: VERSION,
      uptime: process.uptime(),
    };
  });
}
