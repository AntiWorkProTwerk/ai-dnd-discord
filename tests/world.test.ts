// Who decides what exists: places players have seen stay as they saw them (changes need a reason in
// the world, open features may be claimed), the area outline in the GM context, 👀 Look around
// (player-safe, no model call), and background preparation of the places around the party.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Semaphore } from '../src/agent.js';
import { createCampaign } from '../src/campaign.js';
import { loadConfig } from '../src/config.js';
import { getCampaign, getRecord, getTurn, openDatabase, type Db } from '../src/database.js';
import { lookAround } from '../src/look.js';
import { asciiMap, seenMapChanges, type SceneMap } from '../src/maps.js';
import { prepJobFor } from '../src/prep.js';
import type { ModelProvider, ProviderRequest, ProviderResponse, ToolCall } from '../src/providers.js';
import { planBatch, writeBatch } from '../src/records.js';
import { isSeenPlace } from '../src/tools.js';
import { TurnRunner, type DeliveryPort, type DeliveryTarget, type OutboundMessage } from '../src/turns.js';
import type { CampaignRow } from '../src/types.js';

const op = (o: Record<string, unknown>) => ({
  ref: null, record_id: null, kind: null, name: null, parent_id: null, visibility: null, path: null,
  value_json: null, data_json: null, gm_notes_json: null, expected_json: null, expected_version: null, delta: null, ...o,
});
const save = (operations: object[], extra: Record<string, unknown> = {}): Omit<ToolCall, 'id'> => ({
  name: 'save_turn',
  arguments: JSON.stringify({ expected_revision: 0, operations, public_reply: 'Done.', gm_note: '', source_refs: [], roll_ids: [], world_change: null, ...extra }),
});

