/**
 * config.js — every tunable number in one place.
 *
 * LEVEL_BANDS mirrors server/rules.js. The server owns HP; this copy exists so
 * the renderer can resolve a model + scale without waiting on the socket.
 */

export const LEVEL_BANDS = [
  { level: 1, min: 100, max: 499, model: 'hsw_porbeagle.glb', species: 'Porbeagle', tint: 0x6f8fa6 },
  { level: 2, min: 500, max: 999, model: 'hsw_smooth_hammerhead_shark.glb', species: 'Smooth Hammerhead', tint: 0x7d9bb0 },
  { level: 3, min: 1000, max: 1499, model: 'hsw_great_hammerhead_shark.glb', species: 'Great Hammerhead', tint: 0x8aa8b8 },
  { level: 4, min: 1500, max: 1999, model: 'hsw_great_white_shark.glb', species: 'Great White', tint: 0xa8b8bd },
  { level: 5, min: 2000, max: 2499, model: 'hsw_the_frenzy.glb', species: 'The Frenzy', tint: 0xc25a4a },
  { level: 6, min: 2500, max: 2999, model: 'hsw_whale_shark.glb', species: 'Whale Shark', tint: 0x4a6d8c },
  { level: 7, min: 3000, max: 3499, model: 'hsw_blue_whale.glb', species: 'Blue Whale', tint: 0x35597f },
  { level: 8, min: 3500, max: 3999, model: 'hsw_zombie_shark.glb', species: 'Zombie Shark', tint: 0x6f8f4a },
  { level: 9, min: 4000, max: 4999, model: 'hsw_robo_shark.glb', species: 'Robo Shark', tint: 0x9aa7b5 },
  { level: 10, min: 5000, max: 10000, model: 'hsw_mr_snappy.glb', species: 'Mr. Snappy', tint: 0xd8452f }
];

export const HP_CEILING = 10000;
export const TITAN_HP = 5000;

/**
 * Ocean volume the fish are confined to. Y is negative (below the surface).
 *
 * This is a wide, shallow SLAB, not a cylinder — that is the whole trick behind
 * the Hungry Shark look. The camera sits off to one side looking straight down
 * -Z, so play happens across X (left/right) and Y (up/down), while `depth` gives
 * just enough Z wiggle for fish to pass in front of and behind each other. Make
 * `depth` large and the illusion collapses into a soup of fish at random sizes;
 * make it 0 and everything looks flat and papery. 22 is the sweet spot.
 */
export const ARENA = {
  /**
   * Square battle tank, Beyblade-stadium style.
   *
   * Play happens on the horizontal X/Z plane — fish are balls in a box, seen
   * from above at an angle. Y is only used for gentle vertical drift so the
   * tank reads as water rather than a board game. The whole arena is on screen
   * at once, which is the point: a viewer should never wonder where the action
   * is.
   */
  halfSize: 100,       // wall distance from centre, X and Z

  /**
   * Swim band. Deliberately thin and well clear of the floor.
   *
   * Fish were visually sinking into the seabed because the gap between `floor`
   * and `tankDepth` was only 8 units while a Titan's radius is ~5. Twenty units
   * of clearance means even the largest body stays entirely in open water.
   */
  floor: -24,          // lowest a fish may swim
  ceiling: -8,         // highest a fish may swim
  waterTop: -2,        // visible water surface
  tankDepth: -44       // tank floor, safely below the play band
};

export const COMBAT = {
  /** Non-titans: attacker needs 25% more HP than the target. */
  advantageRatio: 1.25,
  /** Titans (5000+): a flat HP gap is enough. */
  titanFlatGap: 500,
  /** Seconds between bites. */
  attackCooldown: 1.5,
  /** Bite damage as a fraction of the attacker's max HP. */
  damageFraction: 0.10,

  /**
   * Base damage per collision, before mass weighting.
   *
   * Tuned so a fight between near-equals takes a satisfying number of hits
   * rather than resolving instantly. Raise it for a faster, bloodier arena.
   */
  impactDamage: 42,
  /** How long a fish commits to one target before re-scanning. */
  lockDuration: 7,
  /**
   * Give up a chase we aren't winning after this many seconds out of biting
   * range. Without it a slower fish tails a faster one forever, which is the
   * "swimming behind someone's tail" look — nothing happens and it reads as a
   * bug rather than a hunt.
   */
  pursuitPatience: 4.5,
  /** Wander for at least this long after breaking off before hunting again. */
  huntCooldown: 1.6,
  /** Multiplier on combined body length that counts as "in biting range". */
  biteRangeFactor: 1.15,
  /** Fish farther away than this are never considered as targets. */
  maxHuntRange: 90,
  /**
   * Grace period after joining, in seconds.
   *
   * Without it a fresh 100 HP fish is legal prey for literally everyone and
   * dies in two bites — a viewer sends their first rose and watches their
   * shark vanish before they can read their own name. Newcomers are untargetable
   * and immune for this long, which is enough to swim clear and get noticed.
   */
  spawnProtection: 8,
  /** Immunity after an evolution or level-down, so nobody gets chain-killed mid-morph. */
  morphProtection: 1.2
};

