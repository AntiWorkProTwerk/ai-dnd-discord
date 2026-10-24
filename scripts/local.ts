// Local terminal client: play a campaign without Discord. It drives the same turn runner,
// tools, records, budgets and workflows as the bot; replies print here instead of to a channel.
// Usage: npm run local [-- --pack lanternfall|ashen-oaths] [--fresh]
import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Semaphore, effectiveBudget } from '../src/agent.js';
import { createCampaign, setLifecycle, WorkflowError } from '../src/campaign.js';
import { loadConfig } from '../src/config.js';
import { acquireInstanceLock, getCampaignByChannel, getMember, openDatabase, parseConfig, projectRoot } from '../src/database.js';
import { migrateSceneMaps } from '../src/maps.js';
import { configureLog, configureLogFile } from '../src/log.js';
import { createProvider } from '../src/providers.js';
import { createMiniatureBuilder, createSceneRenderer, loadDioramaConfig } from '../src/diorama.js';
import { createWorkshopGenerator, ImageQueue, loadImageConfig } from '../src/images.js';
import { exec } from 'node:child_process';
import { renderSheet, renderUsage } from '../src/render.js';
import { seedSamplePack } from '../src/sample.js';
import { TurnRunner, type Button, type DeliveryPort, type DeliveryTarget, type OutboundMessage } from '../src/turns.js';

const GUILD = 'local';
const CHANNEL = 'local-table';
const OWNER = 'you';

const argv = process.argv.slice(2);
const pack = argv.includes('--pack') ? argv[argv.indexOf('--pack') + 1]! : 'lanternfall';
const dataDir = path.resolve(process.env.LOCAL_DATA_DIR ?? path.join(projectRoot(), 'data', 'local'));
if (argv.includes('--fresh')) fs.rmSync(dataDir, { recursive: true, force: true });

const config = loadConfig({ ...process.env, DATA_DIR: dataDir, DATABASE_PATH: path.join(dataDir, 'rpg.sqlite') });
configureLog('info', []);
configureLogFile(path.join(dataDir, 'logs'));
const releaseLock = acquireInstanceLock(dataDir);
const db = openDatabase(config.databasePath);
// Battle maps used to live on scenes; they belong to places now.
migrateSceneMaps(db);
const provider = createProvider(config);

