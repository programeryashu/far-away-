import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../server/app.js";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import {
  recommendSharedMoment,
  type MomentAiConfig,
  type MomentFetch,
} from "../server/ai/shared-moment.js";
import {
  MomentResponseSchema,
  type MomentContext,
} from "../shared/moment.js";

const TEST_DB = "./data/test_moment.db";

/** A far-apart, live-overlap context (SF ↔ Tokyo) that maps to cinema. */
const ctx: MomentContext = {
  participantA: {
    city: "San Francisco",
    timezone: "America/Los_Angeles",
    localTime: "6:00 PM",
    hour: 18,
  },
  participantB: {
    city: "Tokyo",
    timezone: "Asia/Tokyo",
    localTime: "10:00 AM",
    hour: 10,
  },
  bestWindow: { label: "3:00 PM — 11:00 PM", minutes: 300 },
  overlapActive: true,
  distanceKm: 8267,
  availableActivities: ["timer", "cinema", "canvas", "chat"],
};

const aiConfig: MomentAiConfig = {
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "sk-test",
  baseUrl: "https://api.openai.com/v1",
};

function fetchWith(body: unknown, ok = true): MomentFetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
}

function aiBody(content: string) {
  return { choices: [{ message: { content } }] };
}

describe("Shared Moment service", () => {
  it("returns the deterministic recommendation when no AI is configured", async () => {
    const fetchSpy = vi.fn<MomentFetch>();
    const res = await recommendSharedMoment(ctx, { ...aiConfig, apiKey: "" }, fetchSpy);
    expect(res.source).toBe("deterministic");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(MomentResponseSchema.safeParse(res).success).toBe(true);
  });

  it("uses a strictly validated AI response when the provider answers", async () => {
    const content = JSON.stringify({
      recommendation: {
        activity: "cinema",
        durationMinutes: 45,
        title: "Watch together",
        explanation: "A world apart — watch side by side.",
      },
    });
    const res = await recommendSharedMoment(
      ctx,
      aiConfig,
      fetchWith(aiBody(content)),
    );
    expect(res.source).toBe("ai");
    expect(res.recommendation.activity).toBe("cinema");
    expect(MomentResponseSchema.safeParse(res).success).toBe(true);
  });

  it("falls back to deterministic on malformed AI output", async () => {
    const res = await recommendSharedMoment(ctx, aiConfig, fetchWith(aiBody("not json at all")));
    expect(res.source).toBe("deterministic");
  });

  it("falls back to deterministic when AI output is structurally invalid", async () => {
    const content = JSON.stringify({ recommendation: { activity: "cinema" } }); // missing fields
    const res = await recommendSharedMoment(ctx, aiConfig, fetchWith(aiBody(content)));
    expect(res.source).toBe("deterministic");
  });

  it("falls back when the AI suggests an unavailable activity", async () => {
    const content = JSON.stringify({
      recommendation: {
        activity: "dance",
        durationMinutes: 45,
        title: "x",
        explanation: "y",
      },
    });
    const res = await recommendSharedMoment(ctx, aiConfig, fetchWith(aiBody(content)));
    expect(res.source).toBe("deterministic");
  });

  it("falls back when the AI suggests an activity outside the allowed set", async () => {
    const limited: MomentContext = {
      ...ctx,
      availableActivities: ["chat"],
    };
    const content = JSON.stringify({
      recommendation: {
        activity: "timer",
        durationMinutes: 45,
        title: "x",
        explanation: "y",
      },
    });
    const res = await recommendSharedMoment(limited, aiConfig, fetchWith(aiBody(content)));
    expect(res.source).toBe("deterministic");
  });

  it("falls back when the AI suggests an out-of-range duration", async () => {
    const content = JSON.stringify({
      recommendation: {
        activity: "cinema",
        durationMinutes: 999,
        title: "x",
        explanation: "y",
      },
    });
    const res = await recommendSharedMoment(ctx, aiConfig, fetchWith(aiBody(content)));
    expect(res.source).toBe("deterministic");
  });

  it("falls back on a provider error", async () => {
    const res = await recommendSharedMoment(ctx, aiConfig, fetchWith({}, false));
    expect(res.source).toBe("deterministic");
    expect(res.recommendation.activity).toBe("cinema");
  });
});

describe("Shared Moment route", () => {
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

  it("returns a schema-valid deterministic recommendation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/shared-moment/recommend",
      payload: ctx,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(MomentResponseSchema.safeParse(body).success).toBe(true);
    expect(body.source).toBe("deterministic");
    expect(body.recommendation.activity).toBe("cinema");
    expect(body.recommendation.durationMinutes).toBe(45);
  });

  it("rejects a malformed context with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/shared-moment/recommend",
      payload: { participantA: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe("invalid request body");
  });

  it("requires sessionId and peerId together", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/shared-moment/recommend",
      payload: { ...ctx, sessionId: "s1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a peer that does not belong to the session", async () => {
    const create = await app.inject({ method: "POST", url: "/api/sessions" });
    const { id } = JSON.parse(create.payload) as { id: string };
    const res = await app.inject({
      method: "POST",
      url: "/api/shared-moment/recommend",
      payload: { ...ctx, sessionId: id, peerId: "not-a-peer" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("accepts a peer that belongs to the session (ownership passes)", async () => {
    const create = await app.inject({ method: "POST", url: "/api/sessions" });
    const { id } = JSON.parse(create.payload) as { id: string };
    const join = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice" },
    });
    const { peerId } = JSON.parse(join.payload) as { peerId: string };
    const res = await app.inject({
      method: "POST",
      url: "/api/shared-moment/recommend",
      payload: { ...ctx, sessionId: id, peerId },
    });
    expect(res.statusCode).toBe(200);
    expect(MomentResponseSchema.safeParse(JSON.parse(res.payload)).success).toBe(true);
  });
});
