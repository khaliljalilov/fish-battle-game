/**
 * fish.js — one viewer, one shark.
 *
 * A Fish owns its model, its motion, its AI, and its active powers. It never
 * touches the DOM, the socket, or other fish directly — the Game passes a
 * context object in and collects the results. That keeps combat deterministic
 * and makes the whole thing testable frame by frame.
 *
 * Motion is deliberately layered so nothing ever snaps:
 *   heading  -> lerped direction vector
 *   rotation -> quaternion slerp toward the heading
 *   roll     -> lerped bank angle proportional to turn rate
 *   bob      -> sinusoidal offset on the body holder, not the root
 */

import * as THREE from 'three';
import {
  ARENA, COMBAT, MOVEMENT, PHYSICS, POWERS, runtime,
  LEVEL_BANDS, levelForHP, maxHPForLevel, bandFor, scaleForHP
} from './config.js';

const BODY_LENGTH_AT_SCALE_1 = 4.2;

// Scratch objects — reused every frame so the GC never runs during play.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
/** Reused for the one-shot render-size audit. Never allocate in the loop. */
const _box = new THREE.Box3();
/** Poison tint target. Module-level so it's allocated once. */
const _poison = new THREE.Color(0xff3a2a);
/** Turbo tint target for materials with no emissive channel (e.g. MeshBasicMaterial
 *  from a glTF's KHR_materials_unlit export) — every real fish model in this project
 *  loads that way, so this is not a rare fallback. */
const _turboTint = new THREE.Color(POWERS.turbo.glowColor);
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

export class Fish {
  /**
   * @param {object} data      {username, nickname, hp, level, coinsSpent, avatar}
   * @param {ModelLibrary} library
   * @param {THREE.Scene} scene
   */
  constructor(data, library, scene) {
    this.library = library;
    this.scene = scene;

    this.username = data.username;
    this.nickname = data.nickname || data.username;
    this.avatar = data.avatar || null;
    this.hp = Math.max(1, data.hp ?? 100);
    this.level = data.level ?? levelForHP(this.hp);
    this.coinsSpent = data.coinsSpent ?? 0;

    this.dead = false;
    this.dirty = false;          // needs a persistence sync

    // --- transform hierarchy -------------------------------------------------
    // root      : world position + heading (what lookAt drives)
    //   bobber  : vertical bob + roll (never fights the heading)
    //     model : the actual mesh, pre-rotated to face +Z
    this.root = new THREE.Object3D();
    this.bobber = new THREE.Object3D();
    this.root.add(this.bobber);
    scene.add(this.root);

    this.modelInstance = null;
    this.mixer = null;
    this.actions = { swim: null, bite: null };
    this.proceduralTail = null;

    // --- motion state --------------------------------------------------------
    this.forward = new THREE.Vector3(0, 0, 1);
    this.speed = PHYSICS.baseSpeed;
    this.roll = 0;
    this.bobPhase = Math.random() * Math.PI * 2;
    this.tailPhase = Math.random() * Math.PI * 2;
    /** Decorative vertical drift phase. */
    this.driftPhase = Math.random() * Math.PI * 2;
    /** Transient bank applied after an impact, decays to 0. */
    this.bankTarget = 0;
    /** Per-opponent collision debounce, so one impact isn't counted 8 times. */
    this.collisionCooldowns = new Map();
    this.wallHits = 0;
    /** Seconds of remaining poison, drives the red tint. */
    this.poisoned = 0;
    /** Brief immunity after a shuriken hit, so a swarm can't one-shot. */
    this.bladeImmunity = 0;
    /** Brief immunity after a Bouncing Logo Sphere hit — same reason, so four orbs converging can't multi-hit in one frame. */
    this.pinballImmunity = 0;
    /** Impact squash, 0-1, decays each frame. */
    this.recoilPulse = 0;
    /** Rotor blade angle in radians, and the pulse-state accumulator. */
    this.rotorAngle = 0;
    this.rotorTick = 0;
    this.rotorPulseTimer = 0;
    this.rotorPulseActive = false;
    this.rotorPulseAge = 0;
    this.rotorPulseHits = new Set();
    this._ownMaterials = null;
    this._visualState = null;
    this._turboLight = null;

    /**
     * Personality.
     *
     * Forty fish running identical numbers move like a single organism — that
     * is the "dead" look. Each fish gets its own cruise speed, turning
     * eagerness, bobbing rhythm and restlessness, rolled once at birth. The
     * spread is small (±25%) but it's the difference between a shoal and a
     * formation.
     */
    this.trait = {
      speed: 0.85 + Math.random() * 0.35,
      agility: 0.8 + Math.random() * 0.5,
      bobPhase: Math.random() * Math.PI * 2,
      bobRate: 0.8 + Math.random() * 0.5,
      restless: 0.7 + Math.random() * 0.7,   // scales how often it re-picks a destination
      /** Timer until the next unprompted burst of speed. */
      burstIn: 2 + Math.random() * 8,
      burstFor: 0
    };

    // --- combat state --------------------------------------------------------
    this.target = null;
    this.lockTimer = 0;
    this.attackCooldown = Math.random() * COMBAT.attackCooldown;
    this.rescanTimer = Math.random();
    // Untargetable + immune. Set on join (spawn protection) and on every
    // evolution so a fish is never eaten mid-model-swap.
    this.invulnerable = COMBAT.spawnProtection;

    // --- powers --------------------------------------------------------------
    this.power = { turbo: 0, rotor: 0, stun: 0 };
    /** Rotor Blade Storm caster shield — full damage immunity while this
     *  fish's own rotor is spinning. Kept separate from `invulnerable`
     *  (spawn/morph grace) since the two have different durations and the
     *  morph-protection fade visual reads its opacity off that duration. */
    this.rotorShield = 0;
    this.rotorTick = 0;
    this.rotorPulseTimer = 0;
    this.rotorPulseActive = false;
    this.rotorPulseAge = 0;
    this.rotorPulseHits = new Set();
    /** Current rotor blade angle, radians. */
    this.rotorAngle = 0;
    this.auras = { rotor: null, turbo: null, shield: null };

    this._spawnPosition();
    this._applyModel(this.level);
    this._applyScale();
  }

