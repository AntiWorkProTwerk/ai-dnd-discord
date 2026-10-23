import { afterAll, describe, expect, it } from 'vitest';
import { getCampaign, getTurn, insertTurn, nowIso, type Db } from '../src/database.js';
import { availableTools, runTool } from '../src/tools.js';
import type { ToolContext } from '../src/types.js';
import {
  addMember,
  ALICE,
  BOB,
  cleanupTempDirs,
  createOp,
  data,
  makeCtx,
  newCampaign,
  newTurn,
  op,
  readArgs,
  rec,
  saveArgs,
  seed,
  snapshot,
  tempDb,
} from './helpers.js';

afterAll(cleanupTempDirs);

function call(db: Db, ctx: ToolContext, name: string, args: string) {
  const out = runTool({ db, ctx }, name, args);
  return { ...out, json: JSON.parse(out.output) as Record<string, any> };
}

function insertSource(
  db: Db,
  campaignId: string,
  s: { status: string; visibility?: 'public' | 'gm'; role?: string; title?: string; section?: string | null; text: string; page?: number | null },
): number {
  const info = db
    .prepare(
      `INSERT INTO sources (campaign_id, import_id, version, status, role, visibility, title, filename, content_hash, section, page_start, page_end, text, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, 'x.md', 'hash', ?, ?, ?, ?, ?)`,
    )
    .run(campaignId, `imp_${s.status}`, s.status, s.role ?? 'rules', s.visibility ?? 'public', s.title ?? 'Rules', s.section ?? null, s.page ?? null, s.page ?? null, s.text, nowIso());
  return Number(info.lastInsertRowid);
}

const searchArgs = (query: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ query, role: null, section: null, page_from: null, page_to: null, limit: null, ...over });

describe('campaign isolation', () => {
  it('IDs from another campaign are "not found" and cannot be mutated or referenced', () => {
    const { db } = tempDb();
    const a = newCampaign(db);
    const b = newCampaign(db);
    const aIds = seed(db, a.id, [createOp('$loc', 'location', 'Tavern A')]);
    const bIds = seed(db, b.id, [createOp('$npc', 'npc', 'Secret Agent B', { hp: 5 }, { gm_notes_json: '{"secret":"B plot"}' })]);
    const bNpc = bIds.$npc!;

    const t = newTurn(db, a.id);
    const ctx = makeCtx(a.id, t.id);
    const read = call(db, ctx, 'read_records', readArgs({ ids: [bNpc, aIds.$loc] }));
    expect(read.json.records.map((r: { id: string }) => r.id)).toEqual([aIds.$loc]);
    expect(read.json.errors).toEqual([`${bNpc}: not found in this campaign`]);
    expect(read.output).not.toContain('B plot');

    const byKind = call(db, ctx, 'read_records', readArgs({ kind: 'npc' }));
    expect(byKind.json.records).toEqual([]);
    const byText = call(db, ctx, 'read_records', readArgs({ text: 'Secret Agent' }));
    expect(byText.json.records).toEqual([]);
    const byParent = call(db, ctx, 'read_records', readArgs({ parent_id: bNpc }));
    expect(byParent.json.records).toEqual([]);

    const bBefore = snapshot(db, b.id);
    const attempts = [
      [op({ op: 'add', record_id: bNpc, path: 'data.hp', delta: -5 })],
      [op({ op: 'set', record_id: bNpc, path: 'data.hp', value_json: '0', expected_version: 1 })],
      [op({ op: 'archive', record_id: bNpc })],
      [op({ op: 'move', record_id: bNpc, parent_id: aIds.$loc! })],
      [op({ op: 'move', record_id: aIds.$loc!, parent_id: bNpc, expected_version: 1 })],
      [createOp('$x', 'item', 'Stolen', {}, { parent_id: bNpc })],
      [createOp('$q', 'quest', 'Hunt', { target_id: bNpc })],
    ];
    for (const ops of attempts) {
      const res = call(db, ctx, 'save_turn', saveArgs({ operations: ops }));
      expect(res.json.ok).toBe(false);
      expect(res.saved).toBeUndefined();
    }
    expect(snapshot(db, b.id)).toEqual(bBefore);
    expect(getCampaign(db, a.id)!.revision).toBe(0);
    expect(rec(db, aIds.$loc!)!.parent_id).toBeNull();
  });

  it('events are scoped to the campaign', () => {
    const { db } = tempDb();
    const a = newCampaign(db);
    const b = newCampaign(db);
    const tb = newTurn(db, b.id, { input: 'I bribe the duke with the ruby' });
    expect(call(db, makeCtx(b.id, tb.id), 'save_turn', saveArgs({ public_reply: 'The duke accepts the ruby.' })).json.ok).toBe(true);
    const ta = newTurn(db, a.id);
    const res = call(db, makeCtx(a.id, ta.id), 'read_records', readArgs({ event_query: 'ruby' }));
    expect(res.json.events).toEqual([]);
    const own = call(db, makeCtx(b.id, newTurn(db, b.id).id), 'read_records', readArgs({ event_query: 'ruby' }));
    expect(own.json.events).toHaveLength(1);
  });
});