/**
 * Ball physics. This is the heart of the arena mode.
 *
 * Fish move ballistically at a near-constant speed, reflect off the four walls,
 * and bounce off each other. There is no hunting AI at all — collisions ARE the
 * combat. That single change fixes the fairness problem the hunting model had:
 * every impact damages BOTH fish, so no fight is ever a one-sided execution,
 * and the randomness in each bounce means the same matchup never plays out the
 * same way twice.
 */
export const PHYSICS = {
  /**
   * Cruise speed. Individual fish vary around this by ±20%.
   *
   * Raised from 19 to 34. In a 144-unit tank the old speed meant a fish took
   * ~8 seconds to cross the arena, which reads as drifting, not battling.
   * At 34 a crossing takes ~4s and collisions roughly double in frequency —
   * the arena feels like a fight instead of an aquarium.
   */
  baseSpeed: 46,
  /** Big fish are slower, but only mildly — see the note on minSpeedFactor. */
  minSpeedFactor: 0.72,
  /** Speed is nudged back toward cruise at this rate after impacts. */
  speedRecovery: 1.6,
  /** Hard ceiling so a chain of bounces can't fling anyone across the tank. */
  maxSpeed: 96,

  /**
   * Randomness injected into every bounce, in radians.
   *
   * Without this, fish settle into perfectly periodic paths within a few
   * seconds — a billiard table with no friction is completely predictable, and
   * predictable is boring. A small random yaw on each impact keeps the arena
   * churning forever.
   */
  wallSpin: 0.28,
  fishSpin: 0.45,

  /** Restitution. >1 means impacts add energy, keeping the arena lively. */
  wallBounce: 1.0,
  fishBounce: 1.08,

  /** Speed kick given to both fish on impact, so collisions feel like hits. */
  impactKick: 8.5,

  /** Vertical drift: slow, decorative, never affects combat. */
  driftAmplitude: 2.2,
  driftSpeed: 0.5,

  /** Minimum gap between collisions with the SAME fish, seconds. */
  collisionCooldown: 0.55
};

export const MOVEMENT = {
  baseSpeed: 8.5,
  /**
   * Bigger fish are slower, but never below this fraction of base speed.
   *
   * This was 0.55 and it silently broke the whole game. Legal prey is always
   * WEAKER, therefore always SMALLER, therefore always FASTER — so a hunter had
   * a 1.01x speed advantage over its own target and could never close. Fish
   * tailed each other for the full lock duration and no bite ever landed. The
   * penalty is now mild enough that a predator genuinely runs its prey down.
   */
  minSpeedFactor: 0.78,
  /** Speed multiplier while locked onto prey. Must overcome the size penalty. */
  chaseSpeedFactor: 1.75,
  turnRate: 1.9,          // radians/sec ceiling on heading change
  bankAmount: 0.9,        // how hard a fish rolls into a turn
  bobAmplitude: 0.22,
  bobFrequency: 1.6,

  /**
   * Personal space.
   *
   * The old build only pushed fish apart AFTER their meshes already overlapped,
   * which is why they swam glued together — a positional shove every frame with
   * nothing telling them to steer clear in the first place. Now there are two
   * layers: fish STEER away from neighbours inside `avoidRadius` (soft, looks
   * natural), and a hard positional correction inside `separationRadius` only
   * ever runs as a last resort. Raise avoidRadius if the shoal still feels tight.
   */
  avoidRadius: 6.2,       // × combined body length — the "give them room" zone
  avoidForce: 1.8,        // how hard avoidance overrides the desired heading
  separationRadius: 1.35, // × combined body length — hard no-overlap zone
  separationForce: 3.2,

  /**
   * Separation distance for a hunter and its prey specifically.
   *
   * MUST be smaller than COMBAT.biteRangeFactor (1.15) or combat cannot happen
   * at all. The normal 1.35 radius holds fish further apart than a bite can
   * reach, so the separation pass was shoving attackers out of range one frame
   * before they could bite — the arena looked busy and nobody ever took damage.
   * A subtle bug: everything appeared to work, the numbers just never moved.
   */
  combatSeparationRadius: 0.8,

  /**
   * Pull back toward the z=0 plane. Without this fish drift to the depth walls
   * and pile up on them; with it they weave through the slab and cross in front
   * of each other, which is what sells the depth.
   */
  depthPull: 0.35,

  /**
   * Unprompted darts. Every fish periodically flicks its tail and accelerates
   * for a fraction of a second, then glides again. This single addition does
   * more for "these fish are alive" than any amount of animation blending,
   * because constant-velocity motion is the thing that reads as dead.
   */
  /** Cap on interception lead, in seconds. Too high and fish aim at empty water. */
  maxLeadTime: 1.1,

  burstInterval: [3, 11],   // seconds between darts, randomised per fish
  burstSpeedFactor: 1.9,

  wanderChangeInterval: [2.5, 6]
};

