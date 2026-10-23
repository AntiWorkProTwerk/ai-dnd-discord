import { afterAll, describe, expect, it } from 'vitest';
import { getCampaign, type Db } from '../src/database.js';
import { planBatch, writeBatch, type RawOperation } from '../src/records.js';
import { commitTurn } from '../src/tools.js';
import type { Constraint } from '../src/types.js';
import { ValidationError } from '../src/validation.js';
import { ALICE, BOB, OWNER, cleanupTempDirs, createOp, data, makeCtx, newCampaign, newTurn, op, rec, seed, snapshot, tempDb } from './helpers.js';

afterAll(cleanupTempDirs);

function setup(constraints: Constraint[] = []) {
  const { db } = tempDb();
  const c = newCampaign(db, { constraints });
  return { db, c };
}

/** Commits a batch through the real save path, returning created IDs; throws on validation. */
function commit(db: Db, campaignId: string, ops: RawOperation[], opts: { actor?: string; constraints?: Constraint[] } = {}) {
  const t = newTurn(db, campaignId, { actor: opts.actor ?? ALICE });
  const rev = getCampaign(db, campaignId)!.revision;
  return commitTurn(
    db,
    makeCtx(campaignId, t.id),
    { expected_revision: rev, operations: ops as never, public_reply: 'ok', gm_note: '', source_refs: [], roll_ids: [] },
    { campaignId, actorUserId: opts.actor ?? ALICE, constraints: opts.constraints ?? [] },
  );
}

describe('create', () => {
  it('resolves $refs in any order, including forward references', () => {
    const { db, c } = setup();
    const created = seed(db, c.id, [
      createOp('$sword', 'item', 'Sword', { quantity: 1 }, { parent_id: '$hero' }),
      createOp('$hero', 'character', 'Hero', { hp: { current: 10, max: 10 }, home_id: '$town' }, { parent_id: '$town' }),
      createOp('$town', 'location', 'Town'),
    ]);
    expect(Object.keys(created).sort()).toEqual(['$hero', '$sword', '$town']);
    const sword = rec(db, created.$sword!)!;
    const hero = rec(db, created.$hero!)!;
    expect(sword.parent_id).toBe(created.$hero);
    expect(hero.parent_id).toBe(created.$town);
    expect(data(db, hero.id).home_id).toBe(created.$town);
    expect(sword.campaign_id).toBe(c.id);
    expect(sword.version).toBe(1);
    // Server-assigned IDs, never the ref text.
    expect(sword.id).toMatch(/^item_[a-z0-9]{8}$/);
  });

  it('rejects an unknown $ref and duplicate refs', () => {
    const { db, c } = setup();
    expect(() => seed(db, c.id, [createOp('$a', 'item', 'A', {}, { parent_id: '$missing' })])).toThrow(/not a ref created/);
    expect(() => seed(db, c.id, [createOp('$a', 'item', 'A'), createOp('$a', 'item', 'B')])).toThrow(/used twice/);
    expect(() => seed(db, c.id, [createOp('a', 'item', 'A')])).toThrow(/ref must look like/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 });
  });

  it('rejects reserved kinds, bad kinds and non-object data', () => {
    const { db, c } = setup();
    expect(() => seed(db, c.id, [createOp('$a', '_recap', 'x')])).toThrow(ValidationError);
    expect(() => seed(db, c.id, [createOp('$a', 'Item; DROP TABLE', 'x')])).toThrow(/kind/);
    expect(() => seed(db, c.id, [op({ op: 'create', ref: '$a', kind: 'item', name: 'x', data_json: '[1,2]' })])).toThrow(/JSON object/);
    expect(() => seed(db, c.id, [op({ op: 'create', ref: '$a', kind: 'item', name: 'x', data_json: '{"__proto__":{}}' })])).toThrow(/invalid object key/);
  });
});

