# 🌊 TikTok Live Fish Battle — Arena Mode

A Beyblade-style battle arena driven entirely by TikTok Live gifts. Viewers spawn
as fish in a square glass tank, gifts buy HP and evolution, and the fish ricochet
off the walls and each other. Collisions are the combat.

No player input. It runs itself on stream.

---

## Quick start

```bash
cp .env.example .env          # then set ADMIN_SECRET_KEY (required)
npm install
npm run dev                   # SIMULATE=true — fake gifts every 2–5s
```

Open <http://localhost:3000>. You'll see fish spawn and start fighting within a few
seconds, using procedural sharks until you add `.glb` files to `public/models/`
(see the README in that folder).

### Going live needs two things in `.env`

```
TIKTOK_USERNAME=your_tiktok_handle
EULER_API_KEY=your_key_from_eulerstream
```

The API key is not optional. TikTok signs its webcast requests with obfuscated
browser-fingerprint parameters, and `tiktok-live-connector` delegates that
signing to Euler Stream's servers. Without a key you get:

```
SignatureError: Failed to sign request ... status code 404
```

That error does **not** mean your stream or username is wrong — if the log shows
a `room_id`, TikTok found your stream fine and only the signing step failed. Get
a free key at <https://www.eulerstream.com> (about a minute, no card).

Also make sure you're on v2 of the library. v1 exported `WebcastPushConnection`
and points at a signing endpoint that no longer exists:

```powershell
npm i tiktok-live-connector@latest
```

### MongoDB is optional

The server wants a local MongoDB at `mongodb://localhost:27017`, but if it isn't
there the game runs from memory and retries the connection every 10 seconds. You
lose persistence across restarts, nothing else. Start one whenever you want:

```bash
docker run -d -p 27017:27017 --name fishdb mongo:7
```

---

## How it fits together

```
server/
  rules.js    Gift → HP → level economy. Authoritative. Money logic lives here only.
  store.js    Mongo persistence. Write-behind: dirty set + 2s bulkWrite flush.
  server.js   TikTok bridge, Socket.IO fan-out, REST API, admin reset.
public/js/
  config.js   Client tuning: level bands, combat thresholds, camera, powers.
  models.js   GLB loading, normalization, animation resolution, procedural fallback.
  world.js    Fog, god rays, caustics, seabed, rocks, kelp, plankton, bubbles.
  effects.js  Pooled particles: blood, jet trails, toxic gas, shockwave rings, spikes.
  fish.js     One fish: evolution, smoothed swimming, lock-on AI, combat, power auras.
  camera.js   Director camera + chase-cam spectating with lerped transitions.
  ui.js       Leaderboard, nameplates, event ticker, admin panel.
  net.js      Socket.IO client, state sync, reconnect.
  main.js     Game loop, spatial pairing, damage resolution, power dispatch.
```

**The split that matters:** the server owns everything involving coins. The client
owns combat simulation only. A tampered browser console can start fights but can
never invent HP, so nobody can fake a Titan without paying for one.

---

## Game rules as implemented

**Evolution** — 10 levels, one model each, new tier every 500 HP. Scale grows
logarithmically with HP so a 10,000 HP Titan reads as huge without dwarfing the
arena.

**HP comes only from gifts.** Eating never grants HP. The table:

| Gift | Coins | HP | Power |
|---|---|---|---|
| Rose | 1 | +25 | — |
| Turbo Boost | 5 | +125 | 3× speed, 5s, jet trail |
| Spike Burst | 10 | +250 | 360° spikes, 50 dmg nearby |
| Combo | 20 | +700 | Bass Shockwave: camera shake, 3 waves, 300 dmg + 2s stun |
| Big Gift | 30 | +1,050 | Absolute Shield: immune 60s |
| Hand Heart | 100 | +4,500 | Toxic Aura: ~33 DPS for 30s |

Odd coin values decompose to the largest tier that fits plus 25 HP per leftover
coin, so no gift ever feels dead.

**Death is a demotion.** HP hitting zero drops the fish one level and refills to
that level's max. Only a Level 1 fish at zero is actually removed from the scene.

**Attack gating** — under 5,000 HP an attacker needs 25% more HP than its target.
Titans (5,000+) only need a 500–1,000 HP edge, so the top of the board stays
violent. Each bite costs the target 10% of the attacker's max HP, every 1.5s.

**Lock-on AI** — a fish picks a target and commits for 10 seconds. No jitter, no
frame-by-frame target switching. Bites play `LoopOnce` and cross-fade back to swim.

---

## Operating it on stream

- **Focus a fish** — click the 👁 next to any leaderboard name. The camera pushes IN
  on that fish, side-on, and tracks it. Esc returns to the wide shot.
- **Reset the arena** — `Ctrl+Alt+Shift+A`. Needs your `ADMIN_SECRET_KEY` *and* the
  word RESET typed out. Deliberately unreachable by mouse so you can't nuke a
  three-hour stream by misclicking.
