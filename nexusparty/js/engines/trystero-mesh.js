/* NexusParty engine · mesh-trystero
   P2P mesh voice with DECENTRALIZED signaling (Trystero): Nostr relays first,
   BitTorrent trackers as the built-in fallback — no accounts, no keys, no
   central server that can die. Media: browser ↔ browser over free STUN/TURN.
*/
import { Net } from '../core/net.js';

const V = '0.21.6';
const STRATEGIES = [
  { name: 'nostr', label: 'Nostr relays',
    urls: [`https://esm.sh/trystero@${V}/nostr`, `https://cdn.jsdelivr.net/npm/trystero@${V}/nostr/+esm`] },
  { name: 'torrent', label: 'BitTorrent trackers',
    urls: [`https://esm.sh/trystero@${V}/torrent`, `https://cdn.jsdelivr.net/npm/trystero@${V}/torrent/+esm`] },
];
const APP_ID = 'nexusparty-v1';

export const trysteroMesh = {
  id: 'mesh-trystero',
  label: 'P2P mesh · decentralized signaling',
  tier: 'mesh · serverless', tierBonus: 0.30,
  maxSeats: 8, metered: false, embedded: false,
  isAvailable: () => ({ ok: true }),

  async create(ctx) {
    const { room, identity, audio, onEvent } = ctx;
    const ns = 'nxp1-' + room;

    let roomObj = null, sendFn = null, wired = false, lastErr = null;

    const waitPeers = ms => new Promise(res => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const n = roomObj ? Object.keys(roomObj.getPeers()).length : 0;
        if (n > 0 || Date.now() - t0 >= ms) { clearInterval(iv); res(n); }
      }, 400);
    });

    /* Nostr first; if its relays fail, fall back to BitTorrent trackers. */
    async function connectStrategy(waitMs) {
      for (const strat of STRATEGIES) {
        let errored = false;
        try {
          onEvent('status', { text: `signaling via ${strat.label}…` });
          const m = await Net.loadModule(strat.urls);
          roomObj = m.joinRoom(
            { appId: APP_ID, relayRedundancy: 3 }, ns,
            err => { errored = true; lastErr = err; });
          const peers = await waitPeers(waitMs);
          if (peers > 0 || !errored) return { peers, strategy: strat.name };
          try { roomObj.leave(); } catch (_) {}
        } catch (e) {
          lastErr = e;
          try { roomObj && roomObj.leave(); } catch (_) {}
        }
        roomObj = null;
      }
      throw new Error('all signaling strategies failed' + (lastErr ? ': ' + String(lastErr).slice(0, 80) : ''));
    }

    const presenceMsg = () => ({ t: 'presence', name: identity.name, avatar: identity.avatar,
      muted: ctx.self.muted, hand: ctx.self.hand, joinedAt: ctx.joinedAt });

    function wire() {
      if (wired || !roomObj) return; wired = true;

      roomObj.onPeerJoin(peerId => {
        onEvent('peer-join', { key: peerId });
        try { sendFn && sendFn(presenceMsg(), peerId); } catch (_) {}
        try { roomObj.addStream(audio.outgoingStream, peerId); } catch (_) {}
      });
      roomObj.onPeerLeave(peerId => {
        audio.detachRemote(peerId);
        onEvent('peer-leave', { key: peerId });
      });
      roomObj.getStreams((stream, peerId) => {
        audio.attachRemote(peerId, stream);
        onEvent('peer-join', { key: peerId });
      });

      const [send, get] = roomObj.makeAction('np');
      sendFn = send;
      get((data, peerId) => {
        if (!data || typeof data !== 'object') return;
        if (data.t === 'presence') onEvent('presence', { key: peerId, profile: data });
        else if (data.t === 'chat') onEvent('chat', { key: peerId, name: data.name, text: data.text });
        else if (data.t === 'gift') onEvent('gift', { key: peerId, name: data.name, emoji: data.emoji });
      });
    }

    return {
      engineId: 'mesh-trystero', kind: 'native',
      strategy: null,

      async join(waitMs) {
        const r = await connectStrategy(waitMs);
        wire();
        this.strategy = r.strategy;
        try { sendFn && sendFn(presenceMsg()); } catch (_) {}
        try { roomObj.addStream(audio.outgoingStream); } catch (_) {}
        return { peers: Object.keys(roomObj.getPeers()).length, strategy: r.strategy };
      },
      peersCount: () => (roomObj ? Object.keys(roomObj.getPeers()).length : 0),
      presence: () => { try { sendFn && sendFn(presenceMsg()); } catch (_) {} },
      chat: text => { try { sendFn && sendFn({ t: 'chat', name: identity.name, text }); } catch (_) {} },
      gift: emoji => { try { sendFn && sendFn({ t: 'gift', name: identity.name, emoji }); } catch (_) {} },
      async leave() {
        try { roomObj && roomObj.leave(); } catch (_) {}
        roomObj = null; sendFn = null; wired = false;
      },
    };
  },
};
