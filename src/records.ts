// The one transactional write path for world records. Operations are data operations (create,
// set, remove, add, move, archive), never RPG actions. A batch is planned against a candidate
// copy of the affected records and either applied completely or not at all.
import { playerCharacterOwners, getRecord, newRecordId, nowIso, type Db } from './database.js';
import { mapProblems, type MapSceneState } from './maps.js';
import type { Constraint, RecordRow, Visibility } from './types.js';
import {
  assertSafeJson,
  checkConstraints,
  deepEqual,
  getAt,
  isPlainObject,
  LIMITS,
  parseJsonValue,
  parsePath,
  removeAt,
  setAt,
  validateKind,
  validateName,
  ValidationError,
} from './validation.js';

/** Operation as the model sends it: one flat object, unused fields null. */
export interface RawOperation {
  op: 'create' | 'set' | 'remove' | 'add' | 'move' | 'archive';
  ref?: string | null;
  record_id?: string | null;
  kind?: string | null;
  name?: string | null;
  parent_id?: string | null;
  visibility?: Visibility | null;
  path?: string | null;
  value_json?: string | null;
  data_json?: string | null;
  gm_notes_json?: string | null;
  expected_json?: string | null;
  expected_version?: number | null;
  delta?: number | null;
}

export interface RecordState {
  id: string;
  kind: string;
  name: string;
  parent_id: string | null;
  visibility: Visibility;
  private_owner_user_id: string | null;
  data: Record<string, unknown>;
  gm_notes: Record<string, unknown>;
  archived_at: string | null;
  version: number;
}

export interface Diff {
  record_id: string;
  name: string;
  kind: string;
  field: string;
  before: unknown;
  after: unknown;
  /** True when the change concerns gm_notes or a record players may not see. */
  hidden: boolean;
}

export interface BatchOptions {
  campaignId: string;
  actorUserId: string;
  constraints: Constraint[];
  /** Application-owned kinds start with "_" and are not writable by the model. */
  allowReservedKinds?: boolean;
  /** Owner corrections may change fields marked immutable. */
  skipImmutable?: boolean;
  /** Character confirmation: the created record of kind "character" belongs to this Discord user. */
  characterOwnerUserId?: string;
}

export interface PlannedBatch {
  created: Record<string, string>;
  createdOrder: string[];
  before: Map<string, RecordRow | null>;
  after: Map<string, RecordState>;
  diffs: Diff[];
  operations: unknown[];
}

const ID_FIELD = /(^id$|_id$|_ids$)/;
const ID_SHAPE = /^[a-z0-9_]{1,16}_[a-km-np-z2-9]{8}$/;

export function toState(row: RecordRow): RecordState {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    parent_id: row.parent_id,
    visibility: row.visibility,
    private_owner_user_id: row.private_owner_user_id,
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    gm_notes: JSON.parse(row.gm_notes_json) as Record<string, unknown>,
    archived_at: row.archived_at,
    version: row.version,
  };
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * Plans a batch against current state without writing. Throws ValidationError listing every
 * problem found; the caller decides whether to commit.
 */
