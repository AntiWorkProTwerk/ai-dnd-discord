// SQLite access: opening, migrations, scoped queries, usage totals, backups and the
// single-instance lock. All writes use short synchronous transactions; nothing here is held
// open across a model call.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CampaignConfig, CampaignRow, MemberRow, RecordRow, TurnRow, TurnUsage } from './types.js';

export type Db = Database.Database;

/** Repository root (the directory holding package.json), whether running from src or dist. */
export function projectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'migrations'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate the project root (package.json + migrations/)');
}

export function nowIso(): string {
  return new Date().toISOString();
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export function randomToken(length = 10): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Stable server-assigned record ID, prefixed by a slug of the kind for readability. */
export function newRecordId(kind: string): string {
  const slug =
    kind
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 16) || 'rec';
  return `${slug}_${randomToken(8)}`;
}

export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL');
  migrate(db);
  return db;
}

export function migrate(db: Db, dir = path.join(projectRoot(), 'migrations')): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const ran: string[] = [];
  for (const f of files) {
    const version = Number(f.split('_')[0]);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(version, f, nowIso());
    })();
    ran.push(f);
  }
  return ran;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

// ---------------------------------------------------------------- campaigns and members

export function getCampaign(db: Db, id: string): CampaignRow | undefined {
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined;
}

export function getCampaignByChannel(db: Db, guildId: string, channelId: string): CampaignRow | undefined {
  return db
    .prepare(`SELECT * FROM campaigns WHERE guild_id = ? AND channel_id = ? AND status <> 'archived'`)
    .get(guildId, channelId) as CampaignRow | undefined;
}

export function parseConfig(c: CampaignRow): CampaignConfig {
  return JSON.parse(c.config_json) as CampaignConfig;
}

export function getMember(db: Db, campaignId: string, userId: string): MemberRow | undefined {
  return db
    .prepare('SELECT * FROM members WHERE campaign_id = ? AND discord_user_id = ?')
    .get(campaignId, userId) as MemberRow | undefined;
}

export function listMembers(db: Db, campaignId: string): MemberRow[] {
  return db.prepare('SELECT * FROM members WHERE campaign_id = ? ORDER BY created_at').all(campaignId) as MemberRow[];
}

// ---------------------------------------------------------------- records

/** Campaign-scoped lookup. An ID from another campaign is simply not found. */
export function getRecord(db: Db, campaignId: string, id: string): RecordRow | undefined {
  return db.prepare('SELECT * FROM records WHERE campaign_id = ? AND id = ?').get(campaignId, id) as RecordRow | undefined;
}

export function listChildren(db: Db, campaignId: string, parentId: string, includeArchived = false): RecordRow[] {
  return db
    .prepare(
      `SELECT * FROM records WHERE campaign_id = ? AND parent_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'}
       ORDER BY kind, name LIMIT 200`,
    )
    .all(campaignId, parentId) as RecordRow[];
}

// ---------------------------------------------------------------- turns

export interface NewTurn {
  campaign_id: string;
  request_id: string;
  actor_user_id: string;
  actor_character_id?: string | null;
  mode: TurnRow['mode'];
  status: TurnRow['status'];
  input_text?: string;
  base_revision?: number | null;
  source_version?: number | null;
  changes_json?: string | null;
  public_reply?: string | null;
  gm_note?: string | null;
  delivery_json?: string;
  confirm_nonce?: string | null;
  expires_at?: string | null;
}

/** Inserts a turn; returns the existing row instead when the request ID was already used. */
export function insertTurn(db: Db, t: NewTurn): { turn: TurnRow; created: boolean } {
  const existing = db.prepare('SELECT * FROM turns WHERE request_id = ?').get(t.request_id) as TurnRow | undefined;
  if (existing) return { turn: existing, created: false };
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO turns (campaign_id, request_id, actor_user_id, actor_character_id, mode, status, input_text,
         base_revision, source_version, changes_json, public_reply, gm_note, delivery_json, confirm_nonce, expires_at,
         created_at, updated_at)
       VALUES (@campaign_id, @request_id, @actor_user_id, @actor_character_id, @mode, @status, @input_text,
         @base_revision, @source_version, @changes_json, @public_reply, @gm_note, @delivery_json, @confirm_nonce,
         @expires_at, @ts, @ts)`,
    )
    .run({
      actor_character_id: null,
      input_text: '',
      base_revision: null,
      source_version: null,
      changes_json: null,
      public_reply: null,
      gm_note: null,
      delivery_json: '{}',
      confirm_nonce: null,
      expires_at: null,
      ...t,
      ts,
    });
  return { turn: getTurn(db, Number(info.lastInsertRowid))!, created: true };
}

export function getTurn(db: Db, id: number): TurnRow | undefined {
  return db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
}

const TURN_COLUMNS = new Set([
  'actor_character_id',
  'status',
  'base_revision',
  'source_version',
  'rolls_json',
  'tool_log_json',
  'changes_json',
  'before_images_json',
  'public_reply',
  'gm_note',
  'usage_json',
  'delivery_json',
  'confirm_nonce',
  'expires_at',
  'committed_revision',
  'reverted_by_turn_id',
  'attempts',
  'error',
]);

export function updateTurn(db: Db, id: number, fields: Partial<TurnRow>): void {
  const keys = Object.keys(fields).filter((k) => TURN_COLUMNS.has(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE turns SET ${sets}, updated_at = @__ts WHERE id = @__id`).run({ ...fields, __ts: nowIso(), __id: id });
}

export function emptyUsage(): TurnUsage {
  return { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, reserved_usd: 0 };
}

