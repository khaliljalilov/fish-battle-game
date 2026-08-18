# Drop your .glb models here

The game looks for these ten files in this folder, one per evolution level:

| Level | HP band     | File                              |
|-------|-------------|-----------------------------------|
| 1     | 100–499     | `hsw_porbeagle.glb`               |
| 2     | 500–999     | `hsw_smooth_hammerhead_shark.glb` |
| 3     | 1000–1499   | `hsw_great_hammerhead_shark.glb`  |
| 4     | 1500–1999   | `hsw_great_white_shark.glb`       |
| 5     | 2000–2499   | `hsw_the_frenzy.glb`              |
| 6     | 2500–2999   | `hsw_whale_shark.glb`             |
| 7     | 3000–3499   | `hsw_blue_whale.glb`              |
| 8     | 3500–3999   | `hsw_zombie_shark.glb`            |
| 9     | 4000–4999   | `hsw_robo_shark.glb`              |
| 10    | 5000+       | `hsw_mr_snappy.glb`               |

You supply these files yourself. Nothing is bundled or downloaded — make sure you
have the right to use whatever you drop in here.

## Missing files are fine

`ModelLibrary.preload()` never rejects. Any file that fails to load is replaced
with a procedurally generated shark of the same silhouette, tinted per level, with
a hand-animated tail and jaw. The loader reports which levels fell back, and the
HUD status strip says so too. **The game is fully playable with this folder empty** —
add models one at a time and they get picked up on the next reload.

## Model requirements

- **Format:** `.glb` (binary glTF). `.gltf` + separate textures works too if you
  change the filename in `server/rules.js` *and* `public/js/config.js`.
- **Size:** irrelevant. Every model is measured on load and rescaled so its longest
  axis matches the arena's target length, so a 2-unit fish and a 2000-unit fish
  end up the same size on screen.
- **Orientation:** the loader assumes the standard glTF convention — nose pointing
  down **−Z**. If a fish swims backwards or sideways, set `MODEL_YAW_OFFSET` in
  `public/js/config.js` (radians, applied to every model) instead of re-exporting.
- **Animations:** optional. Clip names containing `swim`, `idle`, or `move` are used
  as the looping base; clips containing `bite`, `attack`, or `chomp` are played once
  per bite and cross-faded back to swim. Without clips, the fallback tail-wag drives
  the model instead.
- **Rigging:** skinned meshes are cloned with `SkeletonUtils.clone()`, so every fish
  gets its own skeleton and animates independently. Sharing one skeleton across
  instances is the classic "all fish animate in lockstep" bug — this avoids it.

## Keeping the file size down

Ten high-poly sharks will stall the first load on a stream. Before dropping them in:

```bash
npx gltf-transform optimize input.glb output.glb --texture-size 1024
```

Aim for under 3 MB per model. The arena renders up to 40 fish at once.
