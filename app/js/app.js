/* ═══════════════════════════════════════════════════════════════════
   VCParty·Hydra — UI glue
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  /* ───────── toasts ───────── */
  function toast(msg, cls = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + cls; t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.remove(), 300); }, 3600);
  }

  /* ═══════════ SUPERVISOR UI ═══════════ */
  const S = window.Supervisor;
  const engRows = new Map();

  function renderEngines(snap) {
    const tb = $('#engine-table tbody');
    if (!tb.children.length) {
      snap.engines.forEach(e => {
        const tr = document.createElement('tr'); tr.dataset.id = e.id;
        const quotaCell = e.quotaPct === null
          ? `<td style="color:var(--dim)">∞ (unmetered)</td>`
          : `<td><div class="quota-cell"><input type="range" min="0" max="100" value="${e.quotaPct}">
             <span>${e.quotaPct}%</span></div></td>`;
        tr.innerHTML = `
          <td><span class="dot idle"></span>${e.label}${e.note ? `<div style="color:var(--dim);font-size:11.5px">${e.note}</div>` : ''}</td>
          <td class="tier">${e.tier}</td>
          <td>${e.maxSeats}</td>
          ${quotaCell}
          <td class="h-cell">—</td>
          <td><span class="breaker">${e.breaker}</span></td>
          <td class="score">—</td>
          <td><button class="mini">⚡ kill</button></td>`;
        const btn = tr.querySelector('.mini');
        btn.onclick = () => { e.killed ? restoreOne(e.id) : S.kill(e.id); };
        const slider = tr.querySelector('input[type=range]');
        if (slider) slider.oninput = ev => {
          tr.querySelector('.quota-cell span').textContent = ev.target.value + '%';
          S.setQuota(e.id, +ev.target.value);
        };
        tb.appendChild(tr);
        engRows.set(e.id, tr);
      });
    }
    const ranked = new Map(snap.ranked.map(r => [r.e.id, r]));
    snap.engines.forEach(e => {
      const tr = engRows.get(e.id);
      const r = ranked.get(e.id);
      const alive = r.s > -Infinity;
      tr.classList.toggle('dead', !alive);
      tr.classList.toggle('chosen', snap.current === e.id);
      const dot = tr.querySelector('.dot');
      dot.className = 'dot ' + (e.killed ? 'bad' : alive ? 'ok' : 'warn');
      tr.querySelector('.h-cell').textContent = e.killed ? 'killed (sim)' : e.health === 1 ? 'probed ✓' : e.health === 0 ? 'probe failed' : 'assumed ok';
      const bk = tr.querySelector('.breaker');
      bk.className = 'breaker ' + (e.breaker === 'closed' ? '' : e.breaker);
      bk.textContent = e.breaker;
      tr.querySelector('.score').textContent = alive ? r.s : '✕';
      tr.querySelector('.score').style.color = alive ? 'var(--accent2)' : 'var(--bad)';
      if (!alive && r.why) tr.querySelector('.score').title = r.why;
      const btn = tr.querySelector('.mini');
      btn.textContent = e.killed ? '💚 revive' : '⚡ kill';
      btn.classList.toggle('on', e.killed);
    });
    const w = snap.ranked.find(r => r.s > -Infinity);
    $('#selection-banner').innerHTML = w
      ? `Room <b>“${S.state.roomId || 'party-time'}”</b> · ${S.state.seats || 5} seats → routed via <b>${w.e.label}</b>
         <span style="color:var(--dim)"> · fallback chain: ${snap.ranked.filter(x => x.s > -Infinity).slice(1, 4).map(x => x.e.id).join(' → ') || '—'}</span>`
      : `💀 <b>ALL PROVIDERS DOWN</b> — restore one to see auto-recovery`;
    updateEngineChip();
  }
  const restoreOne = id => {
    const e = S.state.engines.find(x => x.id === id);
    if (e) { e.killed = false; e.breaker = 'closed'; e.fails = []; }
    S.reselect('revive');          // notify() re-renders via the subscribe above
  };

  S.subscribe(renderEngines);

  S.onEvent((ev) => {
    const el = $('#event-log');
    const line = document.createElement('div');
    line.innerHTML = `<span class="t">${ev.t}</span> <span class="${ev.level}">${ev.msg}</span>`;
    el.prepend(line);
    if (ev.msg.includes('routed →') && !ev.msg.includes('was')) toast(ev.msg, 'ok');
    if (ev.level === 'bad') toast(ev.msg, 'bad');
    while (el.children.length > 120) el.lastChild.remove();
  });

  function supContext() {
    const roomId = ($('#sel-room').value || 'party-time').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'party-time';
    const seats = +$('#sel-seats').value;
    S.setContext(roomId, seats);
    return { roomId, seats };
  }
  $('#sel-room').oninput = () => { supContext(); S.reselect('room-changed'); };
  $('#sel-seats').oninput = () => { supContext(); S.reselect('seats-changed'); };
  $('#btn-reselect').onclick = () => { S.state.epoch++; S.reselect('epoch-tick'); };
  $('#btn-kill-random').onclick = () => S.killRandom();
  $('#btn-restore').onclick = () => { S.state.engines.forEach(e => { e.killed = false; e.breaker = 'closed'; e.fails = []; }); S.restoreAll(); };

  /* ═══════════ PROBES UI ═══════════ */
  function renderProbes(results) {
    const grid = $('#probe-grid');
    grid.innerHTML = '';
    Object.values(results).forEach(r => {
      const div = document.createElement('div');
      div.className = 'probe';
      const cls = r.ok ? 'ok' : 'bad';
      div.innerHTML = `<div class="p-name"><span>${r.name}</span><span class="dot ${cls}"></span></div>
        <div class="p-meta"><span class="p-lat">${r.ok ? r.ms + ' ms' : ''}</span> ${r.ok ? '✓ ' + r.detail : '✕ ' + r.detail}</div>`;
      grid.appendChild(div);
    });
    const any = Object.values(results);
    $('#pill-net').textContent = 'net: ' + (any.length ? (any.every(r => r.ok) ? 'all green' : (any.some(r => r.ok) ? 'degraded' : 'offline')) : 'checking…');
  }
  S.onProbe(renderProbes);
  $('#btn-reprobe').onclick = () => S.runProbes();
  S.runProbes();          // auto-probe on load

  /* ═══════════ PARTY UI ═══════════ */
  const AV_SEEDS = ['Pixel', 'Nova', 'Echo', 'Ziggy', 'Mochi', 'Fury', 'Luna', 'Bolt', 'Kiwi', 'Rex'];
  const avUrl = seed => `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}`;
  let chosenAvatar = avUrl(AV_SEEDS[Math.floor(Math.random() * AV_SEEDS.length)]);
  let inRoom = false, raf = null;

  const avatarRow = $('#avatar-row');
  AV_SEEDS.forEach(s => {
    const img = document.createElement('img');
    img.src = avUrl(s); img.alt = s; img.loading = 'lazy';
    if (img.src === chosenAvatar) img.classList.add('sel');
    img.onclick = () => { chosenAvatar = img.src; $$('.avatars img').forEach(i => i.classList.remove('sel')); img.classList.add('sel'); };
    avatarRow.appendChild(img);
  });

  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) { $('#inp-room').value = urlRoom; $('#sel-room').value = urlRoom; supContext(); }

  function renderSeats() {
    const wrap = $('#seats'); wrap.innerHTML = '';
    for (let i = 0; i < Party.MAX_SEATS; i++) {
      const seat = document.createElement('div');
      seat.className = 'seat empty'; seat.id = 'seat-' + i;
      const isMe = i === Party.slot;
      const img = document.createElement('img'); img.className = 'ava'; img.alt = '';
      const nm = document.createElement('div'); nm.className = 'nm';
      const tags = document.createElement('div'); tags.className = 'tags';
      if (isMe) {
        seat.classList.remove('empty');
        img.src = chosenAvatar; nm.textContent = me.name() + ' (you)';
        tags.innerHTML = `${i === 0 ? '<span class="tag">👑 host</span>' : ''}<span class="tag mm"></span><span class="tag hh"></span>`;
      } else {
        img.src = avUrl('empty-' + i);
        nm.textContent = i === 0 ? '👑 host seat' : 'open seat';
        tags.innerHTML = `<span class="tag"></span>`;
      }
      seat.append(img, nm, tags);
      wrap.appendChild(seat);
    }
  }

  function paintPeer(d) {
    const seat = $('#seat-' + d.slot); if (!seat) return;
    seat.classList.remove('empty');
    seat.querySelector('.ava').src = d.avatar;
    seat.querySelector('.nm').textContent = d.name + (d.slot === 0 ? ' 👑' : '');
    const tags = seat.querySelector('.tags');
    tags.innerHTML = `${d.slot === 0 ? '<span class="tag">👑 host</span>' : ''}
      <span class="tag mm ${d.muted ? 'muted' : ''}" style="${d.muted ? '' : 'display:none'}">🔇 muted</span>
      <span class="tag hh hand" style="${d.hand ? '' : 'display:none'}">✋ hand</span>`;
  }
  const me = { name: () => Party.me.name };

  function chatLine(html, cls = '') {
    const div = document.createElement('div');
    div.className = 'c-line ' + cls; div.innerHTML = html;
    $('#chat').appendChild(div);
    $('#chat').scrollTop = 1e9;
  }

  $('#btn-join').onclick = async () => {
    const name = $('#inp-name').value.trim() || 'guest-' + Math.floor(Math.random() * 900 + 100);
    const rm = ($('#inp-room').value.trim() || 'party-time').toLowerCase().replace(/[^a-z0-9-]/g, '');
    $('#sel-room').value = rm; supContext();
    const { winner } = S.reselect('joining-party');
    $('#btn-join').disabled = true; $('#btn-join').textContent = 'connecting…';
    try {
      await Party.join(name, chosenAvatar, rm, winner ? winner.e.label : 'mesh');
      inRoom = true;
      $('#lobby').hidden = true; $('#room').hidden = false;
      $('#room-name').textContent = rm;
      $('#pill-room').textContent = 'room: ' + rm;
      history.replaceState(null, '', '?room=' + rm);
      renderSeats();
      chatLine(`you joined <b>${rm}</b> as seat ${Party.slot + 1}/8 ${Party.slot === 0 ? '(host 👑)' : ''}`, 'c-sys');
      chatLine(`engine: <b>${S.state.current}</b> · if this provider dies, the supervisor re-routes and your call keeps flowing`, 'c-sys');
      watchLevels();
      toast('🎤 you are live — share the room link!', 'ok');
    } catch (err) {
      toast('join failed: ' + err.message, 'bad');
      S.recordFailure('mesh-peerjs', 'join failed: ' + err.message);
    } finally {
      $('#btn-join').disabled = false; $('#btn-join').textContent = '🎤 Enter the party';
    }
  };

  Party.on('status', s => { if (!inRoom) $('#btn-join').textContent = s; });
  Party.on('engine-error', t => toast('engine error: ' + t, 'bad'));
  Party.on('presence', paintPeer);
  Party.on('peer-left', slot => {
    const seat = $('#seat-' + slot); if (!seat) return;
    seat.classList.add('empty');
    seat.querySelector('.ava').src = avUrl('empty-' + slot);
    seat.querySelector('.nm').textContent = slot === 0 ? '👑 host seat' : 'open seat';
    seat.querySelector('.tags').innerHTML = '';
    chatLine(`seat ${slot + 1} left`, 'c-sys');
  });
  Party.on('chat', d => chatLine(`<span class="c-name">${esc(d.name)}:</span> ${esc(d.text)}`));
  Party.on('gift', d => { chatLine(`${d.emoji} <b>${esc(d.name)}</b> sent ${d.emoji}`, 'c-gift'); giftFx(d.emoji); });

  function esc(s) { const d = document.createElement('span'); d.textContent = s ?? ''; return d.innerHTML; }
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

  function watchLevels() {
    cancelAnimationFrame(raf);
    const loop = () => {
      if (!inRoom) return;
      const lv = Party.levels();
      const TH = 0.045;
      for (const [k, v] of Object.entries(lv)) {
        const seatId = k === '-1' ? Party.slot : +k;
        const seat = $('#seat-' + seatId);
        if (seat && !seat.classList.contains('empty')) seat.classList.toggle('speaking', v > TH && !(k === '-1' && Party.me.muted));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  $('#btn-mute').onclick = () => {
    const m = !Party.me.muted;
    Party.setMuted(m);
    $('#btn-mute').textContent = m ? '🔇 unmute' : '🎙️ mute';
    const mm = $('#seat-' + Party.slot + ' .mm');
    if (mm) { mm.style.display = m ? '' : 'none'; }
  };
  $('#btn-hand').onclick = () => {
    const h = !Party.me.hand;
    Party.setHand(h);
    $('#btn-hand').textContent = h ? '✋ lower hand' : '✋ raise hand';
    const hh = $('#seat-' + Party.slot + ' .hh');
    if (hh) hh.style.display = h ? '' : 'none';
  };
  $('#btn-music').onclick = () => {
    const on = Party.toggleBGM();
    $('#btn-music').textContent = on ? '🎵 BGM: on' : '🎵 BGM: off';
    toast(on ? 'background music mixed into your outgoing audio 🎵' : 'BGM off');
  };
  $('#btn-leave').onclick = leaveRoom;
  function leaveRoom() {
    Party.leave(); inRoom = false; cancelAnimationFrame(raf);
    $('#room').hidden = true; $('#lobby').hidden = false;
    $('#pill-room').textContent = 'room: —';
  }
  window.addEventListener('beforeunload', () => Party.leave());

  $('#chat-form').onsubmit = e => {
    e.preventDefault();
    const v = $('#chat-inp').value.trim(); if (!v) return;
    $('#chat-inp').value = '';
    Party.sendChat(v);
    chatLine(`<span class="c-name">you:</span> ${esc(v)}`);
  };
  $$('.btn.gift').forEach(b => b.onclick = () => {
    Party.sendGift(b.dataset.gift);
    giftFx(b.dataset.gift);
    chatLine(`you sent ${b.dataset.gift}`, 'c-gift');
  });

  function updateEngineChip() {
    const id = S.state.current || '—';
    const chip = $('#engine-chip'); if (!chip) return;
    chip.textContent = 'engine: ' + id;
    const pill = $('#pill-engine');
    pill.textContent = 'engine: ' + id;
    pill.className = 'pill ' + (id === '—' ? '' : 'ok');
  }

  supContext();
  S.reselect('boot');
})();
