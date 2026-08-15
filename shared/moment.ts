import { z } from "zod";

/**
 * Shared Moment — the AI-assisted "what should we do together?" contract.
 *
 * Deterministic facts (local times, overlap window, distance) are computed by
 * the client and travel here as a validated context object. The server picks a
 * recommendation — refined by an LLM when configured, otherwise a
 * deterministic rule set — and returns a strictly validated response. The
 * client never trusts raw AI output: this schema is the only thing that may
 * cross the boundary, and an invalid response fails safely to the
 * deterministic fallback.
 *
 * This is a REST contract, not part of the realtime envelope protocol.
 */

export const MOMENT_ACTIVITIES = ["timer", "cinema", "canvas", "chat"] as const;
export type MomentActivity = (typeof MOMENT_ACTIVITIES)[number];

/** The recommended session length stays within a sane, honest range. */
export const MOMENT_MIN_DURATION = 5;
export const MOMENT_MAX_DURATION = 180;

export const MomentParticipantSchema = z.object({
  city: z.string().min(1).max(80),
  timezone: z.string().min(1).max(64),
  /** Human-readable local time, e.g. "8:30 PM". */
  localTime: z.string().min(1).max(32),
  /** Local hour as a fractional value (0..24). */
  hour: z.number().min(0).max(24),
});
export type MomentParticipant = z.infer<typeof MomentParticipantSchema>;

export const MomentWindowSchema = z.object({
  /** A-local window label, e.g. "8:30 PM — 9:15 PM". */
  label: z.string().min(1).max(64),
  /** Window length in minutes (remaining when live, full length when next). */
  minutes: z.number().int().min(0).max(24 * 60),
});
export type MomentWindow = z.infer<typeof MomentWindowSchema>;

/**
 * The AI context. Only facts Orbit already has — no secrets, no raw database
 * rows, no session internals. `availableActivities` constrains the AI to the
 * activities Orbit can actually execute.
 */
export const MomentContextSchema = z.object({
  participantA: MomentParticipantSchema,
  participantB: MomentParticipantSchema,
  /** The live overlap block right now, or the next one, in A-local time. */
  bestWindow: MomentWindowSchema,
  /** True when "now" falls inside the live overlap block. */
  overlapActive: z.boolean(),
  distanceKm: z.number().int().nonnegative(),
  availableActivities: z.array(z.enum([...MOMENT_ACTIVITIES])).min(1),
});
export type MomentContext = z.infer<typeof MomentContextSchema>;

export const MomentRecommendationSchema = z.object({
  activity: z.enum([...MOMENT_ACTIVITIES]),
  durationMinutes: z
    .number()
    .int()
    .min(MOMENT_MIN_DURATION)
    .max(MOMENT_MAX_DURATION),
  title: z.string().min(1).max(80),
  explanation: z.string().min(1).max(240),
});
export type MomentRecommendation = z.infer<typeof MomentRecommendationSchema>;

export const MomentResponseSchema = z.object({
  source: z.enum(["ai", "deterministic"]),
  recommendation: MomentRecommendationSchema,
});
export type MomentResponse = z.infer<typeof MomentResponseSchema>;

/** The AI may only produce one of these shapes, strictly validated. */
export const MomentAiOutputSchema = z.strictObject({
  recommendation: MomentRecommendationSchema,
});
export type MomentAiOutput = z.infer<typeof MomentAiOutputSchema>;

/** Validate a full response (used at the client boundary). */
export function parseMomentResponse(data: unknown): MomentResponse | null {
  const result = MomentResponseSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Format an A-local fractional hour as a 12-hour label, e.g. 20.5 → "8:30 PM",
 * 0 → "12:00 AM". Deterministic and locale-independent.
 */
export function formatHourLabel(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  const h = Math.floor(normalized);
  const m = Math.round((normalized - h) * 60) % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/**
 * Deterministic recommendation — the same rules on both sides of the wire.
 * The server uses these when AI is unavailable or its output is invalid; the
 * client uses them as an instant skeleton and as the offline fallback. The
 * rules are honest to what Orbit can execute: only existing activities, and
 * only "now" actions (a non-live window suggests a message, not a timer that
 * would start at the wrong time).
 */
export function deterministicRecommendation(
  ctx: MomentContext,
): MomentRecommendation {
  if (!ctx.overlapActive) {
    return {
      activity: "chat",
      durationMinutes: 15,
      title: "Bridge the gap",
      explanation:
        "Your live windows do not overlap right now. Open the session with a message the other person can answer when they are free.",
    };
  }
  if (ctx.bestWindow.minutes >= 60 && ctx.distanceKm >= 4000) {
    return {
      activity: "cinema",
      durationMinutes: 45,
      title: "Watch together",
      explanation:
        "A world apart with a solid overlap — share a screen and watch something side by side.",
    };
  }
  if (ctx.bestWindow.minutes >= 60) {
    return {
      activity: "timer",
      durationMinutes: 45,
      title: "Focus together",
      explanation:
        "A comfortable overlap — run a shared focus session, then check in together.",
    };
  }
  if (ctx.bestWindow.minutes >= 30) {
    return {
      activity: "timer",
      durationMinutes: 25,
      title: "Quick focus sprint",
      explanation:
        "Enough time for a focused sprint with a shared countdown.",
    };
  }
  return {
    activity: "chat",
    durationMinutes: 15,
    title: "Catch up now",
    explanation:
      "A short window — keep it light with a quick conversation.",
  };
}
