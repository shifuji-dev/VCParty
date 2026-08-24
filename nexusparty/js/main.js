/* NexusParty · main.js — orchestrator
   Wires engines → supervisor → UI. Implements cross-provider room discovery
   (find which free provider the room lives on) and live migration (switch
   providers without losing the party).
*/
import { createSupervisor } from './core/supervisor.js';
import { AudioCore } from './core/audio.js';
import { trysteroMesh } from './engines/trystero-mesh.js';
import { peerjsMesh } from './engines/peerjs-mesh.js';
import { jitsiPublic, jitsiSelfHost } from './engines/jitsi-embed.js';
import { dailyEmbed } from './engines/daily-embed.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => { const d = document.createElement('span'); d.textContent = s ?? ''; return d.innerHTML; };

/* ───────────── supervisor setup ───────────── */
const S = createSupervisor();
S.register(trysteroMesh);
S.register(peerjsMesh);
S.register(jitsiPublic);
S.register(dailyEmbed);
S.register(jitsiSelfHost);

S.addProbe({ id: 'stun-google', name: 'Google STUN', kind: 'ice',
  arg: [{ urls: 'stun:stun.l.google.com:19302' }], want: 'srflx',
  engines: ['mesh-trystero', 'mesh-peerjs'] });
S.addProbe({ id: 'stun-cf', name: 'Cloudflare STUN', kind: 'ice',
  arg: [{ urls: 'stun:stun.cloudflare.com:3478' }], want: 'srflx',
  engines: ['mesh-trystero', 'mesh-peerjs'] });
S.addProbe({ id: 'turn-openrelay', name: 'OpenRelay TURN (free)', kind: 'ice',
  arg: [{ urls: 'turn:staticauth.openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayprojectsecret' }],
  want: 'relay', engines: ['mesh-trystero', 'mesh-peerjs'] });
S.addProbe({ id: 'peerjs-cloud', name: 'PeerJS cloud', kind: 'http',
  url: 'https://0.peerjs.com/peerjs/peerjs.min.js', engines: ['mesh-peerjs'] });
S.addProbe({ id: 'nostr-relay', name: 'Nostr relay', kind: 'http',
  url: 'https://relay.damus.io/', engines: ['mesh-trystero'] });
S.addProbe({ id: 'bt-tracker', name: 'WebTorrent tracker', kind: 'http',
  url: 'https://tracker.openwebtorrent.com/', engines: ['mesh-trystero'] });
S.addProbe({ id: 'jitsi-pub', name: 'meet.jit.si', kind: 'http',
  url: 'https://meet.jit.si/robots.txt', engines: ['jitsi-public'] });
S.addProbe({ id: 'dicebear', name: 'DiceBear avatars', kind: 'http',
  url: 'https://api.dicebear.com/9.x/bottts-neutral/svg?seed=nexus' });

/* ───────────── settings & profile ───────────── */
const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (_) { return d; } };
let settings = loadJSON('np_settings', {});
let profile = loadJSON('np_profile', {});
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
S.setSettings(settings);

/* ───────────── app state ───────────── */
const App = {
  mode: 'lobby',                       // lobby | room
  session: null, engineDef: null,
  audio: null, roomId: null,
  me: { muted: false, hand: false },
  joinedAt: Date.now(),
  seats: new Map(),                    // key → {profile, order}
  seatOrder: 0, raf: null, meterIv: null,
  migrating: false,
};

/* ───────────── toasts ───────────── */
function toast(msg, cls = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + cls; t.innerHTML = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = 0; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 350); }, 4200);
}

/* ═══════════════ ROOM DISCOVERY + MIGRATION ═══════════════ */
const PROBE_WAIT = 5000;

function makeCtx(room) {
  return {
    room, settings,
    identity: { name: profile.name, avatar: profile.avatar },
    audio: App.audio,
    self: App.me,
    joinedAt: App.joinedAt,
    mount: $('#embed-mount'),
    supervisor: S,
    onEvent: handleEngineEvent,
  };
}

