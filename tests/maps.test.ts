// World maps: maps saved on places and positions on the people in them; validation of positions,
// terrain, exits and movement; every place anyone plays in gets mapped (and stays mapped); the
// migration of old scene maps; the public-only snapshot, the deterministic renderer, the GM's text map, posting through the Map button / map:true / /rpg map, and the
// 3D map and diorama (one Blender scene, different cameras; a fake renderer stands in).
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Semaphore } from '../src/agent.js';
import { ImageQueue } from '../src/images.js';
import { createCampaign } from '../src/campaign.js';
import { loadConfig } from '../src/config.js';
import { handleModal } from '../src/discord.js';
import { getCampaign, getRecord, getTurn, openDatabase, type Db } from '../src/database.js';
import { asciiMap, composedMapGeometry, mapSnapshot, migrateSceneMaps, renderMapOverlaySvg, renderMapSvg, tokenColor } from '../src/maps.js';
import type { ModelProvider, ProviderRequest, ProviderResponse, ToolCall } from '../src/providers.js';
import { planBatch, writeBatch } from '../src/records.js';
import { TurnRunner, type DeliveryPort, type DeliveryTarget, type OutboundMessage } from '../src/turns.js';
import type { SceneSpec } from '../src/scene3d.js';
import type { CampaignRow } from '../src/types.js';

const op = (o: Record<string, unknown>) => ({
  ref: null, record_id: null, kind: null, name: null, parent_id: null, visibility: null, path: null,
  value_json: null, data_json: null, gm_notes_json: null, expected_json: null, expected_version: null, delta: null, ...o,
});
const save = (operations: object[], reply = 'Done.'): Omit<ToolCall, 'id'> => ({
  name: 'save_turn',
  arguments: JSON.stringify({ expected_revision: 0, operations, public_reply: reply, gm_note: '', source_refs: [], roll_ids: [] }),
});

class ScriptProvider implements ModelProvider {
  name = 'fake'; model = 'fake'; paid = false; inputUsdPerMillion = 0; outputUsdPerMillion = 0;
  steps: ((req: ProviderRequest) => { toolCalls: Omit<ToolCall, 'id'>[] })[] = [];
  private n = 0;
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const step = this.steps.shift();
    if (!step) throw new Error('no step');
    const out = step(req);
    return { assistant: { type: 'assistant', text: null, toolCalls: out.toolCalls.map((c) => ({ ...c, id: `c${++this.n}` })) }, usage: { inputTokens: 1, outputTokens: 1 }, status: 'completed' };
  }
  async check() { return 'ok'; }
}

class FakeDelivery implements DeliveryPort {
  sent: { channelId: string; message: OutboundMessage }[] = [];
  async send(t: DeliveryTarget, m: OutboundMessage) {
    this.sent.push({ channelId: t.channelId, message: m });
    return `m${this.sent.length}`;
  }
  async createThread() { return 'thread1'; }
  async archiveThread() {}
}

let dir: string;
let db: Db;
let campaign: CampaignRow;
let ids: Record<string, string>;
let provider: ScriptProvider;
let delivery: FakeDelivery;
let runner: TurnRunner;

function seed(ops: object[]) {
  return db.transaction(() => {
    const plan = planBatch(db, ops as never, { campaignId: campaign.id, actorUserId: 'owner', constraints: [] });
    writeBatch(db, campaign.id, plan);
    return plan.created;
  })();
}
const tryBatch = (ops: object[]) => () => planBatch(db, ops as never, { campaignId: campaign.id, actorUserId: 'owner', constraints: [] });
const version = (id: string) => getRecord(db, campaign.id, id)!.version;
const data = (id: string) => JSON.parse(getRecord(db, campaign.id, id)!.data_json) as Record<string, any>;
const gmNotes = (id: string) => JSON.parse(getRecord(db, campaign.id, id)!.gm_notes_json || '{}') as Record<string, any>;
const MAP = { cols: 10, rows: 8, cell_ft: 5, features: [{ kind: 'wall', label: 'bar', x: 0, y: 0, w: 4, h: 1 }, { kind: 'cover', x: 6, y: 3, w: 1, h: 2 }] };
const INN = 'Crooked Kettle Inn';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-map-'));
  db = openDatabase(path.join(dir, 'rpg.sqlite'));
  campaign = createCampaign(db, { guildId: 'g', channelId: 'main-chan', ownerUserId: 'owner', title: 'T', premise: '', rules_edition: '', tone: '', max_players: 4, boundaries: '', require_character_approval: false });
  db.prepare(`UPDATE campaigns SET status = 'active' WHERE id = ?`).run(campaign.id);
  // The inn holds its map (hidden terrain in gm_notes); everyone in it holds their own position.
  ids = seed([
    op({ op: 'create', ref: '$inn', kind: 'location', name: INN, data_json: JSON.stringify({ map: MAP }), gm_notes_json: JSON.stringify({ map_features: [{ kind: 'pit', label: 'trapdoor', x: 8, y: 1, w: 1, h: 1 }] }) }),
    op({ op: 'create', ref: '$thaniesh', kind: 'character', name: 'Thaniesh', parent_id: '$inn', data_json: JSON.stringify({ hp: { current: 4, max: 10 }, pos: { x: 2, y: 3 } }) }),
    op({ op: 'create', ref: '$vargas', kind: 'character', name: 'Vargas', parent_id: '$inn', data_json: JSON.stringify({ hp: { current: 10, max: 10 }, pos: { x: 3, y: 3 } }) }),
    op({ op: 'create', ref: '$marrow', kind: 'npc', name: 'Marrow Gale', parent_id: '$inn', data_json: JSON.stringify({ hp: { current: 0, max: 9 }, pos: { x: 5, y: 4 } }) }),
    op({ op: 'create', ref: '$spy', kind: 'npc', name: 'Hidden Spy', parent_id: '$inn', visibility: 'gm', data_json: '{}', gm_notes_json: JSON.stringify({ pos: { x: 9, y: 7 } }) }),
  ]);
  db.prepare(`UPDATE members SET character_record_id = ? WHERE campaign_id = ? AND discord_user_id = 'owner'`).run(ids.$thaniesh, campaign.id);
  db.prepare(`INSERT INTO members (campaign_id, discord_user_id, character_record_id, role, created_at) VALUES (?, 'u-v', ?, 'player', '')`).run(campaign.id, ids.$vargas);
  const fighters = [ids.$thaniesh, ids.$vargas, ids.$marrow];
  Object.assign(
    ids,
    seed([
      op({
        op: 'create', ref: '$brawl', kind: 'scene', name: 'Brawl at the Inn', parent_id: ids.$inn,
        data_json: JSON.stringify({ status: 'active', main: true, participants_ids: fighters, initiative: fighters.map((id, i) => ({ id, value: 20 - i })), turn_of_id: ids.$vargas, round: 2, time_min: 1080 }),
      }),
    ]),
  );
  campaign = getCampaign(db, campaign.id)!;
  provider = new ScriptProvider();
  delivery = new FakeDelivery();
  runner = new TurnRunner({ db, config: loadConfig({ DATA_DIR: dir, LLM_PROVIDER: 'ollama' }), provider, delivery, modelLimiter: new Semaphore(2) });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Sets a creature's position on its place's map. */
