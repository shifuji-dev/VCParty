# 🎧 VCParty

A **group voice-chat party app** that runs on **$0/month** — built on the
multi-provider, self-switching "Hydra" architecture: when one free service hits
its quota, goes down, or misbehaves, the supervisor automatically re-routes the
room to the next free alternative without interrupting the party.

## Repo map

| Path | What |
|---|---|
| **`app/`** | ⚡ Working proof-of-concept web app: real P2P mesh voice party + live multi-provider fallback supervisor (health probes, quota ledger, circuit breaker, failover simulator) |
| `docs/01-what-i-learned.md` | Everything learned from the studied playlists & videos (Agora course, ZEGOCLOUD Android, Tencent TUILiveKit/Yalla, WebRTC fundamentals, mesh Zoom-clone, Firebase chat, Clubhouse product) |
| `docs/02-free-stack-research.md` | Deep research: every free tier for media, signaling, STUN/TURN, hosting, DBs, auth, storage — with limits, sources, and a risk register |
| `docs/03-fallback-architecture.md` | The multi-provider, self-switching architecture: adapter layer, supervisor, make-before-break migration, per-layer fallback chains, failure walkthroughs |

## Quick start

```bash
cd app
python3 -m http.server 3000   # or any static server
```

Open it in two tabs (or two devices), pick a room name, and talk — free,
serverless, and self-healing.

## The 10-second pitch

```
8 seats  → P2P mesh WebRTC            ($0, unlimited, server-crash-proof)
>8 seats → LiveKit/Agora/Daily/100ms  (10k free minutes each, rotated at 85%)
exhausted→ self-hosted SFU on Oracle Always-Free VM (unlimited, still $0)
signaling→ Trystero(torrent/nostr) → Supabase → Firebase → PeerJS cloud
NAT      → Google/CF STUN → OpenRelay TURN (20GB/mo) → self-host coturn
```

Cut one head off — another takes over. The party never stops.
