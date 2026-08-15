# Orbit — Architecture (simple version)

Two diagrams tell the whole story. `architecture.svg` is the printable image.

## 1. System

```
 User A            User B
   │                  │
   ▼                  ▼
 Orbit Client     Orbit Client
   │                  │
   └─────► Connection ◄────┘
           │  local: BroadcastChannel
           │  remote: WebSocket
           ▼
        Session Hub
           │
           ▼
       Event Log
           │
           ▼
        SQLite
```

- The **Connection** abstraction hides the transport — the UI never branches between local and remote.
- The **Session Hub** validates every frame against one Zod protocol, assigns a monotonic per-session sequence, persists to SQLite, and broadcasts.
- **Reconnect** = send `state-request { afterSeq }` → the hub replays missed events in order, or falls back to a snapshot. Dedup is client-side by sequence.

## 2. Shared Moment data flow

```
 Time + Location Facts        (JavaScript — deterministic)
        │  local times · overlap window · distance
        ▼
     Shared Moment
        │  deterministic rules → recommendation
        │  (AI optional: interprets the same facts)
        ▼
   Recommendation             (validated with Zod)
        │  activity · duration
        ▼
    Start Together
        │
        ▼
   Realtime Event             (the SAME event system as everything else)
```

Key principle: **facts are computed, never guessed.** AI interprets facts; it never calculates them, and it can never execute an action directly — only a validated recommendation can become a realtime event.

## One-liner for judges

> "One protocol, one event sequence, one database. The AI makes a recommendation; the realtime system makes it real — and replays it if you blink."