export const POWERS = {
  /**
   * NITRO BOOST — the Chilli Pepper gift specifically (1 coin), not every
   * 1-coin gift. Must be VISIBLE, not just faster.
   *
   * The fish itself glows cyan (emissive material + its own point light) and
   * drags a water-jet trail behind it (fish.js _updatePowers -> jetTrail),
   * so a viewer can see who boosted from across the arena. This was
   * previously a built power (`turbo`) with nothing wired to trigger it.
   * Gift-name matching (Chilli Pepper vs. Rose/TikTok/Ice Cream/etc., all
   * still plain HP) lives server-side in rules.js's nitroPowerFor() — this
   * file only defines what the power DOES once granted, never which gift
   * grants it, same as every other power here.
   */
  turbo: {
    duration: 12,
    /** 2.5x cruise speed — was 5.0 when this was an unused, untuned power. */
    speedMultiplier: 2.5,
    glowColor: 0x63e8ff,
    glowIntensity: 4.0,
    label: 'NITRO BOOST'
  },

  /**
   * SPIKES — real blades that live in the arena.
   *
   * Previously this flashed for half a second and vanished, which is why it was
   * impossible to tell what it even did. Now it throws physical blades that
   * bounce off the walls exactly like fish do and stay dangerous for ten
   * seconds. The arena becomes a hazard zone, and viewers can track each blade
   * and watch who it's about to hit — a moment they can anticipate rather than
   * one they merely glimpse.
   */
  spikes: {
    count: 4,
    damage: 180,
    lifetime: 8,
    speed: 55,
    radius: 0.8,          // shuriken size AND its collision radius
    hitCooldown: 0.8,     // per blade, per fish
    /**
     * Per-fish rate limit across ALL blades.
     *
     * Without this, ten blades converging on one fish deal 450 damage in a
     * single frame and a Spike Burst becomes an instant execution. Capping it
     * to one blade hit per 0.35s means a fish caught in the storm takes real,
     * mounting damage — around 1,200 over the full ten seconds if it never
     * escapes — but always has time to be knocked clear first.
     */
    fishHitCooldown: 0.5,
    color: 0xffe066,
    label: 'SHURIKEN STORM'
  },

  /**
   * SHOCKWAVE — a ten-second force field, not one pulse.
   *
   * A single wave was over before anyone registered it. Instead the fish emits
   * a pulse every 1.5s for ten seconds — about seven waves — and each one
   * shoves nearby fish HARD outward. For those ten seconds nobody can stay near
   * it, which reads clearly on camera as a zone of control.
   */
  shockwave: {
    duration: 10,
    interval: 1.5,
    damagePerWave: 60,
    radius: 46,
    push: 58,             // outward velocity added to caught fish
    stun: 0.8,
    trauma: 0.55,
    label: 'BASS SHOCKWAVE'
  },

  /**
   * SHRAPNEL NOVA — replaces the old Absolute Shield gift (30 coins).
   *
   * Every fish stays 100% vulnerable at all times now, so this grants no
   * invulnerability: it's a single instant 360° blast, not a sustained buff.
   * Sits between Bass Shockwave (one wave: 60 dmg) and Death Rotor in raw
   * power — big enough to matter, resolved in one frame rather than a
   * held-down field.
   */
  shrapnel: {
    damage: 260,
    radius: 40,
    push: 34,
    stun: 0.4,
    color: 0xff5a1f,
    label: 'SHRAPNEL NOVA'
  },

  /**
   * ROTOR BLADE STORM — 20 coins. Replaces Bass Shockwave in this tier's
   * gift mapping (shockwave's own code is left intact, just unbound).
   *
   * Back to a sustained field (the single-instant-burst version lasted one
   * revision): the 4 blades (effects.js spawnRotorBlades) spin continuously
   * for the full `duration` (15s), and a periodic AoE tick (main.js case
   * 'rotor', on a _schedule loop, not a one-shot) checks the same radius
   * every `tickInterval` seconds — any fish in range takes damageMin-
   * damageMax on EVERY tick it stays there, not just once. bladeCount:4
   * fans the blades at 0/90/180/270 — a symmetric cross.
   *
   * duration/tickInterval give 60 ticks over 15s (15/0.25) — a continuous
   * buzzsaw/meat-grinder stream rather than a slow pulse. At 30-35/tick
   * that's ~130-140 DPS, up to ~1950 HP total for a fish that never leaves
   * range the whole duration — well above Water Ripple's ~180 total and
   * Bullet Storm's 350, from the same 20-coin tier that used to be Bass
   * Shockwave's 360. Flagging it the way every other power redesign this
   * session has been: this is now the single hardest-hitting sustained
   * power in the game if a fish gets stuck in it. radius (80, raised from
   * 55 — now closer to Water Ripple's 92 than a "mid-range" AoE) is used
   * for both the damage hit-test AND the blade length, so the visible
   * blade tips are exactly where the hitbox ends — the hit-check needs no
   * separate adjustment to "reach the edges," since it was never anything
   * but this same radius value to begin with.
   *
   * Matte, non-additive color on purpose (no glow layer, no point light) —
   * dialed back after an earlier glowing-halo version read as visual noise
   * rather than a clean, high-contrast mechanical object.
   */
  rotor: {
    duration: 15,
    /** 15 / 0.25 = 60 ticks, evenly spaced across the full duration —
     *  4 hits/sec for a continuous slicing feel rather than a slow pulse. */
    tickInterval: 0.25,
    /** Per-tick damage is randomized in this range, not fixed. Lowered from
     *  30-35 now that the caster is shielded and every fish caught in the
     *  field is exposed to the full 60-tick stream — at 12-15/tick that's
     *  ~54 DPS, up to ~810 HP over the full 15s, versus ~1950 at the
     *  previous rate. Still the field to avoid; no longer instantly lethal
     *  to anything that wanders in. */
    damageMin: 12,
    damageMax: 15,
    /** Damage hit-test radius, world units — also the blade mesh length.
     *  Raised from 55; both the visual and the hitbox move together since
     *  they read from this same value. */
    radius: 80,
    /** Symmetric cross pattern: 0/90/180/270 degrees. */
    bladeCount: 4,
    /** Radians per second — fast enough to blur, slow enough to read. */
    spinSpeed: 18,
    /** Suction toward the caster on every tick a fish is in range, pulling
     *  it deeper into the blades so it keeps taking damage rather than
     *  drifting out after one hit — raised from 6 (the single-burst
     *  version's "barely noticeable" tuning) now that it has to matter
     *  across repeated ticks. Still well under a hard shove
     *  (POWERS.shockwave.push is 58). */
    pullForce: 10,
    /** Matte dark orange — MeshStandardMaterial, not additive-blended, so
     *  this is a real surface color under scene lighting, not a glow tint. */
    color: 0xd35400,
    /** Caster shield bubble color (fish.js _ensureShieldAura) — cyan so it
     *  reads as "protected", distinct from turbo's own glow color and from
     *  the blades' matte orange. */
    shieldColor: 0x3fd6ff,
    label: 'ROTOR BLADE STORM'
  },

  /**
   * HEAL BOOST — unbound. Was the 20-coin tier's temporary placeholder;
   * that slot now holds Bouncing Logo Spheres (see POWERS.pinball,
   * server/rules.js GIFT_TABLE[20]). Own code (main.js case 'heal',
   * effects.js heal()) stays intact and available if it's needed again,
   * same as every other unbound power in this file.
   */
  heal: {
    /** Emerald green — reads as restorative, distinct from every damage
     *  power's color and from giftBurst()'s neutral gold. */
    color: 0x2ecc71,
    label: 'HEAL BOOST'
  },

  /**
   * BOUNCING LOGO SPHERES — 20 coins. Four physical spheres launched
   * outward from the caster, each with the caster's own TikTok avatar
   * mapped onto its surface (effects.js launchPinballOrbs/
   * _loadAvatarTexture) — a portrait, not a generic damage effect. They
   * bounce off the arena walls AND off fish with mirror-reflection physics
   * (same trick Shuriken Storm's blades use, effects.js updatePinballOrbs)
   * for the full `lifetime`, dealing damage and ricocheting on every fish
   * contact rather than vanishing on first hit like a bullet/missile does.
   *
   * Deliberately restrained visuals, per an explicit request: no emissive
   * glow, no additive blending, no continuous particle trail — solid
   * MeshStandardMaterial only, and impact FX reuse the same low-key
   * clash() every ordinary bite collision in the arena already uses,
   * rather than a dedicated glow burst. This is the plainest-looking power
   * in the game on purpose, so it stays cheap for TikTok Live Studio's
   * encoder to push out, not because restraint is the default elsewhere.
   *
   * hitCooldown/fishHitCooldown solve the exact same problem Shuriken
   * Storm's blade.hits/bladeImmunity solve: without a per-fish rate limit,
   * four orbs converging on one fish would multi-hit it every frame.
   * fishHitCooldown is the global cap across all four orbs; hitCooldown is
   * the per-orb-per-fish cap on top of that.
   */
  pinball: {
    count: 4,
    damage: 70,
    /** Orbs stay bouncing in the arena for the full 18s before expiring. */
    lifetime: 18,
    /** Raised again from 75 — a high-velocity ricochet. */
    speed: 115,
    /** Sphere radius AND its collision radius — there's no separate
     *  hitRadius field for this power (unlike bulletStorm's orbs); the
     *  fish-contact check in main.js _resolvePinballHits is literally
     *  `orb.radius + fish.radius`, so raising this one number scales the
     *  visual AND the hit detection together, automatically, by
     *  construction. Raised again from 3.2 for a giant, heavier presence —
     *  still no glow/spectacle (see the restraint note above), just
     *  physically much bigger. */
    radius: 5,
    /** Per-orb, per-fish cooldown before that SAME orb can hit that SAME fish again. */
    hitCooldown: 0.8,
    /** Global per-fish cooldown across ALL four orbs — see the block comment above. */
    fishHitCooldown: 0.5,
    /** Launch-moment ring accent only (effects.js launchPinballOrbs) — NOT
     *  the orb color itself. The orbs' own glossy-black fallback material
     *  is hardcoded in effects.js _initPinball (0x111111, same convention
     *  as the missile/blade colors below), since it never varies per cast
     *  the way this ring's color could. Kept a lighter steel-silver here on
     *  purpose so the launch ring reads clearly against both the water and
     *  the now-black orbs, rather than a dark ring vanishing into both. */
    color: 0xb8c0cc,
    label: 'BOUNCING LOGO SPHERES'
  },

  /**
   * GATLING BULLET STORM — 5 coins.
   *
   * A 15-second continuous machine-gun STREAM — `count` energy orbs fire
   * one at a time, `fireInterval` seconds apart (main.js _triggerPower).
   * Distinct spaced-out spheres (effects.js _initBullets), not a
   * continuous cylinder stream — see that file for why the shape alone
   * isn't what creates the spacing (speed * fireInterval is).
   *
   * Lead-shot targeting: each orb aims at the nearest living enemy's
   * PREDICTED position (current position + its velocity * time-to-impact),
   * not where it is right now — see effects.js spawnBullet. Direction is
   * still locked in at the moment of firing and never re-aimed in flight;
   * the fast fireInterval (375 shots/15s) is what keeps the stream as a
   * whole tracking a moving target even though no single orb curves to
   * follow it after launch.
   *
   * count * fireInterval = 15s and count * damage = 350 total volley HP IF
   * every orb connects, both exact by construction below (an explicit
   * request for a 15s "stream show" dealing exactly 350 HP total when fully
   * on-target). A fast-dodging target can still cause some to miss even
   * with lead prediction (it's a single-pass estimate, not a guarantee) —
   * accepted tradeoff of the straight-shot redesign, not a bug. 350 total
   * from a 5-coin gift is still well below the 100-coin Rotor Blade Storm's
   * up-to-~810 total (see POWERS.rotor) for a fish that stays in range the
   * whole 15s.
   */
  bulletStorm: {
    count: 375,
    damage: 350 / 375,
    /** Seconds between each shot. 375 * 0.04 = 15s exactly. */
    fireInterval: 0.04,
    /** Straight-line flight speed, world units/sec. Fast enough to cross
     *  the whole arena (halfSize 100, so up to ~283 corner-to-corner) well
     *  within `lifetime`, reading as an "instant" hit rather than a
     *  travelling projectile. Also the value lead-shot targeting divides
     *  distance by to get time-to-impact (effects.js spawnBullet). */
    speed: 150,
    /** Impact distance — plain world-space distance from the orb's tracked
     *  position (its center) to the target's world position, plus the
     *  target's own radius. Sized for the orb's actual radius (effects.js
     *  BULLET_RADIUS = 2.3, raised for mobile-stream visibility) plus a
     *  buffer, so a hit registers close to when the orb visibly touches
     *  the fish. */
    hitRadius: 2.8,
    /** How far an orb will look for a target, at the moment it's fired, before giving up and firing on the caster's own facing instead. */
    acquireRadius: 120,
    /** Safety expiry — 283 (arena corner-to-corner) / 150 speed ≈ 1.9s, so
     *  2.2 guarantees a full-arena shot lands or expires cleanly either way. */
    lifetime: 2.2,
    /** Impact spark color (Effects.spark) — a dark, muted red-brown so a
     *  hit still reads as a heavier "explosive" pop distinct from the
     *  orbs' own bright fiery orange (effects.js _initBullets), rather
     *  than just a slightly different shade of the same orange. */
    color: 0xa61a00,
    label: 'GATLING BULLET STORM'
  },

  /**
   * WATER RIPPLE SHOCKWAVE — 10 coins (Heart gift). Replaces the removed
   * Vampiric Life Drain in this tier's power slot.
   *
   * A single hue (aquatic cyan), not shockwave's alternating cyan/magenta —
   * this is meant to read as water, not a generic energy blast. No push, no
   * stun, unlike shockwave: this is a pure damage-over-time field, so the
   * two 10/20-coin powers don't end up feeling like the same effect twice.
   *
   * pulseInterval * (duration/pulseInterval floor) = 8 pulses across the
   * full 15s. damageMin/damageMax rolls its own damage per pulse.
   *
   * radius == visualRadius (92, ~most of ARENA.halfSize=100) — one cast
   * hits essentially every fish in the arena, 8 times over 15s. damageMin/
   * damageMax were lowered from 40-50 to 20-25 specifically to keep that
   * arena-wide breadth from also being lethal-fast: ~180 HP average total
   * per fish across the full duration now (was ~360) — survivable enough on
   * purpose, so viewers are encouraged to chain multiple Hearts rather than
   * one cast deciding the fight. Contrast with Bullet Storm (5 coins, single
   * target, ~350 total): this tier trades depth for breadth, not more of
   * both.
   */
  ripple: {
    duration: 15,
    /** 15 / 1.875 = 8 pulses, evenly spaced across the full duration. */
    pulseInterval: 1.875,
    /** Per-pulse damage is randomized in this range, not fixed. */
    damageMin: 20,
    damageMax: 25,
    /** Damage hit-test radius. Matches visualRadius exactly — see the block
     *  comment above for why that's a deliberate, flagged tradeoff. */
    radius: 92,
    /** How far the visible rings expand — most of the way to ARENA.halfSize
     *  (100), selling "toward the edges of the pool" as pure spectacle. */
    visualRadius: 92,
    color: 0x22e0ff,
    label: 'WATER RIPPLE SHOCKWAVE'
  },

  /**
   * HOMING MISSILE VOLLEY — 30 coins.
   *
   * Twelve independent missile meshes fan out and steer toward the nearest
   * living enemy each frame (Effects.updateMissiles), re-acquiring a new
   * target if theirs dies or goes out of range. Each one explodes in a
   * fire/smoke burst on impact or at end of life — never a shockwave ring
   * standing in for the hit.
   */
  missiles: {
    count: 12,
    damage: 140,
    speed: 46,
    /** How fast a missile can turn onto its target, per second. */
    turnRate: 3.0,
    lifetime: 4.5,
    explosionRadius: 12,
    /** How far a missile will look for a target before giving up. */
    acquireRadius: 100,
    push: 24,
    stun: 0.3,
    color: 0xff5a1f,
    label: 'HOMING MISSILE VOLLEY'
  },

  /**
   * 360 BEAM ROTOR — 100 coins.
   *
   * Physical rotating laser beams (Effects.spawnBeamRotor), not expanding
   * rings standing in for a weapon. Hit-testing is geometric: a fish is "in
   * the beam" only if it falls within `angularWidth` radians of a beam's live
   * world-space angle and inside `length` of the caster — a viewer can see
   * exactly why someone did or didn't get hit.
   */
  beamRotor: {
    duration: 12,
    beams: 4,
    length: 60,
    /** Radians per second. */
    spinSpeed: 2.4,
    tickInterval: 0.25,
    damagePerTick: 70,
    /** Half-width of "caught in the beam", radians. */
    angularWidth: 0.16,
    push: 40,
    stun: 0.5,
    color: 0xff2a6d,
    glowColor: 0xffffff,
    label: '360 BEAM ROTOR'
  }
};

