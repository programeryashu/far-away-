import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/**
 * Cinema (SynchroCinema) event name and payload. The shared state is the
 * play/pause boolean plus the media position (seconds) at the moment the
 * action was taken — the peer applies both, so play, pause, and seek all
 * travel as one event.
 */
export const CINEMA_EVENT = "cinema";

// ---------------------------------------------------------------------------
// Payload limits
// ---------------------------------------------------------------------------
// The same Zod schemas gate frames on BOTH sides (client outbound, server
// inbound), so these caps are the single enforcement point for chat text,
// strokes, identity strings, and every numeric range on the wire. They exist
// to keep a hostile or buggy client from pushing unbounded payloads into the
// server, SQLite, and the peer — normal use never comes near them.

/** Longest chat message accepted (characters). */
export const MAX_CHAT_TEXT_LENGTH = 2_000;
/** Longest display name accepted (characters). */
export const MAX_NAME_LENGTH = 40;
export const MAX_CITY_NAME_LENGTH = 100;
export const MAX_TIMEZONE_LENGTH = 64;
/** Longest client-generated message/stroke reference id accepted. */
export const MAX_ID_LENGTH = 64;
export const MAX_COLOR_LENGTH = 32;
/** Points per canvas stroke before the frame is rejected. */
export const MAX_STROKE_POINTS = 512;
/** Canvas coordinates are CSS pixels; anything beyond this is garbage. */
export const MAX_CANVAS_COORD = 100_000;
/** Cinema media position and timer durations are seconds; cap at 24h. */
export const MAX_MEDIA_SECONDS = 86_400;
/** Wall-clock milliseconds cap (year 2100) for timestamps and deadlines. */
export const MAX_WALL_CLOCK_MS = 4_102_444_800_000;

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

const envelopeFields = {
  version: z.number(),
  sessionId: z.string(),
  peerId: z.string(),
  seq: z.number().int().nonnegative(),
  timestamp: z.number().min(0).max(MAX_WALL_CLOCK_MS),
};

/** Loose structural envelope — accepts any event name and any payload. */
export const BaseEnvelopeSchema = z.object({
  ...envelopeFields,
  event: z.string(),
  payload: z.unknown().optional(),
});

export type BaseEnvelope = z.infer<typeof BaseEnvelopeSchema>;

export function makeEnvelope(
  overrides: Partial<Omit<BaseEnvelope, "version">> &
    Pick<BaseEnvelope, "event">,
): BaseEnvelope {
  return {
    version: PROTOCOL_VERSION,
    sessionId: "",
    peerId: "",
    seq: 0,
    timestamp: Date.now(),
    payload: undefined,
    ...overrides,
  };
}

