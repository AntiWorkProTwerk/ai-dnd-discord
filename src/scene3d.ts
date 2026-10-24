// Rendered 3D scenes: a deterministic scene description (room, furniture, people, light, camera)
// built from the public game state, which Blender turns into a picture (scripts/scene_blender.py).
// The same saved 3D models stand in every picture, in the positions the battle map says, so there
// are no AI image artifacts. Never reads gm_notes or hidden records.
import { getRecord, type Db } from './database.js';
import { castOf, focusOf, isFight, publicData, sceneFor } from './images.js';
import { FACINGS, hpState, initialsFor, isConcealed, mapSnapshot, readMap, tokenColor, type MapFeature, type MapSnapshot } from './maps.js';
import { timeMin } from './storylines.js';
import type { RecordRow, TurnRow } from './types.js';

export type Material = 'wood' | 'stone' | 'brick' | 'plaster' | 'dirt' | 'grass' | 'cobbles' | 'sand' | 'snow' | 'water';
export type Shape =
  | 'table'
  | 'counter'
  | 'bench'
  | 'chair'
  | 'barrel'
  | 'crate'
  | 'bed'
  | 'shelf'
  | 'hearth'
  | 'door'
  | 'window'
  | 'pillar'
  | 'cart'
  | 'stairs'
  | 'tree'
  | 'rock'
  | 'path'
  | 'block';