/* Try each available engine in ranked order; join the one where the room
   lives (peers present). If the room exists nowhere, create it on the
   best-ranked engine. `preferred` forces a specific engine (manual switch). */
async function discoverJoin(preferred) {
  const ranked = S.rank(8, App.roomId).filter(r => r.s > -Infinity);
  if (!ranked.length) throw new Error('no providers available — revive one in the deck');
  if (preferred) {
    const i = ranked.findIndex(r => r.def.id === preferred);
    if (i > 0) ranked.unshift(...ranked.splice(i, 1));
  }

  let best = null, firstSession = null;
  for (let i = 0; i < ranked.length; i++) {
    const def = ranked[i].def;
    setStatus(`connecting via ${def.label}…`);
    let session, res;
    try {
      session = await def.create(makeCtx(App.roomId));
      res = await session.join(PROBE_WAIT);
    } catch (err) {
      S.recordFailure(def.id, (err && err.message) || String(err));
      continue;
    }
    if (res.peers > 0) { best = { def, session, res }; break; }
    if (!firstSession) firstSession = { def, session, res };
    if (preferred === def.id) { best = { def, session, res }; break; }   // forced switch: stay even if alone
    await session.leave();                                               // empty → keep looking
  }

  if (!best) {
    if (!firstSession) throw new Error('every provider failed to connect');
    best = firstSession;                                                 // room lives nowhere → we host it
    S.select(8, App.roomId, 'host-room');
  }
  return best;
}

async function enterRoom(engineBundle) {
  const { def, session, res } = engineBundle;
  App.session = session; App.engineDef = def;
  S.setCurrent(def.id);
  App.seats.clear(); App.seatOrder = 0;
  renderSeatsBase(def);
  if (session.kind === 'embedded') {
    $('#embed-mount').hidden = false;
    $('#native-ui').style.display = 'none';
  } else {
    $('#embed-mount').hidden = true;
    $('#native-ui').style.display = '';
    ensureSeat('me', { name: profile.name + ' (you)', avatar: profile.avatar,
      muted: App.me.muted, hand: App.me.hand, isMe: true, joinedAt: App.joinedAt });
    watchLevels();
  }
  setStatus(session.kind === 'embedded'
    ? `live via ${def.label}` + (res && res.strategy ? ` (${res.strategy})` : '')
    : `live · ${1 + (res ? res.peers : 0)} here · ${def.label}`);
  updateEngineChip();
  chatSys(`connected via <b>${esc(def.label)}</b>${res && res.peers ? ` — ${res.peers} already here` : ' — you opened the room'}`);
  chatSys('if this provider fails, the supervisor re-routes the room automatically.');
}

async function joinFlow(preferred) {
  const name = $('#inp-name').value.trim() || 'guest-' + Math.floor(Math.random() * 900 + 100);
  const room = ($('#inp-room').value.trim() || 'party-' + Math.floor(Math.random() * 900 + 100))
    .toLowerCase().replace(/[^a-z0-9-]/g, '');
  profile = { name, avatar: profile.avatar || avatarUrl(AV_SEEDS[0]) };
  saveJSON('np_profile', profile);
  App.roomId = room;
  $('#btn-join').disabled = true;

  try {
    if (!App.audio) {
      setStatus('requesting microphone…');
      App.audio = new AudioCore();
      await App.audio.init();
    }
    const bundle = await discoverJoin(preferred);
    App.mode = 'room';
    $('#lobby').hidden = true; $('#room').hidden = false;
    $('#room-name').textContent = room;
    $('#pill-room').textContent = 'room: ' + room;
    history.replaceState(null, '', '?room=' + room);
    $('#chat').innerHTML = '';
    await enterRoom(bundle);
    toast(`🎤 live via <b>${esc(bundle.def.label)}</b> — share the room link!`, 'ok');
    startMeter();
  } catch (err) {
    toast('join failed: ' + esc(err.message), 'bad');
    if (App.audio) { try { App.audio.destroy(); } catch (_) {} App.audio = null; }
  } finally {
    $('#btn-join').disabled = false; $('#btn-join').textContent = '🎤 Join the party';
  }
}

