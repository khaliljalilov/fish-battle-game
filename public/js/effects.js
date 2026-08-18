/**
 * effects.js — every transient visual.
 *
 * Two pools, zero allocation during play:
 *   • ParticlePool  — one Points cloud reused for blood, sparks, jet trails.
 *   • MeshPool      — reusable rings/spheres for shockwaves and spike bursts.
 *
 * Also owns camera shake trauma, since shake is triggered by the same events.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { makeBubbleTexture } from './world.js';
import { ARENA, RENDER } from './config.js';

const MAX_PARTICLES = 2400;

// Scratch objects for the projectile systems below — reused every frame so
// none of them allocate during play (see the module comment on the pooled
// particle/ring systems for why that matters here).
/** World Anchor scratch — see updateBullets for why this reads getWorldPosition(), not .position. */
const _bulletTargetWorldPos = new THREE.Vector3();
const _bulletPredictedPos = new THREE.Vector3();
const _bulletDir = new THREE.Vector3();
const _bulletSpawnBase = new THREE.Vector3();
/** Sphere radius for an orb — shared between _initBullets (the geometry
 *  itself) and spawnBullet (the muzzle-offset math), so the two can never
 *  drift apart. Raised from 0.85 for visibility on small mobile stream
 *  viewports. Diameter (4.6) still stays under the 6-unit gap between
 *  consecutive spawn points (speed 150 * fireInterval 0.04, POWERS.
 *  bulletStorm) — orbs stay visibly separate, not touching. */