const setPos = (id: string, value: unknown, field = 'data') => op({ op: 'set', record_id: id, path: `${field}.pos`, value_json: JSON.stringify(value), expected_version: version(id) });
const setMap = (id: string, map: unknown) => op({ op: 'set', record_id: id, path: 'data.map', value_json: JSON.stringify(map), expected_version: version(id) });
const moveTo = (id: string, parent: string) => op({ op: 'move', record_id: id, parent_id: parent });
/** The text of the last tool result the GM was sent back. */
const lastOutput = (req: ProviderRequest) => { const it = req.items.at(-1) as { output?: string } | undefined; if (!it?.output) return JSON.stringify(it); try { const o = JSON.parse(it.output) as { error?: string }; return o.error ?? it.output; } catch { return it.output; } };
/** A play turn by `userId` whose GM tries each save in turn; returns the turn and the feedback each retry got. */
async function playWith(userId: string, saves: Omit<ToolCall, 'id'>[]) {
  const feedback: string[] = [];
  saves.forEach((s, i) =>
    provider.steps.push((req) => {
      if (i > 0) feedback.push(lastOutput(req));
      return { toolCalls: [s] };
    }),
  );
  const r = runner.submit({ campaign, userId, mode: 'play', requestId: `p${Math.random()}`, text: 'I act', target: { channelId: 'main-chan', ephemeral: false } });
  await runner.idle();
  return { turn: getTurn(db, r.turnId!)!, feedback };
}
/** Adds a player character (and its member) standing in a place. */
function addPlayer(userId: string, name: string, parent: string, extra: object = {}): string {
  const id = seed([op({ op: 'create', ref: '$p', kind: 'character', name, parent_id: parent, data_json: JSON.stringify(extra) })]).$p!;
  db.prepare(`INSERT INTO members (campaign_id, discord_user_id, character_record_id, role, created_at) VALUES (?, ?, ?, 'player', '')`).run(campaign.id, userId, id);
  return id;
}

describe('map validation', () => {
  it('accepts a legal move and a bystander placed without joining the scene', () => {
    expect(tryBatch([setPos(ids.$vargas!, { x: 4, y: 5 })])).not.toThrow();
    // Positions belong to the place, so anyone there can stand on the map, in the scene or not.
    expect(tryBatch([op({ op: 'create', ref: '$x', kind: 'npc', name: 'Bystander', parent_id: ids.$inn, data_json: JSON.stringify({ pos: { x: 7, y: 7 } }) })])).not.toThrow();
  });

  it('rejects out of bounds, shared cells and walls', () => {
    expect(tryBatch([setPos(ids.$vargas!, { x: 10, y: 3 })])).toThrow(/needs whole-cell x 0-9, y 0-7/);
    expect(tryBatch([setPos(ids.$vargas!, { x: 2, y: 3 })])).toThrow(/share cell 2,3; one creature per cell/);
    expect(tryBatch([setPos(ids.$vargas!, { x: 1, y: 0 })])).toThrow(/inside a wall or object at 1,0/);
    expect(tryBatch([setPos(ids.$vargas!, { x: 8, y: 6, size: 3 })])).toThrow(/needs whole-cell .*inside the 10x8 map/);
    // A secret position counts too: nobody may stand on the hidden spy.
    expect(tryBatch([setPos(ids.$vargas!, { x: 9, y: 7 })])).toThrow(/share cell 9,7/);
  });

  it('needs a well-formed map, and a map under anyone who has a position', () => {
    const bad = (map: unknown) => tryBatch([setMap(ids.$inn!, map)]);
    expect(bad({ cols: 100, rows: 8 })).toThrow(/cols and rows between 1 and 60/);
    expect(bad({ ...MAP, features: [{ kind: 'lava', x: 0, y: 0, w: 1, h: 1 }] })).toThrow(/kind must be one of/);
    expect(bad({ ...MAP, features: [{ kind: 'wall', x: 8, y: 0, w: 5, h: 1 }] })).toThrow(/extends past the 10x8 grid/);
    // A new wall where someone stands.
    expect(bad({ ...MAP, features: [{ kind: 'wall', x: 0, y: 3, w: 10, h: 1 }] })).toThrow(/Thaniesh .* stands inside a wall/);
    expect(tryBatch([op({ op: 'remove', record_id: ids.$inn, path: 'data.map', expected_version: version(ids.$inn!) })])).toThrow(/has a position but .* has no map yet/);
  });

  it('a scene no longer holds a map or positions', () => {
    const onScene = (p: string, v: unknown) => tryBatch([op({ op: 'set', record_id: ids.$brawl, path: p, value_json: JSON.stringify(v), expected_version: version(ids.$brawl!) })]);
    expect(onScene('data.map', MAP)).toThrow(/maps and positions belong to places now/);
    expect(onScene('data.positions', { [ids.$vargas!]: { x: 4, y: 5 } })).toThrow(/maps and positions belong to places now/);
    expect(onScene('gm_notes.positions', { [ids.$spy!]: { x: 9, y: 6 } })).toThrow(/gm_notes\.pos on each hidden creature/);
    expect(tryBatch([op({ op: 'create', ref: '$s', kind: 'scene', name: 'Side', parent_id: ids.$inn, data_json: JSON.stringify({ status: 'active', map: MAP }) })])).toThrow(/belong to places now/);
  });

  it('moving to another place takes a position on its map, not the old one', () => {
    const alley = (pos: object | null) =>
      tryBatch([
        op({ op: 'create', ref: '$alley', kind: 'location', name: 'Back alley', data_json: JSON.stringify({ map: { cols: 3, rows: 3, cell_ft: 5, features: [] } }) }),
        moveTo(ids.$vargas!, '$alley'),
        ...(pos ? [setPos(ids.$vargas!, pos)] : []),
      ]);
    expect(alley(null)).toThrow(/Vargas .* needs whole-cell x 0-2/); // 3,3 was a cell of the inn
    expect(alley({ x: 1, y: 1 })).not.toThrow();
    // A place without a map cannot hold positions.
    expect(
      tryBatch([op({ op: 'create', ref: '$void', kind: 'location', name: 'Fog', data_json: '{}' }), moveTo(ids.$vargas!, '$void'), setPos(ids.$vargas!, { x: 0, y: 0 })]),
    ).toThrow(/has a position but Fog .* has no map yet/);
  });

  it('exits must lead to a live location', () => {
    const made = seed([
      op({ op: 'create', ref: '$street', kind: 'location', name: 'Market Lane', data_json: '{}' }),
      op({ op: 'create', ref: '$gone', kind: 'location', name: 'Burnt Shed', data_json: '{}' }),
    ]);
    db.prepare(`UPDATE records SET archived_at = datetime('now') WHERE id = ?`).run(made.$gone);
    const exitTo = (to: unknown) => tryBatch([setMap(ids.$inn!, { ...MAP, features: [...MAP.features, { kind: 'exit', label: 'street door', x: 9, y: 4, w: 1, h: 1, to }] })]);
    expect(exitTo('location_nowhere')).toThrow(/\.to must be the id of a live location/);
    expect(exitTo(ids.$thaniesh)).toThrow(/\.to must be the id of a live location/);
    expect(exitTo(made.$gone)).toThrow(/\.to must be the id of a live location/);
    expect(exitTo(made.$street)).not.toThrow();
    // Hidden exits are checked too.
    expect(tryBatch([op({ op: 'set', record_id: ids.$inn, path: 'gm_notes.map_features', value_json: JSON.stringify([{ kind: 'door', x: 9, y: 0, w: 1, h: 1, to: 'nope' }]), expected_version: version(ids.$inn!) })])).toThrow(
      /gm_notes\.map_features\[0\]\.to must be the id of a live location/,
    );
  });
});

