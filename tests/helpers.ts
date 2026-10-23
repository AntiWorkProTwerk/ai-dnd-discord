// Shared fixtures for the deterministic test suite: temp databases, campaigns, turns, tool
// contexts and seeded records written through the same planBatch/writeBatch path as play.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCampaign } from '../src/campaign.js';
import { getCampaign, insertTurn, openDatabase, type Db } from '../src/database.js';
import { planBatch, writeBatch, type RawOperation } from '../src/records.js';
import type { CampaignConfig, CampaignRow, Constraint, RecordRow, ToolContext, TurnRow } from '../src/types.js';

export const OWNER = 'user_owner';
export const ALICE = 'user_alice';
export const BOB = 'user_bob';

const tempDirs: string[] = [];

export function tempDir(prefix = 'rpgtest-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a handle briefly; ignore */
    }
  }
}

/** Opens a migrated database in a fresh temp directory (file-backed so reopening works). */
export function tempDb(): { db: Db; file: string; dir: string } {
  const dir = tempDir();
  const file = path.join(dir, 'rpg.sqlite');
  return { db: openDatabase(file), file, dir };
}

let channelSeq = 0;

export function newCampaign(db: Db, opts: { owner?: string; active?: boolean; constraints?: Constraint[] } = {}): CampaignRow {
  const c = createCampaign(db, {
    guildId: 'guild_1',
    channelId: `chan_${++channelSeq}_${crypto.randomBytes(3).toString('hex')}`,
    ownerUserId: opts.owner ?? OWNER,
    title: 'Test campaign',
    premise: 'A test.',
    rules_edition: 'Test rules',
    tone: 'neutral',
    max_players: 4,
    boundaries: '',
    require_character_approval: false,
  });
  if (opts.constraints) setConstraints(db, c.id, opts.constraints);
  if (opts.active ?? true) db.prepare(`UPDATE campaigns SET status = 'active' WHERE id = ?`).run(c.id);
  return getCampaign(db, c.id)!;
}

export function setConstraints(db: Db, campaignId: string, constraints: Constraint[]): void {
  const c = getCampaign(db, campaignId)!;
  const cfg = JSON.parse(c.config_json) as CampaignConfig;
  cfg.constraints = constraints;
  db.prepare('UPDATE campaigns SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), campaignId);
}

let reqSeq = 0;

export function newTurn(
  db: Db,
  campaignId: string,
  opts: { actor?: string; mode?: TurnRow['mode']; status?: TurnRow['status']; input?: string; characterId?: string | null; requestId?: string } = {},
): TurnRow {
  return insertTurn(db, {
    campaign_id: campaignId,
    request_id: opts.requestId ?? `req_${++reqSeq}_${crypto.randomBytes(4).toString('hex')}`,
    actor_user_id: opts.actor ?? ALICE,
    actor_character_id: opts.characterId ?? null,
    mode: opts.mode ?? 'play',
    status: opts.status ?? 'running',
    input_text: opts.input ?? 'I look around.',
  }).turn;
}

export function makeCtx(campaignId: string, turnId: number, over: Partial<ToolContext> = {}): ToolContext {
  return {
    campaignId,
    turnId,
    mode: 'play',
    actorUserId: ALICE,
    actorCharacterId: null,
    view: 'gm',
    includePendingSources: false,
    saveMode: 'commit',
    allowDice: true,
    ...over,
  };
}

/** Full create operation with every unused field null, as the strict schema requires. */
export function op(partial: Partial<RawOperation> & { op: RawOperation['op'] }): RawOperation {
  return {
    ref: null,
    record_id: null,
    kind: null,
    name: null,
    parent_id: null,
    visibility: null,
    path: null,
    value_json: null,
    data_json: null,
    gm_notes_json: null,
    expected_json: null,
    expected_version: null,
    delta: null,
    ...partial,
  };
}

export function createOp(ref: string, kind: string, name: string, data: unknown = {}, extra: Partial<RawOperation> = {}) {
  return op({ op: 'create', ref, kind, name, data_json: JSON.stringify(data), ...extra });
}

/** Seeds records directly through the transactional write path (no revision bump). */
export function seed(
  db: Db,
  campaignId: string,
  ops: RawOperation[],
  opts: { actor?: string; characterOwnerUserId?: string; constraints?: Constraint[] } = {},
): Record<string, string> {
  return db.transaction(() => {
    const plan = planBatch(db, ops, {
      campaignId,
      actorUserId: opts.actor ?? OWNER,
      constraints: opts.constraints ?? [],
      characterOwnerUserId: opts.characterOwnerUserId,
    });
    return writeBatch(db, campaignId, plan).created;
  })();
}

export function rec(db: Db, id: string): RecordRow | undefined {
  return db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
}

export function data(db: Db, id: string): Record<string, unknown> {
  return JSON.parse(rec(db, id)!.data_json) as Record<string, unknown>;
}

/** Snapshot of every row in the world tables for "nothing changed" assertions. */
export function snapshot(db: Db, campaignId?: string) {
  const where = campaignId ? 'WHERE campaign_id = ?' : '';
  const args = campaignId ? [campaignId] : [];
  return {
    campaigns: db.prepare(`SELECT * FROM campaigns ${campaignId ? 'WHERE id = ?' : ''} ORDER BY id`).all(...args),
    members: db.prepare(`SELECT * FROM members ${where} ORDER BY campaign_id, discord_user_id`).all(...args),
    records: db.prepare(`SELECT * FROM records ${where} ORDER BY id`).all(...args),
  };
}

export function saveArgs(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    expected_revision: 0,
    operations: [],
    public_reply: 'The wind howls.',
    gm_note: '',
    source_refs: [],
    roll_ids: [],
    ...over,
  });
}

export function readArgs(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ids: null,
    kind: null,
    name: null,
    parent_id: null,
    text: null,
    include_children: false,
    include_archived: false,
    event_record_id: null,
    event_query: null,
    cursor: null,
    limit: null,
    ...over,
  });
}

export function addMember(db: Db, campaignId: string, userId: string, characterId: string | null): void {
  db.prepare(`INSERT INTO members (campaign_id, discord_user_id, character_record_id, role, created_at) VALUES (?, ?, ?, 'player', ?)`).run(
    campaignId,
    userId,
    characterId,
    new Date().toISOString(),
  );
}