describe('player-facing projection', () => {
  function world() {
    const { db } = tempDb();
    const c = newCampaign(db);
    const ids = seed(db, c.id, [
      createOp('$tavern', 'location', 'Tavern', { description: 'smoky' }, { gm_notes_json: '{"trap":"GMONLY-trapdoor"}' }),
      createOp('$spy', 'npc', 'Hidden spy', { plan: 'GMONLY-poison' }, { visibility: 'gm', parent_id: '$tavern' }),
      createOp('$keeper', 'npc', 'Innkeeper', { attitude: 'friendly' }, { parent_id: '$tavern', gm_notes_json: '{"secret":"GMONLY-smuggler"}' }),
    ]);
    const alice = seed(db, c.id, [createOp('$a', 'character', 'Mira', {}, { parent_id: ids.$tavern! }), createOp('$aNote', 'note', 'Mira journal', { text: 'ALICE-PRIVATE' }, { visibility: 'owner' })], {
      actor: ALICE,
      characterOwnerUserId: ALICE,
    });
    const bob = seed(db, c.id, [createOp('$b', 'character', 'Bors', {}, { parent_id: ids.$tavern! }), createOp('$bNote', 'note', 'Bors journal', { text: 'BOB-PRIVATE' }, { visibility: 'owner', parent_id: ids.$tavern! })], {
      actor: BOB,
      characterOwnerUserId: BOB,
    });
    addMember(db, c.id, ALICE, alice.$a!);
    addMember(db, c.id, BOB, bob.$b!);
    return { db, c, ids: { ...ids, ...alice, ...bob } };
  }

  it('hides gm records, gm_notes and other players\' owner records', () => {
    const { db, c, ids } = world();
    const t = newTurn(db, c.id, { mode: 'ask' });
    const ctx = makeCtx(c.id, t.id, { view: 'player', mode: 'ask', saveMode: 'none', allowDice: false, actorUserId: ALICE });
    const all = [ids.$tavern, ids.$spy, ids.$keeper, ids.$a, ids.$aNote, ids.$b, ids.$bNote];
    const res = call(db, ctx, 'read_records', readArgs({ ids: all, include_children: true }));
    const seen = res.json.records.map((r: { id: string }) => r.id);
    expect(seen.sort()).toEqual([ids.$tavern, ids.$keeper, ids.$a, ids.$aNote, ids.$b].sort());
    expect(res.json.errors.sort()).toEqual([`${ids.$spy}: not found in this campaign`, `${ids.$bNote}: not found in this campaign`].sort());
    expect(res.output).not.toContain('GMONLY');
    expect(res.output).not.toContain('BOB-PRIVATE');
    expect(res.output).toContain('ALICE-PRIVATE');
    expect(res.output).not.toContain('gm_notes');
    const tavern = res.json.records.find((r: { id: string }) => r.id === ids.$tavern);
    const childIds = tavern.children.map((ch: { id: string }) => ch.id);
    expect(childIds).not.toContain(ids.$spy);
    expect(childIds).not.toContain(ids.$bNote);
    expect(childIds).toContain(ids.$keeper);

    // Filters: kind, text (no gm_notes search), parent.
    expect(call(db, ctx, 'read_records', readArgs({ kind: 'npc' })).json.records.map((r: { id: string }) => r.id)).toEqual([ids.$keeper]);
    expect(call(db, ctx, 'read_records', readArgs({ text: 'GMONLY' })).json.records).toEqual([]);
    expect(call(db, ctx, 'read_records', readArgs({ text: 'PRIVATE' })).json.records.map((r: { id: string }) => r.id)).toEqual([ids.$aNote]);
    const kids = call(db, ctx, 'read_records', readArgs({ parent_id: ids.$tavern })).json.records.map((r: { id: string }) => r.id);
    expect(kids).not.toContain(ids.$spy);
    expect(kids).not.toContain(ids.$bNote);

    // Bob sees his note and not Alice's.
    const bobCtx = { ...ctx, actorUserId: BOB };
    const bobRes = call(db, bobCtx, 'read_records', readArgs({ kind: 'note' }));
    expect(bobRes.json.records.map((r: { id: string }) => r.id)).toEqual([ids.$bNote]);
  });

  it('GM view sees its own campaign secrets', () => {
    const { db, c, ids } = world();
    const t = newTurn(db, c.id);
    const res = call(db, makeCtx(c.id, t.id), 'read_records', readArgs({ ids: [ids.$spy, ids.$keeper] }));
    expect(res.json.records).toHaveLength(2);
    expect(res.output).toContain('GMONLY-smuggler');
    expect(call(db, makeCtx(c.id, t.id), 'read_records', readArgs({ text: 'GMONLY-trapdoor' })).json.records).toHaveLength(1);
  });
});