/**
 * Angled overhead camera on the square arena.
 *
 * The whole tank stays in frame at all times — a viewer joining mid-stream
 * should read the situation in one second. Focus mode pushes in on one fish
 * without ever leaving the arena or changing which way the walls face.
 */
export const CAMERA = {
  fov: 50,

  /**
   * Angled overhead shot showing the entire tank at once.
   *
   * The whole arena fits in frame, always. A viewer joining mid-stream should
   * understand the situation in one second: here is the box, here are the fish,
   * that one is big. Chasing individual fish with a close camera made the
   * stream unreadable — you saw a lot of water and never the fight.
   */
  height: 122,         // how far above the water
  distance: 140,       // how far back along +Z
  lookAtY: -15,        // aim into the middle of the water column

  /** Slow orbital drift so the shot isn't a static security-camera feed. */
  driftRange: 0.22,    // radians
  driftSpeed: 0.06,

  /** Focus mode: push in toward one fish without ever losing the tank. */
  focusHeight: 58,
  focusDistance: 50,
  focusLerp: 1.8,

  moveLerp: 2.0,
  lookLerp: 2.6,
  zoomLerp: 1.6,

  minY: -30,
  maxY: 140
};

export const RENDER = {
  /**
   * Deep, saturated, still high-contrast water — NOT near-black.
   *
   * The original palette here was near-black with heavy fog — moody, and
   * completely wrong for the format: on a phone screen, in daylight, next to
   * a scrolling comment feed, dark and murky reads as "broken video". That's
   * why it was shifted bright/tropical in the first place. This later pass
   * asked for a "rich, dark deep-sea blue" background — moved partway there
   * (a deeper, more saturated navy-teal, explicitly NOT the near-black
   * #030f1e that was requested) specifically to keep that phone/daylight
   * legibility intact while still giving fish and power effects more
   * contrast to pop against than the original bright tropical blue did.
   * Fog density stays low (down 5x from the original near-black tuning) so
   * the far wall stays crisp.
   */
  fogColor: 0x125a87,
  fogDensity: 0.0026,
  deepColor: 0x0d3f66,
  surfaceColor: 0x7fe4ff,
  sunColor: 0xffffff,
  maxPixelRatio: 2,
  planktonCount: 900,
  bubbleCount: 260,
  godRayCount: 7,

  /**
   * Past this many active fish, particle bursts (effects.js Effects.setActivity)
   * and bloom strength (main.js _frame) both taper off. Every bite/gift still
   * fires its own burst regardless of fish count, so a crowded fight stacks
   * dozens of them on screen at once — clarity, not the fixed particle pool
   * size, is the actual limit being protected here.
   */
  clutterFishThreshold: 15,
  clutterParticleFloor: 0.35,
  clutterParticleFalloffPerFish: 0.045,
  clutterBloomFloor: 0.55,
  clutterBloomFalloffPerFish: 0.02
};

