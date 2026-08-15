import { describe, it, expect } from "vitest";
import {
  identityFromParts,
  mergeMessages,
  otherPeers,
  parseCanvasStrokes,
  parseCinemaState,
  parseTimerState,
  peerIdentity,
  serverMessagesToClient,
  type ClientMessage,
  type ServerCanvas,
  type ServerMessage,
  type ServerPeer,
} from "./reconcile";

const cityJson = JSON.stringify({
  name: "Tokyo",
  country: "Japan",
  lat: 35.6762,
  lng: 139.6503,
  timezone: "Asia/Tokyo",
});

describe("mergeMessages", () => {
  const base: ClientMessage[] = [
    { id: "m1", sender: "Alice", text: "hi", timestamp: "10:00", status: "delivered" },
    { id: "m2", sender: "Bob", text: "yo", timestamp: "10:01", status: "delivered" },
  ];

  it("appends new messages", () => {
    const merged = mergeMessages(base, [
      { id: "m3", sender: "Alice", text: "again", timestamp: "10:02", status: "delivered" },
    ]);
    expect(merged.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("dedupes by id when the same state arrives twice", () => {
    const history: ClientMessage[] = [
      { id: "m2", sender: "Bob", text: "yo", timestamp: "10:01", status: "delivered" },
      { id: "m3", sender: "Alice", text: "again", timestamp: "10:02", status: "delivered" },
    ];
    const once = mergeMessages(base, history);
    expect(once.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    // Idempotent: applying the same history again changes nothing.
    const twice = mergeMessages(once, history);
    expect(twice.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("skips history rows already adopted by a locally-sent message via serverId", () => {
    const withServerId: ClientMessage[] = [
      { id: "local-1", serverId: "server-9", sender: "Alice", text: "mine", timestamp: "10:00", status: "delivered" },
    ];
    const history: ClientMessage[] = [
      { id: "server-9", sender: "Alice", text: "mine", timestamp: "10:00", status: "delivered" },
      { id: "server-10", sender: "Bob", text: "yours", timestamp: "10:01", status: "delivered" },
    ];
    const merged = mergeMessages(withServerId, history);
    expect(merged.map((m) => m.id)).toEqual(["local-1", "server-10"]);
  });

  it("dedupes live broadcasts that also appear in history", () => {
    const live: ClientMessage[] = [
      { id: "server-5", sender: "Bob", text: "live", timestamp: "10:05", status: "delivered" },
    ];
    const merged = mergeMessages(live, [
      { id: "server-5", sender: "Bob", text: "live", timestamp: "10:05", status: "delivered" },
    ]);
    expect(merged.length).toBe(1);
  });
});

describe("serverMessagesToClient", () => {
  it("maps server rows to client messages", () => {
    const rows: ServerMessage[] = [
      { id: "m1", session_id: "s1", sender_peer: "p1", sender_name: "Alice", text: "hi", ts: 1700000000000, seq: 1 },
    ];
    const mapped = serverMessagesToClient(rows);
    expect(mapped[0]).toMatchObject({ id: "m1", sender: "Alice", text: "hi", status: "delivered" });
    expect(typeof mapped[0].timestamp).toBe("string");
  });
});

describe("otherPeers", () => {
  it("excludes self and keeps the rest", () => {
    const peers: ServerPeer[] = [
      { id: "me", session_id: "s1", role: "a", display_name: "Alice", city_json: "{}", joined_at: 1, last_seen: 1 },
      { id: "bob", session_id: "s1", role: "b", display_name: "Bob", city_json: "{}", joined_at: 2, last_seen: 2 },
    ];
    const others = otherPeers(peers, "me");
    expect(others.map((p) => p.id)).toEqual(["bob"]);
  });
});

describe("identityFromParts / peerIdentity", () => {
  it("parses a valid city and name", () => {
    const identity = identityFromParts("Bob", cityJson);
    expect(identity).toEqual({
      name: "Bob",
      city: { name: "Tokyo", country: "Japan", lat: 35.6762, lng: 139.6503, timezone: "Asia/Tokyo" },
    });
  });

  it("keeps the name but drops an invalid city", () => {
    const identity = identityFromParts("Bob", "{not json");
    expect(identity?.name).toBe("Bob");
    expect(identity?.city).toBeNull();
  });

  it("returns null when there is no identity at all", () => {
    expect(identityFromParts("", "")).toBeNull();
  });

  it("peerIdentity reads the same fields from a server row", () => {
    const peer: ServerPeer = {
      id: "p1",
      session_id: "s1",
      role: "b",
      display_name: "Bob",
      city_json: cityJson,
      joined_at: 1,
      last_seen: 1,
    };
    expect(peerIdentity(peer)?.city?.name).toBe("Tokyo");
  });
});

describe("parseCanvasStrokes", () => {
  const canvas: ServerCanvas = {
    session_id: "s1",
    strokes_json: JSON.stringify([
      { points: [{ x: 1, y: 2 }], color: "#fff" },
    ]),
    updated_at: 1,
  };

  it("parses persisted strokes", () => {
    const strokes = parseCanvasStrokes(canvas);
    expect(strokes).toHaveLength(1);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseCanvasStrokes({ session_id: "s1", strokes_json: "oops", updated_at: 1 })).toEqual([]);
  });

  it("returns [] when canvas is absent", () => {
    expect(parseCanvasStrokes(null)).toEqual([]);
  });
});

describe("parseTimerState", () => {
  it("maps a persisted timer row to a live payload", () => {
    expect(
      parseTimerState({
        session_id: "s1",
        action: "start",
        end_at: 1234,
        remaining: 0,
        updated_at: 1,
      }),
    ).toEqual({ action: "start", endAt: 1234, remaining: 0 });
  });

  it("returns null when there is no persisted timer", () => {
    expect(parseTimerState(null)).toBeNull();
  });
});

describe("parseCinemaState", () => {
  it("maps a persisted cinema row to a live payload", () => {
    expect(
      parseCinemaState({ session_id: "s1", playing: true, updated_at: 1 }),
    ).toEqual({ playing: true });
    expect(
      parseCinemaState({ session_id: "s1", playing: false, updated_at: 1 }),
    ).toEqual({ playing: false });
  });

  it("returns null when there is no persisted cinema", () => {
    expect(parseCinemaState(null)).toBeNull();
  });
});