export interface SceneFeature {
  kind: MapFeature['kind'];
  shape: Shape;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScenePerson {
  id: string;
  /** Public name, as the battle map labels the token. */
  name?: string;
  x: number;
  y: number;
  size: number;
  color: string;
  /** A 3D miniature (GLB) built from the character's portrait, when one exists. */
  model?: string;
  down: boolean;
  wounded: boolean;
  focus: boolean;
  /** Joined the fight mid-round and acts at the end of it (drawn faded, as on the map). */
  waiting?: boolean;
  /** Grid point the person faces. */
  face: { x: number; y: number };
  /** The facing was saved (they turned or looked somewhere): the shot shows what they face. */
  faced?: boolean;
}

export interface SceneSpec {
  indoor: boolean;
  floor: Material;
  wall: Material;
  time: 'dawn' | 'day' | 'dusk' | 'night';
  weather: 'clear' | 'rain' | 'fog' | 'snow';
  cols: number;
  rows: number;
  features: SceneFeature[];
  people: ScenePerson[];
  /** The camera stands behind and beside `from` and looks at `at` (grid coordinates). */
  camera: { from: { x: number; y: number }; at: { x: number; y: number } };
  fight: boolean;
  /** In or by a settlement: houses around the map rather than trees and rocks. */
  town?: boolean;
  /** Seeds the invented set dressing: the same place always gets the same barrels and houses. */
  seed?: number;
}

const INDOOR = /\b(inn|tavern|hall|room|cellar|chapel|church|temple|house|home|shop|store|crypt|tomb|dungeon|cave|keep|tower|library|kitchen|barracks|nave|loft|attic|vault|mine|tunnel|interior|inside)\b/i;
/** Said of the scene itself ("Rain Beyond the Inn", "you look up at the sky"): outdoors, whatever the place is. */
const OUTSIDE_HINT = /\b(outside|outdoors|open air|beyond|sky|rooftops?|lanes?|streets?)\b/i;
const TOWN_HINT = /\b(town|towns|village|city|hamlet|market|houses?|stilt|streets?|bridges?|docks?|quay|wharf|boardwalks?|inns?|tavern|square|alley)\b/i;
const OUTDOOR = /\b(street|road|market|square|field|forest|wood(s|land)?|swamp|marsh|fen|river|lake|shore|beach|dock|pier|harbou?r|camp|courtyard|yard|garden|hill|mountain|plain|meadow|bridge|causeway|outside|outdoors|rooftop|alley)\b/i;

function pickMaterial(text: string, indoor: boolean, surface: 'floor' | 'wall'): Material {
  const t = text.toLowerCase();
  const has = (re: RegExp) => re.test(t);
  if (surface === 'wall') {
    if (has(/\bbrick/)) return 'brick';
    if (has(/\b(stone|chapel|church|temple|crypt|tomb|keep|castle|tower|vault|dungeon|cave|mine)/)) return 'stone';
    if (has(/\b(plaster|whitewash|cottage)/)) return 'plaster';
    return 'wood';
  }
  // Only a flooded floor, not "farmers flooded out of the east".
  if (has(/\b(waist-deep|knee-deep|underwater|flooded (floor|nave|hall|room|cellar|chamber))\b/)) return 'water';
  if (!indoor) {
    if (has(/\b(snow|frost|ice)\b/)) return 'snow';
    // Words about the ground itself come before the kind of place ("Market Mound Riverbank": mud, not cobbles).
    if (has(/\b(mud|muddy|riverbank|bank|marsh|bog|swamp|fen|mire)\b/)) return 'dirt';
    if (has(/\bcobble/)) return 'cobbles';
    if (has(/\b(plank|planks|boardwalks?|dock|docks|pier|jetty|wharf|deck)\b/)) return 'wood';
    if (has(/\b(street|square|market|courtyard|alley)/)) return 'cobbles';
    if (has(/\b(sand|beach|desert|dune)/)) return 'sand';
    if (has(/\b(grass|meadow|field|garden|forest|hill|plain)/)) return 'grass';
    return 'dirt';
  }
  if (has(/\b(stone|chapel|church|temple|crypt|tomb|keep|castle|vault|dungeon|cave|cellar|mine)/)) return 'stone';
  return 'wood';
}

const SHAPES: [RegExp, Shape][] = [
  [/\b(tree)\b/i, 'tree'],
  [/\b(bar|counter)\b/i, 'counter'],
  [/\b(table|desk|altar)\b/i, 'table'],
  [/\b(bench|pew)\b/i, 'bench'],
  [/\b(chair|stool|throne)\b/i, 'chair'],
  [/\b(barrel|keg|cask|vat)\b/i, 'barrel'],
  [/\b(crate|box|chest|trunk|sack)\b/i, 'crate'],
  [/\b(bed|cot|bunk)\b/i, 'bed'],
  [/\b(shelf|shelves|cabinet|cupboard|rack|wardrobe|bookcase)\b/i, 'shelf'],
  [/\b(hearth|fireplace|fire|forge|oven|brazier|stove)\b/i, 'hearth'],
  [/\b(window)\b/i, 'window'],
  [/\b(pillar|column|statue|post|pole|totem|piling|pile|stake)\b/i, 'pillar'],
  [/\b(cart|wagon|carriage)\b/i, 'cart'],
  [/\b(rock|boulder|stone)\b/i, 'rock'],
];

function shapeOf(f: MapFeature): Shape {
  if (f.kind === 'door') return 'door';
  if (f.kind === 'stairs') return 'stairs';
  // A way out is open ground (a path, a gangway, the end of a street), never a solid block.
  if (f.kind === 'exit') return /\b(stairs?|steps|ladder)\b/i.test(f.label ?? '') ? 'stairs' : 'path';
  // Labels may be plural ("kegs", "tables", "benches"): match each word's singular too.
  const words = (f.label ?? '').replace(/(?<=[a-z])(es|s)\b/gi, '');
  for (const [re, shape] of SHAPES) if (f.label && (re.test(f.label) || re.test(words))) return shape;
  if (f.kind === 'cover') return 'crate';
  return 'block';
}

function timeOfDay(minutes: number | null, text: string): SceneSpec['time'] {
  if (minutes === null) {
    if (/\b(dawn|sunrise|morning)\b/i.test(text)) return 'dawn';
    if (/\b(dusk|sunset|evening|twilight)\b/i.test(text)) return 'dusk';
    if (/\b(night|midnight|moon)\b/i.test(text)) return 'night';
    return 'day';
  }
  const h = (((minutes / 60) % 24) + 24) % 24;
  if (h < 5 || h >= 21) return 'night';
  if (h < 8) return 'dawn';
  if (h < 17) return 'day';
  return 'dusk';
}

/** What a scene spec is built from: a play turn, or the current moment (`momentNow`). */
export type SceneMoment = Pick<TurnRow, 'campaign_id' | 'scene_id' | 'actor_character_id' | 'delivery_json' | 'public_reply'>;

/** The current state of a storyline as a moment, for `/rpg map` and `/rpg diorama`. */
export function momentNow(campaignId: string, sceneId: string, actorId: string | null, snapshot: MapSnapshot): SceneMoment {
  return { campaign_id: campaignId, scene_id: sceneId, actor_character_id: actorId, delivery_json: JSON.stringify({ map_snapshot: snapshot }), public_reply: '' };
}

/** Who and where: the moment's battle map (stored, else current), or a sketch made up without one. */
function setting(db: Db, turn: SceneMoment) {
  const actor = turn.actor_character_id ? getRecord(db, turn.campaign_id, turn.actor_character_id) : undefined;
  const story = sceneFor(db, turn, actor);
  const cast = castOf(db, turn.campaign_id, story, actor);
  const stored = (JSON.parse(turn.delivery_json || '{}') as { map_snapshot?: MapSnapshot }).map_snapshot;
  // A stored sketch gives way to a battle map the GM drew since; otherwise it is the moment's layout.
  const real: MapSnapshot | null = (stored?.sketch ? null : stored) ?? mapSnapshot(db, turn.campaign_id, story) ?? stored ?? null;
  const placeId = (publicData(story) ? story?.parent_id : null) ?? actor?.parent_id ?? null;
  const place = placeId ? getRecord(db, turn.campaign_id, placeId) : undefined;
  const placeText = [place?.name ?? '', String(publicData(place)?.description ?? ''), story?.name ?? ''].join(' ');
  // Walls enclose a room: most of the map's edge is wall. A street with one house front is still outdoors.
  const hasWalls = !!real && enclosed(real);
  const outsideNow = OUTSIDE_HINT.test(`${story?.name ?? ''} ${turn.public_reply ?? ''}`);
  const indoor = hasWalls || (!outsideNow && INDOOR.test(placeText) && !OUTDOOR.test(place?.name ?? ''));
  // People players cannot see (hidden, invisible) never appear, with or without a map.
  const snap: MapSnapshot =
    real ??
    {
      ...synthesizeLayout(cast.map((c) => c.record).filter((r) => !isConcealed(JSON.parse(r.data_json))), actor?.id ?? null, indoor),
      scene_id: story?.id ?? '',
      scene_name: (publicData(story) ? story?.name : null) ?? place?.name ?? 'The scene',
      sketch: true,
    };
  // Houses or wilderness around the map: the place or the area it is in says so ("stilt houses", a town).
  const around: string[] = [placeText];
  for (let a = place?.parent_id ? getRecord(db, turn.campaign_id, place.parent_id) : undefined, n = 0; a && n < 3; a = a.parent_id ? getRecord(db, turn.campaign_id, a.parent_id) : undefined, n++) {
    if (a.kind === 'location' && publicData(a)) around.push(a.name, String(publicData(a)?.description ?? ''));
  }
  const town = TOWN_HINT.test(around.join(' '));
  return { actor, story, cast, real, snap, placeText, indoor, town };
}

/**
 * The layout of a moment for the map and the diorama: its battle map, or (no map yet) the same
 * made-up sketch the 3D shot uses, marked `sketch`.
 */
export function layoutFor(db: Db, turn: SceneMoment): MapSnapshot {
  return setting(db, turn).snap;
}

/**
 * The scene of a play turn, from its battle map snapshot (or the current map). Without a map, a
 * small layout is made up: the actor in the middle and the others in an arc in front of them.
 * Everyone on the map is a person in the spec; `focus` marks who the shot is about.
 */
export function buildSceneSpec(db: Db, turn: SceneMoment, modelOf: (recordId: string) => string | null = () => null): SceneSpec {
  const { actor, story, cast, real, snap, placeText, indoor, town } = setting(db, turn);
  const focus = focusOf(cast, actor, story, real?.sketch ? null : real, turn.public_reply ?? '');
  const storyData = publicData(story) ?? {};
  const weatherText = `${placeText} ${String(storyData.time ?? '')} ${turn.public_reply ?? ''}`;

  const fight = isFight(story);
  const people: ScenePerson[] = snap.tokens.map((t) => {
    const r = getRecord(db, turn.campaign_id, t.id);
    // Positions are token centers in grid units, the same as the map draws them.
    return {
      id: t.id,
      name: t.name,
      x: t.x + t.size / 2,
      y: t.y + t.size / 2,
      size: t.size,
      color: t.color,
      ...(modelOf(t.id) ? { model: modelOf(t.id)! } : {}),
      down: t.hp === 'down' || (r ? hpState(JSON.parse(r.data_json)) === 'down' : false),
      wounded: t.hp === 'wounded',
      focus: focus.includes(t.id),
      ...(t.waiting ? { waiting: true } : {}),
      face: { x: 0, y: 0 },
    };
  });
  // Facing: in a fight, the nearest other combatant; otherwise the actor (the actor faces the group).
  const order = new Set(
    (Array.isArray(storyData.initiative) ? (storyData.initiative as unknown[]) : []).map((e) => (typeof e === 'object' && e ? (e as { id?: string }).id : e)).filter((x): x is string => typeof x === 'string'),
  );
  const me = people.find((p) => p.id === actor?.id);
  for (const p of people) {
    const others = people.filter((o) => o !== p && !o.down && (!fight || !order.size || (order.has(o.id) && order.has(p.id)) || !order.has(p.id)));
    const near = others.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    const target = p === me || !me ? near : fight ? near : me;
    p.face = target ? { x: target.x, y: target.y } : { x: p.x, y: p.y + 1 };
    // A saved facing wins outside fights (in a fight everyone squares up to an opponent).
    const facing = snap.tokens.find((t) => t.id === p.id)?.facing;
    if (facing && !fight) {
      const [dx, dy] = FACINGS[facing];
      p.face = { x: p.x + dx, y: p.y + dy };
      p.faced = true;
    }
  }

  const focusPeople = people.filter((p) => p.focus);
  const group = focusPeople.length ? focusPeople : people;
  const at = group.length ? { x: avg(group.map((p) => p.x)), y: avg(group.map((p) => p.y)) } : { x: snap.cols / 2, y: snap.rows / 2 };
  const from = me ? { x: me.x, y: me.y } : { x: at.x, y: Math.min(snap.rows, at.y + 3) };

  return {
    indoor,
    town,
    floor: pickMaterial(placeText, indoor, 'floor'),
    wall: pickMaterial(placeText, indoor, 'wall'),
    time: timeOfDay(story ? timeMin(story) : null, `${String(storyData.time ?? '')} ${placeText}`),
    weather: /\b(rain|storm|downpour|drizzle)\b/i.test(weatherText) ? 'rain' : /\b(fog|mist)\b/i.test(weatherText) ? 'fog' : /\b(snow|blizzard)\b/i.test(weatherText) ? 'snow' : 'clear',
    cols: snap.cols,
    rows: snap.rows,
    features: snap.features.map((f) => ({ kind: f.kind, shape: shapeOf(f), x: f.x, y: f.y, w: f.w, h: f.h })),
    people,
    camera: { from, at },
    fight,
    seed: seedOf(snap.place_id ?? story?.parent_id ?? story?.id ?? ''),
  };
}

/** A stable number from an id (FNV-1a). */
const seedOf = (id: string) => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 1_000_000;
};