  // ------------------------------------------------------------- derived ---

  get maxHP() { return maxHPForLevel(this.level); }
  get band() { return bandFor(this.level); }
  get bodyLength() { return BODY_LENGTH_AT_SCALE_1 * this.scale; }
  get scale() { return scaleForHP(this.hp); }
  get position() { return this.root.position; }
  get isTitan() { return this.level >= 10; }
  get isStunned() { return this.power.stun > 0; }

  // -------------------------------------------------------------- setup ---

  /**
   * Enter from one of the two side edges, swimming inward.
   *
   * Spawning at the edges rather than anywhere in the slab means a new fish
   * never materialises on top of an existing one, and the viewer sees it swim
   * into the scene — an arrival, not a pop-in.
   */
  /** Drop in somewhere inside the tank, heading in a random direction. */
  /**
   * Build (or rebuild) the mesh for a level and attach it under the bobber.
   *
   * Called on spawn and on every evolution. The old instance is fully disposed
   * first — leaking a mixer here means the previous model keeps animating
   * invisibly and the frame cost climbs every time anyone levels up.
   */
  _applyModel(level) {
    // Tear down whatever was there.
    if (this.modelInstance) {
      this.mixer?.stopAllAction();
      this.bobber.remove(this.modelInstance.root);
      this.modelInstance = null;
      this.mixer = null;
      this.actions = { swim: null, bite: null };
      this.proceduralTail = null;
    }

    const inst = this.library.instance(level);
    this.modelInstance = inst;
    this.modelFilename = LEVEL_BANDS.find((band) => band.level === level)?.model || `level-${level}`;
    this.mixer = inst.mixer;
    this.actions = inst.actions;
    this.proceduralTail = inst.tail;

    // Models are authored nose-down-(-Z) by glTF convention, but Object3D
    // .lookAt() points -Z at the target, so the mesh needs a half turn to face
    // the direction of travel. runtime.yawOffset is the live-tunable correction
    // for models that don't follow the convention (press O in the browser).
    inst.root.rotation.y = Math.PI + runtime.yawOffset;
    this.bobber.add(inst.root);

    // Re-verify the rendered size shortly after the model appears. See
    // _verifyRenderedSize for why this exists.
    this._sizeVerified = false;
    this._sizeSettle = 0.25;
    // New meshes need fresh cloned materials and a fresh tint pass.
    this._ownMaterials = null;
    this._visualState = null;
  }

  /**
   * Measure what the model ACTUALLY renders as, and correct it.
   *
   * Load-time normalisation is a prediction, and it keeps being wrong for
   * reasons outside our control: animation clips that drive scale, nested
   * transforms inside the .glb, armatures that resize their own mesh on the
   * first frame. Each time one of those slipped through, a fish rendered many
   * times too large and burst out of the arena — with no error anywhere,
   * because nothing had technically failed.
   *
   * So instead of predicting, we check. A quarter-second after the model is
   * attached (long enough for the mixer to have run and any first-frame
   * transform to have settled) we measure the real world-space bounding box and
   * scale the holder by whatever correction is needed. This runs once per model
   * swap — negligible cost, and it makes an oversized fish structurally
   * impossible regardless of what a .glb does.
   */
  _verifyRenderedSize() {
    const inst = this.modelInstance;
    if (!inst) return;

    _box.setFromObject(inst.root);
    _box.getSize(_v3);
    const longest = Math.max(_v3.x, _v3.y, _v3.z);
    const expectedBodyLength = this.bodyLength;
    const correction = Number.isFinite(longest) && longest > 0.0001 ? expectedBodyLength / longest : NaN;

    console.info(
      `[fish][size] model=${this.modelFilename || 'unknown'} ` +
      `expectedBodyLength=${expectedBodyLength.toFixed(3)} ` +
      `measuredLongestAxis=${Number.isFinite(longest) && longest > 0.0001 ? longest.toFixed(3) : 'unmeasurable'} ` +
      `correction=${Number.isFinite(correction) ? correction.toFixed(3) : 'n/a'}`
    );

    if (!Number.isFinite(longest) || longest <= 0.0001) return;

    // Ignore small discrepancies — a fish mid-tail-flick is legitimately a few
    // percent off, and correcting that every swap would cause visible pulsing.
    if (correction > 0.88 && correction < 1.14) return;

    // A correction this extreme means the load-time box (models.js fitFactor)
    // and this runtime box disagree wildly — almost always junk geometry (a
    // stray collision hull, helper, or armature bone) skewing one of the two
    // measurements. Dump every mesh's own world-space box so the offending
    // node can be identified instead of guessed at. See KNOWN OPEN BUG #1/#2
    // in CLAUDE.md — this is that bug.
    if (correction < 0.3 || correction > 3) this._logMeshBreakdown(inst);

    inst.root.scale.multiplyScalar(correction);
    console.warn(
      `[fish] ${this.username} L${this.level} rendered at ${longest.toFixed(1)} units ` +
      `but physics expects ${expectedBodyLength.toFixed(1)} — corrected by x${correction.toFixed(3)}. ` +
      `The .glb is fighting the normalisation (usually an animated scale track).`
    );
  }

