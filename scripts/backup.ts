// Online backup via SQLite's backup API (WAL-safe; fine while the bot is running), plus the
// private source originals. Never includes .env or API keys.
// Usage: npm run backup
import './env.js';
import { loadConfig, secretValues } from '../src/config.js';
import { createBackup, openDatabase } from '../src/database.js';
import { configureLog, redact } from '../src/log.js';

try {
  const config = loadConfig();
  configureLog(config.logLevel, secretValues(config));
  const db = openDatabase(config.databasePath);
  const { id, dir, manifest } = await createBackup(db, config.dataDir);
  db.close();
  console.log(`Backup created: ${id}`);
  console.log(`  path:           ${dir}`);
  console.log(`  schema version: ${manifest.schema_version}`);
  console.log(`  sha256:         ${manifest.database_sha256}`);
  console.log(`  source files:   ${manifest.source_files.length}`);
  console.log(`  counts:         ${Object.entries(manifest.counts).map(([t, n]) => `${t}=${n}`).join(' ')}`);
  console.log(`Restore with: npm run restore -- ${id}   (test first with --target-dir <dir>)`);
} catch (err) {
  console.error(redact(`Backup failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
}