- **Fish cap** — `MAX_ACTIVE_FISH` (default 40). Gifters beyond the cap are queued
  and spawn as fish die. Raise it only if your GPU has room.
- **Refresh is safe.** `GET /api/state` restores the full arena from the database,
  so a browser crash mid-stream costs you a few seconds, not the session.

---

## Why arena mode

The hunting design did not work as a spectacle. Three reasons, all fixed here:

**The outcome was known in advance.** HP came only from gifts and combat only
subtracted it, so the biggest spender won and nothing could change that. Now
every collision damages **both** fish weighted by mass — a Titan still wins
exchanges about 3:1, but it reaches the next Titan already wounded. The
leaderboard can turn over.

**Fights were executions.** A 9,000 HP fish deleted an 8,000 HP fish in 13
seconds while the victim could not bite back even once. Now nobody is immune and
nobody is helpless.

**Nothing was legible.** Hunting decisions are invisible — a viewer just saw
numbers change. An impact is visible: who hit whom, how hard, who got knocked
across the tank.

## The arena

A square glass tank, `ARENA.halfSize` (58) to each wall, seen from above at an
angle with the **whole tank always in frame**. Someone joining mid-stream should
understand the situation in one second.

Fish are balls with a heading and a speed. They reflect off walls with proper
mirror reflection — only the component into the wall flips, so a shallow hit
glances off and keeps going forward instead of reversing back the way it came.
Every wall and fish impact adds a small random yaw (`wallSpin`, `fishSpin`),
because a frictionless billiard table settles into perfectly periodic paths
within seconds, and predictable is boring.

Fish size is capped at `MAX_FISH_SCALE` (1.85). In a fixed tank an unbounded
Titan swallows the frame and you can no longer see the fight — the arena has to
stay readable more than a big spender has to feel enormous.

Verified over a 120-second 24-fish simulation: 6 collisions/sec, zero frames out
of bounds, zero overlapping bodies, nobody ever stalls below 14 units/sec.

## TikTok connection troubleshooting

Run this any time the live connection fails — it tests your Euler key without
starting the game and tells you exactly which of the four causes you have:

```powershell
node check-key.js
```

Three errors people hit, in the order they usually hit them:

| Error | Means | Fix |
|---|---|---|
| `Failed to sign request ... 404` | library is v1 | `npm i tiktok-live-connector@latest` |
| `The provided API Key is invalid` | key wrong, quoted, or made up | get a real one at eulerstream.com |
| `requires a Business plan` | a premium route was requested | `enableExtendedGiftInfo: false` |

That last one is the subtle one. `enableExtendedGiftInfo: true` fetches the
room's full gift catalogue during connect, and that route is paid-only — so the
connection fails entirely on the free tier with what looks like an auth error but
is really a billing one. We keep it **false**; the coin value and gift name we
actually need come in the gift event itself.

If the log shows a `room_id`, TikTok found your stream fine and only signing
failed. And the connection only works while you are genuinely live — otherwise
you get `Failed to retrieve Room ID`, which is not an error, just "no stream".

## Older notes: the 2.5D camera

Models are full 3D, but the camera is locked to a side-on view looking down -Z and
never orbits or goes behind a fish — the Hungry Shark arrangement. The arena is a
wide, shallow **slab** rather than a cylinder: play happens across X and Y, while
`ARENA.depth` (22) gives just enough Z for fish to cross in front of and behind
each other. Set `depth` to 0 and it looks papery; set it to 100 and you lose track
of who's fighting whom.

Focus distance is derived from body length, so **evolving zooms the camera out on
its own**. The fish stays around 14–16% of screen width at every level while the
visible water column grows from 19 to 29 units. That's the trick: you don't make
the fish bigger on screen, you make the world bigger around it.

## "I added my models but different fish are swimming"

That means the .glb files failed to load and the game silently fell back to
procedural sharks. Open this while the server is running:

    http://localhost:3000/api/models

It reads the folder off disk and tells you exactly what's wrong — wrong folder,
nested subfolder, misspelled or wrong-case filename, or nothing there at all. The
browser console (F12) also now prints a specific reason per model rather than
failing quietly.

The four usual causes:

1. **Wrong folder.** They belong in `public/models/`, not `models/` at the project root.
2. **Nested one level deep.** Unzipping often creates `public/models/Models/*.glb`. Move them up.
3. **Names don't match.** They must match exactly, lowercase, as listed in `public/models/README.md`.
4. **Compressed meshes.** Draco and Meshopt decoders are now wired in automatically. KTX2/Basis textures still aren't supported — re-export with PNG textures if the console mentions them.

## Sound

