// Turn runner: one logical queue per campaign, bounded admission, the agent run for each mode,
// stored-reply delivery with retries, owner confirmations, and restart recovery. A committed
// action is never run again; delivery retries only resend its saved reply.
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
  getTurn,
  insertTurn,
  monthUsage,
  newRecordId,
  nowIso,
  parseConfig,
  parseUsage,
  updateTurn,
  type Db,
} from './database.js';
import type { RollRecord } from './dice.js';
import { log } from './log.js';
import type { ModelProvider } from './providers.js';
import type { Diff } from './records.js';
import { renderDiffs, renderPlay, sanitize, splitMessage } from './render.js';
import type { CampaignRow, DeliveryState, ToolContext, TurnMode, TurnRow } from './types.js';

// ---------------------------------------------------------------- delivery port

export interface Button {
  customId: string;
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
}

export interface OutboundMessage {
  content: string;
  buttons?: Button[];
  file?: { name: string; content: string };
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
    const delivery: DeliveryState = {
      channel_id: input.target.channelId,
      interaction: input.target.interaction ? { ...input.target.interaction, ephemeral: input.target.ephemeral } : undefined,
      private: input.target.ephemeral,
    };
    const { turn, created } = insertTurn(db, {
      campaign_id: input.campaign.id,
      request_id: input.requestId,
      actor_user_id: input.userId,
      actor_character_id: input.mode === 'gm' || input.mode === 'configure' ? null : (member?.character_record_id ?? null),
      mode: input.mode,
      status: 'queued',
      input_text: input.text.slice(0, 4000),
      delivery_json: JSON.stringify(delivery),
    });
    if (!created) return { status: 'duplicate', turnId: turn.id, message: `This request was already received (status: ${turn.status}).` };

    const queued = db
      .prepare(`SELECT COUNT(*) AS n FROM turns WHERE campaign_id = ? AND status IN ('queued', 'running') AND id <> ?`)
      .get(input.campaign.id, turn.id) as { n: number };
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
    void this.enqueue(input.campaign.id, () => this.process(turn.id)).catch((err) => log.error('turn job failed', { turn: turn.id, err }));
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
    // Refresh the acting character in case it was created after queuing.
    const member = getMember(db, campaign.id, turn.actor_user_id);
    const characterId = turn.mode === 'gm' || turn.mode === 'configure' ? null : (member?.character_record_id ?? null);
    updateTurn(db, turn.id, {
      status: 'running',
      attempts: turn.attempts + 1,
      base_revision: campaign.revision,
      source_version: campaign.active_source_version,
      actor_character_id: characterId,
    });
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
        await this.deliverTurn(turn.id);
        this.maybeSummarize(turn.campaign_id);
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
          updateTurn(db, t.id, { status: 'committed' });
          await this.deliverTurn(t.id);
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
          await this.deliverText(t.id, `${t.public_reply ?? ''}\n\n⚠️ This draft cannot be accepted: ${problem}. Reply with \`/rpg character\` to revise.`);
          return;
        }
        const nonce = markProposed(db, t.id, config.limits.confirmationTtlMs * 4);
        await this.deliverMessages(t.id, [
          {
            content: `${sanitize(t.public_reply ?? '')}\n\n**Proposed records**\n${sanitize(sheet)}\n\nAccept to create this character, or use \`/rpg character\` again to ask for changes.`,
            buttons: [
              { customId: `rpg:chr:${t.id}:${nonce}`, label: 'Accept character', style: 'success' },
              { customId: `rpg:no:${t.id}:${nonce}`, label: 'Discard', style: 'secondary' },
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
    return this.enqueue(campaign.id, async () => {
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

  async backup(campaign: CampaignRow, userId: string): Promise<string> {
    if (!isOwner(campaign, userId)) return 'Only the campaign owner can request a backup.';
    const b = await createBackup(this.deps.db, this.deps.config.dataDir);
    return `Backup **${b.id}** written on the bot host (${b.manifest.counts.records} records, ${b.manifest.counts.turns} turns, ${b.manifest.source_files.length} source files). Restore with \`npm run restore -- ${b.id}\` while the bot is stopped.`;
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
    if (turn.mode === 'play') return renderPlay(this.deps.db, turn).map((content) => ({ content }));
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
    const queued = db.prepare(`SELECT id, campaign_id FROM turns WHERE status = 'queued' ORDER BY id`).all() as { id: number; campaign_id: string }[];
    for (const q of queued) {
      void this.enqueue(q.campaign_id, () => this.process(q.id)).catch((err) => log.error('recovered turn failed', { turn: q.id, err }));
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

function latestEventId(db: Db, campaignId: string): number {
  const row = db
    .prepare(`SELECT MAX(id) AS id FROM turns WHERE campaign_id = ? AND mode IN ('play', 'correction', 'undo') AND status IN ('committed', 'delivered')`)
    .get(campaignId) as { id: number | null };
  return row.id ?? 0;
}

