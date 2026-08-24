/* NexusParty core · audio.js
   One shared WebAudio graph for every engine:
     mic ──► micGain ─┐
                      ├─► mixDest (the single outgoing track every engine publishes)
     BGM ──► bgmGain ─┘
   Remote streams get analysers for speaking detection + <audio> playback.
*/

export class AudioCore {
  constructor() {
    this.ready = false;
    this.muted = false;
    this.bgmOn = false;
    this.remotes = new Map();          // key → {el, analyser}
    this._buf = new Float32Array(512);
  }

  async init() {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();

    const src = this.ctx.createMediaStreamSource(this.micStream);
    this.micGain = this.ctx.createGain();
    this.bgmGain = this.ctx.createGain(); this.bgmGain.gain.value = 0;
    this.mixDest = this.ctx.createMediaStreamDestination();
    src.connect(this.micGain).connect(this.mixDest);
    this.bgmGain.connect(this.mixDest);

    this.localAnalyser = this.ctx.createAnalyser();
    this.localAnalyser.fftSize = 512;
    this.ctx.createMediaStreamSource(this.micStream).connect(this.localAnalyser);

    // generative BGM pad — local, royalty-free by construction
    [110, 164.81, 220, 277.18].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      const g = this.ctx.createGain(); g.gain.value = 0.22 / (i + 1);
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.07 + i * 0.03;
      const lg = this.ctx.createGain(); lg.gain.value = 0.08 / (i + 1);
      lfo.connect(lg); lg.connect(g.gain);
      o.connect(g); g.connect(this.bgmGain);
      o.start(); lfo.start();
    });

    this.ready = true;
  }

  /** The mixed stream every engine should publish as its outgoing audio. */
  get outgoingStream() { return this.mixDest.stream; }

  setMicMuted(m) {
    this.muted = m;
    if (this.ctx) this.micGain.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  toggleBGM() {
    this.bgmOn = !this.bgmOn;
    this.bgmGain.gain.setTargetAtTime(this.bgmOn ? 0.5 : 0, this.ctx.currentTime, 0.4);
    return this.bgmOn;
  }

  /** Attach playback + level metering for a remote stream (idempotent per key). */
  attachRemote(key, stream) {
    if (this.remotes.has(key)) return;
    const el = new Audio();
    el.autoplay = true; el.srcObject = stream; el.dataset.npKey = key;
    document.body.appendChild(el);
    const an = this.ctx.createAnalyser(); an.fftSize = 512;
    this.ctx.createMediaStreamSource(stream).connect(an);
    this.remotes.set(key, { el, analyser: an });
  }

  detachRemote(key) {
    const r = this.remotes.get(key);
    if (!r) return;
    r.el.srcObject = null; r.el.remove();
    this.remotes.delete(key);
  }

  detachAllRemotes() { [...this.remotes.keys()].forEach(k => this.detachRemote(k)); }

  /** RMS levels: { me: 0..1, <peerKey>: 0..1 } */
  levels() {
    if (!this.ready) return {};
    const out = { me: this._rms(this.localAnalyser) };
    this.remotes.forEach((v, k) => { out[k] = this._rms(v.analyser); });
    return out;
  }

  _rms(analyser) {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this._buf);
    let sum = 0;
    for (let i = 0; i < this._buf.length; i++) sum += this._buf[i] * this._buf[i];
    return Math.sqrt(sum / this._buf.length);
  }

  destroy() {
    this.detachAllRemotes();
    try { this.micStream && this.micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { this.ctx && this.ctx.close(); } catch (_) {}
    this.ready = false; this.bgmOn = false;
  }
}