  /**
   * Per-mesh world-space bounding box dump, used only when _verifyRenderedSize
   * finds an implausible correction. Isolates which node inside the .glb is
   * throwing off the whole-object Box3 measurement — a stray ground plane,
   * collision hull, or oversized helper reads as huge here even though it's
   * invisible on screen, which is exactly what a single "measured X units"
   * number can't tell you.
   */
  _logMeshBreakdown(inst) {
    console.warn(`[fish][breakdown] ${this.username} L${this.level} model=${this.modelFilename} — per-mesh world bounding boxes:`);
    let index = 0;
    inst.root.traverse((child) => {
      if (!child.isMesh && !child.isSkinnedMesh) return;
      const name = child.name || `(unnamed-${index})`;
      index += 1;
      const box = new THREE.Box3().setFromObject(child);
      const size = box.getSize(new THREE.Vector3());
      console.warn(
        `  - name='${name}' type=${child.type} worldSize=(${size.x.toFixed(3)}, ${size.y.toFixed(3)}, ${size.z.toFixed(3)}) ` +
        `visible=${child.visible}`
      );
    });
  }

  /**
   * Target the HP-derived scale. Capped by MAX_FISH_SCALE.
   *
   * Note this sets a TARGET, not the scale itself — `_updateMotion` eases
   * toward it every frame. Snapping was the ugliest moment in the game: a gift
   * landed and the fish jumped size instantly, which looked like a glitch
   * rather than growth. Easing turns the same event into a visible swell.
   */
  _applyScale() {
    this.targetScale = this.scale;
    // On first call there is nothing to ease from, so land on it immediately.
    if (this.renderScale === undefined) {
      this.renderScale = this.scale;
      this.root.scale.setScalar(this.scale);
    }
  }

  _spawnPosition() {
    const inset = ARENA.halfSize * 0.7;
    this.root.position.set(
      (Math.random() * 2 - 1) * inset,
      (ARENA.ceiling + ARENA.floor) * 0.5,
      (Math.random() * 2 - 1) * inset
    );
    const angle = Math.random() * Math.PI * 2;
    this.forward.set(Math.cos(angle), 0, Math.sin(angle)).normalize();
    this.speed = PHYSICS.baseSpeed * 0.6;
    this.root.lookAt(_v1.copy(this.root.position).add(this.forward));
  }



  // ----------------------------------------------------------- economy ---

  /** Server-authoritative HP set. Handles evolution up or down. */
  setState({ hp, level, coinsSpent }) {
    if (typeof coinsSpent === 'number') this.coinsSpent = coinsSpent;
    if (typeof hp !== 'number') return;

    this.hp = hp;
    const newLevel = typeof level === 'number' ? level : levelForHP(hp);
    if (newLevel !== this.level) this.evolveTo(newLevel);
    this._applyScale();
  }

  evolveTo(level) {
    const clamped = Math.min(10, Math.max(1, level));
    if (clamped === this.level) return;
    this.level = clamped;
    this._applyModel(clamped);
    this._applyScale();
    this.invulnerable = Math.max(this.invulnerable, COMBAT.morphProtection);
  }

  // ------------------------------------------------------------ combat ---

  /**
   * Apply damage.
   * @returns {'blocked'|'hit'|'leveldown'|'dead'}
   */
  takeDamage(amount, ctx) {
    if (this.dead) return 'dead';
    // Spawn/morph grace period. 'blocked' here means "still in that
    // window", not "shielded".
    if (this.invulnerable > 0) return 'blocked';
    // Rotor Blade Storm caster shield — full immunity to ANY damage source
    // while this fish's own rotor is active, not just its own blades
    // (_damageArea already skips `fish === source` for that). Without this,
    // a caster mid-cast could still be finished off by another fish's power.
    if (this.rotorShield > 0) return 'blocked';

    /*
     * Each level is its own health pool, and one bite can empty at most one.
     *
     * Two GDD rules pull against each other here. "Level is derived from HP"
     * means a Level 5 fish would quietly slide down through the bands and only
     * a Level 1 would ever actually see zero — so the level-down rule could
     * never fire. And "damage is 10% of the ATTACKER's max HP" means a Titan
     * hitting a small fish deals more than that fish's entire lifetime HP,
     * deleting it in a single frame through nine levels at once.
     *
     * Resolving both: the band minimum is this level's zero. Empty it and you
     * drop exactly one tier and refill to the top of the new one — never more
     * than one tier per bite, because the rule says "it drops 1 Level down".
     * Level 1 is the exception, where the floor really is 0 and it means death.
     *
     * The pacing this buys is the real prize: a Titan needs ten bites over
     * fifteen seconds to strip a rival Titan, so the fight is something the
     * chat can actually watch, react to, and gift into.
     */
    const floor = this.level <= 1 ? 0 : this.band.min;
    const pool = Math.max(0, this.hp - floor);   // health left in this tier
    this.hp -= Math.min(amount, pool);

    if (this.hp > floor) {
      // Tier survived. Shrinking matters as much as growing — the crowd reads
      // size before it reads any number.
      this._applyScale();
      return 'hit';
    }

    if (this.level <= 1) {
      this.hp = 0;
      this.dead = true;
      return 'dead';
    }

    const newLevel = this.level - 1;
    this.hp = maxHPForLevel(newLevel);
    this.evolveTo(newLevel);
    this.target = null;
    this.lockTimer = 0;
    return 'leveldown';
  }

