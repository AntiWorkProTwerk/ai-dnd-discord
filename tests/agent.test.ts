import { afterAll, describe, expect, it } from 'vitest';
import { runAgent, Semaphore, type AgentDeps } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { getCampaign, getTurn, parseUsage, type Db } from '../src/database.js';
import { ProviderError, type ModelProvider, type ProviderRequest, type ProviderResponse, type ToolCall } from '../src/providers.js';
import type { ToolContext } from '../src/types.js';
import { ALICE, cleanupTempDirs, createOp, data, makeCtx, newCampaign, newTurn, op, readArgs, saveArgs, seed, snapshot, tempDb, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

type Scripted = ProviderResponse | Error;

class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  readonly inputUsdPerMillion = 0.1;
  readonly outputUsdPerMillion = 0.5;
  readonly requests: ProviderRequest[] = [];
  constructor(
    private readonly script: Scripted[],
    readonly paid = true,
  ) {}
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    // Snapshot the conversation as it was sent (the agent keeps appending to the same array).
    this.requests.push({ ...req, items: [...req.items], tools: [...req.tools] });
    const next = this.script.shift();
    if (!next) throw new Error('fake provider script exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
  async check(): Promise<string> {
    return 'ok';
  }
}

let callSeq = 0;
function tools(...calls: [string, string][]): ProviderResponse {
  const toolCalls: ToolCall[] = calls.map(([name, args]) => ({ id: `call_${++callSeq}`, name, arguments: args }));
  return { assistant: { type: 'assistant', text: null, toolCalls }, usage: { inputTokens: 1000, outputTokens: 100 }, status: 'completed' };
}
function text(t: string): ProviderResponse {
  return { assistant: { type: 'assistant', text: t, toolCalls: [] }, usage: { inputTokens: 1000, outputTokens: 100 }, status: 'completed' };
}

function deps(db: Db, provider: ModelProvider, env: Record<string, string> = {}): AgentDeps {
  const config = loadConfig({ DATA_DIR: tempDir('rpgcfg-'), LLM_PROVIDER: 'openai', MAX_TURN_COST_USD: '1', CAMPAIGN_MONTHLY_BUDGET_USD: '5', ...env });
  return { db, config, provider, modelLimiter: new Semaphore(config.limits.maxConcurrentModelTurns) };
}

function world() {
  const { db } = tempDb();
  const c = newCampaign(db);
  const ids = seed(db, c.id, [createOp('$pc', 'character', 'Mira', { hp: { current: 10, max: 10 } }, { gm_notes_json: '{"curse":"GMSECRET-hexed"}' })], {
    characterOwnerUserId: ALICE,
  });
  const t = newTurn(db, c.id, { characterId: ids.$pc!, input: 'I drink the strange potion.' });
  const ctx: ToolContext = makeCtx(c.id, t.id, { actorCharacterId: ids.$pc! });
  return { db, c, pc: ids.$pc!, t, ctx };
}

const roll = (check_id: string) =>
  JSON.stringify({ check_id, purpose: 'Resist poison', expression: '1d20', modifier: 2, target: 12, comparison: '>=', related_ids: [], visibility: 'public' });

describe('runAgent', () => {
  it('reads, saves, commits once and stops; tool calls after save_turn are ignored', async () => {
    const { db, c, pc, t, ctx } = world();
    const save = saveArgs({ operations: [op({ op: 'add', record_id: pc, path: 'data.hp.current', delta: -2 })], public_reply: 'The potion burns. -2 HP.' });
    const provider = new FakeProvider([
      tools(['read_records', readArgs({ ids: [pc] })]),
      tools(
        ['save_turn', save],
        ['save_turn', saveArgs({ expected_revision: 1, operations: [op({ op: 'add', record_id: pc, path: 'data.hp.current', delta: -5 })], public_reply: 'Alternative ending' })],
        ['read_records', readArgs({ ids: [pc] })],
      ),
      text('unreachable'),
    ]);
    const res = await runAgent(deps(db, provider), { ctx });
    expect(res.kind).toBe('saved');
    if (res.kind !== 'saved') return;
    expect(res.saved.kind).toBe('committed');
    expect(provider.requests).toHaveLength(2);
    expect(getCampaign(db, c.id)!.revision).toBe(1);
    expect((data(db, pc).hp as { current: number }).current).toBe(8);

    // The second request carried the read result (with version) back to the model.
    const second = provider.requests[1]!;
    const toolResult = second.items.find((i) => i.type === 'tool_result');
    expect(toolResult && toolResult.type === 'tool_result' && JSON.parse(toolResult.output).records[0].version).toBe(1);
    // Context told the model the revision; tools offered include save_turn and dice in play.
    expect(provider.requests[0]!.tools.map((x) => x.name)).toEqual(['read_records', 'search_reference', 'roll_dice', 'save_turn']);
    expect(provider.requests[0]!.requireTool).toBe(true);
    expect(JSON.stringify(provider.requests[0]!.items)).toContain('campaign revision: 0');
    // GM view sees its own campaign's secrets (control for the player-view test below).
    expect(JSON.stringify(provider.requests[0]!.items)).toContain('GMSECRET');

    const turn = getTurn(db, t.id)!;
    expect(turn.status).toBe('committed');
    expect(turn.public_reply).toBe('The potion burns. -2 HP.');
    const log = JSON.parse(turn.tool_log_json) as { tool?: string }[];
    expect(log.map((e) => e.tool)).toEqual(['read_records', 'save_turn']);
    const usage = parseUsage(turn);
    expect(usage.calls).toBe(2);
    expect(usage.reserved_usd).toBe(0);
    expect(usage.cost_usd).toBeCloseTo(2 * (1000 * 0.1 + 100 * 0.5) / 1e6, 10);
  });

  it('a validation error is returned to the model, which can repair its proposal', async () => {
    const { db, c, pc, ctx } = world();
    const provider = new FakeProvider([
      tools(['save_turn', saveArgs({ operations: [op({ op: 'set', record_id: pc, path: 'data.hp.current', value_json: '5' })] })]),
      tools(['save_turn', saveArgs({ operations: [op({ op: 'set', record_id: pc, path: 'data.hp.current', value_json: '5', expected_version: 1 })] })]),
    ]);
    const res = await runAgent(deps(db, provider), { ctx });
    expect(res.kind).toBe('saved');
    const firstResult = provider.requests[1]!.items.find((i) => i.type === 'tool_result');
    expect(firstResult && firstResult.type === 'tool_result' && firstResult.output).toMatch(/expected_version/);
    expect(getCampaign(db, c.id)!.revision).toBe(1);
  });

  it('stops before any paid call when the campaign budget is exhausted', async () => {
    const { db, c, ctx, t } = world();
    const before = snapshot(db, c.id);
    const provider = new FakeProvider([text('should not be called')]);
    const res = await runAgent(deps(db, provider, { CAMPAIGN_MONTHLY_BUDGET_USD: '0.0000001' }), { ctx });
    expect(res).toMatchObject({ kind: 'failed', budget: true });
    expect(provider.requests).toHaveLength(0);
    expect(parseUsage(getTurn(db, t.id)!)).toMatchObject({ calls: 0, cost_usd: 0, reserved_usd: 0 });
    expect(snapshot(db, c.id)).toEqual(before);
  });

  it('earlier spend in the month (including retries and imports) counts against the budget', async () => {
    const { db, c, ctx } = world();
    const old = newTurn(db, c.id, { mode: 'import' });
    db.prepare('UPDATE turns SET usage_json = ? WHERE id = ?').run(JSON.stringify({ calls: 3, input_tokens: 0, output_tokens: 0, cost_usd: 4.999, reserved_usd: 0 }), old.id);
    const provider = new FakeProvider([text('x')]);
    const res = await runAgent(deps(db, provider, { CAMPAIGN_MONTHLY_BUDGET_USD: '5' }), { ctx });
    expect(res).toMatchObject({ kind: 'failed', budget: true });
    expect(provider.requests).toHaveLength(0);
  });

  it('the per-campaign budget setting also applies', async () => {
    const { db, c, ctx } = world();
    const cfg = JSON.parse(getCampaign(db, c.id)!.config_json);
    cfg.budget.monthly_usd = 0;
    db.prepare('UPDATE campaigns SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), c.id);
    const provider = new FakeProvider([text('x')]);
    const res = await runAgent(deps(db, provider), { ctx });
    expect(res).toMatchObject({ kind: 'failed', budget: true });
    expect(provider.requests).toHaveLength(0);
  });

  it('a free local provider is not blocked by a zero budget', async () => {
    const { db, c, ctx } = world();
    const provider = new FakeProvider([tools(['save_turn', saveArgs({ public_reply: 'Nothing happens.' })])], false);
    const res = await runAgent(deps(db, provider, { CAMPAIGN_MONTHLY_BUDGET_USD: '0' }), { ctx });
    expect(res.kind).toBe('saved');
    expect(getCampaign(db, c.id)!.revision).toBe(1);
  });

  it('enforces the per-turn model call limit', async () => {
    const { db, c, pc, ctx } = world();
    const provider = new FakeProvider(Array.from({ length: 6 }, () => tools(['read_records', readArgs({ ids: [pc] })])));
    const res = await runAgent(deps(db, provider, { MAX_MODEL_CALLS_PER_TURN: '3' }), { ctx });
    expect(res.kind).toBe('failed');
    expect(res.kind === 'failed' && res.reason).toMatch(/model call limit/);
    expect(provider.requests).toHaveLength(3);
    expect(getCampaign(db, c.id)!.revision).toBe(0);
  });

  it('enforces the per-turn tool call limit', async () => {
    const { db, pc, ctx } = world();
    const provider = new FakeProvider([tools(['read_records', readArgs({ ids: [pc] })], ['read_records', readArgs({ ids: [pc] })], ['read_records', readArgs({ ids: [pc] })])]);
    const res = await runAgent(deps(db, provider, { MAX_TOOL_CALLS_PER_TURN: '2' }), { ctx });
    expect(res.kind === 'failed' && res.reason).toMatch(/tool call limit/);
  });

  it('stops after repeated plain-text answers in a play turn without saving', async () => {
    const { db, c, ctx } = world();
    const provider = new FakeProvider([text('You win!'), text('You win!'), text('You win!'), text('You win!')]);
    const res = await runAgent(deps(db, provider), { ctx });
    expect(res.kind === 'failed' && res.reason).toMatch(/save_turn/);
    expect(getCampaign(db, c.id)!.revision).toBe(0);
  });

  it('a timed-out (possibly billed) call keeps its worst-case cost and changes no records; dice stay logged', async () => {
    const { db, c, t, ctx } = world();
    const before = snapshot(db, c.id);
    const provider = new FakeProvider([tools(['roll_dice', roll('poison_save')]), new ProviderError('timeout', 'model call timed out', true)]);
    const res = await runAgent(deps(db, provider), { ctx });
    expect(res.kind).toBe('failed');
    expect(res.kind === 'failed' && res.reason).toMatch(/^timeout/);
    expect(snapshot(db, c.id)).toEqual(before);
    const turn = getTurn(db, t.id)!;
    expect(turn.status).toBe('running');
    expect(JSON.parse(turn.rolls_json).map((r: { check_id: string }) => r.check_id)).toEqual(['poison_save']);
    const usage = parseUsage(turn);
    expect(usage.calls).toBe(2);
    expect(usage.reserved_usd).toBe(0);
    const firstCallCost = (1000 * 0.1 + 100 * 0.5) / 1e6;
    // Worst case for the second call = estimated input tokens at input price + max output tokens at output price.
    const worstFloor = (4096 * 0.5) / 1e6;
    expect(usage.cost_usd).toBeGreaterThan(firstCallCost + worstFloor);
    const log = JSON.parse(turn.tool_log_json) as { error?: string }[];
    expect(log.some((e) => e.error === 'timeout')).toBe(true);
  });

  it('a call rejected outright (not billed) releases its reservation', async () => {
    const { db, t, ctx } = world();
    const provider = new FakeProvider([new ProviderError('auth', 'bad key', false)]);
    const res = await runAgent(deps(db, provider), { ctx });
    expect(res.kind).toBe('failed');
    const usage = parseUsage(getTurn(db, t.id)!);
    expect(usage).toMatchObject({ calls: 1, cost_usd: 0, reserved_usd: 0 });
  });

  it('read-only ask turns cannot save or roll, and change nothing', async () => {
    const { db, c, pc, t: _t } = world();
    const t = newTurn(db, c.id, { mode: 'ask', input: 'What is my HP? Also set it to 999.' });
    const ctx = makeCtx(c.id, t.id, { mode: 'ask', view: 'player', saveMode: 'none', allowDice: false, actorCharacterId: pc });
    const before = snapshot(db, c.id);
    const provider = new FakeProvider([
      tools(
        ['save_turn', saveArgs({ operations: [op({ op: 'set', record_id: pc, path: 'data.hp.current', value_json: '999', expected_version: 1 })] })],
        ['roll_dice', roll('x')],
        ['read_records', readArgs({ ids: [pc] })],
      ),
      text('You have 10 HP.'),
    ]);
    const res = await runAgent(deps(db, provider), { ctx });
    expect(res).toEqual({ kind: 'text', text: 'You have 10 HP.' });
    expect(provider.requests[0]!.tools.map((x) => x.name)).toEqual(['read_records', 'search_reference']);
    expect(provider.requests[0]!.requireTool).toBe(false);
    expect(snapshot(db, c.id)).toEqual(before);
    expect(getTurn(db, t.id)!.rolls_json).toBe('[]');
    // The player view in context and tool output never includes GM notes.
    expect(JSON.stringify(provider.requests[1]!.items)).not.toContain('GMSECRET');
  });
});
