// Parallel storylines: routing, per-storyline context, concurrent resolution, the one-storyline
// invariant, the shared world clock and the Discord thread lifecycle. Fake model and delivery.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContext, Semaphore } from '../src/agent.js';
import { createCampaign } from '../src/campaign.js';
import { loadConfig } from '../src/config.js';
import { campaignFor } from '../src/discord.js';
import { getCampaign, getRecord, getTurn, insertTurn, openDatabase, type Db } from '../src/database.js';
import type { ModelProvider, ProviderRequest, ProviderResponse, ToolCall } from '../src/providers.js';
import { planBatch, writeBatch } from '../src/records.js';
import { storylineOf, threadFor, worldClock } from '../src/storylines.js';
import { TurnRunner, type DeliveryPort, type DeliveryTarget, type OutboundMessage } from '../src/turns.js';
import type { CampaignRow, ToolContext } from '../src/types.js';

const op = (o: Record<string, unknown>) => ({
  ref: null, record_id: null, kind: null, name: null, parent_id: null, visibility: null, path: null,
  value_json: null, data_json: null, gm_notes_json: null, expected_json: null, expected_version: null, delta: null, ...o,
});
const call = (name: string, args: object): Omit<ToolCall, 'id'> => ({ name, arguments: JSON.stringify(args) });
const save = (operations: object[], reply = 'Done.') =>
  call('save_turn', { expected_revision: 0, operations, public_reply: reply, gm_note: '', source_refs: [], roll_ids: [] });

/** A small grid map for a place; exits lead to other locations by id (or $ref in the same batch). */
const map = (cols: number, rows: number, exits: { x: number; y: number; to: string; label?: string }[] = []) => ({
  cols, rows, cell_ft: 5, features: exits.map((e) => ({ kind: 'exit', x: e.x, y: e.y, w: 1, h: 1, to: e.to, ...(e.label ? { label: e.label } : {}) })),
});
/** Walks a creature into another place: parent_id and its position on that place's map. */
const moveTo = (id: string, placeId: string, x: number, y: number) => [
  op({ op: 'move', record_id: id, parent_id: placeId }),
  op({ op: 'set', record_id: id, path: 'data.pos', value_json: JSON.stringify({ x, y }), expected_version: version(id) }),
];

type Step = (req: ProviderRequest) => Promise<{ toolCalls?: Omit<ToolCall, 'id'>[]; text?: string }> | { toolCalls?: Omit<ToolCall, 'id'>[]; text?: string };

/** Scripted model whose steps are picked by the acting character found in the context. */
class RoutedProvider implements ModelProvider {
  name = 'fake'; model = 'fake'; paid = false; inputUsdPerMillion = 0; outputUsdPerMillion = 0;
  scripts = new Map<string, Step[]>();
  inFlight = 0;
  maxInFlight = 0;
  private n = 0;
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const ctx = (req.items[0] as { text: string }).text;
    const key = [...this.scripts.keys()].find((k) => ctx.includes(`"name":"${k}"`) && ctx.indexOf(`"name":"${k}"`) < ctx.indexOf('## Location'));
    const step = key ? this.scripts.get(key)!.shift() : undefined;
    if (!step) throw new Error(`no step for ${key}`);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const out = await step(req);
      return { assistant: { type: 'assistant', text: out.text ?? null, toolCalls: (out.toolCalls ?? []).map((c) => ({ ...c, id: `c${++this.n}` })) }, usage: { inputTokens: 1, outputTokens: 1 }, status: 'completed' };
    } finally {
      this.inFlight--;
    }
  }
  async check() { return 'ok'; }
}

class ThreadDelivery implements DeliveryPort {
  sent: { channelId: string; content: string; ephemeral?: boolean; buttons?: string[] }[] = [];
  threads: { id: string; name: string; private: boolean; members: string[] }[] = [];
  archived: string[] = [];
  added: { thread: string; user: string }[] = [];
  async send(t: DeliveryTarget, m: OutboundMessage) {
    this.sent.push({ channelId: t.channelId, content: m.content, ephemeral: t.ephemeral, buttons: m.buttons?.map((b) => b.customId) });
    return `m${this.sent.length}`;
  }
  async addThreadMember(thread: string, user: string) {
    this.added.push({ thread, user });
  }
  async createThread(_parent: string, name: string, isPrivate: boolean, members: string[]) {
    const id = `thread${this.threads.length + 1}`;
    this.threads.push({ id, name, private: isPrivate, members });
    return id;
  }
  async archiveThread(id: string) {
    this.archived.push(id);
  }
}