  /** World-space point roughly at the jaw — where bites and blood happen. */
  mouthPosition(out = new THREE.Vector3()) {
    return out.copy(this.root.position).addScaledVector(this._worldForward(_v2), this.bodyLength * 0.45);
  }

  _worldForward(out) {
    return out.set(0, 0, 1).applyQuaternion(this.root.quaternion).normalize();
  }

  // ------------------------------------------------------------ powers ---

  /** Powers with a duration are additive; instant powers are handled by Game. */
  grantPower(name) {
    switch (name) {
      case 'turbo':
        this.power.turbo = POWERS.turbo.duration;
        break;
      case 'beamRotor':
        // Reuses the `rotor` field/nameplate state — the beam rotor IS this
        // fish's rotor power, just with real beam geometry instead of rings.
        this.power.rotor = POWERS.beamRotor.duration;
        this.rotorTick = 0;
        break;
      default:
        break; // shockwave, bulletStorm, and missiles are one-shot/wave-based, resolved by Game
    }
  }

  stun(seconds) {
    this.power.stun = Math.max(this.power.stun, seconds);
  }

  /** Rotor Blade Storm caster shield — see `rotorShield` field and `takeDamage`. */
  shieldSelf(seconds) {
    this.rotorShield = Math.max(this.rotorShield, seconds);
  }

