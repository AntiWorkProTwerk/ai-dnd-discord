// Registers the bot's slash commands with Discord. Uses DISCORD_GUILD_ID when set (updates
// appear immediately in that server); otherwise registers globally (can take up to an hour).
// Usage: npm run register
import './env.js';
import { REST, Routes } from 'discord.js';
import { loadConfig, secretValues } from '../src/config.js';
import { buildCommands } from '../src/discord.js';
import { configureLog, redact } from '../src/log.js';

try {
  const config = loadConfig();
  configureLog(config.logLevel, secretValues(config));
  const { token, applicationId, guildId } = config.discord;
  if (!token || !applicationId) {
    throw new Error('DISCORD_TOKEN and DISCORD_APPLICATION_ID are required to register commands.');
  }
  const commands = buildCommands();
  const rest = new REST({ version: '10' }).setToken(token);
  const route = guildId ? Routes.applicationGuildCommands(applicationId, guildId) : Routes.applicationCommands(applicationId);
  const result = (await rest.put(route, { body: commands })) as { name: string }[];
  console.log(
    `Registered ${result.length} command(s) ${guildId ? `to guild ${guildId}` : 'globally (may take up to an hour to appear)'}: ` +
      result.map((c) => `/${c.name}`).join(', '),
  );
} catch (err) {
  console.error(redact(`Command registration failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
}
