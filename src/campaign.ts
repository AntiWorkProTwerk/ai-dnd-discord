// Campaign workflows outside ordinary play: setup, imports and approval, configuration drafts,
// character drafts, lifecycle, owner corrections and undo. Every draft is a turn row with a
// proposal; confirmation re-checks permissions and applies through the same transactional path.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  getCampaign,
  getMember,
  getRecord,
  characterNameClash,
  getTurn,
  insertTurn,
  memberCharacterIds,
  playerCharacterOwners,
  nowIso,
  parseConfig,
  randomToken,
  type Db,
} from './database.js';
import { extractFile, type ExtractionReport } from './ingest.js';
import { constraintViolations, planBatch, restoreImages, writeBatch, type Diff, type RawOperation } from './records.js';
import { commitTurn, OPERATION_SCHEMA } from './tools.js';
import type { CampaignConfig, CampaignRow, Constraint, RecordRow, SourceRole, TurnRow } from './types.js';
import { validateConstraintList, ValidationError } from './validation.js';

export const DEFAULT_CONVENTIONS = [
  'character / npc data: appearance (one visual sentence: sex, age, build, hair, face, clothing; used for portraits and illustrations); hp {current, max}; conditions [strings]; coins {<currency>: integer}; plus the stats the rules use, always under the same keys.',
  'item data: quantity (integer >= 0), description, and rule properties (damage, weight, charges, price) as needed.',
  'location data: description; exits [{to_id, label}].',
  'scene data (one scene per storyline): status ("active" | "ended"); main (true only for the main storyline); participants_ids [ids]; initiative [{id, value}]; turn_of_id; round; time_min (integer in-world minutes since Day 1 00:00); time (readable form); busy_until_min (long action in progress); pending_decision; map {cols, rows, cell_ft, features [{kind, label, x, y, w, h}]} and positions {<id>: {x, y, size}} (battle map; hidden ones in gm_notes.positions).',
  'quest data: status ("open" | "completed" | "failed"); objectives [strings]; giver_id; reward.',
  'event data: due (in-world time), description. faction/relationship data: attitude, notes.',
].join('\n');

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export interface SetupInput {
  guildId: string;
  channelId: string;
  ownerUserId: string;
  title: string;
  premise: string;
  rules_edition: string;
  tone: string;
  max_players: number;
  boundaries: string;
  require_character_approval: boolean;
}

export function defaultConfig(input: Omit<SetupInput, 'guildId' | 'channelId' | 'ownerUserId'>): CampaignConfig {
  return {
    config_version: 1,
    title: input.title.slice(0, 120),
    premise: input.premise.slice(0, 1500),
    rules_edition: input.rules_edition.slice(0, 200),
    tone: input.tone.slice(0, 300),
    max_players: Math.max(1, Math.min(12, Math.round(input.max_players))),
    boundaries: input.boundaries.slice(0, 1000),
    require_character_approval: input.require_character_approval,
    rules_digest: '',
    setting_summary: '',
    conventions: DEFAULT_CONVENTIONS,
    character_creation: '',
    house_rules: [],
    precedence: ['house_rules', 'rules', 'adventure', 'setting'],
    provisional_ruling_policy:
      'When no source covers a situation, make a fair ruling consistent with similar rules, label it "provisional ruling" in the narration, and record it in gm_note so the owner can confirm or correct it.',
    starting_situation: '',
    constraints: [],
    model: { reasoning_effort: null },
    time_sync_window_minutes: 60,
    budget: { monthly_usd: null, max_turn_usd: null },
  };
}

export function createCampaign(db: Db, input: SetupInput): CampaignRow {
  return db.transaction(() => {
    const existing = db
      .prepare(`SELECT id FROM campaigns WHERE guild_id = ? AND channel_id = ? AND status <> 'archived'`)
      .get(input.guildId, input.channelId);
    if (existing) throw new WorkflowError('This channel already has a campaign.');
    const id = `cmp_${randomToken(10)}`;
    const ts = nowIso();
    db.prepare(
      `INSERT INTO campaigns (id, guild_id, channel_id, owner_user_id, status, revision, active_source_version, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'setup', 0, 0, ?, ?, ?)`,
    ).run(id, input.guildId, input.channelId, input.ownerUserId, JSON.stringify(defaultConfig(input)), ts, ts);
    db.prepare(`INSERT INTO members (campaign_id, discord_user_id, character_record_id, role, created_at) VALUES (?, ?, NULL, 'owner', ?)`).run(
      id,
      input.ownerUserId,
      ts,
    );
    return getCampaign(db, id)!;
  })();
}