/** Model files live here. Missing files fall back to a procedural shark. */
export const MODEL_PATH = 'models/';

/**
 * Extra yaw applied to every model, in radians.
 *
 * glTF models are authored facing -Z, but Object3D.lookAt() points a mesh's +Z
 * at its target, so the loader rotates each body by PI. If your .glb files were
 * exported facing a different axis and the sharks swim backwards or sideways,
 * change this one number: Math.PI/2 or -Math.PI/2 covers the usual cases.
 *
 * Set to Math.PI because that is what the O-key tool reported for the shipped
 * models. If yours face a different way, press O in the browser, then paste the
 * value it prints here so it survives a reload.
 */
export const MODEL_YAW_OFFSET = Math.PI;

/**
 * Live-tunable copy of the above.
 *
 * Finding the right yaw by editing a file, saving, and reloading is miserable —
 * you have to wait for ten models to load each time. Press **O** in the browser
 * to cycle 0° / 90° / 180° / 270° and watch the fish turn immediately. When they
 * swim nose-first, the console prints the value to paste into MODEL_YAW_OFFSET
 * so it sticks across reloads.
 */
export const runtime = {
  yawOffset: MODEL_YAW_OFFSET
};

// ------------------------------------------------------------------- maths --

export function levelForHP(hp) {
  for (let i = LEVEL_BANDS.length - 1; i >= 0; i--) {
    if (hp >= LEVEL_BANDS[i].min) return LEVEL_BANDS[i].level;
  }
  return 1;
}

