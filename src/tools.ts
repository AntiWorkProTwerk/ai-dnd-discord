// The four generic tools: read_records, search_reference, roll_dice, save_turn. Handlers take
// campaign, actor, turn, mode and permissions from the server-side ToolContext; no argument can
// name a campaign or a Discord user. All SQL is parameterized and every result is bounded.
import { z } from 'zod';
import { characterNameClash, playerCharacterOwners, getCampaign, getRecord, getTurn, nowIso, parseConfig, type Db } from './database.js';
import { formatClock, syncWindow, worldClock } from './storylines.js';
import { CREATURE_KINDS, dbView, placedIn, placeIdOf, posOf, readMap } from './maps.js';
import { rollForTurn, type RollRecord } from './dice.js';
import { planBatch, worldView, writeBatch, type RawOperation } from './records.js';
import type { ToolSpec } from './providers.js';
import type { CampaignRow, RecordRow, ToolContext, TurnRow } from './types.js';
import { LIMITS, ValidationError } from './validation.js';

const nullable = (type: string | string[], extra: Record<string, unknown> = {}) => ({
  type: Array.isArray(type) ? [...type, 'null'] : [type, 'null'],
  ...extra,
});

export const OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'ref', 'record_id', 'kind', 'name', 'parent_id', 'visibility', 'path', 'value_json', 'data_json', 'gm_notes_json', 'expected_json', 'expected_version', 'delta'],
  properties: {
    op: { type: 'string', enum: ['create', 'set', 'remove', 'add', 'move', 'archive'] },
    ref: nullable('string', { description: 'create only: temporary reference like "$sword", usable as record_id/parent_id by other operations in this batch' }),
    record_id: nullable('string', { description: 'Existing record ID (or a $ref from this batch) for set/remove/add/move/archive' }),
    kind: nullable('string', { description: 'create only: lowercase label such as character, npc, item, location, quest, faction, scene, building, event, note' }),
    name: nullable('string', { description: 'create only: display name' }),
    parent_id: nullable('string', { description: 'create/move: physical container or location (record ID or $ref); null for top level' }),
    visibility: { type: ['string', 'null'], enum: ['public', 'owner', 'gm', null], description: 'create only: public (default), owner (only the owning player), gm (secret)' },
    path: nullable('string', { description: 'set/remove/add: "data.<field>[.<sub>...]", "gm_notes.<field>...", "name" or "visibility"' }),
    value_json: nullable('string', { description: 'set: the new value as a JSON string, e.g. "12", "\\"prone\\"", "[\\"poisoned\\"]", "{\\"current\\":5,\\"max\\":12}"' }),
    data_json: nullable('string', { description: 'create: JSON object string of public facts using the campaign field conventions' }),
    gm_notes_json: nullable('string', { description: 'create: JSON object string of GM-only facts, or null' }),
    expected_json: nullable('string', { description: 'set/remove/add: the value you expect the field to hold now, as JSON (use "null" for absent)' }),
    expected_version: nullable('integer', { description: 'Record version from read_records; required for set/remove on existing records unless expected_json is given' }),
    delta: nullable('number', { description: 'add: number added to a numeric field (negative to subtract); the server does the arithmetic' }),
  },
};

