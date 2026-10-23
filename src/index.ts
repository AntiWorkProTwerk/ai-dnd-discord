// Startup, configuration and lifecycle: one process, one database, one instance lock.
// Shutdown stops accepting work, lets active turns finish or record their state, then closes.
import '../scripts/env.js';
import { Events } from 'discord.js';
import { Semaphore } from './agent.js';
import { loadConfig, secretValues } from './config.js';
import { acquireInstanceLock, openDatabase } from './database.js';
import { attachHandlers, createDiscordClient, createDiscordDelivery } from './discord.js';
import { configureLog, log } from './log.js';
import { createProvider } from './providers.js';
import { TurnRunner } from './turns.js';

async function main(): Promise<void> {
  const config = loadConfig();
  configureLog(config.logLevel, secretValues(config));
  if (!config.discord.token) throw new Error('DISCORD_TOKEN is required to run the bot (see .env.example)');

  const releaseLock = acquireInstanceLock(config.dataDir);
  const db = openDatabase(config.databasePath);
  const provider = createProvider(config);
  log.info('starting', { provider: provider.name, model: provider.model, database: config.databasePath });

  const client = createDiscordClient();
  const runner = new TurnRunner({
    db,
    config,
    provider,
    delivery: createDiscordDelivery(client),
    modelLimiter: new Semaphore(config.limits.maxConcurrentModelTurns),
  });
  attachHandlers(client, { db, config, runner });

  client.once(Events.ClientReady, (c) => {
    log.info('connected to Discord', { user: c.user.tag, guilds: c.guilds.cache.size });
    runner
      .recover()
      .then((stats) => log.info('recovery complete', stats))
      .catch((err) => log.error('recovery failed', { err }));
    runner.startBackgroundRetries();
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    await runner.shutdown(30_000);
    await client.destroy();
    db.close();
    releaseLock();
    log.info('stopped cleanly');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }));

  try {
    await client.login(config.discord.token);
  } catch (err) {
    await client.destroy();
    db.close();
    releaseLock();
    throw err;
  }
}

main().catch((err) => {
  log.error('fatal startup error', { err });
  process.exit(1);
});
