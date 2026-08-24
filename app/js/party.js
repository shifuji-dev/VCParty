/* ═══════════════════════════════════════════════════════════════════
   VCParty·Hydra — Media Engine #1: serverless P2P mesh (real voice)
   • Signaling: PeerJS cloud with slot-claim room pattern (no app server)
   • NAT: Google/Cloudflare STUN + Open Relay free TURN fallback
   • Presence/chat/gifts: peer data channels (control plane = the mesh)
   • Media: browser → browser. If every server dies mid-call, audio keeps
     flowing — the deepest fallback level, for real.
   ═══════════════════════════════════════════════════════════════════ */
window.Party = (() => {
  'use strict';

  const MAX_SEATS = 8;
  const PREFIX = 'vcprty-v1-';                 // namespace on the shared cloud server
  const ICE = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['turn:staticauth.openrelay.metered.ca:80', 'turn:staticauth.openrelay.metered.ca:443'],
        username: 'openrelayproject', credential: 'openrelayprojectsecret' },
      { urls: 'turns:staticauth.openrelay.metered.ca:443',
        username: 'openrelayproject', credential: 'openrelayprojectsecret' },
    ],
  };

  let peer = null, mySlot = -1, room = '';
  let micStream, audioCtx, micGain, bgmGain, mixDest, outgoingTrack;
  let bgmOn = false, bgmNodes = [];
  const peers = new Map();                     // slot → {conn, call, el, analyser, data, level}
  const me = { name:'', avatar:'', muted:false, hand:false };

  const handlers = {};
  const fire = (ev, d) => (handlers[ev] || []).forEach(fn => fn(d));
  const on = (ev, fn) => (handlers[ev] = handlers[ev] || []).push(fn);

  const slotId = (room, i) => PREFIX + room + '-' + i;

  /* ─────────── audio graph: mic + BGM → one mixed outgoing track ─────────── */
  async function buildAudio() {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    const src = audioCtx.createMediaStreamSource(micStream);
    micGain   = audioCtx.createGain(); micGain.gain.value = 1;
    bgmGain   = audioCtx.createGain(); bgmGain.gain.value = 0;
    mixDest   = audioCtx.createMediaStreamDestination();
    src.connect(micGain).connect(mixDest);
    bgmGain.connect(mixDest);

    // chill generative background-music pad (Yalla-style BGM, but free & local)
    [110, 164.81, 220, 277.18].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      const g = audioCtx.createGain(); g.gain.value = 0.22 / (i + 1);
      const lfo = audioCtx.createOscillator(); lfo.frequency.value = 0.07 + i * 0.03;
      const lg  = audioCtx.createGain(); lg.gain.value = 0.08 / (i + 1);
      lfo.connect(lg).connect(g.gain);
      o.connect(g).connect(bgmGain);
      o.start(); lfo.start();
      bgmNodes.push(o, lfo);
    });

    outgoingTrack = mixDest.stream.getAudioTracks()[0];
  }

  function toggleBGM() {
    bgmOn = !bgmOn;
    bgmGain.gain.setTargetAtTime(bgmOn ? 0.5 : 0, audioCtx.currentTime, 0.4);
    return bgmOn;
  }

  function setMuted(m) {
    me.muted = m;
    micGain.gain.setTargetAtTime(m ? 0 : 1, audioCtx.currentTime, 0.02);
    broadcastPresence();
  }

  /* ─────────── slot claim (serverless room membership) ─────────── */
  const attemptPeer = id => new Promise((res, rej) => {
    const p = new Peer(id, { config: ICE });
    const t = setTimeout(() => rej({ taken:false, err:'timeout' }), 8000);
    p.on('open', () => { clearTimeout(t); res(p); });
    p.on('error', e => { clearTimeout(t); p.destroy(); rej({ taken: e.type === 'unavailable-id', err: e.type }); });
  });

  async function claimSlot(rm) {
    for (let i = 0; i < MAX_SEATS; i++) {
      try { return { p: await attemptPeer(slotId(rm, i)), slot: i }; }
      catch (e) { if (!e.taken) throw new Error('signaling unreachable: ' + e.err); }
    }
    throw new Error(`room is full (${MAX_SEATS}/${MAX_SEATS} seats)`);
  }

  /* ─────────── join ─────────── */
  async function join(name, avatar, rm, engineLabel) {
    me.name = name; me.avatar = avatar; room = rm.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!room) throw new Error('room name required');
    fire('status', 'requesting microphone…');
    await buildAudio();

    fire('status', 'claiming a seat (signaling)…');
    const { p, slot } = await claimSlot(room);
    peer = p; mySlot = slot;

    peer.on('connection', c => {                       // a later joiner found us
      wireConn(c, parseInt(c.peer.split('-').pop(), 10));
    });
    peer.on('call', c => {
      c.answer(new MediaStream([outgoingTrack]));
      wireCall(c, parseInt(c.peer.split('-').pop(), 10));
    });
    peer.on('error', e => {
      if (e.type === 'peer-unavailable') return;       // stale slot — fine
      fire('engine-error', e.type);
      Supervisor.recordFailure('mesh-peerjs', 'peerjs: ' + e.type);
    });

    // dial everyone in earlier slots (make-before-break: we connect to all)
    for (let j = 0; j < mySlot; j++) {
      const s = slotId(room, j);
      const c = peer.connect(s, { reliable: true });
      wireConn(c, j);
      const call = peer.call(s, new MediaStream([outgoingTrack]));
      wireCall(call, j);
    }

    fire('joined', { room, slot: mySlot, engine: engineLabel, maxSeats: MAX_SEATS });
    broadcastPresence();
    return { slot: mySlot };
  }

  /* ─────────── peer wiring ─────────── */
  function P(slot) { if (!peers.has(slot)) peers.set(slot, {}); return peers.get(slot); }

  function wireConn(conn, slot) {
    const p = P(slot);
    if (p.conn) { try { conn.close(); } catch(_){} return; }   // already connected
    p.conn = conn;
    conn.on('open', () => { sendTo(conn, presenceMsg()); });
    conn.on('data', d => onData(slot, d));
    conn.on('close', () => dropPeer(slot));
    conn.on('error', () => dropPeer(slot));
  }

  function wireCall(call, slot) {
    const p = P(slot);
    if (p.call) { try { call.close(); } catch(_){} return; }
    p.call = call;
    call.on('stream', stream => attachRemote(slot, stream));
    call.on('close', () => dropPeer(slot));
    call.on('error', () => dropPeer(slot));
  }

  function dropPeer(slot) {
    const p = peers.get(slot);
    if (!p) return;
    if (p.el) { p.el.srcObject = null; p.el.remove(); }
    peers.delete(slot);
    fire('peer-left', slot);
  }

  function attachRemote(slot, stream) {
    const p = P(slot);
    if (p.el) { p.el.srcObject = stream; return; }      // ignore duplicate 'stream' events
    const el = new Audio(); el.autoplay = true; el.srcObject = stream;
    el.setAttribute('data-slot', slot);
    document.body.appendChild(el);
    p.el = el;
    const an = audioCtx.createAnalyser(); an.fftSize = 512;
    an.srcNode = audioCtx.createMediaStreamSource(stream);
    an.srcNode.connect(an);                             // analyser only — <audio> does playback
    p.analyser = an;
    fire('peer-stream', slot);
  }

  /* ─────────── control plane over data channels ─────────── */
  const presenceMsg = () => ({ type:'presence', slot:mySlot, name:me.name, avatar:me.avatar,
                               muted:me.muted, hand:me.hand });
  const sendTo = (conn, msg) => { try { conn.open && conn.send(msg); } catch(_){} };
  function broadcast(msg) { peers.forEach(p => p.conn && sendTo(p.conn, msg)); }
  function broadcastPresence() { broadcast(presenceMsg()); }

  function onData(slot, d) {
    if (!d || typeof d !== 'object') return;
    const p = P(slot);
    if (d.type === 'presence') { Object.assign(p, d); fire('presence', d); }
    else if (d.type === 'chat')  fire('chat',    { ...d, slot });
    else if (d.type === 'gift')  fire('gift',    { ...d, slot });
  }

  const sendChat  = text => broadcast({ type:'chat',  name:me.name, text:text.slice(0,200) });
  const sendGift  = emoji => broadcast({ type:'gift',  name:me.name, emoji });

  /* ─────────── speaking detection (local VU for every stream incl. mine) ─────────── */
  let localAnalyser = null;
  function levels() {
    if (!audioCtx) return {};
    if (!localAnalyser) {
      localAnalyser = audioCtx.createAnalyser(); localAnalyser.fftSize = 512;
      audioCtx.createMediaStreamSource(micStream).connect(localAnalyser);
    }
    const out = { [-1]: rms(localAnalyser) };
    peers.forEach((p, s) => { out[s] = p.analyser ? rms(p.analyser) : 0; });
    return out;
  }
  const buf = new Float32Array(512);
  function rms(analyser) {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /* ─────────── leave / teardown ─────────── */
  function leave() {
    try { peers.forEach(p => { p.conn && p.conn.close(); p.call && p.call.close(); if (p.el) p.el.remove(); }); } catch(_){}
    peers.clear();
    try { peer && peer.destroy(); } catch(_){}
    try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch(_){}
    try { audioCtx && audioCtx.close(); } catch(_){}
    localAnalyser = null; bgmNodes = []; bgmOn = false;
    peer = null; mySlot = -1;
    fire('left', {});
  }

  return { join, leave, setMuted, toggleBGM, sendChat, sendGift, levels, on,
           setHand: h => { me.hand = h; broadcastPresence(); },
           get me(){ return me; }, get slot(){ return mySlot; },
           get seatCount(){ return peers.size + 1; }, MAX_SEATS };
})();
