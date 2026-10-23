import { afterAll, describe, expect, it } from 'vitest';
import { applyUndo, describeUndo, findUndoTarget, WorkflowError } from '../src/campaign.js';
import { getCampaign, getTurn, type Db } from '../src/database.js';
import type { RawOperation } from '../src/records.js';
import { commitTurn } from '../src/tools.js';
import type { TurnRow } from '../src/types.js';
import { ALICE, cleanupTempDirs, createOp, data, makeCtx, newCampaign, newTurn, OWNER, op, rec, seed, snapshot, tempDb } from './helpers.js';

afterAll(cleanupTempDirs);

function play(db: Db, campaignId: string, ops: RawOperation[], opts: { mode?: TurnRow['mode']; input?: string } = {}): TurnRow {
  const mode = opts.mode ?? 'play';
  const t = newTurn(db, campaignId, { mode, input: opts.input ?? 'I act.' });
  commitTurn(
    db,
    makeCtx(campaignId, t.id, { mode }),
    { expected_revision: getCampaign(db, campaignId)!.revision, operations: ops as never, public_reply: 'Done.', gm_note: '', source_refs: [], roll_ids: [] },
    { campaignId, actorUserId: ALICE, constraints: [] },
  );
  return getTurn(db, t.id)!;
}

function undoTurn(db: Db, campaignId: string): TurnRow {
  return newTurn(db, campaignId, { mode: 'undo', status: 'confirmed', actor: OWNER, input: 'undo' });
}

