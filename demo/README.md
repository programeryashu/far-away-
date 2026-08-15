# Orbit — Far Away demo kit

Everything needed to run and pitch Orbit at the hackathon.

| File | What it is |
|---|---|
| `script.md` | The 2–3 minute hero demo: exact sequence, speaker lines, device setup, fallback plan, and the pre-demo live test checklist. |
| `pitch.md` | 12-slide deck structure, positioning, competitive distinction, differentiators, and the 20-second technical explanation. |
| `architecture.md` | Simple two-diagram architecture explanation (system + data flow). |
| `architecture.svg` | The architecture diagram as a standalone image. |
| `assets/` | Real screenshots captured from the actual application. |

## Golden rules

- The demo is **deterministic**: Shared Moment never depends on an AI provider (deterministic fallback is the guaranteed path; AI only enhances it).
- Every screenshot in `assets/` is from the real app — no fake mockups.
- AWS is **stopped** to save credits. Start the EC2 instance ~10 minutes before the demo and run the pre-demo checklist in `script.md`.

## AI provider smoke test (optional, after the demo)

The live AI path is only exercised if a real provider key exists **server-side** (`.env`: `AI_PROVIDER` + `AI_API_KEY`; never in the bundle). Without a key, the same endpoint returns the deterministic fallback — that is the guaranteed demo path.

Smoke command against any running instance (local or production):

```bash
curl -s -X POST <base>/api/shared-moment/recommend -H "content-type: application/json" -d '{
  "participantA": {"city":"Delhi","timezone":"Asia/Kolkata","localTime":"8:30 PM","hour":20.5},
  "participantB": {"city":"Tokyo","timezone":"Asia/Tokyo","localTime":"11:00 PM","hour":23},
  "bestWindow": {"label":"8:30 PM — 9:15 PM","minutes":45},
  "overlapActive": true,
  "distanceKm": 5840,
  "availableActivities": ["timer","cinema","canvas","chat"]
}'
```

Expected: `{"source":"deterministic",...}` with a schema-valid activity/duration. With a key configured, `source` becomes `"ai"` and the UI behaves identically.
