// Both shipped sample packs seed through the real import, approval and record paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCampaign } from '../src/campaign.js';
import { openDatabase, parseConfig, projectRoot } from '../src/database.js';
import { constraintViolations } from '../src/records.js';
import { seedSamplePack } from '../src/sample.js';
import { runTool } from '../src/tools.js';

describe.each(['lanternfall', 'ashen-oaths'])('sample pack %s', (pack) => {
  it('imports, approves, configures and creates valid starting records', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-sample-'));
    const db = openDatabase(path.join(dir, 'rpg.sqlite'));
    const c0 = createCampaign(db, { guildId: 'g', channelId: pack, ownerUserId: 'o', title: pack, premise: '', rules_edition: '', tone: '', max_players: 4, boundaries: '', require_character_approval: false });
    const c = await seedSamplePack(db, dir, c0, path.join(projectRoot(), 'sample-campaign', pack));
    const cfg = parseConfig(c);
    expect(c.active_source_version).toBe(3);
    expect(cfg.rules_digest.length).toBeGreaterThan(200);
    expect(constraintViolations(db, c.id, cfg.constraints)).toEqual([]);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE campaign_id = ?`).get(c.id) as { n: number };
    expect(n.n).toBeGreaterThan(5);
    db.prepare(`INSERT INTO turns (campaign_id, request_id, actor_user_id, mode, status, created_at, updated_at) VALUES (?, 'x', 'o', 'play', 'running', '', '')`).run(c.id);
    const out = JSON.parse(runTool({ db, ctx: { campaignId: c.id, turnId: 1, mode: 'play', actorUserId: 'o', actorCharacterId: null, view: 'gm', includePendingSources: false, saveMode: 'none', allowDice: false } }, 'search_reference', JSON.stringify({ query: 'character creation', role: 'rules', section: null, page_from: null, page_to: null, limit: 3 })).output);
    expect(out.results.length).toBeGreaterThan(0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
