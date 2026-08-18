/**
 * rules.js — AUTHORITATIVE game economy.
 *
 * The backend owns every rule that involves money (gift -> HP -> level).
 * The frontend owns combat simulation only. This split means a browser refresh,
 * a client crash, or a tampered console can never invent HP out of thin air.
 *
 * NOTE: public/js/config.js keeps a mirrored copy of LEVEL_BANDS purely so the
 * renderer can pick a model/scale without a round-trip. If you edit the bands
 * here, edit them there too. This file always wins on disputes.
 */

const GIFT_NAME_MAP = {
  'Rose': 1,
  'TikTok': 1,
  'Ice Cream': 1,
  'Chilli Pepper': 1,
  'Finger Heart': 5,
  'Heart': 10,
  'Perfume': 20,
  'Doughnut': 30,
  'Game Controller': 30,
  'Hand Heart': 100
};

/** HP bands per evolution level. `max` is also the level's "full health". */
const LEVEL_BANDS = [
  { level: 1, min: 100, max: 499, model: 'hsw_porbeagle.glb', name: 'Porbeagle' },
  { level: 2, min: 500, max: 999, model: 'hsw_smooth_hammerhead_shark.glb', name: 'Smooth Hammerhead' },
  { level: 3, min: 1000, max: 1499, model: 'hsw_great_hammerhead_shark.glb', name: 'Great Hammerhead' },
  { level: 4, min: 1500, max: 1999, model: 'hsw_great_white_shark.glb', name: 'Great White' },
  { level: 5, min: 2000, max: 2499, model: 'hsw_the_frenzy.glb', name: 'The Frenzy' },
  { level: 6, min: 2500, max: 2999, model: 'hsw_whale_shark.glb', name: 'Whale Shark' },
  { level: 7, min: 3000, max: 3499, model: 'hsw_blue_whale.glb', name: 'Blue Whale' },
  { level: 8, min: 3500, max: 3999, model: 'hsw_zombie_shark.glb', name: 'Zombie Shark' },
  { level: 9, min: 4000, max: 4999, model: 'hsw_robo_shark.glb', name: 'Robo Shark' },
  { level: 10, min: 5000, max: 10000, model: 'hsw_mr_snappy.glb', name: 'Mr. Snappy' }
];

const HP_CEILING = 10000;
const SPAWN_HP_MIN = 1000;
const SPAWN_HP_MAX = 2000;
const SPAWN_HP = SPAWN_HP_MIN;

/**
 * Gift table keyed by coin value.
 */
const GIFT_TABLE = {
  // power: null here on purpose — Rose/TikTok/Ice Cream and every other
  // generic 1-coin gift stay HP-only. Nitro is gated by gift NAME, not coin
  // value, so it doesn't hijack every cheap gift in the game — see
  // resolveGift's nitroPowerFor() override below.
  1: { hp: 25, power: null, label: 'Rose' },
  5: { hp: 125, power: 'bulletStorm', label: 'Gatling Bullet Storm' },
  // drain (Vampiric Life Drain) was removed entirely; this tier's slot now
  // holds Water Ripple Shockwave instead.
  10: { hp: 250, power: 'ripple', label: 'Water Ripple Shockwave' },
  // Heal Boost's own code stays available (main.js case 'heal', effects.js
  // heal()) if it's needed again, same as every other unbound power below —
  // this slot now holds Bouncing Logo Spheres instead. hp restored to 700
  // (the pre-Heal-Boost value for this tier): pinball is a normal damage/
  // chaos power like every other bound tier, not a heal, so its `hp` goes
  // back to being the tier's plain economy grant rather than doubling as
  // the power's own effect size.
  20: { hp: 700, power: 'pinball', label: 'Bouncing Logo Spheres' },
  // Homing Missile Volley's own code stays available (main.js case
  // 'missiles', effects.js launchMissiles/updateMissiles) if it's needed
  // again — this tier is deliberately unbound for now, same pattern as
  // every other retired tier mapping above.
  30: { hp: 1050, power: null, label: 'Game Controller' },
  // Replaces beamRotor (360 Beam Rotor) in this tier's gift mapping.
  // floorHP stays — it guarantees the L10 threshold regardless of which
  // power the tier grants, not something beamRotor-specific.
  100: { hp: 4500, power: 'rotor', label: 'Rotor Blade Storm', floorHP: 5000 }
};

