// 3D scene specs: the deterministic room/people/light/camera description built from public state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/campaign.js';
import { getRecord, insertTurn, openDatabase, type Db } from '../src/database.js';
import { mapSnapshot } from '../src/maps.js';
import { planBatch, writeBatch } from '../src/records.js';
import { buildSceneSpec, layoutFor, momentNow, type ScenePerson } from '../src/scene3d.js';
import type { CampaignRow, TurnRow } from '../src/types.js';

const op = (o: Record<string, unknown>) => ({
  ref: null, record_id: null, kind: null, name: null, parent_id: null, visibility: null, path: null,
  value_json: null, data_json: null, gm_notes_json: null, expected_json: null, expected_version: null, delta: null, ...o,
});

let dir: string;
let db: Db;
let campaign: CampaignRow;
let ids: Record<string, string>;
let seq = 0;

function seed(ops: object[]): Record<string, string> {
  return db.transaction(() => {
    const plan = planBatch(db, ops as never, { campaignId: campaign.id, actorUserId: 'owner', constraints: [] });
    writeBatch(db, campaign.id, plan);
    return plan.created;
  })();
}

/** Writes a record's public data directly (bypassing validation, e.g. to put a hidden record in it). */
const setData = (id: string, data: object) => db.prepare('UPDATE records SET data_json = ? WHERE id = ?').run(JSON.stringify(data), id);

/**
 * Gives a place its saved map and puts creatures on it (directly, bypassing validation): each one
 * moves into the place (parent_id) with data.pos.
 */
function mapPlace(placeId: string, map: object, positions: Record<string, object>): void {
  db.prepare(`UPDATE records SET data_json = json_set(data_json, '$.map', json(?)) WHERE id = ?`).run(JSON.stringify(map), placeId);
  for (const [id, pos] of Object.entries(positions)) {
    db.prepare(`UPDATE records SET parent_id = ?, data_json = json_set(data_json, '$.pos', json(?)) WHERE id = ?`).run(placeId, JSON.stringify(pos), id);
  }
}

function scene(name: string, parent: string, data: object): string {
  return seed([op({ op: 'create', ref: '$s', kind: 'scene', name, parent_id: parent, data_json: JSON.stringify({ status: 'active', ...data }) })]).$s!;
}

function turn(sceneId: string, opts: { actor?: string | null; reply?: string; delivery?: object } = {}): TurnRow {
  return insertTurn(db, {
    campaign_id: campaign.id,
    request_id: `r${++seq}`,
    actor_user_id: 'owner',
    actor_character_id: opts.actor === undefined ? ids.$thaniesh! : opts.actor,
    mode: 'play',
    status: 'delivered',
    public_reply: opts.reply ?? 'You look around.',
    delivery_json: JSON.stringify(opts.delivery ?? {}),
    scene_id: sceneId,
  }).turn;
}

