/**
 * audio.js — the whole soundtrack, synthesised at runtime.
 *
 * There are no .mp3 files anywhere in this project and that is deliberate. Sound
 * packs are the classic way to get a stream muted by a copyright claim, they
 * balloon the download, and they need a CDN. Everything here is built from
 * oscillators and filtered noise in the Web Audio API, so it weighs nothing,
 * loads instantly, and is unambiguously yours to broadcast.
 *
 * Layers, quietest to loudest:
 *   ambient  — a low ocean rumble plus a slow filtered-noise "current" that
 *              never repeats, because it is noise rather than a loop
 *   events   — bites, gift chimes, evolutions, deaths, each power
 *   ducking  — the ambient bed dips under big events so hits punch through
 *
 * Browsers refuse to start audio without a user gesture. `unlock()` is wired to
 * the first click or keypress; before that the engine sits silent and harmless.
 */

/**
 * Overall level. Deliberately low.
 *
 * The first pass at this was fatiguing to listen to for more than a minute, and
 * the reasons are worth recording: square and sawtooth waves are harsh in the
 * 1–4 kHz range where ears are most sensitive, and firing a cue on EVERY event
 * in a 40-fish arena means near-constant noise. The fixes here are (a) softer
 * waveforms with a lowpass across the whole event bus, (b) much harder rate
 * limiting, and (c) starting muted so you opt in rather than get ambushed.
 */
/**
 * Raised from 0.75 for a further overall volume bump. eventGain (below,
 * where every power/gift sound actually lives) was already pushed to 0.95
 * last pass — right at the edge of its own headroom before needing makeup
 * gain into the limiter — so THIS pass's "make everything louder again"
 * goes through the master bus instead, which multiplies on top of
 * eventGain rather than competing with it for the same headroom. Still
 * safely below 1.0, and everything still passes through the limiter
 * (DynamicsCompressor, threshold -8dB, ratio 12:1) before reaching here.
 */