describe('undo', () => {
  it('restores before-images, removes created records, and keeps the audit trail', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const ids = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: { current: 10, max: 10 }, gold: 5 }), createOp('$room', 'location', 'Room')]);
    const before = snapshot(db, c.id).records;

    const t1 = play(
      db,
      c.id,
      [
        op({ op: 'add', record_id: ids.$pc!, path: 'data.hp.current', delta: -4 }),
        op({ op: 'set', record_id: ids.$pc!, path: 'data.gold', value_json: '0', expected_version: 1 }),
        op({ op: 'move', record_id: ids.$pc!, parent_id: ids.$room! }),
        createOp('$loot', 'item', 'Loot', {}, { parent_id: ids.$pc! }),
      ],
      { input: 'I gamble all my gold' },
    );
    expect(t1.committed_revision).toBe(1);
    expect(data(db, ids.$pc!).gold).toBe(0);
    const lootId = (JSON.parse(t1.changes_json!) as { created: Record<string, string> }).created.$loot!;
    expect(rec(db, lootId)).toBeDefined();

    const target = findUndoTarget(db, c.id)!;
    expect(target.id).toBe(t1.id);
    const description = describeUndo(db, target);
    expect(description).toContain(`Undo turn ${t1.id}`);
    expect(description).toContain('I gamble all my gold');
    expect(description).toMatch(/gold/);

    const u = undoTurn(db, c.id);
    const res = applyUndo(db, u, target.id);
    expect(res.revision).toBe(2);
    expect(res.restored.sort()).toEqual([ids.$pc!, lootId].sort());

    // World content is back to the pre-turn state (versions keep increasing).
    const after = snapshot(db, c.id).records as Record<string, unknown>[];
    const strip = (rows: Record<string, unknown>[]) => rows.map(({ version: _v, updated_at: _u, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before as Record<string, unknown>[]));
    expect(rec(db, lootId)).toBeUndefined();
    expect(rec(db, ids.$pc!)!.version).toBe(3);
    expect(getCampaign(db, c.id)!.revision).toBe(2);

    // Audit trail: original turn retained and linked, undo turn committed with its own event.
    const orig = getTurn(db, t1.id)!;
    expect(orig.status).toBe('committed');
    expect(orig.reverted_by_turn_id).toBe(u.id);
    expect(orig.public_reply).toBe('Done.');
    expect(orig.changes_json).toBe(t1.changes_json);
    const undo = getTurn(db, u.id)!;
    expect(undo.status).toBe('committed');
    expect(undo.committed_revision).toBe(2);
    expect(JSON.parse(undo.changes_json!)).toEqual({ undone_turn_id: t1.id, restored_ids: res.restored });

    // The reverted turn is no longer an undo target, and undoing it again fails.
    expect(findUndoTarget(db, c.id)).toBeUndefined();
    expect(() => applyUndo(db, undoTurn(db, c.id), t1.id)).toThrow(WorkflowError);
  });

  it('keeps dice in the original turn log', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const ids = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: 10 })]);
    const t = newTurn(db, c.id);
    db.prepare('UPDATE turns SET rolls_json = ? WHERE id = ?').run(JSON.stringify([{ check_id: 'atk', total: 3 }]), t.id);
    commitTurn(
      db,
      makeCtx(c.id, t.id),
      { expected_revision: 0, operations: [op({ op: 'add', record_id: ids.$pc!, path: 'data.hp', delta: -2 })] as never, public_reply: 'Hit.', gm_note: '', source_refs: [], roll_ids: ['atk'] },
      { campaignId: c.id, actorUserId: ALICE, constraints: [] },
    );
    applyUndo(db, undoTurn(db, c.id), t.id);
    expect(JSON.parse(getTurn(db, t.id)!.rolls_json)).toEqual([{ check_id: 'atk', total: 3 }]);
    expect(data(db, ids.$pc!).hp).toBe(10);
  });

  it('refuses when a later non-undoable turn changed the same record (no overwrite)', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const ids = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: 10 })]);
    const t1 = play(db, c.id, [op({ op: 'add', record_id: ids.$pc!, path: 'data.hp', delta: -3 })]);
    // An owner instruction (mode gm) later changes the same record; it is not itself an undo target.
    play(db, c.id, [op({ op: 'add', record_id: ids.$pc!, path: 'data.hp', delta: 1 })], { mode: 'gm' });
    expect(findUndoTarget(db, c.id)!.id).toBe(t1.id);
    const before = snapshot(db, c.id);

    const u = undoTurn(db, c.id);
    expect(() => applyUndo(db, u, t1.id)).toThrow(/overwrite later changes/);
    expect(snapshot(db, c.id)).toEqual(before);
    expect(data(db, ids.$pc!).hp).toBe(8);
    expect(getTurn(db, t1.id)!.reverted_by_turn_id).toBeNull();
    // The refused undo is recorded in a terminal state, not left claimable.
    const refused = getTurn(db, u.id)!;
    expect(refused.status).toBe('aborted');
    expect(refused.error).toMatch(/overwrite later changes/);
  });

  it('after undoing the latest turn, an earlier turn on the same record cannot be undone over it', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const ids = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: 10 })]);
    const t1 = play(db, c.id, [op({ op: 'add', record_id: ids.$pc!, path: 'data.hp', delta: -3 })]);
    const t2 = play(db, c.id, [op({ op: 'add', record_id: ids.$pc!, path: 'data.hp', delta: -2 })]);
    expect(findUndoTarget(db, c.id)!.id).toBe(t2.id);
    // Only the latest reversible turn may be undone.
    expect(() => applyUndo(db, undoTurn(db, c.id), t1.id)).toThrow(/latest reversible/);
    applyUndo(db, undoTurn(db, c.id), t2.id);
    expect(data(db, ids.$pc!).hp).toBe(7);
    expect(findUndoTarget(db, c.id)!.id).toBe(t1.id);
    expect(() => applyUndo(db, undoTurn(db, c.id), t1.id)).toThrow(/overwrite later changes/);
    expect(data(db, ids.$pc!).hp).toBe(7);
  });

  it('refuses when a record created by the turn has since gained contents', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const t1 = play(db, c.id, [createOp('$chest', 'item', 'Chest')]);
    const chest = (JSON.parse(t1.changes_json!) as { created: Record<string, string> }).created.$chest!;
    seed(db, c.id, [createOp('$coin', 'item', 'Coin', {}, { parent_id: chest })]);
    expect(() => applyUndo(db, undoTurn(db, c.id), t1.id)).toThrow(/overwrite later changes/);
    expect(rec(db, chest)).toBeDefined();
  });
});
