/**
 * ui.js — the broadcast overlay.
 *
 * Everything here is plain DOM sitting above the canvas. Three rules:
 *   1. Nothing in this file mutates game state; it reads and renders.
 *   2. Nameplates are pooled. Creating a div per fish per frame is the single
 *      fastest way to tank a stream.
 *   3. The leaderboard re-renders on a timer (5/sec), not every frame.
 */

import * as THREE from 'three';
import { bandFor, maxHPForLevel, LEVEL_BANDS } from './config.js';

/** How long a floating damage number lives, seconds. Matches the CSS. */
const POPUP_LIFE = 1.05;
/** Hard cap on simultaneous popups — a frenzy must not tank the framerate. */
const MAX_POPUPS = 34;

const _proj = new THREE.Vector3();

const LEADERBOARD_HZ = 5;
/**
 * Cull distance for nameplates.
 *
 * MUST exceed the camera's real distance to the far corner of the tank or the
 * entire HUD silently vanishes — which is exactly what happened when the arena
 * was widened: the camera moved to 153 units from centre and 221 from the far
 * corner, both past the old limit of 130, so every plate was culled and the
 * game rendered with no names, no HP and no avatars at all.
 *
 * 300 covers the corner with margin at any zoom level.
 */
const NAMEPLATE_MAX_DISTANCE = 420;

export class UI {
  constructor({ onSpectate, onResetRequest }) {
    this.onSpectate = onSpectate;
    this.onResetRequest = onResetRequest;

    this.el = {
      leaderboard: document.getElementById('leaderboard-rows'),
      nameplates: document.getElementById('nameplates'),
      popups: document.getElementById('popups'),
      leader: document.getElementById('leader'),
      leaderAvatar: document.getElementById('leader-avatar'),
      leaderName: document.getElementById('leader-name'),
      leaderHP: document.getElementById('leader-hp'),
      leaderLevel: document.getElementById('leader-level'),
      ticker: document.getElementById('ticker'),
      status: document.getElementById('status-strip'),
      spectating: document.getElementById('spectating'),
      spectatingName: document.getElementById('spectating-name'),
      exitSpectate: document.getElementById('exit-spectate'),
      admin: document.getElementById('admin'),
      adminToggle: document.getElementById('admin-toggle'),
      adminKey: document.getElementById('admin-key'),
      adminConfirm: document.getElementById('admin-confirm'),
      adminSubmit: document.getElementById('admin-submit'),
      adminCancel: document.getElementById('admin-cancel'),
      adminError: document.getElementById('admin-error'),
      loader: document.getElementById('loader'),
      loaderBar: document.getElementById('loader-bar'),
      loaderNote: document.getElementById('loader-note'),
      count: document.getElementById('fish-count'),
      nukeOverlay: document.getElementById('nuke-overlay'),
      nukeAvatar: document.getElementById('nuke-avatar'),
      nukeName: document.getElementById('nuke-name')
    };

    this.plates = new Map();      // username -> {root, avatar, name, hp}
    this.platePool = [];

    /** Floating damage numbers, pooled. */
    this.activePopups = [];
    this.popupPool = [];

    /** Leader banner cache, so we only touch the DOM on real changes. */
    this.leaderName = null;
    this.leaderHP = null;
    this.leaderLevel = null;
    this.leaderboardAccumulator = 0;
    this.lastRowSignature = '';

    this._wireSpectate();
    this._wireAdmin();
  }

  // ------------------------------------------------------------- loading ---

  setLoadProgress(fraction, note) {
    if (this.el.loaderBar) this.el.loaderBar.style.transform = `scaleX(${fraction})`;
    if (note && this.el.loaderNote) this.el.loaderNote.textContent = note;
  }

  hideLoader() {
    this.el.loader?.classList.add('is-hidden');
  }

  // --------------------------------------------------------- status strip ---