describe('search_reference', () => {
  it('returns only approved sources; player view only public ones; never other campaigns', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const other = newCampaign(db);
    const approved = insertSource(db, c.id, { status: 'approved', text: 'Grappling: make a contested athletics check.', section: 'Combat', page: 12 });
    const pending = insertSource(db, c.id, { status: 'pending', text: 'Grappling pending draft text.' });
    insertSource(db, c.id, { status: 'replaced', text: 'Grappling old edition text.' });
    insertSource(db, c.id, { status: 'rejected', text: 'Grappling rejected text.' });
    const gmAdv = insertSource(db, c.id, { status: 'approved', visibility: 'gm', role: 'adventure', text: 'Grappling the hidden villain reveals his identity.' });
    insertSource(db, other.id, { status: 'approved', text: 'Grappling in another campaign.' });

    const t = newTurn(db, c.id);
    const gm = call(db, makeCtx(c.id, t.id), 'search_reference', searchArgs('grappling'));
    expect(gm.json.results.map((r: { source_id: string }) => r.source_id).sort()).toEqual([`src_${approved}`, `src_${gmAdv}`].sort());
    const first = gm.json.results.find((r: { source_id: string }) => r.source_id === `src_${approved}`);
    expect(first.section).toBe('Combat');
    expect(first.pages).toBe('12');

    const player = call(db, makeCtx(c.id, t.id, { view: 'player', saveMode: 'none', allowDice: false }), 'search_reference', searchArgs('grappling'));
    expect(player.json.results.map((r: { source_id: string }) => r.source_id)).toEqual([`src_${approved}`]);
    expect(player.output).not.toContain('villain');

    const review = call(db, makeCtx(c.id, t.id, { includePendingSources: true }), 'search_reference', searchArgs('grappling'));
    expect(review.json.results.map((r: { source_id: string }) => r.source_id)).toContain(`src_${pending}`);
    expect(review.output).not.toContain('old edition');
    expect(review.output).not.toContain('another campaign');

    const role = call(db, makeCtx(c.id, t.id), 'search_reference', searchArgs('grappling', { role: 'adventure' }));
    expect(role.json.results.map((r: { source_id: string }) => r.source_id)).toEqual([`src_${gmAdv}`]);

    const none = call(db, makeCtx(c.id, t.id), 'search_reference', searchArgs('dragonbreath'));
    expect(none.json.ok).toBe(true);
    expect(none.json.results).toEqual([]);
    expect(none.json.note).toMatch(/No matching reference/);
  });

  it('treats FTS syntax in the query as plain words', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    insertSource(db, c.id, { status: 'approved', text: 'Stealth rules apply in darkness.' });
    const t = newTurn(db, c.id);
    const res = call(db, makeCtx(c.id, t.id), 'search_reference', searchArgs('stealth" OR NEAR(* "; DROP TABLE sources; --'));
    expect(res.json.ok).toBe(true);
    expect(res.json.results).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n).toBe(1);
  });
});