let buttons: Button[] = [];
const C = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', yellow: '\x1b[33m', reset: '\x1b[0m' };

function show(message: OutboundMessage, ephemeral: boolean): void {
  const text = message.content
    .replace(/\*\*(.+?)\*\*/g, `${C.bold}$1${C.reset}`)
    .replace(/^-# (.*)$/gm, `${C.dim}  $1${C.reset}`);
  console.log(`\n${ephemeral ? `${C.dim}(private)${C.reset} ` : ''}${text}`);
  if (message.file?.path) {
    console.log(`${C.dim}image saved: ${message.file.path}${C.reset}`);
    // Open with the default Windows image viewer.
    if (process.platform === 'win32' && !process.env.LOCAL_NO_OPEN) exec(`start "" "${message.file.path}"`);
  } else if (message.file) console.log(`${C.dim}--- ${message.file.name} ---${C.reset}\n${message.file.content}`);
  if (message.buttons?.length) {
    buttons = message.buttons;
    console.log(message.buttons.map((b, i) => `${C.yellow}[${i + 1}] ${b.label}${C.reset}`).join('   '));
  }
}

const delivery: DeliveryPort = {
  async send(target: DeliveryTarget, message: OutboundMessage) {
    show(message, target.ephemeral);
    return `local-${Date.now()}`;
  },
};
const imageConfig = loadImageConfig();
const dioramaConfig = loadDioramaConfig();
// Paintings and 3D renders (scene, diorama, map) share one GPU queue: one heavy job at a time.
const gpuQueue = new ImageQueue(imageConfig.maxQueue);
const runner = new TurnRunner({
  db,
  config,
  provider,
  delivery,
  modelLimiter: new Semaphore(1),
  images: imageConfig.enabled ? { generator: createWorkshopGenerator(imageConfig), queue: gpuQueue, config: imageConfig } : undefined,
  diorama: dioramaConfig.enabled ? { queue: gpuQueue, miniatures: createMiniatureBuilder(dioramaConfig), scene: createSceneRenderer(dioramaConfig) } : undefined,
});

let campaign = getCampaignByChannel(db, GUILD, CHANNEL);
if (!campaign) {
  console.log(`Creating a local campaign from sample pack "${pack}"…`);
  const c = createCampaign(db, {
    guildId: GUILD, channelId: CHANNEL, ownerUserId: OWNER, title: pack, premise: '', rules_edition: '', tone: '', max_players: 6, boundaries: '', require_character_approval: false,
  });
  campaign = await seedSamplePack(db, dataDir, c, path.join(projectRoot(), 'sample-campaign', pack));
  setLifecycle(db, campaign.id, OWNER, 'start', `local-start-${Date.now()}`);
}
await runner.recover();

let user = OWNER;
let seq = 0;
const target = (ephemeral: boolean): DeliveryTarget => ({
  channelId: CHANNEL,
  ephemeral,
  interaction: { application_id: 'local', token: 'local', created_at: new Date().toISOString() },
});

const HELP = `
Commands (anything without a command word is a play action):
  character <text>   create your character with the GM (accept with the number shown)
  <text>             act or speak in the fiction (same as: play <text>)
  ask <question>     rules/world question, changes nothing
  sheet              your character sheet and inventory
  recap              story so far
  merge              make your storyline the main story in the main channel
  as <name>          switch to another player (e.g. "as bob"); "as you" switches back to the owner
  gm <instruction>   owner correction or world advance (preview, then confirm)
  configure <text>   owner configuration draft
  undo | usage | backup | pause | resume
  1, 2, …            press a button from the last message
  help | quit`;

async function handle(line: string): Promise<boolean> {
  const input = line.trim();
  if (!input) return true;
  const [word, ...rest] = input.split(/\s+/);
  const text = rest.join(' ');
  const cmd = word!.toLowerCase();
  campaign = getCampaignByChannel(db, GUILD, CHANNEL)!;

  if (/^\d+$/.test(input)) {
    const b = buttons[Number(input) - 1];
    if (!b) return void console.log('No such button.'), true;
    const [, kind, id, nonce] = b.customId.split(':');
    buttons = [];
    if (kind === 'side') {
      console.log(await runner.requestSideThread(Number(id), user, campaign.id));
      return true;
    }
    if (kind === 'map') {
      console.log(await runner.postMap(Number(id), campaign.id));
      return true;
    }
    if (kind === 'dio') {
      const r = runner.diorama(Number(id), campaign.id);
      console.log(r.message);
      if (r.done) await r.done;
      return true;
    }
    if (kind === 'say') {
      console.log('Type your reply as: character <text>');
      return true;
    }
    if (kind === 'img') {
      const r = runner.illustrate(Number(id), campaign.id);
      console.log(r.message);
      if (r.done) await r.done;
      return true;
    }
    console.log(await runner.confirm({ kind: kind!, turnId: Number(id), nonce: nonce!, userId: user, campaign, target: target(true) }));
    await runner.idle();
    return true;
  }
  switch (cmd) {
    case 'quit':
    case 'exit':
      return false;
    case 'help':
      console.log(HELP);
      return true;
    case 'as':
      user = (text || OWNER).toLowerCase();
      console.log(`You are now "${user}"${user === OWNER ? ' (campaign owner)' : ''}.`);
      return true;
    case 'sheet':
      console.log(renderSheet(db, campaign, user));
      return true;
    case 'usage':
      console.log(renderUsage(db, campaign, effectiveBudget(config, parseConfig(campaign), false)));
      return true;
    case 'merge':
      console.log(await runner.mergeToMain(campaign, user, CHANNEL));
      return true;
    case 'backup':
      console.log(await runner.backup(campaign, user));
      return true;
    case 'undo':
      show(runner.prepareUndo(campaign, user, `local-${Date.now()}-${++seq}`), true);
      return true;
    case 'pause':
    case 'resume':
    case 'start':
      try {
        console.log(setLifecycle(db, campaign.id, user, cmd, `local-${Date.now()}-${++seq}`).message);
      } catch (err) {
        console.log(err instanceof WorkflowError ? err.message : String(err));
      }
      return true;
  }

  const modes = { character: 'character', ask: 'ask', recap: 'recap', gm: 'gm', configure: 'configure', play: 'play' } as const;
  const mode = modes[cmd as keyof typeof modes] ?? 'play';
  const body = mode === 'play' && cmd !== 'play' ? input : mode === 'recap' ? 'recap' : text;
  if (!body) return void console.log(`Usage: ${cmd} <text>`), true;
  if ((mode === 'gm' || mode === 'configure') && campaign.owner_user_id !== user) return void console.log('Only the owner ("as you") can do that.'), true;
  if (mode === 'play' && !getMember(db, campaign.id, user)?.character_record_id) {
    return void console.log(`"${user}" has no character yet. Try: character <describe your hero>`), true;
  }
  if (mode === 'recap') {
    const cached = runner.cachedRecap(campaign.id);
    if (cached) return void console.log(`\n${cached}`), true;
  }
  stdout.write(`${C.dim}…the GM is thinking${C.reset}`);
  const ephemeral = !['play', 'recap'].includes(mode);
  const r = runner.submit({ campaign, userId: user, mode, requestId: `local-${Date.now()}-${++seq}`, text: body, target: target(ephemeral) });
  if (r.status !== 'queued') console.log(`\n${r.message}`);
  await runner.idle();
  return true;
}

console.log(`${C.cyan}${C.bold}${parseConfig(campaign).title}${C.reset} — local table (${provider.name} ${provider.model})`);
console.log(`Data: ${dataDir}`);
console.log(HELP);
if (!getMember(db, campaign.id, user)?.character_record_id) console.log(`\nStart with: character <describe your hero>`);

const rl = readline.createInterface({ input: stdin, output: stdout });
let inputEnded = false;
rl.on('close', () => (inputEnded = true));
const prompt = () => {
  if (inputEnded) return;
  rl.setPrompt(`\n${C.cyan}${user}>${C.reset} `);
  rl.prompt();
};
try {
  prompt();
  // Lines typed (or piped) while the GM is thinking are buffered and handled in order.
  for await (const line of rl) {
    if (!(await handle(line))) break;
    prompt();
  }
} finally {
  rl.close();
  await runner.shutdown(10_000);
  db.close();
  releaseLock();
}
