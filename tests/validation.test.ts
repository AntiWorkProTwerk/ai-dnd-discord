import { describe, expect, it } from 'vitest';
import type { Constraint } from '../src/types.js';
import {
  assertSafeJson,
  checkConstraints,
  LIMITS,
  parseDataPath,
  parseJsonValue,
  parsePath,
  validateConstraintList,
  ValidationError,
} from '../src/validation.js';

describe('parsePath', () => {
  it('accepts data, gm_notes, name and visibility paths', () => {
    expect(parsePath('data.hp.current')).toEqual({ root: 'data', segments: ['hp', 'current'] });
    expect(parsePath('gm_notes.secret')).toEqual({ root: 'gm_notes', segments: ['secret'] });
    expect(parsePath('name')).toEqual({ root: 'name', segments: [] });
    expect(parsePath('visibility')).toEqual({ root: 'visibility', segments: [] });
    expect(parsePath('data.items.0')).toEqual({ root: 'data', segments: ['items', '0'] });
  });

  it.each([
    'data.__proto__.polluted',
    'data.constructor',
    'gm_notes.prototype.x',
    'data.a..b',
    'data.a b',
    'data.$where',
  ])('rejects dangerous or malformed segment in %s', (p) => {
    expect(() => parsePath(p)).toThrow(ValidationError);
  });

  it.each(['owner_user_id', 'private_owner_user_id', 'campaign_id', 'version', 'kind', 'parent_id', 'id', 'config.budget', 'members.role', 'data', ''])(
    'rejects bad root %j',
    (p) => {
      expect(() => parsePath(p)).toThrow(ValidationError);
    },
  );

  it('rejects overly deep paths', () => {
    const deep = 'data.' + Array.from({ length: LIMITS.maxPathSegments + 1 }, (_, i) => `k${i}`).join('.');
    expect(() => parsePath(deep)).toThrow(/too deep/);
  });

  it('parseDataPath accepts relative and data.-prefixed paths', () => {
    expect(parseDataPath('hp.current')).toEqual(['hp', 'current']);
    expect(parseDataPath('data.hp.max')).toEqual(['hp', 'max']);
    expect(() => parseDataPath('__proto__')).toThrow(ValidationError);
  });
});