describe('movement', () => {
  /** Two cellars: one split by a wall from end to end, one where the wall leaves a gap at the bottom. */
  const cellars = () =>
    seed([
      op({ op: 'create', ref: '$sealed', kind: 'location', name: 'Sealed cellar', data_json: JSON.stringify({ map: { cols: 10, rows: 5, cell_ft: 5, features: [{ kind: 'wall', x: 5, y: 0, w: 1, h: 5 }] } }) }),
      op({ op: 'create', ref: '$open', kind: 'location', name: 'Open cellar', data_json: JSON.stringify({ map: { cols: 10, rows: 5, cell_ft: 5, features: [{ kind: 'wall', x: 5, y: 0, w: 1, h: 4 }] } }) }),
      op({ op: 'create', ref: '$rat1', kind: 'npc', name: 'Rat-catcher', parent_id: '$sealed', data_json: JSON.stringify({ speed: 10, pos: { x: 2, y: 1 } }) }),
      op({ op: 'create', ref: '$rat2', kind: 'npc', name: 'Rat-catcher', parent_id: '$open', data_json: JSON.stringify({ speed: 10, pos: { x: 2, y: 1 } }) }),
    ]);

  it('a move through a wall with no way around is rejected; around it is fine, however long outside a fight', () => {
    const c = cellars();
    expect(tryBatch([setPos(c.$rat1!, { x: 7, y: 1 })])).toThrow(/Rat-catcher cannot get from 2,1 to 7,1: walls or objects are in the way/);
    // Around the end of the wall: 6 moves, far more than a 20 ft dash, but nobody is fighting.
    expect(tryBatch([setPos(c.$rat2!, { x: 7, y: 1 })])).not.toThrow();
  });

  it('no squeezing diagonally past the corner where two walls meet', () => {
    const c = seed([
      op({ op: 'create', ref: '$l', kind: 'location', name: 'Corner', data_json: JSON.stringify({ map: { cols: 3, rows: 3, cell_ft: 5, features: [{ kind: 'wall', x: 1, y: 0, w: 1, h: 1 }, { kind: 'wall', x: 0, y: 1, w: 1, h: 1 }, { kind: 'wall', x: 2, y: 1, w: 1, h: 2 }, { kind: 'wall', x: 1, y: 2, w: 1, h: 1 }] } }) }),
      op({ op: 'create', ref: '$n', kind: 'npc', name: 'Cat', parent_id: '$l', data_json: JSON.stringify({ pos: { x: 0, y: 0 } }) }),
    ]);
    expect(tryBatch([setPos(c.$n!, { x: 1, y: 1 })])).toThrow(/cannot get from 0,0 to 1,1/);
  });

  it('in a fight a move longer than a dash (2x speed) is rejected', () => {
    seed([op({ op: 'set', record_id: ids.$vargas, path: 'data.speed', value_json: '10', expected_version: version(ids.$vargas!) })]);
    expect(tryBatch([setPos(ids.$vargas!, { x: 9, y: 3 })])).toThrow(/Vargas moved 30 ft \(3,3 to 9,3\); in a fight that is more than a dash \(20 ft\)/);
    expect(tryBatch([setPos(ids.$vargas!, { x: 7, y: 3 })])).not.toThrow(); // 20 ft, through the cover
    // The same walk once the fight is over.
    seed([op({ op: 'remove', record_id: ids.$brawl, path: 'data.initiative', expected_version: version(ids.$brawl!) })]);
    expect(tryBatch([setPos(ids.$vargas!, { x: 9, y: 3 })])).not.toThrow();
  });
});

