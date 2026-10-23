// Turn runner: one logical queue per campaign, bounded admission, the agent run for each mode,
// stored-reply delivery with retries, owner confirmations, and restart recovery. A committed
// action is never run again; delivery retries only resend its saved reply.
import crypto from 'node:crypto';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { BudgetError, effectiveBudget, runAgent, Semaphore, type AgentResult } from './agent.js';
import {
  acceptCharacter,
  applyConfigProposal,
  applyCorrection,
  applyUndo,
  approveImport,
  characterDraftProblem,
  claimProposal,
  CONFIG_PROPOSAL_SCHEMA,
  configProposalValidator,
  describeUndo,
  findUndoTarget,
  formatConfigPreview,
  isOwner,
  markProposed,
  previewConfigProposal,
  rejectProposal,
  undoConflicts,
  WorkflowError,
  type ConfigProposal,
} from './campaign.js';
import {
  createBackup,
  getCampaign,
  getMember,
  memberCharacterIds,
  getRecord,
  getTurn,
  insertTurn,
  monthUsage,
  newRecordId,
  nowIso,
  parseConfig,
  parseUsage,
  playerCharacterOwners,
  updateTurn,
  type Db,
} from './database.js';
import type { RollRecord } from './dice.js';
import { log } from './log.js';
import type { ModelProvider } from './providers.js';
import type { Diff } from './records.js';
import { buildPortraitPrompt, currentPortrait, PORTRAIT_SIZE, portraitFor, portraitHash, portraitPathFor, savePortrait, type PortraitInfo } from './portraits.js';
import { dioramaPathFor, type DioramaRenderer } from './diorama.js';
import { mapPathFor, mapSnapshot, writeMapPng, type MapSnapshot } from './maps.js';
import { activeScenes, isMain, mainScene, participants, sceneData, saveThread, storylineKey, storylineOf, threadFor, worldClock } from './storylines.js';
import { buildScenePlan, buildScenePrompt, ImageBusyError, imagePathFor, logImageError, type ImageConfig, type ImageGenerator, type ImageQueue } from './images.js';
import { renderDiffs, renderPlay, sanitize, splitMessage } from './render.js';
import type { CampaignRow, DeliveryState, ToolContext, TurnMode, TurnRow } from './types.js';

// ---------------------------------------------------------------- delivery port

export interface Button {
  customId: string;
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
}

/** Opens a text box that continues this turn's conversation (same mode) as a new request. */
export function replyButton(turnId: number): Button {
  return { customId: `rpg:say:${turnId}:0`, label: 'Reply', style: 'primary' };
}

export interface OutboundMessage {
  content: string;
  buttons?: Button[];
  /** Text attachment (content) or a file on disk (path), e.g. a generated scene image. */
  file?: { name: string; content?: string; path?: string };
  /** Message ID this message replies to (channel sends only). */
  replyTo?: string;
}

export interface DeliveryTarget {
  channelId: string;
  /** Deferred interaction to edit/follow up while its token is valid. */
  interaction?: { application_id: string; token: string; created_at: string };
  ephemeral: boolean;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** Discord adapter (or a test fake). `index` 0 edits the deferred reply when possible. */
export interface DeliveryPort {
  send(target: DeliveryTarget, message: OutboundMessage, index: number, nonce: string): Promise<string>;
  /** Optional: side storylines get their own persistent thread under the campaign channel. */
  createThread?(parentChannelId: string, name: string, isPrivate: boolean, memberUserIds: string[]): Promise<string>;
  archiveThread?(threadId: string): Promise<void>;
}

/** Interaction tokens last 15 minutes; leave a margin. */
const INTERACTION_TTL_MS = 14 * 60_000;

export function interactionUsable(target: DeliveryTarget): boolean {
  return !!target.interaction && Date.now() - Date.parse(target.interaction.created_at) < INTERACTION_TTL_MS;
}

// ---------------------------------------------------------------- runner

export interface SubmitInput {
  campaign: CampaignRow;
  userId: string;
  mode: Extract<TurnMode, 'play' | 'ask' | 'recap' | 'character' | 'gm' | 'configure' | 'summary'>;
  requestId: string;
  text: string;
  target: DeliveryTarget;
  /** Play turns: paint the scene after the reply is delivered. */
  illustrate?: boolean;
  /** Play turns: if this action starts a side storyline, make its thread private. */
  privateStory?: boolean;
  /** Play turns: post the battle map after the reply. */
  map?: boolean;
  /** Play turns: post a 3D diorama render after the reply. */
  diorama?: boolean;
  /** Play/ask turns: which of the player's characters acts (default: their active character). */
  characterId?: string;
}

export interface SubmitResult {
  status: 'queued' | 'duplicate' | 'rejected' | 'done';
  turnId?: number;
  message?: string;
}

export interface RunnerDeps {
  db: Db;
  config: AppConfig;
  provider: ModelProvider;
  delivery: DeliveryPort;
  modelLimiter?: Semaphore;
  /** Optional local image pipeline; absent means illustrations are off. */
  images?: { generator: ImageGenerator; queue: ImageQueue; config: ImageConfig };
  /** 3D diorama renders (Blender); shares the GPU queue with paintings. */
  diorama?: { renderer: DioramaRenderer; queue: ImageQueue };
}

const READ_ONLY: TurnMode[] = ['ask', 'recap', 'summary'];

export class TurnRunner {
  private queues = new Map<string, Promise<void>>();
  private pending = new Map<string, number>();
  private accepting = true;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly limiter: Semaphore;

  constructor(private readonly deps: RunnerDeps) {
    this.limiter = deps.modelLimiter ?? new Semaphore(deps.config.limits.maxConcurrentModelTurns);
  }

  get db(): Db {
    return this.deps.db;
  }

  // ------------------------------------------------------------ queue

  /** Serialises work within a campaign; other campaigns run concurrently. */
  enqueue<T>(campaignId: string, job: () => Promise<T>): Promise<T> {
    this.pending.set(campaignId, (this.pending.get(campaignId) ?? 0) + 1);
    const prev = this.queues.get(campaignId) ?? Promise.resolve();
    const run = prev.then(job, job);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(campaignId, tail);
    void tail.then(() => {
      const n = (this.pending.get(campaignId) ?? 1) - 1;
      if (n <= 0) {
        this.pending.delete(campaignId);
        if (this.queues.get(campaignId) === tail) this.queues.delete(campaignId);
      } else this.pending.set(campaignId, n);
    });
    return run;
  }

  async idle(): Promise<void> {
    while (this.queues.size) await Promise.all([...this.queues.values()]);
  }

  // ------------------------------------------------------------ model turns