let dir: string;
let db: Db;
let campaign: CampaignRow;
let ids: Record<string, string>;
let provider: RoutedProvider;
let delivery: ThreadDelivery;
let runner: TurnRunner;

function seed(ops: object[]) {
  return db.transaction(() => {
    const plan = planBatch(db, ops as never, { campaignId: campaign.id, actorUserId: 'owner', constraints: [] });
    writeBatch(db, campaign.id, plan);
    return plan.created;
  })();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-story-'));
  db = openDatabase(path.join(dir, 'rpg.sqlite'));
  campaign = createCampaign(db, { guildId: 'g', channelId: 'main-chan', ownerUserId: 'owner', title: 'T', premise: '', rules_edition: '', tone: '', max_players: 4, boundaries: '', require_character_approval: false });
  db.prepare(`UPDATE campaigns SET status = 'active' WHERE id = ?`).run(campaign.id);
  ids = seed([
    op({ op: 'create', ref: '$town', kind: 'location', name: 'Millbrook', data_json: '{}' }),
    op({ op: 'create', ref: '$inn', kind: 'location', name: 'Inn', parent_id: '$town', data_json: JSON.stringify({ map: map(8, 6, [{ x: 7, y: 3, to: '$road', label: 'door' }]) }) }),
    op({ op: 'create', ref: '$road', kind: 'location', name: 'Road', parent_id: '$town', data_json: JSON.stringify({ map: map(12, 3, [{ x: 0, y: 1, to: '$inn', label: 'inn' }]) }) }),
    op({ op: 'create', ref: '$thaniesh', kind: 'character', name: 'Thaniesh', parent_id: '$inn', data_json: '{"hp":{"current":10,"max":10},"pos":{"x":1,"y":1}}' }),
    op({ op: 'create', ref: '$duking', kind: 'character', name: 'Duking', parent_id: '$inn', data_json: '{"hp":{"current":12,"max":12},"pos":{"x":6,"y":4}}' }),
    op({ op: 'create', ref: '$marrow', kind: 'npc', name: 'Marrow', parent_id: '$inn', data_json: '{"hp":{"current":9,"max":9},"pos":{"x":2,"y":1}}' }),
  ]);
  db.prepare(`INSERT INTO members (campaign_id, discord_user_id, character_record_id, role, created_at) VALUES (?, 'u-t', ?, 'player', ''), (?, 'u-d', ?, 'player', '')`).run(campaign.id, ids.$thaniesh, campaign.id, ids.$duking);
  Object.assign(
    ids,
    seed([
      op({ op: 'create', ref: '$brawl', kind: 'scene', name: 'Brawl at the Inn', parent_id: ids.$inn, data_json: JSON.stringify({ status: 'active', main: true, participants_ids: [ids.$thaniesh, ids.$duking, ids.$marrow], time_min: 1080, round: 1 }) }),
    ]),
  );
  campaign = getCampaign(db, campaign.id)!;
  provider = new RoutedProvider();
  delivery = new ThreadDelivery();
  runner = new TurnRunner({ db, config: loadConfig({ DATA_DIR: dir, LLM_PROVIDER: 'ollama' }), provider, delivery, modelLimiter: new Semaphore(4) });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const target = (channelId = 'main-chan'): DeliveryTarget => ({ channelId, ephemeral: false, interaction: { application_id: 'a', token: 't', created_at: new Date().toISOString() } });
const version = (id: string) => getRecord(db, campaign.id, id)!.version;

/** Duking leaves the brawl for the road: a new side storyline. */
function splitOps() {
  return [
    op({ op: 'create', ref: '$ride', kind: 'scene', name: "Duking's ride", parent_id: ids.$road, data_json: JSON.stringify({ status: 'active', participants_ids: [ids.$duking], time_min: 1085 }) }),
    op({ op: 'set', record_id: ids.$brawl, path: 'data.participants_ids', value_json: JSON.stringify([ids.$thaniesh, ids.$marrow]), expected_version: version(ids.$brawl!) }),
    ...moveTo(ids.$duking!, ids.$road!, 1, 1),
  ];
}

async function split() {
  provider.scripts.set('Duking', [() => ({ toolCalls: [save(splitOps(), 'You ride out alone.')] })]);
  const r = runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'split', text: 'I leave to find a horse', target: target(), sideStory: true });
  await runner.idle();
  return getTurn(db, r.turnId!)!;
}