describe('every place anyone plays in is mapped', () => {
  it('a play turn in an unmapped place is sent back until the save adds the map and a position for everyone there', async () => {
    const mill = seed([op({ op: 'create', ref: '$m', kind: 'location', name: 'Old Mill', data_json: JSON.stringify({ description: 'A creaking water mill.' }) })]).$m!;
    const duking = addPlayer('u-d', 'Duking', mill);
    const miller = seed([op({ op: 'create', ref: '$n', kind: 'npc', name: 'Miller', parent_id: mill, data_json: '{}' })]).$n!;
    const millMap = { cols: 12, rows: 10, cell_ft: 5, features: [{ kind: 'object', label: 'millstone', x: 5, y: 4, w: 2, h: 2 }, { kind: 'exit', label: 'door', x: 0, y: 5, w: 1, h: 1, to: ids.$inn }] };
    const { turn, feedback } = await playWith('u-d', [
      save([], 'You look around.'),
      save([setMap(mill, millMap)], 'You look around.'),
      save([setMap(mill, millMap), setPos(duking, { x: 1, y: 5 }), setPos(miller, { x: 8, y: 2 }, 'gm_notes')], 'You look around.'),
    ]);
    expect(feedback[0]).toMatch(/Old Mill \(location_\w+\) has no map, and .+ (is|are) there/);
    expect(feedback[1]).toContain(`Duking (${duking}) needs a position on the map of Old Mill`);
    // A bystander nobody touched may stay unplaced until they matter (the GM placed him anyway).
    expect(feedback[1]).not.toContain('Miller');
    expect(turn.status).toBe('delivered');
    expect(data(mill).map).toEqual(millMap);
    expect(data(duking).pos).toEqual({ x: 1, y: 5 });
    expect(gmNotes(miller).pos).toEqual({ x: 8, y: 2 }); // a secret position
  });

  it('people standing directly in a town are told to create the specific place inside it', async () => {
    const town = seed([op({ op: 'create', ref: '$t', kind: 'location', name: 'Wickmere', data_json: JSON.stringify({ description: 'A river town.' }) })]).$t!;
    const duking = addPlayer('u-d', 'Duking', town);
    const lane = { cols: 20, rows: 14, cell_ft: 5, features: [{ kind: 'exit', label: 'to the inn', x: 19, y: 7, w: 1, h: 1, to: ids.$inn }] };
    const { turn, feedback } = await playWith('u-d', [
      save([], 'You walk into town.'),
      save([op({ op: 'create', ref: '$lane', kind: 'location', name: 'Wickmere, market lane', parent_id: town, data_json: JSON.stringify({ map: lane }) }), moveTo(duking, '$lane'), setPos(duking, { x: 3, y: 7 })], 'You walk into town.'),
    ]);
    expect(feedback[0]).toContain(`create the specific place inside it (kind "location", parent_id ${town}`);
    expect(turn.status).toBe('delivered');
    const laneId = getRecord(db, campaign.id, duking)!.parent_id!;
    expect(getRecord(db, campaign.id, laneId)!).toMatchObject({ name: 'Wickmere, market lane', parent_id: town });
    expect(data(town).map).toBeUndefined(); // the town itself stays a region
  });

  it('editing a place (a new exit) and walking about do not drag in bystanders nobody touched', async () => {
    const millMap = { cols: 12, rows: 10, cell_ft: 5, features: [{ kind: 'object', label: 'millstone', x: 5, y: 4, w: 2, h: 2 }] };
    const mill = seed([op({ op: 'create', ref: '$m', kind: 'location', name: 'Old Mill', data_json: JSON.stringify({ map: millMap }) })]).$m!;
    const duking = addPlayer('u-d', 'Duking', mill, { pos: { x: 1, y: 5 } });
    seed([op({ op: 'create', ref: '$n', kind: 'npc', name: 'Miller', parent_id: mill, data_json: '{}' })]); // never placed
    const withExit = { ...millMap, features: [...millMap.features, { kind: 'exit', label: 'mill race', x: 11, y: 5, w: 1, h: 1, to: ids.$inn }] };
    const { turn, feedback } = await playWith('u-d', [save([setMap(mill, withExit), setPos(duking, { x: 3, y: 5 })], 'You find the mill race.'), save([], 'unused')]);
    expect(feedback).toEqual([]);
    expect(turn.status).toBe('delivered');
  });

  it('leaving a town for a new mapped place is fine while a friend still stands in the (unmapped) town', async () => {
    const town = seed([op({ op: 'create', ref: '$t', kind: 'location', name: 'Wickmere', data_json: JSON.stringify({ description: 'A river town.' }) })]).$t!;
    const duking = addPlayer('u-d', 'Duking', town);
    const friend = addPlayer('u-f', 'Thaniesh', town);
    const bank = { cols: 10, rows: 8, cell_ft: 5, features: [{ kind: 'water', label: 'river channel', x: 5, y: 0, w: 5, h: 8 }, { kind: 'exit', label: 'boardwalk back to Wickmere', x: 0, y: 4, w: 1, h: 1 }] };
    const { turn, feedback } = await playWith('u-d', [
      save([op({ op: 'create', ref: '$bank', kind: 'location', name: 'Innside Riverbank', parent_id: town, data_json: JSON.stringify({ map: bank }) }), moveTo(duking, '$bank'), setPos(duking, { x: 1, y: 4 })], 'You go down to the river.'),
      save([], "unused"),
    ]);
    expect(feedback).toEqual([]);
    expect(turn.status).toBe('delivered');
    expect(getRecord(db, campaign.id, friend)!.parent_id).toBe(town);
  });

  it('a character in no location at all is sent to one', async () => {
    const duking = addPlayer('u-d', 'Duking', null as never);
    const { turn, feedback } = await playWith('u-d', [
      save([], 'You wake.'),
      save([moveTo(duking, ids.$inn!), setPos(duking, { x: 4, y: 6 })], 'You wake in the inn.'),
    ]);
    expect(feedback[0]).toMatch(/Duking is not in any location/);
    expect(turn.status).toBe('delivered');
  });

  it('a new place made on the fly persists, and the old place keeps its map and the people left in it', async () => {
    const alleyMap = { cols: 6, rows: 4, cell_ft: 5, features: [{ kind: 'exit', label: 'back door', x: 0, y: 1, w: 1, h: 1, to: ids.$inn }] };
    const { turn, feedback } = await playWith('u-v', [
      save(
        [
          op({ op: 'create', ref: '$alley', kind: 'location', name: 'Back alley', data_json: JSON.stringify({ description: 'A muddy alley behind the inn.', map: alleyMap }) }),
          moveTo(ids.$vargas!, '$alley'),
          setPos(ids.$vargas!, { x: 1, y: 1 }),
        ],
        'You slip out the back door.',
      ),
    ]);
    expect(feedback).toEqual([]);
    expect(turn.status).toBe('delivered');
    const alley = getRecord(db, campaign.id, ids.$vargas!)!.parent_id!;
    expect(data(alley).map).toEqual(alleyMap);
    expect(asciiMap(db, campaign.id, alley, ids.$vargas!)).toMatch(new RegExp(`exit "back door" at 0,1 1x1 -> leads to ${INN} \\(${ids.$inn}\\)`));
    // The inn is as it was left: its map, Marrow by the bar, Thaniesh, and the spy's secret spot.
    expect(data(ids.$inn!).map).toEqual(MAP);
    expect(data(ids.$marrow!).pos).toEqual({ x: 5, y: 4 });
    expect(data(ids.$thaniesh!).pos).toEqual({ x: 2, y: 3 });
    expect(gmNotes(ids.$spy!).pos).toEqual({ x: 9, y: 7 });
    const snap = mapSnapshot(db, campaign.id, getRecord(db, campaign.id, ids.$brawl!))!;
    expect(snap.tokens.map((t) => t.name)).toEqual(['Thaniesh', 'Marrow Gale']);
    // Coming back later: the same room, the same people where they were.
    seed([moveTo(ids.$vargas!, ids.$inn!), setPos(ids.$vargas!, { x: 0, y: 4 })]);
    const back = mapSnapshot(db, campaign.id, getRecord(db, campaign.id, ids.$brawl!))!;
    expect(back.tokens.map((t) => [t.name, t.x, t.y])).toEqual([['Thaniesh', 2, 3], ['Vargas', 0, 4], ['Marrow Gale', 5, 4]]);
    expect(data(alley).map).toEqual(alleyMap); // and the alley is still there for next time
  });
});

