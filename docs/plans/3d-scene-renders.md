# Rendered 3D scenes instead of painted images

## Context

Painted FLUX illustrations still look poor: extra hands, people repeated, faces drifting. The 3D pieces built last round already work:
- deterministic battle maps;
- portraits;
- **3D miniatures**: portrait → GLB via the local 3D pipeline's Pixal3D graph;
- Blender dioramas.

The user wants 🎨 Illustrate to become a **rendered 3D scene**: the same saved models every time, in the right positions, with zero AI image artifacts.

**User choices:**
- Pure 3D render, with no AI repaint.
- Static, staged poses: models turned toward their opponents, cinematic camera. No rigging.
- Procedural rooms and furniture: shaped, textured blocks from the map and the location description. No generated prop library.

## Design

### 1. Scene spec (new `src/scene3d.ts`, no AI)

`buildSceneSpec(db, turn, opts)` returns a JSON spec for Blender. It reads public data only.

**Layout:**
- Use the turn's stored `map_snapshot`, else the current `mapSnapshot` (src/maps.ts).
- Without a map, synthesize one:
  - an 8×6 room, or an open area outdoors;
  - the actor in the middle, and the other public participants in a 1–2 cell arc in front;
  - the cast comes from `castOf()` / `sceneFor()`, so reuse them: export them from src/images.ts.

**People:**
- **Focus:** at most 3, using `focusOf` from images.ts (export it). Background participants stay in the room but out of camera focus.
- **Models:** each person gets `model` = `currentMiniature()` (src/portraits.ts) when one exists, else a capsule in their token color.
- **Facing:** each person faces their opponent. That's the nearest other combatant when a fight is on (initiative), otherwise the actor or the camera.
- **State:**
  - `down` (hp ≤ 0): the model lies on its back;
  - `wounded`: a subtle red tint on the base;
  - hidden / gm-visibility records are never included, the same filtering as `mapSnapshot`.

**Room:**
- **Indoor or outdoor:** indoor if the map has walls or the location's text says inn, hall, room, cellar, chapel, house, tavern and so on. Otherwise outdoor.
- **Materials:** keywords from the public location description pick wall and floor materials: wood / stone / brick / plaster / dirt / grass / cobbles / water. Defaults: wood indoors, dirt outdoors.
- **Features:** each feature kind becomes a shaped procedural object, chosen by its label:
  - table: a top on legs;
  - bar counter: a counter with a top;
  - bench, chair, barrel, crate, bed, shelf, hearth or fireplace (glowing);
  - door, window, pillar or statue as a column, cart, stairs;
  - water as a glossy plane, pit as a hole;
  - `light` as a warm point light.

  Unknown labels fall back to a plain block.

**Lighting and time:**
- The time of day comes from the scene's `time_min`: dawn, day, dusk or night set the sun or window color and strength.
- Interiors get warm lamp lights plus window light.
- "Rain" or "storm" in the description makes the outdoor light cool and grey.

**Camera:**
- A cinematic 3/4 view at about 1.6–2.2 m height, from behind and beside the actor, looking at the focus group's centroid.
- Lens 30–40 mm, framing the focus group with margin.
- Walls between the camera and the focus are cut away.

### 2. Missing models are built on demand

The render job runs on the shared GPU queue. Before rendering, for each focus person with no current miniature, it calls the existing `paintPortraitNow` + miniature build. Those helpers move into a shared private `ensureMiniature()` in src/turns.ts.
- **Public NPCs too:** `buildPortraitPrompt` already supports them.
- **First-time cost:** about 1 minute per new person. After that the models are cached under `DATA_DIR/images/<campaign>/miniatures/` and reused.
- **Progress:** the "Painting…" message says "building 3D models for N people (first time only)".
- **Fallback:** if a build fails, that person is a capsule. The picture still posts.

### 3. Blender renderer (new `scripts/scene_blender.py`)

This is a sibling of `scripts/diorama_blender.py`. It reuses that script's helpers: material, box, the feet-centered GLB placement from `miniature()`, the camera/track setup, and the EEVEE/AgX settings. Its job is to build the room, objects, people, lights and camera from the spec and render 1280×720 with EEVEE (Cycles available via an env setting).
- It runs through the existing `scripts/diorama.py` wrapper (GPU lock, ComfyUI `/free`, timeout). That wrapper gets a `--script` argument choosing between the diorama and the scene.
- **TS side:** `createSceneRenderer(cfg)` lives next to `createDioramaRenderer` in src/diorama.ts.

### 4. Wiring (src/turns.ts, src/index.ts, src/images.ts config)

- **New setting** `IMAGE_MODE=render3d|paint`, default `render3d`. `TurnRunner.illustrate()` branches on it:
  - `render3d`: ensure models → `buildSceneSpec` → render → post. It uses the same caption, replyTo, storyline channel, dedupe and `delivery.image` state as today.
  - `paint`: the current FLUX path, unchanged, as an option.
- The 🎨 Illustrate button and `illustrate:true` stay the same for players.
- **Requirements:** render3d needs Blender (`DIORAMA` config / `BLENDER_PATH`) and the miniature builder. If they're missing, the bot logs it and falls back to paint.
- **Log:** each render logs the spec summary: people, models used vs capsules, materials, seconds.

## Files

- **New:** src/scene3d.ts, scripts/scene_blender.py, tests/scene3d.test.ts.
- **Changed:**
  - src/images.ts: export `castOf`, `sceneFor`, `focusOf`; add the `IMAGE_MODE` config;
  - src/turns.ts: the illustrate branch, plus `ensureMiniature` extracted from `buildMiniature`;
  - src/diorama.ts: `createSceneRenderer`;
  - scripts/diorama.py: the `--script` argument;
  - src/index.ts and scripts/local.ts: wiring;
  - scripts/doctor.ts;
  - README.md and .env.example.

## Verification

**Unit tests (fakes):**
- The spec includes public participants only; a hidden NPC is never included.
- Without a map, a layout is synthesized.
- Focus is capped at 3, and models are assigned where miniatures exist.
- People face their opponents.
- Material keywords map correctly (stone chapel → stone; inn → wood).
- Indoor and outdoor are detected.
- A fallen character is marked `down`.
- `IMAGE_MODE=render3d` routes illustrate to the scene renderer, and missing miniatures are built first.
- If Blender fails, the bot falls back to paint.

**Real renders on a copy of the campaign** (this is the main check; I view each image and iterate on camera, materials and lighting until it reads well):
- turn 29: the inn brawl, with Vargas and Thaniesh miniatures and Marrow;
- the Duking join turn, with a waiting combatant;
- a non-map scene (synthesized layout);
- an outdoor scene.

**Then:** `npm run typecheck && npm test`, restart, press 🎨 in Discord. Check `data/logs` for render entries.
