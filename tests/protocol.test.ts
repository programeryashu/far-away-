import { describe, it, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  BaseEnvelopeSchema,
  makeEnvelope,
  parseEnvelope,
} from "../shared/protocol.js";

describe("BaseEnvelopeSchema", () => {
  it("accepts a valid envelope", () => {
    const result = BaseEnvelopeSchema.safeParse({
      version: PROTOCOL_VERSION,
      session: "session-1",
      from: "user-a",
      seq: 0,
      timestamp: 1_700_000_000_000,
      event: "ping",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid version", () => {
    const result = BaseEnvelopeSchema.safeParse({
      version: "1",
      session: "session-1",
      from: "user-a",
      seq: 0,
      timestamp: 1_700_000_000_000,
      event: "ping",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative sequence", () => {
    const result = BaseEnvelopeSchema.safeParse({
      version: PROTOCOL_VERSION,
      session: "session-1",
      from: "user-a",
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
    const result = BaseEnvelopeSchema.safeParse({
      version: PROTOCOL_VERSION,
      session: "session-1",
      from: "user-a",
      seq: 1,
      timestamp: 1_700_000_000_000,
      event: "feature.future.v99",
    });
    expect(result.success).toBe(true);
  });
});

describe("makeEnvelope", () => {
  it("applies default values", () => {
    const envelope = makeEnvelope({ event: "ping" });
    expect(envelope.version).toBe(PROTOCOL_VERSION);
    expect(envelope.session).toBe("");
    expect(envelope.from).toBe("");
    expect(envelope.seq).toBe(0);
    expect(typeof envelope.timestamp).toBe("number");
    expect(envelope.event).toBe("ping");
  });

  it("allows overrides", () => {
    const envelope = makeEnvelope({
      event: "chat",
      session: "session-1",
      from: "user-a",
      seq: 7,
      timestamp: 123,
    });
    expect(envelope.session).toBe("session-1");
    expect(envelope.from).toBe("user-a");
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
