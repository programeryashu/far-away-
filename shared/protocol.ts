import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/**
 * Cinema (SynchroCinema) event name and payload. The feature's only state is
 * a play/pause boolean — there is no seek/position control in the current
 * implementation, so nothing else is part of the payload.
 */
export const CINEMA_EVENT = "cinema";

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

const envelopeFields = {
  version: z.number(),
  sessionId: z.string(),
  peerId: z.string(),
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
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

export const PingPayloadSchema = z.object({ ts: z.number() });
export type PingPayload = z.infer<typeof PingPayloadSchema>;

export const CinemaPayloadSchema = z.object({ playing: z.boolean() });
export type CinemaPayload = z.infer<typeof CinemaPayloadSchema>;

export const TimerPayloadSchema = z.object({
  action: z.enum(["start", "pause", "reset"]),
  endAt: z.number(),
  remaining: z.number(),
});
export type TimerPayload = z.infer<typeof TimerPayloadSchema>;

export const CanvasPointSchema = z.object({ x: z.number(), y: z.number() });

export const StrokePayloadSchema = z.object({
  points: z.array(CanvasPointSchema),
  color: z.string(),
});
export type StrokePayload = z.infer<typeof StrokePayloadSchema>;

export const ChatSendPayloadSchema = z.object({
  /** Client-generated id so the sender can correlate the ack. */
  id: z.string().optional(),
  sender: z.string().optional(),
  text: z
    .string()
    .min(1)
    .refine((t) => t.trim().length > 0, "text must not be blank"),
  timestamp: z.string().optional(),
});
export type ChatSendPayload = z.infer<typeof ChatSendPayloadSchema>;

export const CityPayloadSchema = z.object({
  name: z.string(),
  country: z.string(),
  lat: z.number().finite(),
  lng: z.number().finite(),
  timezone: z.string(),
});
export type CityPayload = z.infer<typeof CityPayloadSchema>;

export const IdentityUpdatePayloadSchema = z.object({
  displayName: z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, "displayName must not be blank"),
  city: CityPayloadSchema,
});
export type IdentityUpdatePayload = z.infer<typeof IdentityUpdatePayloadSchema>;

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

export const StatePayloadSchema = z.object({
  session: StateSessionSchema,
  peers: z.array(StatePeerSchema),
  messages: z.array(StateMessageSchema),
  canvas: StateCanvasSchema.nullable(),
  timer: StateTimerSchema.nullable(),
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
  z.object({ ...envelopeFields, event: z.literal("state-request"), payload: EmptyPayloadSchema }),
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
