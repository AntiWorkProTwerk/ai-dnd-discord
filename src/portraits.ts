// Character portraits: one full-body reference image per character, painted locally once and
// reused so every illustration shows the same face, build and outfit. The portrait's source
// prompt is built from public sheet data only; a change in appearance makes it stale.
// Portraits are application-owned `_portrait` records (invisible to the model and never undone).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getRecord, newRecordId, nowIso, type Db } from './database.js';
import { heroLook, namer, publicData, visibleState } from './images.js';
import type { RecordRow } from './types.js';

export const PORTRAIT_KIND = '_portrait';
/** Bump when the portrait prompt template changes, so old portraits are repainted on next use. */
const TEMPLATE_VERSION = 'p2';
export const PORTRAIT_SIZE = { width: 768, height: 1024 };

export interface PortraitInfo {
  record_id: string;
  path: string;
  prompt: string;
  prompt_hash: string;
  seed: number;
  status: 'queued' | 'done' | 'failed';
  seconds?: number;
  error?: string;
  updated_at?: string;
}

export function portraitPathFor(dataDir: string, campaignId: string, recordId: string): string {
  return path.join(dataDir, 'images', campaignId, 'portraits', `${recordId}.png`);
}

export function portraitFor(db: Db, campaignId: string, recordId: string): (PortraitInfo & { rowId: string }) | undefined {
  const row = db.prepare(`SELECT id, data_json FROM records WHERE campaign_id = ? AND kind = ? AND name = ? AND archived_at IS NULL`).get(campaignId, PORTRAIT_KIND, recordId) as
    | { id: string; data_json: string }
    | undefined;
  return row ? { rowId: row.id, ...(JSON.parse(row.data_json) as PortraitInfo) } : undefined;
}

export function savePortrait(db: Db, campaignId: string, recordId: string, patch: Partial<PortraitInfo>): void {
  const cur = portraitFor(db, campaignId, recordId);
  const ts = nowIso();
  if (cur) {
    const { rowId, ...data } = cur;
    db.prepare('UPDATE records SET data_json = ?, version = version + 1, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...data, ...patch, updated_at: ts }), ts, rowId);
  } else {
    db.prepare(
      `INSERT INTO records (id, campaign_id, kind, name, parent_id, visibility, data_json, gm_notes_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'gm', ?, '{}', 1, ?, ?)`,
    ).run(newRecordId('portrait'), campaignId, PORTRAIT_KIND, recordId, JSON.stringify({ record_id: recordId, path: '', prompt: '', prompt_hash: '', seed: 0, status: 'queued', ...patch, updated_at: ts }), ts, ts);
  }
}

/**
 * A full-body reference portrait prompt from the record's public look and gear, or null for a
 * record players cannot see (hidden NPCs never get a portrait). Names are replaced by roles.
 */
export function buildPortraitPrompt(db: Db, record: RecordRow, style: string): string | null {
  if (!publicData(record) || record.archived_at) return null;
  const names = namer(db, record.campaign_id, new Map([[record.id, 'the character']]));
  const look = names(heroLook(record)).replace(/^(a|an|the)\s+/i, (m) => m.toLowerCase());
  const state = visibleState(db, record.campaign_id, record);
  const gear = state.includes('carrying ') ? names(state.slice(state.indexOf('carrying '))) : '';
  const who = record.kind === 'character' ? 'one adventurer' : 'one person';
  return [
    style,
    `Full-body portrait of ${who} standing alone, front three-quarter view, arms relaxed at the sides, the whole body in frame from head to feet`,
    look ? `The character is ${look}` : '',
    gear ? `The character is ${gear}` : '',
    'Plain neutral grey studio background, even soft lighting, clear face, two hands with five fingers each',
    'A wordless image with no caption, title or lettering anywhere',
  ]
    .filter(Boolean)
    .map((p) => p.replace(/[.\s]+$/, ''))
    .join('. ')
    .concat('.');
}

export function portraitHash(prompt: string): string {
  return crypto.createHash('sha256').update(`${TEMPLATE_VERSION}|${prompt}`).digest('hex').slice(0, 16);
}

/** The usable portrait for a record: painted, file present and matching the current look. */
export function currentPortrait(db: Db, campaignId: string, recordId: string, style: string): PortraitInfo | null {
  const record = getRecord(db, campaignId, recordId);
  if (!record) return null;
  const prompt = buildPortraitPrompt(db, record, style);
  const p = portraitFor(db, campaignId, recordId);
  if (!prompt || !p || p.status !== 'done' || !p.path || !fs.existsSync(p.path)) return null;
  return p.prompt_hash === portraitHash(prompt) ? p : null;
}