export function isOwner(campaign: CampaignRow, userId: string): boolean {
  return campaign.owner_user_id === userId;
}

/** The campaign owner may control several characters (to test parallel storylines alone); players control one. */
export function mayControlSeveral(campaign: CampaignRow, userId: string): boolean {
  return isOwner(campaign, userId);
}

export function requireOwner(campaign: CampaignRow, userId: string): void {
  if (!isOwner(campaign, userId)) throw new WorkflowError('Only the campaign owner can do that.');
}

// ---------------------------------------------------------------- lifecycle

export function setLifecycle(db: Db, campaignId: string, userId: string, action: 'start' | 'pause' | 'resume', requestId: string): { campaign: CampaignRow; message: string } {
  return db.transaction(() => {
    const c = getCampaign(db, campaignId);
    if (!c) throw new WorkflowError('Campaign not found.');
    requireOwner(c, userId);
    const allowed: Record<typeof action, CampaignRow['status'][]> = { start: ['setup'], pause: ['active'], resume: ['paused'] };
    if (!allowed[action].includes(c.status)) throw new WorkflowError(`Cannot ${action} a campaign that is ${c.status}.`);
    const next = action === 'pause' ? 'paused' : 'active';
    db.prepare('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), campaignId);
    insertTurn(db, { campaign_id: campaignId, request_id: requestId, actor_user_id: userId, mode: 'lifecycle', status: 'delivered', input_text: action });
    const cfg = parseConfig(c);
    const warning = action === 'start' && !cfg.rules_digest ? ' (No rules digest is configured yet; the GM will rely on searching imported sources.)' : '';
    const message = action === 'start' ? `The campaign **${cfg.title}** has begun!${warning}` : action === 'pause' ? 'The campaign is paused.' : 'The campaign has resumed.';
    return { campaign: getCampaign(db, campaignId)!, message };
  })();
}

// ---------------------------------------------------------------- proposals

/**
 * Atomically claims a proposal for confirmation. The confirmation binds to the turn, its nonce
 * (draft version), campaign, the permitted user and an expiry; a replay or stale click fails.
 */
export function claimProposal(
  db: Db,
  args: { turnId: number; nonce: string; campaignId: string; userId: string; who: 'owner' | 'actor'; fromStatus?: TurnRow['status'] },
): TurnRow {
  return db.transaction(() => {
    const t = getTurn(db, args.turnId);
    const c = getCampaign(db, args.campaignId);
    if (!t || !c || t.campaign_id !== c.id) throw new WorkflowError('That proposal does not belong to this campaign.');
    if (args.who === 'owner' && !isOwner(c, args.userId)) throw new WorkflowError('Only the campaign owner can confirm this.');
    if (args.who === 'actor' && t.actor_user_id !== args.userId) throw new WorkflowError('Only the player who made this draft can accept it.');
    const from = args.fromStatus ?? 'proposed';
    if (t.status !== from) throw new WorkflowError(`This proposal is already ${t.status}.`);
    if (!t.confirm_nonce || t.confirm_nonce !== args.nonce) throw new WorkflowError('This confirmation is out of date.');
    if (t.expires_at && t.expires_at < nowIso()) {
      db.prepare(`UPDATE turns SET status = 'expired', confirm_nonce = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), t.id);
      throw new WorkflowError('This proposal expired. Ask again to get a fresh draft.');
    }
    // Consume the nonce so the same confirmation can never apply twice.
    const res = db
      .prepare(`UPDATE turns SET status = 'confirmed', confirm_nonce = NULL, updated_at = ? WHERE id = ? AND status = ? AND confirm_nonce = ?`)
      .run(nowIso(), t.id, from, args.nonce);
    if (res.changes !== 1) throw new WorkflowError('This proposal was already handled.');
    return getTurn(db, t.id)!;
  })();
}

export function rejectProposal(db: Db, args: { turnId: number; nonce: string; campaignId: string; userId: string; who: 'owner' | 'actor' }): void {
  const t = getTurn(db, args.turnId);
  const c = getCampaign(db, args.campaignId);
  if (!t || !c || t.campaign_id !== c.id) throw new WorkflowError('That proposal does not belong to this campaign.');
  const ownerOk = isOwner(c, args.userId);
  if (args.who === 'owner' ? !ownerOk : t.actor_user_id !== args.userId && !ownerOk) throw new WorkflowError('You cannot cancel this proposal.');
  const res = db
    .prepare(`UPDATE turns SET status = 'rejected', confirm_nonce = NULL, updated_at = ? WHERE id = ? AND confirm_nonce = ? AND status IN ('proposed', 'awaiting_owner')`)
    .run(nowIso(), t.id, args.nonce);
  if (res.changes !== 1) throw new WorkflowError('This proposal was already handled.');
  if (t.mode === 'import') db.prepare(`UPDATE sources SET status = 'rejected' WHERE import_id = ? AND status = 'pending'`).run(importIdOf(t));
}

export function markProposed(db: Db, turnId: number, ttlMs: number, status: 'proposed' | 'awaiting_owner' = 'proposed'): string {
  const nonce = randomToken(12);
  db.prepare('UPDATE turns SET status = ?, confirm_nonce = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(
    status,
    nonce,
    new Date(Date.now() + ttlMs).toISOString(),
    nowIso(),
    turnId,
  );
  return nonce;
}

class ClaimFailedError extends WorkflowError {
  constructor(
    public turnId: number,
    message: string,
  ) {
    super(message);
  }
}

function markAborted(db: Db, turnId: number, reason: string): void {
  db.prepare(`UPDATE turns SET status = 'aborted', error = ?, updated_at = ? WHERE id = ?`).run(reason.slice(0, 2000), nowIso(), turnId);
}

/** A failed apply returns the claimed proposal to a terminal state with the reason. */
function failClaimed(db: Db, turnId: number, reason: string): never {
  markAborted(db, turnId, reason);
  throw new ClaimFailedError(turnId, reason);
}

/**
 * Runs a claimed apply in one transaction. A failClaimed inside it is rolled back with
 * everything else, so the terminal status is written again after the rollback.
 */
function claimedTransaction<T>(db: Db, fn: () => T): T {
  try {
    return db.transaction(fn)();
  } catch (err) {
    if (err instanceof ClaimFailedError && !db.inTransaction) markAborted(db, err.turnId, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------- imports

export interface ImportInput {
  campaign: CampaignRow;
  userId: string;
  requestId: string;
  filename: string;
  bytes: Buffer;
  role: SourceRole;
  title?: string;
  dataDir: string;
  maxBytes: number;
  ttlMs: number;
}

export interface ImportResult {
  turn: TurnRow;
  nonce: string;
  report: ExtractionReport;
  title: string;
  hash: string;
}

function importIdOf(t: TurnRow): string {
  return (JSON.parse(t.changes_json ?? '{}') as { import_id?: string }).import_id ?? '';
}

/** Extracts and stores an upload as pending (private, unsearchable in play) until the owner approves it. */
export async function prepareImport(db: Db, input: ImportInput): Promise<ImportResult> {
  requireOwner(input.campaign, input.userId);
  if (input.bytes.length > input.maxBytes) throw new WorkflowError(`File is larger than the ${(input.maxBytes / 1048576).toFixed(0)} MB import limit.`);
  if (input.bytes.length === 0) throw new WorkflowError('File is empty.');
  const safeName = path.basename(input.filename).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';
  const hash = crypto.createHash('sha256').update(input.bytes).digest('hex');
  const dup = db
    .prepare(`SELECT title, status FROM sources WHERE campaign_id = ? AND content_hash = ? AND status IN ('pending', 'approved') LIMIT 1`)
    .get(input.campaign.id, hash) as { title: string; status: string } | undefined;
  if (dup) throw new WorkflowError(`This exact file was already imported as "${dup.title}" (${dup.status}).`);

  let extraction;
  try {
    extraction = await extractFile(safeName, input.bytes);
  } catch (err) {
    throw new WorkflowError(`Could not read the file: ${(err as Error).message.slice(0, 200)}`);
  }
  if (!extraction.chunks.length) throw new WorkflowError(`No extractable text found. ${extraction.report.warnings.join(' ')}`);

  const ext = path.extname(safeName).toLowerCase() || '.bin';
  const dir = path.join(input.dataDir, 'sources', input.campaign.id);
  fs.mkdirSync(dir, { recursive: true });
  const originalPath = path.join(dir, `${hash}${ext}`);
  fs.writeFileSync(originalPath, input.bytes);

  const title = (input.title?.trim() || safeName.replace(/\.[^.]+$/, '')).slice(0, 120);
  const importId = `imp_${randomToken(10)}`;
  const visibility = input.role === 'adventure' ? 'gm' : 'public';
  const result = db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO sources (campaign_id, import_id, version, status, role, visibility, title, filename, content_hash, section, page_start, page_end, text, created_at)
       VALUES (?, ?, 0, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ts = nowIso();
    for (const c of extraction.chunks) {
      ins.run(input.campaign.id, importId, input.role, visibility, title, safeName, hash, c.section, c.page_start, c.page_end, c.text, ts);
    }
    const { turn } = insertTurn(db, {
      campaign_id: input.campaign.id,
      request_id: input.requestId,
      actor_user_id: input.userId,
      mode: 'import',
      status: 'running',
      input_text: `import ${safeName} as ${input.role}`,
      changes_json: JSON.stringify({
        import_id: importId,
        title,
        role: input.role,
        filename: safeName,
        sha256: hash,
        bytes: input.bytes.length,
        original: path.relative(input.dataDir, originalPath).split(path.sep).join('/'),
        report: extraction.report,
      }),
    });
    const nonce = markProposed(db, turn.id, input.ttlMs * 4);
    return { turn: getTurn(db, turn.id)!, nonce };
  })();
  return { ...result, report: extraction.report, title, hash };
}

/** Approves a pending import: it becomes searchable and a new source version becomes active. */
export function approveImport(db: Db, turn: TurnRow): { version: number; replaced: number; title: string } {
  const info = JSON.parse(turn.changes_json ?? '{}') as { import_id: string; title: string; role: SourceRole };
  return claimedTransaction(db, () => {
    const c = getCampaign(db, turn.campaign_id)!;
    const version = c.active_source_version + 1;
    const replaced = db
      .prepare(`UPDATE sources SET status = 'replaced' WHERE campaign_id = ? AND status = 'approved' AND role = ? AND title = ? AND import_id <> ?`)
      .run(c.id, info.role, info.title, info.import_id).changes;
    const n = db.prepare(`UPDATE sources SET status = 'approved', version = ? WHERE import_id = ? AND status = 'pending'`).run(version, info.import_id).changes;
    if (!n) failClaimed(db, turn.id, 'Nothing left to approve in this import.');
    db.prepare('UPDATE campaigns SET active_source_version = ?, updated_at = ? WHERE id = ?').run(version, nowIso(), c.id);
    db.prepare(`UPDATE turns SET status = 'delivered', source_version = ?, updated_at = ? WHERE id = ?`).run(version, nowIso(), turn.id);
    return { version, replaced, title: info.title };
  });
}

export function formatImportReport(r: ImportResult | { report: ExtractionReport; title: string }): string {
  const rep = r.report;
  const lines = [
    `**Import preview: ${r.title}** (${rep.format})`,
    `${rep.pages !== null ? `${rep.pages} pages, ` : ''}${rep.characters.toLocaleString()} characters, ${rep.chunks} searchable sections.`,
  ];
  for (const w of rep.warnings) lines.push(`⚠️ ${w}`);
  if (!rep.warnings.length) lines.push('No extraction problems detected.');
  lines.push('The import stays private and unused until you approve it.');
  return lines.join('\n');
}

// ---------------------------------------------------------------- configuration proposals

const nullableString = { type: ['string', 'null'] };

/** Strict JSON schema for the model's configuration draft (null = unchanged). */
export const CONFIG_PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'questions', 'config', 'starting_operations'],
  properties: {
    summary: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    config: {
      type: 'object',
      additionalProperties: false,
      required: [
        'title', 'premise', 'rules_edition', 'tone', 'max_players', 'boundaries', 'require_character_approval', 'rules_digest',
        'setting_summary', 'conventions', 'character_creation', 'house_rules', 'precedence', 'provisional_ruling_policy',
        'starting_situation', 'constraints', 'time_sync_window_minutes',
      ],
      properties: {
        title: nullableString,
        premise: nullableString,
        rules_edition: nullableString,
        tone: nullableString,
        max_players: { type: ['integer', 'null'] },
        boundaries: nullableString,
        require_character_approval: { type: ['boolean', 'null'] },
        rules_digest: nullableString,
        setting_summary: nullableString,
        conventions: nullableString,
        character_creation: nullableString,
        house_rules: { type: ['array', 'null'], items: { type: 'string' } },
        precedence: { type: ['array', 'null'], items: { type: 'string' } },
        provisional_ruling_policy: nullableString,
        starting_situation: nullableString,
        time_sync_window_minutes: { type: ['integer', 'null'], description: 'Shared world clock: in-world minutes one storyline may run ahead of the others' },
        constraints: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'path', 'rule', 'value_json'],
            properties: {
              kind: { type: 'string' },
              path: { type: 'string' },
              rule: { type: 'string', enum: ['required', 'integer', 'number', 'min', 'max', 'enum', 'immutable', 'lte_field', 'gte_field'] },
              value_json: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    // Same operation shape as save_turn (create only is typical here).
    starting_operations: { type: 'array', items: OPERATION_SCHEMA },
  },
};

const ProposalZod = z.object({
  summary: z.string().max(4000),
  questions: z.array(z.string().max(500)).max(10),
  config: z.object({
    title: z.string().max(120).nullable(),
    premise: z.string().max(1500).nullable(),
    rules_edition: z.string().max(200).nullable(),
    tone: z.string().max(300).nullable(),
    max_players: z.number().int().min(1).max(12).nullable(),
    boundaries: z.string().max(1000).nullable(),
    require_character_approval: z.boolean().nullable(),
    rules_digest: z.string().max(12000).nullable(),
    setting_summary: z.string().max(4000).nullable(),
    conventions: z.string().max(3000).nullable(),
    character_creation: z.string().max(5000).nullable(),
    house_rules: z.array(z.string().max(500)).max(40).nullable(),
    precedence: z.array(z.string().max(40)).max(8).nullable(),
    provisional_ruling_policy: z.string().max(1000).nullable(),
    starting_situation: z.string().max(3000).nullable(),
    time_sync_window_minutes: z.number().int().min(0).max(10080).nullable().optional(),
    constraints: z.array(z.object({ kind: z.string(), path: z.string(), rule: z.string(), value_json: z.string().nullable() })).max(50).nullable(),
  }),
  starting_operations: z.array(z.any()).max(40),
});
export type ConfigProposal = z.infer<typeof ProposalZod>;
export const configProposalValidator = ProposalZod;

export function mergeConfig(current: CampaignConfig, proposal: ConfigProposal): { next: CampaignConfig; changed: string[] } {
  const next: CampaignConfig = JSON.parse(JSON.stringify(current));
  const changed: string[] = [];
  const p = proposal.config;
  for (const key of Object.keys(p) as (keyof ConfigProposal['config'])[]) {
    const v = p[key];
    if (v === null || v === undefined) continue;
    if (key === 'constraints') {
      const parsed = (v as NonNullable<ConfigProposal['config']['constraints']>).map((c) => ({
        kind: c.kind,
        path: c.path,
        rule: c.rule,
        value: c.value_json === null ? null : (JSON.parse(c.value_json) as Constraint['value']),
      }));
      next.constraints = validateConstraintList(parsed);
    } else {
      (next as unknown as Record<string, unknown>)[key] = v;
    }
    if (JSON.stringify((current as unknown as Record<string, unknown>)[key]) !== JSON.stringify((next as unknown as Record<string, unknown>)[key])) changed.push(key);
  }
  next.config_version = current.config_version + (changed.length ? 1 : 0);
  return { next, changed };
}

/** Validates a configuration proposal against the current state without applying it. */
export function previewConfigProposal(db: Db, campaign: CampaignRow, proposal: ConfigProposal): { next: CampaignConfig; changed: string[]; violations: string[]; diffs: Diff[] } {
  let merged;
  try {
    merged = mergeConfig(parseConfig(campaign), proposal);
  } catch (err) {
    return { next: parseConfig(campaign), changed: [], violations: [`invalid constraints: ${(err as Error).message}`], diffs: [] };
  }
  const violations = constraintViolations(db, campaign.id, merged.next.constraints);
  let diffs: Diff[] = [];
  if (proposal.starting_operations.length) {
    try {
      diffs = planBatch(db, proposal.starting_operations as RawOperation[], { campaignId: campaign.id, actorUserId: campaign.owner_user_id, constraints: merged.next.constraints }).diffs;
    } catch (err) {
      violations.push(`starting records invalid: ${(err as Error).message}`);
    }
  }
  return { ...merged, violations, diffs };
}

export function applyConfigProposal(db: Db, turn: TurnRow): { changed: string[]; created: number } {
  const proposal = JSON.parse(turn.changes_json ?? '{}') as ConfigProposal & { base_config_version?: number };
  return claimedTransaction(db, () => {
    const c = getCampaign(db, turn.campaign_id)!;
    const current = parseConfig(c);
    if (proposal.base_config_version !== undefined && proposal.base_config_version !== current.config_version) {
      failClaimed(db, turn.id, 'The configuration changed after this draft was made. Draft it again.');
    }
    const { next, changed } = mergeConfig(current, proposal);
    // Constraints activate only when every existing record already satisfies them.
    const violations = constraintViolations(db, c.id, next.constraints);
    if (violations.length) failClaimed(db, turn.id, `Existing records violate the proposed constraints; correct them first:\n${violations.slice(0, 8).join('\n')}`);
    let created = 0;
    let revision = c.revision;
    let applied = null;
    if (proposal.starting_operations.length) {
      try {
        const plan = planBatch(db, proposal.starting_operations as RawOperation[], { campaignId: c.id, actorUserId: c.owner_user_id, constraints: next.constraints });
        applied = writeBatch(db, c.id, plan);
        created = Object.keys(plan.created).length;
        revision += 1;
      } catch (err) {
        failClaimed(db, turn.id, `Starting records are invalid: ${(err as Error).message}`);
      }
    }
    db.prepare('UPDATE campaigns SET config_json = ?, revision = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), revision, nowIso(), c.id);
    db.prepare(`UPDATE turns SET status = 'delivered', committed_revision = ?, before_images_json = ?, updated_at = ? WHERE id = ?`).run(
      revision,
      JSON.stringify({ config_before: current, images: applied?.beforeImages ?? {}, after_versions: applied?.afterVersions ?? {} }),
      nowIso(),
      turn.id,
    );
    return { changed, created };
  });
}

export function formatConfigPreview(campaign: CampaignRow, proposal: ConfigProposal, preview: ReturnType<typeof previewConfigProposal>): string {
  const before = parseConfig(campaign) as unknown as Record<string, unknown>;
  const after = preview.next as unknown as Record<string, unknown>;
  const lines = [`**Configuration draft**`, proposal.summary.slice(0, 1500), ''];
  if (!preview.changed.length) lines.push('_No configuration fields change._');
  for (const key of preview.changed) {
    const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 1));
    lines.push(`__${key}__`);
    lines.push(`before: ${show(before[key]).slice(0, 300) || '(empty)'}`);
    lines.push(`after: ${show(after[key])}`);
    lines.push('');
  }
  if (preview.diffs.length) {
    lines.push(`__Starting records__ (${preview.diffs.filter((d) => d.field === 'created').length} new)`);
    for (const d of preview.diffs.filter((x) => x.field === 'created').slice(0, 40)) lines.push(`+ ${d.kind}: ${d.name}${d.hidden ? ' (hidden)' : ''}`);
  }
  if (proposal.questions.length) {
    lines.push('', '__Questions for you__');
    for (const q of proposal.questions) lines.push(`? ${q}`);
  }
  if (preview.violations.length) {
    lines.push('', '__Cannot be applied as drafted__');
    for (const v of preview.violations.slice(0, 10)) lines.push(`✖ ${v}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- characters

export interface CharacterAcceptResult {
  status: 'committed' | 'awaiting_owner';
  characterId?: string;
  characterName?: string;
  nonce?: string;
}

function createdCharacters(turn: TurnRow): { ops: RawOperation[]; chars: RawOperation[] } {
  const draft = JSON.parse(turn.changes_json ?? '{}') as { operations?: RawOperation[] };
  const ops = draft.operations ?? [];
  return { ops, chars: ops.filter((o) => o.op === 'create' && (o.kind ?? '').toLowerCase() === 'character') };
}

/** Checks a draft before showing an Accept button; returns a problem or null. */
export function characterDraftProblem(db: Db, turn: TurnRow): string | null {
  const { ops, chars } = createdCharacters(turn);
  if (!ops.length) return 'no sheet proposed yet';
  if (chars.length !== 1) return 'a character draft must create exactly one record of kind "character"';
  if (ops.some((o) => o.op !== 'create')) return 'a character draft may only create new records';
  const clash = characterNameClash(db, turn.campaign_id, turn.actor_user_id, chars[0]!.name ?? '');
  if (clash) return clash;
  const member = getMember(db, turn.campaign_id, turn.actor_user_id);
  const campaign = getCampaign(db, turn.campaign_id);
  if (member?.character_record_id && !(campaign && mayControlSeveral(campaign, turn.actor_user_id))) return 'you already have a character in this campaign';
  return null;
}

/**
 * Applies an accepted character draft. The new character record is bound to the Discord user who
 * made and accepted the draft; nothing in the draft can choose that mapping.
 */
export function acceptCharacter(db: Db, turn: TurnRow, approvedByOwner: boolean, ttlMs: number): CharacterAcceptResult {
  const campaign = getCampaign(db, turn.campaign_id)!;
  const config = parseConfig(campaign);
  const problem = characterDraftProblem(db, turn);
  if (problem) failClaimed(db, turn.id, problem);
  if (config.require_character_approval && !approvedByOwner && !isOwner(campaign, turn.actor_user_id)) {
    const nonce = markProposed(db, turn.id, ttlMs * 8, 'awaiting_owner');
    return { status: 'awaiting_owner', nonce };
  }
  const players = playerCharacterOwners(db, campaign.id).size;
  if (players >= config.max_players) failClaimed(db, turn.id, `This campaign is full (${config.max_players} characters).`);

  const { ops } = createdCharacters(turn);
  try {
    const result = commitTurn(
      db,
      { campaignId: campaign.id, turnId: turn.id, mode: 'character' },
      { expected_revision: campaign.revision, operations: ops as never, public_reply: turn.public_reply ?? '', gm_note: turn.gm_note ?? '', source_refs: [], roll_ids: [] },
      { campaignId: campaign.id, actorUserId: turn.actor_user_id, constraints: config.constraints, characterOwnerUserId: turn.actor_user_id },
      ['confirmed'],
    );
    const ref = createdCharacters(turn).chars[0]!.ref!;
    const characterId = result.created[ref]!;
    db.transaction(() => {
      const existing = getMember(db, campaign.id, turn.actor_user_id);
      const owned = memberCharacterIds(existing);
      if (owned.length && !mayControlSeveral(campaign, turn.actor_user_id)) throw new WorkflowError('You already have a character in this campaign.');
      // The new character becomes the member's active one; earlier ones stay under their control.
      const ids = JSON.stringify([...owned, characterId]);
      if (existing)
        db.prepare('UPDATE members SET character_record_id = ?, character_ids_json = ? WHERE campaign_id = ? AND discord_user_id = ?').run(characterId, ids, campaign.id, turn.actor_user_id);
      else
        db.prepare(`INSERT INTO members (campaign_id, discord_user_id, character_record_id, character_ids_json, role, created_at) VALUES (?, ?, ?, ?, 'player', ?)`).run(
          campaign.id,
          turn.actor_user_id,
          characterId,
          ids,
          nowIso(),
        );
      db.prepare('UPDATE turns SET actor_character_id = ? WHERE id = ?').run(characterId, turn.id);
    })();
    return { status: 'committed', characterId, characterName: getRecord(db, campaign.id, characterId)?.name };
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
    failClaimed(db, turn.id, `The draft no longer fits the current campaign state: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- corrections

export function applyCorrection(db: Db, turn: TurnRow): { revision: number } {
  const campaign = getCampaign(db, turn.campaign_id)!;
  const config = parseConfig(campaign);
  const draft = JSON.parse(turn.changes_json ?? '{}') as { operations?: RawOperation[]; source_refs?: string[]; roll_ids?: string[] };
  if (turn.base_revision !== null && turn.base_revision !== campaign.revision) {
    failClaimed(db, turn.id, `The world changed after this correction was drafted (revision ${turn.base_revision} → ${campaign.revision}). Draft it again so it cannot overwrite newer facts.`);
  }
  try {
    db.prepare(`UPDATE turns SET mode = 'correction' WHERE id = ?`).run(turn.id);
    return commitTurn(
      db,
      { campaignId: campaign.id, turnId: turn.id, mode: 'correction' },
      {
        expected_revision: campaign.revision,
        operations: (draft.operations ?? []) as never,
        public_reply: turn.public_reply ?? '',
        gm_note: turn.gm_note ?? '',
        source_refs: draft.source_refs ?? [],
        roll_ids: draft.roll_ids ?? [],
      },
      { campaignId: campaign.id, actorUserId: turn.actor_user_id, constraints: config.constraints, skipImmutable: true },
      ['confirmed'],
    );
  } catch (err) {
    db.prepare(`UPDATE turns SET mode = 'gm' WHERE id = ?`).run(turn.id);
    failClaimed(db, turn.id, `Correction could not be applied: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- undo

export function findUndoTarget(db: Db, campaignId: string): TurnRow | undefined {
  return db
    .prepare(
      `SELECT * FROM turns WHERE campaign_id = ? AND mode IN ('play', 'correction') AND status IN ('committed', 'delivered')
         AND reverted_by_turn_id IS NULL AND committed_revision IS NOT NULL ORDER BY committed_revision DESC, id DESC LIMIT 1`,
    )
    .get(campaignId) as TurnRow | undefined;
}

function sameContent(a: RecordRow, b: RecordRow): boolean {
  return (
    a.name === b.name &&
    a.parent_id === b.parent_id &&
    a.visibility === b.visibility &&
    a.private_owner_user_id === b.private_owner_user_id &&
    a.data_json === b.data_json &&
    a.gm_notes_json === b.gm_notes_json &&
    (a.archived_at === null) === (b.archived_at === null)
  );
}

interface BeforeImages {
  images: Record<string, RecordRow | null>;
  after_versions: Record<string, number>;
}

/** Records changed since the target turn, which make the undo unsafe. */
export function undoConflicts(db: Db, target: TurnRow): string[] {
  const bi = JSON.parse(target.before_images_json ?? '{"images":{},"after_versions":{}}') as BeforeImages;
  const conflicts: string[] = [];
  for (const [id, version] of Object.entries(bi.after_versions)) {
    const cur = getRecord(db, target.campaign_id, id);
    if (!cur) conflicts.push(`${id} no longer exists`);
    else if (cur.version !== version) conflicts.push(`${cur.name} changed after that turn`);
  }
  return conflicts;
}

export function describeUndo(db: Db, target: TurnRow): string {
  const changes = JSON.parse(target.changes_json ?? '{}') as { diffs?: Diff[] };
  const who = target.actor_character_id ? (getRecord(db, target.campaign_id, target.actor_character_id)?.name ?? 'a character') : 'the GM';
  const lines = [`**Undo turn ${target.id}** (${target.mode} by ${who}): "${target.input_text.slice(0, 200)}"`];
  const diffs = changes.diffs ?? [];
  if (!diffs.length) lines.push('That turn changed no records; undo only marks it reverted.');
  for (const d of diffs.slice(0, 25)) lines.push(`- ${d.name}: ${d.field} ${fmt(d.after)} → back to ${fmt(d.before)}`);
  lines.push('Dice and the original turn stay in the log. The undone action is not replayed.');
  return lines.join('\n');
}

const fmt = (v: unknown) => (v === undefined ? '(absent)' : JSON.stringify(v)?.slice(0, 80));

export function applyUndo(db: Db, undoTurn: TurnRow, targetId: number): { revision: number; restored: string[] } {
  return claimedTransaction(db, () => {
    const campaign = getCampaign(db, undoTurn.campaign_id)!;
    const target = getTurn(db, targetId);
    const latest = findUndoTarget(db, campaign.id);
    if (!target || !latest || latest.id !== target.id) failClaimed(db, undoTurn.id, 'That is no longer the latest reversible turn.');
    const bi = JSON.parse(target.before_images_json ?? '{"images":{},"after_versions":{}}') as BeforeImages;
    const { conflicts, restored } = restoreImages(db, campaign.id, bi.images, bi.after_versions);
    if (conflicts.length) failClaimed(db, undoTurn.id, `Undo would overwrite later changes:\n${conflicts.slice(0, 8).join('\n')}`);
    const revision = campaign.revision + 1;
    db.prepare('UPDATE campaigns SET revision = ?, updated_at = ? WHERE id = ?').run(revision, nowIso(), campaign.id);
    db.prepare('UPDATE turns SET reverted_by_turn_id = ?, updated_at = ? WHERE id = ?').run(undoTurn.id, nowIso(), target.id);
    const who = target.actor_character_id ? (getRecord(db, campaign.id, target.actor_character_id)?.name ?? 'a character') : 'the GM';
    db.prepare(
      `UPDATE turns SET status = 'committed', committed_revision = ?, changes_json = ?, public_reply = ?, gm_note = ?, updated_at = ? WHERE id = ?`,
    ).run(
      revision,
      JSON.stringify({ undone_turn_id: target.id, restored_ids: restored }),
      `↩️ The GM undid the last action (${who}: "${target.input_text.slice(0, 120)}"). The world is back to how it was before it.`,
      `undo of turn ${target.id}`,
      nowIso(),
      undoTurn.id,
    );
    return { revision, restored };
  });
}
