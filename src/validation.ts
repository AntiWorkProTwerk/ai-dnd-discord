// Data invariants that hold for every campaign: safe JSON values, safe field paths, finite
// numbers, bounded sizes, and the owner-approved declarative constraints. Nothing here encodes a
// gameplay rule; complex rules stay in the campaign's text.
import type { Constraint } from './types.js';

export const LIMITS = {
  maxOperations: 40,
  maxValueJsonChars: 8000,
  maxRecordJsonChars: 32000,
  maxNameChars: 120,
  maxKindChars: 40,
  maxDepth: 12,
  maxPathSegments: 8,
  maxReplyChars: 3800,
  maxGmNoteChars: 2000,
};

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Rejects non-finite numbers, dangerous keys, control-character keys and excessive depth. */
export function assertSafeJson(value: unknown, where: string, depth = 0): void {
  if (depth > LIMITS.maxDepth) throw new ValidationError(`${where}: value nested deeper than ${LIMITS.maxDepth} levels`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`${where}: numbers must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafeJson(v, `${where}[${i}]`, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k) || k.startsWith('$') || k.length === 0 || k.length > 64 || /[\u0000-\u001f]/.test(k)) {
        throw new ValidationError(`${where}: invalid object key ${JSON.stringify(k.slice(0, 40))}`);
      }
      assertSafeJson(v, `${where}.${k}`, depth + 1);
    }
    return;
  }
  throw new ValidationError(`${where}: unsupported value type ${typeof value}`);
}

/** Parses a model-supplied JSON string with size and safety limits. */
export function parseJsonValue(text: string, where: string, maxChars = LIMITS.maxValueJsonChars): unknown {
  if (text.length > maxChars) throw new ValidationError(`${where}: JSON longer than ${maxChars} characters`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValidationError(`${where}: not valid JSON (strings must be quoted, e.g. "\\"poisoned\\"")`);
  }
  assertSafeJson(value, where);
  return value;
}

export type PathRoot = 'data' | 'gm_notes' | 'name' | 'visibility';

export interface ParsedPath {
  root: PathRoot;
  segments: string[];
}

/** Accepts "data.hp.current", "gm_notes.secret", "name", or "visibility". */
export function parsePath(path: string): ParsedPath {
  if (typeof path !== 'string' || path.length === 0 || path.length > 300) throw new ValidationError('path is required');
  if (path === 'name' || path === 'visibility') return { root: path, segments: [] };
  const parts = path.split('.');
  const root = parts.shift();
  if (root !== 'data' && root !== 'gm_notes') {
    throw new ValidationError(`path "${path}" must start with "data." or "gm_notes." (or be "name"/"visibility")`);
  }
  if (parts.length === 0) throw new ValidationError(`path "${path}" must name a field inside ${root}`);
  if (parts.length > LIMITS.maxPathSegments) throw new ValidationError(`path "${path}" is too deep`);
  for (const p of parts) {
    if (!SEGMENT.test(p) || FORBIDDEN_KEYS.has(p)) throw new ValidationError(`path "${path}" has invalid segment "${p.slice(0, 40)}"`);
  }
  return { root, segments: parts };
}

/** Constraint paths are relative to the record's data, e.g. "hp.current". */
export function parseDataPath(path: string): string[] {
  const clean = path.startsWith('data.') ? path.slice(5) : path;
  return parsePath(`data.${clean}`).segments;
}

export function getAt(obj: unknown, segments: string[]): { found: boolean; value: unknown } {
  let cur: unknown = obj;
  for (const s of segments) {
    if (Array.isArray(cur) && /^\d+$/.test(s)) {
      const i = Number(s);
      if (i >= cur.length) return { found: false, value: undefined };
      cur = cur[i];
    } else if (isPlainObject(cur) && Object.prototype.hasOwnProperty.call(cur, s)) {
      cur = cur[s];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

/** Sets a value, creating intermediate objects. Mutates `obj`. */
export function setAt(obj: Record<string, unknown>, segments: string[], value: unknown): void {
  let cur: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const s = segments[i]!;
    if (Array.isArray(cur) && /^\d+$/.test(s)) {
      const idx = Number(s);
      if (idx >= cur.length) throw new ValidationError(`array index ${idx} out of range`);
      cur = cur[idx];
      continue;
    }
    if (!isPlainObject(cur)) throw new ValidationError(`cannot set "${segments.join('.')}": "${s}" is inside a non-object`);
    if (!isPlainObject(cur[s]) && !Array.isArray(cur[s])) cur[s] = {};
    cur = cur[s];
  }
  const last = segments[segments.length - 1]!;
  if (Array.isArray(cur) && /^\d+$/.test(last)) {
    const idx = Number(last);
    if (idx > cur.length) throw new ValidationError(`array index ${idx} out of range`);
    cur[idx] = value;
    return;
  }
  if (!isPlainObject(cur)) throw new ValidationError(`cannot set "${segments.join('.')}": parent is not an object`);
  cur[last] = value;
}

export function removeAt(obj: Record<string, unknown>, segments: string[]): boolean {
  const parent = getAt(obj, segments.slice(0, -1));
  if (!parent.found) return false;
  const last = segments[segments.length - 1]!;
  if (Array.isArray(parent.value) && /^\d+$/.test(last)) {
    const idx = Number(last);
    if (idx >= parent.value.length) return false;
    parent.value.splice(idx, 1);
    return true;
  }
  if (isPlainObject(parent.value) && Object.prototype.hasOwnProperty.call(parent.value, last)) {
    delete parent.value[last];
    return true;
  }
  return false;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

export function validateKind(kind: string): string {
  const k = kind.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(k) || k.length > LIMITS.maxKindChars) {
    throw new ValidationError(`kind "${kind.slice(0, 40)}" must be lowercase letters, digits and underscores`);
  }
  return k;
}

export function validateName(name: string): string {
  const n = name.replace(/[\u0000-\u001f]/g, ' ').trim();
  if (!n) throw new ValidationError('name must not be empty');
  if (n.length > LIMITS.maxNameChars) throw new ValidationError(`name longer than ${LIMITS.maxNameChars} characters`);
  return n;
}

// ---------------------------------------------------------------- constraints

const CONSTRAINT_RULES = new Set(['required', 'integer', 'number', 'min', 'max', 'enum', 'immutable', 'lte_field', 'gte_field']);

/** Checks the shape of an owner-proposed constraint list before it can be activated. */
export function validateConstraintList(list: unknown): Constraint[] {
  if (!Array.isArray(list)) throw new ValidationError('constraints must be a list');
  if (list.length > 50) throw new ValidationError('at most 50 constraints');
  return list.map((raw, i) => {
    if (!isPlainObject(raw)) throw new ValidationError(`constraint ${i} must be an object`);
    const kind = raw.kind === '*' ? '*' : validateKind(String(raw.kind ?? ''));
    const rule = String(raw.rule ?? '');
    if (!CONSTRAINT_RULES.has(rule)) throw new ValidationError(`constraint ${i}: unknown rule "${rule}"`);
    const path = String(raw.path ?? '');
    parseDataPath(path);
    const value = raw.value ?? null;
    if ((rule === 'min' || rule === 'max') && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new ValidationError(`constraint ${i}: ${rule} needs a numeric value`);
    }
    if (rule === 'enum' && (!Array.isArray(value) || value.length === 0)) {
      throw new ValidationError(`constraint ${i}: enum needs a non-empty list of values`);
    }
    if (rule === 'lte_field' || rule === 'gte_field') {
      if (typeof value !== 'string') throw new ValidationError(`constraint ${i}: ${rule} needs another field path as value`);
      parseDataPath(value);
    }
    return { kind, path, rule: rule as Constraint['rule'], value: value as Constraint['value'] };
  });
}

export function describeConstraint(c: Constraint): string {
  const target = `${c.kind === '*' ? 'any record' : c.kind}.${c.path}`;
  switch (c.rule) {
    case 'required':
      return `${target} is required`;
    case 'integer':
      return `${target} must be an integer`;
    case 'number':
      return `${target} must be a number`;
    case 'min':
      return `${target} must be >= ${c.value}`;
    case 'max':
      return `${target} must be <= ${c.value}`;
    case 'enum':
      return `${target} must be one of ${JSON.stringify(c.value)}`;
    case 'immutable':
      return `${target} cannot change once set`;
    case 'lte_field':
      return `${target} must be <= ${c.kind}.${c.value}`;
    case 'gte_field':
      return `${target} must be >= ${c.kind}.${c.value}`;
  }
}

/**
 * Returns violation messages for one record's data. `before` is the prior data (undefined for
 * a new record), used by immutable rules. Values are never clamped.
 */
export function checkConstraints(
  constraints: Constraint[],
  record: { id: string; kind: string; name: string; data: unknown },
  before: unknown | undefined,
  opts: { skipImmutable?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const c of constraints) {
    if (c.kind !== '*' && c.kind !== record.kind) continue;
    const segs = parseDataPath(c.path);
    const { found, value } = getAt(record.data, segs);
    const label = `${record.name} (${record.id}) data.${c.path}`;
    switch (c.rule) {
      case 'required':
        if (!found || value === null) out.push(`${label} is required`);
        break;
      case 'integer':
        if (found && value !== null && !Number.isInteger(value)) out.push(`${label} must be an integer, got ${JSON.stringify(value)}`);
        break;
      case 'number':
        if (found && value !== null && typeof value !== 'number') out.push(`${label} must be a number, got ${JSON.stringify(value)}`);
        break;
      case 'min':
        if (found && typeof value === 'number' && value < (c.value as number)) out.push(`${label} = ${value} is below the minimum ${c.value}`);
        break;
      case 'max':
        if (found && typeof value === 'number' && value > (c.value as number)) out.push(`${label} = ${value} is above the maximum ${c.value}`);
        break;
      case 'enum':
        if (found && !(c.value as unknown[]).some((v) => deepEqual(v, value))) {
          out.push(`${label} = ${JSON.stringify(value)} is not one of ${JSON.stringify(c.value)}`);
        }
        break;
      case 'immutable':
        if (!opts.skipImmutable && before !== undefined) {
          const prev = getAt(before, segs);
          if (prev.found && (!found || !deepEqual(prev.value, value))) out.push(`${label} is immutable`);
        }
        break;
      case 'lte_field':
      case 'gte_field': {
        const other = getAt(record.data, parseDataPath(String(c.value)));
        if (found && typeof value === 'number' && other.found && typeof other.value === 'number') {
          if (c.rule === 'lte_field' && value > other.value) out.push(`${label} = ${value} exceeds data.${c.value} = ${other.value}`);
          if (c.rule === 'gte_field' && value < other.value) out.push(`${label} = ${value} is below data.${c.value} = ${other.value}`);
        }
        break;
      }
    }
  }
  return out;
}