const person = (people: ScenePerson[], id: string) => people.find((p) => p.id === id)!;
const MAP = (features: object[] = []) => ({ cols: 10, rows: 8, cell_ft: 5, features });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-scene3d-'));
  db = openDatabase(path.join(dir, 'rpg.sqlite'));
  campaign = createCampaign(db, { guildId: 'g', channelId: 'main-chan', ownerUserId: 'owner', title: 'T', premise: '', rules_edition: '', tone: '', max_players: 4, boundaries: '', require_character_approval: false });
  db.prepare(`UPDATE campaigns SET status = 'active' WHERE id = ?`).run(campaign.id);
  ids = seed([
    op({ op: 'create', ref: '$inn', kind: 'location', name: 'The Crooked Kettle', data_json: JSON.stringify({ description: 'A warm inn with a low ceiling, crowded with farmers flooded out of the east.' }) }),
    op({ op: 'create', ref: '$chapel', kind: 'location', name: 'Drowned Chapel', data_json: JSON.stringify({ description: 'A flooded stone chapel. The nave is flooded waist-deep and candles gutter.' }) }),
    op({ op: 'create', ref: '$market', kind: 'location', name: 'Pike Market', data_json: JSON.stringify({ description: 'Stalls and handcarts line the street.' }) }),
    op({ op: 'create', ref: '$thaniesh', kind: 'character', name: 'Thaniesh', parent_id: '$inn', data_json: '{"hp":{"current":4,"max":10}}' }),
    op({ op: 'create', ref: '$vargas', kind: 'character', name: 'Vargas', parent_id: '$inn', data_json: '{"hp":{"current":10,"max":10}}' }),
    op({ op: 'create', ref: '$marrow', kind: 'npc', name: 'Marrow Gale', parent_id: '$inn', data_json: '{"hp":{"current":0,"max":9}}' }),
    op({ op: 'create', ref: '$bram', kind: 'npc', name: 'Bram', parent_id: '$inn', data_json: '{"hp":{"current":8,"max":8}}' }),
    op({ op: 'create', ref: '$cora', kind: 'npc', name: 'Cora', parent_id: '$inn', data_json: '{}' }),
    op({ op: 'create', ref: '$spy', kind: 'npc', name: 'Hidden Spy', parent_id: '$inn', visibility: 'gm', data_json: '{}' }),
    op({ op: 'create', ref: '$ghost', kind: 'npc', name: 'Lurking Ghost', parent_id: '$inn', data_json: '{"conditions":["hidden"]}' }),
  ]);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('public participants only', () => {
  it('a gm-visibility NPC and a hidden-condition token never appear on a battle map scene', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh, ids.$vargas] });
    setData(s, { status: 'active', participants_ids: [ids.$thaniesh, ids.$vargas, ids.$spy, ids.$ghost] });
    mapPlace(ids.$inn!, MAP(), { [ids.$thaniesh!]: { x: 1, y: 1 }, [ids.$vargas!]: { x: 2, y: 1 }, [ids.$spy!]: { x: 5, y: 5 }, [ids.$ghost!]: { x: 6, y: 6 } });
    const spec = buildSceneSpec(db, turn(s, { reply: 'Hidden Spy and Lurking Ghost watch.' }));
    expect(spec.people.map((p) => p.id).sort()).toEqual([ids.$thaniesh, ids.$vargas].sort());
    expect(JSON.stringify(spec)).not.toContain(ids.$spy!);
    expect(JSON.stringify(spec)).not.toContain(ids.$ghost!);
  });

  it('a gm-visibility NPC never appears in a scene without a battle map', () => {
    const s = scene('Common room', ids.$inn!, {});
    setData(s, { status: 'active', participants_ids: [ids.$thaniesh, ids.$vargas, ids.$spy] });
    const spec = buildSceneSpec(db, turn(s));
    expect(spec.people.map((p) => p.id).sort()).toEqual([ids.$thaniesh, ids.$vargas].sort());
  });

  // BUG: without a battle map the layout is synthesized from castOf(), which filters non-public
  // records but not the "hidden"/"invisible" conditions that mapSnapshot() drops.
  it('a participant with condition "hidden" stays out of a scene without a battle map', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh, ids.$vargas, ids.$ghost] });
    const spec = buildSceneSpec(db, turn(s));
    expect(spec.people.map((p) => p.id)).not.toContain(ids.$ghost);
  });
});

