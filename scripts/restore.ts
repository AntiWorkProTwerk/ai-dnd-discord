// Restores a backup made by `npm run backup`.
//
// Usage: npm run restore -- <backupId|path> [--target-dir <dir>] [--force]
//
//   <backupId|path>    a backup id (looked up in <DATA_DIR>/backups/) or a backup directory path
//   --target-dir <dir> restore into a separate directory (<dir>/rpg.sqlite + <dir>/sources) to
//                      test a backup without touching the live data
//   --force            live restore: skip the safety copy of the current database and sources
//                      target-dir restore: allow overwriting an existing <dir>/rpg.sqlite
//
// Refuses while a bot process holds the instance lock on the target data directory.
import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, secretValues } from '../src/config.js';
import { isInstanceLocked, restoreBackup } from '../src/database.js';
import { configureLog, redact } from '../src/log.js';

const USAGE = 'Usage: npm run restore -- <backupId|path> [--target-dir <dir>] [--force]';

function parseArgs(argv: string[]): { source: string; targetDir?: string; force: boolean } {
  let source: string | undefined;
  let targetDir: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--force') force = true;
    else if (a === '--target-dir') {
      targetDir = argv[++i];
      if (!targetDir) throw new Error(`--target-dir needs a directory\n${USAGE}`);
    } else if (a.startsWith('--target-dir=')) targetDir = a.slice('--target-dir='.length);
    else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}\n${USAGE}`);
    else if (!source) source = a;
    else throw new Error(`Unexpected argument ${a}\n${USAGE}`);
  }
  if (!source) throw new Error(USAGE);
  return { source, targetDir, force };
}

function resolveBackupDir(source: string, dataDir: string): string {
  const candidates = [path.resolve(source), path.join(dataDir, 'backups', source)];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
  }
  throw new Error(`No backup found for "${source}" (looked for manifest.json in: ${candidates.join(', ')})`);
}

function move(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

try {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  configureLog(config.logLevel, secretValues(config));
  const backupDir = resolveBackupDir(args.source, config.dataDir);

  const liveDataDir = config.dataDir;
  const separate = args.targetDir !== undefined && path.resolve(args.targetDir) !== liveDataDir;
  const targetDataDir = separate ? path.resolve(args.targetDir!) : liveDataDir;
  const targetDbPath = separate ? path.join(targetDataDir, 'rpg.sqlite') : config.databasePath;

  const pid = isInstanceLocked(targetDataDir);
  if (pid) {
    throw new Error(`Refusing to restore: a bot process (pid ${pid}) holds the instance lock in ${targetDataDir}. Stop the bot first.`);
  }

  console.log(`Backup:      ${backupDir}`);
  console.log(`Target DB:   ${targetDbPath}`);
  console.log(`Target data: ${targetDataDir}${separate ? ' (separate test restore)' : ' (LIVE)'}`);

  if (separate) {
    if (fs.existsSync(targetDbPath) && !args.force) {
      throw new Error(`${targetDbPath} already exists; choose an empty --target-dir or pass --force to overwrite it.`);
    }
  } else {
    const existing = ['', '-wal', '-shm'].map((s) => targetDbPath + s).filter((f) => fs.existsSync(f));
    const sourcesDir = path.join(targetDataDir, 'sources');
    if (args.force) {
      // Overwrite in place. Clear old sources so the restored set matches the backup exactly.
      fs.rmSync(sourcesDir, { recursive: true, force: true });
      if (existing.length) console.log('--force: overwriting the current database without a safety copy.');
    } else if (existing.length || fs.existsSync(sourcesDir)) {
      const safety = path.join(targetDataDir, `pre-restore-${stamp()}`);
      for (const f of existing) move(f, path.join(safety, path.basename(f)));
      if (fs.existsSync(sourcesDir)) move(sourcesDir, path.join(safety, 'sources'));
      console.log(`Moved the current database and sources to ${safety}`);
    }
  }

  const manifest = restoreBackup(backupDir, targetDbPath, targetDataDir);
  console.log(`Restored ${manifest.id} (created ${manifest.created_at}, schema version ${manifest.schema_version})`);
  console.log('Verification:');
  console.log('  checksums:       ok (database + ' + manifest.source_files.length + ' source files)');
  console.log('  integrity_check: ok');
  console.log(`  counts:          ${Object.entries(manifest.counts).map(([t, n]) => `${t}=${n}`).join(' ')} (match manifest)`);
  if (!separate) console.log('Start the bot normally; it will apply any newer migrations on open.');
} catch (err) {
  console.error(redact(`Restore failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
}
