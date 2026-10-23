// Seeds a campaign from a sample pack directory (rules.md, setting.md, adventure.md,
// config.json, starting-records.json) through the same import, approval and transactional record
// paths the Discord commands use. Used by `npm run seed-sample` and the live evaluations.
import fs from 'node:fs';
import path from 'node:path';
import { approveImport, claimProposal, prepareImport } from './campaign.js';
import { getCampaign, nowIso, type Db } from './database.js';
import { planBatch, writeBatch, type RawOperation } from './records.js';
import type { CampaignConfig, CampaignRow, SourceRole } from './types.js';
import { validateConstraintList } from './validation.js';

const FILES: [string, SourceRole][] = [
  ['rules.md', 'rules'],
  ['setting.md', 'setting'],
  ['adventure.md', 'adventure'],
];

export async function seedSamplePack(db: Db, dataDir: string, campaign: CampaignRow, packDir: string): Promise<CampaignRow> {
  for (const [file, role] of FILES) {
    const full = path.join(packDir, file);
    if (!fs.existsSync(full)) continue;
    const imp = await prepareImport(db, {
      campaign,
      userId: campaign.owner_user_id,
      requestId: `seed:${campaign.id}:${file}`,
      filename: file,
      bytes: fs.readFileSync(full),
      role,
      title: `${path.basename(packDir)} ${role}`,
      dataDir,
      maxBytes: 20 * 1024 * 1024,
      ttlMs: 3_600_000,
    });
    const claimed = claimProposal(db, { turnId: imp.turn.id, nonce: imp.nonce, campaignId: campaign.id, userId: campaign.owner_user_id, who: 'owner' });
    approveImport(db, claimed);
  }

  const configFile = path.join(packDir, 'config.json');
  const recordsFile = path.join(packDir, 'starting-records.json');
  db.transaction(() => {
    const c = getCampaign(db, campaign.id)!;
    let config = JSON.parse(c.config_json) as CampaignConfig;
    if (fs.existsSync(configFile)) {
      const pack = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Partial<CampaignConfig>;
      config = { ...config, ...pack, config_version: config.config_version + 1 };
      config.constraints = validateConstraintList(config.constraints ?? []);
    }
    let revision = c.revision;
    if (fs.existsSync(recordsFile)) {
      const ops = JSON.parse(fs.readFileSync(recordsFile, 'utf8')) as RawOperation[];
      const plan = planBatch(db, ops, { campaignId: c.id, actorUserId: c.owner_user_id, constraints: config.constraints });
      writeBatch(db, c.id, plan);
      revision += 1;
    }
    db.prepare('UPDATE campaigns SET config_json = ?, revision = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), revision, nowIso(), c.id);
  })();
  return getCampaign(db, campaign.id)!;
}