describe('synthesized layout (no battle map)', () => {
  it('places the actor middle-front and the others in an arc in front, on a 10x8 grid', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh, ids.$vargas, ids.$bram, ids.$cora] });
    const spec = buildSceneSpec(db, turn(s));
    expect([spec.cols, spec.rows]).toEqual([10, 8]);
    expect(spec.people).toHaveLength(4);
    const me = person(spec.people, ids.$thaniesh!);
    expect([me.x, me.y]).toEqual([4.5, 5.5]);
    const others = spec.people.filter((p) => p !== me);
    for (const o of others) {
      expect(o.y).toBeLessThan(me.y); // in front of the actor (away from the camera)
      expect(o.x).toBeGreaterThanOrEqual(0);
      expect(o.x).toBeLessThan(10);
      expect(o.y).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(o.x - me.x, o.y - me.y)).toBeGreaterThan(1.5);
      expect(Math.hypot(o.x - me.x, o.y - me.y)).toBeLessThan(3.5);
    }
    // an arc: spread left to right, no two in the same cell
    const xs = others.map((o) => o.x).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(me.x);
    expect(xs.at(-1)).toBeGreaterThan(me.x);
    expect(new Set(spec.people.map((p) => `${p.x},${p.y}`)).size).toBe(4);
  });

  it('indoor rooms get three walls, outdoor clearings none', () => {
    const inn = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh] });
    const indoor = buildSceneSpec(db, turn(inn));
    expect(indoor.indoor).toBe(true);
    expect(indoor.features.filter((f) => f.kind === 'wall')).toHaveLength(3);
    expect(indoor.features.every((f) => f.shape === 'block')).toBe(true);

    const market = scene('the street', ids.$market!, { participants_ids: [ids.$thaniesh] });
    const outdoor = buildSceneSpec(db, turn(market));
    expect(outdoor.indoor).toBe(false);
    expect(outdoor.features).toEqual([]);
  });

  it('works with no actor (camera falls back to behind the group)', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$vargas, ids.$bram] });
    const spec = buildSceneSpec(db, turn(s, { actor: null }));
    expect(spec.people).toHaveLength(2);
    expect(spec.camera.from.y).toBeGreaterThan(spec.camera.at.y);
  });
});

describe('focus', () => {
  it('is capped at 3 and always includes the actor', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$vargas, ids.$bram, ids.$cora, ids.$marrow, ids.$thaniesh] });
    const spec = buildSceneSpec(db, turn(s, { reply: 'Vargas, Bram, Cora and Marrow Gale all turn to look.' }));
    expect(spec.people).toHaveLength(5);
    expect(spec.people.filter((p) => p.focus).length).toBeLessThanOrEqual(3);
    expect(person(spec.people, ids.$thaniesh!).focus).toBe(true);
  });

  it('keeps the actor in focus on a battle map even when far from everyone named', () => {
    mapPlace(ids.$inn!, MAP(), { [ids.$thaniesh!]: { x: 0, y: 7 }, [ids.$vargas!]: { x: 9, y: 0 }, [ids.$bram!]: { x: 8, y: 0 }, [ids.$cora!]: { x: 7, y: 0 }, [ids.$marrow!]: { x: 6, y: 0 } });
    const s = scene('Common room', ids.$inn!, {
      participants_ids: [ids.$thaniesh, ids.$vargas, ids.$bram, ids.$cora, ids.$marrow],
    });
    const spec = buildSceneSpec(db, turn(s, { reply: 'Vargas, Bram, Cora and Marrow Gale shout.' }));
    expect(spec.people.filter((p) => p.focus).length).toBeLessThanOrEqual(3);
    expect(person(spec.people, ids.$thaniesh!).focus).toBe(true);
  });
});

describe('map details for the 3D map', () => {
  it('carries each name and marks a mid-round joiner as waiting', () => {
    mapPlace(ids.$inn!, MAP(), { [ids.$thaniesh!]: { x: 1, y: 1 }, [ids.$vargas!]: { x: 2, y: 1 }, [ids.$bram!]: { x: 5, y: 5 } });
    const s = scene('Brawl', ids.$inn!, {
      participants_ids: [ids.$thaniesh, ids.$vargas, ids.$bram],
      initiative: [{ id: ids.$thaniesh, value: 15 }, { id: ids.$bram, value: 12 }, { id: ids.$vargas, value: null, waiting: true }],
      turn_of_id: ids.$thaniesh,
      round: 1,
    });
    const spec = buildSceneSpec(db, turn(s));
    expect(spec.people.map((p) => p.name).sort()).toEqual(['Bram', 'Thaniesh', 'Vargas']);
    expect(person(spec.people, ids.$vargas!).waiting).toBe(true);
    expect('waiting' in person(spec.people, ids.$thaniesh!)).toBe(false);
    expect(person(spec.people, ids.$vargas!)).toMatchObject({ x: 2.5, y: 1.5 }); // token centers, as the map draws them
  });

  it('builds the current moment of a storyline without a turn', () => {
    mapPlace(ids.$inn!, MAP(), { [ids.$thaniesh!]: { x: 1, y: 1 }, [ids.$vargas!]: { x: 4, y: 1 } });
    const s = scene('Brawl', ids.$inn!, { participants_ids: [ids.$thaniesh, ids.$vargas] });
    const snap = mapSnapshot(db, campaign.id, getRecord(db, campaign.id, s))!;
    const spec = buildSceneSpec(db, momentNow(campaign.id, s, ids.$vargas!, snap));
    expect(spec.people).toHaveLength(2);
    expect(person(spec.people, ids.$vargas!).focus).toBe(true);
    expect(spec.camera.from).toEqual({ x: 4.5, y: 1.5 }); // from the caller
  });
});

