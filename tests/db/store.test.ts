import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../../server/db/store.js";
import fs from "node:fs";

const TEST_DB = "./data/test_store.db";

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    store = new Store(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("should create and get a session", () => {
    const id = "s1";
    const code = "CODE1";
    store.createSession(id, code, "active", Date.now() + 1000);
    const session = store.getSession(id);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(id);
    expect(session!.code).toBe(code);
  });

  it("should manage peers", () => {
    const sessionId = "s1";
    store.createSession(sessionId, "C1", "active", Date.now() + 1000);

    store.addPeer("p1", sessionId, "a", "Alice", "{}");
    expect(store.countPeers(sessionId)).toBe(1);

    store.addPeer("p2", sessionId, "b", "Bob", "{}");
    expect(store.countPeers(sessionId)).toBe(2);

    const alice = store.getPeerByRole(sessionId, "a");
    expect(alice).not.toBeNull();
    expect(alice!.display_name).toBe("Alice");

    store.removePeer("p1");
    expect(store.countPeers(sessionId)).toBe(1);
  });

  it("stores only the hash of a peer's session token", () => {
    const sessionId = "s1";
    store.createSession(sessionId, "C1", "active", Date.now() + 1000);

    const tokenHash = "a".repeat(64);
    store.addPeer("p1", sessionId, "a", "Alice", "{}", tokenHash);
    expect(store.getPeer("p1")!.token_hash).toBe(tokenHash);
    expect(JSON.stringify(store.getPeers(sessionId))).not.toContain("secret");
  });

  it("should handle messages and sequences", () => {
    const sessionId = "s1";
    store.createSession(sessionId, "C1", "active", Date.now() + 1000);

    const seq1 = store.getNextSequence(sessionId);
    expect(seq1).toBe(1);
    store.addMessage("m1", sessionId, "p1", "Alice", "Hello", seq1);

    const seq2 = store.getNextSequence(sessionId);
    expect(seq2).toBe(2);
    store.addMessage("m2", sessionId, "p1", "Alice", "World", seq2);

    const msgs = store.getMessages(sessionId);
    expect(msgs.length).toBe(2);
    expect(msgs[0].seq).toBe(1);
    expect(msgs[1].seq).toBe(2);

    const msgsAfter = store.getMessagesAfterSeq(sessionId, 1);
    expect(msgsAfter.length).toBe(1);
    expect(msgsAfter[0].id).toBe("m2");
  });

  it("should update canvas snapshots", () => {
    const sessionId = "s1";
    store.createSession(sessionId, "C1", "active", Date.now() + 1000);

    store.updateCanvasSnapshot(sessionId, "strokes-1");
    const snap1 = store.getCanvasSnapshot(sessionId);
    expect(snap1).not.toBeNull();
    expect(snap1!.strokes_json).toBe("strokes-1");

    store.updateCanvasSnapshot(sessionId, "strokes-2");
    const snap2 = store.getCanvasSnapshot(sessionId);
    expect(snap2).not.toBeNull();
    expect(snap2!.strokes_json).toBe("strokes-2");
  });

  it("should upsert and read timer state", () => {
    const sessionId = "s1";
    store.createSession(sessionId, "C1", "active", Date.now() + 1000);

    store.upsertTimerState(sessionId, "start", 1000, 0);
    const timer1 = store.getTimerState(sessionId);
    expect(timer1).not.toBeNull();
    expect(timer1!.action).toBe("start");
    expect(timer1!.end_at).toBe(1000);

    store.upsertTimerState(sessionId, "pause", 0, 42);
    const timer2 = store.getTimerState(sessionId);
    expect(timer2!.action).toBe("pause");
    expect(timer2!.remaining).toBe(42);
    expect(store.getTimerState("other")).toBeNull();
  });

  it("should include timer in session state", () => {
    const sessionId = "s1";
    store.createSession(sessionId, "C1", "active", Date.now() + 1000);
    store.upsertTimerState(sessionId, "start", 1234, 0);
    const state = store.getSessionState(sessionId);
    expect(state?.timer?.action).toBe("start");
    expect(state?.timer?.end_at).toBe(1234);
  });

  it("should upsert and read cinema state with boolean normalization and position", () => {
    const sessionId = "s1";
    store.createSession(sessionId, "C1", "active", Date.now() + 1000);

    // No row yet → null.
    expect(store.getCinemaState(sessionId)).toBeNull();

    store.upsertCinemaState(sessionId, true, 12.5);
    const c1 = store.getCinemaState(sessionId);
    expect(c1?.playing).toBe(true);
    expect(c1?.position).toBe(12.5);

    // SQLite stores the boolean as 1/0; the getter must normalize it back.
    store.upsertCinemaState(sessionId, false, 30);
    const c2 = store.getCinemaState(sessionId);
    expect(c2?.playing).toBe(false);
    expect(c2?.position).toBe(30);
    expect(store.getCinemaState("other")).toBeNull();
  });

  it("persists the chosen movie and keeps it across later play/pause actions", () => {
    const sessionId = "s1";
    store.createSession(sessionId, "C1", "active", Date.now() + 1000);

    const movie = { id: 550, title: "Fight Club", year: 1999 };
    // Selection/start event carries the movie.
    store.upsertCinemaState(sessionId, true, 0, JSON.stringify(movie));
    let state = store.getSessionState(sessionId);
    expect(state?.cinema?.movie).toEqual(movie);

    // A later pause/seek with no movie must NOT erase the selection.
    store.upsertCinemaState(sessionId, false, 30);
    state = store.getSessionState(sessionId);
    expect(state?.cinema?.playing).toBe(false);
    expect(state?.cinema?.position).toBe(30);
    expect(state?.cinema?.movie).toEqual(movie);

    // A NEW selection replaces the old one.
    const sequel = { id: 551, title: "Fight Club 2", year: 2003 };
    store.upsertCinemaState(sessionId, true, 5, JSON.stringify(sequel));
    state = store.getSessionState(sessionId);
    expect(state?.cinema?.movie).toEqual(sequel);
  });

  it("should include cinema in session state", () => {
    const sessionId = "s1";
    store.createSession(sessionId, "C1", "active", Date.now() + 1000);
    store.upsertCinemaState(sessionId, true, 8);
    const state = store.getSessionState(sessionId);
    expect(state?.cinema?.playing).toBe(true);
    expect(state?.cinema?.position).toBe(8);
    expect(state?.cinema?.session_id).toBe(sessionId);
  });

  it("should update a peer identity", () => {
    const sessionId = "s1";
    store.createSession(sessionId, "C1", "active", Date.now() + 1000);
    store.addPeer("p1", sessionId, "a", "Alice", "{}");

    store.updatePeerIdentity("p1", "Alicia", JSON.stringify({ name: "Paris" }));
    const peer = store.getPeer("p1");
    expect(peer!.display_name).toBe("Alicia");
    expect(JSON.parse(peer!.city_json)).toEqual({ name: "Paris" });
  });

  describe("session event log", () => {
    it("starts at seq 1 and increments monotonically", () => {
      const sessionId = "s1";
      store.createSession(sessionId, "C1", "active", Date.now() + 1000);

      expect(store.getLatestEventSeq(sessionId)).toBe(0);
      expect(store.getEventCount(sessionId)).toBe(0);

      const seq1 = store.appendEvent(sessionId, "chat", "{}");
      const seq2 = store.appendEvent(sessionId, "timer", "{}");
      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(store.getLatestEventSeq(sessionId)).toBe(2);
      expect(store.getEventCount(sessionId)).toBe(2);
    });

    it("keeps per-session sequences independent", () => {
      store.createSession("s1", "C1", "active", Date.now() + 1000);
      store.createSession("s2", "C2", "active", Date.now() + 1000);

      expect(store.appendEvent("s1", "chat", "{}")).toBe(1);
      expect(store.appendEvent("s2", "chat", "{}")).toBe(1);
      expect(store.appendEvent("s1", "timer", "{}")).toBe(2);
      expect(store.getLatestEventSeq("s1")).toBe(2);
      expect(store.getLatestEventSeq("s2")).toBe(1);
    });

    it("reads events after a seq in order with their payloads", () => {
      const sessionId = "s1";
      store.createSession(sessionId, "C1", "active", Date.now() + 1000);
      store.appendEvent(sessionId, "chat", JSON.stringify({ text: "a" }));
      store.appendEvent(sessionId, "timer", JSON.stringify({ action: "start" }));
      store.appendEvent(sessionId, "cinema", JSON.stringify({ playing: true }));

      const after = store.getEventsAfterSeq(sessionId, 1);
      expect(after.map((e) => e.seq)).toEqual([2, 3]);
      expect(after.map((e) => e.event)).toEqual(["timer", "cinema"]);
      expect(JSON.parse(after[0].payload_json)).toEqual({ action: "start" });

      const range = store.getEventsRange(sessionId, 2, 3);
      expect(range.map((e) => e.seq)).toEqual([2, 3]);
      expect(store.getEventsAfterSeq(sessionId, 3)).toEqual([]);
    });

    it("prunes events keeping only the most recent", () => {
      const sessionId = "s1";
      store.createSession(sessionId, "C1", "active", Date.now() + 1000);
      for (let i = 1; i <= 5; i++) {
        store.appendEvent(sessionId, "chat", JSON.stringify({ i }));
      }

      const removed = store.pruneEvents(sessionId, 2);
      expect(removed).toBe(3);
      expect(store.getEventCount(sessionId)).toBe(2);
      expect(store.getEventsAfterSeq(sessionId, 0).map((e) => e.seq)).toEqual([4, 5]);

      // Pruning past the end deletes nothing.
      expect(store.pruneEvents(sessionId, 2)).toBe(0);
    });

    it("deletes the event log when a session closes or expires", () => {
      const s1 = "s1";
      store.createSession(s1, "C1", "active", Date.now() + 1000);
      store.appendEvent(s1, "chat", "{}");
      store.closeSession(s1);
      expect(store.getEventCount(s1)).toBe(0);

      const s2 = "s2";
      store.createSession(s2, "C2", "active", Date.now() + 1000);
      store.appendEvent(s2, "chat", "{}");
      store.expireSession(s2);
      expect(store.getEventCount(s2)).toBe(0);
    });
  });
});