class ScriptProvider implements ModelProvider {
  name = 'fake'; model = 'fake'; paid = false; inputUsdPerMillion = 0; outputUsdPerMillion = 0;
  steps: ((req: ProviderRequest) => { toolCalls: Omit<ToolCall, 'id'>[] })[] = [];
  requests: ProviderRequest[] = [];
  private n = 0;
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
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
const version = (id: string) => getRecord(db, campaign.id, id)!.version;
const data = (id: string) => JSON.parse(getRecord(db, campaign.id, id)!.data_json) as Record<string, any>;
const setMap = (id: string, map: unknown) => op({ op: 'set', record_id: id, path: 'data.map', value_json: JSON.stringify(map), expected_version: version(id) });
const lastOutput = (req: ProviderRequest) => { const it = req.items.at(-1) as { output?: string } | undefined; if (!it?.output) return JSON.stringify(it); try { const o = JSON.parse(it.output) as { error?: string }; return o.error ?? it.output; } catch { return it.output; } };

const STREET = {
  cols: 16, rows: 10, cell_ft: 5,
  features: [
    { kind: 'wall', label: 'tannery wall', x: 0, y: 0, w: 6, h: 1 },
    { kind: 'door', label: 'tannery door', x: 3, y: 1, w: 1, h: 1 },
    { kind: 'door', label: 'shuttered shopfront', x: 9, y: 1, w: 1, h: 1, open: true },
    { kind: 'object', label: 'water trough', x: 7, y: 5, w: 2, h: 1 },
  ],
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-world-'));
  db = openDatabase(path.join(dir, 'rpg.sqlite'));
  campaign = createCampaign(db, { guildId: 'g', channelId: 'main-chan', ownerUserId: 'owner', title: 'T', premise: '', rules_edition: '', tone: '', max_players: 4, boundaries: '', require_character_approval: false });
  db.prepare(`UPDATE campaigns SET status = 'active' WHERE id = ?`).run(campaign.id);
  ids = seed([
    op({ op: 'create', ref: '$town', kind: 'location', name: 'Wickmere', data_json: JSON.stringify({ description: 'A fishing town on the marsh.' }) }),
    op({ op: 'create', ref: '$street', kind: 'location', name: 'Dock Street', parent_id: '$town', data_json: JSON.stringify({ description: 'A muddy street along the docks.', map: STREET }) }),
    op({ op: 'create', ref: '$thaniesh', kind: 'character', name: 'Thaniesh', parent_id: '$street', data_json: JSON.stringify({ hp: { current: 10, max: 10 }, pos: { x: 3, y: 4 } }) }),
    op({ op: 'create', ref: '$odile', kind: 'npc', name: 'Odile', parent_id: '$street', data_json: JSON.stringify({ hp: { current: 0, max: 8 }, pos: { x: 6, y: 4 } }) }),
    op({ op: 'create', ref: '$spy', kind: 'npc', name: 'Hidden Spy', parent_id: '$street', visibility: 'gm', data_json: '{}', gm_notes_json: JSON.stringify({ pos: { x: 15, y: 9 } }) }),
    op({ op: 'create', ref: '$lurker', kind: 'npc', name: 'Lurker', parent_id: '$street', data_json: JSON.stringify({ conditions: ['hidden'], pos: { x: 12, y: 8 } }) }),
  ]);
  db.prepare(`UPDATE members SET character_record_id = ? WHERE campaign_id = ? AND discord_user_id = 'owner'`).run(ids.$thaniesh, campaign.id);
  campaign = getCampaign(db, campaign.id)!;
  provider = new ScriptProvider();
  delivery = new FakeDelivery();
  runner = new TurnRunner({ db, config: loadConfig({ DATA_DIR: dir, LLM_PROVIDER: 'ollama' }), provider, delivery, modelLimiter: new Semaphore(2) });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A play turn whose GM tries each save in turn; returns the turn and the feedback each retry got. */
async function playWith(saves: Omit<ToolCall, 'id'>[], text = 'I look for a fur trader') {
  const feedback: string[] = [];
  saves.forEach((s, i) =>
    provider.steps.push((req) => {
      if (i > 0) feedback.push(lastOutput(req));
      return { toolCalls: [s] };
    }),
  );
  const r = runner.submit({ campaign, userId: 'owner', mode: 'play', requestId: `p${Math.random()}`, text, target: { channelId: 'main-chan', ephemeral: false } });
  await runner.idle();
  return { turn: getTurn(db, r.turnId!)!, feedback };
}

describe('what players saw stays as they saw it', () => {
  const base = STREET as SceneMap;
  const withFeatures = (features: SceneMap['features'], over: Partial<SceneMap> = {}): SceneMap => ({ ...base, ...over, features });

  it('lists removed, moved and relabeled features and a smaller grid', () => {
    const [wall, door, shop, trough] = base.features;
    expect(seenMapChanges(base, withFeatures([wall!, door!, shop!]))).toEqual(['object "water trough" at 7,5']);
    expect(seenMapChanges(base, withFeatures([wall!, { ...door!, x: 4 }, shop!, trough!]))).toEqual(['door "tannery door" at 3,1']);
    expect(seenMapChanges(base, withFeatures([wall!, { ...door!, label: 'bakery door' }, shop!, trough!]))).toEqual(['door "tannery door" at 3,1']);
    expect(seenMapChanges(base, withFeatures(base.features, { cols: 12 }))[0]).toContain('shrank');
    expect(seenMapChanges(base, null)).toEqual(['the whole map was removed']);
  });

  it('allows additions, linking an exit, a bigger grid and claiming an open feature', () => {
    const [wall, door, shop, trough] = base.features;
    const grown = withFeatures(
      [wall!, { ...door!, to: 'location_abcdefgh' }, { kind: 'door', label: "Brannoc's furs", x: 9, y: 1, w: 1, h: 1 }, trough!, { kind: 'cover', label: 'cart', x: 12, y: 6, w: 2, h: 1 }],
      { cols: 20 },
    );
    expect(seenMapChanges(base, grown)).toEqual([]);
    // Once a door leads somewhere, sending it somewhere else is a change.
    const linked = withFeatures([wall!, { ...door!, to: 'location_abcdefgh' }, shop!, trough!]);
    expect(seenMapChanges(linked, withFeatures([wall!, { ...door!, to: 'location_zzzzzzzz' }, shop!, trough!]))).toHaveLength(1);
  });

  it('marks the place seen when a play turn commits there, then needs a reason to change it', async () => {
    expect(isSeenPlace(db, campaign.id, ids.$street!)).toBe(false);
    await playWith([save([])]);
    expect(isSeenPlace(db, campaign.id, ids.$street!)).toBe(true);

    const noTrough = { ...STREET, features: STREET.features.filter((f) => f.label !== 'water trough') };
    const { turn, feedback } = await playWith([save([setMap(ids.$street!, noTrough)]), save([setMap(ids.$street!, noTrough)], { world_change: 'the cart smashed the trough to pieces' })]);
    expect(feedback[0]).toContain('Players have already seen Dock Street');
    expect(feedback[0]).toContain('water trough');
    expect(turn.status === 'committed' || turn.status === 'delivered').toBe(true);
    expect(data(ids.$street!).map.features).toHaveLength(3);
  });

  it('lets the GM claim an open feature, add things, and reshape places nobody has seen', async () => {
    await playWith([save([])]);
    const claimed = { ...STREET, features: STREET.features.map((f) => (f.open ? { kind: 'door', label: "Brannoc's furs", x: 9, y: 1, w: 1, h: 1 } : f)).concat([{ kind: 'cover', label: 'fur rack', x: 10, y: 2, w: 1, h: 1 }]) };
    const cellar = seed([op({ op: 'create', ref: '$c', kind: 'location', name: 'Tannery Cellar', parent_id: ids.$town, data_json: JSON.stringify({ map: { cols: 8, rows: 6, cell_ft: 5, features: [{ kind: 'object', label: 'vat', x: 2, y: 2, w: 2, h: 2 }] } }) })]).$c!;
    const { turn, feedback } = await playWith([save([setMap(ids.$street!, claimed), setMap(cellar, { cols: 6, rows: 6, cell_ft: 5, features: [] })])]);
    expect(feedback).toEqual([]);
    expect(turn.status === 'committed' || turn.status === 'delivered').toBe(true);
    expect(data(ids.$street!).map.features.map((f: { label?: string }) => f.label)).toContain("Brannoc's furs");
  });
});

describe('facing', () => {
  it('is saved on the position, shown to the GM, and must be a compass point', () => {
    const set = (facing: unknown) => seed([op({ op: 'set', record_id: ids.$thaniesh, path: 'data.pos', value_json: JSON.stringify({ x: 3, y: 4, facing }), expected_version: version(ids.$thaniesh!) })]);
    set('n');
    expect(data(ids.$thaniesh!).pos.facing).toBe('n');
    expect(asciiMap(db, campaign.id, ids.$street!, ids.$thaniesh!)).toContain('at 3,4 facing n');
    expect(() => set('backwards')).toThrow(/pos\.facing must be one of n, ne, e, se, s, sw, w, nw/);
  });
});

describe('turning', () => {
  const face = (facing: string) => op({ op: 'set', record_id: ids.$thaniesh, path: 'data.pos.facing', value_json: JSON.stringify(facing), expected_version: version(ids.$thaniesh!) });

  it('a turn that does not save which way they now face is sent back with what to set', async () => {
    const { turn, feedback } = await playWith([save([]), save([face('n')])], 'turn around');
    expect(feedback[0]).toContain('set data.pos.facing on Thaniesh');
    expect(feedback[0]).toContain('not saved');
    expect(['committed', 'delivered']).toContain(turn.status);
    expect(data(ids.$thaniesh!).pos).toEqual({ x: 3, y: 4, facing: 'n' });
  });

  it('turning around must end up facing the other way from how they were shown', async () => {
    // Not saved yet: pictures show Thaniesh facing Odile, to the east.
    const { feedback } = await playWith([save([face('e')]), save([face('w')])], 'turn around');
    expect(feedback[0]).toContain('turning around faces w (west)');
    expect(data(ids.$thaniesh!).pos.facing).toBe('w');
  });

  it('looking where they already face is fine when the facing is written again; other actions need nothing', async () => {
    await playWith([save([face('n')])], 'I turn to face the water');
    const again = await playWith([save([face('n')])], 'I look out over the water');
    expect(again.feedback).toEqual([]);
    const other = await playWith([save([])], 'I wait for the ferry');
    expect(other.feedback).toEqual([]);
  });
});

describe('the area outline in the GM context', () => {
  it('shows what is settled about the town around the place, or asks for an outline', async () => {
    let context = '';
    provider.steps.push((req) => {
      context = JSON.stringify(req.items);
      return { toolCalls: [save([])] };
    });
    runner.submit({ campaign, userId: 'owner', mode: 'play', requestId: 'p1', text: 'Is there a fur trader?', target: { channelId: 'main-chan', ephemeral: false } });
    await runner.idle();
    expect(context).toContain('## Area outline');
    expect(context).toContain('Wickmere');
    expect(context).toContain('no outline yet');

    seed([op({ op: 'set', record_id: ids.$town, path: 'data.notable', value_json: JSON.stringify(['Tallow and Tide inn', 'tanner (buys pelts)', 'no smith']), expected_version: version(ids.$town!) })]);
    provider.steps.push((req) => {
      context = JSON.stringify(req.items);
      return { toolCalls: [save([])] };
    });
    runner.submit({ campaign, userId: 'owner', mode: 'play', requestId: 'p2', text: 'Is there a smith?', target: { channelId: 'main-chan', ephemeral: false } });
    await runner.idle();
    expect(context).toContain('tanner (buys pelts); no smith');
  });
});

describe('👀 Look around', () => {
  it('lists ways out, things and people in view with distances, and nothing secret', () => {
    seed([op({ op: 'set', record_id: ids.$town, path: 'data.notable', value_json: JSON.stringify(['ferry dock', 'no smith']), expected_version: version(ids.$town!) })]);
    const text = lookAround(db, campaign, 'owner');
    expect(text).toContain('Thaniesh looks around: Dock Street');
    expect(text).toContain('(Wickmere)');
    expect(text).toContain('tannery door (north, 3 squares / 15 ft)');
    expect(text).toContain('water trough (east, 4 squares / 20 ft)');
    expect(text).toContain('Odile (down)');
    expect(text).toContain('Known about Wickmere');
    expect(text).toContain('ferry dock; no smith');
    expect(text).not.toContain('Hidden Spy');
    expect(text).not.toContain('Lurker');
  });

  it('names where a way leads only once the party has been there', async () => {
    const yard = seed([op({ op: 'create', ref: '$y', kind: 'location', name: 'Tannery Yard', parent_id: ids.$town, data_json: JSON.stringify({ map: { cols: 8, rows: 6, cell_ft: 5, features: [] } }) })]).$y!;
    seed([setMap(ids.$street!, { ...STREET, features: STREET.features.map((f) => (f.label === 'tannery door' ? { ...f, to: yard } : f)) })]);
    expect(lookAround(db, campaign, 'owner')).toContain('tannery door (north, 3 squares / 15 ft) → not explored yet');
    db.prepare(`INSERT INTO seen_places (campaign_id, place_id, first_turn_id, seen_at) VALUES (?, ?, NULL, '')`).run(campaign.id, yard);
    expect(lookAround(db, campaign, 'owner')).toContain('→ Tannery Yard');
  });
});

describe('background preparation', () => {
  it('picks the area outline, unmapped destinations and exits that lead nowhere, skipping open ones and the town itself', () => {
    const yard = seed([op({ op: 'create', ref: '$y', kind: 'location', name: 'Tannery Yard', parent_id: ids.$town, data_json: '{}' })]).$y!;
    const features = [
      ...STREET.features.map((f) => (f.label === 'tannery door' ? { ...f, to: yard } : f)),
      { kind: 'door', x: 12, y: 0, w: 1, h: 1 },
      { kind: 'exit', label: 'road to the marsh', x: 15, y: 4, w: 1, h: 2 },
      { kind: 'exit', label: 'into town', x: 0, y: 4, w: 1, h: 2, to: ids.$town },
      { kind: 'exit', label: 'side alley', x: 8, y: 9, w: 1, h: 1, open: true },
    ];
    seed([setMap(ids.$street!, { ...STREET, features })]);
    const job = prepJobFor(db, campaign.id, ids.$thaniesh!)!;
    expect(job.place_id).toBe(ids.$street);
    expect(job.tasks.map((t) => t.key)).toEqual([`outline:${ids.$town}`, `map:${yard}`, `beyond:${ids.$street}:15,4`]);
    expect(job.tasks[2]!.text).toContain('"road to the marsh"');

    seed([op({ op: 'set', record_id: ids.$town, path: 'data.notable', value_json: '["ferry dock"]', expected_version: version(ids.$town!) })]);
    expect(prepJobFor(db, campaign.id, ids.$thaniesh!)!.tasks.map((t) => t.key)).toEqual([`map:${yard}`, `beyond:${ids.$street}:15,4`]);
  });

  it('runs after a play turn in the background: posts nothing, stays in scope, and is not repeated', async () => {
    // Only the outline is missing (the named door would also be prepared: see the test above).
    seed([setMap(ids.$street!, { ...STREET, features: STREET.features.filter((f) => f.label !== 'tannery door') })]);
    runner = new TurnRunner({ db, config: loadConfig({ DATA_DIR: dir, LLM_PROVIDER: 'ollama' }), provider, delivery, modelLimiter: new Semaphore(2), worldPrep: true });
    provider.steps.push(() => ({ toolCalls: [save([])] }));
    let prepContext = '';
    const outline = op({ op: 'set', record_id: ids.$town, path: 'data.notable', value_json: '["ferry dock", "tanner (buys pelts)", "no smith"]', expected_version: version(ids.$town!) });
    // First the prep GM oversteps (moves the player character), then does only its task.
    provider.steps.push((req) => {
      prepContext = JSON.stringify(req.items);
      return { toolCalls: [save([outline, op({ op: 'set', record_id: ids.$thaniesh, path: 'data.pos', value_json: '{"x":4,"y":4}', expected_version: version(ids.$thaniesh!) })])] };
    });
    let feedback = '';
    provider.steps.push((req) => {
      feedback = lastOutput(req);
      return { toolCalls: [save([outline], { public_reply: 'Outlined Wickmere.' })] };
    });
    runner.submit({ campaign, userId: 'owner', mode: 'play', requestId: 'p1', text: 'I wait', target: { channelId: 'main-chan', ephemeral: false } });
    await runner.idle();

    const prep = db.prepare(`SELECT * FROM turns WHERE mode = 'prep'`).all() as { status: string; public_reply: string }[];
    expect(prep).toHaveLength(1);
    expect(prep[0]!.status).toBe('delivered');
    expect(prepContext).toContain('## Preparation tasks');
    expect(prepContext).toContain('Outline Wickmere');
    expect(feedback).toContain('Preparation cannot change character records');
    expect(data(ids.$town!).notable).toEqual(['ferry dock', 'tanner (buys pelts)', 'no smith']);
    expect(data(ids.$thaniesh!).pos).toEqual({ x: 3, y: 4 });
    expect(delivery.sent.every((s) => !s.message.content.includes('Outlined'))).toBe(true);

    // Nothing left to prepare: the next play turn queues no prep run.
    provider.steps.push(() => ({ toolCalls: [save([])] }));
    runner.submit({ campaign, userId: 'owner', mode: 'play', requestId: 'p2', text: 'I wait more', target: { channelId: 'main-chan', ephemeral: false } });
    await runner.idle();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE mode = 'prep'`).get() as { n: number }).n).toBe(1);
  });

  it('never changes what players have seen', async () => {
    runner = new TurnRunner({ db, config: loadConfig({ DATA_DIR: dir, LLM_PROVIDER: 'ollama' }), provider, delivery, modelLimiter: new Semaphore(2), worldPrep: true });
    provider.steps.push(() => ({ toolCalls: [save([])] }));
    const noTrough = { ...STREET, features: STREET.features.filter((f) => f.label !== 'water trough') };
    let feedback = '';
    provider.steps.push(() => ({ toolCalls: [save([setMap(ids.$street!, noTrough)], { world_change: 'tidied up' })] }));
    provider.steps.push((req) => {
      feedback = lastOutput(req);
      return { toolCalls: [save([op({ op: 'set', record_id: ids.$town, path: 'data.notable', value_json: '["ferry dock"]', expected_version: version(ids.$town!) })])] };
    });
    runner.submit({ campaign, userId: 'owner', mode: 'play', requestId: 'p1', text: 'I wait', target: { channelId: 'main-chan', ephemeral: false } });
    await runner.idle();
    expect(feedback).toContain('Preparation may only add to a place players have seen');
    expect(data(ids.$street!).map.features).toHaveLength(4);
  });
});
