import { afterAll, describe, expect, it } from 'vitest';
import { getTurn, openDatabase } from '../src/database.js';
import { DICE_LIMITS, parseDice, rollForTurn, rollParsed, type RandomInt, type RollRecord, type RollRequest } from '../src/dice.js';
import { runTool } from '../src/tools.js';
import { ValidationError } from '../src/validation.js';
import { cleanupTempDirs, makeCtx, newCampaign, newTurn, tempDb } from './helpers.js';

afterAll(cleanupTempDirs);

/** Deterministic RandomInt that returns queued values (validated against the range). */
function scripted(values: number[]): RandomInt & { calls: number } {
  const fn = ((min: number, max: number) => {
    fn.calls++;
    const v = values.shift();
    if (v === undefined) throw new Error('scripted random exhausted');
    if (v < min || v >= max) throw new Error(`scripted value ${v} outside [${min}, ${max})`);
    return v;
  }) as RandomInt & { calls: number };
  fn.calls = 0;
  return fn;
}

const req = (over: Partial<RollRequest> = {}): RollRequest => ({
  check_id: 'mira_attack_1',
  purpose: 'Mira attacks the guard',
  expression: '1d20+5',
  modifier: null,
  target: 15,
  comparison: '>=',
  related_ids: [],
  visibility: 'public',
  ...over,
});

describe('parseDice', () => {
  it('parses NdM with modifiers', () => {
    expect(parseDice('1d20+5')).toEqual({ terms: [{ sign: 1, count: 1, sides: 20 }], constant: 5 });
    expect(parseDice('d6')).toEqual({ terms: [{ sign: 1, count: 1, sides: 6 }], constant: 0 });
    expect(parseDice('2d6 + 1d4 - 2')).toEqual({
      terms: [
        { sign: 1, count: 2, sides: 6 },
        { sign: 1, count: 1, sides: 4 },
      ],
      constant: -2,
    });
    expect(parseDice('3 + 1d8')).toEqual({ terms: [{ sign: 1, count: 1, sides: 8 }], constant: 3 });
  });

  it('parses keep/drop options', () => {
    expect(parseDice('2d20kh1+3').terms[0]).toEqual({ sign: 1, count: 2, sides: 20, keep: { mode: 'kh', n: 1 } });
    expect(parseDice('2d20kl1').terms[0]!.keep).toEqual({ mode: 'kl', n: 1 });
    expect(parseDice('4d6dl1').terms[0]!.keep).toEqual({ mode: 'dl', n: 1 });
    expect(parseDice('4d6DH1').terms[0]!.keep).toEqual({ mode: 'dh', n: 1 });
  });

  it.each([
    '1d20;process.exit()',
    'process.exit()',
    '1d20+eval("1")',
    'require("fs")',
    '1d20*2',
    '(1d20)',
    '1d20 1d6',
    '1d20++2',
    '',
    '5',
    '2d20kh3',
    '2d20kx1',
    '1d1',
    '0d6',
    `${DICE_LIMITS.maxCount + 1}d6`,
    `1d${DICE_LIMITS.maxSides + 1}`,
    '1d6+'.repeat(11) + '1d6',
    '1d20+' + '9'.repeat(100),
    '1d20+99999',
  ])('rejects %j', (expr) => {
    expect(() => parseDice(expr)).toThrow(ValidationError);
  });

  it('rejects too many terms', () => {
    expect(() => parseDice(Array(DICE_LIMITS.maxTerms + 1).fill('1d4').join('+'))).toThrow(/at most/);
  });
});

describe('rollParsed with injected randomness', () => {
  it('sums dice and constant', () => {
    const r = rollParsed(parseDice('2d6+1d4-2'), scripted([3, 5, 4]));
    expect(r.total).toBe(3 + 5 + 4 - 2);
    expect(r.details.map((d) => d.rolls)).toEqual([[3, 5], [4]]);
  });

  it('keeps highest / lowest and drops', () => {
    expect(rollParsed(parseDice('2d20kh1'), scripted([4, 17])).total).toBe(17);
    expect(rollParsed(parseDice('2d20kl1'), scripted([4, 17])).total).toBe(4);
    expect(rollParsed(parseDice('4d6dl1'), scripted([1, 6, 3, 5])).total).toBe(14);
    expect(rollParsed(parseDice('4d6dh1'), scripted([1, 6, 3, 5])).total).toBe(9);
    const d = rollParsed(parseDice('2d20kh1'), scripted([4, 17])).details[0]!;
    expect(d.rolls).toEqual([4, 17]);
    expect(d.kept).toEqual([17]);
  });

  it('subtracts negative terms', () => {
    expect(rollParsed(parseDice('1d10-1d4'), scripted([7, 3])).total).toBe(4);
  });

  it('requests values in [1, sides+1)', () => {
    const seen: [number, number][] = [];
    rollParsed(parseDice('1d20+1d6'), (min, max) => {
      seen.push([min, max]);
      return min;
    });
    expect(seen).toEqual([
      [1, 21],
      [1, 7],
    ]);
  });
});