  setStatus({ mongo, tiktok, simulate }) {
    if (!this.el.status) return;
    const chips = [
      chip(mongo ? 'DB LINKED' : 'DB OFFLINE', mongo ? 'ok' : 'warn'),
      chip(
        simulate ? 'SIM FEED' : tiktok ? 'LIVE FEED' : 'NO FEED',
        simulate ? 'info' : tiktok ? 'ok' : 'warn'
      )
    ];
    this.el.status.innerHTML = chips.join('');
  }

  setFishCount(n, max) {
    if (this.el.count) this.el.count.textContent = `${n} / ${max}`;
  }

  // ---------------------------------------------------------- leaderboard ---

  updateLeaderboard(dt, fishList, spectatingUsername) {
    this.leaderboardAccumulator += dt;
    if (this.leaderboardAccumulator < 1 / LEADERBOARD_HZ) return;
    this.leaderboardAccumulator = 0;

    const top = [...fishList].sort((a, b) => b.hp - a.hp).slice(0, 5);

    // Skip the DOM write entirely if nothing visible changed.
    const signature = top.map((f) => `${f.username}:${Math.round(f.hp)}:${f.level}`).join('|') + `#${spectatingUsername}`;
    if (signature === this.lastRowSignature) return;
    this.lastRowSignature = signature;

    this.el.leaderboard.innerHTML = top.map((fish, i) => {
      const max = maxHPForLevel(fish.level);
      const within = Math.max(0, Math.min(1, fish.hp / max));
      const watching = fish.username === spectatingUsername;
      return `
        <li class="row ${watching ? 'is-watching' : ''} ${fish.level >= 10 ? 'is-titan' : ''}">
          <span class="row__rank">${i + 1}</span>
          <span class="row__depth" aria-hidden="true">${depthRail(fish.level)}</span>
          <span class="row__body">
            <span class="row__top">
              <span class="row__name" title="${escapeHtml(fish.nickname)}">${escapeHtml(fish.nickname)}</span>
              <span class="row__hp">${formatHP(fish.hp)}</span>
            </span>
            <span class="row__meta">L${fish.level} · ${bandFor(fish.level).species}</span>
            <span class="row__bar"><span class="row__fill" style="transform:scaleX(${within.toFixed(3)})"></span></span>
          </span>
          <button class="row__eye" data-spectate="${escapeHtml(fish.username)}" title="Watch ${escapeHtml(fish.nickname)}" aria-label="Watch ${escapeHtml(fish.nickname)}">
            ${watching ? EYE_ON : EYE_OFF}
          </button>
        </li>`;
    }).join('');
  }