describe('set / remove', () => {
  it('requires expected_version or expected_json on existing records', () => {
    const { db, c } = setup();
    const { $npc } = seed(db, c.id, [createOp('$npc', 'npc', 'Guard', { attitude: 'suspicious' })]);
    expect(() => commit(db, c.id, [op({ op: 'set', record_id: $npc!, path: 'data.attitude', value_json: '"friendly"' })])).toThrow(/needs expected_version/);
    expect(() =>
      commit(db, c.id, [op({ op: 'set', record_id: $npc!, path: 'data.attitude', value_json: '"friendly"', expected_version: 7 })]),
    ).toThrow(/not expected_version 7/);
    expect(() =>
      commit(db, c.id, [op({ op: 'set', record_id: $npc!, path: 'data.attitude', value_json: '"friendly"', expected_json: '"hostile"' })]),
    ).toThrow(/not the expected/);
    expect(data(db, $npc!).attitude).toBe('suspicious');

    commit(db, c.id, [op({ op: 'set', record_id: $npc!, path: 'data.attitude', value_json: '"friendly"', expected_version: 1 })]);
    expect(data(db, $npc!).attitude).toBe('friendly');
    expect(rec(db, $npc!)!.version).toBe(2);

    commit(db, c.id, [op({ op: 'set', record_id: $npc!, path: 'data.mood', value_json: '"calm"', expected_json: 'null' })]);
    expect(data(db, $npc!).mood).toBe('calm');

    commit(db, c.id, [op({ op: 'remove', record_id: $npc!, path: 'data.mood', expected_json: '"calm"' })]);
    expect(data(db, $npc!)).not.toHaveProperty('mood');
  });

  it('remove of an absent field fails', () => {
    const { db, c } = setup();
    const { $npc } = seed(db, c.id, [createOp('$npc', 'npc', 'Guard', {})]);
    expect(() => commit(db, c.id, [op({ op: 'remove', record_id: $npc!, path: 'data.nothing', expected_version: 1 })])).toThrow(/not present/);
  });

  it('rejects writes to non-data roots such as owner, campaign or id fields', () => {
    const { db, c } = setup();
    const { $pc } = seed(db, c.id, [createOp('$pc', 'character', 'Mira', {})], { characterOwnerUserId: ALICE });
    for (const path of ['private_owner_user_id', 'campaign_id', 'owner_user_id', 'id', 'kind', 'version', 'data.__proto__.x']) {
      expect(() => commit(db, c.id, [op({ op: 'set', record_id: $pc!, path, value_json: `"${BOB}"`, expected_version: 1 })])).toThrow(ValidationError);
    }
    expect(rec(db, $pc!)!.private_owner_user_id).toBe(ALICE);
  });
});

describe('add', () => {
  it('performs delta arithmetic in code', () => {
    const { db, c } = setup();
    const { $pc } = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: { current: 12, max: 12 }, gold: 0.2 })]);
    commit(db, c.id, [op({ op: 'add', record_id: $pc!, path: 'data.hp.current', delta: -5 })]);
    expect(data(db, $pc!).hp).toEqual({ current: 7, max: 12 });
    commit(db, c.id, [op({ op: 'add', record_id: $pc!, path: 'data.gold', delta: 0.1 })]);
    expect(data(db, $pc!).gold).toBe(0.3);
    // Two adds in one batch accumulate.
    commit(db, c.id, [
      op({ op: 'add', record_id: $pc!, path: 'data.hp.current', delta: -2 }),
      op({ op: 'add', record_id: $pc!, path: 'data.hp.current', delta: -3 }),
    ]);
    expect((data(db, $pc!).hp as { current: number }).current).toBe(2);
  });

  it('fails on absent or non-numeric fields and checks expected_json', () => {
    const { db, c } = setup();
    const { $pc } = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: { current: 12 }, name2: 'x' })]);
    expect(() => commit(db, c.id, [op({ op: 'add', record_id: $pc!, path: 'data.mp', delta: 1 })])).toThrow(/absent/);
    expect(() => commit(db, c.id, [op({ op: 'add', record_id: $pc!, path: 'data.name2', delta: 1 })])).toThrow(/not a number/);
    expect(() => commit(db, c.id, [op({ op: 'add', record_id: $pc!, path: 'data.hp.current', delta: -1, expected_json: '10' })])).toThrow(/not the expected/);
    expect(() => commit(db, c.id, [op({ op: 'add', record_id: $pc!, path: 'name', delta: 1 })])).toThrow(ValidationError);
    expect(data(db, $pc!).hp).toEqual({ current: 12 });
  });

  it('rejects results that are not finite', () => {
    const { db, c } = setup();
    const { $x } = seed(db, c.id, [createOp('$x', 'item', 'Big', { n: 1.7e308 })]);
    expect(() => commit(db, c.id, [op({ op: 'add', record_id: $x!, path: 'data.n', delta: 1.7e308 })])).toThrow(/finite/);
  });
});