describe('save_turn', () => {
  it('commits atomically, increments the revision once, and allows only one commit per turn', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const { $pc } = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: { current: 10, max: 10 } })]);
    const t = newTurn(db, c.id);
    const ctx = makeCtx(c.id, t.id);
    const ops = [op({ op: 'add', record_id: $pc!, path: 'data.hp.current', delta: -3 }), createOp('$gem', 'item', 'Gem', { quantity: 1 }, { parent_id: $pc! })];
    const res = call(db, ctx, 'save_turn', saveArgs({ operations: ops, public_reply: 'Ouch. You find a gem.' }));
    expect(res.json.ok).toBe(true);
    expect(res.saved?.kind).toBe('committed');
    expect(res.json.committed_revision).toBe(1);
    expect(getCampaign(db, c.id)!.revision).toBe(1);
    expect((data(db, $pc!).hp as { current: number }).current).toBe(7);
    const turn = getTurn(db, t.id)!;
    expect(turn.status).toBe('committed');
    expect(turn.public_reply).toBe('Ouch. You find a gem.');
    expect(turn.committed_revision).toBe(1);
    expect(JSON.parse(turn.before_images_json!).images[$pc!].data_json).toContain('"current":10');

    const again = call(db, ctx, 'save_turn', saveArgs({ expected_revision: 1, operations: [op({ op: 'add', record_id: $pc!, path: 'data.hp.current', delta: -3 })] }));
    expect(again.json.ok).toBe(false);
    expect(again.json.error).toMatch(/only one commit/);
    expect(getCampaign(db, c.id)!.revision).toBe(1);
    expect((data(db, $pc!).hp as { current: number }).current).toBe(7);
  });

  it('a replayed request ID returns the same turn and cannot apply changes twice', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const { $pc } = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { gold: 10 })]);
    const t = newTurn(db, c.id, { requestId: 'discord-interaction-123' });
    const args = saveArgs({ operations: [op({ op: 'add', record_id: $pc!, path: 'data.gold', delta: -4 })] });
    expect(call(db, makeCtx(c.id, t.id), 'save_turn', args).json.ok).toBe(true);
    const replay = insertTurn(db, { campaign_id: c.id, request_id: 'discord-interaction-123', actor_user_id: ALICE, mode: 'play', status: 'running' });
    expect(replay.created).toBe(false);
    expect(replay.turn.id).toBe(t.id);
    expect(replay.turn.status).toBe('committed');
    // Even a retried save against the fresh revision on the same turn is refused.
    expect(call(db, makeCtx(c.id, replay.turn.id), 'save_turn', saveArgs({ expected_revision: 1, operations: [op({ op: 'add', record_id: $pc!, path: 'data.gold', delta: -4 })] })).json.ok).toBe(false);
    expect(data(db, $pc!).gold).toBe(6);
  });

  it('play turns in parallel storylines are checked per record, not by campaign revision', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const { $door, $lamp } = seed(db, c.id, [createOp('$door', 'item', 'Door', { open: false }), createOp('$lamp', 'item', 'Lamp', { lit: false })]);
    // Two storylines plan at the same time; the first commits and bumps the campaign revision.
    const t1 = newTurn(db, c.id);
    const t2 = newTurn(db, c.id);
    const setOpen = (v: boolean) => op({ op: 'set', record_id: $door!, path: 'data.open', value_json: JSON.stringify(v), expected_version: 1 });
    expect(call(db, makeCtx(c.id, t1.id), 'save_turn', saveArgs({ operations: [setOpen(true)] })).json.ok).toBe(true);
    // A different record still commits even though its plan predates the revision bump.
    const lamp = op({ op: 'set', record_id: $lamp!, path: 'data.lit', value_json: 'true', expected_version: 1 });
    expect(call(db, makeCtx(c.id, t2.id), 'save_turn', saveArgs({ operations: [lamp] })).json.ok).toBe(true);
    // The same record with an old expected_version is refused and nothing is applied.
    const t3 = newTurn(db, c.id);
    const before = snapshot(db, c.id);
    const stale = call(db, makeCtx(c.id, t3.id), 'save_turn', saveArgs({ operations: [setOpen(false)] }));
    expect(stale.json.ok).toBe(false);
    expect(stale.json.error).toMatch(/version 2, not expected_version 1/);
    expect(snapshot(db, c.id)).toEqual(before);
    // A record the GM saw at an old version and then wrote without expectations is refused too.
    const t4 = newTurn(db, c.id);
    const ctx = { ...makeCtx(c.id, t4.id), seen: new Map([[$door!, 1]]) };
    const delta = call(db, ctx, 'save_turn', saveArgs({ operations: [op({ op: 'archive', record_id: $door! })] }));
    expect(delta.json.error).toMatch(/changed in another storyline/);
    expect(data(db, $door!).open).toBe(true);
    expect(getTurn(db, t4.id)!.status).toBe('running');
    // Non-play writes (e.g. owner corrections) keep the strict campaign revision check.
    const t5 = newTurn(db, c.id);
    const strict = call(db, { ...makeCtx(c.id, t5.id), mode: 'correction' as const }, 'save_turn', saveArgs({ operations: [] }));
    expect(strict.json.error).toMatch(/stale plan/);
  });

  it('rejects unknown roll_ids and source_refs', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const other = newCampaign(db);
    const good = insertSource(db, c.id, { status: 'approved', text: 'Rules text' });
    const rejected = insertSource(db, c.id, { status: 'rejected', text: 'Rejected text' });
    const foreign = insertSource(db, other.id, { status: 'approved', text: 'Other text' });
    const t = newTurn(db, c.id);
    const ctx = makeCtx(c.id, t.id);
    expect(call(db, ctx, 'save_turn', saveArgs({ roll_ids: ['never_rolled'] })).json.error).toMatch(/roll_ids not rolled/);
    for (const ref of [`src_${foreign}`, `src_${rejected}`, 'src_99999', 'PHB p.12']) {
      expect(call(db, ctx, 'save_turn', saveArgs({ source_refs: [ref] })).json.error).toMatch(/source_refs/);
    }
    expect(getCampaign(db, c.id)!.revision).toBe(0);
    // Rolled in this turn + a real source: accepted.
    const roll = call(db, ctx, 'roll_dice', JSON.stringify({ check_id: 'c1', purpose: 'p', expression: '1d20', modifier: null, target: null, comparison: null, related_ids: [], visibility: 'public' }));
    expect(roll.json.ok).toBe(true);
    // A roll from a different turn does not count.
    const t2 = newTurn(db, c.id);
    expect(call(db, makeCtx(c.id, t2.id), 'save_turn', saveArgs({ roll_ids: ['c1'] })).json.ok).toBe(false);
    expect(call(db, ctx, 'save_turn', saveArgs({ roll_ids: ['c1'], source_refs: [`src_${good}`] })).json.ok).toBe(true);
  });

  it('rejects play commits when the campaign is not active', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    db.prepare(`UPDATE campaigns SET status = 'paused' WHERE id = ?`).run(c.id);
    const t = newTurn(db, c.id);
    const res = call(db, makeCtx(c.id, t.id), 'save_turn', saveArgs());
    expect(res.json.error).toMatch(/paused/);
    expect(getCampaign(db, c.id)!.revision).toBe(0);
  });

  it('rejects malformed arguments, an empty reply and unknown tools', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const t = newTurn(db, c.id);
    const ctx = makeCtx(c.id, t.id);
    expect(call(db, ctx, 'save_turn', '{not json').json.ok).toBe(false);
    expect(call(db, ctx, 'save_turn', saveArgs({ public_reply: '   ' })).json.error).toMatch(/public_reply/);
    expect(call(db, ctx, 'save_turn', saveArgs({ campaign_id: 'cmp_other' })).json.ok).toBe(true); // unknown keys are stripped, never used
    expect(call(db, makeCtx(c.id, newTurn(db, c.id).id), 'run_sql', '{}').json.error).toMatch(/unknown tool/);
  });

  it('draft mode stores a proposal without changing the world', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const before = snapshot(db, c.id);
    const t = newTurn(db, c.id, { mode: 'gm', actor: c.owner_user_id });
    const res = call(db, makeCtx(c.id, t.id, { mode: 'gm', saveMode: 'draft', allowDice: false }), 'save_turn', saveArgs({ operations: [createOp('$x', 'npc', 'New NPC')] }));
    expect(res.json.ok).toBe(true);
    expect(res.saved?.kind).toBe('draft');
    expect(snapshot(db, c.id)).toEqual(before);
    expect(getTurn(db, t.id)!.status).toBe('running');
    expect(JSON.parse(getTurn(db, t.id)!.changes_json!).operations).toHaveLength(1);
  });
});