  /**
   * Turbo aura — a glowing shell wrapped around the body, on top of the point
   * light and jet trail. The light illuminates the water; this is what makes
   * the fish itself look like it's on fire at close range.
   */
  _ensureTurboAura() {
    if (this.auras.turbo) return;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({
        color: POWERS.turbo.glowColor, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false
      })
    );
    mesh.scale.setScalar(BODY_LENGTH_AT_SCALE_1 * 0.62);
    this.bobber.add(mesh);
    this.auras.turbo = mesh;
  }

  /**
   * Rotor Blade Storm caster shield — a translucent bubble enclosing the
   * fish, larger and a different color (POWERS.rotor.shieldColor) than the
   * turbo shell so the two auras never read as the same effect if a fish
   * somehow has both.
   */
  _ensureShieldAura() {
    if (this.auras.shield) return;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({
        color: POWERS.rotor.shieldColor, transparent: true, opacity: 0.2,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false
      })
    );
    mesh.scale.setScalar(BODY_LENGTH_AT_SCALE_1 * 0.78);
    this.bobber.add(mesh);
    this.auras.shield = mesh;
  }

  _removeAura(key) {
    const aura = this.auras[key];
    if (!aura) return;
    this.bobber.remove(aura);

    aura.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material?.dispose?.());
      } else {
        child.material?.dispose?.();
      }
    });

    this.auras[key] = null;
  }

  // ------------------------------------------------------------ update ---

  update(dt, elapsed, ctx) {
    this._updatePowers(dt, elapsed, ctx);
    // No AI step: there is no hunting in arena mode. Collisions are the combat,
    // and they're resolved by the game loop after every fish has moved.
    this._updateMotion(dt, elapsed);
    this._updateAnimation(dt, elapsed);
    this._applyPowerVisuals(dt);
  }

  _updatePowers(dt, elapsed, ctx) {
    for (const key of ['turbo', 'rotor', 'stun']) {
      if (this.power[key] > 0) this.power[key] = Math.max(0, this.power[key] - dt);
    }
    if (this.invulnerable > 0) this.invulnerable = Math.max(0, this.invulnerable - dt);
    if (this.rotorShield > 0) this.rotorShield = Math.max(0, this.rotorShield - dt);

    // Turbo: glowing aura shell + a jet trail whose density scales with the
    // fish's actual speed (not just "is turbo on"), so a fish still turning
    // into its boost drags a thin wake and one at full speed drags a dense,
    // unmistakable one.
    if (this.power.turbo > 0) {
      this._ensureTurboAura();
      this.auras.turbo.material.opacity = 0.24 + Math.sin(elapsed * 8) * 0.08;

      const back = this._worldForward(_v1).multiplyScalar(-1);
      const speedFactor = THREE.MathUtils.clamp(
        this.speed / (PHYSICS.baseSpeed * POWERS.turbo.speedMultiplier), 0.25, 1
      );
      ctx.effects.jetTrail(
        _v2.copy(this.root.position).addScaledVector(back, this.bodyLength * 0.4),
        back,
        { count: Math.round(4 + 10 * speedFactor), color: POWERS.turbo.glowColor }
      );
    } else if (this.auras.turbo) {
      this._removeAura('turbo');
    }

    // Rotor Blade Storm caster shield — gentle pulse so it reads as an
    // active effect rather than a static decal.
    if (this.rotorShield > 0) {
      this._ensureShieldAura();
      this.auras.shield.material.opacity = 0.16 + Math.sin(elapsed * 6) * 0.06;
    } else if (this.auras.shield) {
      this._removeAura('shield');
    }
  }

  /**
   * Hunting AI.
   *
   * Rule that matters most: once a target is chosen it is kept for
   * COMBAT.lockDuration seconds. Re-scanning every frame is what makes AI fish
   * look like they're having a seizure; a hard lock makes them look ruthless.
   */
  bite(target, ctx) {
    // Scale the sound by how big this fish is, so the mix alone tells the
    // viewer whether that was a minnow snapping or a Titan taking a chunk out
    // of someone. HP over the ceiling maps to a full-weight crunch.
    ctx.audio?.bite(Math.min(1, this.hp / 5000));

    // LoopOnce bite blended over the swim loop, then faded back out.
    const bite = this.actions.bite;
    if (bite) {
      bite.reset();
      bite.setLoop(THREE.LoopOnce, 1);
      bite.clampWhenFinished = true;
      bite.fadeIn(0.12).play();
      if (this.actions.swim) this.actions.swim.fadeOut(0.12);

      const onFinished = (e) => {
        if (e.action !== bite) return;
        this.mixer.removeEventListener('finished', onFinished);
        bite.fadeOut(0.2);
        this.actions.swim?.reset().fadeIn(0.2).play();
      };
      this.mixer.addEventListener('finished', onFinished);
    } else {
      // Procedural bodies have no clips: snap the jaw with a scripted lunge.
      this.biteLunge = 0.35;
    }

    const damage = this.maxHP * COMBAT.damageFraction;
    ctx.damage(this, target, damage);
  }

  /** Steering + integration. Everything smoothed, nothing snapped. */
  /**
   * Ball physics.
   *
   * A fish is a sphere with a velocity. It cruises, reflects off walls, and
   * bounces off other fish. There is no steering toward anything — the arena
   * itself creates the drama through collisions, which is why this reads so
   * much better on stream than the old hunting model: every event is a visible
   * impact rather than an invisible decision.
   */
  _updateMotion(dt, elapsed) {
    const pos = this.root.position;

    // Cruise speed, scaled by size, recovered gradually after impacts so a
    // collision produces a visible surge that then settles.
    const sizeFactor = THREE.MathUtils.lerp(
      1, PHYSICS.minSpeedFactor,
      THREE.MathUtils.clamp((this.scale - 1) / 0.9, 0, 1)
    );
    let cruise = PHYSICS.baseSpeed * sizeFactor * this.trait.speed;
    if (this.power.turbo > 0) cruise *= POWERS.turbo.speedMultiplier;

    if (this.isStunned) {
      this.speed = THREE.MathUtils.lerp(this.speed, 0, Math.min(1, dt * 6));
    } else {
      this.speed = THREE.MathUtils.lerp(
        this.speed, cruise, Math.min(1, dt * PHYSICS.speedRecovery)
      );
    }
    this.speed = Math.min(this.speed, PHYSICS.maxSpeed);

    // Integrate on the horizontal plane. Y is decorative drift only, so a fish
    // can never "hide" above or below the fight.
    pos.x += this.forward.x * this.speed * dt;
    pos.z += this.forward.z * this.speed * dt;

    this.driftPhase += dt * PHYSICS.driftSpeed * this.trait.bobRate;
    const midY = (ARENA.ceiling + ARENA.floor) * 0.5;
    pos.y = midY + Math.sin(this.driftPhase + this.trait.bobPhase) * PHYSICS.driftAmplitude;

    this._bounceWalls();

    // Face exactly where we're going. The head leads, always — that was the
    // single most broken-looking thing about the old build.
    this.forward.y = 0;
    if (this.forward.lengthSq() < 0.0001) this.forward.set(1, 0, 0);
    this.forward.normalize();

    _m1.lookAt(_v2.copy(pos).add(this.forward), pos, _up);
    _q1.setFromRotationMatrix(_m1);
    // Fast slerp: a ball that bounces should snap to its new heading, not
    // sweep round to it over half a second.
    this.root.quaternion.slerp(_q1, Math.min(1, dt * 14));

    // Bank slightly into direction changes for life, never enough to obscure
    // which way the head is pointing.
    this.roll = THREE.MathUtils.lerp(this.roll, this.bankTarget, Math.min(1, dt * 5));
    this.bankTarget *= Math.max(0, 1 - dt * 2.2);
    this.bobber.rotation.z = this.roll;

    // Tail wag rate follows speed, so a fish knocked flying visibly thrashes.
    this.bobPhase += dt * MOVEMENT.bobFrequency * (0.6 + this.speed / PHYSICS.baseSpeed);
    this.bobber.rotation.x = Math.sin(this.bobPhase) * 0.04;

    // Ease the rendered size toward the HP-derived target so growth reads as a
    // swell rather than a pop.
    if (this.targetScale !== undefined) {
      this.renderScale = THREE.MathUtils.lerp(
        this.renderScale, this.targetScale, Math.min(1, dt * 3.2)
      );
      this.root.scale.setScalar(this.renderScale);
    }

    if (this.poisoned > 0) this.poisoned = Math.max(0, this.poisoned - dt);
    if (this.bladeImmunity > 0) this.bladeImmunity = Math.max(0, this.bladeImmunity - dt);
    if (this.pinballImmunity > 0) this.pinballImmunity = Math.max(0, this.pinballImmunity - dt);

    this.collisionCooldowns.forEach((v, k) => {
      const next = v - dt;
      if (next <= 0) this.collisionCooldowns.delete(k);
      else this.collisionCooldowns.set(k, next);
    });
  }

  /**
   * Reflect off the four walls.
   *
   * Proper mirror reflection: only the component INTO the wall flips, the
   * component along the wall is preserved. A fish hitting a wall at a shallow
   * angle therefore glances off and keeps going forward — it does not turn
   * round and swim back the way it came, which is what "reversing" would do and
   * what looked so wrong before.
   */
  /**
   * Drive the animation mixer, or hand-animate the procedural fallback.
   *
   * Wag rate follows actual speed, so a fish knocked flying by a Titan visibly
   * thrashes and a drifting one barely moves. That coupling is most of what
   * makes the fallback sharks read as alive rather than as sliding props.
   */
  _updateAnimation(dt, elapsed) {
    // One-shot size audit after the model settles.
    if (!this._sizeVerified) {
      this._sizeSettle -= dt;
      if (this._sizeSettle <= 0) {
        this._verifyRenderedSize();
        this._sizeVerified = true;
      }
    }

    if (this.mixer) {
      // Speed up the swim loop with cruise speed, clamped so a turbo boost
      // doesn't turn the clip into a blur.
      const rate = THREE.MathUtils.clamp(this.speed / PHYSICS.baseSpeed, 0.55, 2.0);
      if (this.actions.swim) this.actions.swim.setEffectiveTimeScale(rate);
      this.mixer.update(dt);
    }

    if (this.proceduralTail) {
      this.tailPhase += dt * (3.2 + (this.speed / PHYSICS.baseSpeed) * 4.5);
      this.proceduralTail.rotation.y = Math.sin(this.tailPhase) * 0.55;
    }

    // Squash and stretch: impact recoil, plus the evolution morph pulse.
    let squash = 1;
    let stretch = 1;

    if (this.recoilPulse > 0) {
      this.recoilPulse = Math.max(0, this.recoilPulse - dt * 3.4);
      // Compress along the body, bulge across it — the classic impact read.
      const k = Math.sin(this.recoilPulse * Math.PI) * 0.34;
      squash = 1 - k;
      stretch = 1 + k * 0.75;
    }

    if (this.invulnerable > 0) {
      const k = 1 - THREE.MathUtils.clamp(this.invulnerable / COMBAT.morphProtection, 0, 1);
      const pulse = 1 + Math.sin(k * Math.PI) * 0.14;
      squash *= pulse;
      stretch *= pulse;
    }

    this.bobber.scale.set(stretch, stretch, squash);
  }

  _bounceWalls() {
    const pos = this.root.position;
    const r = this.radius;
    const limit = ARENA.halfSize - r;
    let hit = false;

    if (pos.x > limit)      { pos.x = limit;  this.forward.x = -Math.abs(this.forward.x); hit = true; }
    else if (pos.x < -limit){ pos.x = -limit; this.forward.x =  Math.abs(this.forward.x); hit = true; }

    if (pos.z > limit)      { pos.z = limit;  this.forward.z = -Math.abs(this.forward.z); hit = true; }
    else if (pos.z < -limit){ pos.z = -limit; this.forward.z =  Math.abs(this.forward.z); hit = true; }

    if (!hit) return;

    // A little random yaw so the tank never settles into a repeating pattern.
    this._yaw((Math.random() * 2 - 1) * PHYSICS.wallSpin);
    this.speed *= PHYSICS.wallBounce;
    this.bankTarget = (Math.random() * 2 - 1) * 0.5;
    this.wallHits += 1;
  }

  /**
   * Hard safety net after collision resolution.
   *
   * The mass-weighted push in `collideWith` is positional and knows nothing
   * about walls, so a light fish squeezed between a Titan and the glass can be
   * shoved straight through it. This clamps everyone back inside the tank as
   * the last step of the frame.
   */
  contain() {
    const p = this.root.position;
    const limit = ARENA.halfSize - this.radius;
    p.x = THREE.MathUtils.clamp(p.x, -limit, limit);
    p.z = THREE.MathUtils.clamp(p.z, -limit, limit);
    p.y = THREE.MathUtils.clamp(p.y, ARENA.floor, ARENA.ceiling);
  }

  /**
   * Visible recoil from an impact.
   *
   * A squash-and-stretch pulse plus a roll kick. Cheap, but it changes the
   * silhouette of something the viewer is already watching, which lands far
   * harder than adding more particles around it. Decays in ~0.3s.
   */
  recoil(power) {
    this.recoilPulse = Math.min(1, Math.max(this.recoilPulse, power));
    this.bankTarget = (Math.random() * 2 - 1) * (0.6 + power * 0.9);
  }

  /**
   * Get thrown away from a point — used by Bass Shockwave.
   *
   * Redirects the heading outward and adds a speed burst, rather than snapping
   * the position. Teleporting the fish would look like a glitch; accelerating
   * it away looks like force.
   */
  shoveFrom(origin, power) {
    const p = this.root.position;
    let dx = p.x - origin.x;
    let dz = p.z - origin.z;
    const d = Math.hypot(dx, dz);

    if (d < 0.0001) {
      // Dead centre: pick a random escape direction rather than dividing by 0.
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a);
      dz = Math.sin(a);
    } else {
      dx /= d;
      dz /= d;
    }

    // Closer fish are thrown harder — the blast falls off with distance.
    const falloff = THREE.MathUtils.clamp(1 - d / POWERS.shockwave.radius, 0.25, 1);

    this.forward.set(dx, 0, dz).normalize();
    this.speed = Math.min(PHYSICS.maxSpeed, this.speed + power * falloff);
    this.bankTarget = (Math.random() * 2 - 1) * 0.9;
  }

  /**
   * Light suction toward `origin` — same shape as shoveFrom above but
   * pulling inward instead of shoving outward (Rotor Blade Storm's optional
   * pull effect). Deliberately NOT shoveFrom(origin, -power): that method
   * always re-faces the fish AWAY from origin regardless of power's sign, so
   * a negative push would slow the fish down while still turning it to face
   * outward — reads as resisting the pull, not being drawn in.
   */
  pullToward(origin, power) {
    const p = this.root.position;
    let dx = origin.x - p.x;
    let dz = origin.z - p.z;
    const d = Math.hypot(dx, dz);

    if (d < 0.0001) return; // already at the center — nothing to pull toward

    dx /= d;
    dz /= d;

    this.forward.set(dx, 0, dz).normalize();
    this.speed = Math.min(PHYSICS.maxSpeed, this.speed + power);
    this.bankTarget = (Math.random() * 2 - 1) * 0.7;
  }

  /** Rotate the heading about Y by `radians`. */
  _yaw(radians) {
    const c = Math.cos(radians);
    const sn = Math.sin(radians);
    const x = this.forward.x;
    const z = this.forward.z;
    this.forward.x = x * c - z * sn;
    this.forward.z = x * sn + z * c;
    this.forward.y = 0;
    this.forward.normalize();
  }

  /** Collision radius on the horizontal plane. */
  get radius() {
    return BODY_LENGTH_AT_SCALE_1 * this.scale * 0.42;
  }

  /** Mass for collision response. Heavier fish are pushed less. */
  get mass() {
    return Math.max(1, this.hp) ** 0.6;
  }

  /** Hard positional separation so two bodies can never occupy one space. */
  /**
   * Elastic collision between two fish, plus the damage that comes with it.
   *
   * This replaces the entire hunting system. Two fish hit, both bounce apart,
   * and both take damage weighted by the other's mass — so a big fish still
   * wins, but it never walks away untouched, and a small fish that keeps
   * landing hits can genuinely wear one down. That is the fairness fix: no
   * fight is an execution any more, and the randomness in the bounce means the
   * same pairing never resolves identically twice.
   *
   * Returns the impact speed if a collision happened, otherwise 0.
   */
  collideWith(other) {
    const pos = this.root.position;
    const otherPos = other.root.position;

    // Horizontal distance only — vertical drift is decorative.
    let dx = pos.x - otherPos.x;
    let dz = pos.z - otherPos.z;
    const distSq = dx * dx + dz * dz;
    const minDist = this.radius + other.radius;
    if (distSq >= minDist * minDist || distSq < 0.000001) return 0;

    const dist = Math.sqrt(distSq);
    dx /= dist;
    dz /= dist;

    // 1. Separate by mass. The lighter fish gets moved further, which reads as
    //    the heavy one shouldering through.
    const overlap = minDist - dist;
    const mA = this.mass;
    const mB = other.mass;
    const total = mA + mB;
    const pushA = overlap * (mB / total);
    const pushB = overlap * (mA / total);
    pos.x += dx * pushA;
    pos.z += dz * pushA;
    otherPos.x -= dx * pushB;
    otherPos.z -= dz * pushB;

    // 2. Reflect both headings about the collision normal, weighted by mass so
    //    the lighter fish is knocked further off course.
    const impact = (this.speed + other.speed) * 0.5;

    reflectAbout(this.forward, dx, dz, 0.55 + 0.35 * (mB / total));
    reflectAbout(other.forward, -dx, -dz, 0.55 + 0.35 * (mA / total));

    // 3. Randomise, so the arena never falls into a stable orbit.
    this._yaw((Math.random() * 2 - 1) * PHYSICS.fishSpin);
    other._yaw((Math.random() * 2 - 1) * PHYSICS.fishSpin);

    // 4. Kick both, scaled by the other's mass — being hit by a Titan hurts and
    //    sends you flying; clipping a minnow barely registers.
    this.speed = Math.min(PHYSICS.maxSpeed,
      this.speed * PHYSICS.fishBounce + PHYSICS.impactKick * (mB / total) * 2);
    other.speed = Math.min(PHYSICS.maxSpeed,
      other.speed * PHYSICS.fishBounce + PHYSICS.impactKick * (mA / total) * 2);

    this.bankTarget = (Math.random() * 2 - 1) * 0.7;
    other.bankTarget = (Math.random() * 2 - 1) * 0.7;

    return impact;
  }

  /** Have we already resolved a hit with this fish very recently? */
  canCollideWith(other) {
    return !this.collisionCooldowns.has(other.username);
  }

  markCollided(other) {
    this.collisionCooldowns.set(other.username, PHYSICS.collisionCooldown);
    other.collisionCooldowns.set(this.username, PHYSICS.collisionCooldown);
  }

  /**
   * Paint the fish according to its active powers.
   *
   * This is the part that was missing. Turbo only changed a number, so on
   * screen nothing happened and viewers had no idea a power had fired. Poison
   * was invisible for its entire duration. Now the BODY carries the state:
   * turbo makes it glow cyan and lights the water around it, poison stains it
   * red. A viewer can read what is happening to every fish without a single
   * number or label.
   *
   * Materials are cloned per fish on first tint so one poisoned fish can't
   * recolour every other fish sharing that model's material.
   */
  _applyPowerVisuals(dt) {
    const inst = this.modelInstance;
    if (!inst) return;

    const turbo = this.power.turbo > 0;
    const poisoned = this.poisoned > 0;
    const state = `${turbo ? 't' : ''}${poisoned ? 'p' : ''}`;

    if (state !== this._visualState) {
      this._visualState = state;
      this._ensureOwnMaterials();

      for (const mat of this._ownMaterials) {
        if (mat.emissive) {
          if (turbo) {
            mat.emissive.setHex(POWERS.turbo.glowColor);
            mat.emissiveIntensity = POWERS.turbo.glowIntensity;
            mat.color.setHex(0xffffff);
          } else if (poisoned) {
            mat.emissive.setHex(POWERS.rotor.color);
            mat.emissiveIntensity = 0.9;
            mat.color.copy(mat.userData.baseColor).lerp(_poison, 0.65);
          } else {
            mat.emissive.setHex(0x000000);
            mat.emissiveIntensity = 0;
            mat.color.copy(mat.userData.baseColor);
          }
        } else {
          // No emissive channel to layer a glow on top of (MeshBasicMaterial and
          // similar unlit materials — this is the common case, not an edge case;
          // see the note on _turboTint above). Tint the base color directly instead,
          // and always restore the saved baseColor when no power is active.
          if (turbo) {
            mat.color.copy(mat.userData.baseColor).lerp(_turboTint, 0.65);
          } else if (poisoned) {
            mat.color.copy(mat.userData.baseColor).lerp(_poison, 0.65);
          } else {
            mat.color.copy(mat.userData.baseColor);
          }
        }
      }
    }

    // A real light so the boost illuminates the water, not just the model.
    if (turbo) {
      if (!this._turboLight) {
        this._turboLight = new THREE.PointLight(POWERS.turbo.glowColor, 0, 46, 2);
        this.root.add(this._turboLight);
      }
      // Pulse so it reads as energy rather than a lamp taped to a fish.
      this._turboLight.intensity = 12 + Math.sin(this.bobPhase * 9) * 5;
    } else if (this._turboLight) {
      this._turboLight.intensity = THREE.MathUtils.lerp(this._turboLight.intensity, 0, Math.min(1, dt * 6));
      if (this._turboLight.intensity < 0.05) {
        this.root.remove(this._turboLight);
        this._turboLight.dispose?.();
        this._turboLight = null;
      }
    }
  }

  /** Clone materials so tinting this fish never affects any other. */
  _ensureOwnMaterials() {
    if (this._ownMaterials) return;
    this._ownMaterials = [];
    this.modelInstance.root.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const list = Array.isArray(child.material) ? child.material : [child.material];
      const cloned = list.map((m) => {
        const c = m.clone();
        c.userData.baseColor = m.color ? m.color.clone() : new THREE.Color(0xffffff);
        this._ownMaterials.push(c);
        return c;
      });
      child.material = Array.isArray(child.material) ? cloned : cloned[0];
    });
  }

  /** Re-apply the yaw offset in place — used by the live orientation toggle. */
  refreshYaw() {
    if (this.modelInstance) this.modelInstance.root.rotation.y = Math.PI + runtime.yawOffset;
  }

  dispose() {
    this._removeAura('rotor');
    this._removeAura('turbo');
    this._removeAura('shield');
    this.mixer?.stopAllAction();
    this.scene.remove(this.root);
    disposeTree(this.root);
  }
}

