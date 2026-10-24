# Persistent world maps

Goal: the whole game world is mapped and saved. Every place anyone goes has a grid map that is
created once (the first time someone gets there) and kept forever. Everyone has a saved position,
distances are exact, "I walk over to the fireplace" means something, and coming back days later
finds the same room with things where they were left.

## Today

- A map lives on a **scene** (`scene.data.map` + `data.positions`) and only for fights. When the
  fight ends the GM may delete it, and a new scene in the same inn starts blank.
- Scenes without a map get a made-up sketch for pictures (not saved as world state).

## Design

### 1. Maps belong to places
- A `location` record holds its map: `data.map {cols, rows, cell_ft, features}`. Created once,
  then edited like any other record (a door broken down, a table overturned stays that way).
- Features can be **exits**: `{kind: "door", x, y, to: "<location id>"}` linking to another place
  (the inn's street door leads to "Wickmere, market lane"). Walking through an exit moves you to
  that place's map, at its matching exit.
- Hidden things stay in `gm_notes.map_features` as now.

### 2. Everyone has a saved position
- Each character, NPC and notable object stores where it is: its parent location (already true)
  plus `data.pos {x, y}` on that location's map (hidden creatures: `gm_notes.pos`).
- Leaving keeps nothing stale: moving to another place sets the new location and its position in
  the same save. An NPC left by the hearth is still by the hearth when you come back.
- Scenes keep only the per-encounter state (initiative, round, whose turn); they read positions
  from the people in them. Fights, side stories and the map/diorama/picture views all read the same
  positions.

### 3. New places are created when first visited
- The validator refuses a save that puts someone in a place without a map: the GM must create the
  map in the same save, sized and furnished from the place's description (same rules as today's
  battle maps: walls, doors, furniture; a room 8-16 cells, a street or clearing about 20x14).
- New places the story invents ("a back alley behind the inn") are created as location records with
  a map and an exit linking them to where you came from, so they persist and can be revisited.
- Big areas are split into connected maps instead of one huge grid (a town = several streets and
  squares joined by exits; a forest road = a few clearings).

### 4. Rules that use the map everywhere, not just in fights
- Movement: a move must follow a path that avoids walls and objects; in a fight it is limited by
  speed (6 cells) as now; outside a fight there is no limit but the path must exist.
- Reach: the attack reach check (already built) applies to every attack; talking, handing things,
  picking a lock etc. need adjacency or a stated distance.
- The GM context always includes the ascii map of the current place with distances from the actor.

### 5. Long distances
- Travel between far-apart places (another town, days away) does not walk a grid: places get a
  region (`parent` chain: room -> building -> town -> region) and travel between regions uses
  time on the world clock, not cells. Arriving puts you at the destination's entrance exit.

### 6. Pictures stay consistent
- The 3D scene, map and diorama are built from the place's saved map and the saved positions, and
  the extra set dressing is seeded by the location id, so a room looks the same every visit.

## Migration
- Existing battle maps move from their scene to the scene's location (positions to the people).
- Places without a map get one the next time someone acts there (the GM creates it then).

## Work
1. Schema + helpers: location maps, `pos`, exits; validation (`mapProblems` for locations, positions
   in walls/objects, two creatures in one cell, path check for moves).
2. Tools: require a map when entering an unmapped place; move/exit handling; reach for interactions.
3. GM prompt: maps for every place, exits, creating new places, travel; context = place map always.
4. Views: map/diorama/3D read location maps; location-seeded dressing; sketches only as a fallback.
5. Migration script for existing campaigns; tests for create-on-visit, persistence across leaving
   and returning, exits, path blocking, the inn map surviving the end of the fight.