describe('migrating maps saved on scenes', () => {
  it('moves a scene map and its positions (public and secret) to the place and the people, once, and keeps a map a place already has', () => {
    const made = seed([
      op({ op: 'create', ref: '$mill', kind: 'location', name: 'Old Mill', data_json: '{}' }),
      op({ op: 'create', ref: '$a', kind: 'npc', name: 'Miller', parent_id: '$mill', data_json: '{}' }),
      op({ op: 'create', ref: '$b', kind: 'npc', name: 'Lurker', parent_id: '$mill', data_json: '{}' }),
      op({ op: 'create', ref: '$s', kind: 'scene', name: 'Old fight', parent_id: '$mill', data_json: '{"status":"active"}' }),
      op({ op: 'create', ref: '$s2', kind: 'scene', name: 'Older fight', parent_id: ids.$inn, data_json: '{"status":"ended"}' }),
    ]);
    const oldMap = { cols: 6, rows: 6, cell_ft: 5, features: [{ kind: 'object', label: 'millstone', x: 2, y: 2, w: 2, h: 2 }] };
    // Old-style data, written directly (the validator refuses it now).
    db.prepare('UPDATE records SET data_json = ?, gm_notes_json = ? WHERE id = ?').run(
      JSON.stringify({ status: 'active', round: 1, map: oldMap, positions: { [made.$a!]: { x: 0, y: 0 } } }),
      JSON.stringify({ positions: { [made.$b!]: { x: 5, y: 5 } }, map_features: [{ kind: 'pit', x: 1, y: 4, w: 1, h: 1 }], note: 'keep me' }),
      made.$s,
    );
    db.prepare('UPDATE records SET data_json = ? WHERE id = ?').run(JSON.stringify({ status: 'ended', map: { cols: 4, rows: 4, cell_ft: 5, features: [] }, positions: { [ids.$vargas!]: { x: 0, y: 0 } } }), made.$s2);
    expect(migrateSceneMaps(db)).toBe(2);
    expect(data(made.$mill!).map).toEqual(oldMap);
    expect(gmNotes(made.$mill!).map_features).toEqual([{ kind: 'pit', x: 1, y: 4, w: 1, h: 1 }]);
    expect(data(made.$a!).pos).toEqual({ x: 0, y: 0 });
    expect(gmNotes(made.$b!).pos).toEqual({ x: 5, y: 5 });
    expect(data(made.$b!).pos).toBeUndefined();
    expect(data(made.$s!)).toEqual({ status: 'active', round: 1 });
    expect(gmNotes(made.$s!)).toEqual({ note: 'keep me' });
    // The inn already had a map, and Vargas a position: both stay; the scene is cleaned anyway.
    expect(data(ids.$inn!).map).toEqual(MAP);
    expect(data(ids.$vargas!).pos).toEqual({ x: 3, y: 3 });
    expect(data(made.$s2!)).toEqual({ status: 'ended' });
    // Idempotent: nothing left to move, nothing changes.
    const versions = [made.$mill, made.$a, made.$b, made.$s].map((id) => version(id!));
    expect(migrateSceneMaps(db)).toBe(0);
    expect([made.$mill, made.$a, made.$b, made.$s].map((id) => version(id!))).toEqual(versions);
    expect(data(made.$mill!).map).toEqual(oldMap);
  });
});

