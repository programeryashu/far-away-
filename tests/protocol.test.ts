import { describe, it, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  BaseEnvelopeSchema,
  KNOWN_CLIENT_EVENTS,
  SEQUENCED_SERVER_EVENTS,
  makeEnvelope,
  parseClientEnvelope,
  parseEnvelope,
  parseServerEnvelope,
} from "../shared/protocol.js";

/** Build a wire-style frame. Undefined payload = the key is absent (as JSON.stringify would drop it). */
function frame(event: string, payload?: unknown): Record<string, unknown> {
  const f: Record<string, unknown> = {
    version: PROTOCOL_VERSION,
    sessionId: "s1",
    peerId: "p1",
    seq: 0,
    timestamp: 1_700_000_000_000,
    event,
  };
  if (payload !== undefined) f.payload = payload;
  return f;
}

const validCity = {
  name: "Paris",
  country: "France",
  lat: 48.8566,
  lng: 2.3522,
  timezone: "Europe/Paris",
};

const validStatePayload = {
  session: {
    id: "s1",
    code: "ABC123",
    status: "active",
    created_at: 1,
    expires_at: 9999,
    closed_at: null,
  },
  peers: [
    {
      id: "p1",
      session_id: "s1",
      role: "a",
      display_name: "Alice",
      city_json: "{}",
      joined_at: 1,
      last_seen: 1,
    },
  ],
  messages: [
    {
      id: "m1",
      session_id: "s1",
      sender_peer: "p1",
      sender_name: "Alice",
      text: "hi",
      ts: 1,
      seq: 1,
    },
  ],
  canvas: { session_id: "s1", strokes_json: "[]", updated_at: 1 },
  timer: { session_id: "s1", action: "start", end_at: 100, remaining: 0, updated_at: 1 },
  cinema: { session_id: "s1", playing: true, updated_at: 1 },
  snapshotSeq: 0,
};

