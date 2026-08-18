/**
 * world.js — the ocean itself.
 *
 * Everything here is static or ambient: nothing in this module knows about
 * fish, gifts, or combat. It builds the volume the game happens inside and
 * exposes a single update(dt, elapsed) to keep it alive.
 */

import * as THREE from 'three';
import { ARENA, RENDER } from './config.js';

export class World {
  constructor(scene) {
    this.scene = scene;
    this.updaters = [];

    this._buildAtmosphere();
    this._buildLighting();
    this._buildGodRays();
    this._buildSeabed();
    this._buildTankWalls();
    this._buildRocks();
    this._buildKelp();
    this._buildPlankton();
    this._buildBubbles();
  }

  update(dt, elapsed) {
    for (const fn of this.updaters) fn(dt, elapsed);
  }

  // ------------------------------------------------------------ atmosphere --

  _buildAtmosphere() {
    // Exponential fog is what sells "depth". Density is tuned so a fish 60u out
    // is a silhouette and a fish 100u out is gone.
    this.scene.fog = new THREE.FogExp2(RENDER.fogColor, RENDER.fogDensity);
    this.scene.background = new THREE.Color(RENDER.deepColor);

    // Surface: a large inverted plane with a subtle animated normal-ish shimmer.
    const surfaceGeo = new THREE.PlaneGeometry(ARENA.halfSize * 2.4, ARENA.halfSize * 2.4, 40, 40);
    const surfaceMat = new THREE.MeshBasicMaterial({
      color: RENDER.surfaceColor,
      transparent: true,
      opacity: 0.16,
      side: THREE.BackSide,
      depthWrite: false
    });
    const surface = new THREE.Mesh(surfaceGeo, surfaceMat);
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = 2;
    this.scene.add(surface);

    // Ripple the surface vertices — cheap, and it catches the eye on wide shots.
    const pos = surfaceGeo.attributes.position;
    const base = Float32Array.from(pos.array);
    this.updaters.push((dt, t) => {
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3];
        const y = base[i * 3 + 1];
        pos.array[i * 3 + 2] = Math.sin(x * 0.06 + t * 0.9) * 1.1 + Math.cos(y * 0.05 + t * 0.7) * 1.1;
      }
      pos.needsUpdate = true;
    });
  }

  // --------------------------------------------------------------- lighting --

  _buildLighting() {
    // Ambient floor. Was 1.5 — the phone-in-daylight legibility problem this
    // originally solved (see RENDER's comment in config.js) is still real, so
    // this is toned down, not gutted; a fully dim scene reads as a broken
    // stream on a phone screen next to a bright comment feed.
    this.scene.add(new THREE.AmbientLight(0xbfeaff, 1.0));

    // Sun from above-front. This is what makes the fish backs read bright and
    // their bellies dark — the classic underwater silhouette. Was 2.0.
    const sun = new THREE.DirectionalLight(RENDER.sunColor, 1.35);
    sun.position.set(30, 90, 20);
    this.scene.add(sun);
    this.scene.add(sun.target);

    // Cold bounce from the deep to keep the undersides from going flat. Was 1.1.
    const bounce = new THREE.HemisphereLight(0xd8f6ff, 0x2b8fc4, 0.75);
    this.scene.add(bounce);

    // A slow-moving point light gives the water a "living" flicker. Was
    // 0.9-1.15.
    const glow = new THREE.PointLight(0x9ff5ff, 0.65, 180, 2);
    glow.position.set(0, -18, 0);
    this.scene.add(glow);
    this.updaters.push((dt, t) => {
      glow.intensity = 0.58 + Math.sin(t * 1.7) * 0.16;
      glow.position.x = Math.sin(t * 0.15) * 40;
      glow.position.z = Math.cos(t * 0.12) * 40;
    });
  }

  // -------------------------------------------------------------- god rays --

  _buildGodRays() {
    // Shafts are just long, very transparent cones with additive blending.
    // Cheaper than volumetric anything and reads correctly through the fog.
    const group = new THREE.Group();
    const geo = new THREE.ConeGeometry(7, 70, 8, 1, true);

    for (let i = 0; i < RENDER.godRayCount; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: RENDER.sunColor,
        transparent: true,
        opacity: 0.05 + Math.random() * 0.05,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false
      });
      const ray = new THREE.Mesh(geo, mat);
      const angle = (i / RENDER.godRayCount) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 22 + Math.random() * 62;
      ray.position.set(Math.cos(angle) * dist, -8, Math.sin(angle) * dist);
      ray.rotation.z = (Math.random() - 0.5) * 0.35;
      ray.rotation.x = (Math.random() - 0.5) * 0.2;
      ray.userData.phase = Math.random() * Math.PI * 2;
      ray.userData.baseOpacity = mat.opacity;
      group.add(ray);
    }

    this.scene.add(group);
    this.updaters.push((dt, t) => {
      for (const ray of group.children) {
        const p = ray.userData.phase;
        ray.material.opacity = ray.userData.baseOpacity * (0.6 + Math.sin(t * 0.8 + p) * 0.4);
        ray.rotation.z += Math.sin(t * 0.3 + p) * dt * 0.02;
      }
      group.rotation.y += dt * 0.01;
    });
  }

  // --------------------------------------------------------------- seabed --

  _buildSeabed() {
    // Wide enough that the plane's own edge stays fully inside fog range —
    // see the no-edge-bowl comment below.
    const size = ARENA.halfSize * 4.0;
    const geo = new THREE.PlaneGeometry(size, size, 90, 90);

    // Hand-rolled ridged noise: three sine octaves. Deterministic, no library.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const h =
        Math.sin(x * 0.035) * Math.cos(y * 0.03) * 3.2 +
        Math.sin(x * 0.09 + 1.3) * Math.cos(y * 0.11) * 1.1 +
        Math.sin((x + y) * 0.17) * 0.45;
      /**
       * No edge bowl anymore — removed on request for a flat, clean seabed.
       *
       * There used to be a rim here that curved the plane upward past the
       * play area (outside ARENA.halfSize * 1.15) to hide the flat plane's
       * own edge. That's gone now; only the gentle ridged-noise texture
       * above (`h`, max amplitude ~4.75) remains. This is safe to remove
       * without the plane's edge becoming visible: the seabed spans
       * ARENA.halfSize * 4 (400 units) in every direction, and the fog
       * built in _buildAtmosphere is tuned so a fish 100 units out is
       * already gone — the plane's edge, 400 units out, is deep inside
       * fully-opaque fog territory no matter its height.
       */
      pos.setZ(i, h);
    }
    geo.computeVertexNormals();

    // Pale sand, not dark navy.
    //
    // The old floor was almost the same value as the fish, so bodies visually
    // dissolved into it whenever one swam low — it read as fish sinking THROUGH
    // the ground. A light warm floor under blue-white fish gives permanent
    // separation no matter where anything is in the tank.
    const textureLoader = new THREE.TextureLoader();
    const groundColor = textureLoader.load('/textures/ground/Ground080_2K-JPG/Ground080_2K-JPG_Color.jpg');
    const groundNormal = textureLoader.load('/textures/ground/Ground080_2K-JPG/Ground080_2K-JPG_NormalGL.jpg');
    const groundRoughness = textureLoader.load('/textures/ground/Ground080_2K-JPG/Ground080_2K-JPG_Roughness.jpg');
    const groundAo = textureLoader.load('/textures/ground/Ground080_2K-JPG/Ground080_2K-JPG_AmbientOcclusion.jpg');

    for (const texture of [groundColor, groundNormal, groundRoughness, groundAo]) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(8, 8);
      // Sharper at the shallow, near-grazing angle an overhead-ish camera
      // sees a wide floor at — default anisotropy (1) blurs a texture this
      // large well before it reaches the tank walls. No renderer reference
      // needed here; 8 is safely within every WebGL2 device's supported
      // range and already a large jump from the default.
      texture.anisotropy = 8;
    }

    const sand = new THREE.MeshStandardMaterial({
      // A richer, more saturated ochre than the old flat tan (0xe4d6ae) —
      // still light/warm on purpose (see the fish-vs-floor separation note
      // above), just more contrast-y instead of washed out.
      color: 0xe8bf7a,
      // Slightly below fully-rough (1) for a touch of specular definition
      // under the EXISTING lights — no new light added, this just lets the
      // ones already there put a sharper highlight on the floor.
      roughness: 0.85,
      metalness: 0,
      map: groundColor,
      normalMap: groundNormal,
      roughnessMap: groundRoughness,
      aoMap: groundAo
    });

    const floor = new THREE.Mesh(geo, sand);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = ARENA.tankDepth;
    this.scene.add(floor);

    // Scroll the ground textures subtly so they feel alive without looking tiled.
    this.updaters.push((dt, t) => {
      for (const texture of [groundColor, groundNormal, groundRoughness, groundAo]) {
        texture.offset.x = Math.sin(t * 0.08) * 0.35 + t * 0.012;
        texture.offset.y = Math.cos(t * 0.06) * 0.35;
      }
    });
  }

  /**
   * The four glass walls.
   *
   * These are what make the arena legible. Without a visible boundary a viewer
   * cannot tell whether a fish bounced off something or just turned around, and
   * the whole Beyblade read falls apart. Rendered as additive glass panels with
   * a soft neon glow along the top edge (see makeRimGlowTexture — alternating
   * two hues per wall, not one flat saturated color), drawn back-to-front so
   * you always see through the near wall into the fight.
   */
  _buildTankWalls() {
    const half = ARENA.halfSize;
    const top = ARENA.waterTop;
    const bottom = ARENA.tankDepth;
    const height = top - bottom;

    const glass = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.02,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    // Soft neon edge glow, not a solid opaque bar. The old rim was a flat
    // 0x00ffff plane at 0.95 opacity — maximum saturation, maximum
    // brightness, zero falloff, which is exactly what reads as a cheap,
    // harsh strip-light rather than a glow. A vertical gradient texture
    // (bright hairline at the very top edge, fading to nothing over the rest
    // of the band) gives it actual depth, and alternating two neon hues
    // around the four walls (instead of one flat cyan everywhere) is what
    // makes it read as "designed" rather than a single primary-color outline.
    const wallGeo = new THREE.PlaneGeometry(half * 2, height);
    const rimGeo = new THREE.PlaneGeometry(half * 2, 2.4);
    const rimMaterials = [0x2fd8ff, 0xb84dff].map((hex) => new THREE.MeshBasicMaterial({
      map: makeRimGlowTexture(hex),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }));

    // [rotationY, x, z] for each of the four sides.
    const sides = [
      [0, 0, -half],
      [Math.PI, 0, half],
      [Math.PI / 2, -half, 0],
      [-Math.PI / 2, half, 0]
    ];

    sides.forEach(([ry, x, z], i) => {
      const wall = new THREE.Mesh(wallGeo, glass);
      wall.position.set(x, bottom + height / 2, z);
      wall.rotation.y = ry;
      wall.renderOrder = -1;
      this.scene.add(wall);

      const edge = new THREE.Mesh(rimGeo, rimMaterials[i % 2]);
      edge.position.set(x, top, z);
      edge.rotation.y = ry;
      this.scene.add(edge);
    });

    // Floor grid inside the tank. Gives the eye a fixed reference so motion
    // reads as motion rather than the camera drifting.
    const grid = new THREE.GridHelper(half * 2, 12, 0xbfe9ff, 0x6fc4e8);
    grid.position.y = bottom + 0.05;
    grid.material.transparent = true;
    grid.material.opacity = 0.22;
    grid.material.depthWrite = false;
    this.scene.add(grid);
  }

  _buildRocks() {
    // One InstancedMesh for ~70 rocks: a single draw call.
    const count = 70;
    const geo = new THREE.IcosahedronGeometry(1, 0);
    // Deeper, more saturated slate than the old pale gray-blue (0xa8bcc4) —
    // reads as a silhouette with real contrast against the bright water
    // instead of nearly blending into it. Roughness eased down slightly
    // (0.95 -> 0.8) for sharper facet highlights under the existing lights;
    // no new light added.
    const mat = new THREE.MeshStandardMaterial({ color: 0x3d5866, roughness: 0.8, flatShading: true });
    const rocks = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      // Just outside the walls: decoration must never obstruct the fight.
      const dist = ARENA.halfSize * 1.08 + Math.random() * ARENA.halfSize * 0.5;
      const s = 1.2 + Math.random() * 5.5;
      dummy.position.set(Math.cos(angle) * dist, ARENA.tankDepth + s * 0.35, Math.sin(angle) * dist);
      dummy.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      dummy.scale.set(s, s * (0.5 + Math.random() * 0.5), s);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
    }
    rocks.instanceMatrix.needsUpdate = true;
    this.scene.add(rocks);
  }

  _buildKelp() {
    // Kelp = thin tapered cylinders. Each blade sways on its own phase.
    const blades = new THREE.Group();
    const geo = new THREE.CylinderGeometry(0.06, 0.28, 1, 5, 4);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4fb87a, roughness: 0.9, side: THREE.DoubleSide });

    for (let i = 0; i < 90; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = ARENA.halfSize * 1.12 + Math.random() * ARENA.halfSize * 0.4;
      const h = 6 + Math.random() * 14;
      const blade = new THREE.Mesh(geo, mat);
      blade.scale.set(1, h, 1);
      blade.position.set(Math.cos(angle) * dist, ARENA.tankDepth + h * 0.5, Math.sin(angle) * dist);
      blade.userData.phase = Math.random() * Math.PI * 2;
      blade.userData.lean = 0.12 + Math.random() * 0.14;
      blades.add(blade);
    }

    this.scene.add(blades);
    this.updaters.push((dt, t) => {
      for (const blade of blades.children) {
        const p = blade.userData.phase;
        blade.rotation.z = Math.sin(t * 0.75 + p) * blade.userData.lean;
        blade.rotation.x = Math.cos(t * 0.55 + p) * blade.userData.lean * 0.6;
      }
    });
  }

  // ------------------------------------------------------------- particles --

  _buildPlankton() {
    // Slow-drifting motes. Additive + fog-free so they twinkle in the dark.
    const count = RENDER.planktonCount;
    const positions = new Float32Array(count * 3);
    const drift = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * ARENA.halfSize;
      positions[i * 3] = Math.cos(angle) * dist;
      positions[i * 3 + 1] = ARENA.tankDepth + Math.random() * (ARENA.waterTop - ARENA.tankDepth);
      positions[i * 3 + 2] = Math.sin(angle) * dist;
      drift[i * 3] = (Math.random() - 0.5) * 0.35;
      drift[i * 3 + 1] = (Math.random() - 0.2) * 0.25;
      drift[i * 3 + 2] = (Math.random() - 0.5) * 0.35;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0x9ff2e6,
      size: 0.32,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);

    this.updaters.push((dt, t) => {
      const arr = geo.attributes.position.array;
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        arr[i3] += drift[i3] * dt;
        arr[i3 + 1] += drift[i3 + 1] * dt;
        arr[i3 + 2] += drift[i3 + 2] * dt;
        // Wrap inside the cylinder instead of respawning — avoids popping.
        if (Math.max(Math.abs(arr[i3]), Math.abs(arr[i3 + 2])) > ARENA.halfSize) {
          arr[i3] *= -0.96;
          arr[i3 + 2] *= -0.96;
        }
        if (arr[i3 + 1] > ARENA.waterTop) arr[i3 + 1] = ARENA.tankDepth;
        if (arr[i3 + 1] < ARENA.tankDepth) arr[i3 + 1] = ARENA.waterTop;
      }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = 0.45 + Math.sin(t * 1.2) * 0.12;
    });
  }

  _buildBubbles() {
    const count = RENDER.bubbleCount;
    const positions = new Float32Array(count * 3);
    const speed = new Float32Array(count);
    const phase = new Float32Array(count);

    const reset = (i, atBottom = true) => {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * ARENA.halfSize * 0.92;
      positions[i * 3] = Math.cos(angle) * dist;
      positions[i * 3 + 1] = atBottom
        ? ARENA.tankDepth + Math.random() * 4
        : ARENA.tankDepth + Math.random() * 20;
      positions[i * 3 + 2] = Math.sin(angle) * dist;
      speed[i] = 1.6 + Math.random() * 3.4;
      phase[i] = Math.random() * Math.PI * 2;
    };
    for (let i = 0; i < count; i++) reset(i, false);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0xd9fbff,
      size: 0.5,
      map: makeBubbleTexture(),
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);

    this.updaters.push((dt, t) => {
      const arr = geo.attributes.position.array;
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        arr[i3 + 1] += speed[i] * dt;
        // Bubbles wobble as they rise — the detail that sells it.
        arr[i3] += Math.sin(t * 2.2 + phase[i]) * dt * 0.35;
        arr[i3 + 2] += Math.cos(t * 1.9 + phase[i]) * dt * 0.35;
        if (arr[i3 + 1] > 1) reset(i, true);
      }
      geo.attributes.position.needsUpdate = true;
    });
  }
}