export function parseEnvelope(data: unknown): BaseEnvelope | null {
  const result = BaseEnvelopeSchema.safeParse(data);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

/**
 * Events that carry no meaningful payload accept either an absent payload
 * (JSON.stringify drops `undefined`, so a frame may have no `payload` key)
 * or an empty object — anything else is rejected. `.optional()` is required
 * because in Zod 4 a missing key on a required field fails even when the
 * field schema itself would accept `undefined`.
 */
const EmptyPayloadSchema = z.strictObject({}).optional();

export const PingPayloadSchema = z.object({
  ts: z.number().min(0).max(MAX_WALL_CLOCK_MS),
});
export type PingPayload = z.infer<typeof PingPayloadSchema>;

export const CinemaPayloadSchema = z.object({
  playing: z.boolean(),
  /** Media position in seconds when the action was taken. */
  position: z.number().min(0).max(MAX_MEDIA_SECONDS),
});
export type CinemaPayload = z.infer<typeof CinemaPayloadSchema>;

export const TimerPayloadSchema = z.object({
  action: z.enum(["start", "pause", "reset"]),
  endAt: z.number().min(0).max(MAX_WALL_CLOCK_MS),
  remaining: z.number().min(0).max(MAX_MEDIA_SECONDS),
});
export type TimerPayload = z.infer<typeof TimerPayloadSchema>;

export const CanvasPointSchema = z.object({
  x: z.number().finite().min(-MAX_CANVAS_COORD).max(MAX_CANVAS_COORD),
  y: z.number().finite().min(-MAX_CANVAS_COORD).max(MAX_CANVAS_COORD),
});

export const StrokePayloadSchema = z.object({
  points: z.array(CanvasPointSchema).max(MAX_STROKE_POINTS),
  color: z.string().min(1).max(MAX_COLOR_LENGTH),
});
export type StrokePayload = z.infer<typeof StrokePayloadSchema>;

export const ChatSendPayloadSchema = z.object({
  /** Client-generated id so the sender can correlate the ack. */
  id: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  sender: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  text: z
    .string()
    .min(1)
    .max(MAX_CHAT_TEXT_LENGTH)
    .refine((t) => t.trim().length > 0, "text must not be blank"),
  timestamp: z.string().max(MAX_ID_LENGTH).optional(),
});
export type ChatSendPayload = z.infer<typeof ChatSendPayloadSchema>;

export const CityPayloadSchema = z.object({
  name: z.string().min(1).max(MAX_CITY_NAME_LENGTH),
  country: z.string().max(MAX_CITY_NAME_LENGTH),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  timezone: z.string().min(1).max(MAX_TIMEZONE_LENGTH),
});
export type CityPayload = z.infer<typeof CityPayloadSchema>;

export const IdentityUpdatePayloadSchema = z.object({
  displayName: z
    .string()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .refine((s) => s.trim().length > 0, "displayName must not be blank"),
  city: CityPayloadSchema,
});
export type IdentityUpdatePayload = z.infer<typeof IdentityUpdatePayloadSchema>;

export const StateRequestPayloadSchema = z.object({
  /**
   * The client's last applied session event seq. 0 = no base state yet (fresh
   * page/join) — the server answers with the full state snapshot. A positive
   * value asks the server to replay every event strictly after it, or fall
   * back to the snapshot when the range is no longer available.
   */
  afterSeq: z.number().int().nonnegative(),
});
export type StateRequestPayload = z.infer<typeof StateRequestPayloadSchema>;

// ---- server → client payloads ----

export const ConnectedPayloadSchema = z.object({
  sessionId: z.string(),
  peerId: z.string(),
  role: z.enum(["a", "b"]),
});
export type ConnectedPayload = z.infer<typeof ConnectedPayloadSchema>;

export const PeerPresencePayloadSchema = z.object({
  peerId: z.string(),
  displayName: z.string().optional(),
  cityJson: z.string().optional(),
});
export type PeerPresencePayload = z.infer<typeof PeerPresencePayloadSchema>;

export const PeerLeftPayloadSchema = z.object({ peerId: z.string() });
export type PeerLeftPayload = z.infer<typeof PeerLeftPayloadSchema>;

export const ErrorPayloadSchema = z.object({ message: z.string() });
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export const ChatBroadcastPayloadSchema = z.object({
  id: z.string(),
  /** Peer that sent the message — distinct from the display name. */
  peerId: z.string(),
  sender: z.string(),
  text: z.string(),
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
});
export type ChatBroadcastPayload = z.infer<typeof ChatBroadcastPayloadSchema>;

export const AckPayloadSchema = z.object({
  refSeq: z.number().int().nonnegative(),
  refId: z.string().optional(),
  id: z.string(),
});
export type AckPayload = z.infer<typeof AckPayloadSchema>;

export const PongPayloadSchema = z.object({ ts: z.number() });
export type PongPayload = z.infer<typeof PongPayloadSchema>;

// ---- session state snapshot (the `state` event payload) ----
// Mirrors the rows produced by server/db/store.ts getSessionState(). The
// schema is the single source of truth for the shape of the `state` envelope.

export const StateSessionSchema = z.object({
  id: z.string(),
  code: z.string(),
  status: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  closed_at: z.number().nullable(),
});
export type StateSession = z.infer<typeof StateSessionSchema>;

export const StatePeerSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  role: z.enum(["a", "b"]),
  display_name: z.string(),
  city_json: z.string(),
  joined_at: z.number(),
  last_seen: z.number(),
});
export type StatePeer = z.infer<typeof StatePeerSchema>;

export const StateMessageSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  sender_peer: z.string(),
  sender_name: z.string(),
  text: z.string(),
  ts: z.number(),
  seq: z.number(),
});
export type StateMessage = z.infer<typeof StateMessageSchema>;

export const StateCanvasSchema = z.object({
  session_id: z.string(),
  strokes_json: z.string(),
  updated_at: z.number(),
});
export type StateCanvas = z.infer<typeof StateCanvasSchema>;

export const StateTimerSchema = z.object({
  session_id: z.string(),
  action: z.enum(["start", "pause", "reset"]),
  end_at: z.number(),
  remaining: z.number(),
  updated_at: z.number(),
});
export type StateTimer = z.infer<typeof StateTimerSchema>;