describe('models', () => {
  it('assigns model only to people modelOf knows', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh, ids.$vargas, ids.$bram] });
    const spec = buildSceneSpec(db, turn(s), (id) => (id === ids.$vargas ? 'models/vargas.glb' : null));
    expect(person(spec.people, ids.$vargas!).model).toBe('models/vargas.glb');
    expect('model' in person(spec.people, ids.$thaniesh!)).toBe(false);
    expect('model' in person(spec.people, ids.$bram!)).toBe(false);
  });

  it('defaults to no models', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh, ids.$vargas] });
    expect(buildSceneSpec(db, turn(s)).people.some((p) => 'model' in p)).toBe(false);
  });
});

describe('facing', () => {
  // Thaniesh and Vargas on the left, Bram and Cora on the right.
  const positions = () => ({
    [ids.$thaniesh!]: { x: 1, y: 4 },
    [ids.$vargas!]: { x: 2, y: 2 },
    [ids.$bram!]: { x: 8, y: 1 },
    [ids.$cora!]: { x: 7, y: 6 },
  });
  const all = () => [ids.$thaniesh, ids.$vargas, ids.$bram, ids.$cora];

  it('in a fight each combatant faces its nearest other combatant', () => {
    mapPlace(ids.$inn!, MAP(), positions());
    const s = scene('Brawl', ids.$inn!, { participants_ids: all(), initiative: all().map((id, i) => ({ id, value: 20 - i })), round: 1 });
    const spec = buildSceneSpec(db, turn(s));
    expect(spec.fight).toBe(true);
    for (const p of spec.people) {
      const near = spec.people.filter((o) => o !== p).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0]!;
      expect(p.face, p.id).toEqual({ x: near.x, y: near.y });
    }
    const v = person(spec.people, ids.$vargas!);
    const t = person(spec.people, ids.$thaniesh!);
    expect(v.face).toEqual({ x: t.x, y: t.y }); // nearest, not the actor-by-default
    const b = person(spec.people, ids.$bram!);
    const c = person(spec.people, ids.$cora!);
    expect(b.face).toEqual({ x: c.x, y: c.y });
  });

  it('a fallen combatant is not faced', () => {
    mapPlace(ids.$inn!, MAP(), { ...positions(), [ids.$marrow!]: { x: 2, y: 4 } });
    const s = scene('Brawl', ids.$inn!, {
      participants_ids: [...all(), ids.$marrow],
      initiative: [...all(), ids.$marrow].map((id, i) => ({ id, value: 20 - i })),
    });
    const spec = buildSceneSpec(db, turn(s));
    const t = person(spec.people, ids.$thaniesh!);
    const m = person(spec.people, ids.$marrow!);
    expect(t.face).not.toEqual({ x: m.x, y: m.y });
  });

  it('out of a fight everyone else faces the actor, and the actor faces the nearest person', () => {
    mapPlace(ids.$inn!, MAP(), positions());
    const s = scene('Common room', ids.$inn!, { participants_ids: all() });
    const spec = buildSceneSpec(db, turn(s));
    expect(spec.fight).toBe(false);
    const me = person(spec.people, ids.$thaniesh!);
    for (const p of spec.people.filter((x) => x !== me)) expect(p.face, p.id).toEqual({ x: me.x, y: me.y });
    const v = person(spec.people, ids.$vargas!);
    expect(me.face).toEqual({ x: v.x, y: v.y });
  });

  it('a one-entry initiative is not a fight', () => {
    mapPlace(ids.$inn!, MAP(), positions());
    const s = scene('Common room', ids.$inn!, { participants_ids: all(), initiative: [{ id: ids.$bram, value: 10 }] });
    const spec = buildSceneSpec(db, turn(s));
    expect(spec.fight).toBe(false);
    const me = person(spec.people, ids.$thaniesh!);
    expect(person(spec.people, ids.$bram!).face).toEqual({ x: me.x, y: me.y });
  });
});

