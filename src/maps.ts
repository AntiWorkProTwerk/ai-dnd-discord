// World maps: every place (a location record) has a saved grid map with terrain and exits, and
// everyone in it a saved position (`data.pos` on the creature), so distances, movement and
// pictures stay consistent forever. Plus a deterministic renderer. Maps are drawn from public data
// only; hidden creatures and terrain live in gm_notes and are never drawn. No AI is involved.
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { getRecord, type Db } from './database.js';
import type { RecordRow, TurnRow } from './types.js';

export const FEATURE_KINDS = ['wall', 'door', 'cover', 'difficult', 'water', 'pit', 'object', 'stairs', 'light', 'exit'] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

export interface MapFeature {
  kind: FeatureKind;
  label?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** An exit (door, stairs, open edge): the id of the location it leads to. */
  to?: string;
}

export interface SceneMap {
  cols: number;
  rows: number;
  cell_ft: number;
  features: MapFeature[];
}

export interface Position {
  x: number;
  y: number;
  size?: number;
}

const MAX_CELLS = 2400;
/** Cells nobody can stand in. Furniture you can hide behind is `cover`, which is passable. */
const BLOCKING = new Set<string>(['wall', 'object']);
const MAX_SIDE = 60;
const MAX_FEATURES = 60;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

// ---------------------------------------------------------------- validation

function featureProblems(where: string, raw: unknown, map: { cols: number; rows: number }): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [`${where} must be an array`];
  if (raw.length > MAX_FEATURES) return [`${where} has ${raw.length} entries; at most ${MAX_FEATURES}`];
  const out: string[] = [];
  raw.forEach((f, i) => {
    const o = obj(f);
    if (!o) return void out.push(`${where}[${i}] must be an object {kind,label,x,y,w,h}`);
    if (!FEATURE_KINDS.includes(o.kind as FeatureKind)) out.push(`${where}[${i}].kind must be one of ${FEATURE_KINDS.join(', ')}`);
    if (o.label !== undefined && (typeof o.label !== 'string' || o.label.length > 60)) out.push(`${where}[${i}].label must be text of at most 60 characters`);
    if (!isInt(o.x, 0, map.cols - 1) || !isInt(o.y, 0, map.rows - 1) || !isInt(o.w, 1, map.cols) || !isInt(o.h, 1, map.rows)) {
      out.push(`${where}[${i}] needs integer x,y,w,h inside the ${map.cols}x${map.rows} grid`);
    } else if ((o.x as number) + (o.w as number) > map.cols || (o.y as number) + (o.h as number) > map.rows) {
      out.push(`${where}[${i}] extends past the ${map.cols}x${map.rows} grid`);
    }
  });
  return out;
}

/** Parses a valid map, or null. */
export function readMap(raw: unknown): SceneMap | null {
  const m = obj(raw);
  if (!m || !isInt(m.cols, 1, MAX_SIDE) || !isInt(m.rows, 1, MAX_SIDE)) return null;
  const features = Array.isArray(m.features) ? (m.features as MapFeature[]).filter((f) => obj(f) && FEATURE_KINDS.includes(f.kind)) : [];
  return { cols: m.cols, rows: m.rows, cell_ft: typeof m.cell_ft === 'number' && m.cell_ft > 0 ? m.cell_ft : 5, features };
}

export function readPositions(raw: unknown): Map<string, Position> {
  const out = new Map<string, Position>();
  const o = obj(raw);
  if (!o) return out;
  for (const [id, v] of Object.entries(o)) {
    const p = obj(v);
    if (p && typeof p.x === 'number' && typeof p.y === 'number') out.set(id, { x: p.x, y: p.y, size: typeof p.size === 'number' ? p.size : 1 });
  }
  return out;
}

const footprint = (p: Position) => {
  const cells: [number, number][] = [];
  const s = p.size ?? 1;
  for (let dx = 0; dx < s; dx++) for (let dy = 0; dy < s; dy++) cells.push([p.x + dx, p.y + dy]);
  return cells;
};

// ---------------------------------------------------------------- places

/** What validation needs of a record, as it will be after the batch. */
export interface PlaceRecord {
  id: string;
  kind: string;
  name: string;
  parent_id: string | null;
  visibility: string;
  archived: boolean;
  data: Record<string, unknown>;
  gm_notes: Record<string, unknown>;
}

/** Reads records as they will be after a batch: `get` one, or `childrenOf` a record. */
export interface WorldView {
  get(id: string): PlaceRecord | undefined;
  childrenOf(id: string): PlaceRecord[];
}

export const CREATURE_KINDS = new Set(['character', 'npc']);

/** The place a record is in: its nearest location ancestor (a character inside a scene or a cart counts as in that scene's place). */
export function placeIdOf(view: Pick<WorldView, 'get'>, id: string): string | null {
  let cur = view.get(id)?.parent_id ?? null;
  for (let depth = 0; cur && depth < 12; depth++) {
    const r = view.get(cur);
    if (!r) return null;
    if (r.kind === 'location') return r.id;
    cur = r.parent_id;
  }
  return null;
}

/** A record's position on its place's map: public `data.pos`, else a secret `gm_notes.pos`. */
export function posOf(r: Pick<PlaceRecord, 'data' | 'gm_notes'>): (Position & { hidden: boolean }) | null {
  for (const [raw, hidden] of [[r.data.pos, false], [r.gm_notes.pos, true]] as const) {
    const p = obj(raw);
    if (p && typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y, size: typeof p.size === 'number' ? p.size : 1, hidden };
  }
  return null;
}

