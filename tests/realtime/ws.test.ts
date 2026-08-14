import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../server/app.js";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import fs from "node:fs";
import { parseEnvelope } from "../../shared/protocol.js";

const TEST_DB = "./data/test_ws.db";

interface Frame {
  event: string;
  payload: unknown;
  seq?: number;
}

// Resolve when a frame with the given event arrives; resolve null on timeout.
function waitForEvent(
  ws: WebSocket,
  event: string,
  timeoutMs = 3000,
): Promise<Frame | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      resolve(null);
    }, timeoutMs);
    const onMessage = (raw: Buffer) => {
      const data = JSON.parse(raw.toString()) as Frame;
      if (data.event === event) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(data);
      }
    };
    ws.on("message", onMessage);
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on("close", (code) => resolve(code)));
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Ask the server for a full state snapshot (fresh-connect catch-up). */
function requestState(ws: WebSocket, sessionId: string, peerId: string): Promise<Frame | null> {
  const promise = waitForEvent(ws, "state");
  ws.send(envelope(sessionId, peerId, "state-request", { afterSeq: 0 }));
  return promise;
}

const envelope = (sessionId: string, peerId: string, event: string, payload: unknown) =>
  JSON.stringify({
    version: 1,
    sessionId,
    peerId,
    seq: 0,
    timestamp: Date.now(),
    event,
    payload,
  });

