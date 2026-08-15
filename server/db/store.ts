import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { migrations, type Session, type Peer, type Message, type CanvasSnapshot, type TimerState, type CinemaState, type SessionEvent } from "./schema.js";

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.runMigrations();
  }

  private runMigrations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const applied = this.db
      .prepare("SELECT id FROM schema_migrations")
      .all() as { id: number }[];
    const appliedIds = new Set(applied.map((m) => m.id));

    for (const migration of migrations) {
      if (!appliedIds.has(migration.id)) {
        console.log(`Applying migration: ${migration.name}`);
        this.db.exec("BEGIN");
        try {
          this.db.exec(migration.sql);
          this.db
            .prepare(
              "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
            )
            .run(migration.id, migration.name, Date.now());
          this.db.exec("COMMIT");
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
      }
    }
  }

  // Session methods
  createSession(id: string, code: string, status: string, expiresAt: number) {
    this.db
      .prepare(
        "INSERT INTO sessions (id, code, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, code, status, Date.now(), expiresAt);
  }

  getSession(id: string): Session | null {
    return this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as unknown as Session | null;
  }

  getSessionByCode(code: string): Session | null {
    return this.db
      .prepare("SELECT * FROM sessions WHERE code = ?")
      .get(code) as unknown as Session | null;
  }

  // ... (similar casts for other methods)

  closeSession(id: string) {
    // Retention: sessions are ephemeral — closing one discards its event log
    // (replay only matters while a peer could still reconnect).
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?",
        )
        .run(Date.now(), id);
      this.db.prepare("DELETE FROM session_events WHERE session_id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  expireSession(id: string) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE sessions SET status = 'expired' WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM session_events WHERE session_id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  countActiveSessions(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'active'")
        .get() as { count: number }
    ).count;
  }

  // Peer methods
  addPeer(
    id: string,
    sessionId: string,
    role: "a" | "b",
    displayName: string,
    cityJson: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO peers (id, session_id, role, display_name, city_json, joined_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, role, displayName, cityJson, Date.now(), Date.now());
  }

  getPeer(id: string): Peer | null {
    return this.db.prepare("SELECT * FROM peers WHERE id = ?").get(id) as unknown as Peer | null;
  }

  getPeers(sessionId: string): Peer[] {
    return this.db
      .prepare("SELECT * FROM peers WHERE session_id = ?")
      .all(sessionId) as unknown as Peer[];
  }

  getPeerByRole(sessionId: string, role: "a" | "b"): Peer | null {
    return this.db
      .prepare("SELECT * FROM peers WHERE session_id = ? AND role = ?")
      .get(sessionId, role) as unknown as Peer | null;
  }

  updatePeerLastSeen(id: string, at: number = Date.now()) {
    this.db
      .prepare("UPDATE peers SET last_seen = ? WHERE id = ?")
      .run(at, id);
  }

  removePeer(id: string) {
    this.db.prepare("DELETE FROM peers WHERE id = ?").run(id);
  }

  countPeers(sessionId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) as count FROM peers WHERE session_id = ?")
        .get(sessionId) as { count: number }
    ).count;
  }

  // Message methods
  addMessage(
    id: string,
    sessionId: string,
    senderPeer: string,
    senderName: string,
    text: string,
    seq: number,
  ) {
    this.db
      .prepare(
        "INSERT INTO messages (id, session_id, sender_peer, sender_name, text, ts, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, senderPeer, senderName, text, Date.now(), seq);
  }

  getMessages(sessionId: string): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as unknown as Message[];
  }

  getMessagesAfterSeq(sessionId: string, seq: number): Message[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(sessionId, seq) as unknown as Message[];
  }

  getNextSequence(sessionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM messages WHERE session_id = ?",
        )
        .get(sessionId) as { next_seq: number }
    ).next_seq;
  }

  // Canvas methods
  updateCanvasSnapshot(sessionId: string, strokesJson: string) {
    this.db
      .prepare(
        "INSERT INTO canvas_snapshots (session_id, strokes_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET strokes_json = ?, updated_at = ?",
      )
      .run(sessionId, strokesJson, Date.now(), strokesJson, Date.now());
  }

  getCanvasSnapshot(sessionId: string): CanvasSnapshot | null {
    // node:sqlite returns undefined (not null) for a missing row — normalize
    // to null so the state envelope matches the nullable schema field.
    const row = this.db
      .prepare("SELECT * FROM canvas_snapshots WHERE session_id = ?")
      .get(sessionId) as unknown as CanvasSnapshot | undefined;
    return row ?? null;
  }

  // Timer methods
  upsertTimerState(
    sessionId: string,
    action: "start" | "pause" | "reset",
    endAt: number,
    remaining: number,
  ) {
    this.db
      .prepare(
        "INSERT INTO timer_state (session_id, action, end_at, remaining, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET action = excluded.action, end_at = excluded.end_at, " +
          "remaining = excluded.remaining, updated_at = excluded.updated_at",
      )
      .run(sessionId, action, endAt, remaining, Date.now());
  }

  getTimerState(sessionId: string): TimerState | null {
    const row = this.db
      .prepare("SELECT * FROM timer_state WHERE session_id = ?")
      .get(sessionId) as unknown as TimerState | undefined;
    return row ?? null;
  }

  // Cinema methods — the shared watch's only state is play/pause, persisted
  // so a fresh joiner inherits it from the authoritative snapshot (the event
  // log alone cannot restore it for an afterSeq=0 client).
  upsertCinemaState(sessionId: string, playing: boolean) {
    this.db
      .prepare(
        "INSERT INTO cinema_state (session_id, playing, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET playing = excluded.playing, updated_at = excluded.updated_at",
      )
      .run(sessionId, playing ? 1 : 0, Date.now());
  }

  getCinemaState(sessionId: string): CinemaState | null {
    // SQLite stores the boolean as 1/0 — the raw row is read with a numeric
    // playing so the normalization below is intentional, then mapped to the
    // boolean the schema and the rest of the app expect.
    const row = this.db
      .prepare("SELECT session_id, playing, updated_at FROM cinema_state WHERE session_id = ?")
      .get(sessionId) as unknown as
      | { session_id: string; playing: number; updated_at: number }
      | undefined;
    return row ? { session_id: row.session_id, playing: row.playing === 1, updated_at: row.updated_at } : null;
  }

  // Identity
  updatePeerIdentity(id: string, displayName: string, cityJson: string) {
    this.db
      .prepare("UPDATE peers SET display_name = ?, city_json = ? WHERE id = ?")
      .run(displayName, cityJson, id);
  }

  // Session event log (the durable per-session event stream)

  /**
   * Append one event, allocating the next per-session seq atomically. Two
   * concurrent appends for the same session can never receive the same seq:
   * the MAX+1 allocation and the insert happen inside one transaction.
   */
  appendEvent(sessionId: string, event: string, payloadJson: string): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const next = (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM session_events WHERE session_id = ?",
          )
          .get(sessionId) as { next_seq: number }
      ).next_seq;
      this.db
        .prepare(
          "INSERT INTO session_events (session_id, seq, event, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(sessionId, next, event, payloadJson, Date.now());
      this.db.exec("COMMIT");
      return next;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getEventsAfterSeq(sessionId: string, seq: number): SessionEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(sessionId, seq) as unknown as SessionEvent[];
  }

  getEventsRange(sessionId: string, fromSeq: number, toSeq: number): SessionEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM session_events WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC",
      )
      .all(sessionId, fromSeq, toSeq) as unknown as SessionEvent[];
  }

  getLatestEventSeq(sessionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_events WHERE session_id = ?",
        )
        .get(sessionId) as { max_seq: number }
    ).max_seq;
  }

  getEventCount(sessionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?",
        )
        .get(sessionId) as { count: number }
    ).count;
  }

  /**
   * Retention cap for long-lived active sessions: keep only the most recent
   * `keepCount` events. Never call this while a peer might still need older
   * events — replay beyond the retained range falls back to the full state
   * snapshot, so pruning is safe but makes catch-up coarser.
   */
  pruneEvents(sessionId: string, keepCount: number): number {
    const result = this.db
      .prepare(
        "DELETE FROM session_events WHERE session_id = ? AND seq <= (SELECT seq FROM (SELECT seq FROM session_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?))",
      )
      .run(sessionId, sessionId, Math.max(0, keepCount));
    return Number(result.changes);
  }

  // State
  getSessionState(sessionId: string) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const peers = this.getPeers(sessionId);
    const messages = this.getMessages(sessionId);
    const canvas = this.getCanvasSnapshot(sessionId);
    const timer = this.getTimerState(sessionId);
    const cinema = this.getCinemaState(sessionId);
    return { session, peers, messages, canvas, timer, cinema };
  }

  close() {
    this.db.close();
  }
}
