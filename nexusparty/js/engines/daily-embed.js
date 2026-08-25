/* NexusParty engine · daily (BYO free tier)
   Daily.co free tier = 10,000 participant-minutes/month. Bring your own room
   URL prefix (created on the free dashboard; rooms default to public so they
   can be joined tokenless). The supervisor meters usage against the 10k grant
   and rotates away at 85%.
*/
import { Net } from '../core/net.js';

const CDNS = [
  'https://esm.sh/@daily-co/daily-js',
  'https://cdn.jsdelivr.net/npm/@daily-co/daily-js/+esm',
];

export const dailyEmbed = {
  id: 'daily-byo',
  label: 'Daily.co · your free 10k min/mo',
  tier: 'sfu · BYO', tierBonus: 0.22,
  maxSeats: 30, metered: true, monthlyFree: 10000, embedded: true,

  isAvailable: settings => {
    const u = (settings && settings.dailyUrl || '').trim();
    if (!u) return { ok: false, why: 'add your room URL in ⚙️ providers' };
    if (!/^https:\/\/.+/.test(u)) return { ok: false, why: 'URL must start with https://' };
    return { ok: true };
  },

  async create(ctx) {
    const { room, identity, mount, onEvent } = ctx;
    const base = ctx.settings.dailyUrl.trim().replace(/\/+$/, '');

    const Daily = await Net.loadModule(CDNS);
    const frame = await Daily.createFrame(mount, {
      iframeStyle: { width: '100%', height: '100%', border: '0', borderRadius: '12px' },
      showLeaveButton: true,
    });

    frame.on('participant-joined', p => onEvent('peer-join', { key: 'dy-' + p.session_id }));
    frame.on('participant-left', p => onEvent('peer-leave', { key: 'dy-' + p.session_id }));
    frame.on('error', ev => onEvent('status', { text: 'daily error: ' + ((ev && ev.errorMsg) || 'unknown') }));

    return {
      engineId: 'daily-byo', kind: 'embedded',

      join() {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('daily join timeout')), 25000);
          frame.on('joined-meeting', () => {
            clearTimeout(t);
            const ps = frame.participants() || {};
            resolve({ peers: Math.max(0, Object.keys(ps).length - 1) });
          });
          frame.join({ url: `${base}/nxp-${room}`, userName: identity.name })
            .catch(e => { clearTimeout(t); reject(e); });
        });
      },
      peersCount: () => {
        try { return Math.max(0, Object.keys(frame.participants() || {}).length - 1); } catch (_) { return 0; }
      },
      presence() {}, chat() {}, gift() {},
      setMuted() {},
      async leave() {
        try { await frame.leave(); } catch (_) {}
        try { frame.destroy(); } catch (_) {}
      },
    };
  },
};