describe('read-only modes', () => {
  it('cannot save or roll, and the world is unchanged', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const { $pc } = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { gold: 5 })]);
    const t = newTurn(db, c.id, { mode: 'ask' });
    const ctx = makeCtx(c.id, t.id, { mode: 'ask', view: 'player', saveMode: 'none', allowDice: false });
    expect(availableTools(ctx).map((x) => x.name)).toEqual(['read_records', 'search_reference']);
    const before = snapshot(db, c.id);
    const save = call(db, ctx, 'save_turn', saveArgs({ operations: [op({ op: 'add', record_id: $pc!, path: 'data.gold', delta: 1000 })] }));
    expect(save.json.ok).toBe(false);
    expect(save.json.error).toMatch(/read-only/);
    const roll = call(db, ctx, 'roll_dice', JSON.stringify({ check_id: 'c', purpose: 'p', expression: '1d20', modifier: null, target: null, comparison: null, related_ids: [], visibility: 'public' }));
    expect(roll.json.error).toMatch(/not available/);
    expect(snapshot(db, c.id)).toEqual(before);
    const turn = getTurn(db, t.id)!;
    expect(turn.rolls_json).toBe('[]');
    expect(turn.status).toBe('running');
    expect(turn.changes_json).toBeNull();
  });

  it('full tool set in play mode', () => {
    expect(availableTools(makeCtx('c', 1)).map((x) => x.name)).toEqual(['read_records', 'search_reference', 'roll_dice', 'save_turn']);
  });
});