export function bandFor(level) {
  return LEVEL_BANDS[Math.min(Math.max(level | 0, 1), 10) - 1];
}

export function maxHPForLevel(level) {
  return bandFor(level).max;
}

/**
 * Body scale from HP.
 *
 * The GDD asks for "+0.15x per 100 HP, logarithmically". Taken literally and
 * linearly a 10,000 HP titan would be 15x the size of a minnow and would not
 * fit in the arena. Logarithmic growth keeps the same feel — every gift visibly
 * grows you — while topping out around 2.2x, which reads as enormous on camera
 * without breaking collision or framing.
 */
export function scaleForHP(hp) {
  const clamped = Math.max(100, Math.min(SCALE_HP_CEILING, hp));
  // Start genuinely small and grow hard. The old curve ran 1.15 -> 2.0, barely
  // a 70% difference across the entire game, so a 10,000 HP fish looked almost
  // identical to a 100 HP one. Growth has to be FELT or evolution means nothing.
  // 0.64 doubles the size of a 10,000 HP fish compared to the old curve, which
  // is what a viewer at that level expects to see for what they've spent, and
  // keeps growing to SCALE_HP_CEILING rather than flattening early.
  const raw = MIN_FISH_SCALE + 0.64 * Math.log2(1 + clamped / 100);
  // Hard cap. In a fixed square tank an unbounded Titan swallows the frame and
  // you can no longer see the fight — the arena has to stay readable more than
  // a big spender has to feel enormous. Growth still shows: 1.15x at Level 1 up
  // to the cap, it just stops runaway scaling.
  return Math.min(raw, MAX_FISH_SCALE);
}

/** Smallest a fish renders — new arrivals are properly tiny. */
/** Smallest a fish renders. */
export const MIN_FISH_SCALE = 0.55;

/**
 * HP at which the size curve stops growing.
 *
 * Separate from HP_CEILING (which now only bounds nothing, since HP is
 * uncapped). Growth keeps paying off all the way to 50,000 — a viewer who has
 * spent enough to pass 10,000 should still see their fish get bigger, or the
 * spending stops meaning anything visually.
 */
export const SCALE_HP_CEILING = 50000;

/**
 * Largest a fish may ever render.
 *
 * 3.4x the starting size. Big enough that a Titan dominates the tank and the
 * chat can see it coming, small enough that the arena stays readable when two
 * of them meet.
 */
export const MAX_FISH_SCALE = 6.0;

/** Can `attacker` legally bite `target`? */
export function canAttack(attackerHP, targetHP) {
  const titanFight = attackerHP >= TITAN_HP || targetHP >= TITAN_HP;
  if (titanFight) return attackerHP - targetHP >= COMBAT.titanFlatGap;
  return attackerHP >= targetHP * COMBAT.advantageRatio;
}