// ------------------------------------------------------------------ utils ---

/** 2D cross product of two heading vectors — signed turn amount. */
function crossY(ax, az, bx, bz) {
  return ax * bz - az * bx;
}

/** Release GPU memory for a subtree. Shared geometries are ref-counted by three. */
function disposeTree(root) {
  root.traverse((child) => {
    if (!child.isMesh && !child.isSkinnedMesh) return;
    child.geometry?.dispose?.();
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) m?.dispose?.();
  });
}

/**
 * Mirror a heading about a collision normal, blended by `strength`.
 *
 * strength 1 = a perfect mirror bounce; lower values glance off instead. Both
 * fish use a mass-weighted strength so the lighter one is deflected harder,
 * which is what makes a Titan look like it's ploughing through traffic.
 */
function reflectAbout(forward, nx, nz, strength) {
  const dot = forward.x * nx + forward.z * nz;
  // Only reflect if we're actually heading into the other fish.
  if (dot >= 0) return;
  const rx = forward.x - 2 * dot * nx;
  const rz = forward.z - 2 * dot * nz;
  forward.x = THREE.MathUtils.lerp(forward.x, rx, strength);
  forward.z = THREE.MathUtils.lerp(forward.z, rz, strength);
  forward.y = 0;
  if (forward.lengthSq() < 0.0001) forward.set(nx, 0, nz);
  forward.normalize();
}
