/* NexusParty core · net.js
   Multi-CDN loading + real network probes. Every external dependency has a
   fallback CDN — the app itself practices what it preaches. */

export const Net = {
  /** Load first working script from a list of CDN URLs. */
  loadScript(urls) {
    return new Promise((resolve, reject) => {
      const next = i => {
        if (i >= urls.length) return reject(new Error('all CDNs failed: ' + urls[0]));
        const s = document.createElement('script');
        s.src = urls[i]; s.async = true;
        s.onload = () => resolve(urls[i]);
        s.onerror = () => { s.remove(); next(i + 1); };
        document.head.appendChild(s);
      };
      next(0);
    });
  },

  /** Dynamic-import the first working ES module from a list of URLs. */
  async loadModule(urls) {
    let err;
    for (const u of urls) {
      try { return await import(u); } catch (e) { err = e; }
    }
    throw new Error('all module CDNs failed: ' + (err && err.message));
  },

  /** Opaque reachability check (network path, not HTTP status). */
  fetchOk(url, timeout = 6000) {
    return new Promise(resolve => {
      const t0 = performance.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      fetch(url, { mode: 'no-cors', signal: ctl.signal, cache: 'no-store' })
        .then(() => { clearTimeout(timer); resolve({ ok: true, ms: Math.round(performance.now() - t0) }); })
        .catch(e => { clearTimeout(timer); resolve({ ok: false, ms: Math.round(performance.now() - t0), err: String(e).slice(0, 70) }); });
    });
  },

  /** Genuine ICE gathering test — resolves when a candidate of `want`
      type (srflx|relay) appears. Proves STUN/TURN works end-to-end. */
  iceProbe(iceServers, want, timeout = 7000) {
    return new Promise(resolve => {
      const t0 = performance.now();
      let pc;
      const done = ok => {
        try { pc && pc.close(); } catch (_) {}
        resolve({ ok, ms: Math.round(performance.now() - t0) });
      };
      const timer = setTimeout(() => done(false), timeout);
      try {
        pc = new RTCPeerConnection({ iceServers });
        pc.createDataChannel('np-probe');
        pc.onicecandidate = ev => {
          if (!ev.candidate) { clearTimeout(timer); done(false); return; }
          if (ev.candidate.candidate.includes('typ ' + want)) { clearTimeout(timer); done(true); }
        };
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') { clearTimeout(timer); done(false); }
        };
        pc.setLocalDescription().catch(() => { clearTimeout(timer); done(false); });
      } catch (e) { clearTimeout(timer); done(false); }
    });
  },
};

/* shared ICE config: free Google/Cloudflare STUN + Open Relay free TURN (20 GB/mo) */
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: ['turn:staticauth.openrelay.metered.ca:80', 'turn:staticauth.openrelay.metered.ca:443'],
    username: 'openrelayproject', credential: 'openrelayprojectsecret' },
  { urls: 'turns:staticauth.openrelay.metered.ca:443',
    username: 'openrelayproject', credential: 'openrelayprojectsecret' },
];