describe('map snapshot and rendering', () => {
  it('shows public tokens only, with state and whose turn it is; hidden ones never appear', () => {
    const snap = mapSnapshot(db, campaign.id, getRecord(db, campaign.id, ids.$brawl!))!;
    expect(snap.tokens.map((t) => [t.name, t.initials, t.hp, t.isTurn])).toEqual([
      ['Thaniesh', 'Th', 'wounded', false],
      ['Vargas', 'Va', 'ok', true],
      ['Marrow Gale', 'MG', 'down', false],
    ]);
    expect(snap).toMatchObject({ scene_id: ids.$brawl, scene_name: INN, place_id: ids.$inn, round: 2, turn_of: 'Vargas' });
    const svg = renderMapSvg(snap);
    expect(svg).toContain(INN);
    expect(svg).toContain("Round 2 · Vargas's turn");
    expect(svg).not.toMatch(/Spy|trapdoor/);
    expect(JSON.stringify(snap)).not.toContain(ids.$spy!);
  });

  it('shows everyone public standing in the place, not just the scene participants, and never secret or concealed ones', () => {
    const made = seed([
      op({ op: 'create', ref: '$by', kind: 'npc', name: 'Bystander', parent_id: ids.$inn, data_json: JSON.stringify({ pos: { x: 7, y: 7 } }) }),
      op({ op: 'create', ref: '$sh', kind: 'npc', name: 'Shadow', parent_id: ids.$inn, data_json: '{}', gm_notes_json: JSON.stringify({ pos: { x: 8, y: 7 } }) }),
      op({ op: 'create', ref: '$lu', kind: 'npc', name: 'Lurker', parent_id: ids.$inn, data_json: JSON.stringify({ conditions: ['invisible'], pos: { x: 8, y: 5 } }) }),
      op({ op: 'create', ref: '$cart', kind: 'container', name: 'Cart', parent_id: ids.$inn, data_json: '{}' }),
      op({ op: 'create', ref: '$kid', kind: 'npc', name: 'Stowaway', parent_id: '$cart', data_json: JSON.stringify({ pos: { x: 9, y: 2 } }) }),
    ]);
    const snap = mapSnapshot(db, campaign.id, getRecord(db, campaign.id, ids.$brawl!))!;
    expect(snap.tokens.map((t) => t.name)).toEqual(['Thaniesh', 'Vargas', 'Marrow Gale', 'Bystander', 'Stowaway']);
    const text = JSON.stringify(snap);
    for (const hidden of [made.$sh!, made.$lu!, ids.$spy!, 'Shadow', 'Lurker', '8,7']) expect(text).not.toContain(hidden);
    expect(text).not.toContain('"pos"');
  });

  it('draws tokens in their cells with their colors, a turn halo and grey for the downed', () => {
    const snap = mapSnapshot(db, campaign.id, getRecord(db, campaign.id, ids.$brawl!))!;
    const img = new Resvg(renderMapSvg(snap), { font: { loadSystemFonts: false } }).render();
    expect(img.width).toBe(10 * 48 + 300);
    const px = (x: number, y: number) => {
      const i = (y * img.width + x) * 4;
      return `#${[...img.pixels.subarray(i, i + 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    };
    const cell = (cx: number, cy: number, dx = 0.5, dy = 0.5) => px(Math.round((cx + dx) * 48), Math.round(52 + (cy + dy) * 48));
    expect(cell(2, 3, 0.5, 0.25)).toBe(tokenColor(ids.$thaniesh!, 'character'));
    expect(cell(5, 4, 0.3, 0.5)).toBe('#8a8a8a'); // downed: grey
    expect(cell(3, 3, 0.5, -0.025)).toBe('#ffcc33'); // halo just outside Vargas's token
    expect(cell(1, 0)).toBe('#3b3b44'); // wall
  });

  it('gives the GM a text map with hidden things marked and distances from the actor', () => {
    const text = asciiMap(db, campaign.id, ids.$inn!, ids.$vargas!)!;
    expect(text).toContain('10x8 grid, 5 ft per cell');
    expect(text).toMatch(/MG = Marrow Gale \(.+\) at 5,4, south-east of the actor \(se\), 10 ft/);
    expect(text).toMatch(/HS = Hidden Spy \(.+\) at 9,7 \[hidden from players\]/);
    expect(text).toContain('pit "trapdoor" at 8,1 1x1 [hidden: gm_notes]');
    expect(asciiMap(db, campaign.id, ids.$brawl!, null)).toBeNull(); // a scene is not a place
  });

  it('the text map lists exits and where they lead, people not placed yet, items lying about, and concealed people as hidden', () => {
    const made = seed([
      op({ op: 'create', ref: '$street', kind: 'location', name: 'Market Lane', data_json: '{}' }),
      op({ op: 'create', ref: '$cellar', kind: 'location', name: 'Cellar', data_json: '{}' }),
      op({ op: 'create', ref: '$key', kind: 'item', name: 'Iron key', parent_id: ids.$inn, data_json: JSON.stringify({ pos: { x: 6, y: 3 } }) }),
      op({ op: 'create', ref: '$late', kind: 'npc', name: 'Latecomer', parent_id: ids.$inn, data_json: '{}' }),
      op({ op: 'create', ref: '$lu', kind: 'npc', name: 'Lurker', parent_id: ids.$inn, data_json: JSON.stringify({ conditions: ['hidden'], pos: { x: 8, y: 5 } }) }),
    ]);
    seed([setMap(ids.$inn!, { ...MAP, features: [...MAP.features, { kind: 'exit', label: 'street door', x: 9, y: 4, w: 1, h: 1, to: made.$street }, { kind: 'stairs', x: 9, y: 6, w: 1, h: 1, to: made.$cellar }] })]);
    const text = asciiMap(db, campaign.id, ids.$inn!, ids.$vargas!)!;
    expect(text).toContain(`exit "street door" at 9,4 1x1 -> leads to Market Lane (${made.$street})`);
    expect(text).toContain(`stairs at 9,6 1x1 -> leads to Cellar (${made.$cellar})`);
    expect(text).toContain(`Not placed yet (give them data.pos when they come into the story): Latecomer (${made.$late})`);
    expect(text).toContain(`item Iron key (${made.$key}) at 6,3, east of the actor (e), 15 ft`);
    expect(text).toMatch(/Lu = Lurker \(.+\) at 8,5 \[hidden from players\]/);
    const rows = text.split('\n');
    expect(rows[1 + 3]!.slice(12, 14)).toBe(' i'); // the key on its cell (row 3, column 6)
    expect(rows[1 + 4]!.slice(18, 20)).toBe(' >'); // the street door
    // Players see the exit too, labeled with where it leads when they have no label of their own.
    const snap = mapSnapshot(db, campaign.id, getRecord(db, campaign.id, ids.$brawl!))!;
    expect(snap.features.filter((f) => f.x === 9)).toEqual([
      { kind: 'exit', label: 'street door', x: 9, y: 4, w: 1, h: 1 },
      { kind: 'stairs', label: 'to Cellar', x: 9, y: 6, w: 1, h: 1 },
    ]);
  });
});

describe('posting maps', () => {
  it('play map:true posts the turn map under the reply, and the Map button does not post twice', async () => {
    provider.steps.push(() => ({ toolCalls: [save([setPos(ids.$vargas!, { x: 4, y: 3 })], 'You step closer.')] }));
    const r = runner.submit({ campaign, userId: 'u-v', mode: 'play', requestId: 'p1', text: 'step closer', target: { channelId: 'main-chan', ephemeral: false }, map: true });
    await runner.idle();
    const t = getTurn(db, r.turnId!)!;
    expect(delivery.sent[0]!.message.buttons?.map((b) => b.customId)).toEqual([`rpg:map:${t.id}:0`, `rpg:look:${t.id}:0`]);
    expect(delivery.sent[0]!.message.content).not.toMatch(/data\.pos|positions|participants_ids/); // bookkeeping is not shown as changes
    const posted = delivery.sent.find((m) => m.message.file?.name === `map-${t.id}.png`)!;
    expect(posted.message.replyTo).toBe('m1');
    expect(posted.channelId).toBe('main-chan');
    expect(fs.existsSync(posted.message.file!.path!)).toBe(true);
    expect((JSON.parse(t.delivery_json).map_snapshot.tokens as { name: string; x: number }[]).find((x) => x.name === 'Vargas')!.x).toBe(4);
    expect(await runner.postMap(t.id, campaign.id)).toMatch(/already posted/);
  });

  it('a play save in a place that lost its map is sent back to draw one', async () => {
    const { map: _m, ...rest } = data(ids.$inn!);
    db.prepare('UPDATE records SET data_json = ? WHERE id = ?').run(JSON.stringify(rest), ids.$inn);
    const { turn, feedback } = await playWith('u-v', [save([], 'You swing.'), save([setMap(ids.$inn!, MAP)], 'You swing.')]);
    expect(feedback[0]).toMatch(new RegExp(`${INN} \\(${ids.$inn}\\) has no map, and Vargas, .+ are there`));
    expect(turn.status).toBe('delivered');
    expect(data(ids.$inn!).map.cols).toBe(10);
  });

  it('/rpg map posts the current map in the caller storyline channel', async () => {
    const r = await runner.mapNow(campaign, 'u-v');
    expect(r.channelId).toBe('main-chan');
    expect(delivery.sent.at(-1)!.message.file?.name).toBe('map.png');
  });

  it('the Reply text box is handled (modal id parsing)', async () => {
    const replies: string[] = [];
    const i = {
      customId: 'rpg:sayf:5:0', channelId: 'nowhere', guildId: 'g', deferred: false, replied: false,
      inGuild: () => true,
      reply: async (o: { content: string }) => void replies.push(o.content),
    };
    await handleModal({ db, config: loadConfig({ DATA_DIR: dir, LLM_PROVIDER: 'ollama' }), runner }, i as never);
    expect(replies).toEqual(['No campaign in this channel.']);
  });
});

describe('one 3D scene, three cameras', () => {
  const BASE = '#406040';
  let calls: { view?: string; px?: number; turntable?: string; spec: SceneSpec }[];
  let renderFail: Error | null;
  /** A runner whose fake Blender writes a flat-colored render of the requested size. */
  const runner3d = () =>
    new TurnRunner({
      db, config: loadConfig({ DATA_DIR: dir, LLM_PROVIDER: 'ollama' }), provider, delivery, modelLimiter: new Semaphore(2),
      diorama: {
        queue: new ImageQueue(4),
        scene: {
          async render(spec, out, opts) {
            calls.push({ view: opts?.view, px: opts?.px, turntable: opts?.turntable, spec });
            if (renderFail) throw renderFail;
            const [w, h] = opts?.view === 'map' ? [spec.cols * opts.px!, spec.rows * opts.px!] : [64, 48];
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${BASE}"/></svg>`).render().asPng());
            if (opts?.turntable) fs.writeFileSync(opts.turntable, 'mp4');
            return { path: out, video: opts?.turntable ?? null, seconds: 1 };
          },
        },
      },
    });
  /** Decodes a PNG file (through resvg) into a pixel lookup. */
  const decode = (file: string) => {
    const buf = fs.readFileSync(file);
    const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    const img = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image href="data:image/png;base64,${buf.toString('base64')}" width="${w}" height="${h}"/></svg>`).render();
    const at = (x: number, y: number) => {
      const i = (Math.round(y) * img.width + Math.round(x)) * 4;
      return `#${[...img.pixels.subarray(i, i + 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    };
    return { width: img.width, height: img.height, at };
  };
  beforeEach(() => {
    calls = [];
    renderFail = null;
  });

  it('🗺️ the map is a top-down render of the scene with the grid, rings and names drawn over it', async () => {
    const r = await runner3d().mapNow(campaign, 'u-v');
    expect(r.message).toBe('🗺️ Map posted.');
    expect(calls.map((c) => [c.view, c.px])).toEqual([['map', 96]]);
    expect(calls[0]!.spec.people.map((p) => p.name).sort()).toEqual(['Marrow Gale', 'Thaniesh', 'Vargas']);
    const file = delivery.sent.at(-1)!.message.file!.path!;
    expect(fs.existsSync(file.replace(/\.png$/, '-top.png'))).toBe(false); // the bare render is not kept
    const snap = mapSnapshot(db, campaign.id, getRecord(db, campaign.id, ids.$brawl!))!;
    const img = decode(file);
    // The grid is the render pixel for pixel (10x8 cells at 96 px), under the title strip and
    // beside the legend, both at 2x like the flat map.
    expect(composedMapGeometry(snap, 96)).toEqual({ width: 10 * 96 + 600, height: (52 + 8 * 48 + 12) * 2, gridTop: 104 });
    expect([img.width, img.height]).toEqual([10 * 96 + 600, (52 + 8 * 48 + 12) * 2]);
    const cell = (cx: number, cy: number) => img.at(cx * 96, 104 + cy * 96);
    expect(cell(8.5, 6.5)).toBe(BASE); // an empty cell shows the render
    // Thaniesh (2,3): the ring in his color, 0.4 cells from the center, with the figure inside.
    expect(cell(2.5 - 0.4, 3.5)).toBe(tokenColor(ids.$thaniesh!, 'character'));
    expect(cell(2.5, 3.5)).toBe(BASE);
    expect(cell(5.5 - 0.4, 4.5)).toBe('#8a8a8a'); // Marrow is down: a grey ring
    expect(cell(3.5 + 0.55, 3.5)).toBe('#ffcc33'); // the gold halo around Vargas, whose turn it is
    expect(cell(3.5 + 0.45, 3.5)).not.toBe('#ffcc33');
  });

  it('🗺️ falls back to the flat map when Blender fails', async () => {
    renderFail = new Error('Blender crashed');
    const r = await runner3d().mapNow(campaign, 'u-v');
    expect(r.message).toBe('🗺️ Map posted.');
    expect(calls).toHaveLength(1);
    const img = decode(delivery.sent.at(-1)!.message.file!.path!);
    expect(img.at(8.5 * 96, 104 + 6.5 * 96)).toBe('#e9e4d8'); // the flat map's floor
  });

  it('🗺️ map:true queues the 3D map after the reply and posts it under it once', async () => {
    const r3 = runner3d();
    provider.steps.push(() => ({ toolCalls: [save([setPos(ids.$vargas!, { x: 4, y: 3 })], 'You step closer.')] }));
    const r = r3.submit({ campaign, userId: 'u-v', mode: 'play', requestId: 'p3d', text: 'step closer', target: { channelId: 'main-chan', ephemeral: false }, map: true });
    await r3.idle();
    const t = getTurn(db, r.turnId!)!;
    expect(await r3.postMap(t.id, campaign.id)).toBe('🗺️ Map posted under the scene.'); // the same job, not a second render
    expect(calls.map((c) => c.view)).toEqual(['map']);
    expect(calls[0]!.spec.people.find((p) => p.name === 'Vargas')!.x).toBe(4.5); // the turn's snapshot
    const posted = delivery.sent.filter((m) => m.message.file?.name === `map-${t.id}.png`);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message.replyTo).toBe('m1');
    expect(JSON.parse(getTurn(db, t.id)!.delivery_json).media.map).toMatchObject({ status: 'done', mode: '3d' });
    expect(await r3.postMap(t.id, campaign.id)).toMatch(/already posted/);
  });

  it('🧊 adds a Diorama button next to Map, renders the diorama view once, and posts it under the reply', async () => {
    const dioRunner = runner3d();
    provider.steps.push(() => ({ toolCalls: [save([], 'You hold your ground.')] }));
    const r = dioRunner.submit({ campaign, userId: 'u-v', mode: 'play', requestId: 'dio1', text: 'hold', target: { channelId: 'main-chan', ephemeral: false }, diorama: true });
    await dioRunner.idle();
    await new Promise((res) => setTimeout(res, 20));
    const t = getTurn(db, r.turnId!)!;
    expect(delivery.sent[0]!.message.buttons?.map((b) => b.label)).toEqual(['🗺️ Map', '👀 Look around', '🧊 Diorama']);
    expect(calls.map((c) => [c.view, c.turntable, c.spec.people.length])).toEqual([['diorama', undefined, 3]]);
    const posted = delivery.sent.find((m) => m.message.file?.name === `diorama-${t.id}.png`)!;
    expect(posted.message.replyTo).toBe('m1');
    expect(dioRunner.diorama(t.id, campaign.id).message).toMatch(/already posted/);
    await dioRunner.diorama(t.id, campaign.id, { turntable: true }).done;
    expect(calls.at(-1)).toMatchObject({ view: 'diorama', turntable: expect.stringContaining(`diorama-turn-${t.id}.mp4`) });
    expect(delivery.sent.at(-1)!.message.file?.name).toBe(`diorama-${t.id}.mp4`);
  });

  it('🧊 /rpg diorama renders the current scene from the diorama camera', async () => {
    const r = runner3d().dioramaNow(campaign, 'u-v', undefined, { turntable: true });
    await r.done;
    expect(calls.map((c) => c.view)).toEqual(['diorama']);
    expect(calls[0]!.turntable).toMatch(/\.mp4$/);
    expect(calls[0]!.spec.people.find((p) => p.name === 'Vargas')!.focus).toBe(true); // the caller
    expect(delivery.sent.at(-1)!.message.file?.name).toBe('diorama.mp4');
  });

  it('is off without the renderer', () => {
    expect(runner.diorama(1).message).toMatch(/turned off/);
  });
});