describe('parseJsonValue', () => {
  it('parses ordinary values', () => {
    expect(parseJsonValue('12', 'v')).toBe(12);
    expect(parseJsonValue('"prone"', 'v')).toBe('prone');
    expect(parseJsonValue('{"current":5,"max":12}', 'v')).toEqual({ current: 5, max: 12 });
    expect(parseJsonValue('null', 'v')).toBeNull();
  });

  it('rejects non-finite numbers such as 1e400', () => {
    expect(() => parseJsonValue('1e400', 'v')).toThrow(/finite/);
    expect(() => parseJsonValue('{"hp":-1e400}', 'v')).toThrow(/finite/);
    expect(() => parseJsonValue('[1, 2, 1e999]', 'v')).toThrow(/finite/);
  });

  it('rejects invalid JSON (unquoted strings)', () => {
    expect(() => parseJsonValue('poisoned', 'v')).toThrow(/not valid JSON/);
    expect(() => parseJsonValue('NaN', 'v')).toThrow(ValidationError);
  });

  it('rejects excessive depth', () => {
    const deep = '['.repeat(LIMITS.maxDepth + 2) + ']'.repeat(LIMITS.maxDepth + 2);
    expect(() => parseJsonValue(deep, 'v')).toThrow(/nested deeper/);
    const ok = '['.repeat(LIMITS.maxDepth) + ']'.repeat(LIMITS.maxDepth);
    expect(() => parseJsonValue(ok, 'v')).not.toThrow();
  });

  it('rejects dangerous keys at any depth', () => {
    expect(() => parseJsonValue('{"__proto__":{"admin":true}}', 'v')).toThrow(/invalid object key/);
    expect(() => parseJsonValue('{"a":{"constructor":{}}}', 'v')).toThrow(/invalid object key/);
    expect(() => parseJsonValue('{"a":[{"prototype":1}]}', 'v')).toThrow(/invalid object key/);
    expect(() => parseJsonValue('{"$ne":1}', 'v')).toThrow(/invalid object key/);
    expect(() => parseJsonValue('{"":1}', 'v')).toThrow(/invalid object key/);
  });

  it('does not pollute Object.prototype', () => {
    try {
      parseJsonValue('{"__proto__":{"polluted":true}}', 'v');
    } catch {
      /* expected */
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects oversize input', () => {
    expect(() => parseJsonValue(JSON.stringify('x'.repeat(LIMITS.maxValueJsonChars)), 'v')).toThrow(/longer than/);
  });

  it('assertSafeJson rejects non-JSON types', () => {
    expect(() => assertSafeJson(undefined, 'v')).toThrow(ValidationError);
    expect(() => assertSafeJson(() => 1, 'v')).toThrow(ValidationError);
    expect(() => assertSafeJson(Infinity, 'v')).toThrow(ValidationError);
  });
});

describe('constraints', () => {
  const rec = (data: unknown, kind = 'character') => ({ id: 'character_aaaaaaaa', kind, name: 'Mira', data });

  it('min / max report violations and never clamp', () => {
    const cs: Constraint[] = [
      { kind: 'item', path: 'quantity', rule: 'min', value: 0 },
      { kind: 'item', path: 'quantity', rule: 'max', value: 99 },
    ];
    const data = { quantity: -1 };
    expect(checkConstraints(cs, rec(data, 'item'), undefined)).toHaveLength(1);
    expect(data.quantity).toBe(-1); // untouched: no silent clamping
    const big = { quantity: 100 };
    expect(checkConstraints(cs, rec(big, 'item'), undefined)[0]).toMatch(/above the maximum 99/);
    expect(big.quantity).toBe(100);
    expect(checkConstraints(cs, rec({ quantity: 5 }, 'item'), undefined)).toEqual([]);
  });

  it('applies only to the matching kind, or to all kinds with "*"', () => {
    const cs: Constraint[] = [{ kind: 'item', path: 'quantity', rule: 'min', value: 0 }];
    expect(checkConstraints(cs, rec({ quantity: -1 }, 'npc'), undefined)).toEqual([]);
    const all: Constraint[] = [{ kind: '*', path: 'quantity', rule: 'min', value: 0 }];
    expect(checkConstraints(all, rec({ quantity: -1 }, 'npc'), undefined)).toHaveLength(1);
  });

  it('integer', () => {
    const cs: Constraint[] = [{ kind: 'item', path: 'quantity', rule: 'integer' }];
    expect(checkConstraints(cs, rec({ quantity: 1.5 }, 'item'), undefined)[0]).toMatch(/integer/);
    expect(checkConstraints(cs, rec({ quantity: '2' }, 'item'), undefined)[0]).toMatch(/integer/);
    expect(checkConstraints(cs, rec({ quantity: 2 }, 'item'), undefined)).toEqual([]);
  });

  it('enum', () => {
    const cs: Constraint[] = [{ kind: 'quest', path: 'status', rule: 'enum', value: ['open', 'completed', 'failed'] }];
    expect(checkConstraints(cs, rec({ status: 'won' }, 'quest'), undefined)[0]).toMatch(/not one of/);
    expect(checkConstraints(cs, rec({ status: 'open' }, 'quest'), undefined)).toEqual([]);
  });

  it('required', () => {
    const cs: Constraint[] = [{ kind: 'character', path: 'hp.max', rule: 'required' }];
    expect(checkConstraints(cs, rec({ hp: {} }), undefined)[0]).toMatch(/required/);
    expect(checkConstraints(cs, rec({ hp: { max: null } }), undefined)[0]).toMatch(/required/);
    expect(checkConstraints(cs, rec({ hp: { max: 3 } }), undefined)).toEqual([]);
  });

  it('lte_field compares against another field', () => {
    const cs: Constraint[] = [{ kind: 'character', path: 'hp.current', rule: 'lte_field', value: 'hp.max' }];
    expect(checkConstraints(cs, rec({ hp: { current: 13, max: 12 } }), undefined)[0]).toMatch(/exceeds data.hp.max/);
    expect(checkConstraints(cs, rec({ hp: { current: 12, max: 12 } }), undefined)).toEqual([]);
    // Negative HP is allowed unless a min constraint says otherwise.
    expect(checkConstraints(cs, rec({ hp: { current: -5, max: 12 } }), undefined)).toEqual([]);
  });

  it('immutable compares with the prior data', () => {
    const cs: Constraint[] = [{ kind: 'character', path: 'species', rule: 'immutable' }];
    expect(checkConstraints(cs, rec({ species: 'elf' }), { species: 'human' })[0]).toMatch(/immutable/);
    expect(checkConstraints(cs, rec({}), { species: 'human' })[0]).toMatch(/immutable/);
    expect(checkConstraints(cs, rec({ species: 'human' }), { species: 'human' })).toEqual([]);
    // New record, or field first set: allowed.
    expect(checkConstraints(cs, rec({ species: 'elf' }), undefined)).toEqual([]);
    expect(checkConstraints(cs, rec({ species: 'elf' }), {})).toEqual([]);
    // Owner corrections may skip immutability.
    expect(checkConstraints(cs, rec({ species: 'elf' }), { species: 'human' }, { skipImmutable: true })).toEqual([]);
  });

  it('validateConstraintList checks shapes', () => {
    expect(validateConstraintList([{ kind: 'item', path: 'quantity', rule: 'min', value: 0 }])).toHaveLength(1);
    expect(() => validateConstraintList([{ kind: 'item', path: 'quantity', rule: 'min', value: 'zero' }])).toThrow(ValidationError);
    expect(() => validateConstraintList([{ kind: 'item', path: 'quantity', rule: 'eval', value: 'process.exit()' }])).toThrow(/unknown rule/);
    expect(() => validateConstraintList([{ kind: 'item', path: '__proto__', rule: 'required' }])).toThrow(ValidationError);
    expect(() => validateConstraintList([{ kind: 'quest', path: 'status', rule: 'enum', value: [] }])).toThrow(/enum/);
    expect(() => validateConstraintList([{ kind: 'character', path: 'hp.current', rule: 'lte_field', value: 5 }])).toThrow(/field path/);
    expect(() => validateConstraintList('nope')).toThrow(ValidationError);
  });
});
