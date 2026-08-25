# 🔍 Part 2 — Deep Research: Building a Group Voice Chat Party App for $0

Question: **can a real group voice-chat app run entirely on free infrastructure?** Answer: **yes — with a smart combination and fallbacks.** Below is the layer-by-layer research (checked against 2025–2026 sources, links inline).

---

## 1. The three ways to move voice (and which are free)

| Approach | How it works | Cost | Group limit |
|---|---|---|---|
| **P2P mesh WebRTC** | Every browser sends audio directly to every other browser. Needs only a *signaling* channel + STUN/TURN | **$0 — forever** (media never touches a server) | ~4–8 comfortable; ~10–12 max (each peer uploads N−1 streams) |
| **Self-hosted SFU** | Open-source media server (LiveKit, Jitsi, mediasoup, Janus) forwards streams; each peer uploads once | **$0 software** (Apache-2.0); needs a host with UDP ports | Hundreds+, host-bound |
| **Managed CPaaS free tiers** | Agora/LiveKit Cloud/Daily/100ms/ZEGOCLOUD run the SFU for you | **$0 up to monthly free minutes** | Large |

Sources: [PeerJS FAQ](https://peerjs.com/client/faq) (mesh ≈ 5–10 connections/peer before degradation, use an SFU beyond), [WebRTC fundamentals](https://dev.to/softheartengineer/how-to-build-real-time-video-chat-applications-with-webrtc-471n) (server needed only for signaling; TURN for 5–10% of connections).

## 2. Managed voice/video platforms — the free-minute pool

Every account gets a monthly grant; rotating across accounts is NOT allowed by most ToS, but **stacking several providers behind one app with automatic failover is legitimate** — that's the Part-3 design.

| Provider | Free tier | Overage | Notes |
|---|---|---|---|
| **Agora** | **10,000 min/month** per account, forever (audio+HD video) | $0.99/1k audio min | The course from Part 1 runs on this; RTM chat included (500 MAU) |
| **LiveKit Cloud** | Free Build tier (~5–10k participant-min/mo + 50 GB) | $0.0004–0.0005/min | **Open-source SFU you can also self-host — the only major one** |
| **Daily.co** | 10,000 min/month | $0.004/min | Dead-simple web SDK |
| **100ms** | 10,000 min/month | ~$0.004/min | Prebuilt UI components |
| **VideoSDK** | 10,000 min/month | from $0.0006/min | Cheapest overage |
| **ZEGOCLOUD** | 10,000 free minutes | from $0.59/1k min | Sources 2/3/8 of Part 1 |
| **Cloudflare RealtimeKit** | Free (beta) | — | SFU-shaped, may change |
| **Twilio Video** | trial credit only | — | ⚠️ Programmable Video sunset — avoid |
| **Jitsi (meet.jit.si)** | **Unlimited, accountless, forever** | — | Open-source; embeddable via IFrame/External API; ~35 active participants practical on public server; creating rooms now asks for a Google/GitHub/Facebook login, joining doesn't |

Sources: [PkgPulse comparison](https://www.pkgpulse.com/guides/livekit-vs-agora-vs-100ms-real-time-video-audio-sdks-2026), [checkthat.ai LiveKit pricing](https://checkthat.ai/brands/livekit/pricing), [Forasoft Agora cost guide](https://www.forasoft.com/blog/article/agora-custom-development-services), [ajianaz Agora review](https://ajianaz.dev/agora-io-platform-pricing-is-it-the-right-real-time-communication-sdk-for-your-app/), [VideoSDK comparison](https://www.videosdk.live/agora-vs-livekit), [extrasafe Jitsi overview](https://www.extrasafe.chat/blog/jitsi-app-overview-2025), [jitsi.guide integration](https://jitsi.guide/blog/jitsi-meet-add-your-site-app/), [checkthat Jitsi](https://checkthat.ai/brands/jitsi-meet).

**Cumulative free pool from just 5 providers ≈ 40–50k participant-minutes/month ≈ 666–833 party-hours/month** — e.g. a room of 10 people partying 2 h/day uses ~600 min/day ≈ 18k min/month. One provider covers casual use; the pool covers a community.

## 3. Free signaling & peer discovery (the "matchmaker")

| Option | Free limits | Setup |
|---|---|---|
| **PeerJS public cloud** (`0.peerjs.com`) | Free, donation-funded, **no SLA** | none — `new Peer()` |
| **Self-hosted PeerServer** | free software, run on any free host | docker image `peerjs/peerjs-server` |
| **Trystero** 🌟 | **BitTorrent trackers / Nostr relays / MQTT brokers / IPFS** — decentralized, zero-setup, zero-account; plus managed Firebase & Supabase strategies | none — one import line per strategy |
| **Metered Realtime** | 100 peak conns, 100k msgs/month | publishable key |
| **Supabase Realtime** | 200 concurrent conns, 100 msg/s, 100 channel-joins/s (free plan) | free project |
| **Firebase Realtime DB / Firestore** | RTDB ~100 simultaneous conns (Spark); Firestore 50k reads & 20k writes/day, 1 GiB | free project |
| **Ably** | 200 conns, 6M msgs/month | free key |
| **Pusher Channels** | 200 conns, 200k msgs/day | free key |
| **Socket.io self-hosted** | unlimited (your host) | free host |

Sources: [Trystero docs](https://npm.io/package/trystero) (strategies, `relayRedundancy`, encrypted SDP), [PeerJS FAQ](https://peerjs.com/client/faq) & [PeerJS alternatives analysis](https://medium.com/@jamesbordane57/peerjs-alternatives-in-2026-free-turn-auto-reconnect-and-which-webrtc-library-to-actually-pick-716efbdf55f2) (cloud has outages; no TURN included), [Metered Open Relay page](https://www.metered.ca/tools/openrelay/), [Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits), [Pusher alternatives comparison](https://www.buildmvpfast.com/alternatives/pusher-channels).

> Trystero is the proof that **signaling can have built-in multi-provider fallback** — it already connects to *several* BitTorrent trackers / Nostr relays simultaneously with `relayRedundancy` and lets you swap strategy with one import. We adopt the same idea at every layer.

## 4. Free STUN / TURN (NAT traversal)

| Resource | Free allowance |
|---|---|
| **Google STUN** `stun:stun.l.google.com:19302` | unlimited, no key |
| **Cloudflare STUN** `stun:stun.cloudflare.com:3478` | free |
| **Open Relay Project (Metered)** — `staticauth.openrelay.metered.ca:80/443`, TCP+UDP+TLS, public creds | **20 GB TURN/month** |
| **coturn self-hosted** (Oracle Cloud Always-Free VM) | unlimited, your box |

Sources: [Open Relay Project](https://www.metered.ca/tools/openrelay/) (20 GB/mo, ports 80/443, TURNS+SSL, Nextcloud-style static auth `openrelayproject` / `openrelayprojectsecret`), [STUN setup on Stack Overflow](https://stackoverflow.com/questions/71855307/how-to-setup-stun-server-in-a-video-chat-app-built-using-simple-peer), [Google STUN list](https://medium.com/@jamesbordane57/google-stun-server-list-97251ec590fe).

Rule of thumb: ~5–10% of connections need TURN; audio-only ≈ ~0.06 GB/participant-hour → 20 GB ≈ **~330 relay-hours/month free**.

## 5. Free hosting (frontend + API + WebSocket server)

| Platform | Free tier | Notes |
|---|---|---|
| **Cloudflare Pages** | **unlimited sites, unlimited bandwidth**, 500 builds/mo, Workers 100k req/day | best primary for a static SPA |
| **Vercel Hobby** | 100 GB bandwidth, 1M function invocations | non-commercial use only |
| **Netlify** | ~300 credits/mo (~15–30 GB BW, ~20 builds) | credit-based since Sep 2025 |
| **GitHub Pages** | 100 GB/mo soft | perfect permanent mirror |
| **Render free** | 750 hr/mo web service (512 MB), sleeps after 15 min idle | runs our Node/Socket.io/PeerServer; cold start 30–60 s |
| **Koyeb / Deno Deploy** | free service / 100 GB egress, edge functions | mirrors |
| **Oracle Cloud Always Free** | **4 ARM VMs (24 GB RAM total!) + 200 GB disk, forever** | ⭐ the free tier that can run a **self-hosted LiveKit SFU, coturn, Jitsi** — needs card for verification, never charged while in Always-Free scope |
| **Firebase Hosting** | 10 GB storage / 10 GB transfer | another mirror |

Sources: [agentdeals hosting comparison](https://agentdeals.dev/hosting-free-tier-comparison-2026), [snapdeploy tests](https://snapdeploy.dev/blog/deploy-website-free-2026-complete-guide), [klymentiev comparison](https://klymentiev.com/blog/free-website-hosting), [guptadeepak Jamstack](https://guptadeepak.com/tools/top-5-static-site-hosting-jamstack-platforms-2026/), [PeerServer-on-Cloud-Run writeup](https://gonzalohirsch.com/blog/virtually-free-peer-js-server-on-gcp/).

**Mirror strategy = hosting fallback:** the same static bundle deployed to 3–4 of these; a 2-line `mirrors.js` (or a Worker) ordered by health → the app itself falls back if a host is down or blocked in a country.

## 6. Free databases (rooms registry, profiles, history)

| DB | Free | Killer feature for us |
|---|---|---|
| **Supabase** | 500 MB Postgres, **50k MAU auth**, 1 GB files, Realtime included, unlimited API | primary store + presence backup |
| **Firebase Firestore** | 1 GiB, 50k reads/day, 20k writes/day | secondary/mirror + Trystero signaling |
| **Neon** | 0.5 GB/project (grows to ~10 GB), branching | serverless mirror |
| **Turso** | 5–9 GB, 500M row reads/mo | huge free storage |
| **MongoDB Atlas M0** | 512 MB | document mirror |
| **CockroachDB serverless** | 10 GiB, 50M RUs | biggest SQL grant |
| **Cloudflare D1 / Upstash Redis** | 5 GB SQLite / 256 MB Redis (500k cmds/mo) | edge cache + rate/quota ledger |

Sources: [agentdeals DB comparison](https://agentdeals.dev/database-free-tier-comparison-2026), [apiscout DBaaS](https://apiscout.dev/guides/best-database-as-a-service-apis-2026), [cloudswap list](https://cloudswap.info/en/blog/free-cloud-database/), [uibakery Supabase pricing](https://uibakery.io/blog/supabase-pricing).

Important: **live room state should NOT live in the DB** — presence belongs in the signaling/presence layer (Supabase Realtime / Trystero / RTM). The DB only stores *persistent* things (profiles, room history, gift ledger). Then a DB outage can never kill an in-progress party.

## 7. Free authentication

| Provider | Free |
|---|---|
| **Firebase Auth** | 50k MAU (Google/Apple/Facebook/GitHub/email/anon) |
| **Supabase Auth** | 50k MAU + every OAuth provider |
| **WorkOS AuthKit** | first **1M users free** |
| **Auth0** | 25k MAU |
| **Clerk** | Hobby tier free (~10k–50k MAU by current plan) |
| **Keycloak / Logto / Better Auth (self-host)** | unlimited, free software |

Source: [merginit auth comparison](https://merginit.com/blog/13062026-free-auth-identity-providers-comparison).

For a party app the best "fallback-proof" identity is: **guest-first** — a locally-generated keypair identity + optional social login upgrade. Zero dependency on any auth vendor to get into a room.

## 8. Free storage, avatars, monitoring, domain

- **Avatars**: [DiceBear](https://www.dicebear.com) API (free, no key, generated SVG avatars) — no storage needed at all.
- **Object storage**: Supabase 1 GB, Cloudflare R2 free tier, Cloudinary free credits.
- **Uptime/health monitoring**: UptimeRobot (50 monitors), BetterStack free — watches our mirrors & provider endpoints.
- **Domain**: free subdomains (Cloudflare/vercel/netlify), community domains (`is-a.dev`, `js.org`), free Cloudflare DNS.
- **CI/CD**: GitHub Actions free minutes → auto-deploys to all mirrors on every push.

## 9. The verified $0 stack (what Part 3 builds on)

```
Frontend        Cloudflare Pages (primary) + GitHub Pages / Netlify / Vercel (mirrors)
Voice tier 1    P2P mesh WebRTC — PeerJS cloud/self-host, Trystero strategies — $0 unlimited
Voice tier 2    LiveKit Cloud / Agora / Daily / 100ms / VideoSDK — 10k min each / month
Voice tier 3    Self-hosted LiveKit or Jitsi on Oracle Always-Free ARM VM — unlimited
Signaling       Trystero (torrent/nostr/mqtt) → Supabase Realtime → Firebase → PeerJS cloud
NAT             Google/Cloudflare STUN → Open Relay TURN (20 GB/mo) → self-hosted coturn
Presence/data   Supabase (primary) + Firestore (mirror); live state in presence, not DB
Auth            Guest keypair → Firebase/Supabase social login (50k MAU each)
Monitoring      UptimeRobot + in-app provider health prober (see /app PoC)
Total cost      $0/month
```

### ⚠️ Honest risk register (free ≠ carefree)

1. **PeerJS public cloud has no SLA** and a real outage history → never the only signaling path.
2. **Mesh ceiling (~8 users)** → must ladder up to an SFU tier for big rooms.
3. **Quota cliffs** (10k min gone → hard errors mid-party) → proactive quota ledger + rotate at ~85%.
4. **Cold starts** on Render/Koyeb free dynos (15–60 s) → keep stateless fallbacks, wake-on-visit.
5. **ToS fine print**: Vercel Hobby = non-commercial; Oracle needs a card; free tiers can shrink (PlanetScale killed its free tier; Twilio killed Video) → the fallback architecture is also **future-proofing**.
6. **Meet.jit.si room-creation login** requirement (join remains open) → use it as joinable fallback, not primary creation path.
