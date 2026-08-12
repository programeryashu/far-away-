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
});