describe('move and containment', () => {
  it('moves a record and derives inventory from parent', () => {
    const { db, c } = setup();
    const ids = seed(db, c.id, [createOp('$a', 'character', 'A'), createOp('$b', 'character', 'B'), createOp('$gem', 'item', 'Gem', {}, { parent_id: '$a' })]);
    commit(db, c.id, [op({ op: 'move', record_id: ids.$gem!, parent_id: ids.$b! })]);
    expect(rec(db, ids.$gem!)!.parent_id).toBe(ids.$b);
  });

  it('rejects parent cycles (direct and indirect) and self-containment', () => {
    const { db, c } = setup();
    const ids = seed(db, c.id, [
      createOp('$house', 'building', 'House'),
      createOp('$room', 'location', 'Room', {}, { parent_id: '$house' }),
      createOp('$chest', 'item', 'Chest', {}, { parent_id: '$room' }),
    ]);
    const before = snapshot(db, c.id);
    expect(() => commit(db, c.id, [op({ op: 'move', record_id: ids.$house!, parent_id: ids.$chest! })])).toThrow(/cycle/);
    expect(() => commit(db, c.id, [op({ op: 'move', record_id: ids.$house!, parent_id: ids.$room! })])).toThrow(/cycle/);
    expect(() => commit(db, c.id, [op({ op: 'move', record_id: ids.$house!, parent_id: ids.$house! })])).toThrow(/contain itself/);
    // A cycle among records created in the same batch.
    expect(() =>
      seed(db, c.id, [createOp('$x', 'item', 'X', {}, { parent_id: '$y' }), createOp('$y', 'item', 'Y', {}, { parent_id: '$x' })]),
    ).toThrow(/cycle/);
    expect(snapshot(db, c.id)).toEqual(before);
  });

  it('rejects a dangling parent', () => {
    const { db, c } = setup();
    const { $a } = seed(db, c.id, [createOp('$a', 'item', 'A')]);
    expect(() => seed(db, c.id, [createOp('$b', 'item', 'B', {}, { parent_id: 'location_zzzzzzzz' })])).toThrow(/does not exist/);
    expect(() => commit(db, c.id, [op({ op: 'move', record_id: $a!, parent_id: 'nowhere' })])).toThrow(/does not exist/);
  });

  it('rejects dangling *_id / *_ids references in data', () => {
    const { db, c } = setup();
    const { $loc } = seed(db, c.id, [createOp('$loc', 'location', 'Gate')]);
    expect(() => seed(db, c.id, [createOp('$q', 'quest', 'Q', { giver_id: 'npc_abcdefgh' })])).toThrow(/does not exist/);
    expect(() => seed(db, c.id, [createOp('$s', 'scene', 'S', { participants_ids: [$loc, 'character_abcdefgh'] })])).toThrow(/does not exist/);
    expect(() => seed(db, c.id, [createOp('$s', 'scene', 'S', { turn_of_id: '$nobody' })])).toThrow(/unknown batch ref/);
    // Valid references are fine.
    const ok = seed(db, c.id, [createOp('$s', 'scene', 'S', { location_id: $loc, participants_ids: [$loc] })]);
    expect(data(db, ok.$s!).location_id).toBe($loc);
  });

  it('archiving a container with live children is rejected', () => {
    const { db, c } = setup();
    const ids = seed(db, c.id, [createOp('$bag', 'item', 'Bag'), createOp('$coin', 'item', 'Coin', {}, { parent_id: '$bag' })]);
    expect(() => commit(db, c.id, [op({ op: 'archive', record_id: ids.$bag! })])).toThrow(/still contains/);
    expect(rec(db, ids.$bag!)!.archived_at).toBeNull();
    // Moving the child out first in the same batch is fine.
    commit(db, c.id, [op({ op: 'move', record_id: ids.$coin!, parent_id: null }), op({ op: 'archive', record_id: ids.$bag! })]);
    expect(rec(db, ids.$bag!)!.archived_at).not.toBeNull();
    // Archived records cannot be edited or used as a new parent.
    expect(() => commit(db, c.id, [op({ op: 'move', record_id: ids.$coin!, parent_id: ids.$bag! })])).toThrow(/archived/);
    expect(() => commit(db, c.id, [op({ op: 'add', record_id: ids.$bag!, path: 'data.x', delta: 1 })])).toThrow(/archived/);
  });
});

