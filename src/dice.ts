// Bounded dice parser and the per-turn roll ledger. No eval: the grammar is
//   expr := term (('+'|'-') term)*
//   term := [N]dM [kh K | kl K | dh K | dl K] | integer
// Randomness comes from the server's CSPRNG. A declared check is persisted before its result
// is returned, and a repeated check ID returns the saved result instead of rolling again.
import crypto from 'node:crypto';
import { getTurn, nowIso, type Db } from './database.js';
import { ValidationError } from './validation.js';

export const DICE_LIMITS = { maxTerms: 10, maxCount: 100, maxSides: 1000, maxExpressionChars: 80, maxChecksPerTurn: 30 };

export interface DiceTerm {
  sign: 1 | -1;
  count: number;
  sides: number;
  keep?: { mode: 'kh' | 'kl' | 'dh' | 'dl'; n: number };
}

export interface ParsedDice {
  terms: DiceTerm[];
  constant: number;
}

export function parseDice(expression: string): ParsedDice {
  const src = expression.replace(/\s+/g, '').toLowerCase();
  if (!src) throw new ValidationError('dice expression is empty');
  if (src.length > DICE_LIMITS.maxExpressionChars) throw new ValidationError('dice expression too long');
  const re = /([+-]?)(?:(\d*)d(\d+)(?:(kh|kl|dh|dl)(\d+))?|(\d+))/y;
  const terms: DiceTerm[] = [];
  let constant = 0;
  let pos = 0;
  let first = true;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m[0] === '' || (!first && !m[1])) throw new ValidationError(`cannot parse dice expression "${expression}" near "${src.slice(pos, pos + 10)}"`);
    const sign: 1 | -1 = m[1] === '-' ? -1 : 1;
    if (m[6] !== undefined) {
      constant += sign * Number(m[6]);
      if (Math.abs(constant) > 10000) throw new ValidationError('modifier too large');
    } else {
      const count = m[2] ? Number(m[2]) : 1;
      const sides = Number(m[3]);
      if (count < 1 || count > DICE_LIMITS.maxCount) throw new ValidationError(`dice count must be 1-${DICE_LIMITS.maxCount}`);
      if (sides < 2 || sides > DICE_LIMITS.maxSides) throw new ValidationError(`dice sides must be 2-${DICE_LIMITS.maxSides}`);
      const term: DiceTerm = { sign, count, sides };
      if (m[4]) {
        const n = Number(m[5]);
        if (n < 1 || n > count) throw new ValidationError(`${m[4]}${n} must keep/drop between 1 and ${count} dice`);
        term.keep = { mode: m[4] as 'kh' | 'kl' | 'dh' | 'dl', n };
      }
      terms.push(term);
      if (terms.length > DICE_LIMITS.maxTerms) throw new ValidationError(`at most ${DICE_LIMITS.maxTerms} dice terms`);
    }
    pos = re.lastIndex;
    first = false;
  }
  if (terms.length === 0) throw new ValidationError('dice expression must contain at least one die, e.g. 1d20+3');
  return { terms, constant };
}

export type RandomInt = (minInclusive: number, maxExclusive: number) => number;
const defaultRandom: RandomInt = (min, max) => crypto.randomInt(min, max);

export interface RollDetail {
  dice: string;
  rolls: number[];
  kept: number[];
  subtotal: number;
}

export function rollParsed(p: ParsedDice, random: RandomInt = defaultRandom): { total: number; details: RollDetail[] } {
  let total = p.constant;
  const details: RollDetail[] = [];
  for (const t of p.terms) {
    const rolls = Array.from({ length: t.count }, () => random(1, t.sides + 1));
    let kept = rolls;
    if (t.keep) {
      const sorted = [...rolls].sort((a, b) => a - b);
      const n = t.keep.n;
      if (t.keep.mode === 'kh') kept = sorted.slice(-n);
      else if (t.keep.mode === 'kl') kept = sorted.slice(0, n);
      else if (t.keep.mode === 'dh') kept = sorted.slice(0, sorted.length - n);
      else kept = sorted.slice(n);
    }
    const subtotal = kept.reduce((a, b) => a + b, 0) * t.sign;
    total += subtotal;
    const k = t.keep ? `${t.keep.mode}${t.keep.n}` : '';
    details.push({ dice: `${t.sign < 0 ? '-' : ''}${t.count}d${t.sides}${k}`, rolls, kept, subtotal });
  }
  return { total, details };
}

