// Scene illustrations: spoiler-safe prompts, button/queue behaviour, auto-illustrate, failures.
// A fake generator stands in for the local GPU pipeline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Semaphore } from '../src/agent.js';
import { createCampaign } from '../src/campaign.js';
import { loadConfig } from '../src/config.js';
import { getCampaign, getTurn, openDatabase, type Db } from '../src/database.js';
import { buildScenePlan, buildScenePrompt, ImageBusyError, ImageQueue, loadImageConfig, type ImageGenerator } from '../src/images.js';
import type { ModelProvider, ProviderRequest, ProviderResponse } from '../src/providers.js';
import { planBatch, writeBatch } from '../src/records.js';
import { TurnRunner, type DeliveryPort, type DeliveryTarget, type OutboundMessage } from '../src/turns.js';
import type { CampaignRow } from '../src/types.js';
import type { SceneSpec } from '../src/scene3d.js';

const op = (o: Record<string, unknown>) => ({
  ref: null, record_id: null, kind: null, name: null, parent_id: null, visibility: null, path: null,
  value_json: null, data_json: null, gm_notes_json: null, expected_json: null, expected_version: null, delta: null, ...o,
});

class OneShotProvider implements ModelProvider {
  name = 'fake'; model = 'fake'; paid = false; inputUsdPerMillion = 0; outputUsdPerMillion = 0;
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    void req;
    return {
      assistant: { type: 'assistant', text: null, toolCalls: [{ id: 'c1', name: 'save_turn', arguments: JSON.stringify({ expected_revision: 1, operations: [], public_reply: 'Rain hammers the **chapel** roof as smugglers burst in.', gm_note: '', source_refs: [], roll_ids: [] }) }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      status: 'completed',
    };
  }
  async check() { return 'ok'; }
}

class Capture implements DeliveryPort {
  sent: OutboundMessage[] = [];
  async send(_t: DeliveryTarget, m: OutboundMessage) {
    this.sent.push(m);
    return `m${this.sent.length}`;
  }
}

let dir: string;
let db: Db;
let campaign: CampaignRow;
let delivery: Capture;
let prompts: string[];
let refsSeen: string[][];
let fail: Error | null;

let built: string[];
let scenes: SceneSpec[];
let sceneFail: Error | null;
let rendered: { model?: string }[][];
let views: string[];

function runnerWith(images = true, max = 4, dioramas = false) {
  const config = loadConfig({ DATA_DIR: dir, LLM_PROVIDER: 'ollama' });
  delivery = new Capture();
  const generator: ImageGenerator = {
    async generate(prompt, _seed, out, opts) {
      prompts.push(prompt);
      refsSeen.push(opts?.refs ?? []);
      if (fail) throw fail;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, 'png');
      return { path: out, seconds: 0.1 };
    },
  };
  const queue = new ImageQueue(max);
  built = [];
  scenes = [];
  sceneFail = null;
  rendered = [];
  views = [];
  return new TurnRunner({
    db, config, provider: new OneShotProvider(), delivery, modelLimiter: new Semaphore(1),
    images: images ? { generator, queue, config: loadImageConfig({ IMAGE_GENERATION: 'comfy' }) } : undefined,
    diorama: dioramas
      ? {
          queue,
          scene: {
            async render(spec, out, opts) {
              if (sceneFail) throw sceneFail;
              views.push(opts?.view ?? 'shot');
              if (opts?.view === 'diorama') rendered.push(spec.people.map((p) => ({ model: p.model })));
              else scenes.push(spec);
              fs.mkdirSync(path.dirname(out), { recursive: true });
              fs.writeFileSync(out, 'png');
              return { path: out, video: null, seconds: 2 };
            },
          },
          miniatures: {
            async build(portrait, out) {
              built.push(portrait);
              fs.mkdirSync(path.dirname(out), { recursive: true });
              fs.writeFileSync(out, 'glb');
              return { path: out, seconds: 1 };
            },
          },
        }
      : undefined,
  });
}

const CHAPEL_MAP = { cols: 10, rows: 8, cell_ft: 5, features: [{ kind: 'object', label: 'altar', x: 4, y: 0, w: 2, h: 1 }] };
/** Puts a record on its place's map (bypassing validation). */
const setPos = (id: string, pos: object) => db.prepare(`UPDATE records SET data_json = json_set(data_json, '$.pos', json(?)) WHERE id = ?`).run(JSON.stringify(pos), id);