/** Everything placed in a place (records whose nearest location is it), walking through scenes and containers. */
export function placedIn(view: WorldView, placeId: string): PlaceRecord[] {
  const out: PlaceRecord[] = [];
  const walk = (id: string, depth: number) => {
    for (const c of view.childrenOf(id)) {
      if (c.archived) continue;
      if (c.kind === 'location') continue; // a place inside this place has its own map
      out.push(c);
      if (depth < 4) walk(c.id, depth + 1);
    }
  };
  walk(placeId, 0);
  return out;
}

/** Cells nobody can stand in. */
export function blockedCells(map: SceneMap): Set<string> {
  const out = new Set<string>();
  for (const f of map.features) if (BLOCKING.has(f.kind)) for (let x = f.x; x < f.x + f.w; x++) for (let y = f.y; y < f.y + f.h; y++) out.add(`${x},${y}`);
  return out;
}

/**
 * Length in moves of the shortest open path between two cells (diagonals allowed, one move each,
 * like 5 ft squares), going around walls and objects. Null when there is no way through.
 */
export function pathLength(map: SceneMap, blocked: Set<string>, from: { x: number; y: number }, to: { x: number; y: number }): number | null {
  if (from.x === to.x && from.y === to.y) return 0;
  const seen = new Set<string>([`${from.x},${from.y}`]);
  let frontier = [from];
  for (let steps = 1; frontier.length && steps <= map.cols * map.rows; steps++) {
    const next: { x: number; y: number }[] = [];
    for (const c of frontier) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const x = c.x + dx;
          const y = c.y + dy;
          const k = `${x},${y}`;
          if ((!dx && !dy) || x < 0 || y < 0 || x >= map.cols || y >= map.rows || seen.has(k) || blocked.has(k)) continue;
          // No squeezing diagonally between two blocked cells (the corner of a wall).
          if (dx && dy && blocked.has(`${c.x + dx},${c.y}`) && blocked.has(`${c.x},${c.y + dy}`)) continue;
          if (x === to.x && y === to.y) return steps;
          seen.add(k);
          next.push({ x, y });
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** Walking speed in feet: `data.speed` as a number or `{walk}`, default 30. */
export function speedFt(data: Record<string, unknown>): number {
  const s = data.speed;
  if (typeof s === 'number' && s > 0) return s;
  const w = obj(s)?.walk;
  return typeof w === 'number' && w > 0 ? w : 30;
}

function mapShapeProblems(at: string, raw: unknown, gmFeatures: unknown, view: Pick<WorldView, 'get'>): string[] {
  const m = obj(raw);
  if (!m || !isInt(m.cols, 1, MAX_SIDE) || !isInt(m.rows, 1, MAX_SIDE)) return [`${at}: data.map needs integer cols and rows between 1 and ${MAX_SIDE}`];
  const out: string[] = [];
  if ((m.cols as number) * (m.rows as number) > MAX_CELLS) out.push(`${at}: data.map is ${m.cols}x${m.rows}; at most ${MAX_CELLS} cells. Split a big area into several connected places (exits).`);
  if (m.cell_ft !== undefined && !(typeof m.cell_ft === 'number' && m.cell_ft >= 5 && m.cell_ft <= 30)) out.push(`${at}: data.map.cell_ft must be between 5 and 30 feet`);
  const grid = { cols: m.cols as number, rows: m.rows as number };
  out.push(...featureProblems(`${at}: data.map.features`, m.features, grid));
  out.push(...featureProblems(`${at}: gm_notes.map_features`, gmFeatures, grid));
  for (const [where, list] of [['data.map.features', m.features], ['gm_notes.map_features', gmFeatures]] as const) {
    if (!Array.isArray(list)) continue;
    list.forEach((f, i) => {
      const to = obj(f)?.to;
      if (to === undefined || to === null) return;
      const dest = typeof to === 'string' ? view.get(to) : undefined;
      if (!dest || dest.archived || dest.kind !== 'location') out.push(`${at}: ${where}[${i}].to must be the id of a live location (where this exit leads)`);
    });
  }
  return out;
}

/**
 * World-map checks for a batch: place maps are well formed, positions sit on their place's map in
 * open cells (one creature per cell), and creatures that walk somewhere within a place have an open
 * path, no longer than a dash (2x speed) while they are in a fight. Only what the batch changes is
 * checked, so old data never blocks unrelated saves. Returns actionable messages for the GM.
 */
export function placeProblems(view: WorldView, changed: PlaceRecord[], before: (id: string) => PlaceRecord | undefined, inFight: (id: string) => boolean): string[] {
  const out: string[] = [];
  const places = new Set<string>();
  for (const r of changed) {
    if (r.kind === 'location') places.add(r.id);
    const p = placeIdOf(view, r.id);
    if (p) places.add(p);
    if (r.kind === 'scene') {
      const b = before(r.id);
      for (const key of ['map', 'positions'] as const) {
        if (r.data[key] !== undefined && JSON.stringify(r.data[key]) !== JSON.stringify(b?.data[key])) {
          out.push(`scene ${r.name}: maps and positions belong to places now, not scenes. Set data.map on the location (${p ?? 'the scene\'s location'}) and data.pos {x, y} on each character or npc there.`);
        }
      }
      if (r.gm_notes.positions !== undefined && JSON.stringify(r.gm_notes.positions) !== JSON.stringify(b?.gm_notes.positions)) {
        out.push(`scene ${r.name}: hidden positions go in gm_notes.pos on each hidden creature, not on the scene.`);
      }
    }
  }
  const changedIds = new Set(changed.map((r) => r.id));
  for (const placeId of places) {
    const place = view.get(placeId);
    if (!place || place.archived) continue;
    const at = `place ${place.name}`;
    const mapChanged = changedIds.has(placeId) && JSON.stringify(place.data.map) !== JSON.stringify(before(placeId)?.data.map);
    const rawMap = place.data.map;
    if (rawMap !== undefined && rawMap !== null && (changedIds.has(placeId))) out.push(...mapShapeProblems(at, rawMap, place.gm_notes.map_features, view));
    const map = readMap(rawMap);
    const blocked = map ? blockedCells(map) : new Set<string>();
    const occupied = new Map<string, string>();
    for (const r of placedIn(view, placeId)) {
      const pos = posOf(r);
      if (!pos) continue;
      const mine = changedIds.has(r.id) || mapChanged;
      if (!map) {
        if (mine) out.push(`${r.name} (${r.id}) has a position but ${place.name} (${placeId}) has no map yet; set its data.map in this save`);
        continue;
      }
      const creature = CREATURE_KINDS.has(r.kind);
      const size = pos.size ?? 1;
      if (!isInt(pos.x, 0, map.cols - 1) || !isInt(pos.y, 0, map.rows - 1) || !isInt(size, 1, 4) || pos.x + size > map.cols || pos.y + size > map.rows) {
        if (mine) out.push(`${at}: ${r.name} (${r.id}) needs whole-cell x 0-${map.cols - 1}, y 0-${map.rows - 1} (and size 1-4) inside the ${map.cols}x${map.rows} map`);
        continue;
      }
      if (!creature) continue; // items may sit on tables and share cells
      for (const [x, y] of footprint(pos)) {
        if (blocked.has(`${x},${y}`)) {
          if (mine) out.push(`${at}: ${r.name} (${r.id}) stands inside a wall or object at ${x},${y}; pick an open cell next to it`);
          break;
        }
        const other = occupied.get(`${x},${y}`);
        if (other && other !== r.id) {
          if (mine || changedIds.has(other)) out.push(`${at}: ${r.name} (${r.id}) and ${other} share cell ${x},${y}; one creature per cell`);
          break;
        }
        occupied.set(`${x},${y}`, r.id);
      }
      // Walking within the same place: there must be a way through, and in a fight it is one turn's move.
      const b = before(r.id);
      const from = b ? posOf(b) : null;
      if (!changedIds.has(r.id) || !from || !b || placeIdOf({ get: (id) => (id === r.id ? b : view.get(id)) }, r.id) !== placeId) continue;
      if (from.x === pos.x && from.y === pos.y) continue;
      const steps = pathLength(map, blocked, from, pos);
      if (steps === null) {
        out.push(`${at}: ${r.name} cannot get from ${from.x},${from.y} to ${pos.x},${pos.y}: walls or objects are in the way and there is no open path. Use a door or exit, or pick a reachable cell.`);
      } else if (inFight(r.id)) {
        const limit = Math.floor((2 * speedFt(r.data)) / map.cell_ft);
        if (steps > limit) {
          out.push(`${at}: ${r.name} moved ${steps * map.cell_ft} ft (${from.x},${from.y} to ${pos.x},${pos.y}); in a fight that is more than a dash (${limit * map.cell_ft} ft). Stop them part of the way.`);
        }
      }
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- snapshot (public only)

export type HpState = 'ok' | 'wounded' | 'down';

export interface MapToken {
  id: string;
  name: string;
  initials: string;
  kind: string;
  color: string;
  x: number;
  y: number;
  size: number;
  hp: HpState;
  isTurn: boolean;
  /** Joined the fight mid-round: acts at the end of the round (drawn faded). */
  waiting?: boolean;
}

export interface MapSnapshot {
  scene_id: string;
  scene_name: string;
  cols: number;
  rows: number;
  cell_ft: number;
  features: MapFeature[];
  tokens: MapToken[];
  round: number | null;
  turn_of: string | null;
  /** No battle map: a layout made up from who is there (positions are only approximate). */
  sketch?: boolean;
  /** The location this is the map of. */
  place_id?: string;
}

const COOL = ['#2f6fdf', '#1f9e8f', '#7a4fd6', '#2b8a3e', '#0b7fa8', '#5465ff'];
const WARM = ['#d9480f', '#c92a2a', '#b8860b', '#a61e4d', '#e8590c', '#8f5a2a'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable token color for a record: cool for player characters, warm for everyone else. */
export function tokenColor(id: string, kind: string): string {
  const palette = kind === 'character' ? COOL : WARM;
  return palette[hash(id) % palette.length]!;
}

export function hpState(data: Record<string, unknown>): HpState {
  const hp = obj(data.hp);
  if (hp && typeof hp.current === 'number' && typeof hp.max === 'number' && hp.max > 0) {
    if (hp.current <= 0) return 'down';
    if (hp.current / hp.max <= 0.5) return 'wounded';
  }
  return 'ok';
}

export function initialsFor(names: { id: string; name: string }[]): Map<string, string> {
  const base = (n: string) => {
    const words = n.replace(/^(the|a|an)\s+/i, '').split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
    if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
    return (words[0] ?? '?').slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  };
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const { id, name } of names) {
    const b = base(name);
    const n = (seen.get(b) ?? 0) + 1;
    seen.set(b, n);
    out.set(id, n === 1 ? b : `${b}${n}`);
  }
  return out;
}

const HIDDEN_CONDITIONS = /^(hidden|invisible|unseen|concealed)$/i;

/** A creature players cannot currently see (condition hidden, invisible, …). */
export function isConcealed(data: Record<string, unknown>): boolean {
  return Array.isArray(data.conditions) && data.conditions.some((c) => typeof c === 'string' && HIDDEN_CONDITIONS.test(c));
}

/** Records as they are in the database (no pending batch). */
export function dbView(db: Db, campaignId: string): WorldView {
  const toPlace = (r: RecordRow): PlaceRecord => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    parent_id: r.parent_id,
    visibility: r.visibility,
    archived: !!r.archived_at,
    data: JSON.parse(r.data_json) as Record<string, unknown>,
    gm_notes: JSON.parse(r.gm_notes_json || '{}') as Record<string, unknown>,
  });
  return {
    get: (id) => {
      const r = getRecord(db, campaignId, id);
      return r ? toPlace(r) : undefined;
    },
    childrenOf: (id) => (db.prepare('SELECT * FROM records WHERE campaign_id = ? AND parent_id = ? AND archived_at IS NULL').all(campaignId, id) as RecordRow[]).map(toPlace),
  };
}

/** The place a scene happens in: where its characters are, else the scene's own location. */
export function scenePlaceId(view: WorldView, scene: Pick<RecordRow, 'id' | 'data_json'>): string | null {
  const ids = (JSON.parse(scene.data_json) as { participants_ids?: unknown }).participants_ids;
  const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  for (const kind of ['character', 'npc']) {
    for (const id of list) {
      if (view.get(id)?.kind !== kind) continue;
      const p = placeIdOf(view, id);
      if (p) return p;
    }
  }
  return placeIdOf(view, scene.id);
}

/** The public map of the place a scene happens in (with the scene's fight state), or null when it has none. Never reads gm_notes. */
export function mapSnapshot(db: Db, campaignId: string, scene: RecordRow | undefined): MapSnapshot | null {
  if (!scene || scene.visibility !== 'public' || scene.archived_at) return null;
  const view = dbView(db, campaignId);
  const placeId = scenePlaceId(view, scene);
  return placeId ? placeSnapshot(db, campaignId, placeId, scene) : null;
}

/** The public map of a place: its saved map and everyone visible standing on it. */
export function placeSnapshot(db: Db, campaignId: string, placeId: string, scene?: RecordRow): MapSnapshot | null {
  const view = dbView(db, campaignId);
  const place = view.get(placeId);
  if (!place || place.archived || place.visibility !== 'public') return null;
  const map = readMap(place.data.map);
  if (!map) return null;
  const data = scene ? (JSON.parse(scene.data_json) as Record<string, unknown>) : {};
  const entries = placedIn(view, placeId)
    .filter((r) => CREATURE_KINDS.has(r.kind) && r.visibility === 'public' && !isConcealed(r.data))
    .map((r) => ({ r, p: posOf(r) }))
    .filter((e): e is { r: PlaceRecord; p: Position & { hidden: boolean } } => !!e.p && !e.p.hidden);
  const initials = initialsFor(entries.map((e) => ({ id: e.r.id, name: e.r.name })));
  const turnOf = typeof data.turn_of_id === 'string' ? data.turn_of_id : null;
  const waiting = new Set(
    (Array.isArray(data.initiative) ? (data.initiative as unknown[]) : [])
      .map((e) => obj(e))
      .filter((e): e is Record<string, unknown> => !!e && e.waiting === true && typeof e.id === 'string')
      .map((e) => e.id as string),
  );
  const destName = (id: unknown) => (typeof id === 'string' ? view.get(id) : undefined);
  return {
    scene_id: scene?.id ?? '',
    scene_name: place.name,
    place_id: place.id,
    cols: map.cols,
    rows: map.rows,
    cell_ft: map.cell_ft,
    features: map.features.map((f) => {
      const dest = destName(f.to);
      const label = f.label ? String(f.label).slice(0, 32) : dest && dest.visibility === 'public' ? `to ${dest.name}`.slice(0, 32) : undefined;
      return { kind: f.kind, x: f.x, y: f.y, w: f.w, h: f.h, ...(label ? { label } : {}) };
    }),
    tokens: entries.map(({ r, p }) => ({
      id: r.id,
      name: r.name,
      initials: initials.get(r.id)!,
      kind: r.kind,
      color: tokenColor(r.id, r.kind),
      x: p.x,
      y: p.y,
      size: p.size ?? 1,
      hp: hpState(r.data),
      isTurn: r.id === turnOf,
      ...(waiting.has(r.id) && r.id !== turnOf ? { waiting: true } : {}),
    })),
    round: typeof data.round === 'number' ? data.round : null,
    turn_of: turnOf ? (entries.find((e) => e.r.id === turnOf)?.r.name ?? null) : null,
  };
}

// ---------------------------------------------------------------- migration

/**
 * Moves battle maps saved on scenes (before maps belonged to places) to the scene's place, and the
 * scene's positions onto the people in it. Idempotent; run at startup. A place that already has a
 * map keeps it. Returns how many scenes were migrated.
 */
export function migrateSceneMaps(db: Db): number {
  const rows = db
    .prepare(
      `SELECT * FROM records WHERE kind = 'scene' AND (json_extract(data_json, '$.map') IS NOT NULL OR json_extract(data_json, '$.positions') IS NOT NULL
         OR json_extract(gm_notes_json, '$.positions') IS NOT NULL OR json_extract(gm_notes_json, '$.map_features') IS NOT NULL)`,
    )
    .all() as RecordRow[];
  // Live scenes first, newest first: their map is the place as it is now.
  const live = (r: RecordRow) => !r.archived_at && ['active', undefined].includes((JSON.parse(r.data_json) as { status?: string }).status);
  rows.sort((a, b) => Number(live(b)) - Number(live(a)) || b.updated_at.localeCompare(a.updated_at));
  const save = db.prepare('UPDATE records SET data_json = ?, gm_notes_json = ?, version = version + 1, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const scene of rows) {
      const view = dbView(db, scene.campaign_id);
      const data = JSON.parse(scene.data_json) as Record<string, unknown>;
      const gm = JSON.parse(scene.gm_notes_json || '{}') as Record<string, unknown>;
      const placeId = placeIdOf(view, scene.id) ?? scenePlaceId(view, scene);
      const place = placeId ? view.get(placeId) : undefined;
      if (place && readMap(data.map) && !readMap(place.data.map)) {
        const pg = { ...place.gm_notes, ...(Array.isArray(gm.map_features) && gm.map_features.length ? { map_features: gm.map_features } : {}) };
        save.run(JSON.stringify({ ...place.data, map: data.map }), JSON.stringify(pg), now, place.id);
      }
      for (const [field, hidden] of [[data.positions, false], [gm.positions, true]] as const) {
        for (const [id, p] of readPositions(field)) {
          const rec = view.get(id);
          if (!rec || rec.archived || !place || placeIdOf(view, id) !== place.id || posOf(rec)) continue;
          const pos = { x: p.x, y: p.y, ...((p.size ?? 1) > 1 ? { size: p.size } : {}) };
          if (hidden) save.run(JSON.stringify(rec.data), JSON.stringify({ ...rec.gm_notes, pos }), now, id);
          else save.run(JSON.stringify({ ...rec.data, pos }), JSON.stringify(rec.gm_notes), now, id);
        }
      }
      const { map: _m, positions: _p, ...restData } = data;
      const { positions: _gp, map_features: _gf, ...restGm } = gm;
      save.run(JSON.stringify(restData), JSON.stringify(restGm), now, scene.id);
    }
  })();
  return rows.length;
}

// ---------------------------------------------------------------- ASCII map for the GM's context

const ASCII: Record<FeatureKind, string> = { wall: '#', door: '+', cover: '%', difficult: '^', water: '~', pit: 'O', object: '*', stairs: '=', light: '.', exit: '>' };

/**
 * A compact text map of a place for the GM: initials on the grid, a legend with distances from the
 * actor, exits and where they lead, and items lying about. The GM sees gm_notes anyway, so hidden
 * creatures and features are included and marked.
 */
export function asciiMap(db: Db, campaignId: string, placeId: string, actorId: string | null): string | null {
  const view = dbView(db, campaignId);
  const place = view.get(placeId);
  if (!place) return null;
  const map = readMap(place.data.map);
  if (!map) return null;
  const hiddenFeatures = Array.isArray(place.gm_notes.map_features) ? (place.gm_notes.map_features as MapFeature[]).filter((f) => obj(f) && FEATURE_KINDS.includes(f.kind)) : [];
  const placed = placedIn(view, placeId)
    .map((r) => ({ r, p: posOf(r) }))
    .filter((e): e is { r: PlaceRecord; p: Position & { hidden: boolean } } => !!e.p);
  const creatures = placed.filter((e) => CREATURE_KINDS.has(e.r.kind));
  const items = placed.filter((e) => !CREATURE_KINDS.has(e.r.kind));
  const initials = initialsFor(creatures.map((e) => ({ id: e.r.id, name: e.r.name })));
  const lines: string[] = [`${map.cols}x${map.rows} grid, ${map.cell_ft} ft per cell, x right, y down, origin top-left.`];
  if (map.cols * map.rows <= 900) {
    const grid = Array.from({ length: map.rows }, () => Array.from({ length: map.cols }, () => ' .'));
    for (const f of [...map.features, ...hiddenFeatures]) for (let x = f.x; x < f.x + f.w; x++) for (let y = f.y; y < f.y + f.h; y++) if (grid[y]?.[x]) grid[y]![x] = ` ${ASCII[f.kind]}`;
    for (const { p } of items) if (grid[p.y]?.[p.x]) grid[p.y]![p.x] = ' i';
    for (const { r, p } of creatures) for (const [x, y] of footprint(p)) if (grid[y]?.[x]) grid[y]![x] = initials.get(r.id)!.slice(0, 2).padStart(2);
    lines.push(...grid.map((row) => row.join('')));
    lines.push('Terrain: # wall, + door, % cover, ^ difficult, ~ water, O pit, * object, = stairs, > exit, i item');
  }
  const actor = creatures.find((e) => e.r.id === actorId);
  const dist = (p: Position) => (actor && p !== actor.p ? `, ${Math.max(Math.abs(p.x - actor.p.x), Math.abs(p.y - actor.p.y)) * map.cell_ft} ft from the actor` : '');
  for (const { r, p } of creatures) {
    const hidden = p.hidden || r.visibility !== 'public' || isConcealed(r.data);
    lines.push(`${initials.get(r.id)} = ${r.name} (${r.id}) at ${p.x},${p.y}${(p.size ?? 1) > 1 ? ` size ${p.size}` : ''}${hidden ? ' [hidden from players]' : ''}${dist(p)}`);
  }
  const unplaced = placedIn(view, placeId).filter((r) => CREATURE_KINDS.has(r.kind) && !posOf(r));
  if (unplaced.length) lines.push(`Not placed yet (give them data.pos when they come into the story): ${unplaced.map((r) => `${r.name} (${r.id})`).join(', ')}`);
  for (const { r, p } of items) lines.push(`item ${r.name} (${r.id}) at ${p.x},${p.y}${p.hidden ? ' [hidden from players]' : ''}${dist(p)}`);
  const ways = new Set(['door', 'exit', 'stairs']);
  for (const f of [...map.features.map((f) => ({ f, h: false })), ...hiddenFeatures.map((f) => ({ f, h: true }))].filter((x) => x.f.label || x.h || x.f.to || ways.has(x.f.kind))) {
    const dest = typeof f.f.to === 'string' ? view.get(f.f.to) : undefined;
    const where = dest ? ` -> leads to ${dest.name} (${dest.id})` : ways.has(f.f.kind) ? ' -> unlinked: set "to" to the location it leads to (create it if new) when it matters' : '';
    lines.push(`${f.f.kind}${f.f.label ? ` "${f.f.label}"` : ''} at ${f.f.x},${f.f.y} ${f.f.w}x${f.f.h}${where}${f.h ? ' [hidden: gm_notes]' : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- SVG / PNG

// Two maps share one layout (title strip, grid, legend on the right) and the helpers below:
// the flat tactical map drawn here, and the 3D map, a top-down Blender render of the scene with
// the same grid, labels and token marks drawn over it (composeMapPng).
const CELL = 48;
const LEGEND_W = 300;
const HEADER = 52;
const FONT = "'Segoe UI', Arial, sans-serif";
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FEATURE_STYLE: Record<FeatureKind, string> = {
  wall: 'fill="#3b3b44"',
  door: 'fill="#8b5a2b"',
  cover: 'fill="#8d8d8d" fill-opacity="0.55"',
  difficult: 'fill="url(#hatch)"',
  water: 'fill="#4a8fd4" fill-opacity="0.75"',
  pit: 'fill="#161616" stroke="#5c4a32" stroke-width="3"',
  object: 'fill="#7a6a55" fill-opacity="0.85"',
  stairs: 'fill="url(#stairs)"',
  light: 'fill="#ffe9a8" fill-opacity="0.45"',
  exit: 'fill="#e0b84a" fill-opacity="0.3" stroke="#e0b84a" stroke-width="2" stroke-dasharray="6 4"',
};

/** Size of the whole map image in map units (one cell is CELL units). */
function mapLayout(s: MapSnapshot): { gw: number; gh: number; width: number; height: number } {
  const gw = s.cols * CELL;
  const gh = s.rows * CELL;
  const legendH = 104 + s.tokens.length * 36;
  return { gw, gh, width: gw + LEGEND_W, height: HEADER + Math.max(gh, legendH) + 12 };
}

/** The opening tag, patterns, background and title strip (scene name, round, whose turn). */
function mapFrame(o: string[], s: MapSnapshot, width: number, height: number): void {
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">`);
  o.push(
    '<defs>',
    '<pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="10" fill="#c8a978" fill-opacity="0.35"/><line x1="0" y1="0" x2="0" y2="10" stroke="#8a6a3a" stroke-width="3"/></pattern>',
    '<pattern id="stairs" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#b9b2a3"/><line x1="0" y1="11" x2="12" y2="11" stroke="#6d675c" stroke-width="2"/></pattern>',
    '</defs>',
  );
  o.push(`<rect width="${width}" height="${height}" fill="#24232b"/>`);
  const status = [s.round !== null && s.round > 0 ? `Round ${s.round}` : '', s.turn_of ? `${s.turn_of}'s turn` : ''].filter(Boolean).join(' · ');
  o.push(`<text x="16" y="35" font-size="26" font-weight="700" fill="#f1ede4">${esc(s.scene_name.slice(0, 48))}</text>`);
  if (status) o.push(`<text x="${width - 16}" y="35" font-size="22" font-weight="700" fill="#ffcc33" text-anchor="end">${esc(status)}</text>`);
}

/** Grid lines, every fifth one stronger. */
function gridLines(o: string[], s: MapSnapshot, stroke: string, [minor, major]: [number, number]): void {
  const gw = s.cols * CELL;
  const gh = s.rows * CELL;
  const line = (i: number, x1: number, y1: number, x2: number, y2: number) =>
    o.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-opacity="${i % 5 === 0 ? major : minor}" stroke-width="${i % 5 === 0 ? 1.6 : 1}"/>`);
  for (let c = 0; c <= s.cols; c++) line(c, c * CELL, 0, c * CELL, gh);
  for (let r = 0; r <= s.rows; r++) line(r, 0, r * CELL, gw, r * CELL);
}

type Placed = { x: number; y: number; w: number }[];

/**
 * A text label on a dark pill so it stays readable over terrain, centered at cx,cy. Skipped (false)
 * where it would collide with a pill already placed.
 */
function pill(o: string[], drawn: Placed, cx: number, cy: number, text: string, opts: { color?: string; opacity?: number } = {}): boolean {
  const w = text.length * 8.4 + 14;
  if (drawn.some((d) => Math.abs(d.x - cx) < (d.w + w) / 2 && Math.abs(d.y - cy) < 24)) return false;
  drawn.push({ x: cx, y: cy, w });
  const g = opts.opacity !== undefined ? `<g opacity="${opts.opacity}">` : '';
  o.push(`${g}<rect x="${cx - w / 2}" y="${cy - 11}" width="${w}" height="22" rx="11" fill="#1f1d24" fill-opacity="0.72"/>`);
  o.push(`<text x="${cx}" y="${cy + 5}" font-size="14" fill="${opts.color ?? '#f6f1e6'}" text-anchor="middle">${esc(text)}</text>${g ? '</g>' : ''}`);
  return true;
}

/** Feature labels: walls are obvious and unlabeled; each label text is drawn once. */
function featureLabels(o: string[], s: MapSnapshot, drawn: Placed): void {
  const seen = new Set<string>();
  for (const f of s.features) {
    if (!f.label || f.kind === 'wall' || seen.has(f.label.toLowerCase())) continue;
    if (pill(o, drawn, (f.x + f.w / 2) * CELL, (f.y + f.h / 2) * CELL, f.label.slice(0, 24))) seen.add(f.label.toLowerCase());
  }
}

/** Token center and radius in map units. A token sits at its top-left cell and spans `size` cells. */
const tokenGeom = (t: MapToken) => ({ cx: (t.x + t.size / 2) * CELL, cy: (t.y + t.size / 2) * CELL, r: t.size * CELL * 0.4 });
/** Larger creatures under smaller ones. */
const drawOrder = (s: MapSnapshot) => [...s.tokens].sort((a, b) => b.size - a.size);
const turnHalo = (o: string[], cx: number, cy: number, r: number) => o.push(`<circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="none" stroke="#ffcc33" stroke-width="5"/>`);
const downCross = (o: string[], cx: number, cy: number, r: number) => {
  const d = r * 0.75;
  o.push(`<path d="M${cx - d} ${cy - d} L${cx + d} ${cy + d} M${cx + d} ${cy - d} L${cx - d} ${cy + d}" stroke="#2b2b2b" stroke-width="4"/>`);
};

/** The legend: each token with its state, the scale, and the footnote for faded tokens. */
function legend(o: string[], s: MapSnapshot, gw: number): void {
  o.push(`<g transform="translate(${gw + 18} ${HEADER})">`);
  o.push(`<text x="0" y="24" font-size="20" font-weight="700" fill="#f1ede4">Legend</text>`);
  s.tokens.forEach((t, i) => {
    const y = 56 + i * 36;
    const state = [t.hp === 'down' ? 'down' : t.hp === 'wounded' ? 'wounded' : '', t.waiting ? 'waiting' : ''].filter(Boolean).join(', ');
    o.push(`<circle cx="14" cy="${y}" r="14" fill="${t.hp === 'down' ? '#8a8a8a' : t.color}" ${t.isTurn ? 'stroke="#ffcc33" stroke-width="3"' : ''}/>`);
    o.push(`<text x="14" y="${y + 5}" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(t.initials)}</text>`);
    o.push(
      `<text x="38" y="${y + 6}" font-size="18" fill="${t.isTurn ? '#ffcc33' : '#f1ede4'}" font-weight="${t.isTurn ? 700 : 400}">${esc(t.name.slice(0, 20))}${state ? `<tspan dx="8" fill="#ff9f43" font-size="15">${state}</tspan>` : ''}</text>`,
    );
  });
  o.push(`<text x="0" y="${66 + s.tokens.length * 36}" font-size="15" fill="#a9a39a">1 square = ${s.cell_ft} ft</text>`);
  const notes = [s.tokens.some((t) => t.waiting) ? 'Faded: joined mid-round, acts at the end' : '', s.sketch ? 'This place has no map yet: positions are approximate' : ''].filter(Boolean);
  notes.forEach((n, i) => o.push(`<text x="0" y="${90 + s.tokens.length * 36 + i * 22}" font-size="15" fill="#a9a39a">${n}</text>`));
  o.push('</g>');
}

/** Deterministic top-down tactical map with tokens and a legend. */
export function renderMapSvg(s: MapSnapshot): string {
  const { gw, gh, width, height } = mapLayout(s);
  const o: string[] = [];
  mapFrame(o, s, width, height);
  o.push(`<g transform="translate(0 ${HEADER})">`);
  o.push(`<rect width="${gw}" height="${gh}" fill="#e9e4d8"/>`);
  for (const f of s.features) {
    const x = f.x * CELL;
    const y = f.y * CELL;
    const w = f.w * CELL;
    const h = f.h * CELL;
    if (f.kind === 'light') o.push(`<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${FEATURE_STYLE.light}/>`);
    else if (f.kind === 'door') o.push(`<rect x="${x + 4}" y="${y + 4}" width="${w - 8}" height="${h - 8}" rx="4" ${FEATURE_STYLE.door}/>`);
    else o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" ${FEATURE_STYLE[f.kind]}/>`);
  }
  gridLines(o, s, '#9b9384', [0.45, 0.9]);
  featureLabels(o, s, []);
  // Tokens: a filled disc with initials; the active turn gets a halo.
  for (const t of drawOrder(s)) {
    const { cx, cy, r } = tokenGeom(t);
    if (t.isTurn) turnHalo(o, cx, cy, r);
    const fill = t.hp === 'down' ? '#8a8a8a' : t.color;
    const ring = t.waiting ? 'stroke="#ffffff" stroke-width="3" stroke-dasharray="6 5"' : t.hp === 'wounded' ? 'stroke="#ff8c1a" stroke-width="4"' : 'stroke="#ffffff" stroke-width="2"';
    o.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${ring}${t.waiting ? ' fill-opacity="0.4"' : ''}/>`);
    o.push(`<text${t.waiting ? ' fill-opacity="0.7"' : ''} x="${cx}" y="${cy + r * 0.36}" font-size="${Math.round(r * 0.95)}" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(t.initials)}</text>`);
    if (t.hp === 'down') downCross(o, cx, cy, r);
  }
  o.push('</g>');
  legend(o, s, gw);
  o.push('</svg>');
  return o.join('\n');
}

/**
 * The 3D map: the same layout as renderMapSvg, with a top-down render of the scene (`baseHref`,
 * covering the grid exactly) in place of the flat terrain, and the information drawn over it: a
 * faint grid, a ring per token in its color (the figure stays visible inside), name pills,
 * wounded/down marks, the turn halo, and waiting tokens dashed and faded.
 */
export function renderMapOverlaySvg(s: MapSnapshot, baseHref: string): string {
  const { gw, gh, width, height } = mapLayout(s);
  const o: string[] = [];
  mapFrame(o, s, width, height);
  o.push(`<g transform="translate(0 ${HEADER})">`);
  o.push(`<image href="${esc(baseHref)}" x="0" y="0" width="${gw}" height="${gh}" preserveAspectRatio="none"/>`);
  gridLines(o, s, '#000000', [0.18, 0.35]);
  const tokens = drawOrder(s);
  for (const t of tokens) {
    const { cx, cy, r } = tokenGeom(t);
    const color = t.hp === 'down' ? '#8a8a8a' : t.color;
    o.push(`<g${t.waiting ? ' opacity="0.55"' : ''}>`);
    if (t.isTurn) turnHalo(o, cx, cy, r + 2);
    // A dark under-stroke keeps the colored ring visible on light and dark floors alike.
    o.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#000000" stroke-opacity="0.45" stroke-width="8"/>`);
    o.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="4"${t.waiting ? ' stroke-dasharray="6 5"' : ''}/>`);
    if (t.hp === 'down') downCross(o, cx, cy, r);
    if (t.hp === 'wounded') o.push(`<circle cx="${cx + r * 0.71}" cy="${cy - r * 0.71}" r="7" fill="#ff8c1a" stroke="#ffffff" stroke-width="2"/>`);
    o.push('</g>');
  }
  // Names: below each token, or above it at the bottom edge or when below is taken. Token names
  // go first, then feature labels where there is room.
  const drawn: Placed = [];
  for (const t of tokens) {
    const { cx, cy, r } = tokenGeom(t);
    const text = t.name.slice(0, 18);
    const half = (text.length * 8.4 + 14) / 2;
    const x = Math.min(Math.max(cx, half), gw - half);
    const gap = r + (t.isTurn ? 22 : 14); // clear of the turn halo
    const spots = [cy + gap, cy - gap].filter((y) => y >= 11 && y <= gh - 11);
    const opts = { color: t.isTurn ? '#ffcc33' : undefined, opacity: t.waiting ? 0.6 : undefined };
    for (const y of spots) if (pill(o, drawn, x, y, text, opts)) break;
  }
  featureLabels(o, s, drawn);
  o.push('</g>');
  legend(o, s, gw);
  o.push('</svg>');
  return o.join('\n');
}

export function renderMapPng(svg: string, zoom = 2): Buffer {
  // Rendered at 2x by default so it stays sharp when Discord scales the preview down.
  const r = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' }, background: '#24232b', fitTo: { mode: 'zoom', value: zoom } });
  return r.render().asPng();
}

export function mapPathFor(dataDir: string, turn: Pick<TurnRow, 'campaign_id' | 'id'>): string {
  return path.join(dataDir, 'images', turn.campaign_id, `map-turn-${turn.id}.png`);
}

/** Renders a snapshot to a PNG file and returns its path. */
export function writeMapPng(snapshot: MapSnapshot, outPath: string): string {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderMapPng(renderMapSvg(snapshot)));
  return outPath;
}

/** Where the grid sits in a composed 3D map of `px` pixels per cell. */
export function composedMapGeometry(snapshot: MapSnapshot, px: number): { width: number; height: number; gridTop: number } {
  const { width, height } = mapLayout(snapshot);
  const k = px / CELL;
  return { width: Math.round(width * k), height: Math.round(height * k), gridTop: HEADER * k };
}

/**
 * The 3D map: overlays drawn on a top-down render of the scene (`basePngPath`, `px` pixels per
 * cell: grid cell x,y covers pixels [x*px, (x+1)*px) × [y*px, (y+1)*px)). The whole SVG is scaled
 * by px/48, so the render keeps its pixels: the grid area is cols*px × rows*px, under the title
 * strip and beside the legend (composedMapGeometry). Returns the path.
 */
export function composeMapPng(snapshot: MapSnapshot, basePngPath: string, outPath: string, px: number): string {
  const href = `data:image/png;base64,${fs.readFileSync(basePngPath).toString('base64')}`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderMapPng(renderMapOverlaySvg(snapshot, href), px / CELL));
  return outPath;
}

// ---------------------------------------------------------------- placement text (for illustrations)

/**
 * Where each listed creature stands, in words a painter can follow, seen from the map's south
 * edge: foreground/background by row, left/right by column, next to whom, and the nearest
 * labeled feature. Measured against a guide image, words worked better: colored or grey blocking
 * figures bled into the paintings.
 */
export function describePlacement(s: MapSnapshot, labels: Map<string, string>): string {
  const toks = s.tokens.filter((t) => labels.has(t.id));
  if (!toks.length) return '';
  const cx = (t: MapToken) => t.x + t.size / 2;
  const cy = (t: MapToken) => t.y + t.size / 2;
  const ys = toks.map(cy);
  const xs = toks.map(cx);
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const near = (t: MapToken) => {
    let best: { label: string; d: number } | null = null;
    for (const f of s.features) {
      if (!f.label || f.kind === 'wall') continue;
      const dx = Math.max(f.x - cx(t), 0, cx(t) - (f.x + f.w));
      const dy = Math.max(f.y - cy(t), 0, cy(t) - (f.y + f.h));
      const d = Math.max(dx, dy);
      if (d <= 1.5 && (!best || d < best.d)) best = { label: f.label, d };
    }
    return best ? ` by the ${best.label.replace(/^(the|a|an)\s+/i, '')}` : '';
  };
  const parts = toks.map((t) => {
    const depth = maxY - minY < 1.5 ? '' : cy(t) >= maxY - 0.5 ? 'in the foreground' : cy(t) <= minY + 0.5 ? 'in the background' : 'in the middle distance';
    const side = spreadX < 1.5 ? '' : cx(t) < midX - 0.75 ? 'on the left' : cx(t) > midX + 0.75 ? 'on the right' : 'in the center';
    const buddy = toks.find((o) => o !== t && Math.max(Math.abs(cx(o) - cx(t)), Math.abs(cy(o) - cy(t))) <= 1.01);
    const where = [side, depth].filter(Boolean).join(' ') || 'at the center of the scene';
    const down = t.hp === 'down' ? ', fallen on the floor' : '';
    return `${labels.get(t.id)} is ${where}${near(t)}${buddy ? `, right next to ${labels.get(buddy.id)}` : ''}${down}`;
  });
  return parts.join('; ');
}