/**
 * Persisted cinema row. `position` is the media time (seconds) stored with
 * `updated_at`; a joiner that inherits `playing` advances the position by the
 * wall-clock elapsed time since `updated_at` — the same wall-clock anchoring
 * the shared timer uses.
 */
export const StateCinemaSchema = z.object({
  session_id: z.string(),
  playing: z.boolean(),
  position: z.number().min(0).max(MAX_MEDIA_SECONDS),
  updated_at: z.number(),
});
export type StateCinema = z.infer<typeof StateCinemaSchema>;

export const StatePayloadSchema = z.object({
  session: StateSessionSchema,
  peers: z.array(StatePeerSchema),
  messages: z.array(StateMessageSchema),
  canvas: StateCanvasSchema.nullable(),
  timer: StateTimerSchema.nullable(),
  /**
   * Current play/pause of the shared watch. Snapshot-carried so a brand-new
   * joiner (afterSeq 0, who never sees the cinema event in the log) inherits
   * an already-running watch — the event log alone cannot restore it.
   */
  cinema: StateCinemaSchema.nullable(),
  /**
   * The last session event seq incorporated into this snapshot. The client
   * advances its lastAppliedEventSeq to this boundary (never backwards), so a
   * snapshot followed by live events is gap-free and duplicates are ignored.
   */
  snapshotSeq: z.number().int().nonnegative(),
});
export type StatePayload = z.infer<typeof StatePayloadSchema>;

// ---------------------------------------------------------------------------
// Discriminated envelope unions
// ---------------------------------------------------------------------------

export const ClientEnvelopeSchema = z.discriminatedUnion("event", [
  z.object({ ...envelopeFields, event: z.literal("hello"), payload: EmptyPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("chat"), payload: ChatSendPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("canvas-stroke"), payload: StrokePayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("canvas-clear"), payload: EmptyPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("timer"), payload: TimerPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("cinema"), payload: CinemaPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("identity-update"), payload: IdentityUpdatePayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("state-request"), payload: StateRequestPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("ping"), payload: PingPayloadSchema }),
]);
export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;
export type ClientEventName = ClientEnvelope["event"];

export const ServerEnvelopeSchema = z.discriminatedUnion("event", [
  z.object({ ...envelopeFields, event: z.literal("connected"), payload: ConnectedPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("state"), payload: StatePayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("peer-joined"), payload: PeerPresencePayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("peer-left"), payload: PeerLeftPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("peer-updated"), payload: PeerPresencePayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("chat"), payload: ChatBroadcastPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("ack"), payload: AckPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("pong"), payload: PongPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("canvas-stroke"), payload: StrokePayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("canvas-clear"), payload: EmptyPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("timer"), payload: TimerPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("cinema"), payload: CinemaPayloadSchema }),
  z.object({ ...envelopeFields, event: z.literal("error"), payload: ErrorPayloadSchema }),
]);
export type ServerEnvelope = z.infer<typeof ServerEnvelopeSchema>;
export type ServerEventName = ServerEnvelope["event"];

/**
 * Known client→server event names. The server uses this to tell an unknown
 * event (forward compatibility) apart from a known event with a malformed
 * payload, so each gets a useful error message.
 */
export const KNOWN_CLIENT_EVENTS: ReadonlySet<string> = new Set([
  "hello",
  "chat",
  "canvas-stroke",
  "canvas-clear",
  "timer",
  "cinema",
  "identity-update",
  "state-request",
  "ping",
]);

/**
 * Server→client events that participate in the durable per-session event
 * stream. Each carries the server-assigned session event seq in the envelope;
 * the client dedupes, orders, and catches up on exactly these. Presence events
 * (peer-joined / peer-left) are deliberately excluded: presence is socket
 * truth, not replayable domain state.
 */
export const SEQUENCED_SERVER_EVENTS: ReadonlySet<string> = new Set([
  "chat",
  "canvas-stroke",
  "canvas-clear",
  "timer",
  "cinema",
  "peer-updated",
]);

/** Parse and fully validate a client→server frame. Unknown events → null. */
export function parseClientEnvelope(data: unknown): ClientEnvelope | null {
  const result = ClientEnvelopeSchema.safeParse(data);
  return result.success ? result.data : null;
}

/** Parse and fully validate a server→client frame. Unknown events → null. */
export function parseServerEnvelope(data: unknown): ServerEnvelope | null {
  const result = ServerEnvelopeSchema.safeParse(data);
  return result.success ? result.data : null;
}