describe('joining a fight mid-round', () => {
  it('a joiner appended with waiting: true is drawn faded until their turn; joiners need a position', async () => {
    const duking = seed([op({ op: 'create', ref: '$d', kind: 'character', name: 'Duking', parent_id: ids.$inn, data_json: '{}' })]).$d!;
    db.prepare(`INSERT INTO members (campaign_id, discord_user_id, character_record_id, role, created_at) VALUES (?, 'u-d', ?, 'player', '')`).run(campaign.id, duking);
    const brawl = () => JSON.parse(getRecord(db, campaign.id, ids.$brawl!)!.data_json);
    // Duking walks in and watches without a position on the inn's map: the save is sent back.
    let feedback = '';
    const join = (withPosition: boolean) =>
      save([
        op({ op: 'set', record_id: ids.$brawl, path: 'data.participants_ids', value_json: JSON.stringify([...brawl().participants_ids, duking]), expected_version: version(ids.$brawl!) }),
        op({ op: 'set', record_id: ids.$brawl, path: 'data.initiative', value_json: JSON.stringify([...brawl().initiative, { id: duking, value: null, waiting: true }]), expected_version: version(ids.$brawl!) }),
        ...(withPosition ? [setPos(duking, { x: 4, y: 5 })] : []),
      ], 'Duking wades in; he swings at the end of the round.');
    provider.steps.push(() => ({ toolCalls: [join(false)] }));
    provider.steps.push((req) => {
      feedback = lastOutput(req);
      return { toolCalls: [join(true)] };
    });
    const r = runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'join', text: 'I join the fight', target: { channelId: 'main-chan', ephemeral: false } });
    await runner.idle();
    expect(feedback).toContain(`Duking (${duking}) needs a position on the map of ${INN}`);
    expect(getTurn(db, r.turnId!)!.status).toBe('delivered');
    const snap = mapSnapshot(db, campaign.id, getRecord(db, campaign.id, ids.$brawl!))!;
    const tok = snap.tokens.find((t) => t.name === 'Duking')!;
    expect(tok.waiting).toBe(true);
    expect(brawl().initiative.at(-1)).toEqual({ id: duking, value: null, waiting: true });
    const svg = renderMapSvg(snap);
    expect(svg).toContain('stroke-dasharray="6 5"');
    expect(svg).toContain('joined mid-round, acts at the end');
    // The 3D map marks him the same way: a dashed, faded ring and name, and the footnote.
    const overlay = renderMapOverlaySvg(snap, 'top.png');
    expect(overlay).toContain('<image href="top.png"');
    expect(overlay).toMatch(/<g opacity="0\.55">(?:(?!<\/g>).)*stroke-dasharray="6 5"/s);
    expect(overlay).toMatch(/<g opacity="0\.6"><rect[^\n]*\n<text[^\n]*>Duking<\/text><\/g>/);
    expect(overlay).toContain('joined mid-round, acts at the end');
  });
});

