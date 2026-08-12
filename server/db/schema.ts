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
];