const target = (): DeliveryTarget => ({ channelId: 'c', ephemeral: false, interaction: { application_id: 'a', token: 't', created_at: new Date().toISOString() } });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-img-'));
  db = openDatabase(path.join(dir, 'rpg.sqlite'));
  prompts = [];
  refsSeen = [];
  fail = null;
  campaign = createCampaign(db, { guildId: 'g', channelId: 'c', ownerUserId: 'o', title: 'T', premise: '', rules_edition: '', tone: 'grim', max_players: 4, boundaries: '', require_character_approval: false });
  db.transaction(() => {
    const plan = planBatch(db, [
      // Every place anyone plays in has a saved map, and everyone there a position on it.
      op({ op: 'create', ref: '$room', kind: 'location', name: 'Cray Chapel', data_json: JSON.stringify({ description: 'A flooded stone chapel', map: CHAPEL_MAP }), gm_notes_json: '{"secret":"The reeve hid the bell clapper here"}' }),
      op({ op: 'create', ref: '$pc', kind: 'character', name: 'Borin', parent_id: '$room', data_json: JSON.stringify({ appearance: 'stocky dwarf with a red beard', pos: { x: 4, y: 7 } }) }),
      op({ op: 'create', ref: '$vault', kind: 'location', name: 'Secret Vault', parent_id: '$room', visibility: 'gm', data_json: '{"description":"hidden treasure vault"}' }),
    ] as never, { campaignId: campaign.id, actorUserId: 'o', constraints: [] });
    writeBatch(db, campaign.id, plan);
    db.prepare(`UPDATE campaigns SET status = 'active', revision = 1 WHERE id = ?`).run(campaign.id);
    db.prepare(`UPDATE records SET private_owner_user_id = 'u1' WHERE kind = 'character'`).run();
    const pc = db.prepare(`SELECT id FROM records WHERE kind = 'character'`).get() as { id: string };
    db.prepare(`INSERT INTO members (campaign_id, discord_user_id, character_record_id, role, created_at) VALUES (?, 'u1', ?, 'player', '')`).run(campaign.id, pc.id);
  })();
  campaign = getCampaign(db, campaign.id)!;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function playTurn(runner: TurnRunner, illustrate = false) {
  const r = runner.submit({ campaign, userId: 'u1', mode: 'play', requestId: `p${Math.random()}`, text: 'I raise my axe', target: target(), illustrate });
  await runner.idle();
  return getTurn(db, r.turnId!)!;
}

describe('scene prompts', () => {
  it('use public narration and records only, never GM notes or hidden places', async () => {
    const runner = runnerWith();
    const t = await playTurn(runner);
    const prompt = buildScenePrompt(db, t, 'Painted', 'grim');
    expect(prompt).toContain('Rain hammers the chapel roof');
    expect(prompt).toContain('Setting: A flooded stone chapel');
    expect(prompt).not.toMatch(/Borin|Cray Chapel/);
    expect(prompt).toContain('stocky dwarf with a red beard');
    expect(prompt).toMatch(/wordless/);
    expect(prompt).not.toMatch(/reeve hid|clapper|Secret Vault|treasure/);
    expect(prompt).not.toContain('**');
    expect(buildScenePrompt(db, { ...t, public_reply: 'She says “Run, the bell!” and points.' }, 'P')).not.toMatch(/Run, the bell/);
  });
});