export function planBatch(db: Db, rawOps: RawOperation[], opts: BatchOptions): PlannedBatch {
  if (!Array.isArray(rawOps)) throw new ValidationError('operations must be a list');
  if (rawOps.length > LIMITS.maxOperations) throw new ValidationError(`at most ${LIMITS.maxOperations} operations per turn`);

  const errors: string[] = [];
  const before = new Map<string, RecordRow | null>();
  const after = new Map<string, RecordState>();
  const created: Record<string, string> = {};
  const createdOrder: string[] = [];
  const diffs: Diff[] = [];
  const normalized: unknown[] = [];
  const failedRefs = new Set<string>();

  // Pass 1: assign IDs to every temporary reference so operations may refer to them in any order.
  rawOps.forEach((op, i) => {
    if (op?.op !== 'create') return;
    const ref = op.ref ?? '';
    if (!/^\$[A-Za-z0-9_-]{1,40}$/.test(ref)) {
      errors.push(`operation ${i} (create): ref must look like "$new_item" (got ${JSON.stringify(ref).slice(0, 40)})`);
      return;
    }
    if (created[ref]) {
      errors.push(`operation ${i} (create): ref ${ref} used twice`);
      return;
    }
    let kind = 'record';
    try {
      kind = validateKind(op.kind ?? '');
    } catch {
      /* reported in pass 2 */
    }
    created[ref] = newRecordId(kind);
  });

  const resolveId = (value: string | null | undefined, field: string, i: number): string | null => {
    if (value === null || value === undefined || value === '') return null;
    if (value.startsWith('$')) {
      const id = created[value];
      if (!id) throw new ValidationError(`${field} ${value} is not a ref created in this batch`);
      if (failedRefs.has(value)) throw new ValidationError(`${field} ${value} refers to a create that failed`);
      return id;
    }
    void i;
    return value;
  };

  const load = (id: string): RecordState => {
    const cur = after.get(id);
    if (cur) return cur;
    const row = getRecord(db, opts.campaignId, id);
    if (!row) throw new ValidationError(`record ${id} does not exist in this campaign`);
    if (row.kind.startsWith('_') && !opts.allowReservedKinds) throw new ValidationError(`record ${id} is application-owned`);
    before.set(id, row);
    const state = toState(row);
    after.set(id, state);
    return state;
  };

  const substituteRefs = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('$') && created[v]) return created[v];
    if (Array.isArray(v)) return v.map(substituteRefs);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteRefs(x)]));
    return v;
  };

  const checkExpected = (op: RawOperation, state: RecordState, segs: { root: string; segments: string[] } | null) => {
    if (op.expected_version !== null && op.expected_version !== undefined) {
      const orig = before.get(state.id);
      const baseVersion = orig ? orig.version : state.version;
      if (op.expected_version !== baseVersion) {
        throw new ValidationError(
          `${state.id} is at version ${baseVersion}, not expected_version ${op.expected_version}; re-read it before changing it`,
        );
      }
    }
    if (op.expected_json !== null && op.expected_json !== undefined && segs) {
      const expected = parseJsonValue(op.expected_json, 'expected_json');
      const cur = currentValue(state, segs);
      const matches = expected === null ? !cur.found || cur.value === null : cur.found && deepEqual(cur.value, expected);
      if (!matches) {
        throw new ValidationError(
          `${state.id} ${op.path} is ${cur.found ? JSON.stringify(cur.value)?.slice(0, 200) : 'absent'}, not the expected ${op.expected_json.slice(0, 200)}`,
        );
      }
    }
  };

  // Pass 2: apply each operation to the candidate state.
  rawOps.forEach((op, i) => {
    const label = `operation ${i} (${op?.op ?? '?'}${op?.record_id ? ` ${op.record_id}` : op?.ref ? ` ${op.ref}` : ''})`;
    try {
      if (!op || typeof op !== 'object') throw new ValidationError('operation must be an object');
      switch (op.op) {
        case 'create': {
          const id = created[op.ref ?? ''];
          if (!id) throw new ValidationError('invalid ref');
          const kind = validateKind(op.kind ?? '');
          if (kind.startsWith('_') && !opts.allowReservedKinds) throw new ValidationError('kinds starting with "_" are reserved');
          const name = validateName(op.name ?? '');
          const data = op.data_json ? parseJsonValue(op.data_json, 'data_json', LIMITS.maxRecordJsonChars) : {};
          const gmNotes = op.gm_notes_json ? parseJsonValue(op.gm_notes_json, 'gm_notes_json', LIMITS.maxRecordJsonChars) : {};
          if (!isPlainObject(data)) throw new ValidationError('data_json must be a JSON object');
          if (!isPlainObject(gmNotes)) throw new ValidationError('gm_notes_json must be a JSON object');
          const visibility = (op.visibility ?? 'public') as Visibility;
          if (!['public', 'owner', 'gm'].includes(visibility)) throw new ValidationError('visibility must be public, owner or gm');
          const parentId = resolveId(op.parent_id, 'parent_id', i);
          const state: RecordState = {
            id,
            kind,
            name,
            parent_id: parentId,
            visibility,
            private_owner_user_id: null,
            data: substituteRefs(data) as Record<string, unknown>,
            gm_notes: substituteRefs(gmNotes) as Record<string, unknown>,
            archived_at: null,
            version: 1,
          };
          before.set(id, null);
          after.set(id, state);
          createdOrder.push(id);
          diffs.push({ record_id: id, name, kind, field: 'created', before: null, after: { parent_id: parentId, data: state.data }, hidden: visibility !== 'public' });
          normalized.push({ op: 'create', ref: op.ref, id, kind, name, parent_id: parentId, visibility });
          break;
        }
        case 'set':
        case 'remove': {
          const id = resolveId(op.record_id, 'record_id', i);
          if (!id) throw new ValidationError('record_id is required');
          const state = load(id);
          if (state.archived_at) throw new ValidationError(`${id} is archived`);
          const p = parsePath(op.path ?? '');
          const existing = before.get(id);
          if (existing && (op.expected_version === null || op.expected_version === undefined) && (op.expected_json === null || op.expected_json === undefined)) {
            throw new ValidationError(`${op.op} on an existing record needs expected_version (from read_records) or expected_json`);
          }
          checkExpected(op, state, p);
          const prior = currentValue(state, p);
          if (op.op === 'remove') {
            if (p.root === 'name' || p.root === 'visibility') throw new ValidationError(`cannot remove ${p.root}`);
            const target = p.root === 'data' ? state.data : state.gm_notes;
            if (!removeAt(target, p.segments)) throw new ValidationError(`${op.path} is not present`);
            diffs.push({ record_id: id, name: state.name, kind: state.kind, field: op.path!, before: prior.value, after: undefined, hidden: p.root === 'gm_notes' || state.visibility !== 'public' });
            normalized.push({ op: 'remove', record_id: id, path: op.path });
            break;
          }
          if (op.value_json === null || op.value_json === undefined) throw new ValidationError('set needs value_json');
          const value = substituteRefs(parseJsonValue(op.value_json, 'value_json'));
          if (p.root === 'name') {
            if (typeof value !== 'string') throw new ValidationError('name must be a string');
            state.name = validateName(value);
          } else if (p.root === 'visibility') {
            if (value !== 'public' && value !== 'owner' && value !== 'gm') throw new ValidationError('visibility must be public, owner or gm');
            state.visibility = value;
          } else {
            setAt(p.root === 'data' ? state.data : state.gm_notes, p.segments, value);
          }
          diffs.push({ record_id: id, name: state.name, kind: state.kind, field: op.path!, before: prior.value, after: value, hidden: p.root === 'gm_notes' || state.visibility !== 'public' });
          normalized.push({ op: 'set', record_id: id, path: op.path, value });
          break;
        }
        case 'add': {
          const id = resolveId(op.record_id, 'record_id', i);
          if (!id) throw new ValidationError('record_id is required');
          const state = load(id);
          if (state.archived_at) throw new ValidationError(`${id} is archived`);
          const p = parsePath(op.path ?? '');
          if (p.root !== 'data' && p.root !== 'gm_notes') throw new ValidationError('add works on data.* or gm_notes.* numeric fields');
          if (typeof op.delta !== 'number' || !Number.isFinite(op.delta)) throw new ValidationError('delta must be a finite number');
          checkExpected(op, state, p);
          const cur = currentValue(state, p);
          if (!cur.found || typeof cur.value !== 'number') {
            throw new ValidationError(`${op.path} on ${id} is ${cur.found ? 'not a number' : 'absent'}; use set to initialise it`);
          }
          const next = cur.value + op.delta;
          if (!Number.isFinite(next)) throw new ValidationError('result is not a finite number');
          // Avoid binary float noise for decimal deltas such as 0.1.
          const rounded = Math.round(next * 1e9) / 1e9;
          setAt(p.root === 'data' ? state.data : state.gm_notes, p.segments, rounded);
          diffs.push({ record_id: id, name: state.name, kind: state.kind, field: op.path!, before: cur.value, after: rounded, hidden: p.root === 'gm_notes' || state.visibility !== 'public' });
          normalized.push({ op: 'add', record_id: id, path: op.path, delta: op.delta });
          break;
        }
        case 'move': {
          const id = resolveId(op.record_id, 'record_id', i);
          if (!id) throw new ValidationError('record_id is required');
          const state = load(id);
          if (state.archived_at) throw new ValidationError(`${id} is archived`);
          checkExpected(op, state, null);
          const parentId = resolveId(op.parent_id, 'parent_id', i);
          const prev = state.parent_id;
          state.parent_id = parentId;
          diffs.push({ record_id: id, name: state.name, kind: state.kind, field: 'parent', before: prev, after: parentId, hidden: state.visibility !== 'public' });
          normalized.push({ op: 'move', record_id: id, parent_id: parentId });
          break;
        }
        case 'archive': {
          const id = resolveId(op.record_id, 'record_id', i);
          if (!id) throw new ValidationError('record_id is required');
          const state = load(id);
          if (state.archived_at) throw new ValidationError(`${id} is already archived`);
          checkExpected(op, state, null);
          state.archived_at = nowIso();
          diffs.push({ record_id: id, name: state.name, kind: state.kind, field: 'archived', before: false, after: true, hidden: state.visibility !== 'public' });
          normalized.push({ op: 'archive', record_id: id });
          break;
        }
        default:
          throw new ValidationError(`unknown op "${String((op as RawOperation).op)}"`);
      }
    } catch (err) {
      if (op?.op === 'create' && op.ref) failedRefs.add(op.ref);
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  if (errors.length === 0) {
    // Whole-batch checks against the candidate state.
    for (const [id, state] of after) {
      try {
        validateCandidate(db, opts, state, before.get(id) ?? null, after);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if ([...after.values()].some((s) => s.kind === 'scene')) {
      const scenes = activeSceneStates(db, opts.campaignId, after);
      const overlap = storylineOverlap(db, opts.campaignId, scenes);
      if (overlap) errors.push(overlap);
      const changed = new Set([...after.values()].filter((s) => s.kind === 'scene').map((s) => s.id));
      const info = (id: string) => {
        const st = after.get(id);
        if (st) return { kind: st.kind, visibility: st.visibility, archived: !!st.archived_at };
        const row = getRecord(db, opts.campaignId, id);
        return row ? { kind: row.kind, visibility: row.visibility, archived: !!row.archived_at } : undefined;
      };
      errors.push(...mapProblems(scenes, changed, info));
    }
  }
  if (errors.length) throw new ValidationError(errors.slice(0, 12).join('\n'));

  assignOwners(db, opts, after, createdOrder);
  return { created, createdOrder, before, after, diffs, operations: normalized };
}

function currentValue(state: RecordState, p: { root: string; segments: string[] }): { found: boolean; value: unknown } {
  if (p.root === 'name') return { found: true, value: state.name };
  if (p.root === 'visibility') return { found: true, value: state.visibility };
  return getAt(p.root === 'data' ? state.data : state.gm_notes, p.segments);
}

function lookupParent(db: Db, campaignId: string, id: string, after: Map<string, RecordState>): RecordState | null {
  const cand = after.get(id);
  if (cand) return cand;
  const row = getRecord(db, campaignId, id);
  return row ? toState(row) : null;
}

function validateCandidate(db: Db, opts: BatchOptions, state: RecordState, prior: RecordRow | null, after: Map<string, RecordState>): void {
  const size = JSON.stringify(state.data).length + JSON.stringify(state.gm_notes).length;
  if (size > LIMITS.maxRecordJsonChars) throw new ValidationError(`${state.name} (${state.id}) would exceed ${LIMITS.maxRecordJsonChars} characters`);
  assertSafeJson(state.data, `${state.id}.data`);
  assertSafeJson(state.gm_notes, `${state.id}.gm_notes`);

  // Parent must exist in this campaign, be live, and not create a containment cycle.
  if (state.parent_id) {
    if (state.parent_id === state.id) throw new ValidationError(`${state.id} cannot contain itself`);
    const seen = new Set<string>([state.id]);
    let cur: string | null = state.parent_id;
    let depth = 0;
    while (cur) {
      if (seen.has(cur)) throw new ValidationError(`moving ${state.name} (${state.id}) under ${state.parent_id} would create a containment cycle`);
      seen.add(cur);
      const parent = lookupParent(db, opts.campaignId, cur, after);
      if (!parent) throw new ValidationError(`parent ${cur} of ${state.id} does not exist in this campaign`);
      if (depth === 0 && parent.archived_at && !state.archived_at) throw new ValidationError(`parent ${cur} is archived`);
      cur = parent.parent_id;
      if (++depth > 64) throw new ValidationError('containment chain too deep');
    }
  }

  // Archived containers may not hide live contents.
  if (state.archived_at && !(prior?.archived_at)) {
    const dbChildren = db
      .prepare('SELECT id FROM records WHERE campaign_id = ? AND parent_id = ? AND archived_at IS NULL')
      .all(opts.campaignId, state.id) as { id: string }[];
    const live = new Set(dbChildren.map((r) => r.id));
    for (const [id, s] of after) {
      if (s.parent_id === state.id && !s.archived_at) live.add(id);
      else live.delete(id);
    }
    if (live.size) {
      throw new ValidationError(`${state.name} (${state.id}) still contains ${[...live].slice(0, 5).join(', ')}; move or archive them first`);
    }
  }

  // Reference fields (keys ending in _id/_ids) must name records in this campaign.
  const refs: string[] = [];
  collectIdRefs(state.data, refs);
  collectIdRefs(state.gm_notes, refs);
  for (const ref of refs) {
    if (ref.startsWith('$')) throw new ValidationError(`${state.id} refers to unknown batch ref ${ref}`);
    if (!ID_SHAPE.test(ref)) continue;
    if (!after.has(ref) && !getRecord(db, opts.campaignId, ref)) {
      throw new ValidationError(`${state.name} (${state.id}) refers to ${ref}, which does not exist in this campaign`);
    }
  }

  if (!state.archived_at) {
    const priorData = prior ? (JSON.parse(prior.data_json) as unknown) : undefined;
    const violations = checkConstraints(opts.constraints, state, priorData, { skipImmutable: opts.skipImmutable });
    if (violations.length) throw new ValidationError(`constraint violated: ${violations.join('; ')}`);
  }
}

function collectIdRefs(v: unknown, out: string[], key = ''): void {
  if (out.length > 200) return;
  if (typeof v === 'string') {
    if (ID_FIELD.test(key)) out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectIdRefs(x, out, key);
    return;
  }
  if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) collectIdRefs(x, out, k);
}

/**
 * Ownership is never chosen by the model: a confirmed character belongs to the confirming user,
 * and an "owner"-visibility record belongs to the owner of its nearest owned ancestor, or else
 * to the acting user.
 */
function assignOwners(db: Db, opts: BatchOptions, after: Map<string, RecordState>, createdOrder: string[]): void {
  if (opts.characterOwnerUserId) {
    for (const id of createdOrder) {
      const s = after.get(id)!;
      if (s.kind === 'character') s.private_owner_user_id = opts.characterOwnerUserId;
    }
  }
  for (const [, s] of after) {
    if (s.visibility !== 'owner' || s.private_owner_user_id) continue;
    let cur = s.parent_id;
    let owner: string | null = null;
    for (let d = 0; cur && d < 64; d++) {
      const p = lookupParent(db, opts.campaignId, cur, after);
      if (!p) break;
      if (p.private_owner_user_id) {
        owner = p.private_owner_user_id;
        break;
      }
      cur = p.parent_id;
    }
    s.private_owner_user_id = owner ?? opts.actorUserId;
  }
}

export interface AppliedBatch {
  created: Record<string, string>;
  /** Pre-change rows (null for records this batch created). */
  beforeImages: Record<string, RecordRow | null>;
  /** Version each touched record has after the batch, for undo's still-matches check. */
  afterVersions: Record<string, number>;
  diffs: Diff[];
  operations: unknown[];
}

/** Writes a planned batch. Must run inside a transaction opened by the caller. */
export function writeBatch(db: Db, campaignId: string, plan: PlannedBatch): AppliedBatch {
  db.pragma('defer_foreign_keys = ON');
  const ts = nowIso();
  const insert = db.prepare(
    `INSERT INTO records (id, campaign_id, kind, name, parent_id, visibility, private_owner_user_id, data_json, gm_notes_json,
       version, archived_at, created_at, updated_at)
     VALUES (@id, @campaign_id, @kind, @name, @parent_id, @visibility, @private_owner_user_id, @data_json, @gm_notes_json,
       1, @archived_at, @ts, @ts)`,
  );
  const update = db.prepare(
    `UPDATE records SET name = @name, parent_id = @parent_id, visibility = @visibility,
       private_owner_user_id = @private_owner_user_id, data_json = @data_json, gm_notes_json = @gm_notes_json,
       archived_at = @archived_at, version = version + 1, updated_at = @ts
     WHERE id = @id AND campaign_id = @campaign_id AND version = @expected`,
  );
  const beforeImages: Record<string, RecordRow | null> = {};
  const afterVersions: Record<string, number> = {};
  for (const [id, s] of plan.after) {
    const prior = plan.before.get(id) ?? null;
    beforeImages[id] = prior;
    const params = {
      id,
      campaign_id: campaignId,
      kind: s.kind,
      name: s.name,
      parent_id: s.parent_id,
      visibility: s.visibility,
      private_owner_user_id: s.private_owner_user_id,
      data_json: JSON.stringify(s.data),
      gm_notes_json: JSON.stringify(s.gm_notes),
      archived_at: s.archived_at,
      ts,
    };
    if (prior === null) {
      insert.run(params);
      afterVersions[id] = 1;
    } else {
      const res = update.run({ ...params, expected: prior.version });
      if (res.changes !== 1) throw new ValidationError(`${id} changed concurrently; re-read and try again`);
      afterVersions[id] = prior.version + 1;
    }
  }
  return { created: plan.created, beforeImages, afterVersions, diffs: plan.diffs, operations: plan.operations };
}

/** Restores before-images (undo). Must run inside a transaction opened by the caller. */
export function restoreImages(
  db: Db,
  campaignId: string,
  beforeImages: Record<string, RecordRow | null>,
  afterVersions: Record<string, number>,
): { conflicts: string[]; restored: string[] } {
  const conflicts: string[] = [];
  for (const [id, version] of Object.entries(afterVersions)) {
    const cur = getRecord(db, campaignId, id);
    if (!cur) conflicts.push(`${id} no longer exists`);
    else if (cur.version !== version) conflicts.push(`${cur.name} (${id}) changed after that turn (version ${cur.version}, expected ${version})`);
  }
  // A record created by the turn must not have gained children since.
  for (const [id, prior] of Object.entries(beforeImages)) {
    if (prior !== null) continue;
    const kids = db
      .prepare('SELECT id FROM records WHERE campaign_id = ? AND parent_id = ?')
      .all(campaignId, id) as { id: string }[];
    const foreign = kids.filter((k) => !(k.id in beforeImages));
    if (foreign.length) conflicts.push(`${id} now contains ${foreign.map((k) => k.id).join(', ')}`);
  }
  if (conflicts.length) return { conflicts, restored: [] };

  db.pragma('defer_foreign_keys = ON');
  const ts = nowIso();
  const restored: string[] = [];
  for (const [id, prior] of Object.entries(beforeImages)) {
    if (prior === null) {
      db.prepare('DELETE FROM records WHERE campaign_id = ? AND id = ?').run(campaignId, id);
    } else {
      // Version keeps increasing so later optimistic checks never confuse states.
      db.prepare(
        `UPDATE records SET name = ?, parent_id = ?, visibility = ?, private_owner_user_id = ?, data_json = ?, gm_notes_json = ?,
           archived_at = ?, version = version + 1, updated_at = ? WHERE campaign_id = ? AND id = ?`,
      ).run(prior.name, prior.parent_id, prior.visibility, prior.private_owner_user_id, prior.data_json, prior.gm_notes_json, prior.archived_at, ts, campaignId, id);
    }
    restored.push(id);
  }
  return { conflicts, restored };
}

/** Existing records violating a proposed constraint list; constraints activate only when empty. */
export function constraintViolations(db: Db, campaignId: string, constraints: Constraint[]): string[] {
  const rows = db
    .prepare(`SELECT * FROM records WHERE campaign_id = ? AND archived_at IS NULL AND kind NOT LIKE '\\_%' ESCAPE '\\'`)
    .all(campaignId) as RecordRow[];
  const out: string[] = [];
  for (const row of rows) {
    const s = toState(row);
    out.push(...checkConstraints(constraints, s, undefined));
    if (out.length > 30) break;
  }
  return out;
}

export function cloneState(s: RecordState): RecordState {
  return clone(s);
}

/**
 * Storyline invariant: a player character may be a participant of at most one active scene, so
 * every action routes to exactly one storyline. Returns an actionable error or null.
 */
/** Every active, unarchived scene as it will be after the batch. */
function activeSceneStates(db: Db, campaignId: string, after: Map<string, RecordState>): MapSceneState[] {
  const scenes = new Map<string, MapSceneState & { archived: boolean }>();
  for (const row of db.prepare(`SELECT * FROM records WHERE campaign_id = ? AND kind = 'scene'`).all(campaignId) as RecordRow[]) {
    scenes.set(row.id, { id: row.id, name: row.name, archived: !!row.archived_at, data: JSON.parse(row.data_json) as Record<string, unknown>, gm_notes: JSON.parse(row.gm_notes_json || '{}') as Record<string, unknown> });
  }
  for (const [id, s] of after) if (s.kind === 'scene') scenes.set(id, { id, name: s.name, archived: !!s.archived_at, data: s.data, gm_notes: s.gm_notes });
  return [...scenes.values()].filter((s) => !s.archived && (s.data.status === undefined || s.data.status === 'active'));
}

function storylineOverlap(db: Db, campaignId: string, scenes: MapSceneState[]): string | null {
  const pcs = new Set(playerCharacterOwners(db, campaignId).keys());
  const where = new Map<string, string[]>();
  for (const s of scenes) {
    const ids = Array.isArray(s.data.participants_ids) ? s.data.participants_ids : [];
    for (const p of ids) if (typeof p === 'string' && pcs.has(p)) where.set(p, [...(where.get(p) ?? []), s.name]);
  }
  const doubled = [...where].filter(([, names]) => names.length > 1);
  if (!doubled.length) return null;
  return `a player character can be in only one active scene (storyline): ${doubled
    .map(([pc, names]) => `${pc} is in ${names.join(' and ')}`)
    .join('; ')}. Remove them from the scene they left (or end that scene) in the same batch.`;
}
