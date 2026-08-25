/* NexusParty engine · jitsi (public + self-hosted)
   SFU voice via Jitsi Meet's external API — a full party room in an iframe.
   meet.jit.si is free & unlimited (room creators may be asked for a one-time
   social login; joining is accountless). Self-hosted domains work identically.
*/
import { Net } from '../core/net.js';

function makeJitsi({ id, label, tier, tierBonus, getDomain, needs }) {
  return {
    id, label, tier, tierBonus,
    maxSeats: 35, metered: false, embedded: true,

    isAvailable: settings => {
      const d = getDomain(settings);
      return d ? { ok: true } : { ok: false, why: needs };
    },

    async create(ctx) {
      const { room, identity, mount, onEvent } = ctx;
      const domain = getDomain(ctx.settings);
      if (!domain) throw new Error('not configured');

      await Net.loadScript([`https://${domain}/external_api.js`]);
      if (!window.JitsiMeetExternalAPI) throw new Error('external API failed to load');

      const api = new window.JitsiMeetExternalAPI(domain, {
        roomName: 'nexusparty-' + room,
        parentNode: mount,
        userInfo: { displayName: identity.name },
        configOverwrite: {
          startWithVideoMuted: true,
          startAudioOnly: true,
          prejoinPageEnabled: false,
          disableTileView: false,
        },
      });

      api.addListener('participantJoined', info =>
        onEvent('peer-join', { key: 'jx-' + info.id, name: info._formattedName || '' }));
      api.addListener('participantLeft', info =>
        onEvent('peer-leave', { key: 'jx-' + info.id }));
      api.addListener('audioMuteStatusChanged', info =>
        onEvent('status', { text: info.muted ? 'muted (jitsi)' : 'unmuted (jitsi)' }));
      api.addListener('conferenceFailed', ev => {
        const why = (ev && ev.error) || '';
        if (String(why).includes('authenticationRequired')) {
          onEvent('status', { text: 'meet.jit.si asks the room creator to sign in once (Google/GitHub). Tip: open meet.jit.si, sign in, or switch engine from the picker above.' });
        } else {
          onEvent('status', { text: 'jitsi conference issue: ' + why });
        }
      });

      return {
        engineId: id, kind: 'embedded',

        join() {
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('jitsi join timeout')), 25000);
            api.addListener('videoConferenceJoined', () => {
              clearTimeout(t);
              resolve({ peers: Math.max(0, api.getParticipantsCount() - 1) });
            });
          });
        },
        peersCount: () => Math.max(0, api.getParticipantsCount() - 1),
        presence() {}, chat() {}, gift() {},
        setMuted: m => { try { api.executeCommand('toggleAudio'); } catch (_) {} },
        async leave() { try { api.dispose(); } catch (_) {} },
      };
    },
  };
}

export const jitsiPublic = makeJitsi({
  id: 'jitsi-public',
  label: 'Jitsi Meet · public SFU (free)',
  tier: 'sfu · embedded', tierBonus: 0.18,
  getDomain: () => 'meet.jit.si',
  needs: '',
});

export const jitsiSelfHost = makeJitsi({
  id: 'jitsi-selfhost',
  label: 'Jitsi · self-hosted (your domain)',
  tier: 'sfu · self-hosted', tierBonus: 0.22,
  getDomain: s => (s && s.jitsiDomain || '').trim(),
  needs: 'add your domain in ⚙️ providers',
});