describe('scene prompts from game state', () => {
  it('show everyone in the storyline with their looks, wounds and weapons, even when the reply is all turn talk', async () => {
    const runner = runnerWith();
    const t = await playTurn(runner);
    const room = (db.prepare(`SELECT id FROM records WHERE name = 'Cray Chapel'`).get() as { id: string }).id;
    db.transaction(() => {
      const plan = planBatch(db, [
        op({ op: 'create', ref: '$elf', kind: 'character', name: 'Thaniesh', parent_id: room, data_json: '{"concept":"A night elf scout","hp":{"current":3,"max":10}}' }),
        op({ op: 'create', ref: '$inn', kind: 'npc', name: 'Marrow Gale', parent_id: room, data_json: '{"role":"innkeeper","attacks":["cudgel +2, 1d6"]}' }),
        op({ op: 'create', ref: '$spy', kind: 'npc', name: 'Hidden Spy', parent_id: room, visibility: 'gm', data_json: '{"role":"spy"}' }),
        op({ op: 'create', ref: '$fight', kind: 'scene', name: 'Brawl', parent_id: room, data_json: '{}' }),
      ] as never, { campaignId: campaign.id, actorUserId: 'o', constraints: [] });
      writeBatch(db, campaign.id, plan);
      const ids = [t.actor_character_id, plan.created.$elf, plan.created.$inn, plan.created.$spy];
      db.prepare(`UPDATE records SET data_json = ? WHERE id = ?`).run(JSON.stringify({ status: 'active', main: true, participants_ids: ids, round: 1, initiative: ids.map((id, i) => ({ id, value: 10 - i })) }), plan.created.$fight);
    })();
    const prompt = buildScenePrompt(db, { ...t, scene_id: null, public_reply: 'You step into the melee. Your initiative is 17; Thaniesh has the next decision.' }, 'Painted');
    expect(prompt).toContain('The hero steps into the melee');
    expect(prompt).toMatch(/A fight is under way|melee/);
    expect(prompt).toContain('stocky dwarf with a red beard');
    expect(prompt).toContain('Also in the scene: the companion, a night elf scout, bloodied and wounded; the innkeeper, carrying a cudgel');
    expect(prompt).not.toMatch(/Thaniesh|Marrow|spy|initiative|decision/i);
  });
});

describe('scene prompt cleanup', () => {
  it('drops questions, turn talk, numbers and unknown names; fixes "you" grammar', async () => {
    const runner = runnerWith();
    const t = await playTurn(runner);
    const narration =
      "You’re in the middle of a fight at the Silver Stag on Market Mound. You punched Borin, then swung a huge club and missed, smashing the counter instead. You’re still unhurt; the innkeeper’s turn is next. Rooms cost 5 sp. What do you do?";
    const prompt = buildScenePrompt(db, { ...t, public_reply: narration, input_text: 'I beat him senseless lol' }, 'Painted');
    expect(prompt).toContain('The hero is in the middle of a fight');
    expect(prompt).toContain('smashing the counter instead');
    expect(prompt).not.toMatch(/What do|turn is next|unhurt|5 sp|Market Mound|Silver Stag|’re|senseless/);
    expect(prompt).toMatch(/^Painted\. [A-Z]/);
  });
});

describe('illustrate', () => {
  it('adds a button to play replies and posts the image as a reply to the scene, once', async () => {
    const runner = runnerWith();
    const t = await playTurn(runner);
    // Every scene has a map now (its battle map, or a sketch), then the picture button.
    expect(delivery.sent[0]!.buttons?.map((b) => b.customId)).toEqual([`rpg:map:${t.id}:0`, `rpg:img:${t.id}:0`]);
    const r = runner.illustrate(t.id, campaign.id);
    expect(r.message).toMatch(/Painting/);
    expect(await r.done).toMatchObject({ path: expect.stringContaining(`turn-${t.id}.png`) });
    const posted = delivery.sent[delivery.sent.length - 1]!;
    expect(posted.file?.path).toContain(`turn-${t.id}.png`);
    expect(posted.replyTo).toBe('m1');
    expect(runner.illustrate(t.id, campaign.id).message).toMatch(/already illustrated/);
    // The hero's portrait is painted first, then passed as a reference for the scene.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatch(/Full-body portrait/);
    expect(prompts[1]).toMatch(/one frame, not a split panel.*Image 1 shows the hero: keep their face/);
    expect(refsSeen[1]).toEqual([expect.stringContaining(path.join('portraits', `${t.actor_character_id}.png`))]);
    expect(getCampaign(db, campaign.id)!.revision).toBe(2);
  });

  it('auto-illustrates when the play command asked for it', async () => {
    const runner = runnerWith();
    const t = await playTurn(runner, true);
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts).toHaveLength(2);
    expect(JSON.parse(getTurn(db, t.id)!.delivery_json).image.status).toBe('done');
  });

  it('is off without a pipeline and refuses non-scene turns', async () => {
    const off = runnerWith(false);
    const t = await playTurn(off);
    expect(delivery.sent[0]!.buttons?.map((b) => b.customId)).toEqual([`rpg:map:${t.id}:0`]);
    expect(off.illustrate(t.id).message).toMatch(/turned off/);
    const on = runnerWith();
    expect(on.illustrate(99999).message).toMatch(/not a scene/);
  });

  it('reports a busy GPU in the channel and allows a later retry', async () => {
    const runner = runnerWith();
    const t = await playTurn(runner);
    fail = new ImageBusyError('busy');
    const r = runner.illustrate(t.id, campaign.id);
    expect(await r.done).toMatchObject({ error: expect.stringMatching(/busy/) });
    expect(delivery.sent[delivery.sent.length - 1]!.content).toMatch(/GPU is busy/);
    fail = null;
    expect(await runner.illustrate(t.id, campaign.id).done).toMatchObject({ path: expect.any(String) });
  });

  it('bounds the backlog', () => {
    const q = new ImageQueue(1);
    expect(q.run(() => new Promise(() => undefined))).not.toBeNull();
    expect(q.run(async () => 1)).toBeNull();
  });
});

