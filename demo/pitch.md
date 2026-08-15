# Orbit — Pitch materials

## One-line pitch

> "Distance doesn't just separate people. It gives them different moments. Orbit makes those moments shared."

## 30-second pitch

> "Orbit is a shared-presence platform for people who are physically far apart. It reads where each person is and what time it is for each of them, computes the window they actually share, and recommends one concrete thing to do in that window — a focus session, a movie, a canvas, a conversation. One click starts it on both devices. And because every event is persisted and replayed, a dropped connection never loses the shared moment. Not a chat app. Shared presence, shared activities, shared time."

## 20-second technical explanation (for judges)

> "Orbit uses a shared realtime session layer — WebSockets, SQLite persistence, and a server-authoritative event sequence. Every event is persisted and replayed after reconnect, so a temporary disconnection never loses shared activity. For Shared Moment, time and location facts — local times, overlap, distance — are calculated deterministically. AI interprets those facts into an activity recommendation, which is validated and then executed through the same realtime event system. If AI is unavailable, the deterministic rules produce the recommendation directly."

(Do not expand into implementation detail unless asked.)

---

## Deck — 12 slides

| # | Title | Key message |
|---|---|---|
| 1 | **Orbit** | "Shared moments, even when you're far apart." (product hero shot) |
| 2 | **The Problem** | Distance creates different moments, clocks, and routines. A 9 PM text lands at 2:30 AM. |
| 3 | **The Insight** | Communication is not the same as shared presence. Tools connect people; they don't synchronize their time. |
| 4 | **The Product** | Orbit shared-presence experience — two cities, two clocks, one live space. |
| 5 | **How It Works** | Create → Join → Shared Moment → Start Together → Stay synchronized. |
| 6 | **Reliability** | Realtime + persisted events + replay after reconnect. "Reconnects aren't restarts." |
| 7 | **AI** | Shared Moment Intelligence: deterministic facts + AI interpretation — the AI never does the math. |
| 8 | **Demo** | Live flow (or screenshots if live fails). |
| 9 | **Why Orbit is different** | Not another chat app — it synchronizes *moments* and *shared activities*. |
| 10 | **Future** | More shared activities, smarter time coordination, broader use cases. |
| 11 | **Impact / Use cases** | Long-distance couples, friends, families, remote teammates, students, people across time zones. |
| 12 | **Team** | Members + roles. |

Keep slides visually minimal: one idea, one visual, big type, quiet color.

## Competitive positioning

Do **not** claim Orbit replaces WhatsApp, FaceTime, Discord, or Zoom.

- **Existing tools:** communication.
- **Orbit:** shared presence + shared activities + shared time.

The distinction in one line: *"Others connect your devices. Orbit synchronizes your moments."*

## Hackathon differentiators (strongest six — not a tech list)

1. **Shared Moment Intelligence** — time facts computed, AI interpretation, validated action, executed by the existing realtime system.
2. **Cross-device shared activities** — timer, canvas, cinema, chat genuinely synchronized.
3. **Server-authoritative realtime state** — one protocol, one event sequence, no client-side authority.
4. **Offline event replay** — disconnect → reconnect reconstructs the missed window in order.
5. **Session lifecycle** — codes, A/B roles, presence, expiry, stale-seat reclaim, clean leave.
6. **Product-quality UX** — quiet, accessible, professional; the product, not the tech, is the story.

## Visual assets needed

| Asset | Source |
|---|---|
| Hero screenshot | `demo/assets/hero.png` |
| Create-session screenshot | `demo/assets/session-create.png` |
| Connected two-person screenshot | `demo/assets/connected.png` |
| Shared Moment screenshot | `demo/assets/shared-moment.png` |
| Offline/replay screenshot | `demo/assets/replay.png` |
| Architecture diagram | `demo/architecture.svg` |

All screenshots are captured from the real application.
