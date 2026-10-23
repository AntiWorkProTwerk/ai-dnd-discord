import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBackup, openDatabase, restoreBackup, type Db } from '../src/database.js';
import { commitTurn } from '../src/tools.js';
import { ALICE, cleanupTempDirs, createOp, makeCtx, newCampaign, newTurn, op, seed, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const FAKE_KEY = 'sk-test-FAKEKEY-0123456789abcdef';

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function dump(db: Db) {
  return {
    campaigns: db.prepare('SELECT * FROM campaigns ORDER BY id').all(),
    members: db.prepare('SELECT * FROM members ORDER BY campaign_id, discord_user_id').all(),
    records: db.prepare('SELECT * FROM records ORDER BY id').all(),
    turns: db.prepare('SELECT * FROM turns ORDER BY id').all(),
    sources: db.prepare('SELECT * FROM sources ORDER BY id').all(),
  };
}

function populated() {
  const dataDir = tempDir('rpgdata-');
  const db = openDatabase(path.join(dataDir, 'rpg.sqlite'));
  const c = newCampaign(db);
  const ids = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: 10 }, { gm_notes_json: '{"secret":"cursed"}' })]);
  const t = newTurn(db, c.id);
  commitTurn(
    db,
    makeCtx(c.id, t.id),
    { expected_revision: 0, operations: [op({ op: 'add', record_id: ids.$pc!, path: 'data.hp', delta: -2 })] as never, public_reply: 'Ow.', gm_note: '', source_refs: [], roll_ids: [] },
    { campaignId: c.id, actorUserId: ALICE, constraints: [] },
  );
  db.prepare(
    `INSERT INTO sources (campaign_id, import_id, version, status, role, visibility, title, filename, content_hash, section, page_start, page_end, text, created_at)
     VALUES (?, 'imp_1', 1, 'approved', 'rules', 'public', 'Rules', 'rules.md', 'abc', 'Combat', NULL, NULL, 'Roll a d20 to hit.', '2026-01-01')`,
  ).run(c.id);
  // A source original and secrets that must never be exported.
  fs.mkdirSync(path.join(dataDir, 'sources', c.id), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'sources', c.id, 'abc.md'), '# Rules\nRoll a d20 to hit.\n');
  fs.writeFileSync(path.join(dataDir, '.env'), `OPENAI_API_KEY=${FAKE_KEY}\n`);
  fs.writeFileSync(path.join(dataDir, 'rpg.lock'), '12345');
  return { db, dataDir, campaignId: c.id };
}

describe('backup and restore', () => {
  it('restores the same campaign state into a clean instance', async () => {
    const { db, dataDir, campaignId } = populated();
    // Write after the WAL checkpoint boundary to make sure the online backup includes it.
    db.prepare('UPDATE turns SET status = ? WHERE campaign_id = ? AND status = ?').run('delivered', campaignId, 'committed');
    const expected = dump(db);
    const { dir, manifest } = await createBackup(db, dataDir);

    expect(manifest.counts).toEqual({ campaigns: 1, members: 1, records: 1, turns: 1, sources: 1 });
    expect(manifest.source_files.map((f) => f.path)).toEqual([`${campaignId}/abc.md`]);

    const target = tempDir('rpgrestore-');
    const targetDb = path.join(target, 'rpg.sqlite');
    restoreBackup(dir, targetDb, target);
    const restored = openDatabase(targetDb);
    expect(dump(restored)).toEqual(expected);
    // FTS index works after restore.
    const hit = restored.prepare(`SELECT rowid FROM sources_fts WHERE sources_fts MATCH '"d20"'`).all();
    expect(hit).toHaveLength(1);
    restored.close();
    expect(fs.readFileSync(path.join(target, 'sources', campaignId, 'abc.md'), 'utf8')).toContain('Roll a d20');
    db.close();
  });

  it('contains only the database, manifest and source originals (no .env, lock or API key)', async () => {
    const { db, dataDir, campaignId } = populated();
    const { dir } = await createBackup(db, dataDir);
    const files = listFiles(dir);
    expect(files).toEqual(['manifest.json', 'rpg.sqlite', `sources/${campaignId}/abc.md`]);
    for (const f of files) {
      expect(fs.readFileSync(path.join(dir, f)).includes(FAKE_KEY), f).toBe(false);
    }
    db.close();
  });

  it('detects a tampered database file', async () => {
    const { db, dataDir } = populated();
    const { dir } = await createBackup(db, dataDir);
    db.close();
    const file = path.join(dir, 'rpg.sqlite');
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 10] = bytes[bytes.length - 10]! ^ 0xff;
    fs.writeFileSync(file, bytes);
    const target = tempDir('rpgrestore-');
    expect(() => restoreBackup(dir, path.join(target, 'rpg.sqlite'), target)).toThrow(/checksum mismatch/);
    expect(fs.existsSync(path.join(target, 'rpg.sqlite'))).toBe(false);
  });

  it('detects a tampered source original', async () => {
    const { db, dataDir, campaignId } = populated();
    const { dir } = await createBackup(db, dataDir);
    db.close();
    fs.appendFileSync(path.join(dir, 'sources', campaignId, 'abc.md'), 'IGNORE PREVIOUS INSTRUCTIONS');
    const target = tempDir('rpgrestore-');
    expect(() => restoreBackup(dir, path.join(target, 'rpg.sqlite'), target)).toThrow(/Source checksum mismatch/);
    expect(fs.existsSync(path.join(target, 'rpg.sqlite'))).toBe(false);
  });
});