export type Comparison = '>=' | '>' | '<=' | '<' | '==';

export interface RollRequest {
  check_id: string;
  purpose: string;
  expression: string;
  modifier: number | null;
  target: number | null;
  comparison: Comparison | null;
  related_ids: string[];
  visibility: 'public' | 'gm';
}

export interface RollRecord extends RollRequest {
  total: number;
  details: RollDetail[];
  success: boolean | null;
  rolled_at: string;
  /** Set when the result was carried over from an interrupted attempt. */
  reused?: boolean;
}

function sameDeclaration(a: RollRequest, b: RollRequest): boolean {
  return (
    a.expression.replace(/\s+/g, '').toLowerCase() === b.expression.replace(/\s+/g, '').toLowerCase() &&
    (a.modifier ?? 0) === (b.modifier ?? 0) &&
    (a.target ?? null) === (b.target ?? null) &&
    (a.comparison ?? null) === (b.comparison ?? null)
  );
}

export function compare(total: number, comparison: Comparison | null, target: number | null): boolean | null {
  if (comparison === null || target === null) return null;
  switch (comparison) {
    case '>=':
      return total >= target;
    case '>':
      return total > target;
    case '<=':
      return total <= target;
    case '<':
      return total < target;
    case '==':
      return total === target;
  }
}

/**
 * Declares and rolls a check for a turn. The result is written to turns.rolls_json in the same
 * synchronous step, before it is returned to the model.
 */
export function rollForTurn(db: Db, turnId: number, req: RollRequest, random: RandomInt = defaultRandom): RollRecord {
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(req.check_id)) throw new ValidationError('check_id must be 1-64 letters, digits, _ . : -');
  if (req.modifier !== null && (!Number.isInteger(req.modifier) || Math.abs(req.modifier) > 10000)) {
    throw new ValidationError('modifier must be an integer');
  }
  if (req.target !== null && !Number.isFinite(req.target)) throw new ValidationError('target must be a finite number');
  const parsed = parseDice(req.expression);

  return db.transaction((): RollRecord => {
    const turn = getTurn(db, turnId);
    if (!turn) throw new ValidationError('turn not found');
    const rolls = JSON.parse(turn.rolls_json) as RollRecord[];
    const existing = rolls.find((r) => r.check_id === req.check_id);
    if (existing) {
      if (!sameDeclaration(existing, req)) {
        throw new ValidationError(
          `check_id ${req.check_id} was already declared as ${existing.expression}${existing.modifier ? ` ${existing.modifier >= 0 ? '+' : ''}${existing.modifier}` : ''}` +
            `${existing.comparison ? ` ${existing.comparison} ${existing.target}` : ''}; reuse it unchanged or declare a new check`,
        );
      }
      return { ...existing, reused: true };
    }
    if (rolls.length >= DICE_LIMITS.maxChecksPerTurn) throw new ValidationError('too many checks in one turn');
    const { total: diceTotal, details } = rollParsed(parsed, random);
    const total = diceTotal + (req.modifier ?? 0);
    const record: RollRecord = {
      ...req,
      purpose: req.purpose.slice(0, 200),
      related_ids: req.related_ids.slice(0, 10),
      total,
      details,
      success: compare(total, req.comparison, req.target),
      rolled_at: nowIso(),
    };
    rolls.push(record);
    db.prepare('UPDATE turns SET rolls_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(rolls), nowIso(), turnId);
    return record;
  })();
}

export function formatRoll(r: RollRecord): string {
  const dice = r.details.map((d) => (d.kept.length === d.rolls.length ? `[${d.rolls.join(', ')}]` : `[${d.rolls.join(', ')} → kept ${d.kept.join(', ')}]`)).join(' ');
  const mod = r.modifier ? ` ${r.modifier >= 0 ? '+' : '-'} ${Math.abs(r.modifier)}` : '';
  const vs = r.comparison && r.target !== null ? ` vs ${r.comparison} ${r.target} → ${r.success ? 'success' : 'failure'}` : '';
  return `🎲 ${r.purpose}: ${r.expression}${mod} ${dice} = **${r.total}**${vs}`;
}