export const TOOL_SPECS: Record<'read_records' | 'search_reference' | 'roll_dice' | 'save_turn', ToolSpec> = {
  read_records: {
    name: 'read_records',
    description:
      'Read current campaign records (characters, NPCs, items, locations, quests, scenes, anything) and optionally past events. ' +
      'Give ids, or a filter (kind/name/parent_id/text). Results include version numbers needed for edits. Inventory = children of a record.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ids', 'kind', 'name', 'parent_id', 'text', 'include_children', 'include_archived', 'event_record_id', 'event_query', 'cursor', 'limit'],
      properties: {
        ids: { type: ['array', 'null'], items: { type: 'string' }, description: 'Specific record IDs (max 20)' },
        kind: nullable('string'),
        name: nullable('string', { description: 'Case-insensitive substring of the name' }),
        parent_id: nullable('string', { description: 'Records directly inside this record' }),
        text: nullable('string', { description: 'Substring search over names and record data' }),
        include_children: { type: 'boolean', description: 'Also list each record\'s direct contents' },
        include_archived: { type: 'boolean' },
        event_record_id: nullable('string', { description: 'Also return past committed events that changed this record' }),
        event_query: nullable('string', { description: 'Also return past events whose action or narration mention this text' }),
        cursor: nullable('string'),
        limit: nullable('integer', { description: 'Max records (default 10, max 25)' }),
      },
    },
  },
  search_reference: {
    name: 'search_reference',
    description:
      'Full-text search of the approved campaign reference material (rules, setting, adventure). Returns excerpts with source IDs and page/section. ' +
      'Cite only source IDs returned here.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query', 'role', 'section', 'page_from', 'page_to', 'limit'],
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "grapple contested check"' },
        role: { type: ['string', 'null'], enum: ['rules', 'setting', 'adventure', null] },
        section: nullable('string', { description: 'Substring of a section heading' }),
        page_from: nullable('integer'),
        page_to: nullable('integer'),
        limit: nullable('integer', { description: 'Max excerpts (default 4, max 8)' }),
      },
    },
  },
  roll_dice: {
    name: 'roll_dice',
    description:
      'Roll dice with server randomness. Declare the check (purpose, expression, modifier, target) BEFORE seeing the result. ' +
      'Expression: NdM terms with + or - and integer modifiers; keep/drop with kh/kl/dh/dl, e.g. "1d20+5", "2d20kh1+3", "4d6dl1", "2d6+1d4". ' +
      'A repeated check_id returns the saved result; never reroll an inconvenient result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['check_id', 'purpose', 'expression', 'modifier', 'target', 'comparison', 'related_ids', 'visibility', 'attacker_id', 'target_id', 'reach_ft'],
      properties: {
        check_id: { type: 'string', description: 'Stable ID for this check within the turn, e.g. "mira_attack_1"' },
        purpose: { type: 'string', description: 'Short description, e.g. "Mira attacks the gate guard"' },
        expression: { type: 'string' },
        modifier: nullable('integer', { description: 'Extra flat modifier added to the expression total' }),
        target: nullable('number', { description: 'Declared target number (DC, AC, etc.) if the check is compared' }),
        comparison: { type: ['string', 'null'], enum: ['>=', '>', '<=', '<', '==', null] },
        related_ids: { type: 'array', items: { type: 'string' }, description: 'Record/source IDs involved' },
        visibility: { type: 'string', enum: ['public', 'gm'], description: 'gm for secret checks players should not see' },
        attacker_id: nullable('string', { description: 'For an attack: who attacks (record ID). Null for other checks.' }),
        target_id: nullable('string', { description: 'For an attack: who or what is attacked (record ID). Null for other checks.' }),
        reach_ft: nullable('number', { description: 'For an attack: its reach or range in feet (5 for most melee, 10 for reach weapons, the weapon range for ranged). The server checks it against the battle map after any movement in this turn.' }),
      },
    },
  },
  save_turn: {
    name: 'save_turn',
    description:
      'Commit this turn: every lasting change as data operations plus the public narration, in one atomic batch. ' +
      'Operations: create (new record via $ref), set/remove a field (with expected_version or expected_json), add a numeric delta, move (change parent/location), archive. ' +
      'If anything is invalid nothing is applied and you get an error to fix. Call exactly once, last. An empty operations list is fine for pure dialogue or a clarifying question.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['expected_revision', 'operations', 'public_reply', 'gm_note', 'source_refs', 'roll_ids'],
      properties: {
        expected_revision: { type: 'integer', description: 'Campaign revision you planned against (given in context)' },
        operations: { type: 'array', items: OPERATION_SCHEMA },
        public_reply: { type: 'string', description: 'Narration posted to the players. Concise; no GM secrets, no tool internals.' },
        gm_note: { type: 'string', description: 'Brief private ruling note for the GM log (not chain-of-thought)' },
        source_refs: { type: 'array', items: { type: 'string' }, description: 'source_id values from search_reference that the ruling relied on' },
        roll_ids: { type: 'array', items: { type: 'string' }, description: 'check_ids used for this outcome' },
      },
    },
  },
};

// ---------------------------------------------------------------- argument validation

const ReadArgs = z.object({
  ids: z.array(z.string().max(80)).max(20).nullable(),
  kind: z.string().max(40).nullable(),
  name: z.string().max(120).nullable(),
  parent_id: z.string().max(80).nullable(),
  text: z.string().max(120).nullable(),
  include_children: z.boolean(),
  include_archived: z.boolean(),
  event_record_id: z.string().max(80).nullable(),
  event_query: z.string().max(120).nullable(),
  cursor: z.string().max(20).nullable(),
  limit: z.number().int().nullable(),
});

const SearchArgs = z.object({
  query: z.string().min(1).max(200),
  role: z.enum(['rules', 'setting', 'adventure']).nullable(),
  section: z.string().max(120).nullable(),
  page_from: z.number().int().nullable(),
  page_to: z.number().int().nullable(),
  limit: z.number().int().nullable(),
});

const RollArgs = z.object({
  check_id: z.string().min(1).max(64),
  purpose: z.string().min(1).max(200),
  expression: z.string().min(1).max(80),
  modifier: z.number().int().nullable(),
  target: z.number().nullable(),
  comparison: z.enum(['>=', '>', '<=', '<', '==']).nullable(),
  related_ids: z.array(z.string().max(80)).max(10),
  visibility: z.enum(['public', 'gm']),
  attacker_id: z.string().max(80).nullable().optional(),
  target_id: z.string().max(80).nullable().optional(),
  reach_ft: z.number().min(0).max(5000).nullable().optional(),
});

const OpArgs = z.object({
  op: z.enum(['create', 'set', 'remove', 'add', 'move', 'archive']),
  ref: z.string().max(42).nullable(),
  record_id: z.string().max(80).nullable(),
  kind: z.string().max(40).nullable(),
  name: z.string().max(120).nullable(),
  parent_id: z.string().max(80).nullable(),
  visibility: z.enum(['public', 'owner', 'gm']).nullable(),
  path: z.string().max(300).nullable(),
  value_json: z.string().max(LIMITS.maxValueJsonChars).nullable(),
  data_json: z.string().max(LIMITS.maxRecordJsonChars).nullable(),
  gm_notes_json: z.string().max(LIMITS.maxRecordJsonChars).nullable(),
  expected_json: z.string().max(LIMITS.maxValueJsonChars).nullable(),
  expected_version: z.number().int().nullable(),
  delta: z.number().nullable(),
});

