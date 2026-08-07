# 🛰️ Far Away Connection Hub

> **"How far is *far away*?" — and what does distance do to a relationship?**

Far Away Connection Hub turns distance into data. Pick two people anywhere on Earth and the app computes the real space between them — the kilometers, the latency a packet would feel crossing that gap, the overlapping hours where both are actually awake — then gives them a shared space to bridge it: a chat with visible routing, a synced movie session, a shared canvas, and a focus timer.

Built as a hackathon MVP for **Far Away Zuup**.

---

## 🚀 The pitch

Long-distance relationships — friends, family, partners — don't fail because people stop caring. They fail because **distance creates invisible friction**: wrong-time texts, missed overlap windows, shared moments that don't feel shared.

Far Away Connection Hub makes that friction **visible and bridgeable**:

- **See** the real distance, and the literal latency a message travels.
- **Know** when both people are actually awake and free — with a slider to plan a meeting slot.
- **Do** things together that feel live: chat with a visible routing path, a synced watch-session, a shared whiteboard, and a focus timer that runs for both.

It's a *connection intelligence layer* for the people you're far from.

---

## ✨ Features

| Module | What it does | Real / Simulated |
|---|---|---|
| **Location Selector** | Pick any two cities (global geocoding via OpenStreetMap Nominatim) or use your **current GPS location**. 11 curated fallback cities work fully offline. | Real |
| **Orbital Distance Matrix** | Haversine great-circle distance, live fiber-optic vs. Starlink latency estimates, animated signal particles along a curved connection map. | Real math, animated |
| **Temporal Chronology** | Live clocks in both timezones, UTC offsets, per-user activity status (😴 sleeping / 💼 working / ☕ free), and a **24-hour connection planner** slider showing when both are awake. | Real |
| **Sub-orbital Chat** | Chat with simulated routing animation — a message visibly "traverses" an undersea fiber route proportional to the real distance, then gets a context-aware auto-reply (based on the partner's actual local hour). | Routing simulated, timezone-aware replies real |
| **Synchronized Activities** | **SynchroCinema** (play/pause with sync logs), **Galactic Canvas** (a DPR-crisp shared whiteboard with a simulated partner drawing back), **Deep Space Coffee** (a working shared 25-min Pomodoro timer). | Interactions real, partner responses simulated |

> **Honest by design:** this is a single-browser MVP — the *partner side* of chat, canvas, and cinema is simulated client-side. The math (distance, timezones, overlap) and the local interactions (drawing, the timer) are 100% real. The simulated seams are exactly where a real backend would plug in (see [Roadmap](#roadmap)).

---

## 🧰 Tech stack

- **React 19** + **TypeScript 6** — typed, component-based UI
- **Vite 8** — instant dev server, ~75 kB gzipped production bundle
- **lucide-react** — icons
- **OpenStreetMap Nominatim API** — forward + reverse geocoding (no API key needed)
- **Native browser APIs** — `Intl.DateTimeFormat` (timezone math), `navigator.geolocation`, `localStorage`, `ResizeObserver`, Canvas 2D
- **ESLint 10** + react-hooks/react-compiler rules — zero lint warnings, zero `npm audit` vulnerabilities

---

## 🏃 Getting started

```bash
npm install      # install dependencies
npm run dev      # start the dev server → http://localhost:5173
```

Production build:

```bash
npm run build    # type-check + production build → dist/
npm run preview  # serve the production build
npm run lint     # ESLint (must be clean)
```

---

## 🔗 Share a connection

Hit **Share Connection** in the header — it copies a URL that encodes both users and their cities. Open it anywhere (another laptop, a phone, a judge's machine) and the exact same connection appears:

```
https://…/?a=Yash&ac=San+Francisco&alat=37.7749&alng=-122.4194&atz=America%2FLos_Angeles&b=Kimi&bc=Tokyo&blat=35.6762&blng=139.6503&btz=Asia%2FTokyo
```

State also persists to `localStorage`, so refresh is safe. URL params win, then saved state, then the default (San Francisco ⇄ Tokyo).

---

## 🧠 How it works

### Distance & latency
Great-circle distance is computed with the **Haversine formula** (`R=6371 km`). Latency is modeled with physical intuition: light in fiber optic glass ≈ 200,000 km/s, radio in vacuum ≈ 300,000 km/s (+ ~15 ms uplink/downlink overhead for the satellite leg). The chat's routing label is picked from the same distance: <500 km → direct fiber, <8,000 km → undersea segment, beyond → trans-Pacific backbone + Starlink hop.

### Timezone math
Everything is derived from `Intl.DateTimeFormat.formatToParts()` against each city's IANA timezone — no hand-rolled offset tables. The overlap planner works in *local hours*: you drag hour A and it derives hour B = (A + ΔTZ) mod 24, then checks whether both are in the 07:00–23:00 awake window.

### Geocoding
`src/lib/cities.ts` centralizes the city model, the offline fallback list, and a coordinate→timezone approximation. When Nominatim is unreachable the app degrades gracefully to local fallback matches — the demo never hard-crashes.

---

## 📁 Project structure

```
src/
├── main.tsx                     # React entry
├── App.tsx                      # layout, state, persistence, share link
├── index.css                    # design tokens + global styles (glassmorphism theme)
├── lib/
│   ├── cities.ts                # CityData model, fallback cities, geocoding helpers, TZ guesser
│   └── share.ts                 # share-URL build/parse + state validation
└── components/
    ├── LocationSelector.tsx     # city picker + geolocation
    ├── DistanceVisualizer.tsx   # Haversine distance + latency + connection map
    ├── TimezoneSync.tsx         # live clocks + overlap planner
    ├── ChatBox.tsx              # chat with simulated routing
    └── ActivityFinder.tsx       # SynchroCinema + Galactic Canvas + Deep Space Coffee
```

---

## 🎤 Demo script (for judges — ~3 minutes)

1. **The question:** *"How far is far away?"* — open with two default cities: San Francisco ⇄ Tokyo (8,235 km).
2. **Make it personal:** type two names; click **Use my location** on one side to drop in your real GPS city.
3. **The wow:** point at the ~41 ms fiber vs. ~42 ms Starlink latency and explain what it means — *"your message literally travels that gap."*
4. **Find the overlap:** pull the **24-Hour Connection Planner** slider until both users show ☕ — that's a real, computed meeting slot.
5. **Send a message:** type one, watch the routing animation, read the auto-reply (it's aware of the partner's *actual* local hour).
6. **Do something together:** start **SynchroCinema**, draw on the **Galactic Canvas** (partner draws back), hit **Start Shared Timer** and watch the Pomodoro tick.
7. **Share it:** click **Share Connection**, open the URL on your phone — the same connection appears. Persistence + share in one move.

---

## 🗺️ Roadmap

What this MVP *proves* is the concept; the real product replaces every simulation with a backend:

- **Real-time sync** — WebSockets/WebRTC so two browsers genuinely share chat, canvas, cinema, and timer state (the current sims already expose the exact hooks to swap in).
- **SSE/WebSocket chat** with true delivery + read receipts.
- **Auth & rooms** — named rooms, invite links, presence (online/away).
- **User timezone-aware scheduling** — compute the *next N* real overlap windows from actual availability, not just awake-hours.
- **Media sync** — real synchronized playback over a signaling channel (like the movie-sync extensions).
- **PWA** — offline fallback cities already work; add offline chat queueing for the "asynchronous messages" story.

---

## 📜 License

Private hackathon project — built with ♥ for **Far Away Zuup**.
