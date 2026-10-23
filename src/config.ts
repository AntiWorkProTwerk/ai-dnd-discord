// Environment configuration. Parsed once at startup; invalid values stop the process with a
// message naming the variable, never echoing secret values.
import path from 'node:path';
import { z } from 'zod';

const num = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min) {
        ctx.addIssue({ code: 'custom', message: `must be a number >= ${min}` });
        return z.NEVER;
      }
      return n;
    });

const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : v.trim()));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  DISCORD_TOKEN: optStr,
  DISCORD_APPLICATION_ID: optStr,
  DISCORD_GUILD_ID: optStr,
  BOT_ADMIN_USER_IDS: str(''),

  DATA_DIR: str('./data'),
  DATABASE_PATH: optStr,

  LLM_PROVIDER: z
    .string()
    .optional()
    .transform((v) => (v ?? 'openai').trim())
    .pipe(z.enum(['openai', 'ollama'])),
  OPENAI_API_KEY: optStr,
  OPENAI_BASE_URL: optStr,
  OPENAI_MODEL: str('gpt-6-luna'),
  OPENAI_REASONING_EFFORT: str('low'),
  OPENAI_INPUT_USD_PER_MILLION: num(0.1),
  OPENAI_OUTPUT_USD_PER_MILLION: num(0.5),
  OLLAMA_URL: str('http://127.0.0.1:11434'),
  OLLAMA_MODEL: str('qwen3:8b'),
  OLLAMA_NUM_CTX: num(16384, 2048),

  MAX_MODEL_CALLS_PER_TURN: num(8, 1),
  MAX_TOOL_CALLS_PER_TURN: num(24, 1),
  MAX_INPUT_TOKENS_PER_CALL: num(16000, 1000),
  MAX_OUTPUT_TOKENS_PER_CALL: num(4096, 256),
  TURN_TIMEOUT_SECONDS: num(90, 5),
  CAMPAIGN_MONTHLY_BUDGET_USD: num(5),
  MAX_TURN_COST_USD: num(0.02),
  MAX_ADMIN_TURN_COST_USD: num(0.05),
  GLOBAL_MONTHLY_BUDGET_USD: num(0),
  MAX_CONCURRENT_MODEL_TURNS: num(2, 1),
  MAX_QUEUED_TURNS_PER_CAMPAIGN: num(5, 1),
  MAX_IMPORT_MB: num(20, 1),
  CONFIRMATION_TTL_MINUTES: num(15, 1),
  LOG_LEVEL: str('info'),
});

export interface AppConfig {
  discord: { token?: string; applicationId?: string; guildId?: string; adminUserIds: string[] };
  dataDir: string;
  databasePath: string;
  provider:
    | {
        kind: 'openai';
        apiKey?: string;
        baseUrl?: string;
        model: string;
        reasoningEffort: string;
        inputUsdPerMillion: number;
        outputUsdPerMillion: number;
      }
    | { kind: 'ollama'; url: string; model: string; numCtx: number };
  limits: {
    maxModelCallsPerTurn: number;
    maxToolCallsPerTurn: number;
    maxInputTokensPerCall: number;
    maxOutputTokensPerCall: number;
    turnTimeoutMs: number;
    campaignMonthlyBudgetUsd: number;
    maxTurnCostUsd: number;
    maxAdminTurnCostUsd: number;
    /** 0 means no application-wide ceiling beyond the per-campaign budgets. */
    globalMonthlyBudgetUsd: number;
    maxConcurrentModelTurns: number;
    maxQueuedTurnsPerCampaign: number;
    maxImportBytes: number;
    confirmationTtlMs: number;
  };
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const dataDir = path.resolve(e.DATA_DIR);
  return {
    discord: {
      token: e.DISCORD_TOKEN,
      applicationId: e.DISCORD_APPLICATION_ID,
      guildId: e.DISCORD_GUILD_ID,
      adminUserIds: e.BOT_ADMIN_USER_IDS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    dataDir,
    databasePath: path.resolve(e.DATABASE_PATH ?? path.join(dataDir, 'rpg.sqlite')),
    provider:
      e.LLM_PROVIDER === 'openai'
        ? {
            kind: 'openai',
            apiKey: e.OPENAI_API_KEY,
            baseUrl: e.OPENAI_BASE_URL,
            model: e.OPENAI_MODEL,
            reasoningEffort: e.OPENAI_REASONING_EFFORT,
            inputUsdPerMillion: e.OPENAI_INPUT_USD_PER_MILLION,
            outputUsdPerMillion: e.OPENAI_OUTPUT_USD_PER_MILLION,
          }
        : { kind: 'ollama', url: e.OLLAMA_URL, model: e.OLLAMA_MODEL, numCtx: e.OLLAMA_NUM_CTX },
    limits: {
      maxModelCallsPerTurn: e.MAX_MODEL_CALLS_PER_TURN,
      maxToolCallsPerTurn: e.MAX_TOOL_CALLS_PER_TURN,
      maxInputTokensPerCall: e.MAX_INPUT_TOKENS_PER_CALL,
      maxOutputTokensPerCall: e.MAX_OUTPUT_TOKENS_PER_CALL,
      turnTimeoutMs: e.TURN_TIMEOUT_SECONDS * 1000,
      campaignMonthlyBudgetUsd: e.CAMPAIGN_MONTHLY_BUDGET_USD,
      maxTurnCostUsd: e.MAX_TURN_COST_USD,
      maxAdminTurnCostUsd: e.MAX_ADMIN_TURN_COST_USD,
      globalMonthlyBudgetUsd: e.GLOBAL_MONTHLY_BUDGET_USD,
      maxConcurrentModelTurns: e.MAX_CONCURRENT_MODEL_TURNS,
      maxQueuedTurnsPerCampaign: e.MAX_QUEUED_TURNS_PER_CAMPAIGN,
      maxImportBytes: Math.round(e.MAX_IMPORT_MB * 1024 * 1024),
      confirmationTtlMs: e.CONFIRMATION_TTL_MINUTES * 60_000,
    },
    logLevel: e.LOG_LEVEL,
  };
}

/** Values that must never appear in logs, errors, model context, or exports. */
export function secretValues(config: AppConfig): string[] {
  const out: string[] = [];
  if (config.discord.token) out.push(config.discord.token);
  if (config.provider.kind === 'openai' && config.provider.apiKey) out.push(config.provider.apiKey);
  return out.filter((s) => s.length >= 8);
}