describe('sketch layouts', () => {
  it('a scene without a battle map gets a sketch with everyone on it, the same one the 3D shot uses', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh] });
    const sketch = layoutFor(db, turn(s));
    expect(sketch).toMatchObject({ sketch: true, scene_id: s, scene_name: 'Common room' });
    expect(sketch.tokens.find((t) => t.id === ids.$thaniesh)!.initials).not.toBe('');
    const spec = buildSceneSpec(db, turn(s));
    expect(spec.people.map((p) => [p.id, p.x, p.y])).toEqual(sketch.tokens.map((t) => [t.id, t.x + 0.5, t.y + 0.5]));
  });
});

describe('materials and indoor/outdoor', () => {
  it('a flooded stone chapel is indoor stone with a water floor', () => {
    const s = scene('Vigil', ids.$chapel!, { participants_ids: [ids.$thaniesh] });
    const spec = buildSceneSpec(db, turn(s));
    expect(spec).toMatchObject({ indoor: true, wall: 'stone', floor: 'water' });
  });

  it('an inn with farmers "flooded out of the east" has a wooden floor, not water', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh] });
    const spec = buildSceneSpec(db, turn(s));
    expect(spec).toMatchObject({ indoor: true, wall: 'wood', floor: 'wood' });
  });

  it('a market street with no walls is outdoor cobbles', () => {
    mapPlace(ids.$market!, MAP([{ kind: 'cover', label: 'fish stall', x: 5, y: 2, w: 2, h: 1 }]), { [ids.$thaniesh!]: { x: 1, y: 1 } });
    const s = scene('the street', ids.$market!, { participants_ids: [ids.$thaniesh] });
    const spec = buildSceneSpec(db, turn(s));
    expect(spec).toMatchObject({ indoor: false, floor: 'cobbles' });
  });

  it('a scene named "Rain Beyond the Inn" at the inn is outdoors', () => {
    const s = scene('Rain Beyond the Inn', ids.$inn!, { participants_ids: [ids.$thaniesh] });
    expect(buildSceneSpec(db, turn(s)).indoor).toBe(false);
  });

  it('walls around the edge of the map make a scene indoor whatever the place says; a single wall does not', () => {
    mapPlace(ids.$market!, MAP([{ kind: 'wall', x: 0, y: 0, w: 10, h: 1 }]), { [ids.$thaniesh!]: { x: 1, y: 1 } });
    const s = scene('the street', ids.$market!, { participants_ids: [ids.$thaniesh] });
    expect(buildSceneSpec(db, turn(s)).indoor).toBe(false);
    const ring = [{ kind: 'wall', x: 0, y: 0, w: 10, h: 1 }, { kind: 'wall', x: 0, y: 7, w: 10, h: 1 }, { kind: 'wall', x: 0, y: 1, w: 1, h: 6 }, { kind: 'door', x: 9, y: 1, w: 1, h: 6 }];
    mapPlace(ids.$market!, MAP(ring), { [ids.$thaniesh!]: { x: 1, y: 1 } });
    expect(buildSceneSpec(db, turn(s)).indoor).toBe(true);
  });
});