describe('atomicity', () => {
  it('a failed batch applies NOTHING, including the campaign revision and the turn', () => {
    const { db, c } = setup([{ kind: 'item', path: 'quantity', rule: 'min', value: 0 }]);
    const ids = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: { current: 10, max: 10 } }), createOp('$potion', 'item', 'Potion', { quantity: 1 }, { parent_id: '$pc' })]);
    const before = snapshot(db, c.id);
    const t = newTurn(db, c.id);
    const ops = [
      op({ op: 'add', record_id: ids.$pc!, path: 'data.hp.current', delta: 5 }), // valid
      createOp('$new', 'item', 'Loot', { quantity: 3 }, { parent_id: ids.$pc! }), // valid
      op({ op: 'move', record_id: ids.$potion!, parent_id: null }), // valid
      op({ op: 'add', record_id: ids.$potion!, path: 'data.quantity', delta: -2 }), // violates min 0
    ];
    expect(() =>
      commitTurn(
        db,
        makeCtx(c.id, t.id),
        { expected_revision: 0, operations: ops as never, public_reply: 'You drink.', gm_note: '', source_refs: [], roll_ids: [] },
        { campaignId: c.id, actorUserId: ALICE, constraints: [{ kind: 'item', path: 'quantity', rule: 'min', value: 0 }] },
      ),
    ).toThrow(/constraint violated/);
    expect(snapshot(db, c.id)).toEqual(before);
    expect(getCampaign(db, c.id)!.revision).toBe(0);
    const turn = db.prepare('SELECT status, changes_json, public_reply FROM turns WHERE id = ?').get(t.id);
    expect(turn).toEqual({ status: 'running', changes_json: null, public_reply: null });
  });

  it('a failure raised during writeBatch inside the transaction rolls back earlier writes', () => {
    const { db, c } = setup();
    const ids = seed(db, c.id, [createOp('$a', 'item', 'A', { n: 1 }), createOp('$b', 'item', 'B', { n: 1 })]);
    const before = snapshot(db, c.id);
    const plan = planBatch(
      db,
      [op({ op: 'add', record_id: ids.$a!, path: 'data.n', delta: 1 }), op({ op: 'add', record_id: ids.$b!, path: 'data.n', delta: 1 })],
      { campaignId: c.id, actorUserId: ALICE, constraints: [] },
    );
    // A concurrent writer bumps B after planning: optimistic version check must fail and roll back A too.
    db.prepare('UPDATE records SET version = version + 1 WHERE id = ?').run(ids.$b);
    const bumped = snapshot(db, c.id);
    expect(() => db.transaction(() => writeBatch(db, c.id, plan))()).toThrow(/changed concurrently/);
    expect(snapshot(db, c.id)).toEqual(bumped);
    expect(data(db, ids.$a!).n).toBe(1);
    void before;
  });

  it('constraint violations fail rather than clamp', () => {
    const cs: Constraint[] = [
      { kind: 'character', path: 'hp.current', rule: 'lte_field', value: 'hp.max' },
      { kind: 'item', path: 'quantity', rule: 'integer' },
    ];
    const { db, c } = setup(cs);
    const ids = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: { current: 10, max: 12 } }), createOp('$arrows', 'item', 'Arrows', { quantity: 20 })]);
    expect(() => commit(db, c.id, [op({ op: 'add', record_id: ids.$pc!, path: 'data.hp.current', delta: 5 })], { constraints: cs })).toThrow(/exceeds/);
    expect((data(db, ids.$pc!).hp as { current: number }).current).toBe(10);
    expect(() => commit(db, c.id, [op({ op: 'add', record_id: ids.$arrows!, path: 'data.quantity', delta: -0.5 })], { constraints: cs })).toThrow(/integer/);
    expect(data(db, ids.$arrows!).quantity).toBe(20);
    expect(() => seed(db, c.id, [createOp('$x', 'item', 'X', { quantity: 1.5 })], { constraints: cs })).toThrow(/integer/);
  });

  it('rejects more than the maximum number of operations', () => {
    const { db, c } = setup();
    const ops = Array.from({ length: 41 }, (_, i) => createOp(`$i${i}`, 'item', `I${i}`));
    expect(() => seed(db, c.id, ops)).toThrow(/at most/);
  });
});