const MASTER_DEFAULT = 0.88;

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    // Start muted. Sound on a live stream should be a decision, not a surprise.
    this.muted = true;
    this.master = null;
    this.ambientGain = null;
    this.eventGain = null;
    this.noiseBuffer = null;

    /** Rate limiting: dozens of simultaneous bites would clip the output. */
    this._recent = new Map();
  }

  // ------------------------------------------------------------- lifecycle --

  /**
   * Build the graph. Safe to call repeatedly; only the first call does work.
   * Must run inside a user gesture or the context stays suspended.
   */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;                       // ancient browser — run silent

    this.ctx = new Ctor();

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER_DEFAULT;
    this.master.connect(this.ctx.destination);

    // A limiter so a shockwave landing during a feeding frenzy can't clip.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(this.master);

    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0.0;
    this.ambientGain.connect(limiter);

    this.eventGain = this.ctx.createGain();
    // Bus for every one-shot cue — bite/hurt/gift and every power sound
    // (pinballBounce, rotorTick, bulletFire, power(), etc.) all pass through
    // this single gain, so raising it is what makes "all gift effects
    // punchier" without also raising the separate ambient bed. Raised ~19%
    // (0.8 -> 0.95, still under 1.0 — no makeup gain needed). Safe against
    // clipping: everything downstream still passes through the
    // DynamicsCompressor limiter above (threshold -8dB, ratio 12:1) before
    // reaching master, which is exactly what that limiter exists for.
    this.eventGain.gain.value = 0.95;

    // A gentle lowpass across every event. This is what takes the "cheap
    // 8-bit buzzer" edge off the synthesised cues — it rolls off the harsh
    // upper harmonics of the square and sawtooth waves without making anything
    // sound muffled, and it doubles as a crude underwater filter.
    const warmth = this.ctx.createBiquadFilter();
    warmth.type = 'lowpass';
    warmth.frequency.value = 2600;
    warmth.Q.value = 0.5;
    this.eventGain.connect(warmth).connect(limiter);

    this.noiseBuffer = this._makeNoise(4);
    this._startAmbient();

    this.ready = true;
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(muted ? 0 : MASTER_DEFAULT, t, 0.08);
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // --------------------------------------------------------------- ambient --

  /**
   * The bed. Two detuned low oscillators for the pressure/rumble, plus noise
   * through a slowly sweeping lowpass for the sense of moving water.
   */
  _startAmbient() {
    const { ctx } = this;

    for (const freq of [38, 55]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      osc.connect(g).connect(this.ambientGain);
      osc.start();

      // Slow drift so the two never phase-lock into a static drone.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.03 + Math.random() * 0.05;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 1.6;
      lfo.connect(lfoGain).connect(osc.frequency);
      lfo.start();
    }

    const current = ctx.createBufferSource();
    current.buffer = this.noiseBuffer;
    current.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    lp.Q.value = 0.7;
    const currentGain = ctx.createGain();
    currentGain.gain.value = 0.22;
    current.connect(lp).connect(currentGain).connect(this.ambientGain);
    current.start();

    // Sweep the filter so the "current" swells and fades on its own.
    const sweep = ctx.createOscillator();
    sweep.frequency.value = 0.045;
    const sweepGain = ctx.createGain();
    sweepGain.gain.value = 130;
    sweep.connect(sweepGain).connect(lp.frequency);
    sweep.start();

    // Fade the whole bed in — a hard start is jarring on stream.
    this.ambientGain.gain.setTargetAtTime(0.34, ctx.currentTime, 4.0);
  }

  /** Dip the ambient bed briefly so an event reads clearly over it. */
  _duck(amount = 0.45, hold = 0.25) {
    if (!this.ambientGain) return;
    const t = this.ctx.currentTime;
    const g = this.ambientGain.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.34 * (1 - amount), t, 0.02);
    g.setTargetAtTime(0.34, t + hold, 0.4);
  }

  // ---------------------------------------------------------------- events --

  /**
   * Throttle by key. Twenty fish biting on the same frame should sound like a
   * frenzy, not like a blown speaker.
   */
  _allow(key, minGap) {
    const now = this.ctx.currentTime;
    const last = this._recent.get(key) ?? -Infinity;
    if (now - last < minGap) return false;
    this._recent.set(key, now);
    return true;
  }

  /** A pitched blip: the workhorse behind most cues. */
  _tone({ freq, endFreq, type = 'sine', dur = 0.2, gain = 0.3, delay = 0, curve = 'exp' }) {
    const { ctx } = this;
    const t = ctx.currentTime + delay;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq && endFreq !== freq) {
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
      else osc.frequency.linearRampToValueAtTime(endFreq, t + dur);
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(g).connect(this.eventGain);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** A noise burst through a filter: impacts, splashes, gas. */
  _noise({ dur = 0.25, gain = 0.3, type = 'lowpass', freq = 800, endFreq, Q = 1, delay = 0 }) {
    const { ctx } = this;
    const t = ctx.currentTime + delay;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    filter.Q.value = Q;
    if (endFreq) filter.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(filter).connect(g).connect(this.eventGain);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------- the cues ---

  /**
   * A bite. `power` (0-1) scales it by attacker size, so a Titan's chomp is a
   * deep crunch and a minnow's is a snap — the mix alone tells you who is
   * winning without looking at the leaderboard.
   */
  bite(power = 0.5) {
    // 0.28s minimum gap. Forty fish on a 1.5s attack cooldown would otherwise
    // average a bite every 40ms — a machine-gun rattle rather than a frenzy.
    if (!this.ready || !this._allow('bite', 0.28)) return;
    const p = Math.min(1, Math.max(0, power));
    this._noise({ dur: 0.11, gain: 0.21 + p * 0.15, type: 'lowpass', freq: 1300 - p * 700, endFreq: 150, Q: 1.1 });
    // Triangle rather than square: same pitch, none of the buzz.
    this._tone({ freq: 200 - p * 80, endFreq: 55, type: 'triangle', dur: 0.11, gain: 0.09 + p * 0.12 });
  }

  /** Damage landing on a fish — wetter and softer than the jaw snap. */
  /**
   * The damage "tick".
   *
   * Short, dry, and pitched well above the bite crunch so the two never blur
   * together — you hear the jaw snap AND the hit landing. Rate-limited to 120ms
   * so a blade storm sounds like rain rather than static.
   */
  hurt(power = 0.5) {
    if (!this.ready || !this._allow('hurt', 0.12)) return;
    const p = Math.min(1, Math.max(0, power));
    // Sharp click: a fast high-to-low blip with a tight noise transient.
    this._tone({ freq: 1500 - p * 300, endFreq: 420, type: 'triangle', dur: 0.055, gain: 0.14 + p * 0.10 });
    this._noise({ dur: 0.06, gain: 0.10 + p * 0.08, type: 'bandpass', freq: 2400, Q: 3 });
  }

  /**
   * Bouncing Logo Sphere ricochet — off a wall OR a fish, same subtle
   * "punchy" click either way (main.js _resolvePinballHits calls this for
   * both cases). A fish hit also layers hurt() on top for the actual
   * damage confirmation; this alone is just the physical knock. Kept
   * deliberately restrained — a short low-mid thump, no bright/neon
   * character — matching this power's plain, no-glow visuals.
   */
  pinballBounce() {
    if (!this.ready || !this._allow('pinballBounce', 0.06)) return;
    this._tone({ freq: 300 + Math.random() * 100, endFreq: 130, type: 'triangle', dur: 0.05, gain: 0.09 });
    this._noise({ dur: 0.03, gain: 0.06, type: 'bandpass', freq: 700, Q: 3 });
  }

  /**
   * One shot of the Gatling Bullet Storm's 15-second stream. main.js calls
   * this on every single fireball spawn — up to 25/sec — but the 100ms gate
   * below means only about 1 in 4 of those calls actually plays a sound, so
   * the cue itself lands at a clean ~10/sec "machine gun" cadence instead of
   * stacking into an unthrottled 25/sec buzz. (An earlier 30ms gate barely
   * throttled anything, since shots are already 40ms apart — this is the fix
   * for that.) A per-hit impact cue needs no separate method: every landed
   * hit already routes through _damage() -> hurt(), which was already
   * rate-limited to 120ms before this change.
   */
  /**
   * One shot in the Gatling Bullet Storm's 375-shot, 15s stream (main.js
   * POWERS.bulletStorm.fireInterval = 0.04s). Rewritten for a sharp arcade
   * laser "pew" rather than a real gunshot crack: bright, fast, almost no
   * bass — a descending sawtooth zap is what actually reads as "laser",
   * where the old triangle bass thump read as "firearm". Throttle tightened
   * from 0.1s to 0.05s (20/sec, up from 10/sec) — the wider gap was thinning
   * 25 shots/sec down to an audibly sparse pop instead of a dense
   * "rat-tat-tat"; the master limiter (see constructor) still keeps this
   * from ever clipping.
   */
  bulletFire() {
    if (!this.ready || !this._allow('bulletFire', 0.05)) return;
    this._tone({ freq: 2200 + Math.random() * 600, endFreq: 650, type: 'sawtooth', dur: 0.05, gain: 0.065 });
    this._tone({ freq: 1400 + Math.random() * 400, endFreq: 500, type: 'square', dur: 0.035, gain: 0.045 });
    this._noise({ dur: 0.02, gain: 0.05, type: 'bandpass', freq: 3400, Q: 5 });
  }

  /**
   * One pulse of the Water Ripple Shockwave's 8-pulse field — a low-bass
   * "womp" (deep sine drop) plus a short lowpass noise swell for the
   * "water" texture, distinct from bulletFire's dry crack and missiles'
   * whoosh. Rate-limited generously since pulses are already ~1.9s apart
   * (main.js POWERS.ripple.pulseInterval); this just guards against two
   * ripples on the same fish overlapping in the same frame.
   */
  ripplePulse() {
    if (!this.ready || !this._allow('ripplePulse', 0.3)) return;
    this._tone({ freq: 95, endFreq: 35, type: 'sine', dur: 0.45, gain: 0.22 });
    this._noise({ dur: 0.4, gain: 0.13, type: 'lowpass', freq: 900, endFreq: 200, Q: 1.4 });
  }

  /**
   * One tick of Rotor Blade Storm's 60-tick, 15s field (main.js
   * POWERS.rotor.tickInterval = 0.25s, 4/sec — a buzzsaw, not a slow pulse).
   * Rewritten for a deep, heavy "fır-fır-fır" chopper: a low sawtooth engine
   * drone held just past the 0.25s tick gap (dur 0.32s) so consecutive calls
   * overlap into one sustained hum instead of a gap, same trick as before —
   * just re-tuned for a tick rate 4x faster than when this was last written
   * — plus a percussive low-mid thump and a bandpass noise crack on TOP of
   * the drone for the actual blade-chop transient, which the old version
   * didn't have (it only had the drone + a thin high noise flick).
   *
   * Throttle tightened from 0.5s to 0.2s — the old gap silently dropped
   * roughly every other tick once tickInterval moved to 0.25s, thinning the
   * real 4/sec chop down to an audible ~2/sec.
   */
  rotorTick() {
    if (!this.ready || !this._allow('rotorTick', 0.2)) return;
    this._tone({ freq: 58, endFreq: 46, type: 'sawtooth', dur: 0.32, gain: 0.16 });
    this._tone({ freq: 120, endFreq: 38, type: 'triangle', dur: 0.07, gain: 0.13 });
    this._noise({ dur: 0.06, gain: 0.15, type: 'bandpass', freq: 550, endFreq: 1500, Q: 3 });
  }

  /** A gift arriving. Rises with coin value: a bright ascending arpeggio. */
  gift(coins = 1) {
    if (!this.ready || !this._allow('gift', 0.18)) return;
    this._duck(0.22, 0.2);
    // Pentatonic steps rather than a chromatic run — consonant no matter how
    // many gifts overlap, which matters when three viewers tip at once.
    const ratios = [1, 1.125, 1.333, 1.5, 1.8];
    const steps = coins >= 100 ? 5 : coins >= 30 ? 4 : coins >= 10 ? 3 : 2;
    const root = 480;
    for (let i = 0; i < steps; i++) {
      this._tone({
        freq: root * ratios[i],
        type: 'sine',
        dur: 0.34,
        gain: 0.09,
        delay: i * 0.075
      });
    }
  }

  /** Evolution — a rising swell with a bright bell on top. */
  evolve(level = 2) {
    if (!this.ready) return;
    this._duck(0.55, 0.4);
    this._tone({ freq: 180, endFreq: 720, type: 'triangle', dur: 0.55, gain: 0.11 });
    this._tone({ freq: 880 + level * 40, type: 'sine', dur: 0.7, gain: 0.2, delay: 0.3 });
    this._tone({ freq: 1320 + level * 60, type: 'sine', dur: 0.6, gain: 0.12, delay: 0.36 });
    this._noise({ dur: 0.7, gain: 0.12, type: 'highpass', freq: 400, endFreq: 3000, delay: 0.25 });
  }

  /** Losing a level — the evolution cue inverted. */
  demote() {
    if (!this.ready) return;
    this._duck(0.4, 0.3);
    this._tone({ freq: 420, endFreq: 90, type: 'triangle', dur: 0.6, gain: 0.12 });
    this._noise({ dur: 0.4, gain: 0.14, type: 'lowpass', freq: 900, endFreq: 120 });
  }

  /** Full elimination — the heaviest cue in the game. */
  death() {
    if (!this.ready) return;
    this._duck(0.7, 0.6);
    this._tone({ freq: 300, endFreq: 40, type: 'triangle', dur: 1.1, gain: 0.15 });
    this._noise({ dur: 0.9, gain: 0.2, type: 'lowpass', freq: 1400, endFreq: 90, Q: 2 });
  }

  /**
   * The like-threshold reward. Lighter and quicker than the gift arpeggio on
   * purpose — this can repeat every 50 likes in a busy stream, so it needs to
   * read as a pleasant tick rather than compete with actual gifts for
   * attention.
   */
  likeReward() {
    if (!this.ready || !this._allow('likeReward', 0.25)) return;
    this._duck(0.18, 0.15);
    this._tone({ freq: 880, type: 'sine', dur: 0.16, gain: 0.14 });
    this._tone({ freq: 1320, type: 'sine', dur: 0.22, gain: 0.12, delay: 0.09 });
  }

  /** A viewer's first gift — their fish entering the arena. */
  spawn() {
    if (!this.ready) return;
    if (!this._allow('spawn', 0.4)) return;
    this._tone({ freq: 320, endFreq: 640, type: 'sine', dur: 0.3, gain: 0.08 });
    this._noise({ dur: 0.3, gain: 0.05, type: 'bandpass', freq: 1100, Q: 1.2 });
  }

  /** Each power gets its own signature so you can hear what just fired. */
  power(kind) {
    if (!this.ready) return;
    this._duck(0.5, 0.35);

    switch (kind) {
      case 'turbo':
        // NITRO BOOST — a sharp ignition transient (the "kick" of the burst
        // actually starting) ahead of the rising whoosh, so it reads as an
        // energetic launch rather than just a swell fading in.
        this._tone({ freq: 900, endFreq: 200, type: 'sawtooth', dur: 0.09, gain: 0.16 });
        this._noise({ dur: 0.7, gain: 0.26, type: 'bandpass', freq: 350, endFreq: 2600, Q: 3 });
        this._tone({ freq: 180, endFreq: 640, type: 'triangle', dur: 0.5, gain: 0.1 });
        break;

      case 'bulletStorm':
        // Called ONCE, when the 15s stream opens — main.js._triggerPower
        // fires this before scheduling the individual shots, each of which
        // gets its own much cheaper bulletFire() cue instead (see below).
        // This cluster is just the "here it comes" flourish — pitch range
        // raised and squares swapped toward sawtooth to match bulletFire's
        // brighter laser character rather than the old duller square blips.
        for (let i = 0; i < 10; i++) {
          this._tone({
            freq: 1800 + Math.random() * 700,
            endFreq: 500,
            type: 'sawtooth',
            dur: 0.05,
            gain: 0.04,
            delay: i * 0.03
          });
        }
        this._noise({ dur: 0.3, gain: 0.14, type: 'bandpass', freq: 2200, Q: 2 });
        break;

      case 'ripple':
        // Called ONCE, when the 15s water-ripple field opens — each of its
        // 8 pulses gets its own cheap ripplePulse() cue instead (see below).
        // A deep drop + a rising watery sweep, distinct from bulletStorm's
        // dry mechanical crack and shockwave's flat sub-bass thump.
        this._tone({ freq: 60, endFreq: 30, type: 'sine', dur: 0.6, gain: 0.24 });
        this._noise({ dur: 0.6, gain: 0.16, type: 'bandpass', freq: 250, endFreq: 1400, Q: 2.5 });
        break;

      case 'missiles':
        // A launch whoosh per missile, staggered so twelve reads as a volley
        // rather than one thick chord.
        for (let i = 0; i < 6; i++) {
          this._noise({ dur: 0.22, gain: 0.09, type: 'bandpass', freq: 500, endFreq: 1800, Q: 2, delay: i * 0.05 });
        }
        this._tone({ freq: 80, endFreq: 30, type: 'sine', dur: 0.3, gain: 0.22 });
        break;

      case 'pinball':
        // Called ONCE, when the four orbs launch outward — four soft, quick
        // "release" pops, one per orb, not a single loud detonation.
        // Restrained on purpose to match this power's deliberately plain,
        // no-glow visuals (see POWERS.pinball's block comment).
        for (let i = 0; i < 4; i++) {
          this._tone({ freq: 480 + i * 55, endFreq: 250, type: 'sine', dur: 0.09, gain: 0.06, delay: i * 0.03 });
        }
        break;

      case 'spikes':
        // A cluster of short metallic pings firing outward.
        for (let i = 0; i < 5; i++) {
          this._tone({
            freq: 900 + Math.random() * 700,
            endFreq: 350,
            type: 'triangle',
            dur: 0.1,
            gain: 0.05,
            delay: i * 0.028
          });
        }
        this._tone({ freq: 900 + Math.random() * 700, endFreq: 350, type: 'triangle', dur: 0.1, gain: 0.05, delay: 0.2 });
        this._tone({ freq: 900 + Math.random() * 700, endFreq: 350, type: 'triangle', dur: 0.1, gain: 0.05, delay: 0.25 });
        this._tone({ freq: 900 + Math.random() * 700, endFreq: 350, type: 'triangle', dur: 0.1, gain: 0.05, delay: 0.3 });
        this._noise({ dur: 0.26, gain: 0.18, type: 'bandpass', freq: 1400, Q: 1.5 });
        break;

      case 'shockwave':
        // Three sub-bass thumps matching the three visual rings.
        for (let i = 0; i < 3; i++) {
          this._tone({ freq: 120, endFreq: 30, type: 'sine', dur: 0.5, gain: 0.26, delay: i * 0.35 });
          this._noise({ dur: 0.32, gain: 0.11, type: 'lowpass', freq: 600, endFreq: 60, delay: i * 0.35 });
        }
        break;

      case 'shrapnel':
        // A single explosive burst — low-end punch, a wash of noise, then a
        // spray of metallic fragment pings flying outward. Deliberately the
        // opposite character from the old shield chime this replaced: that
        // was a rising shimmer for a buff, this is a one-shot detonation.
        this._tone({ freq: 90, endFreq: 40, type: 'sine', dur: 0.35, gain: 0.3 });
        this._noise({ dur: 0.4, gain: 0.22, type: 'bandpass', freq: 900, endFreq: 2400, Q: 2 });
        for (let i = 0; i < 6; i++) {
          this._tone({
            freq: 1400 + Math.random() * 900,
            endFreq: 300,
            type: 'triangle',
            dur: 0.12,
            gain: 0.05,
            delay: 0.03 + i * 0.025
          });
        }
        break;

      case 'rotor':
        // Called ONCE, when Rotor Blade Storm's 15s field opens — a heavy
        // motor spinning up. endFreq lowered from 240 to 140 and a low sine
        // layer added underneath: a chopper reads as "heavy" through low-end
        // weight, and the old 240Hz top end pulled it toward a whiny power
        // tool instead. The sustained "fır-fır-fır" chop for the rest of the
        // duration is rotorTick() below, called once per tick (4/sec).
        this._tone({ freq: 55, endFreq: 140, type: 'sawtooth', dur: 1.4, gain: 0.12 });
        this._tone({ freq: 40, endFreq: 70, type: 'sine', dur: 1.4, gain: 0.14 });
        for (let i = 0; i < 10; i++) {
          this._noise({
            dur: 0.07, gain: 0.06, type: 'bandpass', freq: 1200, Q: 4,
            delay: i * 0.085
          });
        }
        break;

      default:
        this._tone({ freq: 600, type: 'triangle', dur: 0.2, gain: 0.14 });
    }
  }

  /**
   * ARENA NUKE — the 100-coin power. A rising siren telegraphs the impact for
   * about a second, then three bass hits land together with the shockwave
   * rings and the hit-stop freeze in main.js. Gain 0.5 vs the shockwave's
   * 0.26 because this has to read as the single loudest thing in the game.
   */
  nuke() {
    if (!this.ready) return;
    this._duck(0.8, 2.2);

    // Rising siren — the telegraph before the hit lands.
    this._tone({ freq: 220, endFreq: 1100, type: 'sawtooth', dur: 1.0, gain: 0.18 });
    this._noise({ dur: 1.0, gain: 0.08, type: 'bandpass', freq: 400, endFreq: 2200, Q: 2 });

    // Three deep bass hits, much louder than the shockwave's, landing after the siren.
    for (let i = 0; i < 3; i++) {
      const delay = 1.0 + i * 0.4;
      this._tone({ freq: 90, endFreq: 24, type: 'sine', dur: 0.6, gain: 0.5, delay });
      this._noise({ dur: 0.4, gain: 0.22, type: 'lowpass', freq: 500, endFreq: 50, delay });
    }
  }

  /**
   * Arena wiped from the admin panel. A single clean downward sweep — deliberately
   * distinct from `death()`, which is per-fish and heavier, since this clears
   * everyone at once and only ever fires from a confirmed admin action.
   */
  reset() {
    if (!this.ready) return;
    this._duck(0.6, 0.5);
    this._tone({ freq: 700, endFreq: 90, type: 'sine', dur: 0.5, gain: 0.16 });
    this._noise({ dur: 0.5, gain: 0.12, type: 'lowpass', freq: 1200, endFreq: 150 });
  }

  /** Camera changed subject — a soft UI tick, not a game event. */
  uiClick() {
    if (!this.ready) return;
    this._tone({ freq: 900, endFreq: 1400, type: 'sine', dur: 0.07, gain: 0.08 });
  }

  // --------------------------------------------------------------- helpers --

  /** Pre-rendered white noise. Reused by every noise-based cue. */
  _makeNoise(seconds) {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate * seconds, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }
}