describe('portraits', () => {
  const pcId = () => (db.prepare(`SELECT id FROM records WHERE kind = 'character'`).get() as { id: string }).id;

  it('paint once from the public look, are reused, and repaint when the look changes or the file is gone', async () => {
    const runner = runnerWith();
    const id = pcId();
    const first = runner.paintPortrait(campaign.id, id);
    expect(first.message).toMatch(/Painting Borin's portrait/);
    const p = (await first.done)!;
    expect(p.path).toContain(path.join('portraits', `${id}.png`));
    expect(prompts.at(-1)).toMatch(/Full-body portrait of one adventurer/);
    expect(prompts.at(-1)).toContain('stocky dwarf with a red beard');
    expect(prompts.at(-1)).not.toContain('Borin');
    expect(runner.paintPortrait(campaign.id, id).message).toBe('ready');
    expect(prompts).toHaveLength(1);

    db.prepare(`UPDATE records SET data_json = '{"appearance":"lean elf with silver hair"}' WHERE id = ?`).run(id);
    const repaint = runner.paintPortrait(campaign.id, id);
    expect(repaint.message).toMatch(/Painting/);
    await repaint.done;
    expect(prompts.at(-1)).toContain('lean elf with silver hair');

    fs.rmSync(p.path);
    expect(runner.paintPortrait(campaign.id, id).message).toMatch(/Painting/);
  });

  it('never paints hidden NPCs, and portrait records are invisible to the GM tools', async () => {
    const runner = runnerWith();
    const spy = db.transaction(() => {
      const plan = planBatch(db, [op({ op: 'create', ref: '$spy', kind: 'npc', name: 'Spy', visibility: 'gm', data_json: '{"appearance":"masked"}' })] as never, { campaignId: campaign.id, actorUserId: 'o', constraints: [] });
      writeBatch(db, campaign.id, plan);
      return plan.created.$spy!;
    })();
    expect(runner.paintPortrait(campaign.id, spy).done).toBeNull();
    await runner.paintPortrait(campaign.id, pcId()).done;
    expect(() => planBatch(db, [op({ op: 'create', ref: '$p', kind: '_portrait', name: 'x', data_json: '{}' })] as never, { campaignId: campaign.id, actorUserId: 'o', constraints: [] })).toThrow(/_portrait/);
  });

  it('accepting a character paints its portrait in the background', async () => {
    const runner = runnerWith();
    const t = getTurn(db, insertCharacterDraft())!;
    expect(await runner.confirm({ kind: 'chr', turnId: t.id, nonce: t.confirm_nonce!, userId: 'u2', campaign, target: target() })).toMatch(/Character created/);
    await runner.idle();
    await new Promise((r) => setTimeout(r, 20));
    expect(prompts.some((p) => p.includes('tall woman with a scarred cheek'))).toBe(true);
  });
});

/** A proposed character draft for user u2, ready to accept. */
function insertCharacterDraft(): number {
  const ops = [op({ op: 'create', ref: '$pc', kind: 'character', name: 'Ysolde', data_json: '{"appearance":"tall woman with a scarred cheek"}' })];
  const row = db
    .prepare(
      `INSERT INTO turns (campaign_id, request_id, actor_user_id, mode, status, input_text, changes_json, delivery_json, confirm_nonce, expires_at, base_revision, created_at, updated_at)
       VALUES (?, 'draft-u2', 'u2', 'character', 'proposed', 'a fighter', ?, '{}', 'nonce1', ?, ?, datetime('now'), datetime('now')) RETURNING id`,
    )
    .get(campaign.id, JSON.stringify({ operations: ops }), new Date(Date.now() + 600_000).toISOString(), getCampaign(db, campaign.id)!.revision) as { id: number };
  return row.id;
}

describe('scene plans', () => {
  it('focus on at most 3 people, pass at most 2 player portraits, and place people from the battle map', async () => {
    const runner = runnerWith();
    const t = await playTurn(runner);
    const room = (db.prepare(`SELECT id FROM records WHERE name = 'Cray Chapel'`).get() as { id: string }).id;
    const created = db.transaction(() => {
      const plan = planBatch(db, [
        op({ op: 'create', ref: '$elf', kind: 'character', name: 'Thaniesh', parent_id: room, data_json: '{"concept":"A night elf scout"}' }),
        op({ op: 'create', ref: '$rogue', kind: 'character', name: 'Vargas', parent_id: room, data_json: '{"concept":"A red-haired loner"}' }),
        op({ op: 'create', ref: '$inn', kind: 'npc', name: 'Marrow Gale', parent_id: room, data_json: '{"role":"innkeeper"}' }),
        op({ op: 'create', ref: '$fight', kind: 'scene', name: 'Brawl', parent_id: room, data_json: '{}' }),
      ] as never, { campaignId: campaign.id, actorUserId: 'o', constraints: [] });
      writeBatch(db, campaign.id, plan);
      return plan.created;
    })();
    const ids = [t.actor_character_id!, created.$elf!, created.$rogue!, created.$inn!];
    db.prepare(`UPDATE records SET data_json = ? WHERE id = ?`).run(
      JSON.stringify({ status: 'active', main: true, participants_ids: ids, round: 1, turn_of_id: created.$inn, initiative: ids.map((id, i) => ({ id, value: 10 - i })) }),
      created.$fight,
    );
    // On the chapel's map (altar along the north wall); the hero already stands at 4,7.
    setPos(ids[3]!, { x: 4, y: 1 });
    setPos(ids[1]!, { x: 5, y: 2 });
    setPos(ids[2]!, { x: 9, y: 6 });
    const plan = buildScenePlan(db, { ...t, scene_id: created.$fight! }, 'Painted', '', (id) => `/portraits/${id}.png`);
    expect(plan.focus).toEqual([t.actor_character_id, created.$inn, created.$elf]); // actor, whose turn, nearest to the action
    expect(plan.refs).toEqual([`/portraits/${t.actor_character_id}.png`, `/portraits/${created.$elf}.png`]);
    expect(plan.prompt).toContain('Image 1 shows the hero and image 2 shows the first companion');
    // Tokens come in record order now (everyone standing in the place), so check each part.
    expect(plan.prompt).toMatch(/Composition: [^.]*the hero is [^;.]*in the foreground/);
    expect(plan.prompt).toMatch(/Composition: [^.]*the innkeeper is [^;.]*in the background by the altar, right next to the first companion/);
    expect(plan.prompt).toContain('One more figure in the background');
    expect(plan.prompt).not.toMatch(/Thaniesh|Vargas|Marrow/);
  });

  it('falls back to a text-only picture when the reference run fails', async () => {
    const runner = runnerWith();
    const t = await playTurn(runner);
    let calls = 0;
    fail = null;
    const orig = prompts;
    // Fail only the scene run that carries references.
    (runner as unknown as { deps: { images: { generator: { generate: (...a: unknown[]) => Promise<unknown> } } } }).deps.images.generator.generate = async (prompt, _seed, out, opts) => {
      calls++;
      orig.push(prompt as string);
      if ((opts as { refs?: string[] } | undefined)?.refs?.length) throw new Error('reference upload failed');
      fs.mkdirSync(path.dirname(out as string), { recursive: true });
      fs.writeFileSync(out as string, 'png');
      return { path: out, seconds: 0.1 };
    };
    expect(await runner.illustrate(t.id, campaign.id).done).toMatchObject({ path: expect.stringContaining(`turn-${t.id}.png`) });
    expect(calls).toBe(3); // portrait, scene with references (failed), scene without
    expect(orig.at(-1)).not.toMatch(/Image 1 shows/);
  });
});

describe('3D miniatures', () => {
  const pcId = () => (db.prepare(`SELECT id FROM records WHERE kind = 'character'`).get() as { id: string }).id;

  it('build from the portrait once, rebuild when the portrait changes, and stand in dioramas', async () => {
    const runner = runnerWith(true, 4, true);
    const id = pcId();
    const first = runner.buildMiniature(campaign.id, id);
    expect(first.message).toMatch(/Building Borin's 3D miniature/);
    const glb = (await first.done)!;
    expect(glb).toContain(path.join('miniatures', `${id}.glb`));
    expect(built).toEqual([expect.stringContaining(path.join('portraits', `${id}.png`))]); // portrait painted first
    expect(runner.buildMiniature(campaign.id, id).message).toBe('ready');

    // On the chapel's map: the diorama gets the miniature for that token.
    const room = (db.prepare(`SELECT id FROM records WHERE name = 'Cray Chapel'`).get() as { id: string }).id;
    db.transaction(() => {
      const plan = planBatch(db, [op({ op: 'create', ref: '$s', kind: 'scene', name: 'Chapel', parent_id: room, data_json: JSON.stringify({ status: 'active', main: true, participants_ids: [id] }) })] as never, { campaignId: campaign.id, actorUserId: 'o', constraints: [] });
      writeBatch(db, campaign.id, plan);
    })();
    expect(await runner.dioramaNow(getCampaign(db, campaign.id)!, 'u1').done).toBeUndefined();
    expect(rendered.at(-1)).toEqual([{ model: glb }]);

    db.prepare(`UPDATE records SET data_json = '{"appearance":"lean elf with silver hair"}' WHERE id = ?`).run(id);
    expect(runner.buildMiniature(campaign.id, id).message).toMatch(/Building/); // stale: the look changed
  });

  it('a newly accepted character gets its portrait and then its miniature', async () => {
    const runner = runnerWith(true, 4, true);
    const t = getTurn(db, insertCharacterDraft())!;
    await runner.confirm({ kind: 'chr', turnId: t.id, nonce: t.confirm_nonce!, userId: 'u2', campaign, target: target() });
    for (let i = 0; i < 20 && !built.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(built).toHaveLength(1);
  });
});

describe('3D scene renders', () => {
  it('🎨 renders the scene in 3D with the saved models (building missing ones first) and posts it under the reply', async () => {
    const runner = runnerWith(true, 4, true);
    const t = await playTurn(runner);
    const r = runner.illustrate(t.id, campaign.id);
    expect(await r.done).toMatchObject({ path: expect.stringContaining(`turn-${t.id}.png`) });
    expect(built).toHaveLength(1); // the hero's miniature was built first
    expect(scenes).toHaveLength(1);
    expect(views).toEqual(['shot']);
    expect(scenes[0]!.people.find((p) => p.id === t.actor_character_id)!.model).toContain('miniatures');
    expect(scenes[0]!.indoor).toBe(true); // a chapel
    const posted = delivery.sent.at(-1)!;
    expect(posted.content).toMatch(/^🎬 \*\*Borin\*\*/);
    expect(posted.replyTo).toBe('m1');
    expect(JSON.parse(getTurn(db, t.id)!.delivery_json).image).toMatchObject({ status: 'done', mode: 'render3d' });
  });

  it('falls back to a painted picture when Blender fails', async () => {
    const runner = runnerWith(true, 4, true);
    const t = await playTurn(runner);
    sceneFail = new Error('Blender crashed');
    await runner.illustrate(t.id, campaign.id).done;
    expect(delivery.sent.at(-1)!.content).toMatch(/^🎨/);
    expect(prompts.some((p) => p.includes('Rain hammers'))).toBe(true);
  });
});