describe('storyline routing', () => {
  it('everyone starts in the main storyline; a split creates a persistent thread and routes there', async () => {
    expect(storylineOf(db, campaign.id, ids.$duking!)!.id).toBe(ids.$brawl);
    const t = await split();
    expect(t.status).toBe('delivered');
    const ride = storylineOf(db, campaign.id, ids.$duking!)!;
    expect(ride.name).toBe("Duking's ride");
    expect(storylineOf(db, campaign.id, ids.$thaniesh!)!.id).toBe(ids.$brawl);
    expect(delivery.threads).toEqual([{ id: 'thread1', name: "Duking's ride", private: false, members: ['u-d', 'owner'] }]);
    expect(delivery.sent.some((m) => m.channelId === 'thread1' && /side story continues here/.test(m.content))).toBe(true);
    expect(delivery.sent.some((m) => m.channelId === 'main-chan' && m.content.includes('<#thread1>'))).toBe(true);

    // Duking acts again from #dnd: a pointer in #dnd, the narration in his thread.
    provider.scripts.set('Duking', [() => ({ toolCalls: [save([], 'A wild stallion watches you.')] })]);
    delivery.sent = [];
    const r = runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'next', text: 'I look for horses', target: target('main-chan') });
    await runner.idle();
    expect(getTurn(db, r.turnId!)!.scene_id).toBe(ride.id);
    expect(delivery.sent[0]).toMatchObject({ channelId: 'main-chan', content: '↪ Continued in <#thread1>' });
    expect(delivery.sent.find((m) => m.content.includes('wild stallion'))!.channelId).toBe('thread1');
    expect(delivery.sent.find((m) => m.content.includes('wild stallion'))!.content).toContain("📍 Duking's ride");
    expect(campaignFor(db, 'g', 'thread1')!.id).toBe(campaign.id);
  });

  it('a split out the door into a new place created in the same save (map, exit back, pos) is accepted and routed', async () => {
    provider.scripts.set('Duking', [
      () => ({
        toolCalls: [
          save([
            op({ op: 'create', ref: '$yard', kind: 'location', name: 'Stable yard', parent_id: ids.$town, data_json: JSON.stringify({ description: 'Mud, hay and three horses.', map: map(6, 5, [{ x: 0, y: 2, to: ids.$inn!, label: 'inn door' }]) }) }),
            op({ op: 'create', ref: '$ride', kind: 'scene', name: "Duking's ride", parent_id: '$yard', data_json: JSON.stringify({ status: 'active', participants_ids: [ids.$duking], time_min: 1085 }) }),
            op({ op: 'set', record_id: ids.$brawl, path: 'data.participants_ids', value_json: JSON.stringify([ids.$thaniesh, ids.$marrow]), expected_version: version(ids.$brawl!) }),
            ...moveTo(ids.$duking!, '$yard', 1, 2),
          ], 'You step out into the stable yard.'),
        ],
      }),
    ]);
    const r = runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'yard', text: 'I walk out to the stables', target: target(), sideStory: true });
    await runner.idle();
    expect(getTurn(db, r.turnId!)!.status).toBe('delivered');
    const ride = storylineOf(db, campaign.id, ids.$duking!)!;
    expect(ride.name).toBe("Duking's ride");
    const yard = getRecord(db, campaign.id, ride.parent_id!)!;
    expect(yard).toMatchObject({ kind: 'location', name: 'Stable yard', parent_id: ids.$town });
    expect(getRecord(db, campaign.id, ids.$duking!)!.parent_id).toBe(yard.id);
    expect(JSON.parse(getRecord(db, campaign.id, ids.$duking!)!.data_json).pos).toEqual({ x: 1, y: 2 });
    expect(storylineOf(db, campaign.id, ids.$thaniesh!)!.id).toBe(ids.$brawl);
    expect(delivery.threads).toEqual([{ id: 'thread1', name: "Duking's ride", private: false, members: ['u-d', 'owner'] }]);
    expect(delivery.sent.find((m) => m.content.includes('stable yard'))!.channelId).toBe('thread1');
    expect(delivery.sent.some((m) => m.channelId === 'main-chan' && m.content.includes('<#thread1>'))).toBe(true);
  });

  it('a split into an existing place with no map is sent back to map it first', async () => {
    const cellar = seed([op({ op: 'create', ref: '$cellar', kind: 'location', name: 'Cellar', parent_id: ids.$inn, data_json: '{"description":"Dark and damp."}' })]).$cellar!;
    let error = '';
    provider.scripts.set('Duking', [
      () => ({
        toolCalls: [
          save([
            op({ op: 'create', ref: '$down', kind: 'scene', name: 'Down in the cellar', parent_id: cellar, data_json: JSON.stringify({ status: 'active', participants_ids: [ids.$duking], time_min: 1081 }) }),
            op({ op: 'set', record_id: ids.$brawl, path: 'data.participants_ids', value_json: JSON.stringify([ids.$thaniesh, ids.$marrow]), expected_version: version(ids.$brawl!) }),
            op({ op: 'move', record_id: ids.$duking, parent_id: cellar }),
          ], 'You slip down into the cellar.'),
        ],
      }),
      (req) => {
        error = JSON.parse((req.items[req.items.length - 1] as { output: string }).output).error;
        return { text: 'giving up' };
      },
    ]);
    const before = getRecord(db, campaign.id, ids.$duking!)!;
    runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'cellar', text: 'I sneak into the cellar', target: target(), sideStory: true });
    await runner.idle();
    expect(error).toMatch(/Cellar \(.+\) has no map/);
    expect(getRecord(db, campaign.id, ids.$duking!)).toEqual(before);
    expect(storylineOf(db, campaign.id, ids.$duking!)!.id).toBe(ids.$brawl);
    expect(delivery.threads).toEqual([]);
  });

  it('a split without side:true stays in the main channel with a Side thread button; pressing it opens the thread', async () => {
    provider.scripts.set('Duking', [() => ({ toolCalls: [save(splitOps(), 'You ride out alone.')] })]);
    const r = runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'nosplitthread', text: 'I leave to find a horse', target: target() });
    await runner.idle();
    const t = getTurn(db, r.turnId!)!;
    expect(delivery.threads).toEqual([]);
    const reply = delivery.sent.find((m) => m.content.includes('ride out alone'))!;
    expect(reply.channelId).toBe('main-chan');
    expect(reply.content).toContain("📍 Duking's ride");
    expect(reply.buttons).toContain(`rpg:side:${t.id}:0`);
    expect(await runner.requestSideThread(t.id, 'u-t', campaign.id)).toMatch(/Only the players in that side story/);
    expect(await runner.requestSideThread(t.id, 'u-d', campaign.id)).toBe('🧵 Moved to <#thread1>.');
    expect(delivery.threads[0]).toMatchObject({ id: 'thread1', private: false, members: ['u-d', 'owner'] });
    // Thaniesh walks out to join Duking: he joins the storyline and is added to its thread.
    const v = version(storylineOf(db, campaign.id, ids.$duking!)!.id);
    const ride = storylineOf(db, campaign.id, ids.$duking!)!;
    provider.scripts.set('Thaniesh', [
      () => ({
        toolCalls: [
          save([
            op({ op: 'set', record_id: ride.id, path: 'data.participants_ids', value_json: JSON.stringify([ids.$duking, ids.$thaniesh]), expected_version: v }),
            op({ op: 'set', record_id: ids.$brawl, path: 'data.participants_ids', value_json: JSON.stringify([ids.$marrow]), expected_version: version(ids.$brawl!) }),
            ...moveTo(ids.$thaniesh!, ids.$road!, 2, 1),
          ], 'You catch up with Duking.'),
        ],
      }),
    ]);
    runner.submit({ campaign, userId: 'u-t', mode: 'play', requestId: 'catchup', text: 'I follow Duking', target: target() });
    await runner.idle();
    expect(delivery.added).toEqual([{ thread: 'thread1', user: 'u-t' }]);
    expect(delivery.sent.find((m) => m.content.includes('catch up'))!.channelId).toBe('thread1');
  });

  it('/rpg merge in a side thread makes that storyline the main story in the main channel', async () => {
    const ride = storylineOf(db, campaign.id, (await split(), ids.$duking!))!;
    expect(await runner.mergeToMain(campaign, 'u-t', 'thread1')).toMatch(/Only the players in that storyline/);
    delivery.sent = [];
    expect(await runner.mergeToMain(campaign, 'u-d', 'thread1')).toBe("↩️ Merged: **Duking's ride** now plays in <#main-chan>.");
    expect(delivery.archived).toEqual(['thread1']);
    expect(threadFor(db, campaign.id, ride.id)).toMatchObject({ archived: true, requested: false });
    expect(JSON.parse(getRecord(db, campaign.id, ride.id)!.data_json).main).toBe(true);
    expect(JSON.parse(getRecord(db, campaign.id, ids.$brawl!)!.data_json).main).toBeUndefined();
    expect(delivery.sent.find((m) => m.channelId === 'thread1')!.content).toContain('continues in the main channel');
    expect(delivery.sent.find((m) => m.channelId === 'main-chan')!.content).toMatch(/is the main story now.*Thaniesh is still in \*\*Brawl at the Inn\*\*, now a side story/);

    // Duking's next action posts in the main channel, with no new thread; Thaniesh's brawl can get one.
    provider.scripts.set('Duking', [() => ({ toolCalls: [save([], 'The road bends north.')] })]);
    provider.scripts.set('Thaniesh', [() => ({ toolCalls: [save([], 'Marrow glares.')] })]);
    delivery.sent = [];
    runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'after', text: 'I ride on', target: target('thread1') });
    const tt = runner.submit({ campaign, userId: 'u-t', mode: 'play', requestId: 'brawl', text: 'I stare at Marrow', target: target() });
    await runner.idle();
    const road = delivery.sent.find((m) => m.content.includes('road bends'))!;
    expect(road.channelId).toBe('main-chan');
    expect(road.buttons?.some((b) => b.startsWith('rpg:side:')) ?? false).toBe(false);
    expect(delivery.sent.find((m) => m.content.includes('Marrow glares'))!.buttons).toContain(`rpg:side:${tt.turnId}:0`);
    expect(delivery.threads).toHaveLength(1);
    expect(await runner.mergeToMain(campaign, 'u-d', 'main-chan')).toMatch(/already the main story/);
  });

  it('private:true is a whisper: answered only in the player\'s private thread, no split, hidden from others', async () => {
    let ctx = '';
    provider.scripts.set('Duking', [
      (req) => {
        ctx = (req.items[0] as { text: string }).text;
        return { toolCalls: [save([], 'You quietly wonder whether Marrow is hiding something.')] };
      },
    ]);
    const r = runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'whisper', text: 'Is Marrow hiding something?', target: { ...target(), ephemeral: true }, privateStory: true });
    await runner.idle();
    expect(ctx).toContain('## Private action (whispered to you)');
    expect(delivery.threads[0]).toMatchObject({ private: true, members: ['u-d'] });
    const id = delivery.threads[0]!.id;
    expect(delivery.sent.find((m) => m.content.includes('quietly wonder'))!.channelId).toBe(id);
    expect(delivery.sent.find((m) => m.channelId === 'main-chan')).toMatchObject({ content: `🤫 Answered in your private thread with the DM: <#${id}>`, ephemeral: true });
    expect(storylineOf(db, campaign.id, ids.$duking!)!.id).toBe(ids.$brawl); // no split

    // Thaniesh's GM context never shows the whisper.
    let other = '';
    provider.scripts.set('Thaniesh', [
      (req) => {
        other = (req.items[0] as { text: string }).text;
        return { toolCalls: [save([], 'You keep fighting.')] };
      },
    ]);
    runner.submit({ campaign, userId: 'u-t', mode: 'play', requestId: 'after-whisper', text: 'I keep fighting', target: target() });
    await runner.idle();
    expect(other).not.toContain('quietly wonder');
    expect(getTurn(db, r.turnId!)!.status).toBe('delivered');
  });


  it('gives each player the context of their own storyline, with the other one as read-only context', async () => {
    await split();
    const { turn } = insertTurn(db, { campaign_id: campaign.id, request_id: 'ctx', actor_user_id: 'u-d', actor_character_id: ids.$duking, mode: 'play', status: 'running', input_text: 'x' });
    const ctx: ToolContext = { campaignId: campaign.id, turnId: turn.id, mode: 'play', actorUserId: 'u-d', actorCharacterId: ids.$duking!, view: 'gm', includePendingSources: false, saveMode: 'commit', allowDice: true, seen: new Map() };
    const text = buildContext({ db, campaign: getCampaign(db, campaign.id)!, turn, ctx });
    const yours = text.split('## Your storyline')[1]!.split('\n## ')[0]!;
    expect(yours).toContain("Duking's ride");
    expect(yours).not.toContain('Brawl at the Inn');
    expect(text).toMatch(/## Elsewhere right now[^\n]*do NOT resolve[\s\S]*Brawl at the Inn/);
    expect(text).toContain('## Shared world clock');
    expect(ctx.seen!.get(storylineOf(db, campaign.id, ids.$duking!)!.id)).toBeDefined();
  });

  it('resolves different storylines concurrently, like a live game', async () => {
    await split();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    provider.scripts.set('Duking', [async () => { await gate; return { toolCalls: [save([], 'Duking rides.')] }; }]);
    provider.scripts.set('Thaniesh', [async () => { await gate; return { toolCalls: [save([op({ op: 'add', record_id: ids.$marrow, path: 'data.hp.current', delta: -3 })], 'Thaniesh punches.')] }; }]);
    provider.maxInFlight = 0;
    runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'p1', text: 'ride', target: target('thread1') });
    runner.submit({ campaign, userId: 'u-t', mode: 'play', requestId: 'p2', text: 'punch', target: target() });
    await new Promise((r) => setTimeout(r, 50));
    expect(provider.inFlight).toBe(2); // both storylines are thinking at the same time
    release();
    await runner.idle();
    expect(provider.maxInFlight).toBe(2);
    expect((JSON.parse(getRecord(db, campaign.id, ids.$marrow!)!.data_json) as { hp: { current: number } }).hp.current).toBe(6);
  });
});