export const SaveArgs = z.object({
  expected_revision: z.number().int(),
  operations: z.array(OpArgs).max(LIMITS.maxOperations),
  public_reply: z.string().max(LIMITS.maxReplyChars),
  gm_note: z.string().max(LIMITS.maxGmNoteChars),
  source_refs: z.array(z.string().max(40)).max(20),
  roll_ids: z.array(z.string().max(64)).max(30),
});
export type SaveTurnArgs = z.infer<typeof SaveArgs>;

function parseArgs<T>(schema: z.ZodType<T>, raw: string): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ValidationError('arguments were not valid JSON');
  }
  const res = schema.safeParse(json);
  if (!res.success) {
    throw new ValidationError(
      `invalid arguments: ${res.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return res.data;
}

// ---------------------------------------------------------------- projections

const MAX_RECORD_CHARS = 4000;
const MAX_OUTPUT_CHARS = 14000;

function truncateJson(value: unknown, max: number): unknown {
  const s = JSON.stringify(value);
  if (s.length <= max) return value;
  return { _truncated: true, preview: s.slice(0, max) };
}

/** Whether a record is visible in a player-facing view for this user. */
export function playerCanSee(r: RecordRow, userId: string): boolean {
  if (r.kind.startsWith('_')) return false;
  if (r.visibility === 'gm') return false;
  if (r.visibility === 'owner') return r.private_owner_user_id === userId;
  return true;
}

export function projectRecord(r: RecordRow, ctx: Pick<ToolContext, 'view' | 'actorUserId'>, children?: RecordRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id,
    kind: r.kind,
    name: r.name,
    parent_id: r.parent_id,
    visibility: r.visibility,
    version: r.version,
    data: truncateJson(JSON.parse(r.data_json), MAX_RECORD_CHARS),
  };
  if (r.private_owner_user_id) out.player_owned = r.private_owner_user_id === ctx.actorUserId ? 'acting player' : 'another player';
  if (ctx.view === 'gm') {
    const notes = JSON.parse(r.gm_notes_json) as Record<string, unknown>;
    if (Object.keys(notes).length) out.gm_notes = truncateJson(notes, MAX_RECORD_CHARS / 2);
  }
  if (r.archived_at) out.archived = true;
  if (children) {
    const visible = ctx.view === 'gm' ? children : children.filter((c) => playerCanSee(c, ctx.actorUserId));
    out.children = visible.slice(0, 40).map((c) => ({ id: c.id, kind: c.kind, name: c.name }));
    if (visible.length > 40) out.children_truncated = visible.length - 40;
  }
  return out;
}

// ---------------------------------------------------------------- handlers

export interface ToolOutcome {
  output: string;
  /** Set when save_turn succeeded; the loop stops. */
  saved?: { kind: 'committed' | 'draft'; args: SaveTurnArgs; result: Record<string, unknown> };
}

export interface ToolEnv {
  db: Db;
  ctx: ToolContext;
}

export function availableTools(ctx: ToolContext): ToolSpec[] {
  const out = [TOOL_SPECS.read_records, TOOL_SPECS.search_reference];
  if (ctx.allowDice) out.push(TOOL_SPECS.roll_dice);
  if (ctx.saveMode !== 'none') out.push(TOOL_SPECS.save_turn);
  return out;
}

export function runTool(env: ToolEnv, name: string, rawArgs: string): ToolOutcome {
  try {
    switch (name) {
      case 'read_records':
        return { output: bound(readRecords(env, parseArgs(ReadArgs, rawArgs))) };
      case 'search_reference':
        return { output: bound(searchReference(env, parseArgs(SearchArgs, rawArgs))) };
      case 'roll_dice': {
        if (!env.ctx.allowDice) throw new ValidationError('roll_dice is not available in this mode');
        const a = parseArgs(RollArgs, rawArgs);
        requireAttackInfo(env, a);
        const r = rollForTurn(env.db, env.ctx.turnId, a);
        return { output: JSON.stringify(rollOutput(r)) };
      }
      case 'save_turn': {
        if (env.ctx.saveMode === 'none') throw new ValidationError('save_turn is not available in this read-only mode');
        const a = parseArgs(SaveArgs, rawArgs);
        return saveTurn(env, a);
      }
      default:
        throw new ValidationError(`unknown tool ${name}`);
    }
  } catch (err) {
    const message = err instanceof ValidationError ? err.message : 'internal error while running the tool';
    return { output: JSON.stringify({ ok: false, error: message.slice(0, 3000) }) };
  }
}

function bound(value: unknown): string {
  const s = JSON.stringify(value);
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return JSON.stringify({ ok: true, truncated: true, note: 'Output too long; narrow the query or request fewer records.', partial: s.slice(0, MAX_OUTPUT_CHARS) });
}

function rollOutput(r: RollRecord) {
  return {
    ok: true,
    check_id: r.check_id,
    total: r.total,
    dice: r.details.map((d) => ({ dice: d.dice, rolls: d.rolls, kept: d.kept })),
    modifier: r.modifier,
    target: r.target,
    comparison: r.comparison,
    success: r.success,
    reused_saved_result: r.reused ?? false,
  };
}

function readRecords(env: ToolEnv, a: z.infer<typeof ReadArgs>) {
  const { db, ctx } = env;
  const limit = Math.min(Math.max(a.limit ?? 10, 1), 25);
  const offset = Math.max(Number(a.cursor ?? 0) || 0, 0);
  const errors: string[] = [];
  let rows: RecordRow[] = [];
  let nextCursor: string | null = null;

  const visible = (r: RecordRow) => !r.kind.startsWith('_') && (ctx.view === 'gm' || playerCanSee(r, ctx.actorUserId));

  if (a.ids && a.ids.length) {
    const stmt = db.prepare('SELECT * FROM records WHERE campaign_id = ? AND id = ?');
    for (const id of a.ids) {
      const row = stmt.get(ctx.campaignId, id) as RecordRow | undefined;
      // Out-of-campaign and hidden IDs are reported identically, so existence does not leak.
      if (!row || !visible(row)) errors.push(`${id}: not found in this campaign`);
      else rows.push(row);
    }
  } else if (a.kind || a.name || a.parent_id || a.text) {
    const where = ['campaign_id = @campaign', `kind NOT LIKE '\\_%' ESCAPE '\\'`];
    const params: Record<string, unknown> = { campaign: ctx.campaignId, limit: limit + 1, offset };
    if (!a.include_archived) where.push('archived_at IS NULL');
    if (a.kind) {
      where.push('kind = @kind');
      params.kind = a.kind.toLowerCase();
    }
    if (a.name) {
      where.push(`name LIKE @name ESCAPE '\\'`);
      params.name = `%${escapeLike(a.name)}%`;
    }
    if (a.parent_id) {
      where.push('parent_id = @parent');
      params.parent = a.parent_id;
    }
    if (a.text) {
      where.push(ctx.view === 'gm' ? `(name LIKE @text ESCAPE '\\' OR data_json LIKE @text ESCAPE '\\' OR gm_notes_json LIKE @text ESCAPE '\\')` : `(name LIKE @text ESCAPE '\\' OR data_json LIKE @text ESCAPE '\\')`);
      params.text = `%${escapeLike(a.text)}%`;
    }
    if (ctx.view === 'player') {
      where.push(`(visibility = 'public' OR (visibility = 'owner' AND private_owner_user_id = @user))`);
      params.user = ctx.actorUserId;
    }
    rows = db.prepare(`SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY kind, name, id LIMIT @limit OFFSET @offset`).all(params) as RecordRow[];
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      nextCursor = String(offset + limit);
    }
  } else if (!a.event_record_id && !a.event_query) {
    errors.push('give ids, a filter (kind/name/parent_id/text), or an event query');
  }

  const childStmt = db.prepare('SELECT * FROM records WHERE campaign_id = ? AND parent_id = ? AND archived_at IS NULL ORDER BY kind, name LIMIT 60');
  for (const r of rows) ctx.seen?.set(r.id, r.version);
  const records = rows.map((r) => projectRecord(r, ctx, a.include_children ? (childStmt.all(ctx.campaignId, r.id) as RecordRow[]) : undefined));

  const out: Record<string, unknown> = { ok: true, records, next_cursor: nextCursor };
  if (errors.length) out.errors = errors;
  if (a.event_record_id || a.event_query) out.events = readEvents(env, a.event_record_id, a.event_query);
  return out;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function readEvents(env: ToolEnv, recordId: string | null, query: string | null) {
  const { db, ctx } = env;
  // Character-creation replies were private to one player; only the GM view sees them in history.
  const modes = ctx.view === 'gm' ? "'play', 'correction', 'undo', 'character'" : "'play', 'correction', 'undo'";
  // Whispered turns are history only for the player who made them.
  const where = [`campaign_id = @campaign`, `status IN ('committed', 'delivered')`, `mode IN (${modes})`, `(json_extract(delivery_json, '$.whisper') IS NULL OR actor_user_id = @viewer)`];
  const params: Record<string, unknown> = { campaign: ctx.campaignId, viewer: ctx.actorUserId };
  if (recordId) {
    where.push(`changes_json LIKE @rid ESCAPE '\\'`);
    params.rid = `%"${escapeLike(recordId)}"%`;
  }
  if (query) {
    where.push(`(input_text LIKE @q ESCAPE '\\' OR public_reply LIKE @q ESCAPE '\\')`);
    params.q = `%${escapeLike(query)}%`;
  }
  const rows = db.prepare(`SELECT * FROM turns WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 8`).all(params) as TurnRow[];
  return rows.reverse().map((t) => ({
    turn_id: t.id,
    mode: t.mode,
    actor_character_id: t.actor_character_id,
    action: t.input_text.slice(0, 400),
    narration: (t.public_reply ?? '').slice(0, 700),
    ...(ctx.view === 'gm' && t.gm_note ? { gm_note: t.gm_note.slice(0, 300) } : {}),
    reverted: t.reverted_by_turn_id !== null,
    at: t.created_at,
  }));
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'is', 'are', 'how', 'what', 'does', 'do', 'with', 'by', 'at', 'be', 'it']);

/** Builds a safe FTS5 query from free text: quoted terms joined with OR. */
export function ftsQuery(text: string): string | null {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOPWORDS.has(w) && w.length > 1).slice(0, 12);
  if (!words.length) return null;
  return words.map((w) => `"${w}"`).join(' OR ');
}

export function searchReference(env: ToolEnv, a: z.infer<typeof SearchArgs>) {
  const { db, ctx } = env;
  const match = ftsQuery(a.query);
  if (!match) return { ok: true, results: [], note: 'No searchable terms in the query.' };
  const statuses = ctx.includePendingSources ? ['approved', 'pending'] : ['approved'];
  const where = [`s.campaign_id = @campaign`, `s.status IN (${statuses.map((s) => `'${s}'`).join(', ')})`, `sources_fts MATCH @match`];
  const params: Record<string, unknown> = { campaign: ctx.campaignId, match, limit: Math.min(Math.max(a.limit ?? 4, 1), 8) };
  if (ctx.view === 'player') where.push(`s.visibility = 'public'`);
  if (a.role) {
    where.push('s.role = @role');
    params.role = a.role;
  }
  if (a.section) {
    where.push(`s.section LIKE @section ESCAPE '\\'`);
    params.section = `%${escapeLike(a.section)}%`;
  }
  if (a.page_from !== null) {
    where.push('s.page_end >= @pf');
    params.pf = a.page_from;
  }
  if (a.page_to !== null) {
    where.push('s.page_start <= @pt');
    params.pt = a.page_to;
  }
  const rows = db
    .prepare(
      `SELECT s.* FROM sources_fts JOIN sources s ON s.id = sources_fts.rowid
       WHERE ${where.join(' AND ')} ORDER BY bm25(sources_fts, 2.0, 3.0, 1.0) LIMIT @limit`,
    )
    .all(params) as import('./types.js').SourceRow[];
  if (!rows.length) {
    return { ok: true, results: [], note: 'No matching reference text. Apply the provisional-ruling policy or ask the owner; do not invent a citation.' };
  }
  return {
    ok: true,
    results: rows.map((s) => ({
      source_id: `src_${s.id}`,
      title: s.title,
      role: s.role,
      section: s.section,
      pages: s.page_start ? (s.page_end && s.page_end !== s.page_start ? `${s.page_start}-${s.page_end}` : `${s.page_start}`) : null,
      status: s.status,
      excerpt: s.text.slice(0, 1800),
    })),
  };
}

function validSourceRefs(env: ToolEnv, refs: string[]): string[] {
  const bad: string[] = [];
  const stmt = env.db.prepare(`SELECT id FROM sources WHERE campaign_id = ? AND id = ? AND status IN ('approved', 'pending')`);
  for (const ref of refs) {
    const m = /^src_(\d+)$/.exec(ref);
    if (!m || !stmt.get(env.ctx.campaignId, Number(m[1]))) bad.push(ref);
  }
  return bad;
}

function saveTurn(env: ToolEnv, a: SaveTurnArgs): ToolOutcome {
  const { db, ctx } = env;
  if (!a.public_reply.trim()) throw new ValidationError('public_reply must not be empty');
  const turn = getTurn(db, ctx.turnId);
  if (!turn) throw new ValidationError('turn not found');
  const rolls = JSON.parse(turn.rolls_json) as RollRecord[];
  const unknownRolls = a.roll_ids.filter((id) => !rolls.some((r) => r.check_id === id));
  if (unknownRolls.length) throw new ValidationError(`roll_ids not rolled in this turn: ${unknownRolls.join(', ')}`);
  const badRefs = validSourceRefs(env, a.source_refs);
  if (badRefs.length) throw new ValidationError(`source_refs not returned by search_reference: ${badRefs.join(', ')}`);

  const campaign = getCampaign(db, ctx.campaignId);
  if (!campaign) throw new ValidationError('campaign not found');
  const config = parseConfig(campaign);
  const batchOpts = { campaignId: ctx.campaignId, actorUserId: ctx.actorUserId, constraints: config.constraints };
  const ops = a.operations as RawOperation[];

  if (ctx.saveMode === 'draft') {
    if (a.expected_revision !== campaign.revision) {
      throw new ValidationError(`campaign is at revision ${campaign.revision}, not ${a.expected_revision}; re-read and plan again`);
    }
    if (ctx.mode === 'character') {
      for (const o of ops) {
        const clash = o.op === 'create' && (o.kind ?? '').toLowerCase() === 'character' ? characterNameClash(db, ctx.campaignId, ctx.actorUserId, o.name ?? '') : null;
        if (clash) throw new ValidationError(`Name taken: ${clash}. Ask the player for another name (save an empty batch with the question).`);
      }
    }
    const plan = planBatch(db, ops, batchOpts);
    const draft = { operations: a.operations, diffs: plan.diffs, created: plan.created, source_refs: a.source_refs, roll_ids: a.roll_ids };
    db.prepare('UPDATE turns SET changes_json = ?, public_reply = ?, gm_note = ?, base_revision = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(draft),
      a.public_reply,
      a.gm_note,
      campaign.revision,
      nowIso(),
      ctx.turnId,
    );
    return { output: JSON.stringify({ ok: true, draft: true, note: 'Proposal stored for confirmation. Stop now.' }), saved: { kind: 'draft', args: a, result: draft } };
  }

  const result = commitTurn(db, ctx, a, batchOpts);
  return {
    output: JSON.stringify({ ok: true, committed_revision: result.revision, created_ids: result.created, note: 'Committed. Stop now.' }),
    saved: { kind: 'committed', args: a, result },
  };
}

/** Validates and applies a save_turn batch atomically; marks the turn committed. */
export function commitTurn(
  db: Db,
  ctx: Pick<ToolContext, 'campaignId' | 'turnId' | 'mode'> & Partial<Pick<ToolContext, 'seen' | 'actorCharacterId'>>,
  a: Pick<SaveTurnArgs, 'expected_revision' | 'operations' | 'public_reply' | 'gm_note' | 'source_refs' | 'roll_ids'>,
  batchOpts: Parameters<typeof planBatch>[2],
  turnStatusRequired: TurnRow['status'][] = ['running'],
): { revision: number; created: Record<string, string> } {
  return db.transaction(() => {
    const turn = getTurn(db, ctx.turnId);
    if (!turn) throw new ValidationError('turn not found');
    if (!turnStatusRequired.includes(turn.status)) throw new ValidationError(`this turn is already ${turn.status}; only one commit is allowed`);
    const campaign = getCampaign(db, ctx.campaignId);
    if (!campaign) throw new ValidationError('campaign not found');
    if (ctx.mode === 'play' && campaign.status !== 'active') throw new ValidationError(`campaign is ${campaign.status}; play is not open`);
    // Play turns in different storylines commit concurrently, so they are checked per record
    // (below) instead of against the campaign-wide revision; other writes keep the strict check.
    if (ctx.mode !== 'play' && campaign.revision !== a.expected_revision) {
      throw new ValidationError(
        `stale plan: campaign is at revision ${campaign.revision}, not ${a.expected_revision}. Re-read the records you change and save again, reusing existing check_ids.`,
      );
    }
    const plan = planBatch(db, a.operations as RawOperation[], batchOpts);
    if (ctx.mode === 'play') {
      const stale: string[] = [];
      for (const [id, prior] of plan.before) {
        const seenVersion = prior ? ctx.seen?.get(id) : undefined;
        if (prior && seenVersion !== undefined && seenVersion !== prior.version) stale.push(`${prior.name} (${id})`);
      }
      if (stale.length) {
        throw new ValidationError(
          `changed in another storyline since you read them: ${stale.join(', ')}. Re-read them with read_records and save again, reusing your existing check_ids.`,
        );
      }
      checkClockWindow(db, campaign, plan, ctx.actorCharacterId ?? null);
      checkTurnHandback(db, campaign.id, plan, ctx.actorCharacterId ?? null, (JSON.parse(turn.rolls_json) as unknown[]).length > 0);
      checkPlaces(db, campaign.id, plan, ctx.actorCharacterId ?? null);
      const usedRolls = new Set(a.roll_ids);
      checkAttackReach(db, campaign.id, plan, (JSON.parse(turn.rolls_json) as RollRecord[]).filter((r) => usedRolls.has(r.check_id)), ctx.actorCharacterId ?? null);
    }
    const applied = writeBatch(db, ctx.campaignId, plan);
    const revision = campaign.revision + 1;
    db.prepare('UPDATE campaigns SET revision = ?, updated_at = ? WHERE id = ?').run(revision, nowIso(), ctx.campaignId);
    db.prepare(
      `UPDATE turns SET status = 'committed', changes_json = ?, before_images_json = ?, public_reply = ?, gm_note = ?,
         committed_revision = ?, base_revision = COALESCE(base_revision, ?), updated_at = ? WHERE id = ?`,
    ).run(
      JSON.stringify({ operations: applied.operations, diffs: applied.diffs, created: applied.created, source_refs: a.source_refs, roll_ids: a.roll_ids }),
      JSON.stringify({ images: applied.beforeImages, after_versions: applied.afterVersions }),
      a.public_reply,
      a.gm_note,
      revision,
      a.expected_revision,
      nowIso(),
      ctx.turnId,
    );
    return { revision, created: applied.created };
  })();
}

/**
 * Shared world clock: when a play turn advances its storyline's `time_min`, it may not run more
 * than the campaign's sync window ahead of the other active storylines. Long actions are narrated
 * as under way (`busy_until_min`) and complete when the rest of the world catches up.
 */
function checkClockWindow(db: Db, campaign: CampaignRow, plan: ReturnType<typeof planBatch>, actorCharacterId: string | null): void {
  if (!actorCharacterId) return;
  let scene: { id: string; name: string; time: number | null; prior: number | null } | null = null;
  for (const [id, s] of plan.after) {
    if (s.kind !== 'scene' || s.archived_at) continue;
    const ids = Array.isArray(s.data.participants_ids) ? s.data.participants_ids : [];
    if (!ids.includes(actorCharacterId) || (s.data.status !== undefined && s.data.status !== 'active')) continue;
    const prior = plan.before.get(id);
    const priorTime = prior ? (JSON.parse(prior.data_json) as { time_min?: unknown }).time_min : null;
    scene = {
      id,
      name: s.name,
      time: typeof s.data.time_min === 'number' ? s.data.time_min : null,
      prior: typeof priorTime === 'number' ? priorTime : null,
    };
  }
  if (!scene || scene.time === null || (scene.prior !== null && scene.time <= scene.prior)) return;
  const others = worldClock(db, campaign.id, { excludeSceneId: scene.id });
  if (others === null) return;
  const window = syncWindow(parseConfig(campaign));
  const limit = others + window;
  if (scene.time > limit) {
    throw new ValidationError(
      `shared world clock: ${scene.name} would reach ${formatClock(scene.time)}, more than ${window} in-world minutes ahead of the other active storylines (slowest at ${formatClock(others)}). ` +
        `Keep time_min at or below ${limit} (${formatClock(limit)}); narrate the long action as under way, set data.busy_until_min = ${scene.time} on the scene, and stop. It completes when the rest of the world catches up.`,
    );
  }
}

/**
 * Players never trigger NPC turns, so a play turn may not end with an NPC's turn pending in the
 * acting character's own scene: the GM must resolve those NPC turns in the same reply and hand the
 * turn to a player character (or clear turn_of_id when the fight is over).
 */
const ATTACK_WORDS = /\b(attacks?|attacking|strikes?|slash(es)?|stabs?|punch(es)?|kicks?|swings?|shoots?|shot|fires?|hits?|lunges?|bites?|claws?|smash(es)?|cleaves?|thrusts?)\b/i;

/** Where the place has a map, an attack roll must say who attacks whom and with what reach. */
function requireAttackInfo(env: ToolEnv, a: z.infer<typeof RollArgs>): void {
  if (env.ctx.mode !== 'play' || !ATTACK_WORDS.test(a.purpose) || (a.target_id && a.reach_ft !== null && a.reach_ft !== undefined)) return;
  if (!env.ctx.actorCharacterId) return;
  const view = dbView(env.db, env.ctx.campaignId);
  const place = placeIdOf(view, env.ctx.actorCharacterId);
  if (!place || !readMap(view.get(place)?.data.map)) return;
  throw new ValidationError(
    'This looks like an attack, and this place has a map: declare attacker_id, target_id and reach_ft (5 for most melee, 10 for reach weapons, the range for ranged) so the server can check the distance. Declare it again with those fields.',
  );
}

/**
 * Attacks must reach: after this turn's movement, the attacker must be within the declared reach
 * of the target on their place's map (Chebyshev distance between footprints, edge to edge).
 */
function checkAttackReach(db: Db, campaignId: string, plan: ReturnType<typeof planBatch>, rolls: RollRecord[], actorCharacterId: string | null): void {
  const attacks = rolls.filter((r) => r.target_id && typeof r.reach_ft === 'number');
  if (!attacks.length) return;
  const view = worldView(db, campaignId, plan.after);
  for (const r of attacks) {
    const attacker = r.attacker_id ?? actorCharacterId;
    if (!attacker) continue;
    const place = placeIdOf(view, attacker);
    if (!place || place !== placeIdOf(view, r.target_id!)) continue;
    const map = readMap(view.get(place)?.data.map);
    const a = view.get(attacker);
    const t = view.get(r.target_id!);
    const ap = a ? posOf(a) : null;
    const tp = t ? posOf(t) : null;
    if (!map || !ap || !tp) continue;
    const gap = (p: number, ps: number, q: number, qs: number) => Math.max(0, q - (p + ps - 1), p - (q + qs - 1));
    const cells = Math.max(gap(ap.x, ap.size ?? 1, tp.x, tp.size ?? 1), gap(ap.y, ap.size ?? 1, tp.y, tp.size ?? 1));
    const feet = cells * map.cell_ft;
    // Adjacent squares (including diagonal) are 5 ft apart on a 5 ft grid.
    if (feet > r.reach_ft! + 0.01) {
      throw new ValidationError(
        `${a!.name} is ${feet} ft from ${t!.name} on the map, but the attack "${r.check_id}" reaches ${r.reach_ft} ft. If they move first, set data.pos on ${attacker} to a cell within reach in this same save (respecting their movement); otherwise narrate that they close the distance instead of hitting, or use an attack that reaches.`,
      );
    }
  }
}

/**
 * The world is mapped where it matters. The acting character's place must have a saved map, with
 * a position for the actor and everyone in their scene or fight there. Anyone this save moves or
 * changes needs a position too, on a mapped place. Bystanders nobody touched may stay unplaced
 * until they come into the story (the GM sees them as "not placed yet"), so editing a place, say
 * adding an exit, never drags in everyone standing in it.
 */
function checkPlaces(db: Db, campaignId: string, plan: ReturnType<typeof planBatch>, actorCharacterId: string | null): void {
  if (!actorCharacterId) return;
  const view = worldView(db, campaignId, plan.after);
  const before = dbView(db, campaignId);
  const actor = view.get(actorCharacterId);
  const mine = placeIdOf(view, actorCharacterId);
  if (!mine && actor && !actor.archived) {
    throw new ValidationError(`${actor.name} is not in any location. Set their parent_id to the location they are in (create it with data.map if it is new) and give them data.pos on its map, in this save.`);
  }
  // Who must stand somewhere, by place.
  const need = new Map<string, Set<string>>();
  const want = (placeId: string | null, id: string) => {
    if (!placeId) return;
    if (!need.has(placeId)) need.set(placeId, new Set());
    need.get(placeId)!.add(id);
  };
  want(mine, actorCharacterId);
  // The actor's scene: its participants and combatants in the actor's place.
  const sceneRows = db.prepare(`SELECT id FROM records WHERE campaign_id = ? AND kind = 'scene' AND archived_at IS NULL`).all(campaignId) as { id: string }[];
  const sceneIds = new Set([...sceneRows.map((r) => r.id), ...[...plan.after.values()].filter((st) => st.kind === 'scene').map((st) => st.id)]);
  for (const sid of sceneIds) {
    const sc = view.get(sid);
    if (!sc || sc.archived || (sc.data.status !== undefined && sc.data.status !== 'active')) continue;
    const ids = [
      ...(Array.isArray(sc.data.participants_ids) ? (sc.data.participants_ids as unknown[]) : []),
      ...(Array.isArray(sc.data.initiative) ? (sc.data.initiative as unknown[]).map((e) => (typeof e === 'string' ? e : (e as { id?: unknown } | null)?.id)) : []),
    ].filter((x): x is string => typeof x === 'string');
    if (!ids.includes(actorCharacterId)) continue;
    for (const id of ids) if (CREATURE_KINDS.has(view.get(id)?.kind ?? '') && placeIdOf(view, id) === mine) want(mine, id);
  }
  // Anyone this save creates, moves or changes.
  for (const [id, st] of plan.after) if (CREATURE_KINDS.has(st.kind) && !st.archived_at) want(placeIdOf(view, id), id);

  // A place created in this save that someone walked into from a mapped place links back to it.
  for (const [id, st] of plan.after) {
    if (st.kind !== 'character' || plan.before.get(id) === undefined) continue;
    const to = placeIdOf(view, id);
    const from = placeIdOf(before, id);
    if (!to || !from || to === from || plan.before.get(to) !== null) continue;
    const dest = view.get(to)!;
    const origin = before.get(from);
    const destMap = readMap(dest.data.map);
    if (!destMap || !readMap(origin?.data.map)) continue;
    const links = [...destMap.features, ...((Array.isArray(dest.gm_notes.map_features) ? dest.gm_notes.map_features : []) as { to?: unknown }[])].some((f) => f.to === from);
    if (!links) {
      throw new ValidationError(
        `${dest.name} is new and ${st.name} came from ${origin!.name} (${from}): give ${dest.name}'s map the exit they came through, with "to": "${from}" (a door, stairs or an exit at its edge), so the two places stay connected.`,
      );
    }
  }
  for (const [placeId, ids] of need) {
    const place = view.get(placeId)!;
    if (!readMap(place.data.map)) {
      // Townsfolk recorded in a town that nobody is playing in may stay as they are.
      if (placeId !== mine && ![...ids].some((id) => plan.before.get(id) === null || placeIdOf(before, id) !== placeId || posOf(view.get(id)!))) continue;
      throw new ValidationError(
        `${place.name} (${placeId}) has no map, and ${[...ids].map((id) => view.get(id)?.name ?? id).join(', ')} ${ids.size > 1 ? 'are' : 'is'} there. In this same save either set its data.map {cols, rows, cell_ft: 5, features: [walls, doors, furniture, exits with "to"]} from its description and data.pos on them, or, if it is a whole town or region, create the specific place inside it (kind "location", parent_id ${placeId}, with data.map) and move them there (parent_id and data.pos).`,
      );
    }
    const missing = [...ids].map((id) => view.get(id)!).filter((r) => r && !posOf(r));
    if (missing.length) {
      throw new ValidationError(
        `${missing.map((r) => `${r.name} (${r.id})`).join(', ')} need${missing.length > 1 ? '' : 's'} a position on the map of ${place.name}: set data.pos {x, y} (gm_notes.pos if their whereabouts are secret) in this save, consistent with the narration. Someone who is not really here belongs in another location (parent_id).`,
      );
    }
  }
}

