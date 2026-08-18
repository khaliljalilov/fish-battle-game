/**
 * main.js — the game.
 *
 * Boot order matters and is deliberate:
 *   1. renderer + scene           (so something is on screen immediately)
 *   2. model preload              (with a progress bar, never a blank hang)
 *   3. REST state restore         (arena is full before the socket even opens)
 *   4. socket connect             (live gifts start flowing)
 *   5. render loop
 *
 * Steps 3 and 4 are separate on purpose: a browser refresh mid-stream repaints
 * the whole arena from MongoDB in one request, so no viewer loses progress even
 * if the websocket takes a few seconds to hand-shake.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Reused scratch vector — never allocate inside the game loop. */
const _v1 = new THREE.Vector3();
import {
  ARENA, CAMERA, COMBAT, PHYSICS, POWERS, RENDER, runtime,
  bandFor, maxHPForLevel
} from './config.js';
import { ModelLibrary } from './models.js';
import { World } from './world.js';
import { Effects } from './effects.js';
import { Fish } from './fish.js';
import { CameraDirector } from './camera.js';
import { UI } from './ui.js';
import { Net } from './net.js';
import { Audio } from './audio.js';
import { ensureAuthorized, startAuthHeartbeat } from './authGuard.js';

class Game {
  constructor() {
    this.fish = new Map();          // username -> Fish
    this.fishList = [];             // dense array, rebuilt on join/leave only
    this.scheduled = [];            // {t, fn} — delayed effects (shockwave waves)
    /**
     * username -> this.elapsed value at which their current/last bulletStorm
     * stream's final shot is scheduled to fire. Lets a repeat 5-coin gift
     * that lands mid-stream EXTEND the queue's tail instead of starting a
     * second, independent 15s loop firing in parallel — see _triggerPower.
     */
    this.bulletStormQueue = new Map();
    this.maxActive = 40;
    this.running = false;

    // Gated by js/tiktokPanel.js via a window event — see _initTikTokGate().
    // Starts UNPAUSED: the game (and the 🧪 test panel, which posts real
    // gifts through this exact same path) must work normally out of the box.
    // Defaulting this to true silently dropped every gift with no error and
    // no UI feedback, which is what made every test-panel button look dead —
    // the server was resolving each gift correctly the whole time (verified
    // via curl), _onGift() was just returning before rendering anything.
    // Disconnecting the TikTok panel still pauses gifts going forward — see
    // _initTikTokGate() — this only fixes the default before that ever runs.
    this.giftsPaused = false;

    this.clock = new THREE.Clock();
    this.elapsed = 0;

    // Frame-time smoothing feeds the adaptive resolution scaler.
    this.frameAvg = 16;
    this.qualityScale = 1;
    this.qualityCooldown = 0;
  }

  // ------------------------------------------------------------------ boot --