const BULLET_RADIUS = 2.3;
const _missileDesired = new THREE.Vector3();
const _missileUp = new THREE.Vector3(0, 1, 0);
const _missileQuat = new THREE.Quaternion();
const _missileTrailColor = new THREE.Color(0xffb35c);
const _pinballSpawnBase = new THREE.Vector3();
/** Cap on _avatarTextureCache's size — see _loadAvatarTexture. */
const AVATAR_CACHE_LIMIT = 200;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.trauma = 0;          // 0..1, decays every frame
    this.shakeOffset = new THREE.Vector3();

    // Set each frame by main.js via setActivity(). 1 = full intensity, below
    // 1 once the arena is crowded — see setActivity() for why.
    this.intensityScale = 1;

    this._initParticles();
    this._initRings();
    this._initBullets();
    this._initMissiles();
    this._initBeamRotor();
    this._initRotorBlades();
    this._initPinball();
    this.flashEffects = [];
    this.bladeTemplate = null;
    this.bladeReady = false;
    this._loadBladeModel();
  }

  // -------------------------------------------------------------- particles --

  _initParticles() {
    const positions = new Float32Array(MAX_PARTICLES * 3);
    const colors = new Float32Array(MAX_PARTICLES * 3);
    const sizes = new Float32Array(MAX_PARTICLES);

    // Park every unused particle far below the seabed rather than resizing
    // buffers — resizing mid-frame is the classic source of GPU stalls.
    for (let i = 0; i < MAX_PARTICLES; i++) positions[i * 3 + 1] = -9999;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.PointsMaterial({
      size: 0.55,
      vertexColors: true,
      map: makeBubbleTexture(),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.NormalBlending
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.pGeo = geo;
    this.particles = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles[i] = { alive: false, life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0, drag: 0.94, gravity: 0 };
    }
    this.cursor = 0;
  }

  /** Grab the next slot. Oldest particles are overwritten when saturated. */
  _spawn(x, y, z, color, opts = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;

    const p = this.particles[i];
    p.alive = true;
    p.life = 0;
    p.maxLife = opts.life ?? 1.1;
    p.vx = opts.vx ?? 0;
    p.vy = opts.vy ?? 0;
    p.vz = opts.vz ?? 0;
    p.drag = opts.drag ?? 0.94;
    p.gravity = opts.gravity ?? 0;

    const pos = this.pGeo.attributes.position.array;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;

    const col = this.pGeo.attributes.color.array;
    col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b;
    return i;
  }

  // ------------------------------------------------------------- public FX --

  /**
   * Recompute how hard particle bursts hit, based on how many fish are
   * currently active. Called once a frame by main.js.
   *
   * The fixed MAX_PARTICLES pool never grows or shrinks — this instead
   * throttles how many particles each individual bite/gift/clash burst
   * requests, since it's the sheer number of overlapping bursts in a
   * crowded fight (not the pool ceiling) that turns the screen to noise.
   * Floors out rather than reaching zero, so effects stay visible even at
   * the arena's max fish count.
   */
  setActivity(fishCount) {
    const over = Math.max(0, fishCount - RENDER.clutterFishThreshold);
    this.intensityScale = Math.max(
      RENDER.clutterParticleFloor,
      1 - over * RENDER.clutterParticleFalloffPerFish
    );
  }

  /** Scales a particle count by the current crowd-throttled intensity. */
  _scaledCount(n) {
    return Math.max(1, Math.round(n * this.intensityScale));
  }

  /** Blood cloud + a few bright sparks where a bite landed. */
  blood(position, intensity = 1) {
    const deep = new THREE.Color(0x8e1220);
    const bright = new THREE.Color(0xd93a3a);
    const count = this._scaledCount(14 + 18 * intensity);

    for (let i = 0; i < count; i++) {
      const dir = randomUnit();
      const speed = 1.4 + Math.random() * 4.5 * intensity;
      this._spawn(
        position.x + dir.x * 0.4, position.y + dir.y * 0.4, position.z + dir.z * 0.4,
        Math.random() < 0.4 ? bright : deep,
        {
          vx: dir.x * speed, vy: dir.y * speed + 0.5, vz: dir.z * speed,
          life: 1.4 + Math.random() * 1.2,
          drag: 0.90,
          gravity: 0.35   // blood drifts upward slowly in water
        }
      );
    }
    // A couple of bubbles escape on every hit.
    const pale = new THREE.Color(0xd9fbff);
    for (let i = 0; i < 5; i++) {
      const dir = randomUnit();
      this._spawn(position.x, position.y, position.z, pale, {
        vx: dir.x * 1.2, vy: 2.5 + Math.random() * 2, vz: dir.z * 1.2,
        life: 1.6, drag: 0.97, gravity: 1.1
      });
    }
  }

  /**
   * Water-jet trail behind a turbo-boosting fish.
   *
   * `count` is driven by the caller's actual speed (not just "is turbo on"),
   * so a fish still turning into its boost drags a thin wake and a fish at
   * full speed drags a dense one — the trail reads as motion, not a toggle.
   * Two-tone (pale water + the fish's own glow color) so the trail visually
   * belongs to the light/aura around the fish rather than looking bolted on.
   */
  jetTrail(position, backDir, { count = 6, color = 0x63e8ff } = {}) {
    const pale = new THREE.Color(0xbdf3ff);
    const glow = new THREE.Color(color);
    const scaled = this._scaledCount(count);
    for (let i = 0; i < scaled; i++) {
      this._spawn(
        position.x + (Math.random() - 0.5), position.y + (Math.random() - 0.5), position.z + (Math.random() - 0.5),
        Math.random() < 0.5 ? pale : glow,
        {
          vx: backDir.x * 10 + (Math.random() - 0.5),
          vy: backDir.y * 10 + Math.random() * 0.8,
          vz: backDir.z * 10 + (Math.random() - 0.5),
          life: 0.75, drag: 0.9, gravity: 0.4
        }
      );
    }
  }

  /**
   * Poison Bomb — vibrant toxic particle burst.
   *
   * Neon-green and violet motes explode outward from the impact point. Each
   * one carries a tangential component around the vertical axis on top of its
   * radial velocity, so the whole cloud visibly churns as it expands instead
   * of just flying outward in straight lines — the closest a billboarded
   * sprite cloud gets to reading as "spinning". Two accent rings (one per
   * color) sell the blast radius at a glance.
   */
  poisonBomb(position, radius = 10, intensity = 1) {
    const toxicGreen = new THREE.Color(0x00ff66);
    const violet = new THREE.Color(0x8a2be2);
    const count = this._scaledCount(26 + 22 * intensity);
    const reach = Math.max(1, radius) / 10;

    for (let i = 0; i < count; i++) {
      const dir = randomUnit();
      const speed = (2.5 + Math.random() * 6.5 * intensity) * reach;
      const swirl = (3 + Math.random() * 4) * reach;
      this._spawn(
        position.x, position.y, position.z,
        Math.random() < 0.5 ? toxicGreen : violet,
        {
          vx: dir.x * speed - dir.z * swirl,
          vy: dir.y * speed * 0.5 + 1.0,
          vz: dir.z * speed + dir.x * swirl,
          life: 1.5 + Math.random() * 1.0,
          drag: 0.92,
          gravity: 0.2   // toxic cloud drifts upward slowly, like the blood/gift bursts
        }
      );
    }

    this.ring(position, { color: 0x00ff66, from: 1, to: radius * 1.6, duration: 0.6, tilt: false });
    this.ring(position, { color: 0x8a2be2, from: 1, to: radius * 1.1, duration: 0.5, tilt: false });
  }

  /** Tiny bright burst for a single small-arms hit — distinct from blood/clash. */
  spark(position, color = 0xffffff) {
    const col = new THREE.Color(color);
    const count = this._scaledCount(4);
    for (let i = 0; i < count; i++) {
      const dir = randomUnit();
      const speed = 3 + Math.random() * 5;
      this._spawn(position.x, position.y, position.z, col, {
        vx: dir.x * speed, vy: dir.y * speed + 0.6, vz: dir.z * speed,
        life: 0.16 + Math.random() * 0.14,
        drag: 0.85,
        gravity: 0.1
      });
    }
  }

  /**
   * Heal Boost — 20 coins (temporary placeholder power, see config.js
   * POWERS.heal). Motes rise straight up and fade — the opposite motion of
   * every damage burst's outward/downward scatter — so it reads as
   * "restorative" on sight, before the "+120 HP" popup even lands. `opts`
   * comes from POWERS.heal (main.js), same pattern as spawnRotorBlades.
   */
  heal(position, opts) {
    const col = new THREE.Color(opts.color);
    const count = this._scaledCount(24);

    for (let i = 0; i < count; i++) {
      const dir = randomUnit();
      const speed = 1 + Math.random() * 2;
      this._spawn(position.x, position.y, position.z, col, {
        vx: dir.x * speed,
        vy: 2 + Math.random() * 2,
        vz: dir.z * speed,
        life: 0.5 + Math.random() * 0.35,
        drag: 0.9,
        gravity: 1.4   // steady upward lift instead of the usual outward scatter
      });
    }

    this.ring(position, { color: opts.color, from: 1, to: 14, duration: 0.5, tilt: false });
  }

  // ---------------------------------------------------------------- bullets --

  /**
   * Energy-orb pool for the Gatling Bullet Storm power (5 coins).
   *
   * Distinct spaced-out glowing spheres, not a continuous cylinder stream
   * (that was the previous design — see git history; it read as one solid
   * beam rather than individual shots). At speed*fireInterval = 150*0.04 =
   * 6 world units between consecutive spawn points, and a ~1.7-unit orb
   * diameter, real gaps show up between shots without any extra spacing
   * logic — that gap is what actually reads as "distinct projectiles",
   * not the shape itself.
   *
   * Geometry is ONE shared prototype (every orb ever fired), same as the
   * missile cones. Materials are NOT shared, unlike the old cylinder bolts:
   * each orb clones one of the two base color prototypes (a warm fiery-
   * orange pair, not the earlier neon cyan/gold) so updateBullets can pulse
   * its emissive/scale on its own independent phase — sharing one material
   * would make every orb of that color pulse in lockstep instead of each
   * shot reading as its own separate pulse. removeBullet() disposes the
   * per-instance clone (safe — it's never the shared base prototype or the
   * shared geometry), same pattern the original pre-cylinder sprite bullets
   * used.
   */
  _initBullets() {
    // 16/12 segments (up from 12/10) — a much bigger sphere shows low-poly
    // faceting more, and this is meant to read as a smooth glowing orb.
    this.bulletGeo = new THREE.SphereGeometry(BULLET_RADIUS, 16, 12);
    // Solid MeshStandardMaterial, not additive-blended/transparent:
    // additive glow was already tried for this power's old sprite texture
    // and compressed into a washed-out blob on a re-encoded TikTok LIVE
    // stream. Fiery orange tracer look: a brighter warm-orange base color
    // (0xff6600) paired with a deeper orange emissive (0xff5500) so the
    // surface itself reads as a "warm core" rather than a flat single hue.
    // emissiveIntensity cut from 6 to 2.6 — 6 was tuned for max neon
    // punch on a small mobile viewport, but it washed out/blinded the
    // screen at this orb size; 2.6 still reads as a glowing tracer round
    // without the flare.
    this.bulletBaseMats = [
      new THREE.MeshStandardMaterial({ color: 0xff6600, emissive: 0xff5500, emissiveIntensity: 2.6, metalness: 0.1, roughness: 0.25 }),
      new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff5500, emissiveIntensity: 2.6, metalness: 0.1, roughness: 0.25 })
    ];
    this._bulletColorToggle = 0;
    this.bullets = [];
  }

  /**
   * Fire exactly ONE orb from `origin` (the caster's mouth — see
   * fish.mouthPosition(), called by main.js). Game calls this `opts.count`
   * times on a rapid-fire schedule — see the case 'bulletStorm' comment in
   * _triggerPower.
   *
   * Lead-shot targeting: aims at where the nearest living enemy WILL be
   * (target.root.position + target.forward*target.speed*leadTime), not
   * where it is right now, so a fish that's actively swimming away doesn't
   * just outrun a straight shot. leadTime is the standard single-pass
   * approximation — time for the orb to cross the CURRENT distance at its
   * own speed — not an iterative solve; plenty accurate at this speed/
   * arena scale without an extra loop per shot. Direction is still locked
   * in at the moment of firing and never re-aimed in flight (see
   * updateBullets) — fireInterval is fast enough (375 shots/15s) that the
   * stream as a whole tracks a moving target even though no single orb
   * curves to follow it.
   */
  spawnBullet(rawOrigin, owner, opts, fishList) {
    // Push the spawn point clear of the caster's OWN body first, along its
    // swim heading — `rawOrigin` (fish.mouthPosition(), from main.js) is
    // already forward of the fish's center, but a big Titan-tier body can
    // still extend past that analytical offset. owner.radius reflects the
    // fish's actual HP-derived size, so this scales correctly for any fish,
    // not just a scale-1 one. Used for target-acquisition distance too, not
    // just the final mesh placement, so both stay consistent with where the
    // orb actually starts.
    const origin = _bulletSpawnBase.copy(rawOrigin)
      .addScaledVector(owner.forward, owner.radius + 1.5);

    let target = null;
    let bestDistSq = opts.acquireRadius * opts.acquireRadius;
    for (const fish of fishList) {
      if (fish === owner || fish.dead) continue;
      fish.root.getWorldPosition(_bulletTargetWorldPos);
      const d = _bulletTargetWorldPos.distanceToSquared(origin);
      if (d < bestDistSq) { bestDistSq = d; target = fish; }
    }

    if (target) {
      target.root.getWorldPosition(_bulletTargetWorldPos);
      const leadTime = Math.sqrt(bestDistSq) / opts.speed;
      _bulletPredictedPos.copy(_bulletTargetWorldPos)
        .addScaledVector(target.forward, target.speed * leadTime);
      _bulletDir.subVectors(_bulletPredictedPos, origin).normalize();
    } else {
      // No target in range — keep firing along the caster's own facing
      // rather than not firing at all; a gatling burst doesn't pause
      // between kills.
      _bulletDir.set(0, 0, 1).applyQuaternion(owner.root.quaternion).normalize();
    }

    const baseMat = this.bulletBaseMats[this._bulletColorToggle];
    this._bulletColorToggle = 1 - this._bulletColorToggle;
    const material = baseMat.clone();

    const mesh = new THREE.Mesh(this.bulletGeo, material);
    // Small additional forward offset (along the actual fire direction, not
    // the swim heading above) so the orb doesn't render half-buried in
    // whatever it's aimed at, at the instant it spawns. +0.5 Y so it
    // glides slightly above the fish hitbox plane instead of clipping
    // through it at spawn.
    mesh.position.copy(origin).addScaledVector(_bulletDir, BULLET_RADIUS);
    mesh.position.y += 0.5;
    // Solid opaque mesh, so this only affects draw order among objects in
    // the same render queue — it does NOT skip the depth test, so a bolt
    // genuinely behind a closer fish still correctly renders behind it.
    // The actual "hidden inside the model" fix is the spawn offset above.
    mesh.renderOrder = 999;
    this.scene.add(mesh);

    this.bullets.push({
      mesh,
      owner,
      target,
      dir: _bulletDir.clone(),
      speed: opts.speed,
      hitRadius: opts.hitRadius,
      damage: opts.damage,
      life: opts.lifetime,
      pulsePhase: Math.random() * Math.PI * 2,
      pulseAge: 0,
      baseEmissive: material.emissiveIntensity,
      /** null = still flying, a Fish = landed a hit, 'expired' = timed out. */
      hit: null
    });
  }

  /** Fly every live orb in its fixed straight line, pulse it, and flag impacts. Game applies the damage. */
  updateBullets(dt) {
    for (const b of this.bullets) {
      if (b.hit) continue;
      b.life -= dt;

      b.mesh.position.addScaledVector(b.dir, b.speed * dt);

      // Independent pulse per orb — safe because each orb owns its own
      // cloned material (see spawnBullet), not a shared one.
      b.pulseAge += dt;
      const pulse = 0.65 + 0.35 * Math.sin(b.pulseAge * 14 + b.pulsePhase);
      b.mesh.material.emissiveIntensity = b.baseEmissive * pulse;
      b.mesh.scale.setScalar(0.85 + 0.2 * pulse);

      // One trail particle per frame, tinted to match this orb's own color
      // (cyan or gold) instead of a single fixed hue for every shot.
      this._spawn(
        b.mesh.position.x, b.mesh.position.y, b.mesh.position.z,
        b.mesh.material.color,
        {
          vx: -b.dir.x * 2, vy: -b.dir.y * 2 + 0.15, vz: -b.dir.z * 2,
          life: 0.16, drag: 0.86, gravity: 0.05
        }
      );

      // Hit-test against the orb's own locked target only — it flies
      // straight, so it can't be redirected onto a different fish the way a
      // homing shot could. If the target died mid-flight this just expires
      // on lifetime instead of hitting anyone.
      if (b.target && !b.target.dead) {
        b.target.root.getWorldPosition(_bulletTargetWorldPos);
        const hitReach = b.hitRadius + b.target.radius;
        if (b.mesh.position.distanceToSquared(_bulletTargetWorldPos) <= hitReach * hitReach) {
          b.hit = b.target;
          continue;
        }
      }

      if (b.life <= 0) b.hit = 'expired';
    }
  }

  /** Remove a resolved orb (hit or expired). Disposes its own cloned material, never the shared geometry or the two base prototypes. */
  removeBullet(bullet) {
    this.scene.remove(bullet.mesh);
    bullet.mesh.material?.dispose?.();
    const idx = this.bullets.indexOf(bullet);
    if (idx >= 0) this.bullets.splice(idx, 1);
  }

  // --------------------------------------------------------- homing missiles --

  /**
   * Homing missile pool for the Homing Missile Volley power (30 coins).
   *
   * Unlike bullets, missiles are few (12) and long-lived enough to justify a
   * real Mesh each rather than an instanced buffer. Movement and target
   * acquisition live here; Game applies splash damage once updateMissiles()
   * flags one as exploded.
   */
  _initMissiles() {
    this.missileGeo = new THREE.ConeGeometry(0.4, 1.8, 6);
    this.missileMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a2a,
      emissive: 0xff3300,
      emissiveIntensity: 1.6,
      metalness: 0.5,
      roughness: 0.3
    });
    this.missiles = [];
  }

  /** Launch a full volley. `fishList` is used once, up front, to pick initial targets. */
  launchMissiles(origin, owner, opts, fishList) {
    for (let i = 0; i < opts.count; i++) {
      const angle = (i / opts.count) * Math.PI * 2;
      const mesh = new THREE.Mesh(this.missileGeo, this.missileMat);
      mesh.position.copy(origin);
      this.scene.add(mesh);

      const missile = {
        mesh,
        owner,
        dir: new THREE.Vector3(Math.cos(angle), 0.25, Math.sin(angle)).normalize(),
        target: null,
        speed: opts.speed,
        turnRate: opts.turnRate,
        life: opts.lifetime,
        acquireRadius: opts.acquireRadius,
        hitRadius: 3,
        exploded: false
      };
      this._acquireMissileTarget(missile, fishList);
      this.missiles.push(missile);
    }

    this.ring(origin, { color: opts.color, from: 1, to: 16, duration: 0.4, tilt: false });
    this.addTrauma(0.6);
  }

  _acquireMissileTarget(missile, fishList) {
    let best = null;
    let bestDistSq = missile.acquireRadius * missile.acquireRadius;
    for (const fish of fishList) {
      if (fish === missile.owner || fish.dead) continue;
      const d = fish.root.position.distanceToSquared(missile.mesh.position);
      if (d < bestDistSq) { bestDistSq = d; best = fish; }
    }
    missile.target = best;
  }

  /** Steer, move, trail and flag impacts. `fishList` is read every frame so a missile can retarget. */
  updateMissiles(dt, fishList) {
    for (const m of this.missiles) {
      if (m.exploded) continue;
      m.life -= dt;

      if (!m.target || m.target.dead) this._acquireMissileTarget(m, fishList);

      if (m.target) {
        _missileDesired.copy(m.target.root.position).sub(m.mesh.position).normalize();
        m.dir.lerp(_missileDesired, Math.min(1, m.turnRate * dt)).normalize();
      }

      m.mesh.position.addScaledVector(m.dir, m.speed * dt);
      _missileQuat.setFromUnitVectors(_missileUp, m.dir);
      m.mesh.quaternion.copy(_missileQuat);

      // Cheap one-particle-per-frame exhaust trail.
      this._spawn(
        m.mesh.position.x, m.mesh.position.y, m.mesh.position.z,
        _missileTrailColor,
        {
          vx: -m.dir.x * 1.5, vy: -m.dir.y * 1.5 + 0.4, vz: -m.dir.z * 1.5,
          life: 0.35, drag: 0.9, gravity: 0.1
        }
      );

      const hitReach = m.hitRadius + (m.target ? m.target.radius : 0);
      if (m.target && m.mesh.position.distanceToSquared(m.target.root.position) <= hitReach * hitReach) {
        m.exploded = true;
      } else if (m.life <= 0) {
        m.exploded = true;
      }
    }
  }

  /** Remove a resolved missile (exploded or expired) and free its mesh. */
  removeMissile(missile) {
    this.scene.remove(missile.mesh);
    const idx = this.missiles.indexOf(missile);
    if (idx >= 0) this.missiles.splice(idx, 1);
  }

  /** Fire + smoke burst for a missile impact — no shockwave ring standing in for it. */
  missileExplosion(position, radius) {
    const fire = new THREE.Color(0xff6a1f);
    const ember = new THREE.Color(0xffcf5c);
    const count = this._scaledCount(20);
    for (let i = 0; i < count; i++) {
      const dir = randomUnit();
      const speed = 6 + Math.random() * 10;
      this._spawn(position.x, position.y, position.z, Math.random() < 0.5 ? fire : ember, {
        vx: dir.x * speed, vy: dir.y * speed * 0.6 + 2, vz: dir.z * speed,
        life: 0.4 + Math.random() * 0.3,
        drag: 0.88,
        gravity: 0.4
      });
    }

    const smoke = new THREE.Color(0x555a5f);
    const smokeCount = this._scaledCount(14);
    for (let i = 0; i < smokeCount; i++) {
      const dir = randomUnit();
      this._spawn(position.x, position.y, position.z, smoke, {
        vx: dir.x * 2, vy: 2 + Math.random() * 2, vz: dir.z * 2,
        life: 1.2 + Math.random() * 0.6,
        drag: 0.95,
        gravity: -0.15   // smoke rises and lingers, unlike every other burst here
      });
    }

    this.ring(position, { color: 0xff6a1f, from: 1, to: radius * 1.2, duration: 0.4, tilt: false });
    this.addTrauma(0.25);
  }

  // ------------------------------------------------------------ beam rotor --

  /**
   * Physical rotating laser beams for the 360 Beam Rotor power (100 coins).
   *
   * Each beam is a real box mesh plus an invisible tip marker, both children
   * of a per-beam holder fanned evenly around a pivot. Game reads each tip's
   * live world position every damage tick to do real geometric hit-testing —
   * nothing here decides who gets hit.
   *
   * The pivot is parented to the SCENE, not to the owner fish's root, and is
   * kept in sync by copying the fish's transform every frame in
   * updateBeamRotors instead. beamGeo/beamMat are shared across every rotor
   * cast, same as spikeGeo/shurikenGeo above — parenting under fish.root would
   * put them in the subtree Fish.dispose() walks and disposes, and a fish
   * dying mid-spin would free geometry every other active rotor still needs.
   */
  _initBeamRotor() {
    this.beamGeo = new THREE.BoxGeometry(1, 0.5, 0.5);
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xff2a6d,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    });
    this.beamRotors = [];
  }

  spawnBeamRotor(fish, opts) {
    const pivot = new THREE.Object3D();
    pivot.position.copy(fish.root.position);
    pivot.quaternion.copy(fish.root.quaternion);
    this.scene.add(pivot);

    const beams = [];
    for (let i = 0; i < opts.beams; i++) {
      const mesh = new THREE.Mesh(this.beamGeo, this.beamMat);
      mesh.scale.set(opts.length, 0.6, 0.6);
      mesh.position.set(opts.length * 0.5, 0, 0);

      const tip = new THREE.Object3D();
      tip.position.set(opts.length, 0, 0);

      const holder = new THREE.Object3D();
      holder.rotation.y = (i / opts.beams) * Math.PI * 2;
      holder.add(mesh);
      holder.add(tip);
      pivot.add(holder);

      beams.push({ holder, tip });
    }

    const entry = { fish, pivot, beams, spinAngle: 0, spinSpeed: opts.spinSpeed, life: opts.duration };
    this.beamRotors.push(entry);

    this.ring(fish.root.position, { color: opts.color, from: 1, to: 20, duration: 0.5, tilt: false });
    this.addTrauma(0.5);
    return entry;
  }

  /**
   * Track the owner fish (position + facing) and layer the rotor's own spin
   * on top, then tear down rotors whose owner died or timed out. Kept in
   * world space — see the note on spawnBeamRotor for why it isn't parented.
   */
  updateBeamRotors(dt) {
    for (let i = this.beamRotors.length - 1; i >= 0; i--) {
      const r = this.beamRotors[i];
      r.life -= dt;

      if (r.life <= 0 || r.fish.dead) {
        this.scene.remove(r.pivot);
        this.beamRotors.splice(i, 1);
        continue;
      }

      r.spinAngle += r.spinSpeed * dt;
      r.pivot.position.copy(r.fish.root.position);
      r.pivot.quaternion.copy(r.fish.root.quaternion);
      r.pivot.rotateY(r.spinAngle);
    }
  }

  // ---------------------------------------------------------- rotor blades --

  /**
   * Physical spinning helicopter blades for the Rotor Blade Storm power
   * (20 coins) — a single instant high-damage burst now, not a sustained
   * field. Same scene-parenting shape as spawnBeamRotor/updateBeamRotors
   * just above (a pivot copies the owner's transform every frame rather
   * than being a child of fish.root), for the same reason: a fish dying
   * mid-spin must not drag this geometry into Fish.dispose()'s cleanup walk.
   *
   * Purely visual — damage lands once, immediately, in main.js's case
   * 'rotor' the instant this is called; the ~1.5-2s spin here is spectacle
   * for a hit that already happened, not a sustained hitbox. Matte,
   * non-additive materials on purpose (no glow layer, no point light) —
   * this got dialed back down after an earlier glowing-halo version read as
   * visual noise; solid, high-contrast color reads clearer at a glance.
   *
   * Each cast gets its OWN cloned materials (not the shared prototypes
   * below), which is what makes the per-instance fade-out in
   * updateRotorBlades possible without dimming every other active cast's
   * blades along with it — correspondingly, disposing those clones on
   * teardown is correct and required here, unlike the shared
   * geometry/prototype materials this file otherwise never disposes.
   */
  _initRotorBlades() {
    // Thick, heavy-duty slabs — Y (thickness) and Z (width) both well past
    // a thin plane, so they read as solid blades even spinning fast.
    this.rotorBladeGeo = new THREE.BoxGeometry(1, 0.6, 4.5);
    this.rotorBladeMat = new THREE.MeshStandardMaterial({
      color: 0xd35400,
      roughness: 0.65,
      metalness: 0.25,
      flatShading: true,
      transparent: true,
      opacity: 1
    });
    this.rotorHubGeo = new THREE.SphereGeometry(1.6, 14, 12);
    this.rotorHubMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a2a,
      roughness: 0.5,
      metalness: 0.4,
      transparent: true,
      opacity: 1
    });
    this.rotorBlades = [];
  }

  spawnRotorBlades(fish, opts) {
    const pivot = new THREE.Object3D();
    pivot.position.copy(fish.root.position);
    this.scene.add(pivot);

    const coreMat = this.rotorBladeMat.clone();
    const hubMat = this.rotorHubMat.clone();

    for (let i = 0; i < opts.bladeCount; i++) {
      const holder = new THREE.Object3D();
      // bladeCount:4 lands these at 0/90/180/270 — a symmetric cross.
      holder.rotation.y = (i / opts.bladeCount) * Math.PI * 2;

      const core = new THREE.Mesh(this.rotorBladeGeo, coreMat);
      core.scale.set(opts.radius, 1, 1);
      core.position.set(opts.radius * 0.5, 0, 0);
      holder.add(core);

      pivot.add(holder);
    }

    const hub = new THREE.Mesh(this.rotorHubGeo, hubMat);
    pivot.add(hub);

    const entry = {
      fish, pivot, spinAngle: 0, spinSpeed: opts.spinSpeed,
      life: opts.duration, fadeWindow: Math.min(0.35, opts.duration * 0.3),
      maxLife: opts.duration,
      materials: [coreMat, hubMat],
      baseOpacity: [coreMat.opacity, hubMat.opacity]
    };
    this.rotorBlades.push(entry);

    this.ring(fish.root.position, { color: opts.color, from: 1, to: opts.radius * 0.5, duration: 0.4, tilt: true });
    this.addTrauma(0.4);
    return entry;
  }

  updateRotorBlades(dt) {
    for (let i = this.rotorBlades.length - 1; i >= 0; i--) {
      const r = this.rotorBlades[i];
      r.life -= dt;

      if (r.life <= 0 || r.fish.dead) {
        this.scene.remove(r.pivot);
        // Safe to dispose here — these are this instance's OWN cloned
        // materials (see spawnRotorBlades), never the shared prototypes.
        for (const m of r.materials) m.dispose();
        this.rotorBlades.splice(i, 1);
        continue;
      }

      r.spinAngle += r.spinSpeed * dt;
      r.pivot.position.copy(r.fish.root.position);
      // No quaternion copy (unlike beamRotor) — the blade plane must stay
      // flat/horizontal regardless of which way the fish is facing/banking,
      // so only Y-axis spin is applied, never the fish's own orientation.
      r.pivot.rotation.set(0, r.spinAngle, 0);

      // Clean fade-out over the last stretch of life instead of an abrupt
      // pop when the pivot is removed from the scene.
      if (r.life < r.fadeWindow) {
        const k = r.life / r.fadeWindow;
        r.materials.forEach((m, idx) => { m.opacity = r.baseOpacity[idx] * k; });
      }
    }
  }

  // ----------------------------------------------------------- ring meshes --

  _initRings() {
    this.rings = [];
    this.ringPool = [];
    this.ringGeo = new THREE.TorusGeometry(1, 0.045, 6, 48);
    this.spikeGeo = new THREE.ConeGeometry(0.16, 1.5, 5);

    /**
     * Shuriken geometry — a four-pointed throwing star, extruded flat.
     *
     * Built as a Shape rather than assembled from cones because a real star
     * silhouette is what makes it instantly readable as a weapon at arena
     * distance. A cone tumbling through water reads as debris; a spinning star
     * reads as something thrown at someone.
     */
    this.shurikenGeo = buildShuriken();

    /**
     * Live blades from Spike Burst. Shared material and geometry across every
     * blade — 14 per cast and several casts can overlap, so per-blade materials
     * would mean dozens of draw calls for what is visually one object type.
     */
    this.blades = [];
    // Standard (not Basic) so the star catches light as it spins — the
    // highlight sweeping across the blades is what sells the rotation.
    this.bladeMat = new THREE.MeshStandardMaterial({
      color: 0xf2f6ff,
      emissive: 0xffd23c,
      emissiveIntensity: 0.55,
      metalness: 0.9,
      roughness: 0.22,
      transparent: true,
      opacity: 0.98,
      side: THREE.DoubleSide
    });
  }

  _loadBladeModel() {
    const loader = new GLTFLoader();
    loader.load(
      '/models/blade.glb',
      (gltf) => {
        this.bladeTemplate = gltf.scene;
        this.bladeReady = true;
      },
      undefined,
      (error) => {
        console.error('[effects] failed to load blade.glb', error);
        this.bladeReady = true;
      }
    );
  }

  _takeRing(color, opacity) {
    let ring = this.ringPool.pop();
    if (!ring) {
      ring = new THREE.Mesh(
        this.ringGeo,
        new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false })
      );
    }
    ring.material.color.set(color);
    ring.material.opacity = opacity;
    ring.visible = true;
    this.scene.add(ring);
    return ring;
  }

  /** Expanding ring. Used by shockwaves and spike bursts alike. */
  ring(position, { color = 0x39d7ff, from = 1, to = 40, duration = 0.8, tilt = true } = {}) {
    const mesh = this._takeRing(color, 0.9);
    mesh.position.copy(position);
    mesh.rotation.set(tilt ? -Math.PI / 2 : 0, 0, 0);
    mesh.scale.setScalar(from);
    this.rings.push({ mesh, t: 0, duration, from, to });
  }

  emitRotorPulse(ownerFish, position) {
    this.ring(position, { color: 0xff2200, from: 1, to: 60, duration: 0.8, tilt: false });

    const materials = [];
    ownerFish?.modelInstance?.root?.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const list = Array.isArray(child.material) ? child.material : [child.material];
      list.forEach((mat) => {
        if (!mat || !mat.emissive) return;
        materials.push({
          material: mat,
          emissive: mat.emissive.clone(),
          emissiveIntensity: mat.emissiveIntensity
        });
        mat.emissive.setHex(0xffffff);
        mat.emissiveIntensity = 2.2;
      });
    });

    this.flashEffects.push({
      type: 'material',
      materials,
      life: 0.1,
      maxLife: 0.1
    });

    const light = new THREE.PointLight(0xff2200, 8, 80, 2);
    light.position.copy(position);
    ownerFish.root.add(light);
    this.flashEffects.push({
      type: 'light',
      light,
      life: 0.3,
      maxLife: 0.3,
      maxIntensity: 8
    });
  }

  /** 360° cone burst for the spike power. */
  /**
   * Throw physical blades into the arena.
   *
   * Returns the blade records so the game loop can collide them against fish.
   * The effect layer owns their movement and rendering; damage stays in main.js
   * where all the other combat lives.
   */
  launchBlades(position, owner, opts) {
    const { count, speed, lifetime, radius, color } = opts;

    for (let i = 0; i < count; i++) {
      // Fan them out evenly around the horizontal plane, with a little tilt so
      // they don't look like a flat ring of cardboard.
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.2;
      const tilt = (Math.random() - 0.5) * 0.35;

      const mesh = this.bladeTemplate
        ? clone(this.bladeTemplate)
        : new THREE.Mesh(this.shurikenGeo, this.bladeMat);
      mesh.position.copy(position);
      // When cloning a GLB template, set an explicit non-uniform scale so the
      // authored model reads at arena distance. Otherwise fall back to the
      // configured radius scalar for the procedural shuriken.
      if (this.bladeTemplate) {
        mesh.scale.set(12, 12, 12);
      } else {
        mesh.scale.setScalar(radius);
      }

      const blade = {
        mesh,
        owner,
        vx: Math.cos(angle) * speed,
        vz: Math.sin(angle) * speed,
        vy: tilt * 6,
        life: lifetime,
        maxLife: lifetime,
        radius,
        // Fast spin about the vertical axis — a shuriken's whole read is that
        // it's whirling. Slow and it looks like floating litter.
        spin: (Math.random() < 0.5 ? -1 : 1) * (14 + Math.random() * 9),
        hits: new Map()
      };

      this.scene.add(mesh);
      this.blades.push(blade);
    }

    this.ring(position, { color, from: 1, to: 18, duration: 0.45, tilt: false });

    this.ring(position, { color: 0xffffff, from: 1, to: 25, duration: 0.25, tilt: false });
    this.ring(position, { color: 0xffe066, from: 1, to: 18, duration: 0.35, tilt: false });
    this.ring(position, { color: 0xff9900, from: 1, to: 12, duration: 0.45, tilt: false });
    this.giftBurst(position, 2.0);
    this.addTrauma(1.5);

    return this.blades;
  }

  /**
   * Move every blade, bounce it off the tank walls, and fade it out near death.
   *
   * Bouncing uses the same mirror reflection the fish use, so blades behave
   * like everything else in the arena and a viewer can predict where one is
   * going. That predictability is what turns them from a flash into a threat.
   */
  updateBlades(dt, arena) {
    for (let i = this.blades.length - 1; i >= 0; i--) {
      const b = this.blades[i];
      b.life -= dt;

      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        this.blades.splice(i, 1);
        continue;
      }

      const p = b.mesh.position;
      p.x += b.vx * dt;
      p.y += b.vy * dt;
      p.z += b.vz * dt;

      const limit = arena.halfSize - b.radius;
      if (p.x > limit) { p.x = limit; b.vx = -Math.abs(b.vx); }
      else if (p.x < -limit) { p.x = -limit; b.vx = Math.abs(b.vx); }
      if (p.z > limit) { p.z = limit; b.vz = -Math.abs(b.vz); }
      else if (p.z < -limit) { p.z = -limit; b.vz = Math.abs(b.vz); }

      // Keep them inside the swim band so they can actually hit something.
      if (p.y > arena.ceiling) { p.y = arena.ceiling; b.vy = -Math.abs(b.vy); }
      else if (p.y < arena.floor) { p.y = arena.floor; b.vy = Math.abs(b.vy); }

      // Spin flat about Y, with a slight lean into the direction of travel so
      // it looks thrown rather than dropped.
      b.mesh.rotation.y += b.spin * dt;
      b.mesh.rotation.z = Math.sin(b.life * 3) * 0.18;

      // Expire the per-fish hit cooldowns.
      for (const [key, value] of b.hits) {
        const next = value - dt;
        if (next <= 0) b.hits.delete(key);
        else b.hits.set(key, next);
      }

      // Fade only in the last second, so for nine seconds they stay fully solid
      // and obviously dangerous.
      const fade = Math.min(1, b.life);
      // Preserve the initial scale set at spawn (especially for cloned GLB
      // blades). Do not override with a per-frame scalar, which can undo the
      // explicit `mesh.scale.set(x,y,z)` applied when cloning.
      // b.mesh.scale.setScalar(b.radius * (0.6 + fade * 0.4));
    }
  }

  clearBlades() {
    for (const b of this.blades) this.scene.remove(b.mesh);
    this.blades.length = 0;
  }

  // --------------------------------------------------------------- pinball --

  /**
   * Bouncing Logo Sphere pool for the Bouncing Logo Spheres power (20
   * coins). Deliberately the plainest-rendering power in the game — no
   * emissive glow, no additive blending, solid MeshStandardMaterial only —
   * per an explicit request to keep it cheap for TikTok Live Studio's
   * encoder rather than adding another neon effect.
   *
   * Geometry is ONE shared unit sphere; per-orb size comes from
   * mesh.scale.setScalar(opts.radius) at launch (see launchPinballOrbs),
   * same pattern launchBlades uses for shurikenGeo. Materials are NOT
   * shared: each orb clones pinballFallbackMat so its own avatar texture
   * (once/if it loads — see _loadAvatarTexture) can be swapped in without
   * touching any other live orb, and so removePinballOrb-equivalent
   * cleanup (inline in updatePinballOrbs) can dispose it safely.
   */
  _initPinball() {
    // Unit sphere — per-orb radius is applied via mesh.scale in
    // launchPinballOrbs (POWERS.pinball.radius). 20/16 segments (up from
    // 16/12) since that radius is now much larger (5, up from 2.2) — a
    // giant orb shows low-poly faceting more, and a glossy near-black
    // material makes flat facets especially visible in its specular
    // highlight.
    this.pinballGeo = new THREE.SphereGeometry(1, 20, 16);
    // Sleek glossy black billiard/pinball-steel fallback — near-black base
    // (0x111111, not pure 0x000000, so the specular highlight still reads
    // as shape rather than a flat void) with high metalness and low
    // roughness for a sharp, premium reflection. No emissive — this power
    // stays plain-rendering per an explicit request. What every orb shows
    // whenever a caster has no avatar, their avatar hasn't loaded yet, or
    // it fails to load at all.
    this.pinballFallbackMat = new THREE.MeshStandardMaterial({
      color: 0x111111,
      metalness: 0.9,
      roughness: 0.15
    });
    this._avatarLoader = new THREE.TextureLoader();
    this._avatarLoader.setCrossOrigin('anonymous');
    // avatar URL -> THREE.Texture once loaded, or -> [callback, ...] while
    // still in flight. Shared across every cast, so the same caster's
    // avatar is only ever fetched/decoded once, not once per orb per cast.
    this._avatarTextureCache = new Map();
    this.pinballOrbs = [];
  }

  /**
   * Load (or reuse a cached) avatar texture. `onReady` fires once, with the
   * loaded texture, ONLY on success — TikTok avatar CDNs don't always send
   * the CORS headers a WebGL texture upload requires (a plain <img> tag,
   * like the nameplate/leaderboard avatars use, has no such requirement,
   * so the exact same URL can work there and fail here). A failed load
   * just never calls back; every orb waiting on it stays on its fallback
   * material, which is the explicitly-requested behavior, not a bug to
   * work around.
   */
  _loadAvatarTexture(url, onReady) {
    const cached = this._avatarTextureCache.get(url);
    if (cached instanceof THREE.Texture) { onReady(cached); return; }
    if (Array.isArray(cached)) { cached.push(onReady); return; }

    // Unbounded growth guard — a long-running stream can rack up one
    // entry per unique gifter avatar, forever, otherwise. Evict the
    // OLDEST resolved entry (Map preserves insertion order) rather than
    // disposing it: an orb still flying could still be pointing at that
    // exact Texture as its material.map, and disposing out from under a
    // live reference would blank it mid-flight. Dropping our own map
    // reference just lets it get garbage-collected once nothing else
    // holds it; a future request for that same URL simply re-fetches.
    if (this._avatarTextureCache.size >= AVATAR_CACHE_LIMIT) {
      for (const [key, value] of this._avatarTextureCache) {
        if (value instanceof THREE.Texture) { this._avatarTextureCache.delete(key); break; }
      }
    }

    this._avatarTextureCache.set(url, [onReady]);
    this._avatarLoader.load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        const waiting = this._avatarTextureCache.get(url);
        this._avatarTextureCache.set(url, texture);
        if (Array.isArray(waiting)) waiting.forEach((cb) => cb(texture));
      },
      undefined,
      () => {
        // Don't cache the failure — a transient network blip shouldn't
        // permanently block a caster's avatar from ever loading again.
        this._avatarTextureCache.delete(url);
      }
    );
  }

  /**
   * Launch `opts.count` orbs outward from `position`, fanned evenly around
   * the horizontal plane — same fan pattern launchBlades uses. `owner` is
   * the caster Fish (not a username string): its `.avatar` URL is what
   * gets mapped onto every orb from this cast.
   */
  launchPinballOrbs(rawPosition, owner, opts) {
    // Push the whole launch point clear of the caster's own body first,
    // along its swim heading — same reasoning as spawnBullet's identical
    // offset: owner.radius reflects this specific fish's actual size, so a
    // Titan-tier caster gets proportionally more clearance than a small one.
    const position = _pinballSpawnBase.copy(rawPosition)
      .addScaledVector(owner.forward, owner.radius + 1.5);

    for (let i = 0; i < opts.count; i++) {
      const angle = (i / opts.count) * Math.PI * 2 + Math.random() * 0.2;

      const material = this.pinballFallbackMat.clone();
      const mesh = new THREE.Mesh(this.pinballGeo, material);
      mesh.position.copy(position);
      // +0.5 Y so orbs glide slightly above the fish hitbox plane instead
      // of clipping through it right at spawn.
      mesh.position.y += 0.5;
      mesh.scale.setScalar(opts.radius);
      // Solid opaque mesh — this only affects draw order among objects in
      // the same render queue, NOT the depth test, so an orb genuinely
      // behind a closer fish still correctly renders behind it. The actual
      // "hidden inside the model" fix is the spawn offset above.
      mesh.renderOrder = 999;
      this.scene.add(mesh);

      const orb = {
        mesh,
        owner,
        vx: Math.cos(angle) * opts.speed,
        vz: Math.sin(angle) * opts.speed,
        vy: (Math.random() - 0.5) * 4,
        life: opts.lifetime,
        radius: opts.radius,
        spin: (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random()),
        hits: new Map(),
        /** Set by updatePinballOrbs on a wall bounce; consumed (and reset)
         *  by main.js's per-frame hit resolver so it can play one ricochet
         *  cue per bounce instead of effects.js reaching into Audio itself. */
        justBounced: false
      };

      if (owner.avatar) {
        this._loadAvatarTexture(owner.avatar, (texture) => {
          if (orb.life <= 0) return; // orb already expired — material's disposed, don't touch it
          material.map = texture;
          material.needsUpdate = true;
        });
      }

      this.pinballOrbs.push(orb);
    }

    this.ring(position, { color: opts.color, from: 1, to: 14, duration: 0.4, tilt: false });
    this.addTrauma(0.4);
  }

  /**
   * Move every orb, bounce it off the tank walls (mirror reflection, same
   * trick updateBlades uses), roll it, and expire it after `lifetime`. Fish
   * contact is resolved separately by main.js's _resolvePinballHits — this
   * only owns movement/rendering, same split as every other projectile
   * system in this file.
   */
  updatePinballOrbs(dt, arena) {
    for (let i = this.pinballOrbs.length - 1; i >= 0; i--) {
      const o = this.pinballOrbs[i];
      o.life -= dt;

      if (o.life <= 0) {
        this.scene.remove(o.mesh);
        o.mesh.material?.dispose?.();
        this.pinballOrbs.splice(i, 1);
        continue;
      }

      const p = o.mesh.position;
      p.x += o.vx * dt;
      p.y += o.vy * dt;
      p.z += o.vz * dt;

      const limit = arena.halfSize - o.radius;
      if (p.x > limit) { p.x = limit; o.vx = -Math.abs(o.vx); o.justBounced = true; }
      else if (p.x < -limit) { p.x = -limit; o.vx = Math.abs(o.vx); o.justBounced = true; }
      if (p.z > limit) { p.z = limit; o.vz = -Math.abs(o.vz); o.justBounced = true; }
      else if (p.z < -limit) { p.z = -limit; o.vz = Math.abs(o.vz); o.justBounced = true; }

      // Keep them inside the swim band so they can actually hit something.
      if (p.y > arena.ceiling) { p.y = arena.ceiling; o.vy = -Math.abs(o.vy); o.justBounced = true; }
      else if (p.y < arena.floor) { p.y = arena.floor; o.vy = Math.abs(o.vy); o.justBounced = true; }

      // Roll like a ball along its direction of travel, not spin flat like
      // a shuriken — rotate about an axis perpendicular to the horizontal
      // velocity so it visibly tumbles as it rolls/bounces.
      o.mesh.rotation.x += o.vz * o.spin * dt * 0.06;
      o.mesh.rotation.z -= o.vx * o.spin * dt * 0.06;

      // Expire per-fish hit cooldowns.
      for (const [key, value] of o.hits) {
        const next = value - dt;
        if (next <= 0) o.hits.delete(key);
        else o.hits.set(key, next);
      }
    }
  }

  clearPinballOrbs() {
    for (const o of this.pinballOrbs) {
      this.scene.remove(o.mesh);
      o.mesh.material?.dispose?.();
    }
    this.pinballOrbs.length = 0;
  }

  // ---------------------------------------------------------------- shake --

  /** Add camera trauma. Squared falloff makes big hits feel disproportionate. */
  /**
   * Gold celebration burst for an incoming gift.
   *
   * Gifting is the only thing a viewer can actually DO, so it must be the most
   * visually rewarding event in the game — louder than a kill, louder than an
   * evolution. Particles plus an expanding gold ring, both scaled by coin value
   * so a 100-coin gift is unmistakably bigger than a rose.
   */
  giftBurst(position, intensity = 1) {
    const gold = new THREE.Color(0xffd23c);
    const pale = new THREE.Color(0xfff3b0);
    const count = this._scaledCount(16 + 14 * intensity);

    for (let i = 0; i < count; i++) {
      const dir = randomUnit();
      const speed = 4 + Math.random() * 9 * intensity;
      this._spawn(
        position.x + dir.x * 0.5, position.y + dir.y * 0.5, position.z + dir.z * 0.5,
        Math.random() < 0.5 ? gold : pale,
        {
          vx: dir.x * speed, vy: dir.y * speed + 1.5, vz: dir.z * speed,
          life: 1.0 + Math.random() * 0.7,
          drag: 0.93,
          gravity: 0.8    // gold rises like celebration confetti in water
        }
      );
    }
    this.ring(position, { color: 0xffd23c, from: 1, to: 14 + 10 * intensity, duration: 0.75, tilt: false });
  }

  /**
   * Low-coin chaos layer, fired alongside giftBurst() on every gift.
   *
   * Purely cosmetic: the real HP number is already applied server-side and
   * shown by the one floating damage popup main.js spawns for this gift (see
   * _onGift) — nothing here changes it or adds a second number. This only
   * makes that single real hit READ as a rapid-fire burst instead of one
   * soft poof, which is what makes a 1-coin Rose feel loaded instead of
   * limp. Total particle count is clamped to 50-100 and floored high on
   * purpose, so a cheap gift is not visibly weaker than an expensive one —
   * coin value already gets its own spectacle via giftBurst()'s size and the
   * dedicated powers (turbo/spikes/shockwave/shrapnel/rotor).
   *
   * Two textures, not one, because "micro-bullets" and "shrapnel" read as
   * different things: bullets are thin, fast, short-lived tracers; shrapnel
   * is heavier, slower, tumbles longer under more gravity. Both go through
   * _scaledCount() like every other burst, so a crowded arena throttles this
   * exactly the same way it throttles everything else.
   */
  bulletScatter(position, coins = 1) {
    const total = this._scaledCount(THREE.MathUtils.clamp(50 + coins * 2, 50, 100));
    const bulletCount = Math.round(total * 0.6);
    const shrapnelCount = total - bulletCount;

    // Micro-bullets: thin, fast, bright tracers — gone almost as soon as
    // they appear, which is what sells automatic-fire rather than a blast.
    const tracer = new THREE.Color(0xfff7c2);
    const hot = new THREE.Color(0xffb03a);
    for (let i = 0; i < bulletCount; i++) {
      const dir = randomUnit();
      const speed = 12 + Math.random() * 16;
      this._spawn(
        position.x, position.y, position.z,
        Math.random() < 0.5 ? tracer : hot,
        {
          vx: dir.x * speed, vy: dir.y * speed * 0.6 + 1, vz: dir.z * speed,
          life: 0.22 + Math.random() * 0.18,
          drag: 0.8,
          gravity: 0.1
        }
      );
    }

    // Shrapnel: heavier, slower, tumbles longer — reads as debris rather
    // than gunfire, giving the burst two distinct textures instead of one.
    const metal = new THREE.Color(0xb8c2cc);
    const scorch = new THREE.Color(0xff7a3c);
    for (let i = 0; i < shrapnelCount; i++) {
      const dir = randomUnit();
      const speed = 5 + Math.random() * 8;
      this._spawn(
        position.x, position.y, position.z,
        Math.random() < 0.5 ? metal : scorch,
        {
          vx: dir.x * speed, vy: dir.y * speed * 0.5 + 1.5, vz: dir.z * speed,
          life: 0.5 + Math.random() * 0.4,
          drag: 0.9,
          gravity: 0.6
        }
      );
    }

    // Sonic shockwave: two thin, fast, high-contrast rings racing outward in
    // 360°, distinct from giftBurst()'s slower gold ring.
    this.ring(position, { color: 0xffffff, from: 1, to: 24, duration: 0.3, tilt: false });
    this.ring(position, { color: 0xfff2b0, from: 1, to: 16, duration: 0.22, tilt: false });
  }


  /**
   * The impact moment.
   *
   * A Beyblade collision is not two objects touching — it's a FLASH. The whole
   * format depends on the eye being yanked to the point of contact, and that
   * needs three things firing together: a hard white spark at the exact contact
   * point, a shockwave ring on the horizontal plane so you can see the force
   * travel outward, and a debris spray thrown along the separation axis.
   *
   * `power` (0-1) scales all three, so a glancing clip is a small tick and a
   * Titan broadside is an event you can see from across the room.
   */
  clash(position, power = 0.5, normalX = 0, normalZ = 0) {
    const p = Math.max(0.15, Math.min(1, power));
    const white = new THREE.Color(0xffffff);
    const ice = new THREE.Color(0xbfefff);

    // 1. White-hot spark right at the contact point.
    const sparks = this._scaledCount(6 + 16 * p);
    for (let i = 0; i < sparks; i++) {
      const dir = randomUnit();
      const speed = 5 + Math.random() * 14 * p;
      this._spawn(
        position.x, position.y, position.z,
        i % 3 === 0 ? white : ice,
        {
          vx: dir.x * speed, vy: dir.y * speed * 0.6, vz: dir.z * speed,
          life: 0.22 + Math.random() * 0.28,
          drag: 0.86,
          gravity: 0.2
        }
      );
    }

    // 2. Flat shockwave ring — force spreading across the arena plane.
    this.ring(position, {
      color: 0xffffff,
      from: 0.5,
      to: 5 + 13 * p,
      duration: 0.3 + 0.2 * p,
      tilt: false
    });

    // 3. Debris along the separation axis, so the hit has a visible direction.
    if (normalX || normalZ) {
      for (let i = 0; i < this._scaledCount(4 + 8 * p); i++) {
        const flip = i % 2 === 0 ? 1 : -1;
        const spread = (Math.random() - 0.5) * 0.8;
        const speed = 5 + Math.random() * 11 * p;
        this._spawn(
          position.x, position.y, position.z, ice,
          {
            vx: (normalX + spread) * flip * speed,
            vy: (Math.random() - 0.2) * 3,
            vz: (normalZ - spread) * flip * speed,
            life: 0.4 + Math.random() * 0.3,
            drag: 0.9,
            gravity: 0.3
          }
        );
      }
    }

    // 4. Shake only on real hits, so the screen isn't permanently vibrating.
    if (p > 0.45) this.addTrauma(0.15 + p * 0.4);
  }


  /** Camera shake by name — alias so callers don't have to know about trauma. */
  shake(amount) {
    this.addTrauma(amount);
  }

  addTrauma(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * ARENA NUKE — the visual read of the 100-coin power. Damage and the
   * freeze live in main.js; this is only the blast: three rings racing past
   * the walls so no corner of the tank is spared, max camera shake, and a
   * recoil on every fish still standing (owner included — nobody is exempt
   * from the shake of their own bomb).
   */
  nuke(position, fishList) {
    const reach = ARENA.halfSize * 2.1;   // past the diagonal — no corner spared
    this.ring(position, { color: 0xff2a2a, from: 1, to: reach, duration: 2.0, tilt: false });
    this.ring(position, { color: 0xffb03a, from: 1, to: reach * 0.8, duration: 1.6, tilt: false });
    this.ring(position, { color: 0xffffff, from: 1, to: reach * 0.5, duration: 1.2, tilt: false });
    this.addTrauma(3.0);

    for (const fish of fishList) {
      if (fish.dead) continue;
      fish.recoil(1.0);
    }
  }

  // --------------------------------------------------------------- update --

  update(dt) {
    this._updateParticles(dt);
    this._updateRings(dt);

    for (let i = this.flashEffects.length - 1; i >= 0; i--) {
      const fx = this.flashEffects[i];
      fx.life -= dt;

      if (fx.type === 'material') {
        if (fx.life <= 0) {
          fx.materials.forEach(({ material, emissive, emissiveIntensity }) => {
            material.emissive.copy(emissive);
            material.emissiveIntensity = emissiveIntensity;
          });
          this.flashEffects.splice(i, 1);
        }
      } else if (fx.type === 'light') {
        const t = Math.max(0, fx.life / fx.maxLife);
        fx.light.intensity = fx.maxIntensity * t;
        if (fx.life <= 0) {
          fx.light.parent?.remove(fx.light);
          fx.light.dispose?.();
          this.flashEffects.splice(i, 1);
        }
      }
    }

    // Trauma decays linearly; the actual offset uses trauma² so small residual
    // shake is invisible and big hits punch.
    this.trauma = Math.max(0, this.trauma - dt * 1.1);
    const s = this.trauma * this.trauma * 1.4;
    this.shakeOffset.set(
      (Math.random() - 0.5) * s,
      (Math.random() - 0.5) * s,
      (Math.random() - 0.5) * s
    );
  }

  _updateParticles(dt) {
    const pos = this.pGeo.attributes.position.array;
    const col = this.pGeo.attributes.color.array;
    let touched = false;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      touched = true;

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false;
        pos[i * 3 + 1] = -9999;
        continue;
      }

      p.vy += p.gravity * dt;
      const damp = Math.pow(p.drag, dt * 60);
      p.vx *= damp; p.vy *= damp; p.vz *= damp;

      pos[i * 3] += p.vx * dt;
      pos[i * 3 + 1] += p.vy * dt;
      pos[i * 3 + 2] += p.vz * dt;

      // Fade by darkening the vertex color (cheaper than a per-particle alpha
      // attribute, and reads correctly against the dark water).
      const fade = 1 - p.life / p.maxLife;
      col[i * 3] *= 1 - (1 - fade) * dt * 0.9;
      col[i * 3 + 1] *= 1 - (1 - fade) * dt * 0.9;
      col[i * 3 + 2] *= 1 - (1 - fade) * dt * 0.9;
    }

    if (touched) {
      this.pGeo.attributes.position.needsUpdate = true;
      this.pGeo.attributes.color.needsUpdate = true;
    }
  }

  _updateRings(dt) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = Math.min(1, r.t / r.duration);
      const eased = 1 - Math.pow(1 - k, 3);   // ease-out cubic

      if (r.isSpike) {
        r.group.scale.setScalar(r.from + (r.to - r.from) * eased);
        r.mat.opacity = 1 - k;
        if (k >= 1) {
          this.scene.remove(r.group);
          // Dispose the MATERIAL only. `this.spikeGeo` is shared by every spike
          // ever created — disposing it here freed the GPU buffer while later
          // bursts still referenced it, and the corrupted draw showed up as a
          // huge garbled mesh that looked like a giant fish. Never dispose
          // geometry you did not allocate for this instance.
          r.mat.dispose();
          this.rings.splice(i, 1);
        }
        continue;
      }

      r.mesh.scale.setScalar(r.from + (r.to - r.from) * eased);
      r.mesh.material.opacity = 0.9 * (1 - k);
      if (k >= 1) {
        this.scene.remove(r.mesh);
        r.mesh.visible = false;
        this.ringPool.push(r.mesh);
        this.rings.splice(i, 1);
      }
    }
  }
}

function randomUnit() {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return { x: Math.cos(a) * r, y: z, z: Math.sin(a) * r };
}

/**
 * A four-pointed shuriken: sharp outer points, concave between them, with a
 * hole in the middle. Extruded thin and bevelled so it catches the light as it
 * spins, which is most of what makes the spin visible at all.
 */
function buildShuriken() {
  const shape = new THREE.Shape();
  const points = 4;
  const outer = 1.0;
  const inner = 0.32;

  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();

  // Centre hole, the detail that makes it unmistakably a throwing star.
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.15, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.09,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize: 0.035,
    bevelSegments: 1,
    curveSegments: 6
  });
  geo.center();
  // Lie flat on the XZ plane so it spins like a thrown star, not a coin.
  geo.rotateX(Math.PI / 2);
  return geo;
}
