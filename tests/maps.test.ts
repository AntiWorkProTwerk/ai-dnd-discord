// Battle maps: validation of positions and terrain, the public-only snapshot, the deterministic
// renderer, the GM's text map, and posting through the Map button / map:true / /rpg map.
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
import { asciiMap, mapSnapshot, renderMapSvg, tokenColor } from '../src/maps.js';
import type { ModelProvider, ProviderRequest, ProviderResponse, ToolCall } from '../src/providers.js';
import { planBatch, writeBatch } from '../src/records.js';
import { TurnRunner, type DeliveryPort, type DeliveryTarget, type OutboundMessage } from '../src/turns.js';
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
const MAP = { cols: 10, rows: 8, cell_ft: 5, features: [{ kind: 'wall', label: 'bar', x: 0, y: 0, w: 4, h: 1 }, { kind: 'cover', x: 6, y: 3, w: 1, h: 2 }] };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-map-'));
  db = openDatabase(path.join(dir, 'rpg.sqlite'));
  campaign = createCampaign(db, { guildId: 'g', channelId: 'main-chan', ownerUserId: 'owner', title: 'T', premise: '', rules_edition: '', tone: '', max_players: 4, boundaries: '', require_character_approval: false });
  db.prepare(`UPDATE campaigns SET status = 'active' WHERE id = ?`).run(campaign.id);
  ids = seed([
    op({ op: 'create', ref: '$inn', kind: 'location', name: 'Inn', data_json: '{}' }),
    op({ op: 'create', ref: '$thaniesh', kind: 'character', name: 'Thaniesh', parent_id: '$inn', data_json: '{"hp":{"current":4,"max":10}}' }),
    op({ op: 'create', ref: '$vargas', kind: 'character', name: 'Vargas', parent_id: '$inn', data_json: '{"hp":{"current":10,"max":10}}' }),
    op({ op: 'create', ref: '$marrow', kind: 'npc', name: 'Marrow Gale', parent_id: '$inn', data_json: '{"hp":{"current":0,"max":9}}' }),
    op({ op: 'create', ref: '$spy', kind: 'npc', name: 'Hidden Spy', parent_id: '$inn', visibility: 'gm', data_json: '{}' }),
  ]);
  db.prepare(`UPDATE members SET character_record_id = ? WHERE campaign_id = ? AND discord_user_id = 'owner'`).run(ids.$thaniesh, campaign.id);
  db.prepare(`INSERT INTO members (campaign_id, discord_user_id, character_record_id, role, created_at) VALUES (?, 'u-v', ?, 'player', '')`).run(campaign.id, ids.$vargas);
  const fighters = [ids.$thaniesh, ids.$vargas, ids.$marrow];
  Object.assign(
    ids,
    seed([
      op({
        op: 'create', ref: '$brawl', kind: 'scene', name: 'Brawl at the Inn', parent_id: ids.$inn,
        data_json: JSON.stringify({ status: 'active', main: true, participants_ids: fighters, initiative: fighters.map((id, i) => ({ id, value: 20 - i })), turn_of_id: ids.$vargas, round: 2, time_min: 1080, map: MAP, positions: { [ids.$thaniesh!]: { x: 2, y: 3 }, [ids.$vargas!]: { x: 3, y: 3 }, [ids.$marrow!]: { x: 5, y: 4 } } }),
        gm_notes_json: JSON.stringify({ positions: { [ids.$spy!]: { x: 9, y: 7 } }, map_features: [{ kind: 'pit', label: 'trapdoor', x: 8, y: 1, w: 1, h: 1 }] }),
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

const setPos = (id: string, value: unknown) => op({ op: 'set', record_id: ids.$brawl, path: `data.positions.${id}`, value_json: JSON.stringify(value), expected_version: version(ids.$brawl!) });

describe('map validation', () => {
  it('accepts a legal move and a fresh map', () => {
    expect(tryBatch([setPos(ids.$vargas!, { x: 4, y: 5 })])).not.toThrow();
  });

  it('rejects out of bounds, shared cells, walls, non-participants and hidden records in public positions', () => {
    expect(tryBatch([setPos(ids.$vargas!, { x: 10, y: 3 })])).toThrow(/needs integer x \(0-9\)/);
    expect(tryBatch([setPos(ids.$vargas!, { x: 2, y: 3 })])).toThrow(/share cell 2,3; one creature per cell/);
    expect(tryBatch([setPos(ids.$vargas!, { x: 1, y: 0 })])).toThrow(/inside a wall or object at 1,0/);
    expect(tryBatch([setPos(ids.$vargas!, { x: 8, y: 6, size: 3 })])).toThrow(/extends past the grid/);
    expect(tryBatch([setPos(ids.$spy!, { x: 7, y: 7 })])).toThrow(/hidden from players; put its position in gm_notes\.positions/);
    const npc = seed([op({ op: 'create', ref: '$x', kind: 'npc', name: 'Bystander', parent_id: ids.$inn, data_json: '{}' })]).$x!;
    expect(tryBatch([setPos(npc, { x: 7, y: 7 })])).toThrow(/not in participants_ids or the initiative/);
  });

  it('needs a map for positions and a well-formed map', () => {
    const bad = (map: unknown) => tryBatch([op({ op: 'set', record_id: ids.$brawl, path: 'data.map', value_json: JSON.stringify(map), expected_version: version(ids.$brawl!) })]);
    expect(bad({ cols: 100, rows: 8 })).toThrow(/cols and rows between 1 and 60/);
    expect(bad({ ...MAP, features: [{ kind: 'lava', x: 0, y: 0, w: 1, h: 1 }] })).toThrow(/kind must be one of/);
    expect(bad({ ...MAP, features: [{ kind: 'wall', x: 8, y: 0, w: 5, h: 1 }] })).toThrow(/extends past the 10x8 grid/);
    expect(tryBatch([op({ op: 'remove', record_id: ids.$brawl, path: 'data.map', expected_version: version(ids.$brawl!) })])).toThrow(/positions need a battle map/);
  });

  it('allows a split that moves the position along, and rejects one that leaves it behind', () => {
    const side = (keepOld: boolean) => {
      const ops = [
        op({ op: 'create', ref: '$side', kind: 'scene', name: 'Back alley', parent_id: ids.$inn, data_json: JSON.stringify({ status: 'active', participants_ids: [ids.$vargas], map: { cols: 5, rows: 5, cell_ft: 5 }, positions: { [ids.$vargas!]: { x: 1, y: 1 } } }) }),
        op({ op: 'set', record_id: ids.$brawl, path: 'data.participants_ids', value_json: JSON.stringify([ids.$thaniesh, ids.$marrow]), expected_version: version(ids.$brawl!) }),
        op({ op: 'set', record_id: ids.$brawl, path: 'data.initiative', value_json: JSON.stringify([{ id: ids.$thaniesh, value: 20 }, { id: ids.$marrow, value: 18 }]), expected_version: version(ids.$brawl!) }),
      ];
      if (!keepOld) ops.push(op({ op: 'remove', record_id: ids.$brawl, path: `data.positions.${ids.$vargas}`, expected_version: version(ids.$brawl!) }));
      return tryBatch(ops);
    };
    expect(side(true)).toThrow(/not in participants_ids|has a position in/);
    expect(side(false)).not.toThrow();
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
    expect(snap.turn_of).toBe('Vargas');
    const svg = renderMapSvg(snap);
    expect(svg).toContain('Brawl at the Inn');
    expect(svg).toContain('Round 2 · Vargas&#39;s turn'.replace('&#39;', "'"));
    expect(svg).not.toMatch(/Spy|trapdoor/);
    expect(JSON.stringify(snap)).not.toContain(ids.$spy!);
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
    const text = asciiMap(db, campaign.id, getRecord(db, campaign.id, ids.$brawl!)!, ids.$vargas!)!;
    expect(text).toContain('10x8 grid, 5 ft per cell');
    expect(text).toMatch(/MG = Marrow Gale \(.+\) at 5,4, 10 ft from the actor/);
    expect(text).toMatch(/HS = Hidden Spy .*\[hidden: gm_notes\]/);
    expect(text).toContain('pit "trapdoor" at 8,1 1x1 [hidden: gm_notes]');
  });
});

describe('posting maps', () => {
  it('play map:true posts the turn map under the reply, and the Map button does not post twice', async () => {
    provider.steps.push(() => ({ toolCalls: [save([setPos(ids.$vargas!, { x: 4, y: 3 })], 'You step closer.')] }));
    const r = runner.submit({ campaign, userId: 'u-v', mode: 'play', requestId: 'p1', text: 'step closer', target: { channelId: 'main-chan', ephemeral: false }, map: true });
    await runner.idle();
    const t = getTurn(db, r.turnId!)!;
    expect(delivery.sent[0]!.message.buttons?.map((b) => b.customId)).toEqual([`rpg:map:${t.id}:0`]);
    expect(delivery.sent[0]!.message.content).not.toMatch(/positions|participants_ids/); // bookkeeping is not shown as changes
    const posted = delivery.sent.find((m) => m.message.file?.name === `map-${t.id}.png`)!;
    expect(posted.message.replyTo).toBe('m1');
    expect(posted.channelId).toBe('main-chan');
    expect(fs.existsSync(posted.message.file!.path!)).toBe(true);
    expect((JSON.parse(t.delivery_json).map_snapshot.tokens as { name: string; x: number }[]).find((x) => x.name === 'Vargas')!.x).toBe(4);
    expect(await runner.postMap(t.id, campaign.id)).toMatch(/already posted/);
  });

  it('a play save in a running fight without a battle map is sent back to set one up', async () => {
    const brawl = getRecord(db, campaign.id, ids.$brawl!)!;
    const { map: _m, positions: _p, ...rest } = JSON.parse(brawl.data_json);
    db.prepare('UPDATE records SET data_json = ? WHERE id = ?').run(JSON.stringify(rest), brawl.id);
    let feedback = '';
    provider.steps.push(() => ({ toolCalls: [save([], 'You swing.')] }));
    provider.steps.push((req) => {
      feedback = JSON.stringify(req.items.at(-1));
      return {
        toolCalls: [
          save([
            op({ op: 'set', record_id: ids.$brawl, path: 'data.map', value_json: JSON.stringify(MAP), expected_version: version(ids.$brawl!) }),
            op({ op: 'set', record_id: ids.$brawl, path: 'data.positions', value_json: JSON.stringify({ [ids.$thaniesh!]: { x: 2, y: 3 }, [ids.$vargas!]: { x: 3, y: 3 }, [ids.$marrow!]: { x: 5, y: 4 } }), expected_version: version(ids.$brawl!) }),
          ], 'You swing.'),
        ],
      };
    });
    const r = runner.submit({ campaign, userId: 'u-v', mode: 'play', requestId: 'nomap', text: 'swing', target: { channelId: 'main-chan', ephemeral: false } });
    await runner.idle();
    expect(feedback).toMatch(/has a fight \(initiative\) but no battle map/);
    expect(getTurn(db, r.turnId!)!.status).toBe('delivered');
    expect(JSON.parse(getRecord(db, campaign.id, ids.$brawl!)!.data_json).map.cols).toBe(10);
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

describe('dioramas', () => {
  it('adds a Diorama button next to Map, renders the turn snapshot once, and posts it under the reply', async () => {
    const rendered: { tokens: number; out: string; turntable?: string }[] = [];
    const dioRunner = new TurnRunner({
      db, config: loadConfig({ DATA_DIR: dir, LLM_PROVIDER: 'ollama' }), provider, delivery, modelLimiter: new Semaphore(2),
      diorama: {
        queue: new ImageQueue(2),
        renderer: {
          async render(snapshot, out, opts) {
            rendered.push({ tokens: snapshot.tokens.length, out, turntable: opts?.turntable });
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, 'png');
            if (opts?.turntable) fs.writeFileSync(opts.turntable, 'mp4');
            return { path: out, video: opts?.turntable ?? null, seconds: 1 };
          },
        },
      },
    });
    provider.steps.push(() => ({ toolCalls: [save([], 'You hold your ground.')] }));
    const r = dioRunner.submit({ campaign, userId: 'u-v', mode: 'play', requestId: 'dio1', text: 'hold', target: { channelId: 'main-chan', ephemeral: false }, diorama: true });
    await dioRunner.idle();
    await new Promise((res) => setTimeout(res, 20));
    const t = getTurn(db, r.turnId!)!;
    expect(delivery.sent[0]!.message.buttons?.map((b) => b.label)).toEqual(['🗺️ Map', '🧊 Diorama']);
    expect(rendered).toEqual([{ tokens: 3, out: expect.stringContaining(`diorama-turn-${t.id}.png`), turntable: undefined }]);
    const posted = delivery.sent.find((m) => m.message.file?.name === `diorama-${t.id}.png`)!;
    expect(posted.message.replyTo).toBe('m1');
    expect(dioRunner.diorama(t.id, campaign.id).message).toMatch(/already posted/);
    await dioRunner.diorama(t.id, campaign.id, { turntable: true }).done;
    expect(delivery.sent.at(-1)!.message.file?.name).toBe(`diorama-${t.id}.mp4`);
  });

  it('is off without the renderer', () => {
    expect(runner.diorama(1).message).toMatch(/turned off/);
  });
});