describe('reach and side storylines', () => {
  const roll = (args: Record<string, unknown>): Omit<ToolCall, 'id'> => ({
    name: 'roll_dice',
    arguments: JSON.stringify({ check_id: 'hit', purpose: 'Vargas attacks Marrow with his longblade', expression: '1d20+5', modifier: null, target: 10, comparison: '>=', related_ids: [], visibility: 'public', attacker_id: null, target_id: null, reach_ft: null, ...args }),
  });
  const saveWith = (ops: object[]) => ({ name: 'save_turn', arguments: JSON.stringify({ expected_revision: 0, operations: ops, public_reply: 'Done.', gm_note: '', source_refs: [], roll_ids: ['hit'] }) });
  const turnPass = () => {
    // Vargas's turn ends; hand to Marrow is an NPC, so hand back to Thaniesh in the next round.
    const v = version(ids.$brawl!);
    return [op({ op: 'set', record_id: ids.$brawl, path: 'data.round', value_json: '3', expected_version: v }), op({ op: 'set', record_id: ids.$brawl, path: 'data.turn_of_id', value_json: JSON.stringify(ids.$thaniesh), expected_version: v })];
  };

  it('an attack needs attacker, target and reach on a mapped place, and must reach after movement', async () => {
    const outputs: string[] = [];
    provider.steps.push(() => ({ toolCalls: [roll({})] })); // no attack info
    provider.steps.push((req) => {
      outputs.push(JSON.stringify(req.items.at(-1)));
      return { toolCalls: [roll({ attacker_id: ids.$vargas, target_id: ids.$marrow, reach_ft: 5 })] };
    });
    provider.steps.push(() => ({ toolCalls: [saveWith(turnPass())] })); // Vargas at 3,3; Marrow at 5,4: 10 ft away
    provider.steps.push((req) => {
      outputs.push(JSON.stringify(req.items.at(-1)));
      return { toolCalls: [saveWith([setPos(ids.$vargas!, { x: 4, y: 4 }), ...turnPass()])] }; // step in first
    });
    const r = runner.submit({ campaign, userId: 'u-v', mode: 'play', requestId: 'reach', text: 'I attack Marrow', target: { channelId: 'main-chan', ephemeral: false } });
    await runner.idle();
    expect(outputs[0]).toMatch(/declare attacker_id, target_id and reach_ft/);
    expect(outputs[1]).toMatch(/Vargas is 10 ft from Marrow Gale on the map, but the attack .{1,6}hit.{1,6} reaches 5 ft/);
    expect(getTurn(db, r.turnId!)!.status).toBe('delivered');
  });


});