describe('turn order handback', () => {
  const fight = () =>
    seed([
      op({ op: 'set', record_id: ids.$brawl, path: 'data.initiative', value_json: JSON.stringify([{ id: ids.$thaniesh, value: 19 }, { id: ids.$marrow, value: 6 }]), expected_version: version(ids.$brawl!) }),
      op({ op: 'set', record_id: ids.$brawl, path: 'data.turn_of_id', value_json: JSON.stringify(ids.$thaniesh), expected_version: version(ids.$brawl!) }),
    ]);
  const roll = () => call('roll_dice', { check_id: 'punch', purpose: 'punch', expression: '1d20+2', modifier: null, target: 10, comparison: '>=', related_ids: [], visibility: 'public', attacker_id: ids.$thaniesh, target_id: ids.$marrow, reach_ft: 5 });

  it('rejects ending a turn on a pending NPC turn and on a skipped NPC turn, then accepts the fixed save', async () => {
    fight();
    const v = () => version(ids.$brawl!);
    const outputs: string[] = [];
    provider.scripts.set('Thaniesh', [
      () => ({ toolCalls: [roll()] }),
      // 1) leaves Marrow's turn pending
      () => ({ toolCalls: [save([op({ op: 'set', record_id: ids.$brawl, path: 'data.turn_of_id', value_json: JSON.stringify(ids.$marrow), expected_version: v() })], 'Marrow’s turn.')] }),
      // 2) skips Marrow: still Thaniesh's turn in the same round
      (req) => {
        outputs.push(JSON.stringify(req.items[req.items.length - 1]));
        return { toolCalls: [save([op({ op: 'add', record_id: ids.$marrow, path: 'data.hp.current', delta: -2 })], 'Your turn again.')] };
      },
      // 3) resolves Marrow and wraps to round 2
      (req) => {
        outputs.push(JSON.stringify(req.items[req.items.length - 1]));
        return {
          toolCalls: [
            save([
              op({ op: 'add', record_id: ids.$marrow, path: 'data.hp.current', delta: -2 }),
              op({ op: 'set', record_id: ids.$brawl, path: 'data.round', value_json: '2', expected_version: v() }),
            ], 'Marrow swings and misses. Round 2: your turn.'),
          ],
        };
      },
    ]);
    const r = runner.submit({ campaign, userId: 'u-t', mode: 'play', requestId: 'fight', text: 'I punch Marrow', target: target() });
    await runner.idle();
    expect(outputs[0]).toMatch(/a non-player\. Players never trigger NPC turns/);
    expect(outputs[1]).toMatch(/still .*turn in the same round/);
    expect(getTurn(db, r.turnId!)!.status).toBe('delivered');
    expect(JSON.parse(getRecord(db, campaign.id, ids.$brawl!)!.data_json).round).toBe(2);
    expect((JSON.parse(getRecord(db, campaign.id, ids.$marrow!)!.data_json) as { hp: { current: number } }).hp.current).toBe(7);
  });
});