export function parseUsage(t: Pick<TurnRow, 'usage_json'>): TurnUsage {
  return { ...emptyUsage(), ...(JSON.parse(t.usage_json || '{}') as Partial<TurnUsage>) };
}

function monthStartIso(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

export interface UsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  reserved_usd: number;
  turns: number;
}

/**
 * Month-to-date totals from persisted turn usage. Reservations still recorded on a turn
 * (in flight, or kept after an uncertain failure) count against the budget.
 */
export function monthUsage(db: Db, campaignId?: string, date = new Date()): UsageTotals {
  const where = campaignId ? 'AND campaign_id = @campaignId' : '';
  const row = db
    .prepare(
      `SELECT COUNT(*) AS turns,
         COALESCE(SUM(json_extract(usage_json, '$.calls')), 0) AS calls,
         COALESCE(SUM(json_extract(usage_json, '$.input_tokens')), 0) AS input_tokens,
         COALESCE(SUM(json_extract(usage_json, '$.output_tokens')), 0) AS output_tokens,
         COALESCE(SUM(json_extract(usage_json, '$.cost_usd')), 0) AS cost_usd,
         COALESCE(SUM(json_extract(usage_json, '$.reserved_usd')), 0) AS reserved_usd
       FROM turns WHERE created_at >= @start
         AND (COALESCE(json_extract(usage_json, '$.calls'), 0) > 0 OR COALESCE(json_extract(usage_json, '$.reserved_usd'), 0) > 0) ${where}`,
    )
    .get({ start: monthStartIso(date), campaignId }) as UsageTotals;
  return row;
}

// ---------------------------------------------------------------- backups

export interface BackupManifest {
  id: string;
  created_at: string;
  schema_version: number;
  database_file: string;
  database_sha256: string;
  source_files: { path: string; sha256: string }[];
  counts: Record<string, number>;
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function tableCounts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ['campaigns', 'members', 'records', 'turns', 'sources']) {
    out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
}

function walkFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Online backup through SQLite's backup API (WAL-safe), plus the private source originals.
 * The environment file and API keys are never included.
 */
export async function createBackup(db: Db, dataDir: string): Promise<{ id: string; dir: string; manifest: BackupManifest }> {
  const id = `bk_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomToken(4)}`;
  const dir = path.join(dataDir, 'backups', id);
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, 'rpg.sqlite');
  await db.backup(dbFile);

  const srcRoot = path.join(dataDir, 'sources');
  const source_files: BackupManifest['source_files'] = [];
  for (const rel of walkFiles(srcRoot)) {
    const from = path.join(srcRoot, rel);
    const to = path.join(dir, 'sources', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    source_files.push({ path: rel.split(path.sep).join('/'), sha256: sha256File(to) });
  }

  // The copy inherits WAL mode from the live database; switch it to a self-contained single file
  // so no -wal/-shm side files are left in (or needed by) the backup directory.
  const check = new Database(dbFile);
  check.pragma('journal_mode = DELETE');
  const counts = tableCounts(check);
  const integrity = check.pragma('integrity_check', { simple: true });
  check.close();
  if (integrity !== 'ok') throw new Error(`Backup integrity check failed: ${String(integrity)}`);

  const manifest: BackupManifest = {
    id,
    created_at: nowIso(),
    schema_version: schemaVersion(db),
    database_file: 'rpg.sqlite',
    database_sha256: sha256File(dbFile),
    source_files,
    counts,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { id, dir, manifest };
}

/**
 * Restores a backup into a target database path and data directory. The target database must
 * not be open by a running bot (the caller checks the instance lock). Verifies checksums first.
 */
export function restoreBackup(backupDir: string, targetDbPath: string, targetDataDir: string): BackupManifest {
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')) as BackupManifest;
  const dbFile = path.join(backupDir, manifest.database_file);
  if (sha256File(dbFile) !== manifest.database_sha256) throw new Error('Backup database checksum mismatch');
  for (const f of manifest.source_files) {
    if (sha256File(path.join(backupDir, 'sources', f.path)) !== f.sha256) throw new Error(`Source checksum mismatch: ${f.path}`);
  }
  fs.mkdirSync(path.dirname(targetDbPath), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(targetDbPath + suffix)) fs.rmSync(targetDbPath + suffix);
  }
  fs.copyFileSync(dbFile, targetDbPath);
  for (const f of manifest.source_files) {
    const to = path.join(targetDataDir, 'sources', ...f.path.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(backupDir, 'sources', ...f.path.split('/')), to);
  }
  const check = new Database(targetDbPath);
  const integrity = check.pragma('integrity_check', { simple: true });
  const counts = tableCounts(check);
  check.close();
  if (integrity !== 'ok') throw new Error(`Restored database failed integrity check: ${String(integrity)}`);
  for (const [t, n] of Object.entries(manifest.counts)) {
    if (counts[t] !== n) throw new Error(`Restored ${t} count ${counts[t]} does not match manifest ${n}`);
  }
  return manifest;
}

// ---------------------------------------------------------------- single-instance lock

export function acquireInstanceLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, 'rpg.lock');
  const tryCreate = () => {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  };
  try {
    tryCreate();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (pid && isAlive(pid) && pid !== process.pid) {
      throw new Error(`Another bot process (pid ${pid}) holds ${lockFile}. Run only one instance per database.`);
    }
    fs.rmSync(lockFile, { force: true });
    tryCreate();
  }
  return () => {
    try {
      if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) fs.rmSync(lockFile, { force: true });
    } catch {
      /* already gone */
    }
  };
}

export function isInstanceLocked(dataDir: string): number | null {
  const lockFile = path.join(dataDir, 'rpg.lock');
  if (!fs.existsSync(lockFile)) return null;
  const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
  return pid && isAlive(pid) ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