// ------------------------------------------------------- generated textures --

/** Soft blotchy light pattern for the seabed. Drawn once into a canvas. */
function makeCausticsTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#243f47';
  ctx.fillRect(0, 0, size, size);

  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 6 + Math.random() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(150, 235, 245, 0.30)');
    g.addColorStop(0.5, 'rgba(110, 200, 220, 0.10)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Grain keeps the sand from looking like flat vinyl.
  ctx.globalCompositeOperation = 'source-over';
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Vertical glow gradient for the tank's top-edge neon rim — see
 * _buildTankWalls. Brightest at the vertical center (the arena's actual rim
 * line, where the plane is anchored) and fading to nothing both above and
 * below — a glowing line, not a bar with a flat painted edge.
 */
function makeRimGlowTexture(hex, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = new THREE.Color(hex);
  const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  const mid = size / 2;

  const upper = ctx.createLinearGradient(0, mid, 0, 0);
  upper.addColorStop(0, `rgba(${rgb},1)`);
  upper.addColorStop(0.35, `rgba(${rgb},0.45)`);
  upper.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = upper;
  ctx.fillRect(0, 0, canvas.width, mid);

  const lower = ctx.createLinearGradient(0, mid, 0, size);
  lower.addColorStop(0, `rgba(${rgb},1)`);
  lower.addColorStop(0.35, `rgba(${rgb},0.45)`);
  lower.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = lower;
  ctx.fillRect(0, mid, canvas.width, mid);

  return new THREE.CanvasTexture(canvas);
}

/** Round sprite with a bright rim — a bubble, not a dot. */
function makeBubbleTexture(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  const g = ctx.createRadialGradient(c, c, size * 0.18, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,0.05)');
  g.addColorStop(0.72, 'rgba(210,250,255,0.16)');
  g.addColorStop(0.9, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();

  // Specular highlight
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.arc(c * 0.68, c * 0.62, size * 0.07, 0, Math.PI * 2);
  ctx.fill();

  return new THREE.CanvasTexture(canvas);
}

export { makeBubbleTexture };
