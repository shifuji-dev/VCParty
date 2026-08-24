/* NexusParty engine · mesh-peerjs
   P2P mesh voice. Signaling: free PeerJS cloud (0.peerjs.com) using the
   slot-claim room pattern (no app server). Media: browser ↔ browser with
   free STUN + Open Relay TURN fallback. If the cloud dies mid-call, audio
   keeps flowing — only new joins are blocked.
*/
import { Net, ICE_SERVERS } from '../core/net.js';

const CDNS = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
];
const PREFIX = 'nxp1-';
const MAX_SEATS = 8;

export const peerjsMesh = {
  id: 'mesh-peerjs',
  label: 'P2P mesh · PeerJS cloud',
  tier: 'mesh · serverless', tierBonus: 0.30,
  maxSeats: MAX_SEATS, metered: false, embedded: false,
  isAvailable: () => ({ ok: true }),

  async create(ctx) {
    const { room, identity, audio, onEvent } = ctx;
    await Net.loadScript(CDNS);
    const slotId = i => PREFIX + room + '-' + i;

    /* ── claim a seat: slot 0 = host ── */
    const attempt = id => new Promise((res, rej) => {
      const p = new Peer(id, { config: { iceServers: ICE_SERVERS } });
      const t = setTimeout(() => rej(Object.assign(new Error('timeout'), { soft: true })), 9000);
      p.on('open', () => { clearTimeout(t); res(p); });
      p.on('error', e => { clearTimeout(t); try { p.destroy(); } catch (_) {} rej(Object.assign(new Error(e.type), { taken: e.type === 'unavailable-id' })); });
    });

    let peer, mySlot = -1;
    for (let i = 0; i < MAX_SEATS; i++) {
      try { peer = await attempt(slotId(i)); mySlot = i; break; }
      catch (e) { if (!e.taken) throw new Error('signaling unreachable: ' + e.message); }
    }
    if (mySlot < 0) throw new Error(`room full (${MAX_SEATS}/${MAX_SEATS})`);

    const peers = new Map();                       // slot → {conn, call, profile}
    const opened = new Set();
    let fatalError = null;

    const presenceMsg = () => ({ t: 'presence', slot: mySlot, name: identity.name, avatar: identity.avatar,
                                 muted: ctx.self ? ctx.self.muted : false, hand: ctx.self ? ctx.self.hand : false, joinedAt: ctx.joinedAt });

    /* ── wiring ── */
    const P = s => { if (!peers.has(s)) peers.set(s, {}); return peers.get(s); };

    function wireConn(conn, slot) {
      const p = P(slot);
      if (p.conn) { try { conn.close(); } catch (_) {} return; }
      p.conn = conn;
      conn.on('open', () => {
        opened.add(slot);
        send(conn, presenceMsg());
        onEvent('peer-join', { key: String(slot), slot });
      });
      conn.on('data', d => route(slot, d));
      conn.on('close', () => drop(slot));
      conn.on('error', () => drop(slot));
    }
    function wireCall(call, slot) {
      const p = P(slot);
      if (p.call) { try { call.close(); } catch (_) {} return; }
      p.call = call;
      call.on('stream', stream => audio.attachRemote('p' + slot, stream));
      call.on('close', () => drop(slot));
      call.on('error', () => drop(slot));
    }
    function drop(slot) {
      const p = peers.get(slot);
      if (!p) return;
      audio.detachRemote('p' + slot);
      peers.delete(slot); opened.delete(slot);
      onEvent('peer-leave', { key: String(slot), slot });
    }
    const send = (conn, msg) => { try { conn.open && conn.send(msg); } catch (_) {} };
    function route(slot, d) {
      if (!d || typeof d !== 'object') return;
      P(slot).profile = d;
      if (d.t === 'presence') onEvent('presence', { key: String(slot), profile: d });
      else if (d.t === 'chat') onEvent('chat', { key: String(slot), name: d.name, text: d.text });
      else if (d.t === 'gift') onEvent('gift', { key: String(slot), name: d.name, emoji: d.emoji });
    }

    peer.on('connection', c => wireConn(c, parseInt(c.peer.split('-').pop(), 10)));
    peer.on('call', c => { c.answer(audio.outgoingStream); wireCall(c, parseInt(c.peer.split('-').pop(), 10)); });
    peer.on('error', e => {
      if (e.type === 'peer-unavailable') return;      // stale slot probe — fine
      if (['server-error', 'network', 'socket-error', 'socket-disconnected'].includes(e.type)) {
        onEvent('status', { text: `PeerJS signaling problem (${e.type}) — audio continues, new joins may fail` });
        ctx.supervisor && ctx.supervisor.recordFailure('mesh-peerjs', e.type);
      }
    });
    peer.on('disconnected', () => {
      onEvent('status', { text: 'PeerJS signaling lost — mesh audio keeps flowing; trying to reconnect…' });
      setTimeout(() => { try { peer.reconnect(); } catch (_) {} }, 1500);
    });

    /* ── dial everyone in earlier slots ── */
    for (let j = 0; j < mySlot; j++) {
      const s = slotId(j);
      wireConn(peer.connect(s, { reliable: true }), j);
      wireCall(peer.call(s, audio.outgoingStream), j);
    }

    /* ── session ── */
    const session = {
      engineId: 'mesh-peerjs', kind: 'native', mySlot,
      join(waitMs) {
        return new Promise(resolve => {
          const t0 = Date.now();
          const iv = setInterval(() => {
            if (opened.size > 0 || Date.now() - t0 >= waitMs) {
              clearInterval(iv);
              resolve({ peers: opened.size });
            }
          }, 300);
        });
      },
      peersCount: () => opened.size,
      presence: () => peers.forEach(p => p.conn && send(p.conn, presenceMsg())),
      chat: text => peers.forEach(p => p.conn && send(p.conn, { t: 'chat', name: identity.name, text })),
      gift: emoji => peers.forEach(p => p.conn && send(p.conn, { t: 'gift', name: identity.name, emoji })),
      async leave() {
        try { peers.forEach(p => { p.conn && p.conn.close(); p.call && p.call.close(); }); } catch (_) {}
        peers.clear();
        try { peer.destroy(); } catch (_) {}
      },
    };
    return session;
  },
};