  async start() {
    this._initRenderer();
    this._initScene();
    this._initUI();

    // 2. Models. Preload once; every fish is a clone after this.
    this.library = new ModelLibrary();
    const report = await this.library.preload((fraction, level) => {
      this.ui.setLoadProgress(fraction, `Loading ${bandFor(level).species}`);
    });

    if (report.fallback.length) {
      // Loud, on screen, with the real reason. A silent fallback to procedural
      // sharks is the most confusing failure mode this project has — you drop
      // your models in, everything "works", and the wrong fish swim past.
      console.warn(
        `[models] ${report.fallback.length}/10 model(s) failed to load and are using ` +
        `the built-in procedural shark.\n` +
        report.errors.map((e) => `  L${e.level} ${e.file}: ${e.reason}`).join('\n') +
        `\nRun http://localhost:${location.port || 3000}/api/models to see what is actually on disk.`
      );

      this.ui.announce(
        `${report.fallback.length}/10 models failed to load — open /api/models`,
        'alert'
      );

      // First failure verbatim in the ticker: usually all ten share one cause.
      const first = report.errors[0];
      if (first) this.ui.announce(`${first.file}: ${first.reason}`, 'warn');
    } else {
      console.info('[models] all 10 .glb models loaded successfully');
    }

    // 3. Restore from the local database.
    this.ui.setLoadProgress(0.95, 'Restoring arena from database');
    const state = await this.net.fetchState();
    this.maxActive = state.maxActive || 40;
    for (const record of state.fish || []) this._spawnFish(record, { silent: true });

    // 4. Live feed.
    this.net.connect();

    this.ui.setLoadProgress(1, 'Ready');
    this.ui.hideLoader();
    if (state.fish?.length) {
      this.ui.announce(`Restored ${state.fish.length} fish from the last session`, 'ok');
    }

    // 5. Go.
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  _initRenderer() {
    this.canvas = document.getElementById('scene');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;


    window.addEventListener('resize', () => this._onResize());

    // A lost context would otherwise freeze the stream on a black frame.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.running = false;
      this.ui?.announce('Graphics context lost — recovering', 'alert');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.running = true;
      this.ui?.announce('Graphics context restored', 'ok');
    });
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      CAMERA.fov, window.innerWidth / window.innerHeight, 0.1, 600
    );
    this.camera.position.set(0, CAMERA.height, CAMERA.distance);

    /**
     * BLOOM. The single biggest visual upgrade available here.
     *
     * Every glowing thing in this game — shurikens, shockwave rings, turbo
     * trails, shrapnel bursts, damage sparks — was being drawn as flat
     * geometry with no light spill. That is precisely why it all read as
     * "basic": in real footage, bright things bleed into the pixels around
     * them, and without that the brain files them as diagrams rather than
     * energy.
     *
     * The threshold is set high (0.72) so only genuinely bright things bloom.
     * Set it low and the whole scene turns into fog.
     */
    // NOTE: this must run AFTER _initScene has created the camera. RenderPass
    // captures the camera reference at construction, so building the composer
    // in the renderer setup (before the camera exists) handed it `undefined`
    // and every frame threw inside WebGLRenderer.render.
    this.composer = new EffectComposer(this.renderer);
    if (!this.scene || !this.camera) {
      throw new Error(
        '[render] Composer built before the scene/camera exist. RenderPass ' +
        'captures both at construction; building it early yields undefined and ' +
        'throws inside WebGLRenderer.render on every frame.'
      );
    }
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Kept so _frame() can taper bloom.strength down under RENDER.clutterFishThreshold
    // without losing the original tuned value to modulate against.
    this.baseBloomStrength = 0.85;
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      this.baseBloomStrength,   // strength
      0.5,    // radius
      0.72    // threshold — only bright pixels bloom
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.world = new World(this.scene);
    this.effects = new Effects(this.scene);
    this.director = new CameraDirector(this.camera);
    this.audio = new Audio();
    /** Remaining hit-stop time, seconds. See the game loop. */
    this.hitStop = 0;

    // Context handed to every fish each frame. Built once, mutated never.
    this.ctx = {
      effects: this.effects,
      damage: (attacker, target, amount) => this._damage(attacker, target, amount),
      damageArea: (source, position, radius, amount, opts) =>
        this._damageArea(source, position, radius, amount, opts),
      audio: this.audio
    };
  }

  _initUI() {
    this.ui = new UI({
      onSpectate: (username) => this._spectate(username),
      onResetRequest: (key, confirm) => this.net.requestReset(key, confirm)
    });

    this.net = new Net({
      onFullState: (payload) => this._onFullState(payload),
      onGift: (payload) => this._onGift(payload),
      onRemove: ({ username }) => this._removeFish(username, { silent: true }),
      onReset: () => this._onReset(),
      onTikTokStatus: ({ connected }) => {
        this.tiktokConnected = connected;
        this._refreshStatus();
      },
      onDisconnect: () => this.ui.announce('Lost connection to the server — retrying', 'alert')
    });

    this._initAudio();
    this._initControls();
    this._initTestPanel();
    this._initTikTokGate();
    this._initAuthKickGuard();
  }

  /**
   * authGuard.js's heartbeat (started in the boot IIFE below, once past
   * ensureAuthorized()) dispatches this the instant it kicks a session —
   * expired subscription, invalid token, or the auth service unreachable.
   * Freezing here happens synchronously, before authGuard.js's own redirect
   * to /login.html takes effect, so physics/combat can't keep running for
   * however long navigation takes.
   */
  _initAuthKickGuard() {
    window.addEventListener('auth:kicked', () => {
      this.running = false;
    });
  }

  /**
   * Bridges js/tiktokPanel.js — a standalone module with no import
   * relationship to Game — via a window CustomEvent. Everything except
   * gifts (state:full, fish:remove, game:reset, tiktok:status) keeps
   * flowing regardless of this flag: those reflect server/DB state, not
   * TikTok gift traffic, so pausing them here would desync the arena from
   * the database instead of just muting gifts.
   */
  _initTikTokGate() {
    window.addEventListener('tiktok-panel:status', (e) => {
      this.giftsPaused = !e.detail?.connected;
      this.ui.announce(
        this.giftsPaused ? 'Gift events paused' : 'Gift events resumed',
        this.giftsPaused ? 'warn' : 'ok'
      );
    });
  }

  /**
   * Test panel wiring.
   *
   * Every button posts a real gift to /api/simulate/gift, so the event travels
   * the exact same path a TikTok gift does: server applies the economy,
   * broadcasts over Socket.IO, client reacts. Testing a shortcut path would
   * prove nothing — this proves the real one.
   */
  _initTestPanel() {
    const panel = document.getElementById('testpanel');
    const toggle = document.getElementById('testpanel-toggle');
    if (!panel || !toggle) return;

    toggle.addEventListener('click', () => panel.classList.toggle('is-open'));

    const userField = document.getElementById('test-user');
    const senderName = () => (userField?.value || 'tester1').trim() || 'tester1';

    const send = async (coins, giftName, username) => {
      try {
        const res = await fetch('/api/simulate/gift', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username || senderName(), coins, giftName })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          this.ui.announce(`Test gift failed: ${body.error || res.status}`, 'alert');
        }
      } catch (err) {
        this.ui.announce(`Test gift failed: ${err.message}`, 'alert');
      }
    };

    for (const btn of panel.querySelectorAll('.tbtn[data-coins]')) {
      btn.addEventListener('click', () => {
        send(Number(btn.dataset.coins), btn.dataset.gift);
      });
    }

    // Bulk spawns use distinct usernames so they become distinct fish — the
    // whole point is to see a populated arena, not one fish fed repeatedly.
    const NAMES = ['aysu', 'kenan', 'leyla', 'murad', 'nigar', 'orxan', 'perviz',
                   'rena', 'samir', 'tunay', 'ulvi', 'vusal', 'yasmin', 'zaur',
                   'aylin', 'bahar', 'ceyhun', 'dilara', 'elvin', 'fidan'];

    const spawnMany = async (count) => {
      for (let i = 0; i < count; i++) {
        const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? i : '');
        // Vary the opening gift so they arrive at different sizes.
        const coins = [1, 5, 10, 20][Math.floor(Math.random() * 4)];
        await send(coins, 'Test Spawn', name);
        await new Promise((r) => setTimeout(r, 90));   // let the server keep up
      }
    };

    document.getElementById('test-spawn5')?.addEventListener('click', () => spawnMany(5));
    document.getElementById('test-spawn20')?.addEventListener('click', () => spawnMany(20));
  }

  /**
   * Browsers will not let audio start without a user gesture, so the engine is
   * built lazily on the first click or key press. Until then it sits silent and
   * every cue is a no-op — nothing throws, nothing queues up.
   *
   * On a stream you click the window once anyway; if you want it running before
   * you go live, just hit the sound button.
   */
  _initAudio() {
    const unlock = () => {
      this.audio.unlock();
      this._syncSoundButton();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    // Two buttons drive the same mute state: the floating HUD toggle and the
    // one inside the admin panel (for streamers who keep the panel open).
    for (const id of ['sound-toggle', 'admin-sound-toggle']) {
      document.getElementById(id)?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.audio.unlock();
        this.audio.toggleMute();
        this.audio.uiClick();
        this._syncSoundButton();
      });
    }
  }

  /**
   * Keyboard and wheel controls.
   *
   *   wheel / + -   zoom in and out (works in both wide and focus shots)
   *   0             reset zoom
   *   O             cycle model orientation — the fix for fish swimming backwards
   *   Esc           back to the wide shot
   */
  _initControls() {
    // Zoom. Applied as a multiplier on whatever distance the director wants,
    // so it survives switching between fish and stays sensible at every size.
    window.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.director.nudgeZoom(e.deltaY > 0 ? 1.08 : 1 / 1.08);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      // Never steal keys from the admin panel's text fields.
      if (e.target instanceof HTMLInputElement) return;

      switch (e.key) {
        case '+': case '=':
          this.director.nudgeZoom(1 / 1.12);
          break;
        case '-': case '_':
          this.director.nudgeZoom(1.12);
          break;
        case '0':
          this.director.resetZoom();
          this.ui.announce('Zoom reset', 'ok');
          break;
        case 'o': case 'O': {
          // Cycle 0 / 90 / 180 / 270 and re-apply to every fish immediately.
          const next = (runtime.yawOffset + Math.PI / 2) % (Math.PI * 2);
          runtime.yawOffset = next;
          for (const fish of this.fishList) fish.refreshYaw();
          const degrees = Math.round((next * 180) / Math.PI);
          this.ui.announce(`Model orientation: ${degrees}°`, 'ok');
          console.info(
            `[orientation] MODEL_YAW_OFFSET = ${degrees === 0 ? '0' : `Math.PI * ${(degrees / 180).toFixed(2)}`} ` +
            `(${degrees}°). Paste this into public/js/config.js to make it permanent.`
          );
          break;
        }
        default:
          break;
      }
    });
  }

  _syncSoundButton() {
    const muted = this.audio.muted;

    const btn = document.getElementById('sound-toggle');
    const icon = document.getElementById('sound-icon');
    const label = document.getElementById('sound-label');
    if (btn) {
      btn.classList.toggle('is-muted', muted);
      btn.setAttribute('aria-pressed', String(!muted));
    }
    if (icon) icon.textContent = muted ? '🔇' : '🔊';
    if (label) label.textContent = muted ? 'Sound off' : 'Sound on';

    const adminBtn = document.getElementById('admin-sound-toggle');
    const adminIcon = document.getElementById('admin-sound-icon');
    const adminLabel = document.getElementById('admin-sound-label');
    if (adminBtn) adminBtn.setAttribute('aria-pressed', String(!muted));
    if (adminIcon) adminIcon.textContent = muted ? '🔇' : '🔊';
    if (adminLabel) adminLabel.textContent = muted ? 'Sound off' : 'Sound on';
  }

  // -------------------------------------------------------------- network --

  _onFullState({ fish = [], maxActive, mongoConnected, tiktokConnected, simulate }) {
    this.maxActive = maxActive || this.maxActive;
    this.mongoConnected = mongoConnected;
    this.tiktokConnected = tiktokConnected;
    this.simulate = simulate;
    this._refreshStatus();

    // Reconcile rather than rebuild — a full teardown would visibly stutter.
    const seen = new Set();
    for (const record of fish) {
      seen.add(record.username);
      const existing = this.fish.get(record.username);
      if (existing) existing.setState(record);
      else this._spawnFish(record, { silent: true });
    }
    for (const username of [...this.fish.keys()]) {
      if (!seen.has(username)) this._removeFish(username, { silent: true });
    }
  }

  _refreshStatus() {
    this.ui.setStatus({
      mongo: this.mongoConnected,
      tiktok: this.tiktokConnected,
      simulate: this.simulate
    });
  }

  /** A gift arrived. The server already did the HP maths; we render it. */
  _onGift(payload) {
    if (!payload || this.giftsPaused) return;
    console.log(`[CLIENT GIFT] User: ${payload.username} | Gift: ${payload.giftName} | Coins: ${payload.coins} | Power: ${payload.power}`);
    const { username, nickname, hpGain, power, giftName, isNew } = payload;

    let fish = this.fish.get(username);
    if (!fish) {
      if (this.fish.size >= this.maxActive) {
        this.ui.announce(`${nickname} is queued — arena is full`, 'warn');
        return;
      }
      fish = this._spawnFish(payload, { silent: true });
      this.ui.announce(`${nickname} entered the water`, 'ok');
    }

    const previousLevel = fish.level;
    fish.setState(payload);

    this.ui.announce(`${nickname} +${Math.round(hpGain)} HP · ${giftName}`, 'gift');
    // Like-threshold rewards carry no coins and repeat far more often than a
    // real gift, so they get their own lighter chime instead of the coin
    // arpeggio (which would otherwise always play at its lowest, 0-coin tier).
    if (giftName === 'Like Reward') {
      this.audio.likeReward();
    } else {
      this.audio.gift(payload.coins || 1);
    }

    // A gift is the only thing a viewer can actually DO, so it has to land
    // harder than anything else on screen: gold number on the fish, a burst of
    // particles, and a camera push for the big ones.
    const size = { width: window.innerWidth, height: window.innerHeight };
    this.ui.spawnDamage(fish.root.position, hpGain, this.camera, size, 'gift');
    this.effects.giftBurst?.(fish.root.position, Math.min(2.5, 0.8 + (payload.coins || 1) / 40));
    // Low-coin chaos layer — see the comment on Effects.bulletScatter(). Runs
    // on every real gift, cheap ones included, so a 1-coin Rose still sprays.
    // Excluded for Like Reward: it's coins:0 and (per the comment above) can
    // repeat far more often than a real gift on a busy stream, so a 50-100
    // particle burst on every one of those would spam the screen instead of
    // reading as chaos.
    if (giftName !== 'Like Reward') {
      this.effects.bulletScatter?.(fish.root.position, payload.coins || 1);
    }
    if ((payload.coins || 0) >= 20) this.effects.shake(0.5 + Math.min(1.2, payload.coins / 60));

    if (fish.level > previousLevel) {
      this._onEvolve(fish, previousLevel);
    }

    if (power) this._triggerPower(fish, power);
  }

  _onEvolve(fish, from) {
    const band = bandFor(fish.level);
    this.effects.ring(fish.root.position, {
      color: fish.level >= 10 ? 0xffb347 : 0x35f0c8,
      from: 1, to: 18 * fish.scale, duration: 0.9, tilt: false
    });
    this.effects.addTrauma(fish.level >= 10 ? 0.45 : 0.15);
    const tone = fish.level >= 10 ? 'alert' : 'ok';
    const label = fish.level >= 10 ? `${fish.nickname} became a TITAN — ${band.species}` : `${fish.nickname} evolved to L${fish.level} ${band.species}`;
    this.ui.announce(label, tone);
    this.audio.evolve(fish.level);
  }

  _onReset() {
    for (const username of [...this.fish.keys()]) this._removeFish(username, { silent: true });
    this.director.spectate(null);
    this.ui.setSpectating(null);
    this.ui.announce('Arena reset', 'alert');
    this.audio.reset();
  }

  // ---------------------------------------------------------------- powers --

  _triggerPower(fish, power) {
    switch (power) {
      case 'bulletStorm': {
        // A 15-second continuous STREAM, not one instant burst — count shots
        // (currently 375), fireInterval seconds apart, each fired dead
        // straight from the caster's mouth at whatever it locked onto the
        // instant it left the muzzle. World Anchor: origin is re-read via
        // fish.mouthPosition() on every single shot (not captured once up
        // front), since a 15s stream means the caster keeps swimming for the
        // whole thing. Movement/targeting live in Effects.spawnBullet/
        // updateBullets; _resolveBulletHits applies damage once a bolt
        // reports a hit.
        //
        // QUEUE, don't restack: if this fish's PREVIOUS bulletStorm hasn't
        // finished firing yet (e.g. a x5 gift combo landing as 5 separate
        // power triggers within the same 15s), new shots are appended to the
        // tail of the existing schedule instead of starting a second,
        // independent 15s loop at t=0 — two loops running in parallel would
        // double the fire rate and desync from the steady fireInterval
        // cadence, which is the "overlapping timers" this avoids. A stale
        // entry (queue tail already in the past) is just a fresh start.
        const p = POWERS.bulletStorm;
        const now = this.elapsed;
        const queuedUntil = this.bulletStormQueue.get(fish.username) || 0;
        const startDelay = Math.max(0, queuedUntil - now);
        const isExtension = startDelay > 0;

        // audio.power('bulletStorm') is the heavy opening flourish (see
        // audio.js) — only for a fresh stream. Stacking it on every extension
        // would be its own wall-of-noise problem; a lighter announce instead
        // tells the viewer the barrage just got longer.
        if (isExtension) {
          this.ui.announce(`${fish.nickname} — ${p.label} EXTENDED`, 'power');
        } else {
          this.audio.power('bulletStorm');
          this.ui.announce(`${fish.nickname} — ${p.label}`, 'power');
        }

        for (let i = 0; i < p.count; i++) {
          this._schedule(startDelay + i * p.fireInterval, () => {
            if (fish.dead) return;
            // Muzzle, not the fish's center/rear — see fish.js mouthPosition().
            this.effects.spawnBullet(fish.mouthPosition(), fish, p, this.fishList);
            this.audio.bulletFire();
          });
        }
        this.bulletStormQueue.set(fish.username, now + startDelay + p.count * p.fireInterval);
        break;
      }

      case 'turbo': {
        // Pure speed + visual power — no damage tick, nothing to schedule.
        // fish.js already does all the work once power.turbo > 0: the
        // cyan aura shell, the point light, and a jetTrail() burst every
        // frame whose density scales with actual speed (_updatePowers), plus
        // the cruise-speed multiplier itself (_updateMotion). This case just
        // has to start the clock and announce it.
        fish.grantPower('turbo');
        this.ui.announce(`${fish.nickname} — ${POWERS.turbo.label} (${POWERS.turbo.duration}s)`, 'power');
        this.audio.power('turbo');
        break;
      }

      case 'ripple': {
        // WATER RIPPLE SHOCKWAVE — 8 pulses over 15s, single-hue aquatic
        // rings. Damage radius matches the full visual radius exactly (see
        // the block comment on POWERS.ripple for the real consequence of
        // that — it's close to an arena-wide pulse at this size). No push,
        // no stun: this is a pure damage-over-time field.
        const rp = POWERS.ripple;
        this.ui.announce(`${fish.nickname} — ${rp.label} (${rp.duration}s)`, 'power');
        this.audio.power('ripple');

        const pulses = Math.floor(rp.duration / rp.pulseInterval);
        for (let i = 0; i < pulses; i++) {
          this._schedule(i * rp.pulseInterval, () => {
            if (fish.dead) return;
            const origin = fish.root.position.clone();

            // Three concentric rings, one hue, staggered durations so they
            // read as a single ripple expanding outward rather than three
            // separate flashes landing together. tilt:true is the flat
            // orientation here — Effects.ring() sets rotation.x = -PI/2 for
            // tilt:true, 0 for tilt:false, so tilt:false (what every other
            // power in this file uses) is actually the UPRIGHT ring; the
            // opposite of what its name suggests. That's the bug: copying
            // shockwave's tilt:false gave this power vertical rings that
            // swept past fish instead of through them.
            this.effects.ring(origin, { color: rp.color, from: 1, to: rp.visualRadius, duration: 0.9, tilt: true });
            this.effects.ring(origin, { color: rp.color, from: 1, to: rp.visualRadius * 0.62, duration: 0.65, tilt: true });
            this.effects.ring(origin, { color: 0xeafffb, from: 1, to: rp.visualRadius * 0.3, duration: 0.45, tilt: true });

            this.audio.ripplePulse();

            const dmg = rp.damageMin + Math.random() * (rp.damageMax - rp.damageMin);
            // horizontal:true — XZ-plane distance only, ignoring Y, so the
            // hitbox matches the flat disc exactly rather than a 3D sphere
            // that happens to mostly agree with it because fish sit in a
            // narrow depth band.
            this._damageArea(fish, origin, rp.radius, dmg, { horizontal: true });
          });
        }
        break;
      }

      case 'heal': {
        // HEAL BOOST — 20 coins, temporary placeholder power (see
        // config.js POWERS.heal). The +120 HP itself already landed
        // through the same server-authoritative gift.hp path every gift
        // uses, and already has its generic "+120 HP" popup/announce from
        // _onGift above — this is purely the extra green flourish that
        // sells it as a heal rather than a plain gift.
        const hp = POWERS.heal;
        this.ui.announce(`${fish.nickname} — ${hp.label}`, 'power');
        this.audio.power('heal');
        this.effects.heal(fish.root.position, hp);
        break;
      }

      case 'rotor': {
        // ROTOR BLADE STORM — 100 coins. Moved up from the 20-coin tier
        // (server/rules.js); that slot now holds Heal Boost instead
        // (case 'heal' above). beamRotor's own code is untouched in case
        // it's needed again, just unbound from this tier.
        //
        // Sustained field again (not the single-instant-burst version from
        // last revision): blades spin continuously for the full duration
        // (effects.js spawnRotorBlades), and a periodic AoE tick lands on
        // its own _schedule loop every tickInterval — every fish caught in
        // range takes damage on EVERY tick it stays there, plus a light
        // pull dragging it deeper in rather than letting it drift out after
        // one hit.
        const rt = POWERS.rotor;
        this.ui.announce(`${fish.nickname} — ${rt.label} (${rt.duration}s)`, 'power');
        this.audio.power('rotor');
        this.effects.spawnRotorBlades(fish, rt);
        // Caster shield: full immunity for the whole cast so the fish can't
        // be finished off by another power while its own blades are out.
        // _damageArea already exempts the caster from its own rotor hits;
        // this covers everything else (fish.js takeDamage → rotorShield).
        fish.shieldSelf(rt.duration);

        const ticks = Math.floor(rt.duration / rt.tickInterval);
        for (let i = 0; i < ticks; i++) {
          this._schedule(i * rt.tickInterval, () => {
            if (fish.dead) return;
            const origin = fish.root.position.clone();
            this.audio.rotorTick();

            const dmg = rt.damageMin + Math.random() * (rt.damageMax - rt.damageMin);
            // horizontal:true so the hitbox matches the flat spinning-blade
            // plane, not a 3D sphere.
            this._damageArea(fish, origin, rt.radius, dmg, { horizontal: true, pull: rt.pullForce });
          });
        }
        break;
      }

      case 'shockwave': {
        this.effects.addTrauma(POWERS.shockwave.trauma);
        this.ui.announce(`${fish.nickname} — ${POWERS.shockwave.label} (10s)`, 'power');
        this.audio.power('shockwave');

        // A pulse every 1.5s for ten seconds — about seven waves. Each one
        // shoves everyone nearby hard outward, so for the whole duration nobody
        // can hold position near this fish. That sustained zone of control is
        // what makes the power legible; a single wave was over before anyone
        // noticed it had happened.
        const waves = Math.floor(POWERS.shockwave.duration / POWERS.shockwave.interval);
        for (let i = 0; i < waves; i++) {
          this._schedule(i * POWERS.shockwave.interval, () => {
            if (fish.dead) return;
            const origin = fish.root.position.clone();

            // Neon cyan/magenta blast, purely cosmetic and reaching well past
            // the actual damage radius (POWERS.shockwave.radius, used below in
            // _damageArea) — the visual sells a bigger blast than the hit box
            // without touching combat balance. Colors alternate per wave so a
            // sustained shockwave pulses rather than repeating one flat color.
            const [outerColor, innerColor] = i % 2 === 0
              ? [0x00fff7, 0xff00e6]
              : [0xff00e6, 0x00fff7];
            this.effects.ring(origin, {
              color: outerColor, from: 1, to: POWERS.shockwave.radius * 1.9, duration: 0.5, tilt: false
            });
            this.effects.ring(origin, {
              color: innerColor, from: 1, to: POWERS.shockwave.radius * 1.3, duration: 0.4, tilt: false
            });
            this.effects.ring(origin, {
              color: 0xffffff, from: 1, to: POWERS.shockwave.radius * 0.7, duration: 0.3, tilt: false
            });
            this.effects.addTrauma(0.3);
            this.audio.power('shockwave');

            this._damageArea(fish, origin, POWERS.shockwave.radius, POWERS.shockwave.damagePerWave, {
              stun: POWERS.shockwave.stun,
              push: POWERS.shockwave.push
            });
          });
        }
        break;
      }

      case 'missiles': {
        // Twelve independent homing projectiles, not an instant radius blast —
        // splash damage lands only when each one actually reaches its target
        // (or times out), resolved by _resolveMissileHits every frame.
        const origin = fish.root.position.clone();
        this.effects.launchMissiles(origin, fish, POWERS.missiles, this.fishList);
        this.audio.power('missiles');
        this.ui.announce(`${fish.nickname} — ${POWERS.missiles.label}`, 'power');
        break;
      }

      case 'pinball': {
        // Four physical, avatar-textured spheres that persist and bounce
        // around the arena for the full duration (not a stream/burst that
        // vanishes on first hit) — resolved every frame by
        // _resolvePinballHits (fish contact + wall-bounce audio) and
        // effects.updatePinballOrbs (movement/wall physics), same split as
        // Shuriken Storm's blades.
        const origin = fish.root.position.clone();
        this.effects.launchPinballOrbs(origin, fish, POWERS.pinball);
        this.audio.power('pinball');
        this.ui.announce(`${fish.nickname} — ${POWERS.pinball.label}`, 'power');
        break;
      }

      case 'beamRotor': {
        // Physical rotating laser beams, not expanding rings. Hit-testing is
        // real geometry (angle + reach), resolved on a fixed tick by
        // _resolveBeamHits so viewers can see exactly why a fish did or
        // didn't get hit.
        fish.grantPower('beamRotor');
        this.effects.addTrauma(0.5);
        this.audio.power('rotor');
        this.ui.announce(`${fish.nickname} — ${POWERS.beamRotor.label} (${POWERS.beamRotor.duration}s)`, 'power');

        const entry = this.effects.spawnBeamRotor(fish, POWERS.beamRotor);
        const ticks = Math.floor(POWERS.beamRotor.duration / POWERS.beamRotor.tickInterval);
        for (let i = 0; i < ticks; i++) {
          this._schedule(i * POWERS.beamRotor.tickInterval, () => {
            if (fish.dead) return;
            this._resolveBeamHits(entry);
          });
        }
        break;
      }

      default:
        break;
    }
  }

  /** 360 Beam Rotor — one hit-testing tick against every live beam. See POWERS.beamRotor. */
  _resolveBeamHits(entry) {
    if (!entry || entry.fish.dead) return;
    const origin = entry.fish.root.position;
    const size = { width: window.innerWidth, height: window.innerHeight };

    for (const beam of entry.beams) {
      beam.tip.getWorldPosition(_v1);
      const dx = _v1.x - origin.x;
      const dz = _v1.z - origin.z;
      const beamAngle = Math.atan2(dz, dx);
      const beamLenSq = dx * dx + dz * dz;

      for (const target of this.fishList) {
        if (target === entry.fish || target.dead) continue;
        const tx = target.root.position.x - origin.x;
        const tz = target.root.position.z - origin.z;
        const distSq = tx * tx + tz * tz;
        if (distSq > beamLenSq) continue;

        let diff = Math.abs(Math.atan2(tz, tx) - beamAngle);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        if (diff > POWERS.beamRotor.angularWidth) continue;

        this.effects.clash(target.root.position, 0.6, 0, 0);
        this.ui.spawnDamage(target.root.position, POWERS.beamRotor.damagePerTick, this.camera, size, 'heavy');
        target.shoveFrom(origin, POWERS.beamRotor.push);
        target.stun(POWERS.beamRotor.stun);
        this._damage(entry.fish, target, POWERS.beamRotor.damagePerTick);
      }
    }
  }

  _schedule(delay, fn) {
    this.scheduled.push({ t: delay, fn });
  }

  // ---------------------------------------------------------------- combat --

  /**
   * Target selection. Returns the best legal prey, or null.
   * Scored by distance with a mild bias toward weaker fish, so a shark picks
   * the easy meal next to it rather than sprinting across the map.
   */
  /**
   * Damage from one impact. Both fish are hurt — that is the whole point.
   *
   * Damage scales with the OTHER fish's mass, so a Titan ramming a minnow
   * devastates it while barely feeling the return hit. But it does feel it, and
   * that changes everything: a Titan that bullies its way through ten small
   * fish arrives at the next Titan already wounded. Under the old rules the
   * biggest fish took literally zero damage on the way up, so the leaderboard
   * could never turn over and the stream had no story.
   *
   * The `impactScale` on top rewards head-on collisions over glancing ones, so
   * viewers can see which hits mattered.
   */
  _resolveImpact(a, b, impact) {
    const massA = a.mass;
    const massB = b.mass;
    const total = massA + massB;

    const impactScale = THREE.MathUtils.clamp(impact / PHYSICS.baseSpeed, 0.35, 2.2);

    // Each fish takes damage proportional to the other's share of the mass.
    const toA = COMBAT.impactDamage * (massB / total) * 2 * impactScale;
    const toB = COMBAT.impactDamage * (massA / total) * 2 * impactScale;

    const contact = _v1
      .copy(a.root.position)
      .add(b.root.position)
      .multiplyScalar(0.5);

    // The impact moment. This is what makes a collision read as a HIT rather
    // than two models overlapping — spark, shockwave ring, directional debris
    // and a shake proportional to the force.
    const nx = (a.root.position.x - b.root.position.x);
    const nz = (a.root.position.z - b.root.position.z);
    const nl = Math.hypot(nx, nz) || 1;
    const power = THREE.MathUtils.clamp(impactScale / 1.6, 0.15, 1);

    this.effects.clash(contact, power, nx / nl, nz / nl);

    /**
     * HIT STOP — the single most effective trick in game feel.
     *
     * On a heavy impact the entire world freezes for a few frames. It costs
     * almost nothing and it is why a hit in a fighting game lands like a truck
     * while the same hit without it feels like two sprites overlapping. The
     * brain reads the pause as mass.
     *
     * Scaled by force and capped hard: too long and the arena looks like it's
     * lagging rather than punching.
     */
    if (power > 0.55) {
      this.hitStop = Math.max(this.hitStop, 0.04 + power * 0.055);
      // Punch the camera toward the contact so the eye is dragged to it.
      this.effects.addTrauma(0.25 + power * 0.45);
    }

    // Both fish recoil — visible knockback sells the exchange better than any
    // particle, because it changes something the viewer was already tracking.
    a.recoil(power);
    b.recoil(power);
    this.effects.blood(contact, THREE.MathUtils.clamp(impactScale * 0.6, 0.3, 1.2));
    this.audio.bite(THREE.MathUtils.clamp(impactScale / 2, 0.2, 1));

    // Floating combat text on BOTH fish. Showing only the loser's damage would
    // hide the thing that makes this arena fair — that everyone pays a price.
    const size = { width: window.innerWidth, height: window.innerHeight };
    const heavy = impactScale > 1.4;
    this.ui.spawnDamage(a.root.position, toA, this.camera, size, heavy ? 'heavy' : 'hit');
    this.ui.spawnDamage(b.root.position, toB, this.camera, size, heavy ? 'heavy' : 'hit');

    this._damage(b, a, toA);
    this._damage(a, b, toB);
  }

  _damage(attacker, target, amount) {
    if (!target || target.dead) return;

    const contact = attacker ? attacker.mouthPosition() : target.root.position.clone();
    const result = target.takeDamage(amount, this.ctx);

    if (result === 'blocked') return;

    this.net.queueSync(target.username, target.hp);

    if (result === 'hit') {
      this.effects.blood(contact, Math.min(2, amount / 200 + 0.5));
      this.audio.hurt(Math.min(1, amount / 400));
      return;
    }

    if (result === 'leveldown') {
      this.effects.blood(target.root.position, 2);
      this.effects.ring(target.root.position, { color: 0xff4d6d, from: 1, to: 16 * target.scale, duration: 0.8, tilt: false });
      this.effects.addTrauma(0.3);
      this.ui.announce(`${target.nickname} dropped to L${target.level}`, 'alert');
      this.audio.demote();
      return;
    }

    if (result === 'dead') {
      this.effects.blood(target.root.position, 3);
      this.effects.ring(target.root.position, { color: 0xff4d6d, from: 1, to: 22, duration: 1 });
      this.effects.addTrauma(0.4);
      this.ui.announce(`${target.nickname} was eliminated`, 'alert');
      this.audio.death();
      this.net.reportDeath(target.username);
      this._removeFish(target.username, { silent: true });
    }
  }

  /**
   * Blade-vs-fish contact.
   *
   * Each blade keeps its own per-fish cooldown, so a blade riding alongside a
   * fish for a second deals one hit rather than sixty. Without that, a single
   * Spike Burst would delete the entire arena instantly.
   */
  _resolveBladeHits() {
    const blades = this.effects.blades;
    if (!blades.length) return;

    for (const blade of blades) {
      for (const fish of this.fishList) {
        if (fish.dead || fish.username === blade.owner) continue;
        if (blade.hits.has(fish.username)) continue;
        // Global per-fish rate limit — see POWERS.spikes.fishHitCooldown.
        if (fish.bladeImmunity > 0) continue;

        const reach = blade.radius + fish.radius;
        if (blade.mesh.position.distanceToSquared(fish.root.position) > reach * reach) continue;

        blade.hits.set(fish.username, POWERS.spikes.hitCooldown);
        fish.bladeImmunity = POWERS.spikes.fishHitCooldown;

        this.effects.clash(blade.mesh.position, 0.5, 0, 0);
        this.audio.hurt(0.5);
        this.ui.spawnDamage(
          fish.root.position, POWERS.spikes.damage, this.camera,
          { width: window.innerWidth, height: window.innerHeight }, 'hit'
        );
        this._damage(null, fish, POWERS.spikes.damage);
        fish.stun(0.4);
        this.effects.clash(blade.mesh.position, 0.8, 0, 0);
        this.effects.addTrauma(0.2);

        // Deflect the blade so it visibly ricochets off the body.
        blade.vx = -blade.vx * 0.75 + (Math.random() - 0.5) * 8;
        blade.vz = -blade.vz * 0.75 + (Math.random() - 0.5) * 8;

        // Spin burst on contact.
        blade.spin *= -2.5;

        this.effects.ring(blade.mesh.position, {
          color: 0xffe066,
          from: 0.5,
          to: 8,
          duration: 0.3,
          tilt: false
        });
        this.effects.giftBurst(blade.mesh.position, 0.4);
        this.effects.addTrauma(0.15);
      }
    }
  }

  /**
   * Bouncing Logo Sphere contact — wall-bounce audio plus fish-vs-orb
   * damage/ricochet, both per frame. Deliberately lighter-weight VFX than
   * _resolveBladeHits (a modest clash() only, no ring/giftBurst) per the
   * "no heavy glow / no particle spam" request for this power — see
   * POWERS.pinball's block comment.
   */
  _resolvePinballHits() {
    const orbs = this.effects.pinballOrbs;
    if (!orbs.length) return;

    for (const orb of orbs) {
      if (orb.justBounced) {
        orb.justBounced = false;
        this.audio.pinballBounce();
      }

      for (const fish of this.fishList) {
        if (fish.dead || fish === orb.owner) continue;
        if (orb.hits.has(fish.username)) continue;
        // Global per-fish rate limit — see POWERS.pinball.fishHitCooldown.
        if (fish.pinballImmunity > 0) continue;

        const reach = orb.radius + fish.radius;
        if (orb.mesh.position.distanceToSquared(fish.root.position) > reach * reach) continue;

        orb.hits.set(fish.username, POWERS.pinball.hitCooldown);
        fish.pinballImmunity = POWERS.pinball.fishHitCooldown;

        this.effects.clash(orb.mesh.position, 0.35, 0, 0);
        this.audio.pinballBounce();
        this.audio.hurt(0.4);
        this.ui.spawnDamage(
          fish.root.position, POWERS.pinball.damage, this.camera,
          { width: window.innerWidth, height: window.innerHeight }, 'hit'
        );
        this._damage(null, fish, POWERS.pinball.damage);
        fish.stun(0.25);

        // Deflect the orb so it visibly ricochets off the fish, same trick
        // _resolveBladeHits uses for its blades.
        orb.vx = -orb.vx * 0.7 + (Math.random() - 0.5) * 6;
        orb.vz = -orb.vz * 0.7 + (Math.random() - 0.5) * 6;
      }
    }
  }

  /** Gatling Bullet Storm contact — damage lands once Effects flags a bullet as arrived. */
  _resolveBulletHits() {
    const bullets = this.effects.bullets;
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      if (!b.hit) continue;

      if (b.hit !== 'expired') {
        this._damage(b.owner, b.hit, POWERS.bulletStorm.damage);
        this.effects.spark(b.mesh.position, POWERS.bulletStorm.color);
      }
      this.effects.removeBullet(b);
    }
  }

  /** Homing Missile Volley contact — splash damage once Effects flags an impact. */
  _resolveMissileHits() {
    const missiles = this.effects.missiles;
    for (let i = missiles.length - 1; i >= 0; i--) {
      const m = missiles[i];
      if (!m.exploded) continue;

      if (m.target && !m.target.dead) {
        const origin = m.mesh.position.clone();
        this.effects.missileExplosion(origin, POWERS.missiles.explosionRadius);
        this.audio.hurt(1);
        this._damageArea(m.owner, origin, POWERS.missiles.explosionRadius, POWERS.missiles.damage, {
          push: POWERS.missiles.push,
          stun: POWERS.missiles.stun
        });
      }
      this.effects.removeMissile(m);
    }
  }

  _damageArea(source, position, radius, amount, opts = {}) {
    const radiusSq = radius * radius;
    for (const fish of this.fishList) {
      if (fish === source || fish.dead) continue;

      // horizontal:true — XZ-plane distance only, ignoring Y. For a flat
      // disc effect (Water Ripple, Rotor Blade Storm) the hitbox has to
      // match the flat visual exactly, not a 3D sphere that only mostly
      // agrees with it because fish happen to sit in a narrow depth band.
      // No allocation: computed directly from the components rather than a
      // scratch Vector3.
      if (opts.horizontal) {
        const dx = fish.root.position.x - position.x;
        const dz = fish.root.position.z - position.z;
        if (dx * dx + dz * dz > radiusSq) continue;
      } else if (fish.root.position.distanceToSquared(position) > radiusSq) {
        continue;
      }

      // Light suction toward the caster (Rotor Blade Storm) — separate from
      // the outward push below, and never both on the same call in
      // practice, but nothing stops it structurally if a future power wants
      // pull-then-release.
      if (opts.pull) fish.pullToward(position, opts.pull);

      if (opts.hit && opts.hit(fish) === false) continue;

      if (opts.stun) fish.stun(opts.stun);

      // Hard outward shove. This is what sells a shockwave: seeing everyone
      // physically thrown away from the caster is far more legible than any
      // number, and it clears a visible pocket of space around them.
      if (opts.push) fish.shoveFrom(position, opts.push);

      // Rotor victims get a visible recoil and a damage number, so being cut
      // reads as being cut rather than as a silent HP drain.
      if (opts.shred) {
        fish.recoil(0.8);
        this.ui.spawnDamage(
          fish.root.position, amount, this.camera,
          { width: window.innerWidth, height: window.innerHeight }, 'heavy'
        );
        this.effects.clash(fish.root.position, 0.7, 0, 0);
      }

      if (opts.silent) {
        // Damage-over-time: skip the blood spray, keep the bookkeeping.
        // Refresh the poison timer so the red tint lasts as long as the aura
        // keeps reaching them, and show a small number so the melt is visible.
        if (opts.poison) {
          fish.poisoned = Math.max(fish.poisoned, 1.2);
          this.effects.poisonBomb(fish.root.position, radius * 0.3, 0.6);
          this.ui.spawnDamage(
            fish.root.position, amount, this.camera,
            { width: window.innerWidth, height: window.innerHeight }, 'hit'
          );
        }
        const result = fish.takeDamage(amount, this.ctx);
        if (result === 'blocked') continue;
        this.net.queueSync(fish.username, fish.hp);
        if (result === 'dead') {
          this.ui.announce(`${fish.nickname} was eliminated`, 'alert');
          this.net.reportDeath(fish.username);
          this._removeFish(fish.username, { silent: true });
        } else if (result === 'leveldown') {
          this.ui.announce(`${fish.nickname} dropped to L${fish.level}`, 'alert');
        }
        continue;
      }

      this._damage(source, fish, amount);
    }
  }

  // ------------------------------------------------------------- roster ----

  _spawnFish(record, { silent = false } = {}) {
    if (this.fish.has(record.username)) return this.fish.get(record.username);
    if (this.fish.size >= this.maxActive) return null;

    const fish = new Fish(record, this.library, this.scene);
    this.fish.set(record.username, fish);
    this.fishList = [...this.fish.values()];
    if (!silent) this.ui.announce(`${fish.nickname} entered the water`, 'ok');
    this.audio.spawn();
    this.ui.setFishCount(this.fish.size, this.maxActive);
    return fish;
  }

  _removeFish(username, { silent = false } = {}) {
    const fish = this.fish.get(username);
    if (!fish) return;

    // This can run on a still-ALIVE fish (e.g. a server-driven fish:remove,
    // not a combat death) — every scheduled power closure (rotor ticks,
    // bulletStorm shots, ...) starts with `if (fish.dead) return;`, and
    // without this those guards stay false for a fish that's already been
    // disposed, letting a stray tick fire _damageArea/etc. against a
    // stale, frozen position after the fish is gone.
    fish.dead = true;

    // A stale queued-until timestamp under a reused username would otherwise
    // delay a brand new fish's first bulletStorm shots, mistaking them for an
    // extension of a stream that died with the old fish.
    this.bulletStormQueue.delete(username);

    // Anything still holding a reference must let go before disposal.
    this.director.onFishRemoved(fish);
    if (this.director.subject === null) this.ui.setSpectating(null);
    for (const other of this.fishList) {
      if (other.target === fish) {
        other.target = null;
        other.lockTimer = 0;
      }
    }

    fish.dispose();
    this.fish.delete(username);
    this.fishList = [...this.fish.values()];
    this.ui.setFishCount(this.fish.size, this.maxActive);
    if (!silent) this.ui.announce(`${fish.nickname} left the arena`, 'warn');
  }

  _spectate(username) {
    if (!username) {
      this.director.spectate(null);
      this.ui.setSpectating(null);
      return;
    }
    const fish = this.fish.get(username);
    if (!fish) return;
    // Clicking the eye on the fish you're already watching returns to the wide shot.
    if (this.director.subject === fish) {
      this.director.spectate(null);
      this.ui.setSpectating(null);
      return;
    }
    this.director.spectate(fish);
    this.ui.setSpectating(fish);
  }

  // --------------------------------------------------------------- loop ----

  _frame() {
    if (!this.running) return;

    // Clamp dt. Tab-switching produces multi-second deltas that would teleport
    // every fish through the arena wall on the first frame back.
    const raw = this.clock.getDelta();
    let dt = Math.min(raw, 0.05);

    /**
     * Apply hit stop.
     *
     * Time is slowed to a crawl rather than stopped dead — a true freeze reads
     * as a dropped frame, while 12% speed reads as impact. Effects and the
     * camera keep running at full speed below (they use `raw`), so particles
     * still bloom and the shake still fires during the pause. That contrast is
     * the whole trick.
     */
    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - raw);
      dt *= 0.12;
    }

    this.elapsed += dt;

    this._runScheduled(dt);

    this.world.update(dt, this.elapsed);

    // Move everyone first, then resolve every collision. Doing it in that
    // order means a collision is computed from a consistent snapshot of the
    // arena rather than depending on which fish happened to update first.
    const list = this.fishList;

    // Taper particle intensity and bloom glow together as the arena fills up —
    // must run before any fish this frame can spawn a burst (e.g. turbo's
    // jetTrail, called from inside fish.update below).
    this.effects.setActivity(list.length);
    if (this.bloom) {
      const over = Math.max(0, list.length - RENDER.clutterFishThreshold);
      this.bloom.strength = this.baseBloomStrength * Math.max(
        RENDER.clutterBloomFloor,
        1 - over * RENDER.clutterBloomFalloffPerFish
      );
    }

    for (const fish of list) fish.update(dt, this.elapsed, this.ctx);

    // Two relaxation passes: resolving A-B can push A into C, and one pass
    // would leave that overlap visible for a frame.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (a.dead || b.dead) continue;

          const impact = a.collideWith(b);
          if (impact <= 0) continue;

          // Only the first pass may deal damage, and only once per pair per
          // cooldown — otherwise a pair grinding against each other would take
          // damage every single frame and evaporate in under a second.
          if (pass === 0 && a.canCollideWith(b)) {
            a.markCollided(b);
            this._resolveImpact(a, b, impact);
          }
        }
      }
    }
    // Collision separation is a raw positional push and can shove a body
    // through a wall, so containment always gets the final say.
    for (const fish of this.fishList) fish.contain();

    // Blades move and damage on contact. Owner is immune to their own blades —
    // otherwise buying Spike Burst would be a way to kill yourself.
    this.effects.updateBlades(dt, ARENA);
    this._resolveBladeHits();

    // Bouncing Logo Spheres: same move-then-resolve shape as blades above —
    // orbs persist and ricochet off walls/fish rather than vanishing on hit.
    this.effects.updatePinballOrbs(dt, ARENA);
    this._resolvePinballHits();

    // Gatling Bullet Storm: move every live round, then resolve hits against
    // the current fish list. Homing Missile Volley and 360 Beam Rotor follow
    // the same move-then-resolve shape.
    this.effects.updateBullets(dt);
    this._resolveBulletHits();
    this.effects.updateMissiles(dt, this.fishList);
    this._resolveMissileHits();
    this.effects.updateBeamRotors(dt);
    this.effects.updateRotorBlades(dt);

    // Effects and camera run on REAL time, so the world freezes but the impact
    // itself keeps blooming — that contrast is what reads as force.
    this.effects.update(raw);
    this.director.update(raw, this.effects.shakeOffset);

    this.ui.updateLeaderboard(dt, this.fishList, this.director.subject?.username ?? null);
    this.ui.updateLeader(this.fishList);
    this.ui._updatePopups(dt);
    this.ui.updateNameplates(this.fishList, this.camera, {
      width: window.innerWidth, height: window.innerHeight
    }, dt);

    this._adaptQuality(raw);
    this.composer.render();
  }

  _runScheduled(dt) {
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      this.scheduled[i].t -= dt;
      if (this.scheduled[i].t <= 0) {
        const job = this.scheduled.splice(i, 1)[0];
        try { job.fn(); } catch (err) { console.error('[schedule]', err); }
      }
    }
  }

  /**
   * Adaptive resolution. A live stream must not drop frames, so if the average
   * frame time creeps past 22ms we quietly render at a lower internal
   * resolution and scale back up when there's headroom again.
   */
  _adaptQuality(rawDelta) {
    this.frameAvg = this.frameAvg * 0.94 + rawDelta * 1000 * 0.06;
    this.qualityCooldown -= rawDelta;
    if (this.qualityCooldown > 0) return;

    const base = Math.min(window.devicePixelRatio, RENDER.maxPixelRatio);
    let next = this.qualityScale;
    if (this.frameAvg > 22 && this.qualityScale > 0.6) next = this.qualityScale - 0.15;
    else if (this.frameAvg < 13 && this.qualityScale < 1) next = Math.min(1, this.qualityScale + 0.1);

    if (next !== this.qualityScale) {
      this.qualityScale = next;
      this.renderer.setPixelRatio(base * next);
      this.qualityCooldown = 3;
    }
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    // The composer keeps its own render targets — resize them too, or the game
    // renders at the old resolution and looks blurry after any window change.
    this.composer?.setSize(w, h);
    this.bloom?.setSize(w, h);
  }
}

// ------------------------------------------------------------------ launch --

/**
 * Gate the whole boot sequence behind the subscription check — there is no
 * point preloading models and opening a socket just to redirect away a
 * moment later. ensureAuthorized() has already redirected to /login.html by
 * the time it resolves false, so there's nothing further to do here.
 */
(async () => {
  const authorized = await ensureAuthorized();
  if (!authorized) return;
  startAuthHeartbeat();

  const game = new Game();
  window.__fishBattle = game;   // handy for debugging from the console

  game.start().catch((err) => {
    console.error('[fatal]', err);
    const loader = document.getElementById('loader-note');
    if (loader) loader.textContent = `Could not start: ${err.message}`;
  });
})();

// Never let one bad frame kill the stream.
window.addEventListener('error', (e) => console.error('[window]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[promise]', e.reason));