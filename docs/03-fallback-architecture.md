# 🛡️ Part 3 — The Multi-Provider, Self-Switching, $0 Architecture ("VCParty Hydra")

> **The idea, accepted:** instead of betting on one free service, we wire **every** free alternative behind a single app and let a supervisor auto-switch when a service hits its quota, goes down, or misbehaves — without the user noticing anything except (at worst) a 1–2 s audio blip and a tiny toast: *"re-routed via LiveKit ✓"*.
>
> Why "Hydra": cut one head off, another takes over — the party never stops.

---

## 1. Design principles

1. **Provider-agnostic core.** The app talks only to internal interfaces (`MediaEngine`, `SignalingBus`, `PresenceStore`, `AuthProvider`, `TurnProvider`, `MirrorRouter`). Concrete providers are plugins.
2. **Room-level stickiness, global fallback.** Everyone in room X must be on the *same* media engine at the same time. The supervisor chooses **per room**; a global registry broadcasts the choice.
3. **Fail small before failing big.** Ladder: *same provider reconnect → cheaper/simpler provider → degraded mode (listen-only)* — never a dead end.
4. **Proactive, not reactive.** Rotate at **85% quota**, on rising error-rate/latency, or on N missed heartbeats — *before* the hard error.
5. **Live state lives in the ephemeral layer** (presence/signaling), persistent state in a mirrored DB. A DB dying must never kill an in-progress party.
6. **Guest-first identity.** No auth vendor is on the critical path to hear audio.
7. **Zero cost invariant.** Every chain ends in something unlimited-but-self-managed (mesh / self-host on Oracle free VM), not in a credit card.

## 2. System map

```
┌────────────────────────────────────────────────────────────────────────┐
│                            CLIENT (SPA, static)                        │
│                                                                        │
│  ┌─────────────┐   ┌──────────────────────────────────────────────┐   │
│  │  Party UI    │   │            SUPERVISOR (client-side)          │   │
│  │  seats/mic/  │◄──┤  • HealthProber  (pings all providers)       │   │
│  │  chat/gifts  │   │  • QuotaLedger   (local + KV-synced meters)  │   │
│  └──────┬──────┘   │  • Scorer        (health,quota,latency,seat#) │   │
│         │          │  • CircuitBreaker(cooldowns, half-open probes)│   │
│  ┌──────▼───────┐  │  • MigrationPlanner (make-before-break swap)  │   │
│  │ APP CORE     │  └───────────────┬──────────────────────────────┘   │
│  │ (state machine│                  │ choice + events                   │
│  │  lobby/room)  │◄─────────────────┘                                 │
│  └──────┬───────┘                                                    │
└─────────┼──────────────────────────────────────────────────────────────┘
          │ internal interfaces only
  ┌───────┼─────────┬──────────────┬───────────────┬─────────────────┐
  ▼       ▼         ▼              ▼               ▼                 ▼
┌────────────┐ ┌──────────┐ ┌────────────┐ ┌─────────────┐ ┌──────────────┐
│MediaEngine │ │Signaling │ │Presence/DB │ │ TURN chain  │ │ MirrorRouter │
│ (adapter)  │ │ Bus      │ │ (adapter)  │ │             │ │ (host chain) │
├────────────┤ ├──────────┤ ├────────────┤ ├─────────────┤ ├──────────────┤
│ MeshPeerJS │ │ Trystero │ │ Supabase   │ │ Google STUN │ │ CF Pages ①   │
│ MeshTryster│ │  torrent │ │ Firestore  │ │ CF STUN     │ │ GitHub Pg ②  │
│ LiveKitCl. │ │  nostr   │ │ (mirror)   │ │ OpenRelay   │ │ Netlify  ③   │
│ Agora      │ │  mqtt    │ │ Turso/Neon │ │  TURN 20GB  │ │ Vercel   ④   │
│ Daily      │ ├──────────┤ │ (mirror)   │ │ coturn@Ora. │ │ (health-     │
│ Hundredms  │ │ Supabase │ │ Upstash    │ │  (unlimited)│ │  ordered)    │
│ VideoSDK   │ │ Firebase │ │ (ledger)   │ └─────────────┘ └──────────────┘
│ Jitsi      │ │ PeerJS   │ │ Auth: guest│
│ LiveKit-SH │ │ Metered  │ │  +Fb +Supa │
│ (Oracle VM)│ │ Ably/Push│ └────────────┘
└────────────┘ └──────────┘
```

