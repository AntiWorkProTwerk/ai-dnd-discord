// Background world preparation: what to get ready around the party before they get there, the way
// a GM preps between sessions. An outline for the town or region they are in, maps for the places
// their exits lead to, and the places beyond exits that lead nowhere yet. The server picks the
// tasks (no model call); a background GM run in mode "prep" does them.
import type { Db } from './database.js';
import { dbView, placeIdOf, readMap, type PlaceRecord, type WorldView } from './maps.js';

export interface PrepJob {
  /** The party's place the tasks are around. */
  place_id: string;
  tasks: { key: string; text: string }[];
}

const MAX_EXIT_TASKS = 2;

function isAncestor(view: WorldView, maybe: string, of: string): boolean {
  for (let p = view.get(of)?.parent_id, n = 0; p && n < 12; p = view.get(p)?.parent_id, n++) if (p === maybe) return true;
  return false;
}

/** A town, district or region: a location that holds other places. */
function isArea(view: WorldView, r: PlaceRecord): boolean {
  return view.childrenOf(r.id).some((c) => c.kind === 'location');
}

/** What to prepare around a character's place; empty when everything near them is ready. */
export function prepJobFor(db: Db, campaignId: string, characterId: string): PrepJob | null {
  const view = dbView(db, campaignId);
  const placeId = placeIdOf(view, characterId);
  const place = placeId ? view.get(placeId) : undefined;
  if (!place || !placeId) return null;
  const tasks: PrepJob['tasks'] = [];

  // The nearest town or region around the place (whatever contains it), if it has no outline yet.
  const area = place.parent_id ? view.get(place.parent_id) : undefined;
  if (area?.kind === 'location' && !(Array.isArray(area.data.notable) && area.data.notable.length)) {
    tasks.push({
      key: `outline:${area.id}`,
      text: `Outline ${area.name} (${area.id}), the area the party is in: set data.notable to the short list of what is there and publicly known (inns, shops and trades, temples, landmarks, roads out), sized to the place, naming notable things it lacks too ("no smith"); keep everything already recorded about it and its places. Put its secrets, who really runs it and current troubles in gm_notes.`,
    });
  }

  // Where the exits of the party's place lead.
  const map = readMap(place.data.map);
  let exits = 0;
  for (const f of map?.features ?? []) {
    if (exits >= MAX_EXIT_TASKS) break;
    if (f.open || !['exit', 'door', 'stairs'].includes(f.kind)) continue;
    const label = f.label ? `"${f.label}"` : `the ${f.kind}`;
    const at = `${label} at ${f.x},${f.y} of ${place.name} (${placeId})`;
    if (typeof f.to === 'string') {
      const dest = view.get(f.to);
      if (!dest || dest.archived || dest.kind !== 'location' || readMap(dest.data.map) || isAncestor(view, dest.id, placeId) || isArea(view, dest)) continue;
      tasks.push({
        key: `map:${dest.id}`,
        text: `Map ${dest.name} (${dest.id}), reached through ${at}: set its data.map from its description (size, walls, doors, furniture, lights), with the exit back to ${place.name} ("to": "${placeId}") where that way arrives. Add a few people who are normally there (npc records with parent_id ${dest.id} and data.pos) and anything worth finding (secrets in gm_notes).`,
      });
      exits++;
    } else if (f.kind === 'exit' || f.label) {
      // An open edge, or a named door or stairs ("guarded gate", "cellar steps"); unnamed doors are cupboards and side rooms.
      tasks.push({
        key: `beyond:${placeId}:${f.x},${f.y}`,
        text: `Create the place beyond ${at}, which leads nowhere yet: a new location (parent_id ${place.parent_id ?? 'the same area'}) with a name, a description, data.map, people normally there and its exit back ("to": "${placeId}"); then set "to" on that exit in ${place.name}'s data.map to the new place (change nothing else on that map).`,
      });
      exits++;
    }
  }
  return tasks.length ? { place_id: placeId, tasks } : null;
}