/* Switch providers live: keep mic + identity, re-discover, reconnect. */
async function migrate(reason, preferred) {
  if (App.migrating || App.mode !== 'room') return;
  App.migrating = true;
  toast('🔀 switching provider — hold on…');
  setStatus('migrating…');
  cancelAnimationFrame(App.raf);
  try { App.session && await App.session.leave(); } catch (_) {}
  App.session = null;
  $('#embed-mount').innerHTML = '';
  try {
    const bundle = await discoverJoin(preferred);
    await enterRoom(bundle);
    toast(`✅ re-routed via <b>${esc(bundle.def.label)}</b> — party continues`, 'ok');
  } catch (err) {
    toast('migration failed: ' + esc(err.message) + ' — try another engine', 'bad');
    leaveRoom();
  } finally { App.migrating = false; }
}

function leaveRoom() {
  cancelAnimationFrame(App.raf); clearInterval(App.meterIv);
  try { App.session && App.session.leave(); } catch (_) {}
  $('#embed-mount').innerHTML = '';
  if (App.audio) { try { App.audio.destroy(); } catch (_) {} App.audio = null; }
  App.session = null; App.mode = 'lobby'; App.seats.clear();
  $('#room').hidden = true; $('#lobby').hidden = false;
  $('#pill-room').textContent = 'room: —'; $('#pill-engine').textContent = 'engine: —';
}

S.setOnCurrentFailed(() => migrate('engine-failed'));

/* ═══════════════ ENGINE EVENTS → UI ═══════════════ */
function handleEngineEvent(type, payload) {
  if (type === 'status') { setStatus(payload.text); return; }
  if (App.mode !== 'room') return;
  switch (type) {
    case 'peer-join':
      if (App.session.kind === 'native') ensureSeat(payload.key, {});
      else setStatus(`${App.session.peersCount()} participants · ${App.engineDef.label}`);
      break;
    case 'peer-leave':
      if (App.session.kind === 'native') removeSeat(payload.key);
      else setStatus(`${App.session.peersCount()} participants · ${App.engineDef.label}`);
      break;
    case 'presence': ensureSeat(payload.key, payload.profile); break;
    case 'chat': chatLine(`<span class="c-name">${esc(payload.name)}:</span> ${esc(payload.text)}`); break;
    case 'gift': chatLine(`${payload.emoji} <b>${esc(payload.name)}</b> sent ${payload.emoji}`, 'c-gift'); giftFx(payload.emoji); break;
  }
}

/* ═══════════════ NATIVE ROOM UI ═══════════════ */
const AV_SEEDS = ['Pixel', 'Nova', 'Echo', 'Ziggy', 'Mochi', 'Fury', 'Luna', 'Bolt', 'Kiwi', 'Rex'];
const avatarUrl = seed => `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}`;

function renderSeatsBase(def) {
  const wrap = $('#seats'); wrap.innerHTML = '';
  const n = def.maxSeats > 8 ? 8 : def.maxSeats;
  for (let i = 0; i < n; i++) {
    const seat = document.createElement('div');
    seat.className = 'seat empty';
    seat.innerHTML = `<img class="ava" src="${avatarUrl('open-' + i)}" alt="">
      <div class="nm">${i === 0 ? '👑 host seat' : 'open seat'}</div><div class="tags"></div>`;
    wrap.appendChild(seat);
  }
}

function seatElFor(order) {
  const seats = $$('#seats .seat');
  return seats[Math.min(order, seats.length - 1)];
}