Everything is synthesised at runtime from oscillators and filtered noise — there
are no audio files in this project. Nothing to license, nothing to download, no
copyright claim on your VOD. Bites are pitched by attacker size, gifts arpeggiate
by coin value, and each power has its own signature.

Browsers block audio until a user gesture, so it starts on your first click. The
🔊 button (bottom left) toggles it. Volume lives in `MASTER_DEFAULT` at the top of
`public/js/audio.js`.

## Performance notes

Every particle, ring, spike, and nameplate comes from a pre-allocated pool — nothing
is constructed during play, so the GC never stutters mid-fight. Vector math reuses
module-level scratch objects for the same reason. Materials are shared across
instances, geometry is disposed on removal, and the render loop clamps delta time
so a tab-out doesn't teleport every fish across the arena on return.

If frames drop with a full arena, in `config.js`: lower `RENDER.planktonCount`,
`RENDER.bubbleCount`, and `RENDER.godRayCount`, in that order.

## Controls

| Input | Does |
|---|---|
| 👁 on leaderboard | Focus that fish |
| Mouse wheel / `+` `-` | Zoom in and out |
| `0` | Reset zoom |
| `O` | Cycle model orientation 0/90/180/270° — **the fix for fish swimming backwards** |
| `Esc` | Back to the wide shot |
| `Ctrl+Alt+Shift+A` | Admin reset panel |

If your fish swim tail-first, press `O` until they face the right way, then read
the value the console prints and paste it into `MODEL_YAW_OFFSET` in
`public/js/config.js` so it survives a reload.

## Two bugs that made combat silently impossible

Worth recording, because both looked like working code and neither threw an error.

**Hunters were slower than their prey.** Legal prey is always weaker, therefore
smaller, therefore faster under the size-based speed penalty. A hunter had a
1.01× speed advantage over its own target — so chases never closed, fish tailed
each other for the full lock duration, and no bite ever landed. Fixed by raising
`minSpeedFactor` from 0.55 to 0.78 and `chaseSpeedFactor` from 1.35 to 1.75.

**Separation was wider than bite reach.** `separationRadius` (1.35 × body length)
held fish further apart than `biteRangeFactor` (1.15) could reach, so the
separation pass shoved attackers out of range one frame before they could bite.
Fixed with `combatSeparationRadius` (0.8), which applies only to a hunter and its
own target.

A 90-second 40-fish simulation now lands ~5.3 bites/sec with 38 of 40 fish
scoring, and holds all three invariants: no two fish share a target, no mutual
targeting, and zero frames of mesh overlap.

## The HUD is built for a phone, not a monitor

Every choice here assumes the viewer is holding a phone at arm's length with a
comment feed scrolling over half the screen.

**No health bars.** A 7px gauge is unreadable at that size and tells a viewer
nothing precise. Each fish carries its HP as one big yellow number instead —
`8,340` dropping to `7,900` is a story you can follow. Exact digits up to 99,999;
only past 100k does it abbreviate.

**Avatars, not usernames.** Every fish wears its gifter's TikTok profile picture.
People scan a crowded tank looking for *their own face*, never for 11px text.

**Floating damage numbers.** `-240` rises off both fish on every impact. This is
the highest value-per-line feature in the whole project: without it a collision
is two models touching, with it every hit has a visible consequence.

**A leader banner, not just a leaderboard.** One crowned face at the top with the
HP number. The list on the left is for the streamer; the banner is for the
viewer, and it flashes on every lead change — the most exciting moment the game
produces, which previously passed unremarked.

**Bright water.** Fog density dropped 5x and the palette moved to a clean
tropical blue. Dark and murky reads as "broken video" on a phone in daylight, and
it made the yellow HUD text muddy.

## Growth has to be felt

The old scale curve ran 1.15x to 2.0x across the entire game — a 10,000 HP fish
looked almost identical to a 100 HP one, so evolution meant nothing visually.
Now it runs **0.77x to 3.15x, a 4.1x range**. Fish arrive genuinely tiny and
Titans dominate the tank.

Size also eases rather than snaps. A gift landing used to jump the model's size
instantly, which read as a glitch; now `renderScale` lerps toward the target and
the same event reads as a swell.

Verified with 24 large fish over 120s: 9.6 collisions/sec, zero out-of-bounds,
zero overlaps, tank occupancy 9.2% (readable up to ~35%).

## Tuning the arena

All in `PHYSICS` in `config.js`:

| Want | Change |
|---|---|
| Faster, more chaotic | raise `baseSpeed` |
| More collisions | raise `baseSpeed`, or lower `ARENA.halfSize` |
| Bouncier | raise `fishBounce` / `impactKick` |
| More unpredictable | raise `wallSpin` / `fishSpin` |
| Fights end faster | raise `COMBAT.impactDamage` |
| Less damage spam | raise `collisionCooldown` |

`fishBounce` above 1.0 deliberately adds energy on each impact, which is what
keeps the tank churning instead of slowly settling.
