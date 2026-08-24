/* NexusParty core · supervisor.js
   The multi-provider brain: engine registry, live probes, quota ledger
   (localStorage — survives reloads), circuit breakers, deterministic scorer.
   Engines are injected by main.js; this file knows nothing about specific
   providers, so new free providers drop in without touching this code.
*/

import { Net, ICE_SERVERS } from './net.js';

const QUOTA_ROTATE = 85, QUOTA_HARD = 98;
const LS = { quota: 'np_quota_v1', };

const nowMonth = () => new Date().toISOString().slice(0, 7);

function loadLedger() {
  try { return JSON.parse(localStorage.getItem(LS.quota)) || {}; } catch (_) { return {}; }
}
function saveLedger(l) { try { localStorage.setItem(LS.quota, JSON.stringify(l)); } catch (_) {} }

export function createSupervisor() {
  const engines = [];                 // defs registered by main.js
  const probes = [];                  // probe definitions
  const state = {
    health: {},                       // engineId → 0..1 (from probes)
    breaker: {},                      // engineId → {fails:[], openUntil}
    killed: {},                       // engineId → true (manual kill)
    quotaPct: {},                     // engineId → 0..100 (metered engines)
    current: null,
    roomId: 'party', seats: 5,
    log: [],
    settings: {},
  };
  const subs = [], eventSubs = [], probeSubs = [];
  let probeResults = {};

  /* ── events ── */
  function emit(level, msg) {
    const e = { t: new Date().toLocaleTimeString(), level, msg };
    state.log.unshift(e);
    if (state.log.length > 200) state.log.pop();
    eventSubs.forEach(fn => fn(e, state.log));
  }
  const onEvent = fn => eventSubs.push(fn);
  const notify = () => { const s = snapshot(); subs.forEach(fn => fn(s)); };

  /* ── registration ── */
  function register(def) {
    engines.push(def);
    if (def.metered) state.quotaPct[def.id] = usagePct(def.id);
  }
  function setSettings(settings) { state.settings = settings || {}; }

  /* ── quota ledger (participant-minutes per month) ── */
  function usagePct(id) {
    const def = engines.find(e => e.id === id);
    if (!def || !def.metered || !def.monthlyFree) return 0;
    const l = loadLedger();
    const used = (l[nowMonth()] || {})[id] || 0;
    return Math.min(100, Math.round((used / def.monthlyFree) * 100));
  }
  function addMinutes(id, minutes) {
    const def = engines.find(e => e.id === id);
    if (!def || !def.metered) return;
    const l = loadLedger();
    const m = l[nowMonth()] = l[nowMonth()] || {};
    m[id] = (m[id] || 0) + minutes;
    saveLedger(l);
    const before = state.quotaPct[id] || 0;
    state.quotaPct[id] = usagePct(id);
    if (before < QUOTA_ROTATE && state.quotaPct[id] >= QUOTA_ROTATE)
      emit('warn', `📉 ${def.label} crossed ${QUOTA_ROTATE}% of its free monthly quota — new rooms will prefer other providers`);
    if (before < QUOTA_HARD && state.quotaPct[id] >= QUOTA_HARD)
      emit('bad', `🛑 ${def.label} hit ${QUOTA_HARD}% — hard stop, live rooms must migrate`);
  }
  const setQuotaManual = (id, pct) => { state.quotaPct[id] = pct; notify(); };

  /* ── circuit breakers ── */
  function breakerOf(id) {
    const b = state.breaker[id];
    if (!b) return 'closed';
    if (b.openUntil && Date.now() < b.openUntil) return 'open';
    if (b.openUntil) return 'half';
    return 'closed';
  }
  function recordFailure(id, why) {
    const b = state.breaker[id] = state.breaker[id] || { fails: [], openUntil: 0 };
    b.fails.push(Date.now());
    b.fails = b.fails.filter(ts => Date.now() - ts < 60_000);
    const def = engines.find(e => e.id === id);
    if (b.fails.length >= 3 && breakerOf(id) !== 'open') {
      b.openUntil = Date.now() + 5 * 60_000;
      emit('bad', `⛔ breaker OPEN → ${def ? def.label : id} (${b.fails.length} failures/60s — cooling down 5 min)`);
      if (state.current === id) onCurrentFailed();
    } else {
      emit('warn', `⚠️ failure #${b.fails.length} on ${id}: ${String(why).slice(0, 80)}`);
    }
    notify();
  }
  function recordSuccess(id) {
    const b = state.breaker[id];
    if (b && (b.fails.length || b.openUntil)) {
      const def = engines.find(e => e.id === id);
      emit('ok', `✅ breaker CLOSED → ${def ? def.label : id} healthy`);
    }
    state.breaker[id] = { fails: [], openUntil: 0 };
    notify();
  }
  let onCurrentFailed = () => {};
  const setOnCurrentFailed = fn => { onCurrentFailed = fn; };

  /* ── probes ── */
  function addProbe(p) { probes.push(p); }
  async function runProbes() {
    emit('info', '🩺 probing infrastructure…');
    const engineOks = {};
    await Promise.all(probes.map(async p => {
      let r;
      if (p.kind === 'ice') r = await Net.iceProbe(p.arg, p.want);
      else r = await Net.fetchOk(p.url);
      probeResults[p.id] = { ...r, name: p.name };
      if (p.engines) p.engines.forEach(id => (engineOks[id] = engineOks[id] || []).push(r.ok));
      probeSubs.forEach(fn => fn(probeResults));
    }));
    // composite health: a provider is healthy if ANY of its probes can reach it
    Object.entries(engineOks).forEach(([id, oks]) => {
      state.health[id] = oks.some(Boolean) ? 1 : 0;
      if (oks.some(Boolean)) recordSuccessQuiet(id);
    });
    emit('info', '🩺 probes complete');
    notify();
    return probeResults;
  }
  function recordSuccessQuiet(id) {
    const b = state.breaker[id];
    if (b) { b.fails = []; b.openUntil = 0; }
  }
  const onProbe = fn => { probeSubs.push(fn); fn(probeResults); };
  const getProbeResults = () => probeResults;

  /* ── availability / scoring / ranking ── */
  function availability(def) {
    if (state.killed[def.id]) return { ok: false, why: 'killed (manual)' };
    if (breakerOf(def.id) === 'open') return { ok: false, why: 'breaker open' };
    if (def.metered && (state.quotaPct[def.id] || 0) >= QUOTA_HARD) return { ok: false, why: `quota ≥ ${QUOTA_HARD}%` };
    if (def.isAvailable) {
      const a = def.isAvailable(state.settings);
      if (!a.ok) return { ok: false, why: a.why };
    }
    return { ok: true, why: 'ready' };
  }

  function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  const epochBucket = () => Math.floor(Date.now() / (10 * 60 * 1000));

  function scoreOf(def, seats, roomId, epoch) {
    const a = availability(def);
    if (!a.ok) return { s: -Infinity, why: a.why };
    if (seats > def.maxSeats) return { s: -Infinity, why: `${seats} seats > ${def.maxSeats} cap` };
    const health = state.health[def.id] ?? 0.5;
    const quota = def.metered ? 1 - (state.quotaPct[def.id] || 0) / 100 : 1;
    const jitter = (hash32(`${roomId}|${epoch}|${def.id}`) / 0xFFFFFFFF) * 0.05;
    const s = 0.35 * health + 0.25 * quota + def.tierBonus + jitter;
    return { s: +s.toFixed(3), why: def.metered && (state.quotaPct[def.id] || 0) >= QUOTA_ROTATE ? `quota ≥ ${QUOTA_ROTATE}% — deprioritized` : 'eligible' };
  }

  function rank(seats = state.seats, roomId = state.roomId, epoch = epochBucket()) {
    return engines.map(def => ({ def, ...scoreOf(def, seats, roomId, epoch) })).sort((a, b) => b.s - a.s);
  }

  function select(seats, roomId, cause) {
    state.seats = seats; state.roomId = roomId;
    const ranked = rank(seats, roomId);
    const winner = ranked.find(r => r.s > -Infinity) || null;
    if (!winner) { state.current = null; emit('bad', `💀 no provider available for ${seats} seats — revive one in the deck`); }
    else if (winner.def.id !== state.current) {
      const prev = state.current;
      state.current = winner.def.id;
      emit(prev ? 'ok' : 'info', `🔀 [${cause}] room "${roomId}" (${seats} seats) → ${winner.def.label}${prev ? ` (was ${prev})` : ''}`);
    }
    notify();
    return { ranked, winner };
  }
  const reselect = cause => select(state.seats, state.roomId, cause || 'reselect');

  /* ── manual ops ── */
  function kill(id) {
    state.killed[id] = true;
    const def = engines.find(e => e.id === id);
    emit('bad', `⚡ manual kill → ${def ? def.label : id}`);
    if (state.current === id) onCurrentFailed();
    reselect('kill');
  }
  function revive(id) {
    delete state.killed[id];
    const def = engines.find(e => e.id === id);
    emit('ok', `💚 revived → ${def ? def.label : id}`);
    reselect('revive');
  }
  function reviveAll() {
    Object.keys(state.killed).forEach(k => delete state.killed[k]);
    Object.values(state.breaker).forEach(b => { b.fails = []; b.openUntil = 0; });
    emit('ok', '💚 all providers revived');
    reselect('revive-all');
  }
  function setCurrent(id) {
    state.current = id;
    notify();
  }

  function snapshot() {
    return {
      engines: engines.map(def => ({
        ...def,
        available: availability(def),
        breaker: breakerOf(def.id),
        quotaPct: def.metered ? (state.quotaPct[def.id] || 0) : null,
        health: state.health[def.id],
        killed: !!state.killed[def.id],
      })),
      ranked: rank(),
      current: state.current,
      lastEvent: state.log[0],
      quotaRotate: QUOTA_ROTATE,
      quotaHard: QUOTA_HARD,
    };
  }

  const subscribe = fn => { subs.push(fn); };
  return {
    register, setSettings, addProbe, runProbes, onProbe, getProbeResults,
    recordFailure, recordSuccess, setOnCurrentFailed,
    rank, select, reselect, kill, revive, reviveAll, setCurrent,
    addMinutes, setQuotaManual,
    onEvent, subscribe,
    snapshot,
    get state() { return state; },
    QUOTA_ROTATE, QUOTA_HARD,
  };
}
