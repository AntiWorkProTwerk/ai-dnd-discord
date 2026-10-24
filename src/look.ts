// "Look around": what a player's character can see from where they stand, straight from the saved
// world (no model call). Ways out, notable things, the people in view, and what is publicly known
// about the area, so players choose from the world the GM made instead of guessing at it.
// Player-safe: public data only; hidden features, secret positions and concealed people never show.
import { getMember, getRecord, type Db } from './database.js';
import { CREATURE_KINDS, dbView, hpState, isConcealed, placedIn, placeIdOf, posOf, readMap, type MapFeature, type Position } from './maps.js';
import { sanitize } from './render.js';
import { isSeenPlace, playerCanSee } from './tools.js';
import type { CampaignRow } from './types.js';

const WAYS = new Set(['door', 'exit', 'stairs']);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "north-east" from a step on the grid (y runs down, so smaller y is north). */
function direction(dx: number, dy: number): string {
  if (!dx && !dy) return 'here';
  const ns = dy < -Math.abs(dx) / 2 ? 'north' : dy > Math.abs(dx) / 2 ? 'south' : '';
  const ew = dx > Math.abs(dy) / 2 ? 'east' : dx < -Math.abs(dy) / 2 ? 'west' : '';
  return ns && ew ? `${ns}-${ew}` : ns || ew;
}

/** Distance and direction to the nearest cell of a rectangle, in squares and feet. */
function howFar(from: Position | null, r: { x: number; y: number; w: number; h: number }, cellFt: number): string {
  if (!from) return '';
  const tx = Math.min(Math.max(from.x, r.x), r.x + r.w - 1);
  const ty = Math.min(Math.max(from.y, r.y), r.y + r.h - 1);
  const n = Math.max(Math.abs(tx - from.x), Math.abs(ty - from.y));
  if (n === 0) return ' (where you stand)';
  if (n === 1) return ` (right next to you, ${direction(tx - from.x, ty - from.y)})`;
  return ` (${direction(tx - from.x, ty - from.y)}, ${n} squares / ${n * cellFt} ft)`;
}

export function lookAround(db: Db, campaign: CampaignRow, userId: string, characterId?: string): string {
  const member = getMember(db, campaign.id, userId);
  const id = characterId ?? member?.character_record_id;
  const me = id ? getRecord(db, campaign.id, id) : undefined;
  if (!me) return 'You have no character in this campaign yet. Use `/rpg character` to create one.';
  const view = dbView(db, campaign.id);
  const placeId = placeIdOf(view, me.id);
  const place = placeId ? view.get(placeId) : undefined;
  const placeRow = placeId ? getRecord(db, campaign.id, placeId) : undefined;
  if (!place || !placeId || !placeRow || !playerCanSee(placeRow, userId)) return `**${sanitize(me.name)}** is not anywhere the map knows yet. Ask the GM where you are with \`/rpg play\`.`;

  const area: string[] = [];
  for (let a = place.parent_id ? view.get(place.parent_id) : undefined, n = 0; a && n < 3; a = a.parent_id ? view.get(a.parent_id) : undefined, n++) {
    const row = getRecord(db, campaign.id, a.id);
    if (a.kind === 'location' && row && playerCanSee(row, userId)) area.push(a.name);
  }
  const lines = [`**👀 ${sanitize(me.name)} looks around: ${sanitize(place.name)}**${area.length ? ` (${sanitize(area.join(', '))})` : ''}`];
  const description = typeof place.data.description === 'string' ? place.data.description : '';
  if (description) lines.push(sanitize(clip(description, 400)));

  const map = readMap(place.data.map);
  const mine = posOf(view.get(me.id)!);
  const from = mine; // you know where you stand, hidden or not
  if (map) {
    const ways: string[] = [];
    const things: string[] = [];
    for (const f of map.features as MapFeature[]) {
      const far = howFar(from, f, map.cell_ft);
      if (WAYS.has(f.kind) || f.to) {
        const dest = typeof f.to === 'string' ? getRecord(db, campaign.id, f.to) : undefined;
        const known = dest && playerCanSee(dest, userId) && isSeenPlace(db, campaign.id, dest.id);
        const name = f.label ?? (f.kind === 'stairs' ? 'stairs' : f.kind === 'door' ? 'a door' : 'a way out');
        ways.push(`- ${sanitize(name)}${far}${known ? ` → ${sanitize(dest.name)}` : f.to ? ' → not explored yet' : ''}`);
      } else if (f.label && f.kind !== 'wall') {
        things.push(`- ${sanitize(f.label)}${far}`);
      }
    }
    if (ways.length) lines.push('', '**Ways out**', ...ways.slice(0, 10));
    if (things.length) lines.push('', '**Around you**', ...things.slice(0, 12));
  }

  const people: string[] = [];
  const unplaced: string[] = [];
  for (const r of placedIn(view, placeId)) {
    if (r.id === me.id || !CREATURE_KINDS.has(r.kind) || isConcealed(r.data)) continue;
    const row = getRecord(db, campaign.id, r.id);
    if (!row || !playerCanSee(row, userId)) continue;
    const p = posOf(r);
    if (p?.hidden) continue;
    const state = hpState(r.data) === 'down' ? ' (down)' : '';
    if (p && map) people.push(`- ${sanitize(r.name)}${state}${howFar(from, { x: p.x, y: p.y, w: p.size ?? 1, h: p.size ?? 1 }, map.cell_ft)}`);
    else unplaced.push(`${sanitize(r.name)}${state}`);
  }
  if (people.length || unplaced.length) lines.push('', '**People**', ...people.slice(0, 12), ...(unplaced.length ? [`- also around: ${unplaced.slice(0, 8).join(', ')}`] : []));

  // What is publicly known about the town or region around here.
  for (let a = place.parent_id ? view.get(place.parent_id) : undefined, n = 0; a && n < 3; a = a.parent_id ? view.get(a.parent_id) : undefined, n++) {
    const row = getRecord(db, campaign.id, a.id);
    const notable = Array.isArray(a.data.notable) ? a.data.notable.filter((x): x is string => typeof x === 'string') : [];
    if (!row || !playerCanSee(row, userId) || !notable.length) continue;
    lines.push('', `**Known about ${sanitize(a.name)}**`, sanitize(clip(notable.join('; '), 500)));
    const been = [...new Set(view.childrenOf(a.id).filter((c) => c.kind === 'location' && c.id !== placeId && isSeenPlace(db, campaign.id, c.id)).map((c) => c.name))];
    if (been.length) lines.push(`-# Places you have been here: ${sanitize(been.slice(0, 10).join(', '))}`);
    break;
  }
  lines.push('', '-# Ask about anything else or act with `/rpg play`. The GM decides what is really there.');
  return clip(lines.join('\n'), 1900);
}
