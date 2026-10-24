// Applies pending SQL migrations to the configured database and prints the schema version.
// Usage: npm run migrate
import './env.js';
import { loadConfig, secretValues } from '../src/config.js';
import { migrate, openDatabase, schemaVersion } from '../src/database.js';
import { migrateSceneMaps } from '../src/maps.js';
import { configureLog, redact } from '../src/log.js';

try {
  const config = loadConfig();
  configureLog(config.logLevel, secretValues(config));
  const db = openDatabase(config.databasePath); // runs migrations on open
  // Battle maps used to live on scenes; they belong to places now.
  migrateSceneMaps(db);
  const late = migrate(db); // no-op unless a migration appeared between open and now
  const applied = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all() as {
    version: number;
    name: string;
    applied_at: string;
  }[];
  console.log(`Database: ${config.databasePath}`);
  for (const m of applied) console.log(`  ${String(m.version).padStart(3, '0')}  ${m.name}  (applied ${m.applied_at})`);
  if (late.length) console.log(`Applied now: ${late.join(', ')}`);
  console.log(`Schema version: ${schemaVersion(db)}`);
  db.close();
} catch (err) {
  console.error(redact(`Migration failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
}