describe('identity, roles, budgets and config are out of reach', () => {
  it('no save_turn batch can change members or campaign configuration', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const { $pc } = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: 3 })], { actor: ALICE, characterOwnerUserId: ALICE });
    addMember(db, c.id, ALICE, $pc!);
    const membersBefore = db.prepare('SELECT * FROM members WHERE campaign_id = ? ORDER BY discord_user_id').all(c.id);
    const campaignBefore = getCampaign(db, c.id)!;
    const ownerBefore = rec(db, $pc!)!.private_owner_user_id;

    const t = newTurn(db, c.id, { actor: BOB });
    const ctx = makeCtx(c.id, t.id, { actorUserId: BOB });
    const forbiddenPaths = ['owner_user_id', 'role', 'config_json', 'budget.monthly_usd', 'status', 'revision', 'private_owner_user_id', 'campaign_id', 'members.role'];
    for (const path of forbiddenPaths) {
      const r = call(db, ctx, 'save_turn', saveArgs({ operations: [op({ op: 'set', record_id: $pc!, path, value_json: `"${BOB}"`, expected_version: 1 })] }));
      expect(r.json.ok, path).toBe(false);
    }
    // Paths that merely look like identity fields are ordinary data and change nothing else.
    const res = call(
      db,
      ctx,
      'save_turn',
      saveArgs({
        operations: [
          op({ op: 'set', record_id: $pc!, path: 'data.owner_user_id', value_json: `"${BOB}"`, expected_version: 1 }),
          op({ op: 'set', record_id: $pc!, path: 'data.role', value_json: '"owner"', expected_version: 1 }),
          op({ op: 'set', record_id: $pc!, path: 'data.budget', value_json: '{"monthly_usd":1000000}', expected_version: 1 }),
          op({ op: 'set', record_id: $pc!, path: 'visibility', value_json: '"owner"', expected_version: 1 }),
          createOp('$m', 'member', 'Fake membership', { discord_user_id: BOB, character_record_id: $pc!, role: 'owner' }),
          createOp('$cfg', 'campaign', 'Fake config', { owner_user_id: BOB, status: 'archived', active_source_version: 99 }),
        ],
        public_reply: 'Nice try.',
      }),
    );
    expect(res.json.ok).toBe(true);
    expect(db.prepare('SELECT * FROM members WHERE campaign_id = ? ORDER BY discord_user_id').all(c.id)).toEqual(membersBefore);
    const after = getCampaign(db, c.id)!;
    expect({ ...after, revision: 0, updated_at: '' }).toEqual({ ...campaignBefore, revision: 0, updated_at: '' });
    expect(after.revision).toBe(campaignBefore.revision + 1);
    expect(rec(db, $pc!)!.private_owner_user_id).toBe(ownerBefore);
    expect(rec(db, $pc!)!.private_owner_user_id).toBe(ALICE);
  });
});