describe("WebSocket", () => {
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    process.env.DATABASE_PATH = TEST_DB;
    process.env.PORT = "0";
    app = await buildApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  async function createJoinedSession() {
    const create = await app.inject({ method: "POST", url: "/api/sessions" });
    const { id } = JSON.parse(create.payload) as { id: string };
    const joinA = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice", city: { name: "San Francisco" } },
    });
    const joinB = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Bob", city: { name: "Tokyo" } },
    });
    const { peerId: peerA } = JSON.parse(joinA.payload) as { peerId: string };
    const { peerId: peerB } = JSON.parse(joinB.payload) as { peerId: string };
    return { id, peerA, peerB };
  }

  const wsUrl = (sessionId: string, peerId: string) =>
    `ws://127.0.0.1:${port}/ws?sessionId=${sessionId}&peerId=${peerId}`;

  it("should reject connection without session", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const code = await waitForClose(ws);
    expect(code).toBe(4000);
  });

  it("should complete ping/pong and chat round-trips the client schema accepts", async () => {
    const { id, peerA, peerB } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    const wsB = new WebSocket(wsUrl(id, peerB));

    const connectedA = await waitForEvent(wsA, "connected");
    const connectedB = await waitForEvent(wsB, "connected");
    expect(parseEnvelope(connectedA)).not.toBeNull();
    expect(parseEnvelope(connectedB)).not.toBeNull();

    // Ping → pong echoes the original timestamp so the client can measure RTT.
    const ts = Date.now();
    const pongPromise = waitForEvent(wsA, "pong");
    wsA.send(envelope(id, peerA, "ping", { ts }));
    const pong = await pongPromise;
    expect(pong).not.toBeNull();
    expect(parseEnvelope(pong)).not.toBeNull();
    expect((pong?.payload as { ts?: number }).ts).toBe(ts);

    // Chat from A arrives at B with the sender's display name.
    const chatPromise = waitForEvent(wsB, "chat");
    wsA.send(envelope(id, peerA, "chat", { id: "local-1", sender: "Alice", text: "hello" }));
    const chat = await chatPromise;
    expect(chat).not.toBeNull();
    expect(parseEnvelope(chat)).not.toBeNull();
    const chatPayload = chat?.payload as { id?: string; sender?: string; text?: string };
    expect(chatPayload.sender).toBe("Alice");
    expect(chatPayload.text).toBe("hello");
    expect(typeof chatPayload.id).toBe("string");

    wsA.close();
    wsB.close();
  });

  it("should preserve the role across a reconnect", async () => {
    const { id, peerA } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    const first = await waitForEvent(wsA, "connected");
    expect((first?.payload as { role?: string }).role).toBe("a");
    wsA.close();

    const wsA2 = new WebSocket(wsUrl(id, peerA));
    const second = await waitForEvent(wsA2, "connected");
    expect((second?.payload as { role?: string }).role).toBe("a");
    expect(parseEnvelope(second)).not.toBeNull();
    wsA2.close();
  });

  it("should broadcast peer presence: join, leave, rejoin", async () => {
    const { id, peerA, peerB } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    await waitForEvent(wsA, "connected");

    // B joins → A sees peer-joined with B's identity.
    const joinedPromise = waitForEvent(wsA, "peer-joined");
    const wsB = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsB, "connected");
    const joined = await joinedPromise;
    expect(joined).not.toBeNull();
    expect(parseEnvelope(joined)).not.toBeNull();
    expect((joined?.payload as { peerId?: string; displayName?: string }).peerId).toBe(peerB);
    expect((joined?.payload as { displayName?: string }).displayName).toBe("Bob");

    // B leaves → A sees peer-left.
    wsB.close();
    const left = await waitForEvent(wsA, "peer-left");
    expect(left).not.toBeNull();
    expect((left?.payload as { peerId?: string }).peerId).toBe(peerB);

    // B rejoins → A sees peer-joined again.
    const rejoinedPromise = waitForEvent(wsA, "peer-joined");
    const wsB2 = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsB2, "connected");
    const rejoined = await rejoinedPromise;
    expect(rejoined).not.toBeNull();
    expect((rejoined?.payload as { peerId?: string }).peerId).toBe(peerB);

    wsA.close();
    wsB2.close();
  });

  it("should deliver chat both ways, ack the sender, persist, and replay history on reconnect", async () => {
    const { id, peerA, peerB } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    const wsB = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsA, "connected");
    await waitForEvent(wsB, "connected");

    // A → B; listeners are registered before the send so no frame is missed.
    const chatABPromise = waitForEvent(wsB, "chat");
    const ackPromise = waitForEvent(wsA, "ack");
    wsA.send(envelope(id, peerA, "chat", { id: "local-1", sender: "Alice", text: "hello" }));
    const chatAB = await chatABPromise;
    expect((chatAB?.payload as { text?: string }).text).toBe("hello");

    // Sender gets an ack correlating its local id with the server id.
    const ack = await ackPromise;
    const ackPayload = ack?.payload as { refSeq?: number; refId?: string; id?: string };
    expect(ackPayload.refId).toBe("local-1");
    expect(typeof ackPayload.id).toBe("string");
    expect(ackPayload.refSeq).toBe(1);

    // B → A
    const chatBAPromise = waitForEvent(wsA, "chat");
    wsB.send(envelope(id, peerB, "chat", { id: "local-2", sender: "Bob", text: "world" }));
    const chatBA = await chatBAPromise;
    const baPayload = chatBA?.payload as { sender?: string; text?: string };
    expect(baPayload.sender).toBe("Bob");
    expect(baPayload.text).toBe("world");

    // Server persists both, sequences monotonic.
    const stateRes = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
    const state = JSON.parse(stateRes.payload) as { messages: { seq: number; sender_name: string; text: string }[] };
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].seq).toBe(1);
    expect(state.messages[1].seq).toBe(2);
    expect(state.messages.map((m) => m.sender_name)).toEqual(["Alice", "Bob"]);

    // B reconnects → catch-up replays history with both messages.
    wsB.close();
    const wsB2 = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsB2, "connected");
    const stateEvent = await requestState(wsB2, id, peerB);
    const history = (stateEvent?.payload as { messages?: { seq: number }[] }).messages ?? [];
    expect(history.map((m) => m.seq)).toEqual([1, 2]);

    wsA.close();
    wsB2.close();
  });

  it("should broadcast and persist canvas strokes, then reset on clear", async () => {
    const { id, peerA, peerB } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    const wsB = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsA, "connected");
    await waitForEvent(wsB, "connected");

    const stroke = { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: "#fff" };
    const strokePromise = waitForEvent(wsB, "canvas-stroke");
    wsA.send(envelope(id, peerA, "canvas-stroke", stroke));
    const received = await strokePromise;
    expect(received?.payload).toEqual(stroke);
    expect(parseEnvelope(received)).not.toBeNull();

    const afterStroke = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
    const canvasAfter = JSON.parse(afterStroke.payload).canvas as { strokes_json: string };
    expect(JSON.parse(canvasAfter.strokes_json)).toEqual([stroke]);

    const clearPromise = waitForEvent(wsB, "canvas-clear");
    wsA.send(envelope(id, peerA, "canvas-clear", {}));
    const cleared = await clearPromise;
    expect(cleared).not.toBeNull();

    const afterClear = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
    const canvasAfterClear = JSON.parse(afterClear.payload).canvas as { strokes_json: string };
    expect(JSON.parse(canvasAfterClear.strokes_json)).toEqual([]);

    wsA.close();
    wsB.close();
  });

  it("should relay timer events", async () => {
    const { id, peerA, peerB } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    const wsB = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsA, "connected");
    await waitForEvent(wsB, "connected");

    const timer = { action: "start", endAt: Date.now() + 60000, remaining: 0 };
    const timerPromise = waitForEvent(wsB, "timer");
    wsA.send(envelope(id, peerA, "timer", timer));
    const received = await timerPromise;
    expect(received?.payload).toEqual(timer);
    expect(parseEnvelope(received)).not.toBeNull();

    wsA.close();
    wsB.close();
  });

  it("delivers a timer sent immediately around connection establishment exactly once", async () => {
    // Regression: a timer action attempted the instant the socket opens (the
    // earliest possible moment — the client's outbound queue flushes here)
    // must reach the peer exactly once and be persisted exactly once.
    const { id, peerA, peerB } = await createJoinedSession();
    const wsB = new WebSocket(wsUrl(id, peerB));
    const bTimerPromise = waitForEvent(wsB, "timer");
    await waitForEvent(wsB, "connected");

    const endAt = Date.now() + 60000;
    const timer = { action: "start", endAt, remaining: 0 };
    const wsA = new WebSocket(wsUrl(id, peerA));
    wsA.on("open", () => {
      // Sent before the server has even delivered `connected`.
      wsA.send(envelope(id, peerA, "timer", timer));
    });

    const received = await bTimerPromise;
    expect(received).not.toBeNull();
    expect(received?.payload).toEqual(timer);
    expect(parseEnvelope(received)).not.toBeNull();

    // Wait for any duplicate delivery to surface, then verify exactly one row.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stateRes = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
    const state = JSON.parse(stateRes.payload) as { timer: { action: string; end_at: number; remaining: number } | null };
    expect(state.timer?.action).toBe("start");
    expect(state.timer?.end_at).toBe(endAt);
    expect(state.timer?.remaining).toBe(0);

    // A reconnecting peer's state catch-up shows the persisted timer once.
    wsB.close();
    const wsB2 = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsB2, "connected");
    const stateEvent = await requestState(wsB2, id, peerB);
    const catchUp = (stateEvent?.payload as { timer?: { action: string; end_at: number } }).timer;
    expect(catchUp?.action).toBe("start");
    expect(catchUp?.end_at).toBe(endAt);

    wsA.close();
    wsB2.close();
  });

  it("should reject an expired session with a terminal close", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { expiresIn: 0 },
    });
    const { id } = JSON.parse(create.payload) as { id: string };
    const join = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/join`,
      payload: { displayName: "Alice", city: {} },
    });
    const { peerId } = JSON.parse(join.payload) as { peerId: string };

    const ws = new WebSocket(wsUrl(id, peerId));
    const code = await waitForClose(ws);
    expect(code).toBe(4000);
  });

  it("should not crash on malformed frames and should error on unknown events", async () => {
    const { id, peerA } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    await waitForEvent(wsA, "connected");

    wsA.send("this is not json");
    const malformed = await waitForEvent(wsA, "error");
    expect((malformed?.payload as { message?: string }).message).toBe("malformed JSON");
    expect(parseEnvelope(malformed)).not.toBeNull();

    wsA.send(JSON.stringify({ foo: "bar" }));
    const invalid = await waitForEvent(wsA, "error");
    expect((invalid?.payload as { message?: string }).message).toBe("invalid envelope");

    wsA.send(envelope(id, peerA, "totally-unknown", {}));
    const unsupported = await waitForEvent(wsA, "error");
    expect((unsupported?.payload as { message?: string }).message).toContain("unsupported event");

    wsA.close();
  });

  it("should reject a wrong payload for a known event without crashing the socket", async () => {
    const { id, peerA } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    await waitForEvent(wsA, "connected");

    const expectError = async (payload: unknown, expected: string) => {
      wsA.send(envelope(id, peerA, "chat", payload));
      const err = await waitForEvent(wsA, "error");
      expect((err?.payload as { message?: string }).message).toBe(expected);
      expect(parseEnvelope(err)).not.toBeNull();
    };

    // The event name is known, so the error names the payload, not the event.
    await expectError({ text: 123 }, "invalid chat payload");
    await expectError({ text: "   " }, "invalid chat payload");

    wsA.send(envelope(id, peerA, "timer", { action: "jump", endAt: 1, remaining: 0 }));
    let err = await waitForEvent(wsA, "error");
    expect((err?.payload as { message?: string }).message).toBe("invalid timer payload");

    wsA.send(envelope(id, peerA, "ping", { ts: "now" }));
    err = await waitForEvent(wsA, "error");
    expect((err?.payload as { message?: string }).message).toBe("invalid ping payload");

    wsA.send(envelope(id, peerA, "canvas-stroke", { points: [{ x: "a", y: 1 }], color: "#fff" }));
    err = await waitForEvent(wsA, "error");
    expect((err?.payload as { message?: string }).message).toBe("invalid canvas-stroke payload");

    wsA.send(envelope(id, peerA, "identity-update", { displayName: "Alicia", city: { name: "Paris" } }));
    err = await waitForEvent(wsA, "error");
    expect((err?.payload as { message?: string }).message).toBe("invalid identity-update payload");

    wsA.send(envelope(id, peerA, "cinema", { playing: "yes" }));
    err = await waitForEvent(wsA, "error");
    expect((err?.payload as { message?: string }).message).toBe("invalid cinema payload");

    // The socket survives all of the above and still answers a valid ping.
    const pongPromise = waitForEvent(wsA, "pong");
    wsA.send(envelope(id, peerA, "ping", { ts: 42 }));
    const pong = await pongPromise;
    expect((pong?.payload as { ts?: number }).ts).toBe(42);

    wsA.close();
  });

  it("should relay cinema events between peers and reject invalid payloads", async () => {
    const { id, peerA, peerB } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    const wsB = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsA, "connected");
    await waitForEvent(wsB, "connected");

    const cinemaPromise = waitForEvent(wsB, "cinema");
    wsA.send(envelope(id, peerA, "cinema", { playing: true }));
    const cinema = await cinemaPromise;
    expect(cinema?.payload).toEqual({ playing: true });
    expect(parseEnvelope(cinema)).not.toBeNull();

    const errPromise = waitForEvent(wsA, "error");
    wsA.send(envelope(id, peerA, "cinema", { playing: "yes" }));
    const err = await errPromise;
    expect((err?.payload as { message?: string }).message).toContain("cinema");

    wsA.close();
    wsB.close();
  });

  it("should persist timer state and replay it to a reconnecting peer", async () => {
    const { id, peerA, peerB } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    const wsB = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsA, "connected");
    await waitForEvent(wsB, "connected");

    const endAt = Date.now() + 60000;
    const timerPromise = waitForEvent(wsB, "timer");
    wsA.send(envelope(id, peerA, "timer", { action: "start", endAt, remaining: 0 }));
    expect((await timerPromise)?.payload).toEqual({ action: "start", endAt, remaining: 0 });

    // Reconnecting B must receive the persisted timer in state catch-up.
    wsB.close();
    const wsB2 = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsB2, "connected");
    const stateEvent = await requestState(wsB2, id, peerB);
    const timer = (stateEvent?.payload as { timer?: { action: string; end_at: number } }).timer;
    expect(timer?.action).toBe("start");
    expect(timer?.end_at).toBe(endAt);

    wsA.close();
    wsB2.close();
  });

  it("should update identity, broadcast it to the peer, and persist it for state catch-up", async () => {
    const { id, peerA, peerB } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    const wsB = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsA, "connected");
    await waitForEvent(wsB, "connected");

    const city = { name: "Paris", country: "France", lat: 48.8566, lng: 2.3522, timezone: "Europe/Paris" };
    const updatedPromise = waitForEvent(wsB, "peer-updated");
    wsA.send(envelope(id, peerA, "identity-update", { displayName: "Alicia", city }));
    const updated = await updatedPromise;
    const updatePayload = updated?.payload as { peerId?: string; displayName?: string; cityJson?: string };
    expect(updatePayload.peerId).toBe(peerA);
    expect(updatePayload.displayName).toBe("Alicia");
    expect(JSON.parse(updatePayload.cityJson ?? "{}").name).toBe("Paris");

    // Persisted in the DB → reconnecting B's state catch-up sees the new name.
    wsB.close();
    const wsB2 = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsB2, "connected");
    const stateEvent = await requestState(wsB2, id, peerB);
    const peers = (stateEvent?.payload as { peers?: { role: string; display_name: string; city_json: string }[] }).peers ?? [];
    const peerARow = peers.find((p) => p.role === "a");
    expect(peerARow?.display_name).toBe("Alicia");
    expect(JSON.parse(peerARow?.city_json ?? "{}").name).toBe("Paris");

    wsA.close();
    wsB2.close();
  });

  it("replays missed events in order to a reconnecting peer with no duplicates, then live events continue", async () => {
    const { id, peerA, peerB } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    const wsB = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsA, "connected");
    await waitForEvent(wsB, "connected");

    // A sends one event B applies before going offline (event seq 1).
    const firstChatPromise = waitForEvent(wsB, "chat");
    wsA.send(envelope(id, peerA, "chat", { id: "pre-1", sender: "Alice", text: "before" }));
    const firstChat = await firstChatPromise;
    expect(firstChat?.seq).toBe(1);

    // B disconnects.
    wsB.close();
    await waitForClose(wsB);

    // While B is offline, A produces chat/timer/canvas/cinema/identity events.
    wsA.send(envelope(id, peerA, "chat", { id: "off-1", sender: "Alice", text: "during" }));
    const city = { name: "Paris", country: "France", lat: 48.8566, lng: 2.3522, timezone: "Europe/Paris" };
    wsA.send(envelope(id, peerA, "identity-update", { displayName: "Alicia", city }));
    wsA.send(envelope(id, peerA, "timer", { action: "start", endAt: Date.now() + 60000, remaining: 0 }));
    wsA.send(envelope(id, peerA, "cinema", { playing: true }));
    wsA.send(envelope(id, peerA, "canvas-stroke", { points: [{ x: 1, y: 2 }], color: "#fff" }));

    // Let the server persist everything, then B reconnects and requests a
    // replay strictly after the seq it already applied (1).
    await new Promise((r) => setTimeout(r, 250));
    const wsB2 = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsB2, "connected");
    const frames: { event: string; seq: number; payload: Record<string, unknown> }[] = [];
    wsB2.on("message", (raw: Buffer) => {
      const data = JSON.parse(raw.toString()) as (typeof frames)[number];
      frames.push(data);
    });
    wsB2.send(envelope(id, peerB, "state-request", { afterSeq: 1 }));

    // The missed range replays as individual envelopes with original seqs.
    await waitFor(() => frames.length >= 5);
    expect(frames.map((f) => f.event)).toEqual(["chat", "peer-updated", "timer", "cinema", "canvas-stroke"]);
    expect(frames.map((f) => f.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(frames[0].payload.text).toBe("during");
    expect(frames[1].payload.displayName).toBe("Alicia");
    expect(frames[1].payload.peerId).toBe(peerA);
    expect(frames[2].payload.action).toBe("start");
    expect(frames[3].payload.playing).toBe(true);
    expect(frames.every((f) => parseEnvelope(f as unknown as Record<string, unknown>))).toBe(true);

    // No duplicates: nothing further arrives within a quiet window.
    await new Promise((r) => setTimeout(r, 250));
    expect(frames.length).toBe(5);

    // Live events resume normally with the next seq.
    const livePromise = waitForEvent(wsB2, "timer");
    wsA.send(envelope(id, peerA, "timer", { action: "pause", endAt: 0, remaining: 488 }));
    const live = await livePromise;
    expect(live?.seq).toBe(7);
    expect((live?.payload as { action?: string }).action).toBe("pause");

    // A fresh client still gets the authoritative snapshot with snapshotSeq.
    const wsB3 = new WebSocket(wsUrl(id, peerB));
    await waitForEvent(wsB3, "connected");
    const stateEvent = await requestState(wsB3, id, peerB);
    const sp = stateEvent?.payload as { snapshotSeq?: number; messages?: unknown[]; peers?: unknown[] };
    expect(sp.snapshotSeq).toBe(7);
    expect(sp.messages).toHaveLength(2);
    expect(sp.peers).toHaveLength(2);
    expect((sp.peers as { role: string; display_name: string }[]).find((p) => p.role === "a")?.display_name).toBe("Alicia");

    wsA.close();
    wsB2.close();
    wsB3.close();
  });

  it("should report live presence to a newly connected peer and after reconnect", async () => {
    const { id, peerA, peerB } = await createJoinedSession();
    const wsA = new WebSocket(wsUrl(id, peerA));
    await waitForEvent(wsA, "connected");

    // B connecting sees that A is online right now (socket truth).
    const wsB = new WebSocket(wsUrl(id, peerB));
    const bJoinedPromise = waitForEvent(wsB, "peer-joined");
    await waitForEvent(wsB, "connected");
    const bJoined = await bJoinedPromise;
    expect((bJoined?.payload as { peerId?: string }).peerId).toBe(peerA);

    // A reconnects (reload) while B is online → A's new socket sees B.
    wsA.close();
    const wsA2 = new WebSocket(wsUrl(id, peerA));
    const aReloadPromise = waitForEvent(wsA2, "peer-joined");
    await waitForEvent(wsA2, "connected");
    const aReload = await aReloadPromise;
    expect((aReload?.payload as { peerId?: string }).peerId).toBe(peerB);

    wsA2.close();
    wsB.close();
  });
});
