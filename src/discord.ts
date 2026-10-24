// Discord integration: one /rpg command, interaction routing, identity and permission checks,
// and the REST delivery adapter. Campaign and user identity always come from the verified
// interaction; ordinary channel chat is never read (only the Guilds intent is requested).
import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import fs from 'node:fs';
import type { AppConfig } from './config.js';
import { createCampaign, formatImportReport, isOwner, mayControlSeveral, prepareImport, setLifecycle, WorkflowError } from './campaign.js';
import { effectiveBudget } from './agent.js';
import { getCampaign, getCampaignByChannel, getMember, getRecord, getTurn, memberCharacterIds, parseConfig, type Db } from './database.js';
import { campaignIdForThread, privateThreadOwner } from './storylines.js';
import { log } from './log.js';
import { lookAround } from './look.js';
import { renderSheet, renderUsage, sanitize } from './render.js';
import { DeliveryError, interactionUsable, type DeliveryPort, type DeliveryTarget, type OutboundMessage, type TurnRunner } from './turns.js';
import type { CampaignRow, SourceRole } from './types.js';

export function buildCommands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const text = (desc: string) => (o: import('discord.js').SlashCommandStringOption) => o.setName('text').setDescription(desc).setRequired(true).setMaxLength(4000);
  const cmd = new SlashCommandBuilder()
    .setName('rpg')
    .setDescription('AI game master')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Create a campaign in this channel (you become its owner)')
        .addStringOption((o) => o.setName('title').setDescription('Campaign title').setRequired(true).setMaxLength(120))
        .addStringOption((o) => o.setName('rules_edition').setDescription('Rules/edition you will use, e.g. "Lanternfall 1.0"').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('premise').setDescription('Premise of the campaign').setRequired(false).setMaxLength(1500))
        .addStringOption((o) => o.setName('tone').setDescription('Tone, e.g. "grim but hopeful"').setRequired(false).setMaxLength(300))
        .addIntegerOption((o) => o.setName('max_players').setDescription('Maximum player characters (default 4)').setMinValue(1).setMaxValue(12).setRequired(false))
        .addStringOption((o) => o.setName('boundaries').setDescription('Content boundaries / lines and veils').setRequired(false).setMaxLength(1000))
        .addBooleanOption((o) => o.setName('approve_characters').setDescription('Require owner approval of new characters').setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName('import')
        .setDescription('Owner: upload reference material (Markdown, text, or PDF with a text layer)')
        .addAttachmentOption((o) => o.setName('attachment').setDescription('File to import').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('role')
            .setDescription('What this material is')
            .setRequired(true)
            .addChoices({ name: 'rules', value: 'rules' }, { name: 'setting', value: 'setting' }, { name: 'adventure', value: 'adventure' }),
        )
        .addStringOption((o) => o.setName('title').setDescription('Title (defaults to the file name)').setRequired(false).setMaxLength(120)),
    )
    .addSubcommand((s) => s.setName('configure').setDescription('Owner: draft rule/configuration changes for review').addStringOption(text('What to change')))
    .addSubcommand((s) => s.setName('start').setDescription('Owner: start the campaign'))
    .addSubcommand((s) => s.setName('pause').setDescription('Owner: pause play'))
    .addSubcommand((s) => s.setName('resume').setDescription('Owner: resume play'))
    .addSubcommand((s) =>
      s
        .setName('character')
        .setDescription('Create your character with the GM (several exchanges are fine)')
        .addStringOption(text('Describe your character or answer the GM')),
    )
    .addSubcommand((s) =>
      s
        .setName('play')
        .setDescription('Act, speak, fight, build, explore — anything in the fiction')
        .addStringOption(text('What your character does or says'))
        .addBooleanOption((o) => o.setName('illustrate').setDescription('Also paint the scene with the local image pipeline').setRequired(false))
        .addBooleanOption((o) => o.setName('side').setDescription('Start your own side story, in its own thread, with this action').setRequired(false))
        .addBooleanOption((o) => o.setName('private').setDescription('Whisper to the DM: a thought, secret question or quiet action, answered in your private thread').setRequired(false))
        .addBooleanOption((o) => o.setName('map').setDescription('Also post the map of the place after the reply').setRequired(false))
        .addBooleanOption((o) => o.setName('diorama').setDescription('Also post a 3D diorama of the place').setRequired(false))
        .addStringOption((o) => o.setName('as').setDescription('Which of your characters (if you control several)').setRequired(false).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('ask').setDescription('Ask a rules or public-world question (changes nothing)').addStringOption(text('Your question')))
    .addSubcommand((s) =>
      s
        .setName('sheet')
        .setDescription('Show your character sheet and inventory')
        .addStringOption((o) => o.setName('as').setDescription('Which of your characters (if you control several)').setRequired(false).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('look')
        .setDescription('See where you are: ways out, what is around you, who is here, what is known about the area')
        .addStringOption((o) => o.setName('as').setDescription('Which of your characters (if you control several)').setRequired(false).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('map')
        .setDescription("Show the map of the place your character is in")
        .addStringOption((o) => o.setName('as').setDescription('Which of your characters (if you control several)').setRequired(false).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('diorama')
        .setDescription("Show the place your character is in as a 3D diorama")
        .addStringOption((o) => o.setName('as').setDescription('Which of your characters (if you control several)').setRequired(false).setAutocomplete(true))
        .addBooleanOption((o) => o.setName('turntable').setDescription('A short rotating video instead of a still').setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName('portrait')
        .setDescription("Show your character's reference portrait (used to keep illustrations consistent)")
        .addStringOption((o) => o.setName('as').setDescription('Which of your characters (if you control several)').setRequired(false).setAutocomplete(true))
        .addBooleanOption((o) => o.setName('regenerate').setDescription('Paint a new portrait (or rebuild the miniature)').setRequired(false))
        .addBooleanOption((o) => o.setName('miniature').setDescription('Build the 3D miniature used in dioramas (about 3 minutes)').setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName('merge')
        .setDescription('Move a side thread back into the main channel and make it the main story (use it in the thread)')
        .addStringOption((o) => o.setName('as').setDescription('Which of your characters (if you control several)').setRequired(false).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('recap').setDescription('Recap the story so far'))
    .addSubcommand((s) => s.setName('gm').setDescription('Owner: correction, clarification, or world-advance instruction').addStringOption(text('Instruction to the GM')))
    .addSubcommand((s) => s.setName('undo').setDescription('Owner: undo the latest world turn'))
    .addSubcommand((s) => s.setName('usage').setDescription('Owner: model usage, spend, budget and recent failures'))
    .addSubcommand((s) => s.setName('backup').setDescription('Owner: write a backup on the bot host'));
  return [cmd.toJSON()];
}

// ---------------------------------------------------------------- delivery

const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;

function payload(message: OutboundMessage, ephemeral: boolean, withFlags: boolean) {
  const body: Record<string, unknown> = {
    content: message.content.slice(0, 2000),
    // Disable all mentions on sends and edits.
    allowed_mentions: { parse: [] },
    components: message.buttons?.length
      ? [{ type: 1, components: message.buttons.slice(0, 5).map((b) => ({ type: 2, style: STYLE[b.style], label: b.label, custom_id: b.customId })) }]
      : [],
  };
  if (withFlags && ephemeral) body.flags = MessageFlags.Ephemeral;
  const file = message.file;
  const files = file ? [{ name: file.name, data: file.path ? fs.readFileSync(file.path) : Buffer.from(file.content ?? '', 'utf8') }] : undefined;
  if (files) body.attachments = [{ id: 0, filename: file!.name }];
  if (message.replyTo) body.message_reference = { message_id: message.replyTo, fail_if_not_exists: false };
  return { body, files };
}

export function createDiscordDelivery(client: Client): DeliveryPort {
  return {
    /** Persistent storyline thread: 7-day auto-archive (archived threads stay readable and reopen). */
    async createThread(parentChannelId: string, name: string, isPrivate: boolean, memberUserIds: string[]): Promise<string> {
      const res = (await client.rest.post(Routes.threads(parentChannelId), {
        body: { name: name || 'Side story', type: isPrivate ? 12 : 11, auto_archive_duration: 10080, ...(isPrivate ? { invitable: false } : {}) },
      })) as { id: string };
      for (const userId of memberUserIds) {
        try {
          await client.rest.put(Routes.threadMembers(res.id, userId));
        } catch (err) {
          log.warn('could not add thread member', { thread: res.id, user: userId, err });
        }
      }
      return res.id;
    },

    async addThreadMember(threadId: string, userId: string): Promise<void> {
      await client.rest.put(Routes.threadMembers(threadId, userId));
    },

    async archiveThread(threadId: string): Promise<void> {
      await client.rest.patch(Routes.channel(threadId), { body: { archived: true } });
    },

    async send(target: DeliveryTarget, message: OutboundMessage, index: number, nonce: string): Promise<string> {
      try {
        if (target.interaction && interactionUsable(target)) {
          const { application_id: app, token } = target.interaction;
          try {
            if (index === 0) {
              const { body, files } = payload(message, target.ephemeral, false);
              const res = (await client.rest.patch(Routes.webhookMessage(app, token, '@original'), { body, files })) as { id: string };
              return res.id;
            }
            const { body, files } = payload(message, target.ephemeral, true);
            const res = (await client.rest.post(Routes.webhook(app, token), { body, files })) as { id: string };
            return res.id;
          } catch (err) {
            // Token rejected (expired or deleted reply): fall back to the channel for public output.
            if (!(err instanceof DiscordAPIError) || ![401, 404].includes(Number(err.status)) || target.ephemeral) throw err;
          }
        }
        if (target.ephemeral) throw new DeliveryError('private reply can no longer be delivered (interaction expired)', false);
        const { body, files } = payload(message, false, false);
        // Nonce + enforce_nonce lets Discord de-duplicate a retried send.
        const res = (await client.rest.post(Routes.channelMessages(target.channelId), {
          body: { ...body, nonce: nonce.slice(0, 25), enforce_nonce: true },
          files,
        })) as { id: string };
        return res.id;
      } catch (err) {
        if (err instanceof DeliveryError) throw err;
        if (err instanceof DiscordAPIError) {
          const status = Number(err.status);
          const retryable = status === 429 || status >= 500;
          throw new DeliveryError(`Discord HTTP ${status}: ${err.message.slice(0, 200)}`, retryable);
        }
        throw new DeliveryError(`Discord send failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`, true);
      }
    },
  };
}

// ---------------------------------------------------------------- interactions

export interface DiscordDeps {
  db: Db;
  config: AppConfig;
  runner: TurnRunner;
}

const OWNER_ONLY = new Set(['import', 'configure', 'start', 'pause', 'resume', 'gm', 'undo', 'usage', 'backup']);
const MODEL_MODES = { play: 'play', ask: 'ask', recap: 'recap', character: 'character', gm: 'gm', configure: 'configure' } as const;
const EPHEMERAL = new Set(['ask', 'character', 'gm', 'configure', 'import', 'usage', 'backup', 'sheet', 'look', 'undo', 'setup', 'start', 'pause', 'resume']);

function targetOf(i: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction, ephemeral: boolean): DeliveryTarget {
  return {
    channelId: i.channelId!,
    ephemeral,
    interaction: { application_id: i.applicationId, token: i.token, created_at: new Date(i.createdTimestamp).toISOString() },
  };
}

async function reply(i: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction, content: string, ephemeral = true, buttons?: OutboundMessage['buttons']): Promise<void> {
  const components = buttons?.length
    ? [{ type: 1, components: buttons.map((b) => ({ type: 2, style: STYLE[b.style], label: b.label, custom_id: b.customId })) }]
    : [];
  const opts = { content: content.slice(0, 2000), allowedMentions: { parse: [] }, components } as never;
  if (i.deferred || i.replied) await i.editReply(opts);
  else await i.reply({ ...(opts as object), flags: ephemeral ? MessageFlags.Ephemeral : undefined } as never);
}

/** The campaign for a channel, or for a storyline thread the bot created under it. */
export function campaignFor(db: Db, guildId: string, channelId: string) {
  const direct = getCampaignByChannel(db, guildId, channelId);
  if (direct) return direct;
  const viaThread = campaignIdForThread(db, channelId);
  return viaThread ? getCampaign(db, viaThread) : undefined;
}

export function canSetUp(i: ChatInputCommandInteraction, config: AppConfig): boolean {
  if (config.discord.adminUserIds.includes(i.user.id)) return true;
  return !!i.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
}

export async function handleCommand(deps: DiscordDeps, i: ChatInputCommandInteraction): Promise<void> {
  const { db, config, runner } = deps;
  if (!i.inGuild() || !i.channelId) return reply(i, 'Use this command in a server channel.');
  const sub = i.options.getSubcommand();
  const campaign = campaignFor(db, i.guildId, i.channelId);
  log.info('command', { sub, user: i.user.id, name: i.user.username, channel: i.channelId, campaign: campaign?.id, text: i.options.getString('text') ?? undefined, as: i.options.getString('as') ?? undefined });

  if (sub === 'setup') {
    if (!canSetUp(i, config)) return reply(i, 'You need the Manage Channels permission in this channel to create a campaign here.');
    if (campaign) return reply(i, 'This channel (or storyline thread) already belongs to a campaign.');
    try {
      const c = createCampaign(db, {
        guildId: i.guildId,
        channelId: i.channelId,
        ownerUserId: i.user.id,
        title: i.options.getString('title', true),
        rules_edition: i.options.getString('rules_edition', true),
        premise: i.options.getString('premise') ?? '',
        tone: i.options.getString('tone') ?? '',
        max_players: i.options.getInteger('max_players') ?? 4,
        boundaries: i.options.getString('boundaries') ?? '',
        require_character_approval: i.options.getBoolean('approve_characters') ?? false,
      });
      return reply(
        i,
        `Campaign **${sanitize(parseConfig(c).title)}** created in this channel; you are its owner.\nNext: \`/rpg import\` your rules/setting/adventure (or \`/rpg configure\` directly), then players use \`/rpg character\`, and you \`/rpg start\`.`,
      );
    } catch (err) {
      return reply(i, err instanceof WorkflowError ? err.message : 'Could not create the campaign.');
    }
  }

  if (!campaign) return reply(i, 'There is no campaign in this channel. An owner can create one with `/rpg setup`.');
  if (OWNER_ONLY.has(sub) && !isOwner(campaign, i.user.id)) return reply(i, 'Only the campaign owner can use that command.');

  let characterId: string | undefined;
  switch (sub) {
    case 'start':
    case 'pause':
    case 'resume': {
      try {
        const r = setLifecycle(db, campaign.id, i.user.id, sub, i.id);
        await reply(i, `Done: ${sub}.`);
        await i.followUp({ content: sanitize(r.message), allowedMentions: { parse: [] } });
      } catch (err) {
        await reply(i, err instanceof WorkflowError ? err.message : 'Could not change the campaign state.');
      }
      return;
    }
    case 'map': {
      const chosen = pickCharacter(db, campaign, i);
      if (chosen.error) return reply(i, chosen.error);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await runner.mapNow(campaign, i.user.id, chosen.id);
      return reply(i, r.channelId && r.channelId !== i.channelId ? `${r.message} See <#${r.channelId}>.` : r.message);
    }
    case 'diorama': {
      const chosen = pickCharacter(db, campaign, i);
      if (chosen.error) return reply(i, chosen.error);
      return reply(i, runner.dioramaNow(campaign, i.user.id, chosen.id, { turntable: i.options.getBoolean('turntable') ?? false }).message);
    }
    case 'portrait': {
      const chosen = pickCharacter(db, campaign, i);
      if (chosen.error) return reply(i, chosen.error);
      const id = chosen.id ?? getMember(db, campaign.id, i.user.id)?.character_record_id;
      if (!id) return reply(i, 'You have no character here yet: `/rpg character`.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (i.options.getBoolean('miniature')) {
        const m = runner.buildMiniature(campaign.id, id, { force: i.options.getBoolean('regenerate') ?? false });
        if (!m.done) return reply(i, m.message);
        if (m.message !== 'ready') await reply(i, m.message);
        const glb = await m.done;
        return reply(i, glb ? '🧊 The 3D miniature is ready; dioramas (🧊 or `/rpg diorama`) now show it in place of a plain figure.' : "🧊 Couldn't build the miniature (see the bot log). Try again later.");
      }
      const r = runner.paintPortrait(campaign.id, id, { force: i.options.getBoolean('regenerate') ?? false });
      if (!r.done) return reply(i, r.message);
      if (r.message !== 'ready') await reply(i, `${r.message} This takes about a minute.`);
      const p = await r.done;
      if (!p) return reply(i, "🖼️ Couldn't paint the portrait (see the bot log). Try again later.");
      const name = getRecord(db, campaign.id, id)?.name ?? 'Your character';
      await i.editReply({ content: `🖼️ **${sanitize(name)}**`, files: [{ attachment: p.path, name: 'portrait.png' }], allowedMentions: { parse: [] } });
      return;
    }
    case 'merge': {
      const chosen = pickCharacter(db, campaign, i);
      if (chosen.error) return reply(i, chosen.error);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      return reply(i, await runner.mergeToMain(campaign, i.user.id, i.channelId, chosen.id));
    }
    case 'look': {
      const chosen = pickCharacter(db, campaign, i);
      if (chosen.error) return reply(i, chosen.error);
      return reply(i, lookAround(db, campaign, i.user.id, chosen.id));
    }
    case 'sheet': {
      const chosen = pickCharacter(db, campaign, i);
      if (chosen.error) return reply(i, chosen.error);
      return reply(i, renderSheet(db, campaign, i.user.id, chosen.id));
    }
    case 'usage':
      return reply(i, renderUsage(db, campaign, effectiveBudget(config, parseConfig(campaign), false)));
    case 'backup': {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        return reply(i, await runner.backup(campaign, i.user.id));
      } catch (err) {
        log.error('backup failed', { err });
        return reply(i, 'Backup failed; see the bot log.');
      }
    }
    case 'undo': {
      const msg = runner.prepareUndo(campaign, i.user.id, i.id);
      return reply(i, msg.content, true, msg.buttons);
    }
    case 'import':
      return handleImport(deps, i, campaign);
    case 'recap': {
      const cached = runner.cachedRecap(campaign.id);
      if (cached) {
        await i.reply({ content: `**Recap**\n${sanitize(cached)}`.slice(0, 2000), allowedMentions: { parse: [] } });
        return;
      }
      break;
    }
    case 'play': {
      if (campaign.status !== 'active') return reply(i, `The campaign is ${campaign.status === 'setup' ? 'not started yet' : campaign.status}.`);
      const m = getMember(db, campaign.id, i.user.id);
      if (!m?.character_record_id) return reply(i, 'You need a character in this campaign first: `/rpg character`.');
      const chosen = pickCharacter(db, campaign, i);
      if (chosen.error) return reply(i, chosen.error);
      characterId = chosen.id;
      break;
    }
    case 'character': {
      const m = getMember(db, campaign.id, i.user.id);
      // The owner may create more characters; every /rpg character conversation makes a new one.
      if (m?.character_record_id && !mayControlSeveral(campaign, i.user.id)) return reply(i, 'You already have a character here. Use `/rpg sheet` to view it.');
      break;
    }
  }

  const mode = MODEL_MODES[sub as keyof typeof MODEL_MODES];
  if (!mode) return reply(i, 'Unknown command.');
  // Anything played inside your own private thread is a whisper too. A whisper sent from a public
  // channel is acknowledged privately; the answer itself goes to the private thread.
  const inOwnThread = privateThreadOwner(db, campaign.id, i.channelId) === i.user.id;
  const whispering = sub === 'play' && ((i.options.getBoolean('private') ?? false) || inOwnThread);
  const ephemeral = EPHEMERAL.has(sub) || (whispering && !inOwnThread);
  // Model work can take longer than Discord's 3-second window: defer first.
  await i.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  const text = sub === 'recap' ? 'recap' : i.options.getString('text', true);
  const illustrate = sub === 'play' ? (i.options.getBoolean('illustrate') ?? false) : false;
  const map = sub === 'play' ? (i.options.getBoolean('map') ?? false) : false;
  const diorama = sub === 'play' ? (i.options.getBoolean('diorama') ?? false) : false;
  const privateStory = whispering;
  const sideStory = sub === 'play' ? (i.options.getBoolean('side') ?? false) && !whispering : false;
  const r = runner.submit({ campaign, userId: i.user.id, mode, requestId: i.id, text, target: targetOf(i, ephemeral), illustrate, privateStory, sideStory, characterId, map, diorama });
  if (r.status !== 'queued') await reply(i, r.message ?? 'Request not accepted.');
}

async function handleImport(deps: DiscordDeps, i: ChatInputCommandInteraction, campaign: CampaignRow): Promise<void> {
  const { db, config } = deps;
  const att = i.options.getAttachment('attachment', true);
  const role = i.options.getString('role', true) as SourceRole;
  if (att.size > config.limits.maxImportBytes) return reply(i, `That file is larger than the ${(config.limits.maxImportBytes / 1048576).toFixed(0)} MB import limit.`);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  let bytes: Buffer;
  try {
    // Only Discord's own attachment CDN URL is fetched; links inside the file are never followed.
    const url = new URL(att.url);
    if (!/(^|\.)discordapp\.(com|net)$|(^|\.)discord\.com$/.test(url.hostname)) throw new Error('unexpected attachment host');
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return reply(i, `Could not download the attachment (${(err as Error).message}).`);
  }
  try {
    const r = await prepareImport(db, {
      campaign,
      userId: i.user.id,
      requestId: i.id,
      filename: att.name,
      bytes,
      role,
      title: i.options.getString('title') ?? undefined,
      dataDir: config.dataDir,
      maxBytes: config.limits.maxImportBytes,
      ttlMs: config.limits.confirmationTtlMs,
    });
    return reply(i, formatImportReport(r), true, [
      { customId: `rpg:imp:${r.turn.id}:${r.nonce}`, label: 'Approve import', style: 'primary' },
      { customId: `rpg:no:${r.turn.id}:${r.nonce}`, label: 'Reject', style: 'secondary' },
    ]);
  } catch (err) {
    return reply(i, err instanceof WorkflowError ? err.message : 'Import failed; see the bot log.');
  }
}

/** Resolves the `as` option to one of the user's own characters (by ID from autocomplete, or by name). */
function pickCharacter(db: Db, campaign: CampaignRow, i: ChatInputCommandInteraction): { id?: string; error?: string } {
  const wanted = i.options.getString('as')?.trim();
  if (!wanted) return {};
  const owned = memberCharacterIds(getMember(db, campaign.id, i.user.id));
  const match =
    owned.find((id) => id === wanted) ??
    owned.find((id) => getRecord(db, campaign.id, id)?.name.toLowerCase() === wanted.toLowerCase()) ??
    owned.find((id) => getRecord(db, campaign.id, id)?.name.toLowerCase().startsWith(wanted.toLowerCase()));
  if (match) return { id: match };
  const names = owned.map((id) => getRecord(db, campaign.id, id)?.name).filter(Boolean);
  return { error: names.length ? `You don't control a character called "${sanitize(wanted)}". Yours: ${names.map((n) => sanitize(n!)).join(', ')}.` : 'You have no character here yet: `/rpg character`.' };
}

/** Suggests the user's own characters for the `as` option. */
export async function handleAutocomplete(deps: DiscordDeps, i: AutocompleteInteraction): Promise<void> {
  const campaign = i.inGuild() && i.channelId ? campaignFor(deps.db, i.guildId, i.channelId) : undefined;
  const member = campaign ? getMember(deps.db, campaign.id, i.user.id) : undefined;
  const typed = String(i.options.getFocused()).toLowerCase();
  const choices = memberCharacterIds(member)
    .map((id) => ({ id, name: getRecord(deps.db, campaign!.id, id)?.name ?? id }))
    .filter((c) => c.name.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((c) => ({ name: (c.id === member?.character_record_id ? `${c.name} (active)` : c.name).slice(0, 100), value: c.id }));
  await i.respond(choices);
}

export async function handleButton(deps: DiscordDeps, i: ButtonInteraction): Promise<void> {
  const m = /^rpg:(\w+):(\d+):([a-z0-9]+)$/.exec(i.customId);
  if (!m || !i.inGuild() || !i.channelId) return;
  const campaign = campaignFor(deps.db, i.guildId, i.channelId);
  if (!campaign) return reply(i, 'No campaign in this channel.');
  log.info('button', { kind: m[1], turn: Number(m[2]), user: i.user.id, name: i.user.username });
  if (m[1] === 'say') {
    // Discord cannot reply to an ephemeral message, so the Reply button opens a text box instead.
    await i.showModal({
      custom_id: `rpg:sayf:${m[2]}:0`,
      title: 'Reply to the GM',
      components: [{ type: 1, components: [{ type: 4, custom_id: 'text', label: 'Your reply', style: 2, max_length: 4000, required: true }] }],
    } as never);
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const result =
    m[1] === 'img'
      ? deps.runner.illustrate(Number(m[2]), campaign.id).message
      : m[1] === 'map'
      ? await deps.runner.postMap(Number(m[2]), campaign.id)
      : m[1] === 'side'
      ? await deps.runner.requestSideThread(Number(m[2]), i.user.id, campaign.id)
      : m[1] === 'dio'
      ? deps.runner.diorama(Number(m[2]), campaign.id).message
      : m[1] === 'look'
      ? lookAround(deps.db, campaign, i.user.id)
      : await deps.runner.confirm({ kind: m[1]!, turnId: Number(m[2]), nonce: m[3]!, userId: i.user.id, campaign, target: targetOf(i, true) });
  log.info('button result', { kind: m[1], turn: Number(m[2]), user: i.user.id, result });
  await reply(i, result);
}

/** A reply typed into the Reply box continues that conversation as the same player's next message. */
export async function handleModal(deps: DiscordDeps, i: ModalSubmitInteraction): Promise<void> {
  const { db, runner } = deps;
  const m = /^rpg:sayf:(\d+):0$/.exec(i.customId);
  if (!m || !i.inGuild() || !i.channelId) return;
  const campaign = campaignFor(db, i.guildId, i.channelId);
  if (!campaign) return reply(i, 'No campaign in this channel.');
  const prior = getTurn(db, Number(m[1]));
  const text = i.fields.getTextInputValue('text');
  log.info('modal reply', { turn: Number(m[1]), user: i.user.id, name: i.user.username, text });
  if (!prior || prior.campaign_id !== campaign.id || prior.mode !== 'character') return reply(i, 'That conversation is no longer available.');
  if (prior.actor_user_id !== i.user.id) return reply(i, 'Only the player in this conversation can reply to it.');
  if (getMember(db, campaign.id, i.user.id)?.character_record_id && !mayControlSeveral(campaign, i.user.id)) return reply(i, 'You already have a character here. Use `/rpg sheet` to view it.');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const r = runner.submit({ campaign, userId: i.user.id, mode: 'character', requestId: i.id, text, target: targetOf(i, true) });
  if (r.status !== 'queued') await reply(i, r.message ?? 'Request not accepted.');
}

export function createDiscordClient(): Client {
  // Guilds only: slash commands do not need message content or member intents.
  return new Client({ intents: [GatewayIntentBits.Guilds] });
}

export function attachHandlers(client: Client, deps: DiscordDeps): void {
  client.on(Events.InteractionCreate, (interaction) => {
    const run = async () => {
      if (interaction.isChatInputCommand() && interaction.commandName === 'rpg') await handleCommand(deps, interaction);
      else if (interaction.isButton() && interaction.customId.startsWith('rpg:')) await handleButton(deps, interaction);
      else if (interaction.isAutocomplete() && interaction.commandName === 'rpg') await handleAutocomplete(deps, interaction);
      else if (interaction.isModalSubmit() && interaction.customId.startsWith('rpg:sayf:')) await handleModal(deps, interaction);
    };
    run().catch(async (err) => {
      log.error('interaction failed', { err });
      try {
        if (interaction.isRepliable()) {
          const content = 'Something went wrong handling that command. Nothing was changed.';
          if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
          else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      } catch {
        /* interaction already gone */
      }
    });
  });
}

