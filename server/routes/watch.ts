import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  countryToIso,
  getAvailability,
  getMovie,
  getPopularMovies,
  searchMovies,
  type TmdbConfig,
  type WatchMovie,
} from "../tmdb.js";
import { pickForUs } from "../ai/pick.js";

/**
 * Watch routes — a thin TMDB proxy. The key stays server-side; the client
 * receives only normalized metadata and provider names. Availability is
 * informational (Orbit never streams or hosts titles).
 */

function tmdbConfig(fastify: FastifyInstance): TmdbConfig {
  return {
    apiKey: fastify.config.TMDB_API_KEY,
    baseUrl: fastify.config.TMDB_BASE_URL,
    imageUrl: fastify.config.TMDB_IMAGE_URL,
  };
}

const QuerySchema = z.object({ q: z.string().min(1).max(120) });
const IdSchema = z.object({ id: z.coerce.number().int().positive() });
const AvailabilityQuerySchema = z.object({
  countries: z.string().max(400).optional().default(""),
});
const PickQuerySchema = z.object({
  windowMinutes: z.coerce.number().int().min(1).max(600).optional().default(60),
  countries: z.string().max(400).optional().default(""),
});

function countriesFromQuery(raw: string): string[] {
  return raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 4);
}

export async function watchRoutes(fastify: FastifyInstance): Promise<void> {
  const config = tmdbConfig(fastify);

  fastify.get("/api/watch/search", async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid query" });
    const result = await searchMovies(parsed.data.q, config);
    if (!result.ok) {
      return reply.status(result.reason === "unconfigured" ? 503 : 502).send({ ok: false, reason: result.reason });
    }
    return reply.send({ ok: true, ...result.data });
  });

  fastify.get("/api/watch/:id", async (request, reply) => {
    const parsed = IdSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: "invalid movie id" });
    const result = await getMovie(parsed.data.id, config);
    if (!result.ok) {
      return reply.status(result.reason === "unconfigured" ? 503 : 502).send({ ok: false, reason: result.reason });
    }
    return reply.send({ ok: true, movie: result.data });
  });

  fastify.get("/api/watch/:id/availability", async (request, reply) => {
    const id = IdSchema.safeParse(request.params);
    const q = AvailabilityQuerySchema.safeParse(request.query);
    if (!id.success || !q.success) return reply.status(400).send({ error: "invalid request" });
    const countries = countriesFromQuery(q.data.countries);
    const result = await getAvailability(id.data.id, countries, config);
    if (!result.ok) {
      return reply.status(result.reason === "unconfigured" ? 503 : 502).send({ ok: false, reason: result.reason });
    }
    return reply.send({ ok: true, ...result.data });
  });

  /**
   * "Pick something for us" — deterministic filtering FIRST (runtime must fit
   * the shared window, availability used when known), then an optional AI
   * ranking that may ONLY choose among the validated candidates. Any AI
   * failure falls back to the deterministic pick. The AI can never invent a
   * title, runtime, provider, or availability.
   */
  fastify.get("/api/watch/pick", async (request, reply) => {
    const parsed = PickQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid request" });
    const { windowMinutes } = parsed.data;
    const countries = countriesFromQuery(parsed.data.countries);

    const pool = await getPopularMovies(config);
    if (!pool.ok) {
      return reply.status(pool.reason === "unconfigured" ? 503 : 502).send({ ok: false, reason: pool.reason });
    }

    // Availability is a soft signal: when both regions are known, prefer a
    // candidate available in both, but never drop a candidate without data.
    let availableInBoth = new Set<number>();
    if (countries.length > 0) {
      // Deduped so "both regions" is measured against the distinct regions
      // actually queried (duplicate country names must not block the match).
      const isos = [
        ...new Set(countries.map(countryToIso).filter((x): x is string => x !== null)),
      ];
      const outcome = pickForUs(pool.data, windowMinutes);
      const regions = await Promise.all(
        outcome.candidates.map(async (m) => {
          const r = await getAvailability(m.id, countries, config);
          return { id: m.id, ok: r.ok, regions: r.ok ? r.data.regions : [] };
        }),
      );
      availableInBoth = new Set(
        regions
          .filter((r) => r.ok && r.regions.length > 0 && r.regions.length === isos.length)
          .map((r) => r.id),
      );
    }

    const outcome = pickForUs(pool.data, windowMinutes, availableInBoth);

    // Optional AI ranking among candidates (never invention). Any AI failure
    // (or no AI configured) falls back to the deterministic pick.
    let pick: WatchMovie | null = outcome.pick;
    let pickReason: string = outcome.reason;
    if (fastify.config.AI_PROVIDER !== "none" && fastify.config.AI_API_KEY && outcome.candidates.length > 0) {
      try {
        const chosen = await pickWithAi(outcome.candidates, fastify);
        pick = chosen;
        pickReason = "ai";
      } catch {
        pick = outcome.pick;
        pickReason = outcome.reason;
      }
    }

    return reply.send({
      ok: true,
      windowMinutes,
      movies: outcome.candidates,
      pick,
      pickReason,
    });
  });
}

const PICK_TIMEOUT_MS = 4000;

async function pickWithAi(
  candidates: WatchMovie[],
  fastify: FastifyInstance,
): Promise<WatchMovie> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PICK_TIMEOUT_MS);
  try {
    const list = candidates
      .map((m) => `${m.id}|${m.title} (${m.year ?? "?"}, ${m.runtime}min)`)
      .join("\n");
    const res = await fetch(`${fastify.config.AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fastify.config.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: fastify.config.AI_MODEL,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Pick the best movie for two people watching together from the candidate list. " +
              "Respond with ONLY a JSON object {\"movieId\": <number>}. The id MUST be one of the listed ids. " +
              "Never invent titles, runtimes, providers, or availability.",
          },
          {
            role: "user",
            content: `Candidates:\n${list}\n\nPick one.`,
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`AI status ${res.status}`);
    const body: unknown = await res.json();
    const content =
      typeof body === "object" && body !== null
        ? (body as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content
        : undefined;
    const parsed: unknown = typeof content === "string" ? JSON.parse(content) : undefined;
    const movieId = (parsed as { movieId?: unknown } | undefined)?.movieId;
    if (typeof movieId !== "number") throw new Error("AI did not return a movieId");
    const chosen = candidates.find((m) => m.id === movieId);
    if (!chosen) throw new Error(`AI invented id ${movieId}`);
    return chosen;
  } finally {
    clearTimeout(timer);
  }
}