describe('rollForTurn ledger', () => {
  it('persists the roll before returning it, and computes success', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const t = newTurn(db, c.id);
    const r = rollForTurn(db, t.id, req({ modifier: 2 }), scripted([10]));
    expect(r.total).toBe(10 + 5 + 2);
    expect(r.success).toBe(true);
    const stored = JSON.parse(getTurn(db, t.id)!.rolls_json) as RollRecord[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.check_id).toBe('mira_attack_1');
    expect(stored[0]!.total).toBe(17);
    db.close();
  });

  it('a repeated check_id returns the saved result without rolling again', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const t = newTurn(db, c.id);
    const first = rollForTurn(db, t.id, req(), scripted([3]));
    const rng = scripted([20]);
    const again = rollForTurn(db, t.id, req({ expression: ' 1D20 + 5 ', purpose: 'retry' }), rng);
    expect(rng.calls).toBe(0);
    expect(again.total).toBe(first.total);
    expect(again.success).toBe(false);
    expect(again.reused).toBe(true);
    expect(JSON.parse(getTurn(db, t.id)!.rolls_json)).toHaveLength(1);
    db.close();
  });

  it('reusing a check_id with different parameters is an error', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const t = newTurn(db, c.id);
    rollForTurn(db, t.id, req(), scripted([3]));
    expect(() => rollForTurn(db, t.id, req({ expression: '2d20kh1+5' }), scripted([20, 20]))).toThrow(/already declared/);
    expect(() => rollForTurn(db, t.id, req({ target: 10 }), scripted([20]))).toThrow(/already declared/);
    expect(() => rollForTurn(db, t.id, req({ modifier: 3 }), scripted([20]))).toThrow(/already declared/);
    expect(() => rollForTurn(db, t.id, req({ comparison: '>' }), scripted([20]))).toThrow(/already declared/);
    const stored = JSON.parse(getTurn(db, t.id)!.rolls_json) as RollRecord[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.total).toBe(8);
    db.close();
  });

  it('check IDs are per turn', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const t1 = newTurn(db, c.id);
    const t2 = newTurn(db, c.id);
    expect(rollForTurn(db, t1.id, req(), scripted([3])).total).toBe(8);
    expect(rollForTurn(db, t2.id, req(), scripted([12])).total).toBe(17);
    db.close();
  });

  it('rejects invalid declarations before rolling', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const t = newTurn(db, c.id);
    const rng = scripted([]);
    expect(() => rollForTurn(db, t.id, req({ check_id: 'bad id; drop' }), rng)).toThrow(ValidationError);
    expect(() => rollForTurn(db, t.id, req({ expression: '1d20;process.exit()' }), rng)).toThrow(ValidationError);
    expect(() => rollForTurn(db, t.id, req({ modifier: 1.5 }), rng)).toThrow(ValidationError);
    expect(() => rollForTurn(db, t.id, req({ target: Infinity }), rng)).toThrow(ValidationError);
    expect(rng.calls).toBe(0);
    expect(getTurn(db, t.id)!.rolls_json).toBe('[]');
    db.close();
  });

  it('the saved result survives a restart (reopening the database file)', () => {
    const { db, file } = tempDb();
    const c = newCampaign(db);
    const t = newTurn(db, c.id);
    const first = rollForTurn(db, t.id, req(), scripted([2]));
    db.close();

    const reopened = openDatabase(file);
    const rng = scripted([19]);
    const again = rollForTurn(reopened, t.id, req(), rng);
    expect(rng.calls).toBe(0);
    expect(again.total).toBe(first.total);
    expect(again.details).toEqual(first.details);
    expect(again.reused).toBe(true);
    // And via the tool interface, with server randomness: still the saved result.
    const out = JSON.parse(
      runTool(
        { db: reopened, ctx: makeCtx(c.id, t.id) },
        'roll_dice',
        JSON.stringify({ check_id: req().check_id, purpose: 'x', expression: '1d20+5', modifier: null, target: 15, comparison: '>=', related_ids: [], visibility: 'public' }),
      ).output,
    );
    expect(out.ok).toBe(true);
    expect(out.total).toBe(first.total);
    expect(out.reused_saved_result).toBe(true);
    reopened.close();
  });

  it('roll_dice tool rejects eval-like expressions without persisting', () => {
    const { db } = tempDb();
    const c = newCampaign(db);
    const t = newTurn(db, c.id);
    const out = JSON.parse(
      runTool(
        { db, ctx: makeCtx(c.id, t.id) },
        'roll_dice',
        JSON.stringify({ check_id: 'x', purpose: 'x', expression: '1d20;process.exit()', modifier: null, target: null, comparison: null, related_ids: [], visibility: 'public' }),
      ).output,
    );
    expect(out.ok).toBe(false);
    expect(getTurn(db, t.id)!.rolls_json).toBe('[]');
    db.close();
  });
});
