# VCParty·Hydra — Proof of Concept

A static, zero-build, zero-cost web app that demonstrates the multi-provider
fallback architecture from `docs/03-fallback-architecture.md` — and includes a
**real, working group voice party** on top of it.

## What's inside

| File | Role |
|---|---|
| `js/supervisor.js` | The Fallback Supervisor: real health prober (ICE/STUN/TURN gathering tests + reachability), quota ledger, circuit breaker, deterministic scorer & room router |
| `js/party.js` | Media Engine #1: serverless P2P mesh voice (PeerJS cloud slot-claim rooms, free STUN/TURN, data-channel control plane, WebAudio speaking detection + BGM mixer) |
| `js/app.js` | UI glue: engine ladder, failover simulator, probe board, lobby/room, chat, gifts |
| `index.html` / `css/style.css` | Dark party UI |

## Run it

Any static server, e.g.:

```bash
cd app && python3 -m http.server 3000
# → http://localhost:3000
```

Then open the same room name in several tabs/devices to talk for free.

## What to try

1. **Health board** — STUN/TURN probes are *real* ICE gathering tests; watch `srflx`/`relay` candidates prove NAT traversal works.
2. **Kill a provider** (⚡ button) or drag a quota slider past **85% / 98%** — the room re-routes automatically and the event log narrates every decision (proactive rotation → hard stop → breaker open).
3. **Seats slider** — past 8 seats the mesh engine is excluded (P2P ceiling) and an SFU free tier wins; the ladder re-orders live.
4. **Join the party for real** — mic, seats, speaking glow, mute, raise hand, chat, gifts, generative BGM. Then kill the *signaling* provider mid-call: audio keeps flowing because media is browser→browser (the architecture's deepest fallback, demonstrated live).
5. **Simulate random outage** repeatedly — the deterministic selection keeps every client in the same room converging on the same engine.

## Honest notes

- The CPaaS engines (LiveKit/Agora/Daily/100ms/VideoSDK/self-host) are represented in the supervisor with real scoring/breaker/quota logic but their SDKs aren't wired in this PoC — adding each is ~150–300 lines behind the same `MediaEngine` interface (see docs §3). The mesh engine and all probes are fully real.
- PeerJS public cloud is donation-funded with no SLA — in production it would be one entry in the Trystero/self-host signaling chain (docs §5).
