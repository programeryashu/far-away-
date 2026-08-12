import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { migrations, type Session, type Peer, type Message, type CanvasSnapshot } from "./schema.js";

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
    this.db
      .prepare(
        "UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?",
      )
      .run(Date.now(), id);
  }

  expireSession(id: string) {
    this.db.prepare("UPDATE sessions SET status = 'expired' WHERE id = ?").run(id);
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

  updatePeerLastSeen(id: string) {
    this.db
      .prepare("UPDATE peers SET last_seen = ? WHERE id = ?")
      .run(Date.now(), id);
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
    return this.db
      .prepare("SELECT * FROM canvas_snapshots WHERE session_id = ?")
      .get(sessionId) as unknown as CanvasSnapshot | null;
  }

  // State
  getSessionState(sessionId: string) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const peers = this.getPeers(sessionId);
    const messages = this.getMessages(sessionId);
    const canvas = this.getCanvasSnapshot(sessionId);
    return { session, peers, messages, canvas };
  }

  close() {
    this.db.close();
  }
}