/** Whether walls cover at least half of a map's border cells. */
function enclosed(m: Pick<MapSnapshot, 'cols' | 'rows' | 'features'>): boolean {
  const walls = new Set<string>();
  for (const f of m.features) if (f.kind === 'wall' || f.kind === 'door') for (let x = f.x; x < f.x + f.w; x++) for (let y = f.y; y < f.y + f.h; y++) walls.add(`${x},${y}`);
  let border = 0;
  let hit = 0;
  for (let x = 0; x < m.cols; x++) for (let y = 0; y < m.rows; y++) {
    if (x > 0 && y > 0 && x < m.cols - 1 && y < m.rows - 1) continue;
    border++;
    if (walls.has(`${x},${y}`)) hit++;
  }
  return border > 0 && hit / border >= 0.5;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** A made-up layout for a scene without a battle map: a small room or clearing, people in an arc. */
function synthesizeLayout(people: RecordRow[], actorId: string | null, indoor: boolean): MapSnapshot {
  const cols = 10;
  const rows = 8;
  const actor = people.find((p) => p.id === actorId);
  const others = people.filter((p) => p !== actor).slice(0, 7);
  const tokens: MapSnapshot['tokens'] = [];
  const initials = initialsFor(people);
  const add = (r: RecordRow, x: number, y: number) =>
    tokens.push({ id: r.id, name: r.name, initials: initials.get(r.id) ?? '', kind: r.kind, color: tokenColor(r.id, r.kind), x, y, size: 1, hp: hpState(JSON.parse(r.data_json)), isTurn: false });
  if (actor) add(actor, 4, 5);
  others.forEach((r, i) => {
    const angle = Math.PI * (0.25 + (0.5 * (i + 0.5)) / Math.max(others.length, 1));
    add(r, Math.round(4.5 - 2.2 * Math.cos(angle) - 0.5), Math.round(5 - 2.2 * Math.sin(angle)));
  });
  const features: MapFeature[] = indoor
    ? [
        { kind: 'wall', x: 0, y: 0, w: cols, h: 1 },
        { kind: 'wall', x: 0, y: 0, w: 1, h: rows },
        { kind: 'wall', x: cols - 1, y: 0, w: 1, h: rows },
      ]
    : [];
  return { scene_id: '', scene_name: '', cols, rows, cell_ft: 5, features, tokens, round: null, turn_of: null };
}