  submit(input: SubmitInput): SubmitResult {
    const { db, config } = this.deps;
    if (!this.accepting) return { status: 'rejected', message: 'The bot is shutting down; try again in a minute.' };
    const member = getMember(db, input.campaign.id, input.userId);
    // A player who controls several characters names one with `as`; it becomes their active character.
    if (input.characterId && input.characterId !== member?.character_record_id) {
      if (!memberCharacterIds(member).includes(input.characterId)) return { status: 'rejected', message: 'You do not control that character.' };
      db.prepare('UPDATE members SET character_record_id = ? WHERE campaign_id = ? AND discord_user_id = ?').run(input.characterId, input.campaign.id, input.userId);
    }
    const actingCharacter = input.mode === 'gm' || input.mode === 'configure' || input.mode === 'character' ? null : (input.characterId ?? member?.character_record_id ?? null);
    // Play turns belong to the actor's storyline; its replies go to that storyline's channel.
    const scene = input.mode === 'play' ? storylineOf(db, input.campaign.id, actingCharacter) : undefined;
    const storyChannel = scene ? this.channelForScene(input.campaign, scene.id) : input.target.channelId;
    const redirected = input.mode === 'play' && storyChannel !== input.target.channelId;
    const delivery: DeliveryState & Record<string, unknown> = {
      channel_id: storyChannel,
      interaction: input.target.interaction ? { ...input.target.interaction, ephemeral: input.target.ephemeral } : undefined,
      private: input.target.ephemeral,
      ...(input.illustrate && input.mode === 'play' ? { auto_image: true } : {}),
      ...(input.map && input.mode === 'play' ? { auto_map: true } : {}),
      ...(input.diorama && input.mode === 'play' ? { auto_diorama: true } : {}),
      ...(input.privateStory && input.mode === 'play' ? { private_story: true } : {}),
      ...(redirected ? { redirect_from: input.target.channelId } : {}),
    };
    const { turn, created } = insertTurn(db, {
      campaign_id: input.campaign.id,
      request_id: input.requestId,
      actor_user_id: input.userId,
      actor_character_id: actingCharacter,
      mode: input.mode,
      status: 'queued',
      input_text: input.text.slice(0, 4000),
      delivery_json: JSON.stringify(delivery),
      scene_id: scene?.id ?? null,
    });
    if (!created) return { status: 'duplicate', turnId: turn.id, message: `This request was already received (status: ${turn.status}).` };

    // The queue limit applies per storyline (or per player for private requests).
    const queued = (
      input.mode === 'play'
        ? db
            .prepare(`SELECT COUNT(*) AS n FROM turns WHERE campaign_id = ? AND mode = 'play' AND status IN ('queued', 'running') AND id <> ? AND scene_id IS ?`)
            .get(input.campaign.id, turn.id, scene?.id ?? null)
        : db
            .prepare(`SELECT COUNT(*) AS n FROM turns WHERE campaign_id = ? AND mode <> 'play' AND actor_user_id = ? AND status IN ('queued', 'running') AND id <> ?`)
            .get(input.campaign.id, input.userId, turn.id)
    ) as { n: number };
    if (queued.n >= config.limits.maxQueuedTurnsPerCampaign) {
      updateTurn(db, turn.id, { status: 'aborted', error: 'queue full' });
      return { status: 'rejected', turnId: turn.id, message: 'The GM is busy with several actions already. Wait for them to resolve, then try again.' };
    }
    const admin = input.mode === 'gm' || input.mode === 'configure';
    const limits = effectiveBudget(config, parseConfig(input.campaign), admin);
    if (this.deps.provider.paid) {
      const u = monthUsage(db, input.campaign.id);
      if (u.cost_usd + u.reserved_usd >= limits.campaignMonthlyUsd) {
        updateTurn(db, turn.id, { status: 'aborted', error: 'budget exhausted' });
        return { status: 'rejected', turnId: turn.id, message: "This campaign's monthly model budget is used up. The owner can check `/rpg usage`." };
      }
    }
    void this.enqueue(queueKey(getTurn(db, turn.id)!), () => this.process(turn.id)).catch((err) => log.error('turn job failed', { turn: turn.id, err }));
    return { status: 'queued', turnId: turn.id };
  }

  private toolContext(turn: TurnRow): ToolContext {
    const base = {
      campaignId: turn.campaign_id,
      turnId: turn.id,
      mode: turn.mode,
      actorUserId: turn.actor_user_id,
      actorCharacterId: turn.actor_character_id,
      includePendingSources: false,
    };
    switch (turn.mode) {
      case 'play':
        return { ...base, view: 'gm', saveMode: 'commit', allowDice: true };
      case 'gm':
        return { ...base, view: 'gm', saveMode: 'draft', allowDice: true };
      case 'character':
        return { ...base, view: 'player', saveMode: 'draft', allowDice: true };
      case 'configure':
        return { ...base, view: 'gm', saveMode: 'none', allowDice: false, includePendingSources: true };
      case 'summary':
        return { ...base, view: 'gm', saveMode: 'none', allowDice: false };
      default:
        return { ...base, view: 'player', saveMode: 'none', allowDice: false };
    }
  }

  /** Runs one queued turn. Safe to call for a turn that is no longer queued (no-op). */
  async process(turnId: number): Promise<void> {
    const { db } = this.deps;
    const turn = getTurn(db, turnId);
    if (!turn || turn.status !== 'queued') return;
    const campaign = getCampaign(db, turn.campaign_id);
    if (!campaign) return;
    if (turn.mode === 'play' && campaign.status !== 'active') {
      updateTurn(db, turn.id, { status: 'aborted', error: `campaign ${campaign.status}` });
      await this.deliverText(turn.id, `The campaign is ${campaign.status}; actions are not being resolved right now.`);
      return;
    }
    // Keep the character chosen at submit; otherwise use the active one (it may have been created after queuing).
    const member = getMember(db, campaign.id, turn.actor_user_id);
    const characterId =
      turn.mode === 'gm' || turn.mode === 'configure' || turn.mode === 'character' ? null : (turn.actor_character_id ?? member?.character_record_id ?? null);
    updateTurn(db, turn.id, {
      status: 'running',
      attempts: turn.attempts + 1,
      base_revision: campaign.revision,
      source_version: campaign.active_source_version,
      actor_character_id: characterId,
    });
    const started = Date.now();
    const running = getTurn(db, turn.id)!;
    const ctx = this.toolContext(running);
    const admin = running.mode === 'gm' || running.mode === 'configure';

    let result: AgentResult;
    try {
      result = await runAgent(
        { db, config: this.deps.config, provider: this.deps.provider, modelLimiter: this.limiter },
        {
          ctx,
          admin,
          tools: running.mode === 'recap' || running.mode === 'summary' ? 'none' : 'default',
          finalSchema:
            running.mode === 'configure' ? { name: 'configuration_proposal', schema: CONFIG_PROPOSAL_SCHEMA, validate: configProposalValidator } : undefined,
        },
      );
    } catch (err) {
      log.error('agent crashed', { turn: turn.id, err });
      result = { kind: 'failed', reason: err instanceof BudgetError ? err.message : 'internal error' };
    }
    await this.handleResult(getTurn(db, turn.id)!, result);
    const done = getTurn(db, turn.id)!;
    const u = parseUsage(done);
    log.info('turn', {
      turn: done.id,
      campaign: done.campaign_id,
      mode: done.mode,
      status: done.status,
      calls: u.calls,
      cost_usd: Number(u.cost_usd.toFixed(5)),
      seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      actor: done.actor_user_id,
      ...(done.scene_id ? { storyline: done.scene_id } : {}),
      input: done.input_text,
      ...(done.public_reply ? { reply: done.public_reply } : {}),
      ...(done.gm_note ? { gm_note: done.gm_note } : {}),
      ...(done.rolls_json !== '[]' ? { rolls: (JSON.parse(done.rolls_json) as RollRecord[]).map((r) => `${r.check_id}: ${r.expression}${r.modifier ? `${r.modifier >= 0 ? '+' : ''}${r.modifier}` : ''} = ${r.total}${r.success === null ? '' : r.success ? ' success' : ' failure'}`) } : {}),
      ...(done.error ? { error: done.error } : {}),
    });
  }

