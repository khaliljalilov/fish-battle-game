# Fish Battle — project rules

TikTok Live gift-driven 3D battle arena. Node + Express + Socket.IO server, Three.js
client (r160, ES modules, no build step). Server owns the economy; client owns combat
simulation only.

## Working rules

- **Run `node tools/verify.js` before saying anything is done.** It catches missing
  methods, dead imports, missing DOM ids and config keys — all of which produce
  runtime crashes that `node --check` cannot see.
- **`node --check` is not enough.** Every crash in this project so far passed syntax
  checks. Deleted methods, wrong init order and undefined fields all parse fine.
- **One change at a time.** The user tests in a browser and reports back. Batching
  five changes makes it impossible to attribute a regression.
- **Never claim visual output works.** Nobody in the loop can see the rendered frame.
  Say what was verified and what was not.
- No new npm packages without asking — the user copies files in manually.

## Traps that have already cost hours

Each of these shipped silently, with a clean console.

**Animation clips overwrite object transforms.** Exported `.glb` clips often animate
the armature's own `.scale` / `.position`. Model normalisation therefore lives on a
holder node the AnimationMixer never touches (`models.js` → `instance()`), and root
tracks are stripped (`stripRootMotion`). Putting the fit scale on the animated node
makes fish render tens of times too large.

**`fish.js` runs a size audit 0.25s after each model swap** (`_verifyRenderedSize`).
Load-time normalisation is a prediction; this measures reality and corrects it. Do not
remove it — it is the only structural guarantee against giant fish.

**Never dispose shared geometry.** `effects.js` reuses `spikeGeo` / `shurikenGeo`
across every instance. A previous `geometry.dispose()` in the cleanup path freed a
buffer still in use and rendered garbage that looked like a giant fish.

**`_removeAura` must handle Meshes and Groups.** Shield is a Mesh; rotor is a Group
with blades, hub, disc and a light. Assuming `.geometry` crashes the render loop.

**Postprocessing must be built after the camera.** `RenderPass` captures the camera at
construction. Building the composer in renderer setup hands it `undefined` and throws
every frame inside `WebGLRenderer.render`.

**Nameplate cull distance must exceed the camera's distance to the far corner.**
When the arena widened, every plate silently vanished because the camera moved past
the old limit. If the HUD disappears, check `NAMEPLATE_MAX_DISTANCE` in `ui.js` first.

**TikTok gift streaks:** `giftType` lives in `data.giftDetails`, not at the top level.
Reading it from the top level made the streak guard a no-op and inflated a 10-gift
streak into 55 coins. User identity can appear under several different keys — see
`extractIdentity` in `server.js`.

**`enableExtendedGiftInfo` must stay `false`.** It fetches the room gift catalogue,
which is a paid Euler Stream route; with it on, connection fails entirely on the free
tier with an error that reads like an auth problem.

**Combat balance is coupled.** `MOVEMENT.separationRadius` must stay smaller than
`COMBAT.biteRangeFactor` or fish are held outside biting range and no fight ever
resolves. Hunters must be faster than their prey (`chaseSpeedFactor` vs
`minSpeedFactor`) or chases never close.

## Known open bugs

1. **Fish in the ~1000–3500 HP band sometimes do not render.** That band maps to
   `hsw_the_frenzy` (L5), `hsw_whale_shark` (L6), `hsw_blue_whale` (L7). Console shows
   `the_frenzy` measuring as unmeasurable and `whale_shark` at 0.01 units. Suspect the
   model files, not the HP logic.
2. **A giant whale occasionally appears.** Likely the same three models. The runtime
   size audit should catch it — find out why it does not.
3. **9 of 10 models load with 0 animation clips**, `robo_shark` with 396. Fish are
   swimming on the procedural tail wag, not real animation.

Diagnose 1 and 2 by logging, per fish: model file, expected `bodyLength`, and the
measured world-space bounding box after the size audit runs. Do not guess.

## Verifying without a browser

- `SIMULATE=true npm start` — unlocks the test panel locally with an empty
  arena (no auto-spawn). Add `SIMULATE_AUTOSPAWN=true` (or `npm run dev`) for
  the old unattended fake-gift-every-2–5s stream, no TikTok needed.
- The 🧪 TEST panel (bottom right) fires any gift tier through the real server path.
- `GET /api/models` — reports what is actually on disk vs expected filenames.
- `node check-key.js` — diagnoses Euler Stream signing.
- Headless physics sims are the right tool for balance questions. Past ones found that
  combat literally never resolved and that fish were pinned outside bite range.

## Conventions

- Comments explain *why*, especially where a value is load-bearing. Several constants
  here look arbitrary and are not.
- Effects are pooled; never allocate in the frame loop. Reuse the module-level scratch
  vectors (`_v1`, `_box`, …).
- The economy lives only in `server/rules.js`. The client must never invent HP.