describe('ownership', () => {
  it('owner visibility is derived from the actor or owned ancestor, never chosen by the model', () => {
    const { db, c } = setup();
    // A model trying to set an owner via data is just data; the column is server-derived.
    const ids = seed(
      db,
      c.id,
      [createOp('$pc', 'character', 'Mira', { owner_user_id: BOB, private_owner_user_id: BOB }), createOp('$note', 'note', 'Secret map', {}, { visibility: 'owner' })],
      { actor: ALICE, characterOwnerUserId: ALICE },
    );
    expect(rec(db, ids.$pc!)!.private_owner_user_id).toBe(ALICE);
    expect(rec(db, ids.$note!)!.private_owner_user_id).toBe(ALICE);

    // An owner-visibility item placed inside Alice's character belongs to Alice even when Bob acts.
    const more = seed(db, c.id, [createOp('$diary', 'item', 'Diary', {}, { visibility: 'owner', parent_id: ids.$pc! })], { actor: BOB });
    expect(rec(db, more.$diary!)!.private_owner_user_id).toBe(ALICE);

    // Otherwise it belongs to the acting user.
    const bobs = seed(db, c.id, [createOp('$letter', 'item', 'Letter', {}, { visibility: 'owner' })], { actor: BOB });
    expect(rec(db, bobs.$letter!)!.private_owner_user_id).toBe(BOB);
  });

  it('characterOwnerUserId binds only created character records', () => {
    const { db, c } = setup();
    const ids = seed(db, c.id, [createOp('$pc', 'character', 'Mira'), createOp('$sword', 'item', 'Sword', {}, { parent_id: '$pc' })], {
      actor: OWNER,
      characterOwnerUserId: ALICE,
    });
    expect(rec(db, ids.$pc!)!.private_owner_user_id).toBe(ALICE);
    expect(rec(db, ids.$sword!)!.private_owner_user_id).toBeNull();
    // Without the option, a created character has no owner binding.
    const npcish = seed(db, c.id, [createOp('$pc2', 'character', 'Other')]);
    expect(rec(db, npcish.$pc2!)!.private_owner_user_id).toBeNull();
  });
});