describe('time of day and weather', () => {
  const at = (time_min: number) => buildSceneSpec(db, turn(scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh], time_min }))).time;

  it('comes from the scene time_min', () => {
    expect(at(1080)).toBe('dusk');
    expect(at(720)).toBe('day');
    expect(at(60)).toBe('night');
    expect(at(360)).toBe('dawn');
    expect(at(1320)).toBe('night');
    expect(at(1440 + 720)).toBe('day'); // the next day
  });

  it('is rain when the narration or description mentions rain, otherwise clear', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh] });
    expect(buildSceneSpec(db, turn(s, { reply: 'Rain hammers the shutters.' })).weather).toBe('rain');
    expect(buildSceneSpec(db, turn(s, { reply: 'The fire crackles.' })).weather).toBe('clear');
    const wet = seed([op({ op: 'create', ref: '$l', kind: 'location', name: 'Wet Dock', data_json: JSON.stringify({ description: 'Cold rain sheets across the planks.' }) })]).$l!;
    expect(buildSceneSpec(db, turn(scene('Pier', wet, { participants_ids: [ids.$thaniesh] }))).weather).toBe('rain');
  });
});

describe('wounds', () => {
  it('marks the fallen down and the badly hurt wounded, without a map', () => {
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh, ids.$vargas, ids.$marrow] });
    const spec = buildSceneSpec(db, turn(s));
    expect(person(spec.people, ids.$marrow!)).toMatchObject({ down: true });
    expect(person(spec.people, ids.$thaniesh!)).toMatchObject({ down: false, wounded: true });
    expect(person(spec.people, ids.$vargas!)).toMatchObject({ down: false, wounded: false });
  });

  it('marks the fallen down and the badly hurt wounded, on a map', () => {
    mapPlace(ids.$inn!, MAP(), { [ids.$thaniesh!]: { x: 1, y: 1 }, [ids.$vargas!]: { x: 2, y: 1 }, [ids.$marrow!]: { x: 3, y: 1 } });
    const s = scene('Brawl', ids.$inn!, {
      participants_ids: [ids.$thaniesh, ids.$vargas, ids.$marrow],
    });
    const spec = buildSceneSpec(db, turn(s));
    expect(person(spec.people, ids.$marrow!).down).toBe(true);
    expect(person(spec.people, ids.$thaniesh!).wounded).toBe(true);
    expect(person(spec.people, ids.$vargas!)).toMatchObject({ down: false, wounded: false });
  });
});

describe('feature shapes', () => {
  const shapes = (features: object[]) => {
    mapPlace(ids.$inn!, MAP(features), { [ids.$thaniesh!]: { x: 9, y: 7 } });
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh] });
    return buildSceneSpec(db, turn(s)).features.map((f) => f.shape);
  };

  it('come from labels, kinds and fallbacks', () => {
    expect(
      shapes([
        { kind: 'object', label: 'bar counter', x: 0, y: 0, w: 4, h: 1 },
        { kind: 'cover', label: 'oak table', x: 1, y: 2, w: 2, h: 1 },
        { kind: 'cover', x: 5, y: 2, w: 1, h: 1 },
        { kind: 'door', label: 'oak table', x: 9, y: 0, w: 1, h: 1 },
        { kind: 'stairs', x: 8, y: 5, w: 1, h: 2 },
        { kind: 'object', x: 6, y: 5, w: 1, h: 1 },
        { kind: 'cover', label: 'barrel', x: 3, y: 5, w: 1, h: 1 },
      ]),
    ).toEqual(['counter', 'table', 'crate', 'door', 'stairs', 'block', 'barrel']);
  });

  it('keeps feature geometry', () => {
    mapPlace(ids.$inn!, MAP([{ kind: 'cover', label: 'oak table', x: 1, y: 2, w: 3, h: 2 }]), { [ids.$thaniesh!]: { x: 9, y: 7 } });
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh] });
    expect(buildSceneSpec(db, turn(s)).features).toEqual([{ kind: 'cover', shape: 'table', x: 1, y: 2, w: 3, h: 2 }]);
  });

  // BUG: SHAPES uses /\b(barrel|keg|cask|vat)\b/, so the plural "kegs" (or "barrels", "crates",
  // "tables") fails the trailing \b and falls through to the cover fallback 'crate'.
  it('plural label "kegs" becomes a barrel', () => {
    expect(shapes([{ kind: 'cover', label: 'kegs', x: 3, y: 5, w: 2, h: 1 }])).toEqual(['barrel']);
  });
});

