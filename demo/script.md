# Orbit — Hero demo script (2:30)

## Setup (before the audience arrives)

- **Devices:** two real devices (laptop + phone, or two laptops) on any network — same WiFi is fine.
- **City pair:** pick the pair with a live overlap at demo time. Pre-check right before:
  - Open the app on both devices in **local mode**, set the two cities, and check the Shared Moment card says the window is **live** (not "Bridge the gap").
  - Default pair to try: **Delhi ⇄ London** (4.5 h apart, almost always overlapping in a daytime/evening IST slot). If the demo runs very late (after ~00:30 IST), **Delhi ⇄ Tokyo** overlaps instead.
  - The app computes overlap from the *actual* current time — do this check, don't guess.
- **AI provider:** leave `AI_PROVIDER=none`. The deterministic recommendation is the guaranteed path. If a key is configured, the same card simply gets AI-refined — the demo flow is identical.
- **Production:** start the EC2 instance ~10 min before and run the pre-demo checklist (below). Use the production URL, not localhost, so the judges' devices can join.
- **Optional:** keep a second browser tab in local mode as an emergency "second device".

## Speaker script (2:30)

**0:00–0:20 — Problem**

> "Distance doesn't just separate people. It gives them different moments. A 9 PM text lands at 2:30 AM. A 'good morning' arrives at someone's night. The distance isn't the problem — the *mismatched moment* is."

**0:20–0:40 — Introduce Orbit**

> "Orbit is a shared-presence space for people who aren't physically together. It understands *where* each person is, *when* each person is, and what time they actually share — then gives them something to do in that shared moment."

**0:40–1:00 — Create + join**

> "Device A creates a session." *(click Create a connection)* "Device B joins with the code — or the invite link." *(B types the code / opens the link)* "Both of us are now live in the same session, from two different cities."

**1:00–1:20 — Shared Moment**

> *(point at the two local times and the overlap)* "Right now it's 7:40 PM in Delhi and 3:10 PM in London — about two hours of comfortable overlap. Orbit turns that into a recommendation, sized to the time we actually have."

**1:20–1:40 — Start Together**

> *(click Start Together)* "One click, and the activity starts on **both** devices at once — through the same realtime session that runs the whole app, not a demo trick."

**1:40–2:10 — Disconnect + replay**

> *(turn off B's WiFi / close the laptop lid briefly)* "Real life happens. B drops off the network — but the session keeps going, and every event is being logged. Watch A keep working." *(A starts another activity)* "Now B reconnects." *(reconnect B)* "Orbit doesn't just reconnect users — it *reconstructs* what happened while they were away, in order: the message, the timer change, everything. Nothing is lost, nothing is duplicated."

**2:10–2:30 — Close**

> "Orbit makes distance feel less like absence, and more like a different place in the same moment. Two places. One moment."

> *Judges question about technology:* see the 20-second explanation in `pitch.md`.

## Exact sequence (checklist form)

1. [ ] A creates session (code visible)
2. [ ] B joins with code/invite link
3. [ ] Both peers online (Live Window)
4. [ ] "When you're both free" section shows both cities, local times, overlap window
5. [ ] Recommendation appears (deterministic source)
6. [ ] Click **Start Together** → activity starts on both devices
7. [ ] B disconnects (airplane mode / WiFi off)
8. [ ] A sees B offline; A runs another activity
9. [ ] B clicks **Reconnect** (or reconnects automatically)
10. [ ] Missed events replay in order (no duplicates)
11. [ ] Live sync resumes (B sees the next action live)

## Failure plan

| Failure | Fallback |
|---|---|
| Second device unavailable | Local mode + a second browser tab (BroadcastChannel sync) — *explicitly label* "local mode" if asked. Never fake cross-device. |
| AI provider unavailable | Default. Deterministic Shared Moment is the demo path anyway. |
| Network drops mid-demo | That's the feature — reconnect + replay. If both devices lose everything, restart a fresh session. |
| Session expires / breaks | Create a new session (takes 5 seconds); keep the same narrative. |
| AWS not started | Run the resume procedure (~5 min) or demo against localhost — but always state what the audience is seeing. |
| No live overlap at demo time | Use the "Bridge the gap" recommendation — a message to open the session — or switch city pair per the pre-check. |

## Pre-demo live test checklist (run once, right before)

On **production** (after starting EC2 + EIP + cert):

1. [ ] `curl https://<url>/api/health` → `{"ok":true,...,"database":"connected"}`
2. [ ] A creates session, B joins by code — both role-checked
3. [ ] Chat A→B and B→A
4. [ ] Shared Moment shows a recommendation; Start Together starts the activity on both
5. [ ] Timer / cinema / canvas each sync once
6. [ ] B disconnects → A does one action → B reconnects → replay in order → live resumes
7. [ ] Leave returns to local mode cleanly
8. [ ] Browser consoles on both devices: no errors

(Full automated version: the 57-check acceptance script used in Phase 7.)
