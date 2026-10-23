// Battle maps: the spatial model of a scene (a grid with terrain and token positions, stored in the
// scene record) plus a deterministic renderer. Maps are drawn from public data only; hidden
// creatures and terrain live in the scene's gm_notes and are never drawn. No AI is involved.
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { getRecord, type Db } from './database.js';
import type { RecordRow, TurnRow } from './types.js';

export const FEATURE_KINDS = ['wall', 'door', 'cover', 'difficult', 'water', 'pit', 'object', 'stairs', 'light'] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

export interface MapFeature {
  kind: FeatureKind;
  label?: string;
  x: number;
  y: number;
  w: number;
  h: number;
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

export interface MapSceneState {
  id: string;
  name: string;
  data: Record<string, unknown>;
  gm_notes: Record<string, unknown>;
}

export interface MapRecordInfo {
  kind: string;
  visibility: string;
  archived: boolean;
}

function featureProblems(where: string, raw: unknown, map: { cols: number; rows: number }): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [`${where} must be an array`];
  if (raw.length > MAX_FEATURES) return [`${where} has ${raw.length} entries; at most ${MAX_FEATURES}`];
  const out: string[] = [];
  raw.forEach((f, i) => {
    const o = obj(f);
    if (!o) return void out.push(`${where}[${i}] must be an object {kind,label,x,y,w,h}`);
    if (!FEATURE_KINDS.includes(o.kind as FeatureKind)) out.push(`${where}[${i}].kind must be one of ${FEATURE_KINDS.join(', ')}`);
    if (o.label !== undefined && (typeof o.label !== 'string' || o.label.length > 32)) out.push(`${where}[${i}].label must be text of at most 32 characters`);
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

/**
 * Checks the battle maps of the scenes a batch touches. `scenes` are all active scenes after the
 * batch; `changed` names the ones in the batch (only those are checked, so old data never blocks
 * unrelated saves). Returns actionable messages for the GM.
 */
export function mapProblems(scenes: MapSceneState[], changed: Set<string>, info: (id: string) => MapRecordInfo | undefined): string[] {
  const out: string[] = [];
  const placed = new Map<string, string[]>();
  for (const s of scenes) {
    for (const id of [...readPositions(s.data.positions).keys(), ...readPositions(s.gm_notes.positions).keys()]) placed.set(id, [...(placed.get(id) ?? []), s.name]);
  }
  for (const s of scenes) {
    if (!changed.has(s.id)) continue;
    const at = `scene ${s.name}`;
    const pub = s.data.positions;
    const hid = s.gm_notes.positions;
    const hasPositions = (obj(pub) && Object.keys(obj(pub)!).length) || (obj(hid) && Object.keys(obj(hid)!).length);
    if (s.data.map === undefined || s.data.map === null) {
      if (hasPositions) out.push(`${at}: positions need a battle map; set data.map {cols, rows, cell_ft, features} first`);
      continue;
    }
    const m = obj(s.data.map);
    if (!m || !isInt(m.cols, 1, MAX_SIDE) || !isInt(m.rows, 1, MAX_SIDE)) {
      out.push(`${at}: data.map needs integer cols and rows between 1 and ${MAX_SIDE}`);
      continue;
    }
    if ((m.cols as number) * (m.rows as number) > MAX_CELLS) out.push(`${at}: data.map is ${m.cols}x${m.rows}; at most ${MAX_CELLS} cells`);
    if (m.cell_ft !== undefined && !(typeof m.cell_ft === 'number' && m.cell_ft >= 5 && m.cell_ft <= 30)) out.push(`${at}: data.map.cell_ft must be between 5 and 30 feet`);
    const grid = { cols: m.cols as number, rows: m.rows as number };
    out.push(...featureProblems(`${at}: data.map.features`, m.features, grid));
    out.push(...featureProblems(`${at}: gm_notes.map_features`, s.gm_notes.map_features, grid));

    const participants = new Set(Array.isArray(s.data.participants_ids) ? (s.data.participants_ids as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    const initiative = new Set(
      Array.isArray(s.data.initiative) ? (s.data.initiative as unknown[]).map((e) => (typeof e === 'string' ? e : obj(e)?.id)).filter((x): x is string => typeof x === 'string') : [],
    );
    const gmParticipants = new Set(Array.isArray(s.gm_notes.participants_ids) ? (s.gm_notes.participants_ids as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    const walls = new Set<string>();
    for (const f of readMap(m)!.features) if (BLOCKING.has(f.kind)) for (let x = f.x; x < f.x + f.w; x++) for (let y = f.y; y < f.y + f.h; y++) walls.add(`${x},${y}`);
    const occupied = new Map<string, string>();

    const check = (raw: unknown, where: string, hidden: boolean) => {
      if (raw === undefined || raw === null) return;
      const o = obj(raw);
      if (!o) return void out.push(`${at}: ${where} must be an object {recordId: {x, y}}`);
      for (const [id, v] of Object.entries(o)) {
        const p = obj(v);
        const r = info(id);
        if (!r || r.archived) {
          out.push(`${at}: ${where}.${id} is not a live record; remove it`);
          continue;
        }
        if (!['character', 'npc'].includes(r.kind) && !initiative.has(id)) out.push(`${at}: ${where}.${id} is a ${r.kind}; only characters and npcs (or initiative entries) have positions`);
        if (!hidden) {
          if (!participants.has(id) && !initiative.has(id)) out.push(`${at}: ${where}.${id} is not in participants_ids or the initiative; add them, or remove data.positions.${id} in the same batch when they leave`);
          if (r.visibility !== 'public') out.push(`${at}: ${id} is hidden from players; put its position in gm_notes.positions, not data.positions`);
        } else if (!initiative.has(id) && !gmParticipants.has(id) && r.kind !== 'npc') {
          out.push(`${at}: gm_notes.positions.${id} must be an npc, an initiative entry or in gm_notes.participants_ids`);
        }
        if (!p || !isInt(p.x, 0, grid.cols - 1) || !isInt(p.y, 0, grid.rows - 1) || (p.size !== undefined && !isInt(p.size, 1, 4))) {
          out.push(`${at}: ${where}.${id} needs integer x (0-${grid.cols - 1}), y (0-${grid.rows - 1}) and optional size 1-4`);
          continue;
        }
        const pos = { x: p.x as number, y: p.y as number, size: (p.size as number | undefined) ?? 1 };
        for (const [x, y] of footprint(pos)) {
          if (x >= grid.cols || y >= grid.rows) {
            out.push(`${at}: ${id} at ${pos.x},${pos.y} (size ${pos.size}) extends past the grid`);
            break;
          }
          if (walls.has(`${x},${y}`)) {
            out.push(`${at}: ${id} stands inside a wall or object at ${x},${y}; pick an open cell next to it`);
            break;
          }
          const other = occupied.get(`${x},${y}`);
          if (other && other !== id) {
            out.push(`${at}: ${id} and ${other} share cell ${x},${y}; one creature per cell`);
            break;
          }
          occupied.set(`${x},${y}`, id);
        }
        const scenesWith = placed.get(id) ?? [];
        if (scenesWith.length > 1) out.push(`${id} has a position in ${scenesWith.join(' and ')}; remove it from the scene it left in the same batch`);
      }
    };
    check(pub, 'data.positions', false);
    check(hid, 'gm_notes.positions', true);
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

function initialsFor(names: { id: string; name: string }[]): Map<string, string> {
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

/** The public battle map of a scene, or null when it has none. Never reads gm_notes. */
export function mapSnapshot(db: Db, campaignId: string, scene: RecordRow | undefined): MapSnapshot | null {
  if (!scene || scene.visibility !== 'public' || scene.archived_at) return null;
  const data = JSON.parse(scene.data_json) as Record<string, unknown>;
  const map = readMap(data.map);
  if (!map) return null;
  const entries: { r: RecordRow; d: Record<string, unknown>; p: Position }[] = [];
  for (const [id, p] of readPositions(data.positions)) {
    const r = getRecord(db, campaignId, id);
    if (!r || r.archived_at || r.visibility !== 'public') continue;
    const d = JSON.parse(r.data_json) as Record<string, unknown>;
    if (Array.isArray(d.conditions) && d.conditions.some((c) => typeof c === 'string' && HIDDEN_CONDITIONS.test(c))) continue;
    entries.push({ r, d, p });
  }
  const initials = initialsFor(entries.map((e) => ({ id: e.r.id, name: e.r.name })));
  const turnOf = typeof data.turn_of_id === 'string' ? data.turn_of_id : null;
  return {
    scene_id: scene.id,
    scene_name: scene.name,
    cols: map.cols,
    rows: map.rows,
    cell_ft: map.cell_ft,
    features: map.features.map((f) => ({ kind: f.kind, x: f.x, y: f.y, w: f.w, h: f.h, ...(f.label ? { label: String(f.label).slice(0, 32) } : {}) })),
    tokens: entries.map(({ r, d, p }) => ({
      id: r.id,
      name: r.name,
      initials: initials.get(r.id)!,
      kind: r.kind,
      color: tokenColor(r.id, r.kind),
      x: p.x,
      y: p.y,
      size: p.size ?? 1,
      hp: hpState(d),
      isTurn: r.id === turnOf,
    })),
    round: typeof data.round === 'number' ? data.round : null,
    turn_of: turnOf ? (entries.find((e) => e.r.id === turnOf)?.r.name ?? null) : null,
  };
}

// ---------------------------------------------------------------- ASCII map for the GM's context

const ASCII: Record<FeatureKind, string> = { wall: '#', door: '+', cover: '%', difficult: '^', water: '~', pit: 'O', object: '*', stairs: '=', light: '.' };

/**
 * A compact text map for the GM: initials on the grid, a legend and distances from the actor.
 * The GM sees gm_notes anyway, so hidden positions and features are included and marked.
 */
export function asciiMap(db: Db, campaignId: string, scene: RecordRow, actorId: string | null): string | null {
  const data = JSON.parse(scene.data_json) as Record<string, unknown>;
  const gm = JSON.parse(scene.gm_notes_json || '{}') as Record<string, unknown>;
  const map = readMap(data.map);
  if (!map) return null;
  const hiddenFeatures = Array.isArray(gm.map_features) ? (gm.map_features as MapFeature[]).filter((f) => obj(f) && FEATURE_KINDS.includes(f.kind)) : [];
  const tokens = [
    ...[...readPositions(data.positions)].map(([id, p]) => ({ id, p, hidden: false })),
    ...[...readPositions(gm.positions)].map(([id, p]) => ({ id, p, hidden: true })),
  ];
  const names = tokens.map((t) => ({ id: t.id, name: getRecord(db, campaignId, t.id)?.name ?? t.id }));
  const initials = initialsFor(names);
  const lines: string[] = [`${map.cols}x${map.rows} grid, ${map.cell_ft} ft per cell, x right, y down, origin top-left.`];
  if (map.cols * map.rows <= 900) {
    const grid = Array.from({ length: map.rows }, () => Array.from({ length: map.cols }, () => ' .'));
    for (const f of [...map.features, ...hiddenFeatures]) for (let x = f.x; x < f.x + f.w; x++) for (let y = f.y; y < f.y + f.h; y++) if (grid[y]?.[x]) grid[y]![x] = ` ${ASCII[f.kind]}`;
    for (const t of tokens) for (const [x, y] of footprint(t.p)) if (grid[y]?.[x]) grid[y]![x] = initials.get(t.id)!.slice(0, 2).padStart(2);
    lines.push(...grid.map((row) => row.join('')));
    lines.push('Terrain: # wall, + door, % cover, ^ difficult, ~ water, O pit, * object, = stairs');
  }
  const actor = tokens.find((t) => t.id === actorId);
  for (const t of tokens) {
    const n = names.find((x) => x.id === t.id)!.name;
    const dist = actor && t !== actor ? `, ${Math.max(Math.abs(t.p.x - actor.p.x), Math.abs(t.p.y - actor.p.y)) * map.cell_ft} ft from the actor` : '';
    lines.push(`${initials.get(t.id)} = ${n} (${t.id}) at ${t.p.x},${t.p.y}${(t.p.size ?? 1) > 1 ? ` size ${t.p.size}` : ''}${t.hidden ? ' [hidden: gm_notes]' : ''}${dist}`);
  }
  for (const f of [...map.features.map((f) => ({ f, h: false })), ...hiddenFeatures.map((f) => ({ f, h: true }))].filter((x) => x.f.label || x.h)) {
    lines.push(`${f.f.kind}${f.f.label ? ` "${f.f.label}"` : ''} at ${f.f.x},${f.f.y} ${f.f.w}x${f.f.h}${f.h ? ' [hidden: gm_notes]' : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- SVG / PNG

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
};

/** Deterministic top-down tactical map with tokens and a legend. */
export function renderMapSvg(s: MapSnapshot): string {
  const gw = s.cols * CELL;
  const gh = s.rows * CELL;
  const legendH = 80 + s.tokens.length * 36;
  const width = gw + LEGEND_W;
  const height = HEADER + Math.max(gh, legendH) + 12;
  const o: string[] = [];
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
  for (let c = 0; c <= s.cols; c++) o.push(`<line x1="${c * CELL}" y1="0" x2="${c * CELL}" y2="${gh}" stroke="#9b9384" stroke-opacity="${c % 5 === 0 ? 0.9 : 0.45}" stroke-width="${c % 5 === 0 ? 1.6 : 1}"/>`);
  for (let r = 0; r <= s.rows; r++) o.push(`<line x1="0" y1="${r * CELL}" x2="${gw}" y2="${r * CELL}" stroke="#9b9384" stroke-opacity="${r % 5 === 0 ? 0.9 : 0.45}" stroke-width="${r % 5 === 0 ? 1.6 : 1}"/>`);
  // Labels: walls are obvious and unlabeled; each label text is drawn once, on a pill so it stays
  // readable over terrain, and skipped where it would collide with one already drawn.
  const drawn: { x: number; y: number; w: number }[] = [];
  const seenLabels = new Set<string>();
  for (const f of s.features) {
    if (!f.label || f.kind === 'wall' || seenLabels.has(f.label.toLowerCase())) continue;
    const text = f.label.slice(0, 24);
    const w = text.length * 8.4 + 14;
    const cx = (f.x + f.w / 2) * CELL;
    const cy = (f.y + f.h / 2) * CELL;
    if (drawn.some((d) => Math.abs(d.x - cx) < (d.w + w) / 2 && Math.abs(d.y - cy) < 24)) continue;
    drawn.push({ x: cx, y: cy, w });
    seenLabels.add(f.label.toLowerCase());
    o.push(`<rect x="${cx - w / 2}" y="${cy - 11}" width="${w}" height="22" rx="11" fill="#1f1d24" fill-opacity="0.72"/>`);
    o.push(`<text x="${cx}" y="${cy + 5}" font-size="14" fill="#f6f1e6" text-anchor="middle">${esc(text)}</text>`);
  }
  // Tokens: the active turn first gets a halo, then each token, larger creatures under smaller ones.
  const ordered = [...s.tokens].sort((a, b) => b.size - a.size);
  for (const t of ordered) {
    const cx = (t.x + t.size / 2) * CELL;
    const cy = (t.y + t.size / 2) * CELL;
    const r = t.size * CELL * 0.4;
    if (t.isTurn) o.push(`<circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="none" stroke="#ffcc33" stroke-width="5"/>`);
    const fill = t.hp === 'down' ? '#8a8a8a' : t.color;
    const ring = t.hp === 'wounded' ? 'stroke="#ff8c1a" stroke-width="4"' : 'stroke="#ffffff" stroke-width="2"';
    o.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${ring}/>`);
    o.push(`<text x="${cx}" y="${cy + r * 0.36}" font-size="${Math.round(r * 0.95)}" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(t.initials)}</text>`);
    if (t.hp === 'down') {
      const d = r * 0.75;
      o.push(`<path d="M${cx - d} ${cy - d} L${cx + d} ${cy + d} M${cx + d} ${cy - d} L${cx - d} ${cy + d}" stroke="#2b2b2b" stroke-width="4"/>`);
    }
  }
  o.push('</g>');
  // Legend.
  const lx = gw + 18;
  o.push(`<g transform="translate(${lx} ${HEADER})">`);
  o.push(`<text x="0" y="24" font-size="20" font-weight="700" fill="#f1ede4">Legend</text>`);
  s.tokens.forEach((t, i) => {
    const y = 56 + i * 36;
    const state = t.hp === 'down' ? 'down' : t.hp === 'wounded' ? 'wounded' : '';
    o.push(`<circle cx="14" cy="${y}" r="14" fill="${t.hp === 'down' ? '#8a8a8a' : t.color}" ${t.isTurn ? 'stroke="#ffcc33" stroke-width="3"' : ''}/>`);
    o.push(`<text x="14" y="${y + 5}" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(t.initials)}</text>`);
    o.push(
      `<text x="38" y="${y + 6}" font-size="18" fill="${t.isTurn ? '#ffcc33' : '#f1ede4'}" font-weight="${t.isTurn ? 700 : 400}">${esc(t.name.slice(0, 20))}${state ? `<tspan dx="8" fill="#ff9f43" font-size="15">${state}</tspan>` : ''}</text>`,
    );
  });
  o.push(`<text x="0" y="${66 + s.tokens.length * 36}" font-size="15" fill="#a9a39a">1 square = ${s.cell_ft} ft</text>`);
  o.push('</g>');
  o.push('</svg>');
  return o.join('\n');
}

export function renderMapPng(svg: string): Buffer {
  // Rendered at 2x so it stays sharp when Discord scales the preview down.
  const r = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' }, background: '#24232b', fitTo: { mode: 'zoom', value: 2 } });
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