/** Coin tiers sorted descending — used to decompose odd gift values. */
const TIERS = Object.keys(GIFT_TABLE).map(Number).sort((a, b) => b - a);

/**
 * Nitro (turbo power) is bound to a SPECIFIC named gift — Chilli Pepper — not
 * to the whole 1-coin tier. Every other 1-coin gift (Rose, TikTok, Ice
 * Cream, ...) must fall through to GIFT_TABLE[1]'s plain HP-only power:
 * null, or a viewer sending a Rose would get a free speed boost that was
 * never meant to be that common.
 *
 * Matched by substring on the gift's display name rather than a numeric
 * TikTok gift ID: server.js's giftName resolution already has several
 * fallback layers (payload name -> GIFT_MAP lookup -> coin-value guess) and
 * the numeric ID space isn't available to this module, so name matching is
 * the one signal resolveGift can actually rely on. Covers both English
 * spellings ("chilli"/"chili") plus a plain "pepper" match.
 */
const NITRO_GIFT_NAME_PATTERN = /chilli|chili|pepper/i;

function nitroPowerFor(giftName) {
  return giftName && NITRO_GIFT_NAME_PATTERN.test(giftName) ? 'turbo' : null;
}

function levelForHP(hp) {
  for (let i = LEVEL_BANDS.length - 1; i >= 0; i--) {
    if (hp >= LEVEL_BANDS[i].min) return LEVEL_BANDS[i].level;
  }
  return 1;
}

function bandFor(level) {
  return LEVEL_BANDS[Math.min(Math.max(level, 1), 10) - 1];
}

function maxHPForLevel(level) {
  return bandFor(level).max;
}

/**
 * FIXED: Resolves arbitrary coin amount safely even if giftName is generic ("Gift")
 */
function resolveGift(coins, giftName) {
  let amount = Number(coins);
  if ((isNaN(amount) || amount <= 0) && giftName && GIFT_NAME_MAP[giftName] !== undefined) {
    amount = GIFT_NAME_MAP[giftName];
  }
  amount = Math.max(1, Math.floor(isNaN(amount) ? 1 : amount));
  const exact = GIFT_TABLE[amount];
  if (exact) {
    const power = amount === 1 ? nitroPowerFor(giftName) : exact.power;
    const label = amount === 1 && power === 'turbo' ? 'Nitro Boost' : exact.label;
    return { hp: exact.hp, power, label, floorHP: exact.floorHP || 0, coins: amount };
  }
  const tier = TIERS.find((t) => amount >= t);
  if (!tier) return { hp: amount * 25, power: null, label: 'Gift', floorHP: 0, coins: amount };
  const base = GIFT_TABLE[tier];
  const remainder = amount - tier;
  const power = tier === 1 ? nitroPowerFor(giftName) : base.power;
  const label = tier === 1 && power === 'turbo' ? 'Nitro Boost' : base.label;
  return { hp: base.hp + remainder * 25, power, label, floorHP: base.floorHP || 0, coins: amount };
}

/** Clamp + derive level. Single place where an HP number becomes a fish state. */
function normalize(fish) {
  fish.hp = Math.max(0, Math.round(fish.hp));
  fish.level = levelForHP(fish.hp);
  return fish;
}

module.exports = {
  LEVEL_BANDS,
  GIFT_TABLE,
  GIFT_NAME_MAP,
  HP_CEILING,
  SPAWN_HP,
  SPAWN_HP_MIN,
  SPAWN_HP_MAX,
  levelForHP,
  bandFor,
  maxHPForLevel,
  resolveGift,
  normalize
};