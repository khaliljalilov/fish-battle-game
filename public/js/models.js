/**
 * models.js — model library.
 *
 * Loads the ten evolution .glb files once, normalizes them to a common body
 * length, and hands out cheap clones. If a file is missing or fails to parse,
 * that level silently falls back to a procedurally built shark so the arena
 * never renders an empty slot and the game never crashes mid-stream.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { LEVEL_BANDS, MODEL_PATH } from './config.js';

/** Every fish is normalized to this nose-to-tail length at scale 1. */
const TARGET_LENGTH = 4.2;

const SWIM_HINTS = ['swim', 'idle', 'move', 'cruise', 'default'];
const BITE_HINTS = ['bite', 'attack', 'chomp', 'eat', 'hit'];

export class ModelLibrary {
  constructor() {
    this.loader = new GLTFLoader();

    /**
     * Compressed-mesh support.
     *
     * Models exported from game-asset pipelines are very often Draco-compressed
     * or Meshopt-packed, and a plain GLTFLoader throws a bare "no DRACOLoader
     * instance provided" on those — which surfaces as a silent fallback to the
     * procedural shark. Wiring the decoders in costs nothing when the file
     * isn't compressed, so they're always attached.
     */
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
    this.loader.setDRACOLoader(draco);
    this.loader.setMeshoptDecoder(MeshoptDecoder);

    /** @type {Map<number, {scene:THREE.Object3D, clips:THREE.AnimationClip[], fit:number, procedural:boolean}>} */
    this.entries = new Map();
    this.report = { loaded: [], fallback: [], errors: [] };
  }

  /** Load everything up front. Never rejects — failures become fallbacks. */
  async preload(onProgress) {
    let done = 0;
    const tasks = LEVEL_BANDS.map(async (band) => {
      const url = MODEL_PATH + band.model;
      try {
        const gltf = await this.loader.loadAsync(url);
        const root = gltf.scene || gltf.scenes[0];
        prepareMaterials(root);
        this.entries.set(band.level, {
          scene: root,
          clips: gltf.animations || [],
          fit: fitFactor(root, band.model),
          procedural: false
        });
        this.report.loaded.push(band.model);
        console.info(
          `[models] L${band.level} ${band.model} — loaded, ` +
          `${gltf.animations?.length || 0} animation clip(s)`
        );
      } catch (err) {
        // Say exactly WHY, because "wrong fish are swimming" is otherwise
        // impossible to diagnose from the browser. The three real causes are a
        // 404 (name or folder wrong), a parse failure (not actually a .glb, or
        // compressed with an extension we can't decode), and a network error.
        const reason = describeLoadFailure(err);
        console.warn(`[models] L${band.level} ${band.model} — FAILED (${reason}). URL tried: ${url}`);

        const root = buildProceduralShark(band);
        this.entries.set(band.level, {
          scene: root,
          clips: [],
          fit: fitFactor(root, `L${band.level} procedural`),
          procedural: true
        });
        this.report.fallback.push(band.model);
        this.report.errors.push({ level: band.level, file: band.model, url, reason });
      } finally {
        done += 1;
        onProgress?.(done / LEVEL_BANDS.length, band.level);
      }
    });

    await Promise.all(tasks);
    return this.report;
  }

  /**
   * Build a fresh, independently animatable instance for a level.
   * @returns {{root:THREE.Object3D, mixer:THREE.AnimationMixer|null, actions:{swim:THREE.AnimationAction|null, bite:THREE.AnimationAction|null}, procedural:boolean, tail:THREE.Object3D|null}}
   */
  instance(level) {
    const entry = this.entries.get(level) || this.entries.get(1);
    if (!entry) throw new Error('ModelLibrary.preload() was never awaited');

    // SkeletonUtils.clone keeps skinned meshes bound to their own skeleton.
    const root = cloneSkinned(entry.scene);

    /**
     * Normalisation goes on the HOLDER, never on the animated node.
     *
     * This was the giant-fish bug. The fit scale used to be set on `root`, but
     * `root` is what the AnimationMixer drives — and exported .glb clips very
     * often contain a `.scale` track on the armature. The first mixer.update()
     * therefore overwrote the normalisation with the clip's own value, and the
     * model snapped back to its authored size. A whale shark authored at ~200
     * units then rendered ~50x too big and filled the entire tank, with no error
     * anywhere, which is why the console stayed clean while the screen did not.
     *
     * The holder sits above the mixer's reach, so nothing can undo it.
     */
    const holder = new THREE.Object3D();
    holder.scale.setScalar(entry.fit);
    holder.add(root);

    let mixer = null;
    const actions = { swim: null, bite: null };

    if (entry.clips.length) {
      mixer = new THREE.AnimationMixer(root);
      const swimClip = pickClip(entry.clips, SWIM_HINTS) || entry.clips[0];
      const biteClip = pickClip(entry.clips, BITE_HINTS);

      if (swimClip) {
        actions.swim = mixer.clipAction(stripRootMotion(swimClip));
        actions.swim.setLoop(THREE.LoopRepeat, Infinity);
        actions.swim.play();
      }
      if (biteClip && biteClip !== swimClip) {
        actions.bite = mixer.clipAction(stripRootMotion(biteClip));
        actions.bite.setLoop(THREE.LoopOnce, 1);
        actions.bite.clampWhenFinished = true;
      }
    }

    return {
      root: holder,
      mixer,
      actions,
      procedural: entry.procedural,
      tail: root.getObjectByName('proc_tail') || null,
      jaw: root.getObjectByName('proc_jaw') || null
    };
  }
}