describe('camera', () => {
  it('looks at the centroid of focus people from the actor', () => {
    mapPlace(ids.$inn!, MAP(), { [ids.$thaniesh!]: { x: 1, y: 6 }, [ids.$vargas!]: { x: 2, y: 6 }, [ids.$bram!]: { x: 5, y: 1 }, [ids.$cora!]: { x: 8, y: 1 }, [ids.$marrow!]: { x: 9, y: 7 } });
    const s = scene('Common room', ids.$inn!, {
      participants_ids: [ids.$thaniesh, ids.$vargas, ids.$bram, ids.$cora, ids.$marrow],
    });
    const spec = buildSceneSpec(db, turn(s, { reply: 'Bram slams the door.' }));
    const focus = spec.people.filter((p) => p.focus);
    expect(focus.length).toBeGreaterThan(0);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(spec.camera.at.x).toBeCloseTo(avg(focus.map((p) => p.x)));
    expect(spec.camera.at.y).toBeCloseTo(avg(focus.map((p) => p.y)));
    const me = person(spec.people, ids.$thaniesh!);
    expect(spec.camera.from).toEqual({ x: me.x, y: me.y });
    expect(me).toMatchObject({ x: 1.5, y: 6.5 });
  });

  it('centers people on their tokens, including large ones', () => {
    mapPlace(ids.$inn!, MAP(), { [ids.$thaniesh!]: { x: 1, y: 1 }, [ids.$bram!]: { x: 4, y: 4, size: 2 } });
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh, ids.$bram] });
    const spec = buildSceneSpec(db, turn(s));
    expect(person(spec.people, ids.$bram!)).toMatchObject({ x: 5, y: 5, size: 2 });
  });
});

describe('stored map snapshot', () => {
  it('prefers the turn snapshot over the current map', () => {
    mapPlace(ids.$inn!, MAP(), { [ids.$thaniesh!]: { x: 1, y: 1 }, [ids.$vargas!]: { x: 2, y: 1 } });
    const s = scene('Common room', ids.$inn!, { participants_ids: [ids.$thaniesh, ids.$vargas] });
    const snap = mapSnapshot(db, campaign.id, getRecord(db, campaign.id, s))!;
    // The map changes after the turn: Vargas moves and the grid grows.
    mapPlace(ids.$inn!, { ...MAP(), cols: 20 }, { [ids.$vargas!]: { x: 15, y: 6 } });
    const old = buildSceneSpec(db, turn(s, { delivery: { map_snapshot: snap } }));
    expect(old.cols).toBe(10);
    expect(person(old.people, ids.$vargas!)).toMatchObject({ x: 2.5, y: 1.5 });
    const now = buildSceneSpec(db, turn(s));
    expect(now.cols).toBe(20);
    expect(person(now.people, ids.$vargas!)).toMatchObject({ x: 15.5, y: 6.5 });
  });
});

describe('the same place looks the same every visit', () => {
  it('scenes in one mapped place share the set-dressing seed; another place gets its own', () => {
    mapPlace(ids.$inn!, MAP(), { [ids.$thaniesh!]: { x: 1, y: 1 } });
    const first = buildSceneSpec(db, turn(scene('Supper', ids.$inn!, { participants_ids: [ids.$thaniesh] })));
    db.prepare(`UPDATE records SET archived_at = datetime('now') WHERE kind = 'scene'`).run();
    const later = buildSceneSpec(db, turn(scene('Breakfast, days later', ids.$inn!, { participants_ids: [ids.$thaniesh] })));
    expect(first.seed).toBeTypeOf('number');
    expect(later.seed).toBe(first.seed);
    expect(later.cols).toBe(10); // the saved map, not a sketch
    mapPlace(ids.$market!, MAP(), { [ids.$thaniesh!]: { x: 1, y: 1 } });
    const elsewhere = buildSceneSpec(db, turn(scene('Haggling', ids.$market!, { participants_ids: [ids.$thaniesh] })));
    expect(elsewhere.seed).not.toBe(first.seed);
  });
});
