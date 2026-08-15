import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MomentContextSchema } from "../../shared/moment.js";
import { recommendSharedMoment } from "../ai/shared-moment.js";

/**
 * POST /api/shared-moment/recommend
 *
 * Body: a validated MomentContext, plus optional sessionId/peerId. When a
 * session is named, the peer must genuinely belong to it (ownership check)
 * — the endpoint stays usable in local mode where there is no session.
 *
 * The response is always a schema-valid MomentResponse: `source` tells the
 * client whether an AI refined it or the deterministic rules picked it.
 */
export async function sharedMomentRoutes(fastify: FastifyInstance): Promise<void> {
  // The request body may carry sessionId/peerId alongside the context.
  const RequestSchema = MomentContextSchema.extend({
    sessionId: z.string().optional(),
    peerId: z.string().optional(),
  });

  fastify.post("/api/shared-moment/recommend", async (request, reply) => {
    const parsed = RequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request body" });
    }
    const { sessionId, peerId, ...context } = parsed.data;

    if (sessionId || peerId) {
      if (!sessionId || !peerId) {
        return reply.status(400).send({ error: "sessionId and peerId must be provided together" });
      }
      const session = fastify.store.getSession(sessionId);
      if (!session || session.status !== "active") {
        return reply.status(410).send({ error: "Session is no longer active" });
      }
      const peer = fastify.store.getPeer(peerId);
      if (!peer || peer.session_id !== sessionId) {
        return reply.status(404).send({ error: "Peer not found in this session" });
      }
    }

    const config = {
      provider: fastify.config.AI_PROVIDER,
      model: fastify.config.AI_MODEL,
      apiKey: fastify.config.AI_API_KEY,
      baseUrl: fastify.config.AI_BASE_URL,
    };

    return recommendSharedMoment(context, config);
  });
}