// ------------------------------------------------------------------ helpers --

function pickClip(clips, hints) {
  for (const hint of hints) {
    const found = clips.find((c) => c.name.toLowerCase().includes(hint));
    if (found) return found;
  }
  return null;
}

/** Scale factor that brings any model to TARGET_LENGTH along its longest axis. */
/**
 * Measure a model and return the scale that normalises it to TARGET_LENGTH.
 *
 * `Box3.setFromObject()` handles skinned meshes correctly in three r160 — it
 * detects `object.boundingBox` on a SkinnedMesh and calls the skinning-aware
 * `computeBoundingBox()`, which applies bone transforms per vertex. So rigging
 * is NOT a source of size errors here, despite being the usual suspect.
 *
 * What does break measurement is junk in the file: a stray ground plane, a
 * lighting rig, an oversized armature helper, or a collision hull left in by
 * the exporter. Any of those inflate the box, shrink the fit factor, and leave
 * the fish looking wrong. So we log what we measured and clamp the result — a
 * silently mis-scaled model is far harder to debug than a logged one.
 */
function fitFactor(object, label = '') {
  object.updateWorldMatrix(true, true);

  const box = new THREE.Box3().setFromObject(object);
  let size = box.getSize(new THREE.Vector3());
  let longest = Math.max(size.x, size.y, size.z);

  /**
   * Fallback: measure the raw vertex data.
   *
   * Box3.setFromObject returns an empty box for some exports — a mesh whose
   * bounding box can't be derived from its object-level data, points/line
   * primitives, or a scene graph shape the walker doesn't cover. When that
   * happens the model would be left at scale 1, which for a file authored at
   * ~0.2 units means a fish roughly the size of a grain of sand: technically
   * loaded, completely invisible, and impossible to diagnose from the arena.
   *
   * Reading geometry attributes directly always works, because that data is
   * what actually gets drawn.
   */
  if (longest < 0.5) {
    let foundSkinned = false;
    let largestX = 0;
    let largestY = 0;
    let largestZ = 0;

    object.traverse((child) => {
      if (!child.isSkinnedMesh) return;
      const geo = child.geometry;
      if (!geo || !geo.attributes?.position) return;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox) return;
      const skinnedSize = geo.boundingBox.getSize(new THREE.Vector3());
      largestX = Math.max(largestX, skinnedSize.x);
      largestY = Math.max(largestY, skinnedSize.y);
      largestZ = Math.max(largestZ, skinnedSize.z);
      foundSkinned = true;
    });

    if (foundSkinned) {
      const skinnedLongest = Math.max(largestX, largestY, largestZ);
      if (skinnedLongest > longest) {
        size = new THREE.Vector3(largestX, largestY, largestZ);
        longest = skinnedLongest;
        console.info(`[models] ${label} — measured ${skinnedLongest.toFixed(2)} units from raw skinned mesh geometry sizes`);
      }
    }
  }

  if (!Number.isFinite(longest) || longest <= 0.0001) {
    const fallback = new THREE.Box3();
    const tmp = new THREE.Box3();
    let found = false;

    object.traverse((child) => {
      const geo = child.geometry;
      if (!geo || !geo.attributes?.position) return;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox) return;
      tmp.copy(geo.boundingBox).applyMatrix4(child.matrixWorld);
      fallback.union(tmp);
      found = true;
    });

    if (found && !fallback.isEmpty()) {
      size = fallback.getSize(new THREE.Vector3());
      longest = Math.max(size.x, size.y, size.z);
      console.info(`[models] ${label} — object box was empty, measured from vertex data instead`);
    }
  }

  if (!Number.isFinite(longest) || longest <= 0.0001 || longest < 0.5) {
    if (label.includes('the_frenzy')) {
      longest = 7.15;
      console.info(`[models] ${label} — using hardcoded fallback longest=${longest.toFixed(2)}`);
    } else if (label.includes('whale_shark')) {
      longest = 8.0;
      console.info(`[models] ${label} — using hardcoded fallback longest=${longest.toFixed(2)}`);
    } else if (label.includes('robo_shark')) {
      longest = 7.5;
      console.info(`[models] ${label} — using hardcoded fallback longest=${longest.toFixed(2)}`);
    } else if (label.includes('blue_whale')) {
      longest = 18.0;
      console.info(`[models] ${label} — using hardcoded fallback longest=${longest.toFixed(2)}`);
    } else {
      console.warn(
        `[models] ${label} has no measurable geometry at all — using scale 1. ` +
        `The runtime size audit will correct it once it renders.`
      );
      return 1;
    }
  }

  const raw = TARGET_LENGTH / longest;

  // A model needing more than a 400x correction in either direction is almost
  // certainly mis-authored. Clamp so one bad file can't fill the whole tank.
  const fit = THREE.MathUtils.clamp(raw, TARGET_LENGTH / 4000, TARGET_LENGTH * 400);
  if (fit !== raw) {
    console.warn(
      `[models] ${label} measured ${longest.toFixed(3)} units — implausible, clamping. ` +
      `Check the .glb for stray geometry (ground planes, helpers, collision hulls).`
    );
  }

  console.info(
    `[models] ${label} measured ${longest.toFixed(2)} units -> fit x${fit.toFixed(4)}`
  );
  return fit;
}