function ensureSeat(key, profile) {
  if (!App.seats.has(key)) App.seats.set(key, { profile: {}, order: App.seatOrder++ });
  const s = App.seats.get(key);
  Object.assign(s.profile, profile || {});
  const el = seatElFor(s.order); if (!el) return;
  el.classList.remove('empty'); el.dataset.key = key;
  const p = s.profile;
  if (p.avatar) el.querySelector('.ava').src = p.avatar;
  if (p.name) el.querySelector('.nm').textContent = p.name + (isHost(s) ? ' 👑' : '');
  const muted = !!p.muted, hand = !!p.hand;
  el.querySelector('.tags').innerHTML =
    (isHost(s) ? '<span class="tag">👑 host</span>' : '') +
    (muted ? '<span class="tag muted">🔇</span>' : '') +
    (hand ? '<span class="tag hand">✋</span>' : '');
}
function isHost(s) {
  if (s.profile.isMe) return App.session && App.session.mySlot === 0;
  return s.profile.slot === 0;
}

function removeSeat(key) {
  const s = App.seats.get(key); if (!s) return;
  const el = seatElFor(s.order);
  if (el) {
    el.classList.add('empty'); el.dataset.key = '';
    el.querySelector('.ava').src = avatarUrl('open-' + s.order);
    el.querySelector('.nm').textContent = s.order === 0 ? '👑 host seat' : 'open seat';
    el.querySelector('.tags').innerHTML = '';
  }
  App.seats.delete(key);
}

function watchLevels() {
  cancelAnimationFrame(App.raf);
  const TH = 0.045;
  const loop = () => {
    if (App.mode !== 'room') return;
    const lv = App.audio ? App.audio.levels() : {};
    $$('#seats .seat').forEach(el => {
      const key = el.dataset.key; if (!key) return el.classList.remove('speaking');
      const v = key === 'me' ? (lv.me || 0) : (lv[key] || 0);
      const muted = key === 'me' ? App.me.muted : ((App.seats.get(key) || {}).profile || {}).muted;
      el.classList.toggle('speaking', v > TH && !muted);
    });
    App.raf = requestAnimationFrame(loop);
  };
  App.raf = requestAnimationFrame(loop);
}

function chatLine(html, cls = '') {
  const d = document.createElement('div');
  d.className = 'c-line ' + cls; d.innerHTML = html;
  $('#chat').appendChild(d); $('#chat').scrollTop = 1e9;
}
const chatSys = t => chatLine(t, 'c-sys');

function giftFx(emoji) {
  for (let i = 0; i < 6; i++) {
    const el = document.createElement('div');
    el.className = 'gift-fx'; el.textContent = emoji;
    el.style.left = (8 + Math.random() * 84) + '%';
    el.style.animationDelay = (Math.random() * .8) + 's';
    $('#gift-layer').appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }
}

function setStatus(t) {
  $('#conn-state').textContent = t;
  if (App.mode !== 'room') $('#btn-join').textContent = t;
}

function updateEngineChip() {
  const id = App.engineDef ? App.engineDef.id : (S.state.current || '—');
  $('#pill-engine').textContent = 'engine: ' + id;
  $('#pill-engine').className = 'pill ' + (id === '—' ? '' : 'ok');
  syncPicker(id);
}