## 3. The MediaEngine adapter (one API, every provider)

```ts
interface MediaEngine {
  id: string                       // 'mesh-peerjs' | 'livekit' | 'agora' | ...
  tier: 'mesh' | 'sfu' | 'sfu-selfhosted'
  maxSeats: number                 // mesh ≈ 8, sfu ≈ 30 (our cap), etc.
  minuteCost: 0 | 'free-quota'     // for the QuotaLedger
  isReady(cfg): Promise<boolean>   // can this browser+account use it now?
  join(room, identity, seat): Promise<Session>
}
interface Session {
  on(event: 'peerJoined'|'peerLeft'|'speaking'|'error'|'quotaNear'|'stats', cb)
  publish(audio: MediaStreamTrack): Promise<void>
  setMuted(m: boolean): void
  getRemoteAudio(): Record<peerId, MediaStreamTrack>
  sendControl(msg: {hand: boolean, gift?: Gift, inviteSeat?: number})  // over data channel / RTM
  leave(): Promise<void>
}
```

Every concrete engine is ~150–300 lines (they're all the same shape — proven by the Part-1 courses: Agora RTC maps to `join/publish/subscribe`, RTM maps to `sendControl`, PeerJS mesh maps to N×`call()` + data channels, Jitsi maps to its External API, LiveKit to `room.connect()`). Because the **UI only knows this interface**, swapping providers is invisible to the product code.

## 4. The Supervisor — brains of the fallback

### 4.1 HealthProber (runs every 30 s + on-demand)

| Layer | Real probe |
|---|---|
| Media CPaaS | SDK-preflight (e.g. Agora `checkSystemRequirements`), REST status pages, a 2-person "canary" join on a cold room |
| Signaling | WSS handshake to each strategy (Trystero torrent/nostr/mqtt, PeerJS `0.peerjs.com`, Supabase socket) |
| STUN/TURN | **Real ICE gathering test**: create `RTCPeerConnection` with the server config, count `srflx` (STUN works) / `relay` (TURN works) candidates with timeout — this is a genuine, dependency-free NAT-traversal check |
| DB / Auth | REST HEAD + a tiny read/write of a `heartbeat` doc |
| Hosting mirrors | `fetch(mirror + '/health.json', {mode:'no-cors'})` race |

### 4.2 QuotaLedger

- Every engine reports metered usage (e.g. participant-minutes = seats × wall-clock) to the ledger.
- Ledger is a local record synced to **Upstash Redis free tier** (500k cmd/mo is plenty) keyed `yyyy-mm:provider` — visible across all clients, so *any* client can discover "Agora is at 85% this month".
- **Rotation rule:** `usage/quota ≥ 0.85 →` new rooms stop using the provider; `≥ 0.98 →` trigger migration of live rooms. 10k min/mo × 5 providers ≈ **~50k min/mo** before ever touching self-host.

### 4.3 Scorer & CircuitBreaker

```
score(engine) = w1·health + w2·(1 − quotaUsed) + w3·latencyScore + w4·seatFit − penalties
```
- `seatFit`: rooms ≤ 8 may use mesh (cost 0, zero quota); bigger rooms need SFU engines.
- CircuitBreaker per provider: 3 failures in 60 s → OPEN (skip) 5 min → HALF-OPEN probe → CLOSED. Classic pattern, applied to vendors.
- Deterministic tiebreak: `hash(roomId + epoch10min)` — so all clients in the same room independently compute the *same* engine without needing to agree over a (possibly dead) channel.

### 4.4 MigrationPlanner — make-before-break (the "no interruption" trick)

```
1. DETECT     supervisor flags engine E failing / quota-critical for room R
2. AGREE      host (or DeterministicSelector) picks engine E2, announces via
              SignalingBus control message (falls back to: everyone recomputes
              deterministically from the same inputs)
3. PRE-JOIN   every client joins E2 while still connected to E
              ("dual-connected", mic muted on E2)          ← no dead air
4. HANDOFF    on "all seats present on E2" (or T+4 s timeout): unmute E2,
              fade E audio out over 300 ms, leave E
5. HEAL       CircuitBreaker opens on E; retry/half-open later; log event
```

User experience: a 200–400 ms crossfade between two live audio paths. Worst case with full signaling loss: everyone recomputes E2 deterministically and reconverges within seconds — the room URL is the shared truth.

## 5. Fallback chains per layer (summary card)

| Layer | ① primary | ② | ③ | ④ last resort (unlimited) |
|---|---|---|---|---|
| **Media (≤8 seats)** | Mesh via Trystero(torrent+n nostr redundancy) | Mesh via PeerJS cloud | Mesh via self-host PeerServer (Render/Koyeb) | direct RTCPeerConnection via any live signaling |
| **Media (>8 seats)** | LiveKit Cloud free | Agora 10k | Daily / 100ms / VideoSDK | self-host LiveKit SFU on Oracle ARM |
| **Signaling** | Trystero torrent | Trystero nostr/mqtt | Supabase Realtime | Firestore RTDB → PeerJS cloud |
| **NAT** | Google STUN | Cloudflare STUN | OpenRelay TURN (20 GB/mo) | coturn on Oracle VM |
| **Presence/DB** | Supabase (write) | Firestore (write-through mirror) | Turso/Neon (nightly sync) | in-memory + presence from media engine |
| **Auth** | guest keypair (local) | Supabase Auth | Firebase Auth | guest again (never blocks) |
| **Hosting** | Cloudflare Pages | GitHub Pages | Netlify | Vercel (ordered by MirrorRouter health race) |
| **Time/clock, gifts, text chat** | engine data channel | SignalingBus broadcast | DB poll | — |

## 6. Failure walkthroughs (how it feels)

| Incident | What the system does | User feels |
|---|---|---|
| PeerJS cloud dies mid-room (mesh room) | Prober marks OPEN; SignalingBus already on Trystero → media never depended on PeerJS after setup; new joins use Trystero | nothing |
| Agora hits 9.9k/10k minutes | Ledger crosses 85% → new rooms start on LiveKit; at 98% live rooms migrate (make-before-break) | 300 ms crossfade + toast |
| LiveKit Cloud region outage | 3 failed heartbeats → breaker OPEN → deterministic recompute picks Agora/Daily → dual-join handoff | ≤2 s blip |
| Supabase (presence+DB) down | UI presence falls back to engine events (peerJoined/Left) + Firestore mirror; party audio unaffected (mesh is P2P!) | avatars may lag; audio perfect |
| Cloudflare Pages blocked in user's country | MirrorRouter's health race picks Netlify mirror on load | site loads anyway |
| All CPaaS exhausted (huge month) | All rooms ladder down: SFU → mesh ≤8 seats → self-host LiveKit on Oracle (always-on, free) | bigger rooms split, party continues |
| User behind symmetric NAT | STUN finds no srflx pair → ICE relay via OpenRelay TURN; coturn after 20 GB | nothing |

## 7. Honest limits of the design

- **Make-before-break doubles brief CPU/mic usage** during handoff — fine on desktop, acceptable on modern phones.
- **Deterministic selection needs synced clocks-ish inputs** (we use 10-minute epochs; skew just means a staggered rejoin, self-healing).
- **Provider ToS:** rotating *accounts* to multiply quotas violates most ToS — we rotate **providers**, never fake accounts. Vercel Hobby mirrors must be non-commercial.
- **Self-host tier needs one-time setup** (Oracle ARM VM + Docker: LiveKit/coturn/PeerServer) — free forever but requires a card for verification.
- Jitsi public server as an engine is join-side excellent but its room-creation login + ~35-participant practical ceiling make it a fallback, not a primary.

## 8. Proof of concept (this repo, `/app`)

The included PoC implements the **Supervisor core for real**:

- 📡 **Live multi-provider health board** — real probes: ICE/STUN gathering test (actual `RTCPeerConnection` with Google + Cloudflare STUN), TURN relay candidate test against Open Relay's public free TURN, HTTPS reachability for PeerJS cloud & meet.jit.si.
- 🧮 **Scorer + CircuitBreaker + deterministic room hashing** — the exact selection algorithm from §4.3.
- 🎛 **Failover simulator** — kill a provider, watch automatic re-selection with the event log; a **real working P2P voice party** (PeerJS mesh, active-speaker glow, mute, seats, names) that survives the signaling server dying after setup — the deepest fallback, demonstrated live.
- See `app/README.md` for controls.