/** Shared material pass: shadows off (too expensive at 40 fish), fog on. */function logGltfSceneDetails(root, gltf, label) {
  const log = (msg) => console.info(`[models][debug] ${label} ${msg}`);
  log(`raw scene position=${vectorToString(root.position)} scale=${vectorToString(root.scale)}`);

  let index = 0;
  root.traverse((child) => {
    const name = child.name || `(unnamed-${index++})`;
    const type = child.type || child.constructor?.name || 'Object3D';
    let details = `name='${name}', type=${type}`;

    if (child.geometry) {
      const geo = child.geometry;
      const vertexCount = geo.attributes?.position?.count ?? 0;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const box = geo.boundingBox;
      const boxSize = box ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);
      details += `, vertices=${vertexCount}, bbox=${vectorToString(boxSize)}`;
    }

    log(details);
  });
}

function vectorToString(v) {
  return `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
}
function prepareMaterials(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = false;
    child.receiveShadow = false;
    child.frustumCulled = true;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m) continue;
      m.fog = true;
      m.side = THREE.FrontSide;
    }
  });
}

/**
 * Procedural shark — the safety net.
 *
 * Built from primitives so it works with zero asset files. Nose points down -Z
 * to match glTF convention, and the tail group is named so the fish controller
 * can wag it by hand (there is no AnimationClip here).
 */
function buildProceduralShark(band) {
  const group = new THREE.Object3D();
  const skin = new THREE.Color(band.tint);
  const belly = skin.clone().lerp(new THREE.Color(0xf2f7f7), 0.65);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: skin, roughness: 0.72, metalness: band.level === 9 ? 0.65 : 0.05, flatShading: false
  });
  const bellyMat = new THREE.MeshStandardMaterial({ color: belly, roughness: 0.85, metalness: 0 });
  const finMat = new THREE.MeshStandardMaterial({ color: skin.clone().multiplyScalar(0.82), roughness: 0.8 });

  // Body: a stretched sphere, tapered by squashing the rear.
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), bodyMat);
  body.scale.set(0.62, 0.72, 1.65);
  group.add(body);

  // Snout
  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.5, 16), bodyMat);
  snout.rotation.x = -Math.PI / 2;
  snout.position.z = -2.05;
  snout.scale.set(1, 1, 0.72);
  group.add(snout);

  // Underside
  const under = new THREE.Mesh(new THREE.SphereGeometry(0.95, 16, 10), bellyMat);
  under.scale.set(0.52, 0.34, 1.45);
  under.position.y = -0.28;
  group.add(under);

  // Dorsal fin
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.25, 4), finMat);
  dorsal.position.set(0, 0.78, 0.1);
  dorsal.scale.set(0.28, 1, 1.05);
  dorsal.rotation.y = Math.PI / 4;
  group.add(dorsal);

  // Pectoral fins
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.5, 4), finMat);
    fin.position.set(side * 0.62, -0.16, -0.45);
    fin.rotation.set(Math.PI / 2, 0, side * -0.85);
    fin.scale.set(0.9, 1, 0.22);
    group.add(fin);
  }

  // Tail — named so FishController can animate it manually.
  const tail = new THREE.Object3D();
  tail.name = 'proc_tail';
  tail.position.z = 1.55;
  const peduncle = new THREE.Mesh(new THREE.ConeGeometry(0.38, 1.1, 10), bodyMat);
  peduncle.rotation.x = Math.PI / 2;
  peduncle.position.z = 0.5;
  tail.add(peduncle);
  const fluke = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.5, 4), finMat);
  fluke.position.z = 1.1;
  fluke.rotation.set(Math.PI / 2, 0, Math.PI / 4);
  fluke.scale.set(0.9, 1, 0.16);
  tail.add(fluke);
  group.add(tail);

  // Eyes — small emissive dots read well through fog.
  const eyeMat = new THREE.MeshBasicMaterial({ color: band.level === 8 ? 0x9dff5a : 0x0b0f12 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), eyeMat);
    eye.position.set(side * 0.4, 0.18, -1.35);
    group.add(eye);
  }

  // Level-specific flourishes so evolutions are readable at a glance.
  if (band.level >= 9) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.72, 0.07, 6, 20),
      new THREE.MeshBasicMaterial({ color: 0x39d7ff })
    );
    ring.rotation.y = Math.PI / 2;
    ring.position.z = 0.15;
    group.add(ring);
  }
  if (band.level === 10) {
    for (let i = 0; i < 6; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.42, 5), finMat);
      spike.position.set(0, 0.72, -1.0 + i * 0.45);
      group.add(spike);
    }
  }

  prepareMaterials(group);
  return group;
}

/**
 * Turn a GLTFLoader exception into something a human can act on.
 * The loader's own messages are famously unhelpful for this exact problem.
 */
function describeLoadFailure(err) {
  const msg = String(err?.message || err || '').toLowerCase();

  if (msg.includes('404') || msg.includes('not found')) {
    return 'file not found — check the name and that it is in public/models/';
  }
  if (msg.includes('dracoloader') || msg.includes('draco')) {
    return 'Draco-compressed and the decoder could not be reached (are you offline?)';
  }
  if (msg.includes('meshopt')) {
    return 'Meshopt-compressed and the decoder failed to run';
  }
  if (msg.includes('ktx') || msg.includes('basis')) {
    return 'uses KTX2/Basis textures, which need KTX2Loader — re-export with PNG textures';
  }
  if (msg.includes('unexpected token') || msg.includes('json') || msg.includes('unsupported')) {
    return 'not a valid .glb — the server likely returned an HTML error page, or the file is .gltf/.fbx renamed';
  }
  if (msg.includes('network') || msg.includes('failed to fetch')) {
    return 'network error fetching the file';
  }
  return err?.message || 'unknown error';
}

/**
 * Remove root-motion tracks from a clip.
 *
 * A .glb swim cycle usually animates the armature's own transform as well as
 * its bones. Left in, those tracks fight the game: `.scale` undoes the size
 * normalisation, and `.position` slides the model away from where the physics
 * thinks the fish is, so the body and its nameplate drift apart. Bone tracks
 * (which contain a '.bones[' path segment) are exactly what we want to keep —
 * that's the actual swimming motion.
 *
 * Cached per clip, since instance() runs on every spawn and evolution.
 */
const _strippedClips = new WeakMap();

function stripRootMotion(clip) {
  const cached = _strippedClips.get(clip);
  if (cached) return cached;

  const kept = clip.tracks.filter((track) => {
    const name = track.name || '';
    // Bone tracks always name the bone, e.g. "Armature.bones[Spine].quaternion"
    // or "Spine.quaternion". A bare ".scale" / ".position" targets the root.
    const isRootTransform =
      name === '.scale' || name === '.position' ||
      name.endsWith('.scale') && !name.includes('bones[') && name.split('.').length <= 2;
    return !isRootTransform;
  });

  if (kept.length === clip.tracks.length) {
    _strippedClips.set(clip, clip);
    return clip;
  }

  const removed = clip.tracks.length - kept.length;
  console.info(`[models] "${clip.name}" — removed ${removed} root-motion track(s)`);

  const cleaned = new THREE.AnimationClip(clip.name, clip.duration, kept);
  _strippedClips.set(clip, cleaned);
  return cleaned;
}