  _wireSpectate() {
    // Delegated: rows are replaced wholesale, so per-button listeners would leak.
    this.el.leaderboard?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-spectate]');
      if (!btn) return;
      this.onSpectate(btn.dataset.spectate);
    });
    this.el.exitSpectate?.addEventListener('click', () => this.onSpectate(null));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.onSpectate(null);
    });
  }

  setSpectating(fish) {
    if (!this.el.spectating) return;
    if (fish) {
      this.el.spectating.classList.add('is-active');
      this.el.spectatingName.textContent = fish.nickname;
    } else {
      this.el.spectating.classList.remove('is-active');
    }
  }

  // ----------------------------------------------------------- nameplates ---

  /** Project every fish into screen space and park a pooled div on it. */
  updateNameplates(fishList, camera, size, dt = 1 / 60) {
    const seen = new Set();
    const projected = new THREE.Vector3();

    for (const fish of fishList) {
      seen.add(fish.username);

      // Sit the plate above the body, scaled with the fish.
      projected.copy(fish.root.position);
      projected.y += fish.bodyLength * 0.75 + 1.2;
      const distance = camera.position.distanceTo(fish.root.position);
      projected.project(camera);

      const offScreen =
        projected.z > 1 || projected.z < -1 ||
        projected.x < -1.3 || projected.x > 1.3 ||
        projected.y < -1.3 || projected.y > 1.3 ||
        distance > NAMEPLATE_MAX_DISTANCE;

      if (offScreen) {
        this._releasePlate(fish.username);
        continue;
      }

      const plate = this._acquirePlate(fish.username);
      const x = (projected.x * 0.5 + 0.5) * size.width;
      const y = (-projected.y * 0.5 + 0.5) * size.height;

      // Shrink with distance so a crowded arena stays readable.
      // Shrink with distance, but never below 0.75 — a plate the viewer can't
      // read is the same as no plate at all.
      const scale = THREE.MathUtils.clamp(1.7 - distance / NAMEPLATE_MAX_DISTANCE, 0.78, 1.3);
      plate.root.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(2)})`;
      plate.root.style.opacity = String(THREE.MathUtils.clamp(1.9 - distance / NAMEPLATE_MAX_DISTANCE, 0.65, 1));

      if (plate.lastName !== fish.nickname) {
        plate.name.textContent = fish.nickname;
        plate.lastName = fish.nickname;
      }

      // The gifter's own TikTok avatar. This is the single biggest thing for
      // engagement: a viewer scanning the tank looks for THEIR face, not a
      // username in 11px type.
      if (plate.lastAvatar !== fish.avatar) {
        if (fish.avatar) {
          plate.avatar.src = fish.avatar;
          plate.avatar.style.display = '';
        } else {
          plate.avatar.removeAttribute('src');
          plate.avatar.style.display = 'none';
        }
        plate.lastAvatar = fish.avatar;
      }

      /**
       * HP counts UP and DOWN like an odometer instead of snapping.
       *
       * A number that teleports from 8,340 to 7,900 is just a different number;
       * one that rolls down through the hundreds is an event you feel. This is
       * purely cosmetic — `fish.hp` is authoritative and already correct, this
       * only controls what the viewer sees on the way there.
       *
       * The chase is proportional, so big swings move fast and small ones
       * settle gently, and it always lands exactly on the true value.
       */
      if (plate.shownHP === null) {
        plate.shownHP = fish.hp;
      } else if (plate.shownHP !== fish.hp) {
        const diff = fish.hp - plate.shownHP;
        const step = Math.max(1, Math.abs(diff) * dt * 3.4);
        plate.shownHP = Math.abs(diff) <= step
          ? fish.hp
          : plate.shownHP + Math.sign(diff) * step;

        // Colour the number while it moves: green climbing, red falling.
        plate.root.dataset.trend = diff > 0 ? 'up' : 'down';
        plate.trendHold = 0.45;
      } else if (plate.trendHold > 0) {
        plate.trendHold -= dt;
        if (plate.trendHold <= 0) delete plate.root.dataset.trend;
      }

      const hpText = formatHP(plate.shownHP);
      if (plate.lastHP !== hpText) {
        plate.hp.textContent = hpText;
        plate.lastHP = hpText;
      }

      // Bar underneath the number: the number gives precision, the bar gives an
      // instant read of how close this fish is to dropping a level.
      const max = maxHPForLevel(fish.level);
      const ratio = THREE.MathUtils.clamp(fish.hp / Math.max(1, max), 0, 1);
      plate.fill.style.transform = `scaleX(${ratio.toFixed(3)})`;

      // State flags drive colour: rotor, spawn/morph grace, or titan.
      const state = fish.power.rotor > 0 ? 'rotor'
        : fish.invulnerable > 0 ? 'safe'
        : fish.level >= 10 ? 'titan'
        : '';
      if (plate.lastState !== state) {
        plate.root.dataset.state = state;
        plate.lastState = state;
      }

      // Visible combat timer: whichever sustained gift power is currently
      // running on this fish, counted down live so a viewer can see exactly
      // how much longer the turbo/rotor has left. Bullet Storm is a timed
      // stream, not a duration on the fish itself — it has no timer to show.
      const timer = fish.power.turbo > 0 ? { icon: '💨', t: fish.power.turbo }
        : fish.power.rotor > 0 ? { icon: '⚡', t: fish.power.rotor }
        : null;
      const timerText = timer ? `${timer.icon} ${Math.ceil(timer.t)}s` : '';
      if (plate.lastTimer !== timerText) {
        plate.timer.textContent = timerText;
        plate.timer.style.display = timerText ? 'inline-block' : 'none';
        plate.lastTimer = timerText;
      }
    }

    // Retire plates for fish that vanished this frame.
    for (const username of [...this.plates.keys()]) {
      if (!seen.has(username)) this._releasePlate(username);
    }
  }

  _acquirePlate(username) {
    let plate = this.plates.get(username);
    if (plate) return plate;

    plate = this.platePool.pop();
    if (!plate) {
      const root = document.createElement('div');
      root.className = 'plate';
      // Avatar on top, name under it, HP as one big number. No bar: a 7px
      // gauge is unreadable on a phone and tells a viewer nothing precise. A
      // number tells them exactly how close the kill is.
      root.innerHTML = `
        <img class="plate__avatar" alt="" referrerpolicy="no-referrer">
        <span class="plate__name"></span>
        <span class="plate__hp"></span>
        <span class="plate__bar"><i class="plate__fill"></i></span>
        <span class="plate__timer"></span>`;
      plate = {
        root,
        avatar: root.querySelector('.plate__avatar'),
        name: root.querySelector('.plate__name'),
        hp: root.querySelector('.plate__hp'),
        fill: root.querySelector('.plate__fill'),
        timer: root.querySelector('.plate__timer'),
        /** Displayed HP, which chases the real value. See the note below. */
        shownHP: null
      };
    }
    plate.lastName = null;
    plate.lastHP = null;
    plate.lastState = null;
    plate.lastAvatar = null;
    plate.lastTimer = null;
    plate.shownHP = null;
    plate.trendHold = 0;
    plate.root.style.display = '';
    this.el.nameplates.appendChild(plate.root);
    this.plates.set(username, plate);
    return plate;
  }

  _releasePlate(username) {
    const plate = this.plates.get(username);
    if (!plate) return;
    plate.root.style.display = 'none';
    plate.root.remove();
    this.plates.delete(username);
    this.platePool.push(plate);
  }

  // --------------------------------------------------------- damage popups ---

  /**
   * Floating combat text: "-240" rising off a fish that just got hit.
   *
   * This is the highest-value-per-line feature in the whole HUD. Without it a
   * collision is two models touching and a number quietly ticking down
   * somewhere; with it, every impact has a visible consequence and the viewer
   * instantly understands who is winning. It's why every arena game ever made
   * has floating damage numbers.
   *
   * Pooled and capped — at 6 collisions/sec with 40 fish, allocating a div per
   * hit would thrash the GC inside a minute.
   */
  spawnDamage(worldPos, amount, camera, size, kind = 'hit') {
    if (!this.el.popups) return;
    if (this.activePopups.length >= MAX_POPUPS) return;

    _proj.copy(worldPos);
    _proj.project(camera);
    if (_proj.z > 1 || _proj.z < -1) return;

    const x = (_proj.x * 0.5 + 0.5) * size.width;
    const y = (-_proj.y * 0.5 + 0.5) * size.height;

    const el = this.popupPool.pop() || document.createElement('div');
    el.className = `popup popup--${kind}`;
    el.textContent = kind === 'heal'
      ? `+${formatHP(amount)}`
      : `-${formatHP(amount)}`;

    // Scatter slightly so simultaneous hits don't stack into one blob.
    const jitter = (Math.random() * 2 - 1) * 22;
    el.style.left = `${(x + jitter).toFixed(0)}px`;
    el.style.top = `${y.toFixed(0)}px`;

    this.el.popups.appendChild(el);
    // Force a reflow so the CSS transition actually plays on a pooled node.
    void el.offsetWidth;
    el.classList.add('is-rising');

    this.activePopups.push({ el, life: POPUP_LIFE });
  }

  _updatePopups(dt) {
    for (let i = this.activePopups.length - 1; i >= 0; i--) {
      const p = this.activePopups[i];
      p.life -= dt;
      if (p.life > 0) continue;
      p.el.classList.remove('is-rising');
      p.el.remove();
      this.activePopups.splice(i, 1);
      if (this.popupPool.length < MAX_POPUPS) this.popupPool.push(p.el);
    }
  }

  // ---------------------------------------------------------- leader crown ---

  /**
   * The big decorated banner at the top of the screen showing who is winning.
   *
   * A leaderboard list is for the streamer; this is for the viewer. One face,
   * one number, impossible to miss — and it gives everyone a single target to
   * root for or against, which is the whole engine of a gifting stream.
   */
  updateLeader(fishList) {
    if (!this.el.leader) return;

    let best = null;
    for (const f of fishList) {
      if (f.dead) continue;
      if (!best || f.hp > best.hp) best = f;
    }

    if (!best) {
      this.el.leader.classList.remove('is-visible');
      this.leaderName = null;
      return;
    }

    this.el.leader.classList.add('is-visible');

    if (this.leaderName !== best.username) {
      // Flash on takeover — a lead change is the most exciting moment the game
      // produces and it used to pass completely unremarked.
      this.el.leader.classList.remove('is-new');
      void this.el.leader.offsetWidth;
      this.el.leader.classList.add('is-new');
      this.leaderName = best.username;

      this.el.leaderName.textContent = best.nickname;
      if (best.avatar) {
        this.el.leaderAvatar.src = best.avatar;
        this.el.leaderAvatar.style.display = '';
      } else {
        this.el.leaderAvatar.removeAttribute('src');
        this.el.leaderAvatar.style.display = 'none';
      }
    }

    const hpText = formatHP(best.hp);
    if (this.leaderHP !== hpText) {
      this.el.leaderHP.textContent = hpText;
      this.leaderHP = hpText;
    }
    const lvText = `LVL ${best.level}`;
    if (this.leaderLevel !== lvText) {
      this.el.leaderLevel.textContent = lvText;
      this.leaderLevel = lvText;
    }
  }

  // --------------------------------------------------------------- ticker ---

  /** Feed line. `tone` drives the accent colour. */
  announce(text, tone = 'info') {
    if (!this.el.ticker) return;
    const line = document.createElement('li');
    line.className = `feed feed--${tone}`;
    line.textContent = text;
    this.el.ticker.prepend(line);

    // Fade the line out on its own, then trim the list.
    setTimeout(() => line.classList.add('is-fading'), 5200);
    setTimeout(() => line.remove(), 6000);
    while (this.el.ticker.children.length > 7) this.el.ticker.lastElementChild.remove();
  }

  // ------------------------------------------------------------------ nuke ---

  /**
   * Fullscreen takeover for the 100-coin Arena Nuke. CSS drives the fade
   * in/hold/fade-out (see .nuke-overlay in style.css, 2.6s total); this just
   * fills in the owner's identity and (re)starts the animation. The timeout
   * mirrors that 2.6s so `is-active` is clear again before a second nuke
   * could ever need to restart it.
   */
  showNuke(nickname, avatar) {
    const el = this.el.nukeOverlay;
    if (!el) return;

    this.el.nukeName.textContent = nickname;
    if (avatar) {
      this.el.nukeAvatar.src = avatar;
      this.el.nukeAvatar.style.display = '';
    } else {
      this.el.nukeAvatar.removeAttribute('src');
      this.el.nukeAvatar.style.display = 'none';
    }

    // Restart the CSS animation even if a nuke is already mid-fade.
    el.classList.remove('is-active');
    void el.offsetWidth;
    el.classList.add('is-active');

    clearTimeout(this._nukeTimer);
    this._nukeTimer = setTimeout(() => el.classList.remove('is-active'), 2600);
  }

  // ---------------------------------------------------------------- admin ---

  /**
   * The reset panel is reachable two ways: the floating gear button (mouse or
   * touch) and the Ctrl+Alt+Shift+A chord (kept as a fallback). Neither one is
   * the actual security boundary — the server admin key and a typed "RESET"
   * confirmation still gate the destructive action itself, so making the
   * panel easier to open costs nothing.
   */
  _wireAdmin() {
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyA') {
        e.preventDefault();
        this.toggleAdmin(true);
      }
      if (e.key === 'Escape' && this.el.admin?.classList.contains('is-open')) {
        this.toggleAdmin(false);
      }
    });

    this.el.adminToggle?.addEventListener('click', () => {
      this.toggleAdmin(!this.el.admin?.classList.contains('is-open'));
    });

    this.el.adminCancel?.addEventListener('click', () => this.toggleAdmin(false));
    this.el.adminSubmit?.addEventListener('click', () => this._submitAdmin());
    this.el.adminKey?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitAdmin(); });
    this.el.adminConfirm?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitAdmin(); });
  }

  toggleAdmin(open) {
    if (!this.el.admin) return;
    this.el.admin.classList.toggle('is-open', open);
    this.el.adminToggle?.classList.toggle('is-open', open);
    this.el.adminToggle?.setAttribute('aria-expanded', String(!!open));
    this.el.adminError.textContent = '';
    if (open) {
      this.el.adminKey.value = '';
      this.el.adminConfirm.value = '';
      setTimeout(() => this.el.adminKey.focus(), 30);
    }
  }

  async _submitAdmin() {
    const key = this.el.adminKey.value.trim();
    const confirm = this.el.adminConfirm.value.trim();

    if (!key) return this._adminError('Enter the admin key.');
    if (confirm !== 'RESET') return this._adminError('Type RESET in the confirmation field.');

    this.el.adminSubmit.disabled = true;
    this.el.adminSubmit.textContent = 'Clearing…';
    try {
      const result = await this.onResetRequest(key, confirm);
      if (result.ok) {
        this.toggleAdmin(false);
        this.announce(`Arena cleared — ${result.removed} fish removed`, 'alert');
      } else {
        this._adminError(result.error || 'Reset failed.');
      }
    } catch (err) {
      this._adminError(`Could not reach the server: ${err.message}`);
    } finally {
      this.el.adminSubmit.disabled = false;
      this.el.adminSubmit.textContent = 'Clear arena';
    }
  }

  _adminError(message) {
    this.el.adminError.textContent = message;
  }
}

// ------------------------------------------------------------------ helpers --

const EYE_OFF = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1.6 12S5.5 5 12 5s10.4 7 10.4 7-3.9 7-10.4 7S1.6 12 1.6 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_ON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1.6 12S5.5 5 12 5s10.4 7 10.4 7-3.9 7-10.4 7S1.6 12 1.6 12Z"/><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/></svg>`;

/**
 * Depth rail: ten ticks, one per evolution band, filled up to the fish's level.
 * It reads like a sonar depth gauge and tells you how far a fish has left to
 * climb without printing another number.
 */
function depthRail(level) {
  let out = '';
  for (let i = 1; i <= LEVEL_BANDS.length; i++) {
    out += `<i class="tick${i <= level ? ' tick--lit' : ''}"></i>`;
  }
  return out;
}

/**
 * HP as a viewer reads it.
 *
 * Exact digits up to 99,999 because the precise number is the drama — "8,340"
 * landing on "7,900" is a story a viewer can follow. Only past 100k do we
 * abbreviate, since by then the exact value stops mattering and the width would
 * break the plate.
 */
function formatHP(hp) {
  const n = Math.max(0, Math.round(hp));
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 100000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString('en-US');
}

function chip(label, tone) {
  return `<span class="chip chip--${tone}">${label}</span>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
