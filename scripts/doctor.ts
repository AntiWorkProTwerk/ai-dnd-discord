// Startup doctor: checks the runtime, configuration, data directory, database, prompt file,
// Discord settings and model provider without spending money (the provider check is a free
// model-listing call, never a generation). Exits 1 if any check FAILs.
// Usage: npm run doctor
import './env.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, secretValues, type AppConfig } from '../src/config.js';
import { isInstanceLocked, openDatabase, projectRoot, schemaVersion, type Db } from '../src/database.js';
import { configureLog, redact } from '../src/log.js';
import { createProvider } from '../src/providers.js';

type Status = 'PASS' | 'WARN' | 'FAIL';
let failures = 0;
let warnings = 0;

function report(status: Status, check: string, detail: string): void {
  if (status === 'FAIL') failures++;
  if (status === 'WARN') warnings++;
  console.log(redact(`${status.padEnd(4)}  ${check.padEnd(16)} ${detail}`));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Redact anything that looks like a secret even before configuration parses.
configureLog('info', [process.env.DISCORD_TOKEN ?? '', process.env.OPENAI_API_KEY ?? '']);

// 1. Node.js version
{
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  const ok = maj > 22 || (maj === 22 && min >= 13);
  report(ok ? 'PASS' : 'FAIL', 'node', `v${process.versions.node}${ok ? '' : ' (need >= 22.13.0)'}`);
}

// 2. Configuration
let config: AppConfig | undefined;
try {
  config = loadConfig();
  configureLog(config.logLevel, secretValues(config));
  const p = config.provider;
  report('PASS', 'config', `provider=${p.kind} model=${p.model} data=${config.dataDir}`);
} catch (err) {
  report('FAIL', 'config', message(err).replace(/\n\s*/g, '; '));
}

if (config) {
  const root = projectRoot();

  // 3. Data directory writable
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const probe = path.join(config.dataDir, `.doctor-${process.pid}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    report('PASS', 'data dir', `${config.dataDir} is writable`);
  } catch (err) {
    report('FAIL', 'data dir', `${config.dataDir} is not writable: ${message(err)}`);
  }

  // 4. SQLite FTS5 support
  try {
    const mem = new Database(':memory:');
    mem.exec("CREATE VIRTUAL TABLE t USING fts5(body); INSERT INTO t(body) VALUES ('the brass lantern')");
    const hit = mem.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'lantern'").get() as { n: number };
    const version = (mem.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    mem.close();
    report(hit.n === 1 ? 'PASS' : 'FAIL', 'fts5', `SQLite ${version} full-text search ${hit.n === 1 ? 'works' : 'returned no match'}`);
  } catch (err) {
    report('FAIL', 'fts5', `FTS5 unavailable: ${message(err)}`);
  }

  // 5. Database: opens, migrations applied, integrity ok
  let db: Db | undefined;
  try {
    db = openDatabase(config.databasePath);
    const files = fs.readdirSync(path.join(root, 'migrations')).filter((f) => /^\d+_.+\.sql$/.test(f));
    const latest = Math.max(0, ...files.map((f) => Number(f.split('_')[0])));
    const version = schemaVersion(db);
    report(version === latest ? 'PASS' : 'FAIL', 'migrations', `schema version ${version} (latest migration ${latest})`);
    const integrity = db.pragma('integrity_check', { simple: true });
    report(integrity === 'ok' ? 'PASS' : 'FAIL', 'database', `${config.databasePath} integrity_check=${String(integrity)}`);
    const journal = db.pragma('journal_mode', { simple: true });
    if (String(journal).toLowerCase() !== 'wal') report('WARN', 'database', `journal_mode=${String(journal)} (expected wal)`);
  } catch (err) {
    report('FAIL', 'database', `${config.databasePath}: ${message(err)}`);
  } finally {
    db?.close();
  }

  // 6. GM prompt
  const promptFile = path.join(root, 'src', 'prompts', 'gm.md');
  try {
    const size = fs.statSync(promptFile).size;
    report(size > 0 ? 'PASS' : 'FAIL', 'gm prompt', `${promptFile} (${size} bytes)`);
  } catch {
    report('FAIL', 'gm prompt', `${promptFile} is missing`);
  }

  // 7. Discord settings (presence only; values are never printed)
  const d = config.discord;
  report(d.token ? 'PASS' : 'WARN', 'discord token', d.token ? 'DISCORD_TOKEN is set' : 'DISCORD_TOKEN is not set; the bot cannot connect');
  report(
    d.applicationId ? 'PASS' : 'WARN',
    'discord app id',
    d.applicationId ? 'DISCORD_APPLICATION_ID is set' : 'DISCORD_APPLICATION_ID is not set; commands cannot be registered',
  );
  report('PASS', 'command scope', d.guildId ? 'guild (DISCORD_GUILD_ID set; registration is instant)' : 'global (may take up to an hour to appear)');
  report(
    d.adminUserIds.length ? 'PASS' : 'WARN',
    'bot admins',
    d.adminUserIds.length ? `${d.adminUserIds.length} BOT_ADMIN_USER_IDS configured` : 'BOT_ADMIN_USER_IDS is empty',
  );

  // 8. Budget sanity
  if (config.provider.kind === 'openai') {
    if (config.limits.campaignMonthlyBudgetUsd === 0) {
      report('WARN', 'budget', 'LLM_PROVIDER=openai with CAMPAIGN_MONTHLY_BUDGET_USD=0; paid turns will be refused');
    } else {
      const g = config.limits.globalMonthlyBudgetUsd;
      report(
        'PASS',
        'budget',
        `$${config.limits.campaignMonthlyBudgetUsd}/campaign/month, $${config.limits.maxTurnCostUsd}/turn` +
          (g > 0 ? `, $${g}/month overall` : ''),
      );
    }
  }

  // 9. Model provider (free reachability/model-availability call)
  try {
    const provider = createProvider(config);
    const detail = await withTimeout(provider.check(), 20_000, 'provider check');
    report('PASS', 'provider', detail);
  } catch (err) {
    report('FAIL', 'provider', message(err));
  }

  // 10. Instance lock
  try {
    const pid = isInstanceLocked(config.dataDir);
    report('PASS', 'instance lock', pid ? `held by running bot pid ${pid}` : 'no running bot holds the lock');
  } catch (err) {
    report('WARN', 'instance lock', `could not read lock: ${message(err)}`);
  }
}

console.log(
  failures
    ? `\n${failures} check(s) FAILED, ${warnings} warning(s).`
    : `\nAll checks passed${warnings ? ` with ${warnings} warning(s)` : ''}.`,
);
process.exit(failures ? 1 : 0);
