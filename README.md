# 🛰️ Orbit

> **"Distance doesn't just separate people. It gives them different moments. Orbit makes those moments shared."**

Orbit is a shared-presence platform for people who are physically far apart. Two people in different cities get a live shared space — their local times, their real overlap, a recommendation for what to do together — and everything they do in it stays synchronized, even across disconnects.

Built for the **Far Away** hackathon.

---

## 🎯 The pitch

Long-distance connections don't fail because people stop caring. They fail because distance creates invisible friction: wrong-time texts, missed overlap windows, shared moments that don't feel shared.

Orbit makes the distance **visible and bridgeable**:

- **See the moment.** Both people's local times and the real overlap window between their timezones.
- **Decide together.** *Shared Moment* recommends one concrete activity — a timer, a movie, a canvas, a chat — sized to the overlap you actually have.
- **Do it together.** One click starts the activity on **both** devices through a realtime session, not a simulation.
- **Stay together.** Every event is persisted and replayed, so a dropped connection never loses what you were doing.

Orbit is **shared presence + shared activities + shared time** — not another chat app.

---

## ✨ Features

| Feature | What it does |
|---|---|
| **Sessions** | Create a session, share a short code/link, join from another device. Server-assigned A/B roles. |
| **Presence** | Live peer-joined / peer-left state; reconnect is seamless and never duplicates state. |
| **Shared Moment** | Deterministic time/location facts (local times, overlap, distance) interpreted into a recommendation — refined by AI when configured, deterministic otherwise. **Start Together** executes it through the realtime event system. |
| **Chat** | Two-way messages with server-acknowledged delivery, monotonic ordering, persisted history. |
| **Ping / RTT** | Live round-trip latency meter. |
| **Shared Timer** | Start / pause / reset synchronizes on both devices and survives reconnect. |
| **Shared Canvas** | Real-time strokes + clear, persisted and replayed. |
| **SynchroCinema** | Play/pause shared movie sessions. |
| **Identity** | Display name + city are server-authoritative, survive reload, and replay to the other peer. |
| **Timezone Sync** | Live clocks, overlap planner, distance visualization. |
| **Local mode** | The full UI works offline in a single browser; two-tab sync via BroadcastChannel. |

## 🧠 How it works

```
Device A ─┐
          ├─ Orbit client → Connection (local BroadcastChannel or remote WebSocket)
Device B ─┘                              │
                                         ▼
                                   Session Hub ──► event log ──► SQLite
                                         │
                                         ▼
                              server-authoritative event sequence
```

- **One protocol.** `shared/protocol.ts` is the single Zod contract for every realtime event — validated on both boundaries.
- **Server-authoritative state.** The server assigns every event a monotonic per-session sequence and persists it to SQLite (`session_events`).
- **Replay, not re-push.** On reconnect the client sends `state-request { afterSeq }`; the server replays missed events in order, or falls back to a full snapshot. Duplicates are ignored client-side.
- **Unified transport.** Components talk to one `Connection` abstraction — BroadcastChannel locally, WebSocket remotely. No transport branches in the UI.
- **Shared Moment.** JavaScript computes the facts (local times, overlap window, haversine distance); an LLM (optional) interprets them into a recommendation; the recommendation is validated with Zod and executed through the *same* realtime event system. No AI, no problem — deterministic fallback.

## 🧰 Tech stack

- **React 19 + TypeScript 6 + Vite 8**
- **Fastify + @fastify/websocket** — REST + realtime backend
- **SQLite** (Node built-in driver) — sessions, peers, messages, event log, canvas/timer state
- **Zod** — single-source protocol contract
- **lucide-react** — icons
- ESLint 10 + react-hooks — zero warnings; `npm audit` — zero vulnerabilities

## 🏃 Getting started

```bash
npm install
npm run dev          # Vite → http://localhost:5173
npm run dev:server   # backend → http://127.0.0.1:8787 (separate terminal)
```

Two ways to experience it:

1. **Local mode** — the app works fully in one browser; open a second tab for two-tab sync.
2. **Remote session** — click **New Session**, share the code; the other device joins from the invite link. A WebSocket session starts with live presence, chat, timer, canvas, cinema, identity, and replay.

Checks:

```bash
npm run typecheck
npm test
npm run lint
npm run build       # client → dist/
npm run build:server # server → dist-server/
```

## 🔑 Environment

Copy `.env.example` to `.env` for the backend. Required: `HOST`, `PORT`, `LOG_LEVEL`, `ORIGINS`, `DATABASE_PATH`. Shared Moment is optional:

```
AI_PROVIDER=none        # or "openai-compatible"
AI_MODEL=
AI_API_KEY=             # never commit; server-side only
AI_BASE_URL=https://api.openai.com/v1
```

The API key never enters the browser bundle.

## 🚀 Production deployment

Deployed on a single AWS EC2 instance (t3.micro, Ubuntu 24.04): nginx serves the Vite build and proxies `/api/*` and `/ws` (WebSocket upgrade) to Fastify on `127.0.0.1:8787`, with SQLite on EBS, systemd for the app service, and Let's Encrypt for HTTPS/WSS. The deployment is reproducible from the repo: clone → `npm ci` → the checks above → systemd + nginx → certbot. See `demo/` for the runbook.

## 📁 Project structure

```
src/
├── App.tsx                     # session lifecycle, connection, layout
├── index.css                   # design system (neutral, quiet, accessible)
├── lib/
│   ├── connection.ts           # unified local/remote Connection abstraction
│   ├── realtime.ts             # WebSocket client + catch-up/dedup
│   ├── session.ts              # session state machine
│   ├── moment.ts               # Shared Moment facts + fetch + cache
│   ├── reconcile.ts            # server state → UI state
│   ├── time.ts / cities.ts / share.ts / broadcast.ts
└── components/
    ├── LiveWindow.tsx          # presence + peer status
    ├── SharedMoment.tsx        # recommendation + Start Together
    ├── ActivityFinder.tsx      # timer / canvas / SynchroCinema
    ├── ChatBox.tsx / PingMeter.tsx / DistanceVisualizer.tsx
    ├── TimezoneSync.tsx / LocationSelector.tsx

shared/
├── protocol.ts                 # Zod realtime protocol (single source of truth)
└── moment.ts                   # Shared Moment contract + deterministic rules

server/
├── app.ts / index.ts / config.ts
├── realtime/session-hub.ts     # WS handling, event log, replay, broadcast
├── db/store.ts + schema.ts     # SQLite
├── routes/                     # sessions, health, shared-moment
└── ai/shared-moment.ts         # provider abstraction (OpenAI-compatible)
```

## 🎤 Demo materials

`demo/` contains the hero demo script, pitch deck structure, architecture diagram, failure plan, and real screenshots for the Far Away hackathon.

## 📜 License

Private hackathon project — built with ♥ for **Far Away**.