  private async handleResult(turn: TurnRow, result: AgentResult): Promise<void> {
    const { db, config } = this.deps;
    if (result.kind === 'failed') {
      const rolls = JSON.parse(turn.rolls_json) as RollRecord[];
      // Resume once with the same turn and its saved dice; never a fresh attempt with new dice.
      if (!result.budget && rolls.length && turn.attempts < 2 && (turn.mode === 'play' || turn.mode === 'gm')) {
        log.warn('retrying interrupted turn with saved checks', { turn: turn.id, reason: result.reason });
        updateTurn(db, turn.id, { status: 'queued', error: result.reason });
        return this.process(turn.id);
      }
      const needsOwner = rolls.length > 0 && turn.mode === 'play';
      updateTurn(db, turn.id, { status: needsOwner ? 'needs_attention' : 'aborted', error: result.reason.slice(0, 1000) });
      const what = turn.mode === 'play' ? 'Your action could not be resolved' : 'That request could not be completed';
      const extra = needsOwner ? ' Dice already rolled are kept; the owner has been asked to resolve it (`/rpg gm`).' : '';
      const reason = result.budget ? result.reason : `the GM model failed (${result.reason.split(':')[0]})`;
      await this.deliverText(turn.id, `⚠️ ${what}: ${reason}. Nothing in the world changed.${extra}`);
      return;
    }

    switch (turn.mode) {
      case 'play': {
        if (result.kind !== 'saved') return this.handleResult(turn, { kind: 'failed', reason: 'no save' });
        // Open threads first: an action that split the actor off is answered in its new thread
        // (essential for private side stories, whose first reply must not land in the main channel).
        await this.syncStorylines(turn.campaign_id, getTurn(db, turn.id)!);
        this.followActor(turn.id);
        this.storeMapSnapshot(turn.id);
        await this.deliverTurn(turn.id);
        const wants = JSON.parse(getTurn(db, turn.id)!.delivery_json) as { auto_map?: boolean; auto_diorama?: boolean };
        if (wants.auto_map) await this.postMap(turn.id);
        if (wants.auto_diorama) this.diorama(turn.id);
        this.maybeSummarize(turn.campaign_id);
        if ((JSON.parse(getTurn(db, turn.id)!.delivery_json) as { auto_image?: boolean }).auto_image) this.illustrate(turn.id);
        return;
      }
      case 'ask':
      case 'recap':
      case 'summary': {
        const text = result.kind === 'text' ? result.text : '';
        updateTurn(db, turn.id, { status: 'committed', public_reply: text.slice(0, 3800) });
        if (turn.mode === 'recap') this.storeDerived(turn.campaign_id, '_recap', 'public', text, latestEventId(db, turn.campaign_id));
        if (turn.mode === 'summary') {
          this.storeDerived(turn.campaign_id, '_gm_summary', 'gm', text, Number(turn.input_text) || 0);
          updateTurn(db, turn.id, { status: 'delivered' });
          return;
        }
        await this.deliverTurn(turn.id);
        return;
      }
      case 'character': {
        if (result.kind !== 'saved') return this.handleResult(turn, { kind: 'failed', reason: 'no draft' });
        const t = getTurn(db, turn.id)!;
        const draft = JSON.parse(t.changes_json ?? '{}') as { operations?: unknown[]; diffs?: Diff[] };
        if (!draft.operations?.length) {
          // A question from the GM: the Reply button continues the conversation without a new command.
          updateTurn(db, t.id, { status: 'committed' });
          const msgs = this.renderTurn(t);
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1]!, buttons: [replyButton(t.id)] };
          await this.deliverMessages(t.id, msgs);
          updateTurn(db, t.id, { status: 'delivered' });
          return;
        }
        db.prepare(`UPDATE turns SET status = 'superseded', confirm_nonce = NULL WHERE campaign_id = ? AND actor_user_id = ? AND mode = 'character' AND status = 'proposed' AND id <> ?`).run(
          t.campaign_id,
          t.actor_user_id,
          t.id,
        );
        const problem = characterDraftProblem(db, t);
        const sheet = renderDiffs(draft.diffs ?? [], 25).join('\n');
        if (problem) {
          updateTurn(db, t.id, { status: 'rejected', error: problem });
          const msgs = splitMessage(sanitize(`${t.public_reply ?? ''}\n\n⚠️ This draft cannot be accepted: ${problem}. Press Reply to revise it.`)).map((content) => ({ content }) as OutboundMessage);
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1]!, buttons: [replyButton(t.id)] };
          await this.deliverMessages(t.id, msgs);
          return;
        }
        const nonce = markProposed(db, t.id, config.limits.confirmationTtlMs * 4);
        await this.deliverMessages(t.id, [
          {
            content: `${sanitize(t.public_reply ?? '')}\n\n**Proposed records**\n${sanitize(sheet)}\n\nAccept to create this character, or use \`/rpg character\` again to ask for changes.`,
            buttons: [
              { customId: `rpg:chr:${t.id}:${nonce}`, label: 'Accept character', style: 'success' },
              { customId: `rpg:no:${t.id}:${nonce}`, label: 'Discard', style: 'secondary' },
              { ...replyButton(t.id), label: 'Ask for changes' },
            ],
          },
        ]);
        return;
      }
      case 'gm': {
        if (result.kind !== 'saved') return this.handleResult(turn, { kind: 'failed', reason: 'no draft' });
        const t = getTurn(db, turn.id)!;
        const draft = JSON.parse(t.changes_json ?? '{}') as { diffs?: Diff[] };
        const nonce = markProposed(db, t.id, config.limits.confirmationTtlMs);
        const lines = [
          '**Proposed owner change** (nothing is applied until you confirm)',
          `What: ${sanitize(t.gm_note ?? '(no description)')}`,
          '',
          ...(draft.diffs?.length ? renderDiffs(draft.diffs) : ['(no record changes)']),
          '',
          `Public announcement: ${sanitize(t.public_reply ?? '')}`,
        ];
        await this.deliverMessages(t.id, [
          {
            content: lines.join('\n'),
            buttons: [
              { customId: `rpg:cor:${t.id}:${nonce}`, label: 'Apply change', style: 'primary' },
              { customId: `rpg:no:${t.id}:${nonce}`, label: 'Cancel', style: 'secondary' },
            ],
          },
        ]);
        return;
      }
      case 'configure': {
        if (result.kind !== 'json') return this.handleResult(turn, { kind: 'failed', reason: 'no proposal' });
        const proposal = result.value as ConfigProposal;
        const campaign = getCampaign(db, turn.campaign_id)!;
        const preview = previewConfigProposal(db, campaign, proposal);
        updateTurn(db, turn.id, { changes_json: JSON.stringify({ ...proposal, base_config_version: parseConfig(campaign).config_version }) });
        const text = formatConfigPreview(campaign, proposal, preview);
        const ok = preview.violations.length === 0 && (preview.changed.length > 0 || preview.diffs.length > 0);
        let buttons: Button[] | undefined;
        if (ok) {
          const nonce = markProposed(db, turn.id, config.limits.confirmationTtlMs * 4);
          buttons = [
            { customId: `rpg:cfg:${turn.id}:${nonce}`, label: 'Apply configuration', style: 'primary' },
            { customId: `rpg:no:${turn.id}:${nonce}`, label: 'Discard', style: 'secondary' },
          ];
        } else {
          updateTurn(db, turn.id, { status: 'rejected', error: preview.violations.join('; ').slice(0, 1000) || 'no changes' });
        }
        const summary = text.length > 1800 ? `${text.slice(0, 1500)}…\n\n_Full draft attached._` : text;
        await this.deliverMessages(turn.id, [{ content: summary, buttons, file: text.length > 1800 ? { name: 'configuration-draft.md', content: text } : undefined }]);
        return;
      }
    }
  }

  /** Writes an application-owned derived record (recap / GM summary); not a world change. */
  private storeDerived(campaignId: string, kind: '_recap' | '_gm_summary', visibility: 'public' | 'gm', text: string, throughTurnId: number): void {
    const { db } = this.deps;
    const data = JSON.stringify({ text: text.slice(0, 6000), through_turn_id: throughTurnId, updated_at: nowIso() });
    const existing = db.prepare('SELECT id FROM records WHERE campaign_id = ? AND kind = ?').get(campaignId, kind) as { id: string } | undefined;
    if (existing) db.prepare('UPDATE records SET data_json = ?, version = version + 1, updated_at = ? WHERE id = ?').run(data, nowIso(), existing.id);
    else
      db.prepare(
        `INSERT INTO records (id, campaign_id, kind, name, parent_id, visibility, data_json, gm_notes_json, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, '{}', 1, ?, ?)`,
      ).run(newRecordId(kind.slice(1)), campaignId, kind, kind === '_recap' ? 'Public recap' : 'GM summary', visibility, data, nowIso(), nowIso());
  }

  /** Folds older history into the GM summary every ~24 play turns, under the same budget. */
  private maybeSummarize(campaignId: string): void {
    const { db } = this.deps;
    const rec = db.prepare(`SELECT data_json FROM records WHERE campaign_id = ? AND kind = '_gm_summary'`).get(campaignId) as { data_json: string } | undefined;
    const through = rec ? Number((JSON.parse(rec.data_json) as { through_turn_id?: number }).through_turn_id ?? 0) : 0;
    const ids = db
      .prepare(`SELECT id FROM turns WHERE campaign_id = ? AND id > ? AND mode IN ('play', 'correction', 'undo') AND status IN ('committed', 'delivered') ORDER BY id`)
      .all(campaignId, through) as { id: number }[];
    if (ids.length < 32) return;
    const upTo = ids[ids.length - 9]!.id; // keep the 8 most recent out of the summary window
    const campaign = getCampaign(db, campaignId);
    if (!campaign) return;
    this.submit({
      campaign,
      userId: campaign.owner_user_id,
      mode: 'summary',
      requestId: `summary:${campaignId}:${upTo}`,
      text: String(upTo),
      target: { channelId: campaign.channel_id, ephemeral: true },
    });
  }

  // ------------------------------------------------------------ cached recap

  /** Returns the cached recap when nothing public happened since it was written. */
  cachedRecap(campaignId: string): string | null {
    const { db } = this.deps;
    const rec = db.prepare(`SELECT data_json FROM records WHERE campaign_id = ? AND kind = '_recap'`).get(campaignId) as { data_json: string } | undefined;
    if (!rec) return null;
    const data = JSON.parse(rec.data_json) as { text?: string; through_turn_id?: number };
    return data.through_turn_id === latestEventId(db, campaignId) ? (data.text ?? null) : null;
  }

  // ------------------------------------------------------------ confirmations

  /**
   * Handles a confirmation button. Permissions are re-checked here, on the server, at click time;
   * the nonce is consumed atomically so a replayed or stale click cannot apply twice.
   */
  async confirm(args: { kind: string; turnId: number; nonce: string; userId: string; campaign: CampaignRow; target: DeliveryTarget }): Promise<string> {
    const { db, config } = this.deps;
    const { kind, turnId, nonce, userId, campaign } = args;
    return this.enqueue(`${campaign.id}:owner`, async () => {
      try {
        switch (kind) {
          case 'no': {
            const t = getTurn(db, turnId);
            rejectProposal(db, { turnId, nonce, campaignId: campaign.id, userId, who: t?.mode === 'character' ? 'actor' : 'owner' });
            return 'Discarded.';
          }
          case 'cfg': {
            const t = claimProposal(db, { turnId, nonce, campaignId: campaign.id, userId, who: 'owner' });
            const r = applyConfigProposal(db, t);
            await this.announce(campaign, `⚙️ The owner updated the campaign configuration${r.created ? ` and added ${r.created} starting records` : ''}.`);
            return `Configuration applied (${r.changed.join(', ') || 'no field changes'}${r.created ? `; ${r.created} records created` : ''}).`;
          }
          case 'cor': {
            const t = claimProposal(db, { turnId, nonce, campaignId: campaign.id, userId, who: 'owner' });
            applyCorrection(db, t);
            this.retarget(t.id, { channelId: campaign.channel_id, ephemeral: false });
            await this.deliverTurn(t.id);
            await this.syncStorylines(campaign.id, getTurn(db, t.id)!);
            return 'Change applied and announced.';
          }
          case 'chr':
          case 'chra': {
            const who = kind === 'chr' ? 'actor' : 'owner';
            const t = claimProposal(db, { turnId, nonce, campaignId: campaign.id, userId, who, fromStatus: kind === 'chr' ? 'proposed' : 'awaiting_owner' });
            const r = acceptCharacter(db, t, kind === 'chra', config.limits.confirmationTtlMs);
            if (r.status === 'awaiting_owner') {
              const sheet = renderDiffs((JSON.parse(t.changes_json ?? '{}') as { diffs?: Diff[] }).diffs ?? [], 20).join('\n');
              await this.announce(campaign, `📝 A new character draft is waiting for the owner's approval.\n${sanitize(sheet)}`, [
                { customId: `rpg:chra:${t.id}:${r.nonce}`, label: 'Approve (owner)', style: 'success' },
                { customId: `rpg:no:${t.id}:${r.nonce}`, label: 'Reject (owner)', style: 'danger' },
              ]);
              return 'Submitted to the campaign owner for approval.';
            }
            updateTurn(db, t.id, { status: 'delivered' });
            await this.announce(campaign, `🎉 **${sanitize(r.characterName ?? 'A new adventurer')}** joins the campaign!`);
            // Paint the reference portrait in the background; illustrations reuse it.
            if (r.characterId) this.paintPortrait(campaign.id, r.characterId);
            return `Character created. Use \`/rpg sheet\` to view it${campaign.status === 'active' ? ' and `/rpg play` to act' : ''}.`;
          }
          case 'imp': {
            const t = claimProposal(db, { turnId, nonce, campaignId: campaign.id, userId, who: 'owner' });
            const r = approveImport(db, t);
            let msg = `Approved "${r.title}". Active source version is now ${r.version}${r.replaced ? ` (replaced ${r.replaced} older sections)` : ''}.`;
            const fresh = getCampaign(db, campaign.id)!;
            if (!parseConfig(fresh).rules_digest) {
              const s = this.submit({
                campaign: fresh,
                userId,
                mode: 'configure',
                requestId: `adapt:${t.id}`,
                text:
                  'Draft the campaign configuration from the approved sources: rules digest, setting summary, field conventions, character-creation procedure, simple bookkeeping constraints, and a small starting situation. ' +
                  `The owner chose rules edition: "${parseConfig(fresh).rules_edition || 'not stated — ask'}".`,
                target: args.target,
              });
              if (s.status === 'queued') msg += '\nDrafting a configuration from it now; the proposal will appear here for your review.';
            }
            return msg;
          }
          case 'und': {
            const t = claimProposal(db, { turnId, nonce, campaignId: campaign.id, userId, who: 'owner' });
            const targetId = (JSON.parse(t.changes_json ?? '{}') as { target_turn_id: number }).target_turn_id;
            applyUndo(db, t, targetId);
            this.retarget(t.id, { channelId: campaign.channel_id, ephemeral: false });
            await this.deliverTurn(t.id);
            return 'Undone and announced.';
          }
          default:
            return 'Unknown action.';
        }
      } catch (err) {
        if (err instanceof WorkflowError) return `✖ ${err.message}`;
        log.error('confirmation failed', { kind, turnId, err });
        return '✖ Something went wrong applying that; nothing was changed.';
      }
    });
  }

  /** Owner-only undo preview: the latest reversible world turn and what reverting it changes. */
  prepareUndo(campaign: CampaignRow, userId: string, requestId: string): OutboundMessage {
    const { db, config } = this.deps;
    if (!isOwner(campaign, userId)) return { content: 'Only the campaign owner can undo.' };
    const target = findUndoTarget(db, campaign.id);
    if (!target) return { content: 'There is no committed world turn to undo.' };
    const conflicts = undoConflicts(db, target);
    if (conflicts.length) return { content: `Cannot undo turn ${target.id}; later changes would be overwritten:\n${conflicts.slice(0, 8).join('\n')}` };
    const { turn } = insertTurn(db, {
      campaign_id: campaign.id,
      request_id: requestId,
      actor_user_id: userId,
      mode: 'undo',
      status: 'running',
      input_text: `undo turn ${target.id}`,
      changes_json: JSON.stringify({ target_turn_id: target.id }),
    });
    const nonce = markProposed(db, turn.id, config.limits.confirmationTtlMs);
    return {
      content: describeUndo(db, target),
      buttons: [
        { customId: `rpg:und:${turn.id}:${nonce}`, label: 'Undo it', style: 'danger' },
        { customId: `rpg:no:${turn.id}:${nonce}`, label: 'Keep it', style: 'secondary' },
      ],
    };
  }

  /**
   * Paints a committed play turn with the local image pipeline and posts it as a reply to the
   * scene. Free (local GPU), never changes game state, one image at a time. Returns a short status
   * for the requester; `done` settles with the saved file path or an error message.
   */
  illustrate(turnId: number, campaignId?: string): { message: string; done: Promise<{ path?: string; error?: string }> | null } {
    const { db, config } = this.deps;
    const images = this.deps.images;
    if (!images) return { message: 'Image generation is turned off on this bot.', done: null };
    const turn = getTurn(db, turnId);
    if (!turn || turn.mode !== 'play' || (campaignId && turn.campaign_id !== campaignId)) return { message: 'That message is not a scene I can illustrate.', done: null };
    if (!['committed', 'delivered'].includes(turn.status)) return { message: 'That scene is not finished yet.', done: null };
    const state = JSON.parse(turn.delivery_json) as DeliveryState & { image?: { status: string; message_id?: string } };
    if (state.image?.status === 'done') return { message: '🎨 That scene is already illustrated — see the picture under it.', done: null };
    if (state.image?.status === 'queued') return { message: '🎨 Already painting that scene…', done: null };
    const setImage = (image: Record<string, unknown>) => {
      const cur = JSON.parse(getTurn(db, turnId)!.delivery_json) as Record<string, unknown>;
      updateTurn(db, turnId, { delivery_json: JSON.stringify({ ...cur, image }) });
    };
    const job = images.queue.run(async () => {
      const t = getTurn(db, turnId)!;
      const campaign = getCampaign(db, t.campaign_id)!;
      const sent = JSON.parse(t.delivery_json) as DeliveryState;
      const replyTo = sent.message_ids?.[0];
      // Post next to the scene it illustrates: its storyline thread, or the main channel.
      const imageChannel = sent.channel_id ?? campaign.channel_id;
      const who = t.actor_character_id ? (getRecord(db, t.campaign_id, t.actor_character_id)?.name ?? 'The party') : 'The party';
      try {
        const seed = (t.id * 7919) % 2_147_483_647;
        const tone = parseConfig(campaign).tone;
        let plan = buildScenePlan(db, t, images.config.style, tone);
        if (images.config.references !== 'off') {
          // Reuse each focus character's portrait (painting a missing one first, in this same job).
          for (const id of plan.focus) {
            const r = getRecord(db, t.campaign_id, id);
            if (r?.kind === 'character' && !currentPortrait(db, t.campaign_id, id, images.config.style)) await this.paintPortraitNow(t.campaign_id, id);
          }
          plan = buildScenePlan(db, t, images.config.style, tone, (id) => currentPortrait(db, t.campaign_id, id, images.config.style)?.path ?? null);
        }
        let prompt = plan.prompt;
        let out: { path: string; seconds: number };
        try {
          out = await images.generator.generate(prompt, seed, imagePathFor(config.dataDir, t), { refs: plan.refs, refRoot: path.join(config.dataDir, 'images') });
        } catch (err) {
          if (!plan.refs.length || err instanceof ImageBusyError) throw err;
          // A reference problem must not cost the picture: fall back to the text-only prompt.
          log.warn('reference illustration failed; retrying without references', { turn: t.id, err });
          prompt = buildScenePrompt(db, t, images.config.style, tone);
          plan = { ...plan, refs: [] };
          out = await images.generator.generate(prompt, seed, imagePathFor(config.dataDir, t));
        }
        const id = await this.deps.delivery.send(
          { channelId: imageChannel, ephemeral: false },
          { content: `🎨 **${sanitize(who)}** — ${sanitize(t.input_text.length > 140 ? `${t.input_text.slice(0, 140).replace(/\s+\S*$/, '')}…` : t.input_text)}`, file: { name: `scene-${t.id}.png`, path: out.path }, replyTo },
          0,
          `img${t.id}`,
        );
        setImage({ status: 'done', path: out.path, message_id: id, seconds: out.seconds, prompt, refs: plan.refs });
        log.info('image', { turn: t.id, seconds: out.seconds, path: out.path, refs: plan.refs, focus: plan.focus, prompt });
        return { path: out.path };
      } catch (err) {
        logImageError(turnId, err);
        const reason = err instanceof ImageBusyError ? 'the GPU is busy with another job' : 'the image pipeline failed';
        setImage({ status: 'failed', error: String((err as Error).message).slice(0, 300) });
        try {
          await this.deps.delivery.send({ channelId: imageChannel, ephemeral: false }, { content: `🎨 Couldn't paint that scene: ${reason}. Try the button again later.`, replyTo }, 0, `imgf${t.id}${Date.now() % 1000}`);
        } catch {
          /* channel unavailable; the error is logged */
        }
        return { error: reason };
      }
    });
    if (!job) return { message: '🎨 The painter is busy with several scenes; try again in a minute.', done: null };
    setImage({ status: 'queued' });
    const ahead = images.queue.size - 1;
    return { message: `🎨 Painting the scene${ahead > 0 ? ` (${ahead} ahead in line)` : ''}… it will appear under the scene shortly.`, done: job };
  }

  // ------------------------------------------------------------ portraits

  /**
   * Paints a record's reference portrait on the image queue, unless a current one exists.
   * `force` repaints with a new seed. `done` resolves to the portrait, or null on failure.
   */
  /** Paints a portrait directly, for use inside a job that already holds the image queue. */
  private async paintPortraitNow(campaignId: string, recordId: string): Promise<void> {
    const { db, config } = this.deps;
    const images = this.deps.images!;
    const record = getRecord(db, campaignId, recordId);
    const prompt = record ? buildPortraitPrompt(db, record, images.config.style) : null;
    if (!record || !prompt) return;
    const seed = portraitFor(db, campaignId, recordId)?.seed || (parseInt(portraitHash(recordId).slice(0, 8), 16) % 2_147_483_646) + 1;
    try {
      const out = await images.generator.generate(prompt, seed, portraitPathFor(config.dataDir, campaignId, recordId), PORTRAIT_SIZE);
      savePortrait(db, campaignId, recordId, { status: 'done', path: out.path, prompt, prompt_hash: portraitHash(prompt), seed, seconds: out.seconds, error: undefined });
      log.info('portrait', { record: recordId, name: record.name, seconds: out.seconds, path: out.path, seed, prompt });
    } catch (err) {
      logImageError(0, err);
    }
  }

  paintPortrait(campaignId: string, recordId: string, opts: { force?: boolean } = {}): { message: string; done: Promise<PortraitInfo | null> | null } {
    const { db, config } = this.deps;
    const images = this.deps.images;
    if (!images) return { message: 'Image generation is turned off on this bot.', done: null };
    const record = getRecord(db, campaignId, recordId);
    const prompt = record ? buildPortraitPrompt(db, record, images.config.style) : null;
    if (!record || !prompt) return { message: 'That character cannot have a portrait.', done: null };
    const current = currentPortrait(db, campaignId, recordId, images.config.style);
    if (current && !opts.force) return { message: 'ready', done: Promise.resolve(current) };
    const running = this.portraitJobs.get(recordId);
    if (running) return { message: `🖼️ Already painting ${sanitize(record.name)}'s portrait…`, done: running };
    const outPath = portraitPathFor(config.dataDir, campaignId, recordId);
    const prior = portraitFor(db, campaignId, recordId);
    const seed = opts.force ? crypto.randomInt(1, 2_147_483_646) : (prior?.seed || (parseInt(portraitHash(recordId).slice(0, 8), 16) % 2_147_483_646) + 1);
    const job = images.queue.run(async () => {
      try {
        const out = await images.generator.generate(prompt, seed, outPath, PORTRAIT_SIZE);
        savePortrait(db, campaignId, recordId, { status: 'done', path: out.path, prompt, prompt_hash: portraitHash(prompt), seed, seconds: out.seconds, error: undefined });
        log.info('portrait', { record: recordId, name: record.name, seconds: out.seconds, path: out.path, seed, prompt });
        return portraitFor(db, campaignId, recordId) ?? null;
      } catch (err) {
        logImageError(0, err);
        savePortrait(db, campaignId, recordId, { status: 'failed', error: String((err as Error).message).slice(0, 300) });
        return null;
      } finally {
        this.portraitJobs.delete(recordId);
      }
    });
    if (!job) return { message: '🖼️ The painter is busy with several pictures; try again in a minute.', done: null };
    savePortrait(db, campaignId, recordId, { status: 'queued', prompt, prompt_hash: portraitHash(prompt), seed, path: outPath });
    this.portraitJobs.set(recordId, job);
    const ahead = images.queue.size - 1;
    return { message: `🖼️ Painting ${sanitize(record.name)}'s portrait${ahead > 0 ? ` (${ahead} ahead in line)` : ''}…`, done: job };
  }

  // ------------------------------------------------------------ battle maps

  /** Keeps the battle map as it was at this turn, so its Map button shows that moment. */
  private storeMapSnapshot(turnId: number): void {
    const { db } = this.deps;
    const t = getTurn(db, turnId)!;
    const scene = (t.scene_id ? getRecord(db, t.campaign_id, t.scene_id) : undefined) ?? storylineOf(db, t.campaign_id, t.actor_character_id);
    const snapshot = mapSnapshot(db, t.campaign_id, scene);
    if (!snapshot) return;
    const d = JSON.parse(t.delivery_json) as Record<string, unknown>;
    updateTurn(db, turnId, { delivery_json: JSON.stringify({ ...d, map_snapshot: snapshot }) });
  }

  /** Posts a turn's battle map under its reply (the Map button, or `map:true`). No AI, no GPU. */
  async postMap(turnId: number, campaignId?: string): Promise<string> {
    const { db, config } = this.deps;
    const t = getTurn(db, turnId);
    if (!t || t.mode !== 'play' || (campaignId && t.campaign_id !== campaignId)) return 'That message has no battle map.';
    const d = JSON.parse(t.delivery_json) as DeliveryState & { map_snapshot?: MapSnapshot; media?: { map?: { status: string } } };
    if (!d.map_snapshot) return 'There is no battle map for that scene yet. The GM sets one up when a fight starts or position matters.';
    if (d.media?.map?.status === 'done') return '🗺️ That map is already posted under the scene.';
    const channelId = d.channel_id ?? getCampaign(db, t.campaign_id)!.channel_id;
    try {
      const file = writeMapPng(d.map_snapshot, mapPathFor(config.dataDir, t));
      const id = await this.deps.delivery.send({ channelId, ephemeral: false }, { content: `🗺️ **${sanitize(d.map_snapshot.scene_name)}**`, file: { name: `map-${t.id}.png`, path: file }, replyTo: d.message_ids?.[0] }, 0, `map${t.id}`);
      const cur = JSON.parse(getTurn(db, turnId)!.delivery_json) as Record<string, unknown>;
      updateTurn(db, turnId, { delivery_json: JSON.stringify({ ...cur, media: { ...((cur.media as object) ?? {}), map: { status: 'done', message_id: id, path: file } } }) });
      log.info('map', { turn: t.id, scene: d.map_snapshot.scene_id, tokens: d.map_snapshot.tokens.length, path: file });
      return '🗺️ Map posted under the scene.';
    } catch (err) {
      log.warn('map failed', { turn: t.id, err });
      return "🗺️ Couldn't draw that map; see the bot log.";
    }
  }

  /**
   * Renders a turn's battle map as a 3D diorama in Blender and posts it under the reply (the
   * Diorama button, or `diorama:true`). `turntable` posts a short rotating video instead.
   */
  diorama(turnId: number, campaignId?: string, opts: { turntable?: boolean } = {}): { message: string; done: Promise<{ path?: string; error?: string }> | null } {
    const { db, config } = this.deps;
    const dio = this.deps.diorama;
    if (!dio) return { message: '3D dioramas are turned off on this bot.', done: null };
    const t = getTurn(db, turnId);
    if (!t || t.mode !== 'play' || (campaignId && t.campaign_id !== campaignId)) return { message: 'That message has no battle map.', done: null };
    const d = JSON.parse(t.delivery_json) as DeliveryState & { map_snapshot?: MapSnapshot; media?: { diorama?: { status: string } } };
    if (!d.map_snapshot) return { message: 'There is no battle map for that scene yet, so there is nothing to build.', done: null };
    if (d.media?.diorama?.status === 'done' && !opts.turntable) return { message: '🧊 That diorama is already posted under the scene.', done: null };
    if (d.media?.diorama?.status === 'queued') return { message: '🧊 Already building that diorama…', done: null };
    const channelId = d.channel_id ?? getCampaign(db, t.campaign_id)!.channel_id;
    const snapshot = d.map_snapshot;
    const setState = (diorama: Record<string, unknown>) => {
      const cur = JSON.parse(getTurn(db, turnId)!.delivery_json) as Record<string, unknown>;
      updateTurn(db, turnId, { delivery_json: JSON.stringify({ ...cur, media: { ...((cur.media as object) ?? {}), diorama } }) });
    };
    const job = dio.queue.run(async () => {
      try {
        const out = await dio.renderer.render(snapshot, dioramaPathFor(config.dataDir, t), opts.turntable ? { turntable: dioramaPathFor(config.dataDir, t, 'mp4') } : {});
        const file = out.video ? { name: `diorama-${t.id}.mp4`, path: out.video } : { name: `diorama-${t.id}.png`, path: out.path };
        const id = await this.deps.delivery.send({ channelId, ephemeral: false }, { content: `🧊 **${sanitize(snapshot.scene_name)}**`, file, replyTo: d.message_ids?.[0] }, 0, `dio${t.id}${out.video ? 'v' : ''}`);
        setState({ status: 'done', message_id: id, path: file.path, seconds: out.seconds });
        log.info('diorama', { turn: t.id, seconds: out.seconds, path: file.path, tokens: snapshot.tokens.length });
        return { path: file.path };
      } catch (err) {
        log.warn('diorama failed', { turn: t.id, err });
        setState({ status: 'failed', error: String((err as Error).message).slice(0, 300) });
        const reason = err instanceof ImageBusyError ? 'the GPU is busy with another job' : 'Blender failed';
        try {
          await this.deps.delivery.send({ channelId, ephemeral: false }, { content: `🧊 Couldn't build that diorama: ${reason}. Try the button again later.`, replyTo: d.message_ids?.[0] }, 0, `diof${t.id}${Date.now() % 1000}`);
        } catch {
          /* channel unavailable; the error is logged */
        }
        return { error: reason };
      }
    });
    if (!job) return { message: '🧊 The GPU queue is full; try again in a minute.', done: null };
    setState({ status: 'queued' });
    return { message: `🧊 Building the diorama${opts.turntable ? ' turntable' : ''}… it will appear under the scene shortly.`, done: job };
  }

  /** `/rpg diorama`: the current battle map of the caller's storyline as a 3D diorama, in its channel. */
  dioramaNow(campaign: CampaignRow, userId: string, characterId?: string, opts: { turntable?: boolean } = {}): { message: string; channelId?: string; done: Promise<unknown> | null } {
    const { db, config } = this.deps;
    const dio = this.deps.diorama;
    if (!dio) return { message: '3D dioramas are turned off on this bot.', done: null };
    const actor = characterId ?? getMember(db, campaign.id, userId)?.character_record_id ?? null;
    const scene = storylineOf(db, campaign.id, actor) ?? mainScene(db, campaign.id);
    const snapshot = mapSnapshot(db, campaign.id, scene);
    if (!scene || !snapshot) return { message: 'Your scene has no battle map yet, so there is nothing to build.', done: null };
    const channelId = this.channelForScene(campaign, scene.id);
    const base = path.join(config.dataDir, 'images', campaign.id, `diorama-${scene.id}-${Date.now()}`);
    const job = dio.queue.run(async () => {
      try {
        const out = await dio.renderer.render(snapshot, `${base}.png`, opts.turntable ? { turntable: `${base}.mp4` } : {});
        const file = out.video ? { name: 'diorama.mp4', path: out.video } : { name: 'diorama.png', path: out.path };
        await this.deps.delivery.send({ channelId, ephemeral: false }, { content: `🧊 **${sanitize(snapshot.scene_name)}** (current)`, file }, 0, `dionow${scene.id}${Date.now()}`);
        log.info('diorama', { scene: scene.id, seconds: out.seconds, path: file.path, by: userId });
      } catch (err) {
        log.warn('diorama failed', { scene: scene.id, err });
        await this.safeSend(channelId, `🧊 Couldn't build the diorama: ${err instanceof ImageBusyError ? 'the GPU is busy with another job' : 'Blender failed'}.`);
      }
    });
    if (!job) return { message: '🧊 The GPU queue is full; try again in a minute.', done: null };
    return { message: `🧊 Building the diorama${opts.turntable ? ' turntable' : ''}… it will appear${channelId !== campaign.channel_id ? ` in <#${channelId}>` : ''} shortly.`, channelId, done: job };
  }

  /**
   * `/rpg map`: the current battle map of the caller's storyline, posted in that storyline's
   * channel (its thread for side storylines, so private stories stay private).
   */
  async mapNow(campaign: CampaignRow, userId: string, characterId?: string): Promise<{ message: string; channelId?: string }> {
    const { db, config } = this.deps;
    const member = getMember(db, campaign.id, userId);
    const actor = characterId ?? member?.character_record_id ?? null;
    const scene = storylineOf(db, campaign.id, actor) ?? mainScene(db, campaign.id);
    const snapshot = mapSnapshot(db, campaign.id, scene);
    if (!scene || !snapshot) return { message: 'Your scene has no battle map yet. The GM sets one up when a fight starts or position matters.' };
    const channelId = this.channelForScene(campaign, scene.id);
    try {
      const file = writeMapPng(snapshot, path.join(config.dataDir, 'images', campaign.id, `map-${scene.id}-${Date.now()}.png`));
      await this.deps.delivery.send({ channelId, ephemeral: false }, { content: `🗺️ **${sanitize(snapshot.scene_name)}** (current)`, file: { name: 'map.png', path: file } }, 0, `mapnow${scene.id}${Date.now()}`);
      log.info('map', { scene: scene.id, tokens: snapshot.tokens.length, path: file, by: userId });
      return { message: '🗺️ Map posted.', channelId };
    } catch (err) {
      log.warn('map failed', { scene: scene.id, err });
      return { message: "🗺️ Couldn't draw the map; see the bot log." };
    }
  }

  async backup(campaign: CampaignRow, userId: string): Promise<string> {
    if (!isOwner(campaign, userId)) return 'Only the campaign owner can request a backup.';
    const b = await createBackup(this.deps.db, this.deps.config.dataDir);
    return `Backup **${b.id}** written on the bot host (${b.manifest.counts.records} records, ${b.manifest.counts.turns} turns, ${b.manifest.source_files.length} source files). Restore with \`npm run restore -- ${b.id}\` while the bot is stopped.`;
  }

  // ------------------------------------------------------------ storylines

  /** Points an undelivered play turn at the channel of the storyline its actor is in now. */
  private followActor(turnId: number): void {
    const { db } = this.deps;
    const t = getTurn(db, turnId)!;
    const campaign = getCampaign(db, t.campaign_id)!;
    const scene = storylineOf(db, t.campaign_id, t.actor_character_id);
    const d = JSON.parse(t.delivery_json) as DeliveryState & { redirect_from?: string; message_ids?: string[] };
    if (!scene || d.message_ids?.length) return;
    const channel = this.channelForScene(campaign, scene.id);
    if (channel === d.channel_id) return;
    const from = d.redirect_from ?? d.channel_id;
    // Back in the channel the player acted from (e.g. rejoining the main story): no pointer needed.
    const { redirect_from: _old, ...rest } = d;
    updateTurn(db, turnId, { delivery_json: JSON.stringify({ ...rest, channel_id: channel, ...(channel !== from ? { redirect_from: from } : {}) }), scene_id: scene.id });
  }

  /** The channel a storyline posts to: its own thread for side storylines, else the campaign channel. */
  channelForScene(campaign: CampaignRow, sceneId: string | null): string {
    if (!sceneId) return campaign.channel_id;
    const link = threadFor(this.deps.db, campaign.id, sceneId);
    return link?.thread_id && !link.archived ? link.thread_id : campaign.channel_id;
  }

  private creating = new Set<string>();
  private portraitJobs = new Map<string, Promise<PortraitInfo | null>>();

  /**
   * After a world change: open a persistent thread for every new side storyline that has player
   * characters, close threads of storylines that ended or emptied, and tell storylines whose long
   * action can now finish. No model call; all decisions come from the saved scene records.
   */
  async syncStorylines(campaignId: string, turn?: TurnRow): Promise<void> {
    const { db } = this.deps;
    const campaign = getCampaign(db, campaignId);
    if (!campaign) return;
    const delivery = this.deps.delivery;
    const scenes = activeScenes(db, campaignId);
    const owners = playerCharacterOwners(db, campaignId);
    const pcs = new Set(owners.keys());
    const nameOf = (id: string) => getRecord(db, campaignId, id)?.name ?? 'someone';

    for (const scene of scenes) {
      const players = participants(scene).filter((p) => pcs.has(p));
      if (!players.length || isMain(db, scene) || threadFor(db, campaignId, scene.id) || this.creating.has(scene.id) || !delivery.createThread) continue;
      this.creating.add(scene.id);
      try {
        const wantsPrivate = sceneData(scene).private === true || !!(turn && (JSON.parse(turn.delivery_json) as { private_story?: boolean }).private_story);
        const members = [...new Set([...players.map((p) => owners.get(p)).filter((x): x is string => !!x), campaign.owner_user_id])];
        const threadId = await delivery.createThread(campaign.channel_id, scene.name.slice(0, 95), wantsPrivate, members);
        saveThread(db, campaignId, scene.id, { thread_id: threadId, private: wantsPrivate, archived: false });
        const who = players.map(nameOf).join(', ');
        log.info('storyline thread created', { campaign: campaignId, scene: scene.id, name: scene.name, thread: threadId, private: wantsPrivate, players: who });
        await this.safeSend(threadId, `🧵 **${sanitize(scene.name)}** — ${sanitize(who)}'s storyline continues here, alongside the main story. Use \`/rpg play\` in this thread.`);
        if (!wantsPrivate) await this.safeSend(campaign.channel_id, `↪ ${sanitize(who)}'s story continues in <#${threadId}>`);
      } catch (err) {
        log.warn('storyline thread creation failed', { scene: scene.id, err });
      } finally {
        this.creating.delete(scene.id);
      }
    }

    // Threads of storylines that ended, were archived, or lost every player character.
    const links = db.prepare(`SELECT name FROM records WHERE campaign_id = ? AND kind = '_discord_thread'`).all(campaignId) as { name: string }[];
    for (const { name: sceneId } of links) {
      const link = threadFor(db, campaignId, sceneId);
      if (!link || link.archived || !link.thread_id) continue;
      const scene = scenes.find((s) => s.id === sceneId);
      if (scene && participants(scene).some((p) => pcs.has(p))) continue;
      await this.safeSend(link.thread_id, `🏁 This storyline has ended or rejoined the main story in <#${campaign.channel_id}>. This thread stays here as a record.`);
      try {
        await delivery.archiveThread?.(link.thread_id);
      } catch (err) {
        log.warn('storyline thread archive failed', { scene: sceneId, err });
      }
      saveThread(db, campaignId, sceneId, { archived: true });
      log.info('storyline thread closed', { campaign: campaignId, scene: sceneId, thread: link.thread_id });
    }

    // Long actions whose time has come on the shared world clock.
    const world = worldClock(db, campaignId);
    if (world === null) return;
    for (const scene of scenes) {
      const busy = sceneData(scene).busy_until_min;
      if (typeof busy !== 'number' || busy > world) continue;
      const link = threadFor(db, campaignId, scene.id);
      if (link?.notified_busy_until === busy) continue;
      const who = participants(scene).filter((p) => pcs.has(p)).map(nameOf).join(', ') || 'The party';
      await this.safeSend(this.channelForScene(campaign, scene.id), `⏳ The world has caught up: ${sanitize(who)}'s long action in **${sanitize(scene.name)}** can now finish. Use \`/rpg play\` to continue.`);
      saveThread(db, campaignId, scene.id, { notified_busy_until: busy });
      log.info('storyline ready', { campaign: campaignId, scene: scene.id, busy_until_min: busy, world });
    }
  }

  private async safeSend(channelId: string, content: string): Promise<void> {
    try {
      await this.deps.delivery.send({ channelId, ephemeral: false }, { content }, 0, `s${Date.now() % 1e9}`);
    } catch (err) {
      log.warn('storyline notice failed', { channel: channelId, err });
    }
  }

  // ------------------------------------------------------------ delivery

  private retarget(turnId: number, target: DeliveryTarget): void {
    const t = getTurn(this.deps.db, turnId)!;
    const d = JSON.parse(t.delivery_json) as DeliveryState;
    updateTurn(this.deps.db, turnId, {
      delivery_json: JSON.stringify({ ...d, channel_id: target.channelId, interaction: undefined, private: target.ephemeral, message_ids: [], rendered: undefined }),
    });
  }

  private async announce(campaign: CampaignRow, content: string, buttons?: Button[]): Promise<void> {
    try {
      await this.deps.delivery.send({ channelId: campaign.channel_id, ephemeral: false }, { content, buttons }, 0, `ann${Date.now()}`.slice(0, 25));
    } catch (err) {
      log.warn('announcement failed', { campaign: campaign.id, err });
    }
  }

  private renderTurn(turn: TurnRow): OutboundMessage[] {
    if (turn.mode === 'play') {
      const out: OutboundMessage[] = renderPlay(this.deps.db, turn).map((content) => ({ content }));
      const buttons: Button[] = [];
      if ((JSON.parse(turn.delivery_json) as { map_snapshot?: unknown }).map_snapshot) buttons.push({ customId: `rpg:map:${turn.id}:0`, label: '🗺️ Map', style: 'secondary' });
      if (this.deps.images) buttons.push({ customId: `rpg:img:${turn.id}:0`, label: '🎨 Illustrate', style: 'secondary' });
      if (this.deps.diorama && buttons.some((b) => b.customId.startsWith('rpg:map:'))) buttons.push({ customId: `rpg:dio:${turn.id}:0`, label: '🧊 Diorama', style: 'secondary' });
      if (buttons.length) out[out.length - 1]!.buttons = buttons;
      return out;
    }
    return splitMessage(sanitize(turn.public_reply ?? '')).map((content) => ({ content }));
  }

  /** Delivers a committed turn's stored reply; idempotent per chunk. Marks delivered on success. */
  async deliverTurn(turnId: number): Promise<boolean> {
    const t = getTurn(this.deps.db, turnId);
    if (!t) return false;
    const d = JSON.parse(t.delivery_json) as DeliveryState & { rendered?: OutboundMessage[] };
    const messages = d.rendered ?? this.renderTurn(t);
    const ok = await this.deliverMessages(turnId, messages);
    if (ok) {
      const cur = getTurn(this.deps.db, turnId)!;
      if (cur.status === 'committed') updateTurn(this.deps.db, turnId, { status: 'delivered' });
    }
    return ok;
  }

  private async deliverText(turnId: number, text: string): Promise<void> {
    await this.deliverMessages(turnId, splitMessage(sanitize(text)).map((content) => ({ content })));
  }

  /**
   * Sends rendered messages for a turn. Rendering is stored on first attempt so retries resend the
   * same content; chunks that already have message IDs are skipped.
   */
  async deliverMessages(turnId: number, messages: OutboundMessage[]): Promise<boolean> {
    const { db } = this.deps;
    const t = getTurn(db, turnId)!;
    const d = JSON.parse(t.delivery_json) as DeliveryState & { rendered?: OutboundMessage[] };
    const rendered = d.rendered ?? messages;
    const ids = d.message_ids ?? [];
    const target: DeliveryTarget = {
      channelId: d.channel_id ?? getCampaign(db, t.campaign_id)!.channel_id,
      interaction: d.interaction,
      ephemeral: !!d.private,
    };
    const save = (patch: Partial<typeof d>) => {
      const cur = JSON.parse(getTurn(db, turnId)!.delivery_json) as typeof d;
      updateTurn(db, turnId, { delivery_json: JSON.stringify({ ...cur, ...patch }) });
    };
    save({ rendered });
    // The player acted from another channel than their storyline: point there, then post in the thread.
    const from = (d as { redirect_from?: string }).redirect_from;
    if (from && !(d as { pointer_sent?: boolean }).pointer_sent && rendered.length) {
      try {
        await this.deps.delivery.send({ channelId: from, interaction: d.interaction, ephemeral: false }, { content: `↪ Continued in <#${target.channelId}>` }, 0, `p${turnId}`);
      } catch (err) {
        log.warn('storyline pointer failed', { turn: turnId, err });
      }
      save({ pointer_sent: true } as Partial<typeof d>);
    }
    if (from) target.interaction = undefined;
    for (let i = ids.length; i < rendered.length; i++) {
      if (target.ephemeral && !interactionUsable(target)) {
        save({ last_error: 'private reply expired before delivery', delivered_at: nowIso() });
        return true;
      }
      try {
        const id = await this.deps.delivery.send(target, rendered[i]!, i, `t${turnId}c${i}`);
        ids.push(id);
        save({ message_ids: [...ids] });
      } catch (err) {
        const retryable = err instanceof DeliveryError ? err.retryable : true;
        save({ attempts: (d.attempts ?? 0) + 1, last_error: String((err as Error).message).slice(0, 300) });
        log.warn('delivery failed', { turn: turnId, retryable, err });
        if (!retryable) save({ delivered_at: nowIso() });
        return !retryable;
      }
    }
    save({ delivered_at: nowIso() });
    return true;
  }

  /** Retries committed-but-undelivered turns. Never re-runs the action. */
  async retryDeliveries(): Promise<number> {
    const { db } = this.deps;
    const rows = db
      .prepare(`SELECT id, delivery_json FROM turns WHERE status = 'committed' AND mode NOT IN ('summary') ORDER BY id LIMIT 20`)
      .all() as { id: number; delivery_json: string }[];
    let n = 0;
    for (const r of rows) {
      const d = JSON.parse(r.delivery_json) as DeliveryState;
      if ((d.attempts ?? 0) >= 10) {
        updateTurn(db, r.id, { status: 'needs_attention', error: `delivery failed: ${d.last_error ?? 'unknown'}` });
        continue;
      }
      if (await this.deliverTurn(r.id)) n++;
    }
    return n;
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Restart recovery: uncertain reservations become spend, interrupted turns resume once with
   * their saved dice (or go to the owner), queued turns run, committed replies are delivered.
   */
  async recover(): Promise<{ resumed: number; attention: number; requeued: number; delivered: number }> {
    const { db } = this.deps;
    const stats = { resumed: 0, attention: 0, requeued: 0, delivered: 0 };
    const running = db.prepare(`SELECT * FROM turns WHERE status = 'running' ORDER BY id`).all() as TurnRow[];
    for (const t of running) {
      const u = parseUsage(t);
      if (u.reserved_usd > 0) {
        u.cost_usd += u.reserved_usd;
        u.reserved_usd = 0;
        updateTurn(db, t.id, { usage_json: JSON.stringify(u) });
      }
      const resumable = ['play', 'gm', 'ask', 'recap', 'character', 'configure', 'summary'].includes(t.mode);
      if (resumable && t.attempts < 2) {
        updateTurn(db, t.id, { status: 'queued', error: 'interrupted by restart; resuming with saved checks' });
        stats.resumed++;
      } else if (t.mode === 'import' || t.mode === 'undo') {
        updateTurn(db, t.id, { status: 'aborted', error: 'interrupted by restart' });
      } else {
        updateTurn(db, t.id, { status: 'needs_attention', error: 'interrupted twice; owner review needed' });
        stats.attention++;
        await this.deliverText(t.id, '⚠️ An action was interrupted by a restart and needs the owner to resolve it (`/rpg gm`). Nothing in the world changed.');
      }
    }
    db.prepare(`UPDATE turns SET status = 'expired', confirm_nonce = NULL WHERE status IN ('proposed', 'awaiting_owner') AND expires_at < ?`).run(nowIso());
    const queued = db.prepare(`SELECT * FROM turns WHERE status = 'queued' ORDER BY id`).all() as TurnRow[];
    for (const q of queued) {
      void this.enqueue(queueKey(q), () => this.process(q.id)).catch((err) => log.error('recovered turn failed', { turn: q.id, err }));
      stats.requeued++;
    }
    stats.delivered = await this.retryDeliveries();
    return stats;
  }

  startBackgroundRetries(intervalMs = 30_000): void {
    this.retryTimer = setInterval(() => {
      void this.retryDeliveries().catch((err) => log.warn('delivery retry loop failed', { err }));
    }, intervalMs);
    this.retryTimer.unref();
  }

  /** Stops accepting work and waits (bounded) for active turns to finish or record their state. */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.accepting = false;
    if (this.retryTimer) clearInterval(this.retryTimer);
    await Promise.race([this.idle(), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}

/**
 * Queue per storyline: actions in one storyline resolve in order (turn order matters there), while
 * different storylines, private requests and owner drafts proceed concurrently.
 */
function queueKey(turn: TurnRow): string {
  if (turn.mode === 'play') return storylineKey(turn.campaign_id, turn.scene_id);
  if (turn.mode === 'gm' || turn.mode === 'configure' || turn.mode === 'summary') return `${turn.campaign_id}:owner`;
  return `${turn.campaign_id}:user:${turn.actor_user_id}`;
}

function latestEventId(db: Db, campaignId: string): number {
  const row = db
    .prepare(`SELECT MAX(id) AS id FROM turns WHERE campaign_id = ? AND mode IN ('play', 'correction', 'undo') AND status IN ('committed', 'delivered')`)
    .get(campaignId) as { id: number | null };
  return row.id ?? 0;
}