describe('storyline invariants', () => {
  it('rejects a character being in two active storylines at once', () => {
    expect(() =>
      planBatch(db, [op({ op: 'create', ref: '$x', kind: 'scene', name: 'Second', data_json: JSON.stringify({ status: 'active', participants_ids: [ids.$thaniesh] }) })] as never, {
        campaignId: campaign.id,
        actorUserId: 'owner',
        constraints: [],
      }),
    ).toThrow(/only one active scene/);
  });

  it('holds a storyline to the shared world clock and announces when its long action can finish', async () => {
    await split();
    const ride = storylineOf(db, campaign.id, ids.$duking!)!;
    // A two-day ride in one jump is refused (60-minute lead), and nothing is applied.
    provider.scripts.set('Duking', [
      () => ({ toolCalls: [save([op({ op: 'set', record_id: ride.id, path: 'data.time_min', value_json: '3960', expected_version: version(ride.id) })])] }),
      (req) => {
        const last = JSON.parse((req.items[req.items.length - 1] as { output: string }).output);
        expect(last.error).toMatch(/shared world clock/);
        return { toolCalls: [save([op({ op: 'set', record_id: ride.id, path: 'data.busy_until_min', value_json: '3960', expected_version: version(ride.id) })], 'You set out on the long road north.')] };
      },
    ]);
    runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'long', text: 'I ride two days north', target: target('thread1') });
    await runner.idle();
    expect(JSON.parse(getRecord(db, campaign.id, ride.id)!.data_json).time_min).toBe(1085);
    expect(worldClock(db, campaign.id)).toBe(1080); // the ride counts at its finish time; the brawl is now the slowest

    // The main storyline's clock reaches the ride's finish time: one notice in Duking's thread.
    delivery.sent = [];
    provider.scripts.set('Thaniesh', [
      () => ({ toolCalls: [save([op({ op: 'set', record_id: ids.$brawl, path: 'data.time_min', value_json: '3960', expected_version: version(ids.$brawl!) })], 'Two days pass at the inn.')] }),
      () => ({ toolCalls: [save([], 'Quiet.')] }),
    ]);
    runner.submit({ campaign, userId: 'u-t', mode: 'play', requestId: 'wait', text: 'I wait two days', target: target() });
    await runner.idle();
    runner.submit({ campaign, userId: 'u-t', mode: 'play', requestId: 'wait2', text: 'I wait more', target: target() });
    await runner.idle();
    const notices = delivery.sent.filter((m) => m.content.startsWith('⏳'));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.channelId).toBe('thread1');
  });

  it('closes the side thread when the storyline rejoins the main one', async () => {
    await split();
    const ride = storylineOf(db, campaign.id, ids.$duking!)!;
    provider.scripts.set('Duking', [
      () => ({
        toolCalls: [
          save([
            op({ op: 'set', record_id: ids.$brawl, path: 'data.participants_ids', value_json: JSON.stringify([ids.$thaniesh, ids.$marrow, ids.$duking]), expected_version: version(ids.$brawl!) }),
            op({ op: 'set', record_id: ride.id, path: 'data.status', value_json: '"ended"', expected_version: version(ride.id) }),
            ...moveTo(ids.$duking!, ids.$inn!, 6, 3),
          ], 'You ride back into the brawl!'),
        ],
      }),
    ]);
    runner.submit({ campaign, userId: 'u-d', mode: 'play', requestId: 'join', text: 'I ride back and join the fight', target: target('thread1') });
    await runner.idle();
    expect(delivery.archived).toEqual(['thread1']);
    expect(threadFor(db, campaign.id, ride.id)!.archived).toBe(true);
    expect(storylineOf(db, campaign.id, ids.$duking!)!.id).toBe(ids.$brawl);
    expect(delivery.sent.some((m) => m.channelId === 'thread1' && m.content.startsWith('🏁'))).toBe(true);
  });
});