describe("BaseEnvelopeSchema", () => {
  it("accepts a valid envelope", () => {
    const result = BaseEnvelopeSchema.safeParse({
      version: PROTOCOL_VERSION,
      sessionId: "session-1",
      peerId: "user-a",
      seq: 0,
      timestamp: 1_700_000_000_000,
      event: "ping",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid version", () => {
    const result = BaseEnvelopeSchema.safeParse({
      version: "1",
      sessionId: "session-1",
      peerId: "user-a",
      seq: 0,
      timestamp: 1_700_000_000_000,
      event: "ping",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative sequence", () => {
    const result = BaseEnvelopeSchema.safeParse({
      version: PROTOCOL_VERSION,
      sessionId: "session-1",
      peerId: "user-a",
      seq: -1,
      timestamp: 1_700_000_000_000,
      event: "ping",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed envelope", () => {
    const result = BaseEnvelopeSchema.safeParse({ hello: "world" });
    expect(result.success).toBe(false);
  });

  it("accepts an unknown future event type", () => {
    const result = BaseEnvelopeSchema.safeParse(frame("feature.future.v99", {}));
    expect(result.success).toBe(true);
  });
});

describe("makeEnvelope", () => {
  it("applies default values", () => {
    const envelope = makeEnvelope({ event: "ping" });
    expect(envelope.version).toBe(PROTOCOL_VERSION);
    expect(envelope.sessionId).toBe("");
    expect(envelope.peerId).toBe("");
    expect(envelope.seq).toBe(0);
    expect(typeof envelope.timestamp).toBe("number");
    expect(envelope.event).toBe("ping");
  });

  it("allows overrides", () => {
    const envelope = makeEnvelope({
      event: "chat",
      sessionId: "session-1",
      peerId: "user-a",
      seq: 7,
      timestamp: 123,
    });
    expect(envelope.sessionId).toBe("session-1");
    expect(envelope.peerId).toBe("user-a");
    expect(envelope.seq).toBe(7);
    expect(envelope.timestamp).toBe(123);
  });
});

describe("parseEnvelope", () => {
  it("returns the envelope for valid input", () => {
    const envelope = makeEnvelope({ event: "ping" });
    const parsed = parseEnvelope(envelope);
    expect(parsed).not.toBeNull();
    expect(parsed?.event).toBe("ping");
    expect(parsed?.version).toBe(PROTOCOL_VERSION);
  });

  it("returns null for invalid input", () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope(undefined)).toBeNull();
    expect(parseEnvelope("not an object")).toBeNull();
    expect(parseEnvelope({})).toBeNull();
    expect(parseEnvelope({ event: "ping" })).toBeNull();
  });
});

describe("client → server envelopes", () => {
  const validFrames: [string, unknown][] = [
    ["hello", undefined],
    ["chat", { id: "c1", sender: "Alice", text: "hello there" }],
    ["canvas-stroke", { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: "#fff" }],
    ["canvas-clear", {}],
    ["timer", { action: "start", endAt: 1_700_000_100_000, remaining: 0 }],
    ["cinema", { playing: true }],
    ["identity-update", { displayName: "Alicia", city: validCity }],
    ["state-request", { afterSeq: 0 }],
    ["state-request", { afterSeq: 42 }],
    ["ping", { ts: 1_700_000_000_000 }],
  ];

  it.each(validFrames)("accepts a valid %s frame", (event, payload) => {
    expect(parseClientEnvelope(frame(event, payload))).not.toBeNull();
  });

  const malformedFrames: [string, unknown, string][] = [
    ["hello", { foo: 1 }, "hello with a payload"],
    ["chat", { text: "" }, "blank chat text"],
    ["chat", { text: 123 }, "non-string chat text"],
    ["canvas-stroke", { points: [{ x: "a", y: 1 }], color: "#fff" }, "bad point coords"],
    ["canvas-stroke", { points: [], color: 7 }, "non-string color"],
    ["canvas-clear", { anything: true }, "canvas-clear with a payload"],
    ["timer", { action: "jump", endAt: 1, remaining: 0 }, "unknown timer action"],
    ["timer", { action: "start", endAt: "soon", remaining: 0 }, "non-numeric endAt"],
    ["cinema", { playing: "yes" }, "non-boolean playing"],
    ["identity-update", { displayName: "Alicia" }, "missing city"],
    ["identity-update", { displayName: "", city: validCity }, "blank display name"],
    ["identity-update", { displayName: "Alicia", city: { name: "Paris" } }, "partial city"],
    ["state-request", undefined, "state-request without afterSeq"],
    ["state-request", {}, "state-request without afterSeq"],
    ["state-request", { afterSeq: -1 }, "negative afterSeq"],
    ["state-request", { afterSeq: 1.5 }, "fractional afterSeq"],
    ["ping", { ts: "now" }, "non-numeric ts"],
  ];

  it.each(malformedFrames)("rejects a malformed %s (%s)", (event, payload) => {
    expect(parseClientEnvelope(frame(event, payload))).toBeNull();
  });

  it("rejects unknown events", () => {
    expect(parseClientEnvelope(frame("totally-unknown", {}))).toBeNull();
  });

  it("keeps extra unknown payload fields (forward compatibility on fields)", () => {
    const parsed = parseClientEnvelope(frame("chat", { text: "hi", futureField: 42 }));
    expect(parsed).not.toBeNull();
    expect(parsed?.event).toBe("chat");
  });
});

describe("server → client envelopes", () => {
  const validFrames: [string, unknown][] = [
    ["connected", { sessionId: "s1", peerId: "p1", role: "a" }],
    ["state", validStatePayload],
    ["peer-joined", { peerId: "p2", displayName: "Bob", cityJson: "{}" }],
    ["peer-left", { peerId: "p2" }],
    ["peer-updated", { peerId: "p2", displayName: "Robert", cityJson: "{}" }],
    ["chat", { id: "m1", peerId: "p2", sender: "Bob", text: "hi", seq: 2, timestamp: 1_700_000_000_000 }],
    ["ack", { refSeq: 2, refId: "c1", id: "m2" }],
    ["pong", { ts: 1_700_000_000_000 }],
    ["canvas-stroke", { points: [{ x: 1, y: 2 }], color: "#fff" }],
    ["canvas-clear", {}],
    ["timer", { action: "pause", endAt: 0, remaining: 488 }],
    ["cinema", { playing: false }],
    ["error", { message: "invalid envelope" }],
  ];

  it.each(validFrames)("accepts a valid %s frame", (event, payload) => {
    expect(parseServerEnvelope(frame(event, payload))).not.toBeNull();
  });

  it("accepts an ack without a refId", () => {
    const parsed = parseServerEnvelope(frame("ack", { refSeq: 1, id: "m1" }));
    expect(parsed).not.toBeNull();
  });

  it("accepts a state payload without canvas/timer/cinema rows", () => {
    const parsed = parseServerEnvelope(
      frame("state", {
        ...validStatePayload,
        canvas: null,
        timer: null,
        cinema: null,
      }),
    );
    expect(parsed).not.toBeNull();
  });

  it("rejects a state payload without snapshotSeq", () => {
    const withoutSeq = { ...validStatePayload };
    delete (withoutSeq as Record<string, unknown>).snapshotSeq;
    expect(parseServerEnvelope(frame("state", withoutSeq))).toBeNull();
  });

  const malformedFrames: [string, unknown, string][] = [
    ["connected", { sessionId: "s1", peerId: "p1", role: "z" }, "bad role"],
    ["connected", { sessionId: "s1", role: "a" }, "missing peerId"],
    ["peer-joined", { displayName: "Bob" }, "missing peerId"],
    ["peer-left", { peerId: 5 }, "non-string peerId"],
    ["state", { ...validStatePayload, timer: { action: "start", end_at: 1 } }, "partial timer row"],
    ["state", { ...validStatePayload, cinema: { session_id: "s1", playing: "yes" } }, "cinema playing not boolean"],
    ["state", { session: validStatePayload.session, peers: "nope" }, "peers not an array"],
    ["ack", { refSeq: -1, id: "m1" }, "negative refSeq"],
    ["pong", { ts: "later" }, "non-numeric ts"],
    ["chat", { id: "m1", peerId: "p2", text: "hi", seq: 1 }, "missing sender"],
    ["error", { detail: "boom" }, "missing message"],
  ];

  it.each(malformedFrames)("rejects a malformed %s (%s)", (event, payload) => {
    expect(parseServerEnvelope(frame(event, payload))).toBeNull();
  });

  it("rejects unknown events", () => {
    expect(parseServerEnvelope(frame("feature.future.v99", {}))).toBeNull();
  });
});

describe("directionality", () => {
  it("rejects client-only events on the server envelope parser", () => {
    expect(parseServerEnvelope(frame("ping", { ts: 1 }))).toBeNull();
    expect(parseServerEnvelope(frame("hello"))).toBeNull();
    expect(parseServerEnvelope(frame("state-request"))).toBeNull();
    expect(parseServerEnvelope(frame("identity-update", { displayName: "A", city: validCity }))).toBeNull();
    expect(parseServerEnvelope(frame("chat", { text: "hi" }))).toBeNull(); // send shape ≠ broadcast shape
  });

  it("rejects server-only events on the client envelope parser", () => {
    expect(parseClientEnvelope(frame("connected", { sessionId: "s1", peerId: "p1", role: "a" }))).toBeNull();
    expect(parseClientEnvelope(frame("state", validStatePayload))).toBeNull();
    expect(parseClientEnvelope(frame("peer-joined", { peerId: "p2" }))).toBeNull();
    expect(parseClientEnvelope(frame("peer-left", { peerId: "p2" }))).toBeNull();
    expect(parseClientEnvelope(frame("peer-updated", { peerId: "p2" }))).toBeNull();
    expect(parseClientEnvelope(frame("ack", { refSeq: 1, id: "m1" }))).toBeNull();
    expect(parseClientEnvelope(frame("pong", { ts: 1 }))).toBeNull();
    expect(parseClientEnvelope(frame("error", { message: "x" }))).toBeNull();
  });
});

describe("round-trip and forward compatibility", () => {
  it("round-trips a client envelope through makeEnvelope", () => {
    const env = makeEnvelope({
      event: "ping",
      sessionId: "s1",
      peerId: "p1",
      payload: { ts: 123 },
    });
    expect(parseEnvelope(env)).not.toBeNull();
    const parsed = parseClientEnvelope(env);
    expect(parsed).not.toBeNull();
    expect(parsed?.event).toBe("ping");
    if (parsed && parsed.event === "ping") {
      expect(parsed.payload.ts).toBe(123);
    }
  });

  it("round-trips a server envelope through makeEnvelope", () => {
    const env = makeEnvelope({
      event: "connected",
      sessionId: "s1",
      peerId: "p1",
      payload: { sessionId: "s1", peerId: "p1", role: "a" },
    });
    expect(parseServerEnvelope(env)).not.toBeNull();
  });

  it("parses unknown future events at the base level but drops them from both unions", () => {
    const unknown = frame("feature.future.v99", { whatever: true });
    expect(parseEnvelope(unknown)).not.toBeNull();
    expect(parseClientEnvelope(unknown)).toBeNull();
    expect(parseServerEnvelope(unknown)).toBeNull();
  });
});

describe("SEQUENCED_SERVER_EVENTS", () => {
  it("covers exactly the replayable server events", () => {
    expect([...SEQUENCED_SERVER_EVENTS].sort()).toEqual(
      ["canvas-clear", "canvas-stroke", "chat", "cinema", "peer-updated", "timer"].sort(),
    );
  });

  it("excludes presence and control events", () => {
    expect(SEQUENCED_SERVER_EVENTS.has("peer-joined")).toBe(false);
    expect(SEQUENCED_SERVER_EVENTS.has("peer-left")).toBe(false);
    expect(SEQUENCED_SERVER_EVENTS.has("state")).toBe(false);
    expect(SEQUENCED_SERVER_EVENTS.has("ack")).toBe(false);
    expect(SEQUENCED_SERVER_EVENTS.has("pong")).toBe(false);
    expect(SEQUENCED_SERVER_EVENTS.has("error")).toBe(false);
  });
});

describe("KNOWN_CLIENT_EVENTS", () => {
  it("covers every client event in the union", () => {
    const expected = [
      "hello",
      "chat",
      "canvas-stroke",
      "canvas-clear",
      "timer",
      "cinema",
      "identity-update",
      "state-request",
      "ping",
    ];
    expect([...KNOWN_CLIENT_EVENTS].sort()).toEqual([...expected].sort());
  });
});
