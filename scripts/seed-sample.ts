// Seeds a sample pack into the live database for a given Discord channel, as if the owner had
// run /rpg setup, imported and approved the pack, and accepted its configuration.
// Usage: npm run seed-sample -- --guild <id> --channel <id> --owner <user id> [--pack lanternfall] [--replace]
import './env.js';
import path from 'node:path';
import { createCampaign } from '../src/campaign.js';
import { loadConfig } from '../src/config.js';
import { isInstanceLocked, openDatabase, parseConfig, projectRoot } from '../src/database.js';
import { seedSamplePack } from '../src/sample.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (!v) {
    console.error(`Missing --${name}. Usage: npm run seed-sample -- --guild <id> --channel <id> --owner <user id> [--pack lanternfall|ashen-oaths]`);
    process.exit(1);
  }
  return v;
}

const config = loadConfig();
const pid = isInstanceLocked(config.dataDir);
if (pid) {
  console.error(`The bot is running (pid ${pid}). Stop it before seeding.`);
  process.exit(1);
}
const pack = arg('pack', 'lanternfall');
const db = openDatabase(config.databasePath);
const pack0 = path.join(projectRoot(), 'sample-campaign', pack);
if (process.argv.includes('--replace')) {
  // Archive (never delete) the channel's current campaign so a new one can take its place.
  const old = db
    .prepare(`UPDATE campaigns SET status = 'archived', updated_at = ? WHERE guild_id = ? AND channel_id = ? AND status <> 'archived'`)
    .run(new Date().toISOString(), arg('guild'), arg('channel'));
  if (old.changes) console.log('Archived the previous campaign in that channel (its records and history are kept).');
}
const campaign = createCampaign(db, {
  guildId: arg('guild'),
  channelId: arg('channel'),
  ownerUserId: arg('owner'),
  title: pack,
  premise: '',
  rules_edition: '',
  tone: '',
  max_players: 4,
  boundaries: '',
  require_character_approval: false,
});
const seeded = await seedSamplePack(db, config.dataDir, campaign, pack0);
console.log(`Seeded "${parseConfig(seeded).title}" as ${seeded.id} (status ${seeded.status}, source version ${seeded.active_source_version}).`);
console.log('Players can now run /rpg character; the owner starts play with /rpg start.');
db.close();
