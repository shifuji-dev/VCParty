/* ═══════════════════════════════════════════════════════════════════
   VCParty·Hydra — Fallback Supervisor
   Health prober (real network/ICE tests) + quota ledger + circuit
   breaker + deterministic scorer. Framework-free on purpose: this same
   logic ports to React/Flutter/Android untouched (pure functions +
   side-effecting probes).
   ═══════════════════════════════════════════════════════════════════ */
window.Supervisor = (() => {
  'use strict';

  /* ───────────── engine registry (the fallback pool) ───────────── */
  const ENGINES = [
    { id:'mesh-peerjs',  label:'Mesh P2P · PeerJS cloud signaling', tier:'mesh',           maxSeats:8,  quotaPct:null, probe:'peerjs',   note:'media is serverless — $0 forever' },
    { id:'livekit',      label:'LiveKit Cloud · free tier',          tier:'sfu',            maxSeats:30, quotaPct:14,  probe:null,       note:'~10k participant-min/mo' },
    { id:'agora',        label:'Agora · 10k min/mo free',            tier:'sfu',            maxSeats:30, quotaPct:37,  probe:null,       note:'the stack from the studied course' },
    { id:'daily',        label:'Daily.co · 10k min/mo free',         tier:'sfu',            maxSeats:30, quotaPct:6,   probe:null,       note:'' },
    { id:'hundredms',    label:'100ms · 10k min/mo free',            tier:'sfu',            maxSeats:30, quotaPct:3,   probe:null,       note:'prebuilt UIs' },
    { id:'videosdk',     label:'VideoSDK · 10k min/mo free',         tier:'sfu',            maxSeats:30, quotaPct:0,   probe:null,       note:'cheapest overage' },
    { id:'jitsi',        label:'Jitsi Meet public SFU',              tier:'sfu',            maxSeats:35, quotaPct:null, probe:'jitsi',   note:'unlimited free, ~35 active' },
    { id:'selfhost',     label:'Self-host LiveKit · Oracle free VM', tier:'sfu-selfhosted', maxSeats:60, quotaPct:null, probe:null,       note:'unlimited — last resort' },
  ];

  const state = {
    engines: ENGINES.map(e => ({ ...e, killed:false, breaker:'closed', health:undefined, healthTs:0, fails:[] })),
    current: null,          // engine id chosen for the active room
    epoch: 0,               // deterministic selection epoch (10-min buckets)
    listeners: [],
  };

  /* ───────────── events ───────────── */
  const byId = id => state.engines.find(e => e.id === id);
  const log = [];
  function emit(level, msg) {
    const t = new Date().toLocaleTimeString();
    log.unshift({ t, level, msg });
    state.listeners.forEach(fn => fn(log[0], log));
  }
  function onEvent(fn){ state.listeners.push(fn); }

  /* ───────────── circuit breaker ───────────── */
  function recordFailure(id, why) {
    const e = byId(id); if (!e) return;
    e.fails.push(Date.now());
    e.fails = e.fails.filter(ts => Date.now() - ts < 60_000);
    if (e.breaker !== 'open' && e.fails.length >= 3) {
      e.breakerOpenUntil = Date.now() + 5 * 60_000;
      e.breaker = 'open';
      emit('bad', `⛔ circuit breaker OPEN → ${e.label} (${e.fails.length} fails/60s: ${why})`);
      reselect('breaker-open');
    } else {
      emit('warn', `⚠️ failure #${e.fails.length} on ${e.id}: ${why}`);
    }
    notify();
  }
  function recordSuccess(id) {
    const e = byId(id); if (!e) return;
    e.fails = [];
    if (e.breaker !== 'closed') emit('ok', `✅ circuit breaker CLOSED → ${e.label} healthy again`);
    e.breaker = 'closed';
    notify();
  }
  function breakerOf(e) {
    if (e.breaker === 'open') return (Date.now() > (e.breakerOpenUntil||0)) ? 'half' : 'open';
    return 'closed';
  }

  /* ───────────── real probes ───────────── */
  const PROBES = {};
  let probeResults = {};   // id → {ok, ms, detail}
  let probeListeners = [];

  // genuine ICE gathering test — look for srflx (STUN) or relay (TURN) candidates
  PROBES.ice = (name, iceServers, want) => new Promise(resolve => {
    const t0 = performance.now();
    let pc;
    const done = (ok, detail) => {
      try { pc && pc.close(); } catch(_){}
      resolve({ ok, ms: Math.round(performance.now() - t0), detail });
    };
    const timer = setTimeout(() => done(false, 'timeout'), 7000);
    try {
      pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 0 });
      pc.createDataChannel('probe');
      pc.onicecandidate = ev => {
        if (!ev.candidate) { clearTimeout(timer); done(false, 'no matching candidate'); return; }
        if (ev.candidate.candidate.includes(`typ ${want}`)) {
          clearTimeout(timer); done(true, `${want} candidate gathered`);
        }
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timer); done(false, 'gathering done, no match'); }
      };
      pc.setLocalDescription().catch(() => { clearTimeout(timer); done(false, 'SDP error'); });
    } catch (err) { clearTimeout(timer); done(false, String(err)); }
  });

  // opaque reachability fetch (network path check; no CORS semantics)
  PROBES.http = (name, url) => new Promise(resolve => {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    fetch(url, { mode:'no-cors', signal: ctl.signal, cache:'no-store' })
      .then(() => { clearTimeout(timer); resolve({ ok:true, ms: Math.round(performance.now()-t0), detail:'reachable (opaque)' }); })
      .catch(err => { clearTimeout(timer); resolve({ ok:false, ms: Math.round(performance.now()-t0), detail:String(err).slice(0,60) }); });
  });

  const PROBE_DEFS = [
    { id:'stun-google',  name:'Google STUN',        kind:'ice',  arg:{ iceServers:[{ urls:'stun:stun.l.google.com:19302' }] }, want:'srflx', helps:'mesh-peerjs' },
    { id:'stun-cf',      name:'Cloudflare STUN',    kind:'ice',  arg:{ iceServers:[{ urls:'stun:stun.cloudflare.com:3478' }] },  want:'srflx', helps:'mesh-peerjs' },
    { id:'turn-openrelay', name:'OpenRelay TURN (free 20GB/mo)', kind:'ice', arg:{ iceServers:[{
        urls:['turn:staticauth.openrelay.metered.ca:80','turn:staticauth.openrelay.metered.ca:443'],
        username:'openrelayproject', credential:'openrelayprojectsecret' }]}, want:'relay', helps:'mesh-peerjs' },
    { id:'peerjs-cloud', name:'PeerJS cloud (0.peerjs.com)', kind:'http', arg:'https://0.peerjs.com/peerjs/peerjs.min.js', helps:'mesh-peerjs' },
    { id:'jitsi-public', name:'meet.jit.si SFU',    kind:'http', arg:'https://meet.jit.si/robots.txt', helps:'jitsi' },
    { id:'dicebear',     name:'DiceBear avatar API',kind:'http', arg:'https://api.dicebear.com/9.x/bottts-neutral/svg?seed=vcparty-health', helps:'ui' },
  ];

  async function runProbes() {
    emit('info', '🩺 running live infrastructure probes…');
    const jobs = PROBE_DEFS.map(async def => {
      const r = def.kind === 'ice'
        ? await PROBES.ice(def.name, def.arg, def.want)
        : await PROBES.http(def.name, def.arg);
      probeResults[def.id] = { ...r, name:def.name, helps:def.helps, def };
      const eng = state.engines.find(e => e.id === def.helps);
      if (eng) {
        if (r.ok) { eng.health = 1; eng.healthTs = Date.now(); recordSuccess(eng.id); }
        else if (eng.health !== undefined || def.id === 'peerjs-cloud') { eng.health = 0; recordFailure(eng.id, `${def.name} probe failed`); }
      }
      probeListeners.forEach(fn => fn(probeResults));
      return r;
    });
    await Promise.allSettled(jobs);
    emit('info', '🩺 probes complete — scores updated');
    reselect('probes-updated');
    return probeResults;
  }
  function onProbe(fn){ probeListeners.push(fn); }
  function getProbeResults(){ return probeResults; }

  /* ───────────── deterministic hash (room-level consensus without a server) ───────────── */
  function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  const epochBucket = () => Math.floor(Date.now() / (10 * 60 * 1000));

  /* ───────────── scorer + selection ───────────── */
  const QUOTA_ROTATE = 85, QUOTA_HARD = 98;

  function scoreOf(e, seats, roomId, epoch) {
    if (e.killed)                        return { s:-Infinity, why:'manually killed' };
    if (breakerOf(e) === 'open')         return { s:-Infinity, why:'breaker open' };
    if (e.quotaPct !== null && e.quotaPct >= QUOTA_HARD) return { s:-Infinity, why:`quota ≥ ${QUOTA_HARD}%` };
    if (seats > e.maxSeats)              return { s:-Infinity, why:`${seats} seats > ${e.maxSeats} cap` };

    const health = e.health ?? 0.5;                                  // unknown = neutral
    const quotaHeadroom = e.quotaPct === null ? 1 : 1 - e.quotaPct / 100;
    const tierBonus = { mesh:0.30, 'sfu-selfhosted':0.16, sfu:0.22 }[e.tier];
    const jitter = (hash32(`${roomId}|${epoch}|${e.id}`) / 0xFFFFFFFF) * 0.05;
    const s = 0.35 * health + 0.25 * quotaHeadroom + tierBonus + jitter;
    const why = e.quotaPct !== null && e.quotaPct >= QUOTA_ROTATE ? 'quota ≥ 85% — deprioritized (proactive rotation)' : 'eligible';
    return { s:+s.toFixed(3), why };
  }

  function rank(seats, roomId, epoch = epochBucket() + (state.epoch || 0)) {
    return state.engines
      .map(e => ({ e, ...scoreOf(e, seats, roomId, epoch) }))
      .sort((a, b) => b.s - a.s);
  }

  function select(seats, roomId, cause) {
    const ranked = rank(seats, roomId);
    const winner = ranked[0].s > -Infinity ? ranked[0] : null;
    const prev = state.current;
    if (!winner) {
      state.current = null;
      emit('bad', `💀 no provider available for ${seats} seats — all fallbacks exhausted (should never happen: restore one!)`);
    } else if (winner.e.id !== prev) {
      state.current = winner.e.id;
      const lvl = prev === null || prev === undefined ? 'info' : 'ok';
      emit(lvl, `🔀 [${cause}] room "${roomId}" (${seats} seats) routed → ${winner.e.label} · score ${winner.s}` +
          (prev ? ` (was ${prev})` : ''));
    }
    notify();
    return { ranked, winner };
  }
  function reselect(cause) {
    const roomId = state.roomId || 'party-time';
    const seats = state.seats || 5;
    return select(seats, roomId, cause || 'reselect');
  }

  /* ───────────── mutation ops for the demo ───────────── */
  function kill(id, silent) {
    const e = byId(id); if (!e) return;
    e.killed = true;
    if (!silent) emit('bad', `⚡ SIMULATED OUTAGE → ${e.label} is down`);
    reselect('outage');
  }
  function killRandom() {
    const pool = state.engines.filter(e => !e.killed && breakerOf(e) !== 'open');
    if (!pool.length) return;
    kill(pool[Math.floor(Math.random() * pool.length)].id);
  }
  function setQuota(id, pct) {
    const e = byId(id); if (!e) return;
    const was = e.quotaPct;
    e.quotaPct = pct;
    if (was !== null && pct >= QUOTA_ROTATE && was < QUOTA_ROTATE)
      emit('warn', `📉 ${e.label} crossed ${QUOTA_ROTATE}% quota — new rooms will avoid it`);
    if (was !== null && pct >= QUOTA_HARD && was < QUOTA_HARD)
      emit('bad', `🛑 ${e.label} hit ${QUOTA_HARD}% — hard stop, live rooms migrate`);
    reselect('quota');
  }
  function restoreAll() {
    state.engines.forEach(e => { e.killed = false; e.breaker = 'closed'; e.fails = []; });
    emit('ok', '💚 all providers restored — breakers closed');
    reselect('restore');
  }

  /* ───────────── pub/sub for UI ───────────── */
  const subs = [];
  function notify(){ const snap = snapshot(); subs.forEach(fn => fn(snap)); }
  function subscribe(fn){ subs.push(fn); fn(snapshot()); }
  function snapshot() {
    return {
      engines: state.engines.map(e => ({ ...e, breaker: breakerOf(e) })),
      current: state.current,
      ranked: rank(state.seats || 5, state.roomId || 'party-time'),
    };
  }
  function setContext(roomId, seats) { state.roomId = roomId; state.seats = seats; }

  return { state, select, reselect, rank, kill, killRandom, setQuota, restoreAll,
           runProbes, onProbe, getProbeResults, recordFailure, recordSuccess,
           onEvent, getLog: () => log, subscribe, setContext, hash32, QUOTA_ROTATE, QUOTA_HARD };
})();