/* ═══════════════ DECK UI ═══════════════ */
function renderDeck(snap) {
  const tb = $('#engine-table tbody');
  if (!tb.children.length) {
    snap.engines.forEach(e => {
      const tr = document.createElement('tr'); tr.dataset.id = e.id;
      const usage = e.metered
        ? `<div class="usage-cell"><input type="range" min="0" max="100" value="${e.quotaPct}"><span>${e.quotaPct}%</span></div>`
        : '<span style="color:var(--dim);font-size:12px">∞ unmetered</span>';
      tr.innerHTML = `<td><span class="dot idle"></span>${e.label}<div class="tier">${e.tier}</div></td>
        <td>${e.maxSeats}</td><td>${usage}</td>
        <td class="status-cell">—</td><td class="score">—</td>
        <td><button class="mini">⚡</button></td>`;
      tr.querySelector('.mini').onclick = ev => {
        const dead = e.killed || !e.available.ok;
        if (dead) { S.revive(e.id); ev.target.classList.remove('on'); }
        else S.kill(e.id);
      };
      const sl = tr.querySelector('input[type=range]');
      if (sl) sl.oninput = ev => {
        tr.querySelector('.usage-cell span').textContent = ev.target.value + '%';
        S.setQuotaManual(e.id, +ev.target.value);
      };
      tb.appendChild(tr);
    });
  }
  const ranked = new Map(snap.ranked.map(r => [r.def.id, r]));
  snap.engines.forEach(e => {
    const tr = tb.querySelector(`tr[data-id="${e.id}"]`); if (!tr) return;
    const r = ranked.get(e.id);
    const live = r.s > -Infinity;
    tr.classList.toggle('dead', !live);
    tr.classList.toggle('current', App.engineDef ? App.engineDef.id === e.id : S.state.current === e.id);
    tr.querySelector('.dot').className = 'dot ' + (e.killed ? 'bad' : live ? 'ok' : e.available.ok ? 'idle' : 'warn');
    tr.querySelector('.status-cell').textContent = e.killed ? 'killed' : e.available.ok
      ? (e.health === 1 ? 'probed ✓' : e.health === 0 ? 'probe failed' : 'ready')
      : e.available.why;
    tr.querySelector('.score').textContent = live ? r.s : '✕';
    tr.querySelector('.mini').textContent = (e.killed || !e.available.ok) ? '💚' : '⚡';
    tr.querySelector('.mini').classList.toggle('on', e.killed || !e.available.ok);
  });
  const w = snap.ranked.find(r => r.s > -Infinity);
  $('#lobby-hint').textContent = w
    ? `${snap.engines.filter(e => e.available.ok).length} free providers armed · next: ${w.def.label}`
    : 'all providers disabled — revive one in the deck';
}

S.subscribe(renderDeck);

S.onEvent((ev, log) => {
  const el = $('#event-log');
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">${ev.t}</span> <span class="${ev.level}">${esc(ev.msg)}</span>`;
  el.prepend(line);
  while (el.children.length > 150) el.lastChild.remove();
});

S.onProbe(results => {
  const grid = $('#probe-grid'); grid.innerHTML = '';
  Object.values(results).forEach(r => {
    const d = document.createElement('div'); d.className = 'probe';
    d.innerHTML = `<div class="p-name"><span>${esc(r.name)}</span><span class="dot ${r.ok ? 'ok' : 'bad'}"></span></div>
      <div class="p-meta">${r.ok ? '✓ ' + r.ms + ' ms' : '✕ unreachable'}</div>`;
    grid.appendChild(d);
  });
  const list = Object.values(results);
  $('#pill-net').textContent = 'net: ' + (list.length
    ? (list.every(r => r.ok) ? 'all green' : list.some(r => r.ok) ? 'degraded' : 'offline')
    : 'checking…');
});

/* ═══════════════ ENGINE PICKER ═══════════════ */
function syncPicker(currentId) {
  const sel = $('#engine-picker');
  const snap = S.snapshot();
  sel.innerHTML = '';
  snap.engines.forEach(e => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.label + (e.available.ok ? '' : ` (${e.available.why})`);
    o.disabled = !e.available.ok;
    o.selected = e.id === currentId;
    sel.appendChild(o);
  });
}
$('#engine-picker').onchange = ev => {
  if (ev.target.value !== (App.engineDef && App.engineDef.id)) migrate('manual', ev.target.value);
};

/* ═══════════════ QUOTA AUTO-METER ═══════════════ */
function startMeter() {
  clearInterval(App.meterIv);
  App.meterIv = setInterval(() => {
    if (App.mode === 'room' && App.engineDef && App.engineDef.metered && App.session)
      S.addMinutes(App.engineDef.id, 1 + App.session.peersCount());
  }, 60000);
}

