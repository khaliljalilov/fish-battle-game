/**
 * camera.js — angled overhead camera on a fixed square arena.
 *
 * One rule drives everything here: the whole tank is always on screen. A viewer
 * dropping into the stream mid-fight should understand the situation instantly
 * — here is the box, here are the fish, that one is big and winning.
 *
 * The previous chase camera failed at exactly this. Following one fish through
 * open water meant the viewer saw a lot of water, no context, and never the
 * moment of impact. In an arena game the arena IS the shot.
 *
 * Focus mode pushes in toward a fish without ever fully leaving the tank, and
 * the wide shot drifts slowly around the arena so it doesn't look like a
 * security camera.
 */

import * as THREE from 'three';
import { ARENA, CAMERA } from './config.js';

const _desired = new THREE.Vector3();
const _lookAt = new THREE.Vector3();

export class CameraDirector {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'wide';
    /** @type {import('./fish.js').Fish|null} */
    this.subject = null;

    this.currentPos = new THREE.Vector3(0, CAMERA.height, CAMERA.distance);
    this.currentLook = new THREE.Vector3(0, CAMERA.lookAtY, 0);

    /** Manual zoom multiplier from the wheel and +/- keys. */
    this.zoomFactor = 1;
    this.driftPhase = 0;
    this.blend = 1;
  }

  spectate(fish) {
    if (fish === this.subject && this.mode === 'focus') return;
    this.subject = fish || null;
    this.mode = fish ? 'focus' : 'wide';
    this.blend = 0;
  }

  onFishRemoved(fish) {
    if (this.subject === fish) this.spectate(null);
  }

  nudgeZoom(factor) {
    this.zoomFactor = THREE.MathUtils.clamp(this.zoomFactor * factor, 0.45, 2.4);
  }

  resetZoom() {
    this.zoomFactor = 1;
  }

  update(dt, shakeOffset) {
    this.blend = Math.min(1, this.blend + dt * 0.9);
    this.driftPhase += dt * CAMERA.driftSpeed;

    if (this.mode === 'focus' && this.subject && !this.subject.dead) {
      this._focusTarget(this.subject);
    } else {
      if (this.mode === 'focus') this.spectate(null);
      this._wideTarget();
    }

    const ramp = 0.4 + this.blend * 0.6;
    this.currentPos.lerp(_desired, THREE.MathUtils.clamp(dt * CAMERA.moveLerp * ramp, 0, 1));
    this.currentLook.lerp(_lookAt, THREE.MathUtils.clamp(dt * CAMERA.lookLerp * ramp, 0, 1));
    this.currentPos.y = THREE.MathUtils.clamp(this.currentPos.y, CAMERA.minY, CAMERA.maxY);

    this.camera.position.copy(this.currentPos).add(shakeOffset);
    this.camera.lookAt(this.currentLook);
    this.camera.up.set(0, 1, 0);
  }

  /**
   * Wide shot: the entire tank, seen from above and behind, drifting slowly
   * around the vertical axis. The drift is small on purpose — enough to feel
   * alive, not enough to make anyone track a moving frame.
   */
  _wideTarget() {
    const angle = Math.sin(this.driftPhase) * CAMERA.driftRange;
    const radius = CAMERA.distance * this.zoomFactor;

    _desired.set(
      Math.sin(angle) * radius,
      CAMERA.height * this.zoomFactor,
      Math.cos(angle) * radius
    );
    _lookAt.set(0, CAMERA.lookAtY, 0);
  }

  /**
   * Focus shot: drop toward one fish, but stay overhead and keep the tank
   * oriented the same way. The camera does NOT swing behind the fish — the
   * arena's walls must stay where the viewer expects them.
   */
  _focusTarget(fish) {
    const pos = fish.root.position;
    const angle = Math.sin(this.driftPhase) * CAMERA.driftRange * 0.5;
    const radius = CAMERA.focusDistance * this.zoomFactor;

    // Clamp toward the centre so focusing a fish in the corner doesn't put the
    // camera outside the tank looking at a wall.
    const cx = THREE.MathUtils.clamp(pos.x * 0.65, -ARENA.halfSize * 0.6, ARENA.halfSize * 0.6);
    const cz = THREE.MathUtils.clamp(pos.z * 0.65, -ARENA.halfSize * 0.6, ARENA.halfSize * 0.6);

    _desired.set(
      cx + Math.sin(angle) * radius,
      CAMERA.focusHeight * this.zoomFactor,
      cz + Math.cos(angle) * radius
    );
    _lookAt.set(pos.x, CAMERA.lookAtY * 0.7, pos.z);
  }
}