function checkTurnHandback(db: Db, campaignId: string, plan: ReturnType<typeof planBatch>, actorCharacterId: string | null, actorRolled: boolean): void {
  if (!actorCharacterId) return;
  const pcs = new Set(playerCharacterOwners(db, campaignId).keys());
  const scenes = new Map<string, { name: string; data: Record<string, unknown> }>();
  for (const row of db.prepare(`SELECT * FROM records WHERE campaign_id = ? AND kind = 'scene' AND archived_at IS NULL`).all(campaignId) as RecordRow[]) {
    scenes.set(row.id, { name: row.name, data: JSON.parse(row.data_json) as Record<string, unknown> });
  }
  for (const [id, s] of plan.after) if (s.kind === 'scene') scenes.set(id, { name: s.name, data: s.archived_at ? { status: 'ended' } : s.data });
  for (const [, s] of scenes) {
    const d = s.data;
    if (d.status !== undefined && d.status !== 'active') continue;
    const ids = Array.isArray(d.participants_ids) ? d.participants_ids : [];
    if (!ids.includes(actorCharacterId)) continue;
    // An action that rolled dice used the actor's turn: initiative must move on (round or turn),
    // otherwise the NPCs who act between this player and the next were silently skipped.
    const initiative = Array.isArray(d.initiative) ? d.initiative : [];
    // Compare with the scene as it was before this batch (unchanged scenes compare with themselves).
    const sceneId = [...scenes.keys()].find((k) => scenes.get(k) === s) ?? '';
    const prior = plan.before.get(sceneId) ?? (plan.after.has(sceneId) ? undefined : getRecord(db, campaignId, sceneId));
    if (actorRolled && prior && initiative.length > 1 && d.turn_of_id === actorCharacterId) {
      const was = JSON.parse(prior.data_json) as { turn_of_id?: unknown; round?: unknown };
      if (was.turn_of_id === actorCharacterId && was.round === d.round) {
        throw new ValidationError(
          `${s.name}: it is still ${actorCharacterId}'s turn in the same round after an action that used their turn. Advance the initiative: resolve every NPC turn that comes next in order (roll, apply, narrate in this reply), update round if it wrapped, and set turn_of_id to the next player character.`,
        );
      }
    }
    const turnOf = d.turn_of_id;
    if (typeof turnOf !== 'string' || !turnOf || pcs.has(turnOf)) continue;
    const npc = plan.after.get(turnOf)?.name ?? (db.prepare('SELECT name FROM records WHERE campaign_id = ? AND id = ?').get(campaignId, turnOf) as { name: string } | undefined)?.name ?? turnOf;
    throw new ValidationError(
      `${s.name}: turn_of_id is ${npc} (${turnOf}), a non-player. Players never trigger NPC turns: resolve ${npc}'s turn (and any other NPC turns before the next player character) in THIS reply — roll, apply results, narrate — then set turn_of_id to the next player character, or remove turn_of_id if the fight is over.`,
    );
  }
}