/* ═══════════════ LOBBY UI ═══════════════ */
if (!profile.avatar) profile.avatar = avatarUrl(AV_SEEDS[Math.floor(Math.random() * AV_SEEDS.length)]);
const avatarRow = $('#avatar-row');
AV_SEEDS.forEach(s => {
  const img = document.createElement('img');
  img.src = avatarUrl(s); img.alt = s; img.loading = 'lazy';
  if (img.src === profile.avatar) img.classList.add('sel');
  img.onclick = () => {
    profile.avatar = img.src; saveJSON('np_profile', profile);
    $$(' .avatars img').forEach(i => i.classList.remove('sel')); img.classList.add('sel');
  };
  avatarRow.appendChild(img);
});
if (profile.name) $('#inp-name').value = profile.name;
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('#inp-room').value = urlRoom;

$('#btn-join').onclick = () => joinFlow();
$('#btn-leave').onclick = () => leaveRoom();
$('#btn-share').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast('🔗 invite link copied!', 'ok'); }
  catch (_) { toast(location.href); }
};

/* controls */
$('#btn-mute').onclick = () => {
  App.me.muted = !App.me.muted;
  App.audio.setMicMuted(App.me.muted);
  App.session && App.session.presence();
  $('#btn-mute').textContent = App.me.muted ? '🔇 unmute' : '🎙️ mute';
};
$('#btn-hand').onclick = () => {
  App.me.hand = !App.me.hand;
  App.session && App.session.presence();
  $('#btn-hand').textContent = App.me.hand ? '✋ lower hand' : '✋ raise hand';
};
$('#btn-music').onclick = () => {
  const on = App.audio.toggleBGM();
  $('#btn-music').textContent = on ? '🎵 BGM: on' : '🎵 BGM: off';
  toast(on ? 'BGM is mixed into your outgoing audio 🎵' : 'BGM off');
};
$('#chat-form').onsubmit = e => {
  e.preventDefault();
  const v = $('#chat-inp').value.trim(); if (!v) return;
  $('#chat-inp').value = '';
  App.session && App.session.chat(v);
  chatLine(`<span class="c-name">you:</span> ${esc(v)}`);
};
$$('.btn.gift').forEach(b => b.onclick = () => {
  App.session && App.session.gift(b.dataset.gift);
  giftFx(b.dataset.gift);
  chatLine(`you sent ${b.dataset.gift}`, 'c-gift');
});

/* deck actions */
$('#btn-kill-current').onclick = () => {
  const cur = App.engineDef ? App.engineDef.id : S.state.current;
  if (!cur) return;
  S.kill(cur);                            // triggers migration via onCurrentFailed
};
$('#btn-restore').onclick = () => S.reviveAll();
$('#btn-reprobe').onclick = () => S.runProbes();
$('#btn-deck-toggle').onclick = () => {
  const b = $('#deck-body'); const hidden = b.style.display === 'none';
  b.style.display = hidden ? '' : 'none';
  $('#btn-deck-toggle').textContent = hidden ? 'hide' : 'show';
};

/* settings modal */
$('#btn-settings').onclick = () => {
  $('#set-daily').value = settings.dailyUrl || '';
  $('#set-jitsi').value = settings.jitsiDomain || '';
  $('#settings-veil').hidden = false;
};
$('#set-cancel').onclick = () => { $('#settings-veil').hidden = true; };
$('#set-save').onclick = () => {
  settings = {
    dailyUrl: $('#set-daily').value.trim(),
    jitsiDomain: $('#set-jitsi').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
  };
  saveJSON('np_settings', settings);
  S.setSettings(settings);
  $('#settings-veil').hidden = true;
  $('#engine-table tbody').innerHTML = '';      // rebuild with new availability
  renderDeck(S.snapshot());
  if (App.mode === 'room') syncPicker(App.engineDef.id);
  toast('⚙️ providers updated', 'ok');
};

window.addEventListener('beforeunload', () => {
  try { App.session && App.session.leave(); } catch (_) {}
});

/* boot */
S.select(8, 'party', 'boot');
S.runProbes();
setInterval(() => S.runProbes(), 120000);       // keep health fresh
