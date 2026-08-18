export interface Session {
  id: string;
  code: string;
  status: string;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
}

export interface Peer {
  id: string;
  session_id: string;
  role: 'a' | 'b';
  display_name: string;
  city_json: string;
  joined_at: number;
  last_seen: number;
  /**
   * SHA-256 hex of the peer's session-scoped secret token (issued at join).
   * Only the joining client ever sees the token itself; the hash is what the
   * server stores and compares. Empty for legacy rows that predate tokens.
   */
  token_hash: string;
}

export interface Message {
  id: string;
  session_id: string;
  sender_peer: string;
  sender_name: string;
  text: string;
  ts: number;
  seq: number;
}

export interface CanvasSnapshot {
  session_id: string;
  strokes_json: string;
  updated_at: number;
}

export interface TimerState {
  session_id: string;
  action: 'start' | 'pause' | 'reset';
  end_at: number;
  remaining: number;
  updated_at: number;
}

export interface CinemaState {
  session_id: string;
  /** Current play/pause of the shared watch. */
  playing: boolean;
  /** Media position in seconds, stored alongside `updated_at`. */
  position: number;
  /** The movie chosen together (Watch 2.0), parsed from `movie_json`. */
  movie: import("../../shared/protocol.js").SelectedMovie | null;
  updated_at: number;
}

export interface SessionEvent {
  id: number;
  session_id: string;
  /** Per-session monotonic sequence — allocated by the store, never by clients. */
  seq: number;
  event: string;
  /** Server-shaped payload (validated against the protocol before persistence). */
  payload_json: string;
  created_at: number;
}

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        closed_at INTEGER NULL
      );

      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('a', 'b')),
        display_name TEXT NOT NULL,
        city_json TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sender_peer TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canvas_snapshots (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        strokes_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(code);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_peers_session_id ON peers(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
    `,
  },
  {
    id: 2,
    name: "timer_state",
    sql: `
      CREATE TABLE IF NOT EXISTS timer_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('start', 'pause', 'reset')),
        end_at INTEGER NOT NULL,
        remaining INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: "session_events",
    sql: `
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session_seq ON session_events(session_id, seq);
    `,
  },
  {
    id: 4,
    name: "cinema_state",
    sql: `
      CREATE TABLE IF NOT EXISTS cinema_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        playing INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: 5,
    name: "cinema_position",
    sql: `
      ALTER TABLE cinema_state ADD COLUMN position REAL NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 6,
    name: "peer_token_hash",
    sql: `
      ALTER TABLE peers ADD COLUMN token_hash TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    id: 7,
    name: "cinema_movie",
    sql: `
      ALTER TABLE cinema_state ADD COLUMN movie_json TEXT NOT NULL DEFAULT '';
    `,
  },
];
