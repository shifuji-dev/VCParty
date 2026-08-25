# 🔗 NexusParty

A **group voice-chat party app** that costs **$0/month** — one room, many free
providers, automatic re-routing. Built on the multi-provider "Hydra"
architecture: when a service hits its limit, goes down, or misbehaves, the
supervisor switches the room to the next free alternative.

## 🚀 Run it

```bash
cd nexusparty
python3 -m http.server 3000     # or any static server
```

No build step, no backend, no accounts, no API keys.

## 🧩 The engines (media providers)

| Engine | Tier | Cost | Notes |
|---|---|---|---|
| **P2P mesh · decentralized signaling** (Trystero: Nostr relays → BitTorrent trackers) | mesh | $0 unlimited | default for ≤ 8 seats; no server at all |
| **P2P mesh · PeerJS cloud** | mesh | $0 unlimited | free public signaling; audio survives signaling death |
| **Jitsi Meet · public SFU** | sfu | $0 unlimited | full room UI in an iframe; join is accountless |
| **Daily.co · BYO free tier** | sfu | 10k min/mo free | paste your room URL in ⚙️ providers; auto-metered, rotated at 85% |
| **Jitsi · self-hosted** | sfu | $0 (your box) | paste your domain in ⚙️ providers |

All mesh media uses free Google/Cloudflare STUN + the Open Relay Project's
free TURN (20 GB/mo) for NAT traversal.

## 🛡️ How the fallback works

1. **Cross-provider room discovery** — joining tries engines in ranked order
   and connects to the one where the room actually lives (each provider is its
   own namespace; no central registry, no coordination server).
2. **Live supervision** — real probes (ICE `srflx`/`relay` tests, endpoint
   reachability), per-provider circuit breakers, and a quota ledger for
   metered engines.
3. **Migration without dead air** — the engine picker or the deck's
   "kill current engine" re-routes the room while your mic stays open.
4. **Serverless by default** — with mesh engines, media is browser ↔ browser:
   even if every server dies, the call keeps flowing.

## 📁 Repo map

| Path | What |
|---|---|
| **`nexusparty/`** | The app (this is the thing to run) |
| `app/` | Earlier PoC (voice party + failover simulator) |
| `docs/01-what-i-learned.md` | Analysis of the studied courses/videos |
| `docs/02-free-stack-research.md` | Deep research on every free tier |
| `docs/03-fallback-architecture.md` | The full multi-provider architecture design |

## 🗺️ Roadmap

- [ ] Agora / LiveKit adapters (same interface; bring your own free-tier keys)
- [ ] Supabase presence + Firestore mirror for cross-engine room directories
- [ ] Self-hosted coturn + PeerServer recipes for Oracle Always-Free VM
- [ ] Room seats > 8 via SFU auto-escalation
