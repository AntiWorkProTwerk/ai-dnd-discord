// One small provider interface with two adapters: OpenAI Responses (GPT-6 Luna by default) and
// Ollama tool calling. Adapters translate a neutral conversation to the provider's wire format
// and back. Budget reservation and pricing are applied by the agent, not here. Neither adapter
// retries on its own, so every billed request passes through the budget.
import OpenAI from 'openai';
import type { AppConfig } from './config.js';

export interface ToolSpec {
  name: string;
  description: string;
  /** Strict JSON schema: every property required, additionalProperties false. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ConversationItem =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string | null; toolCalls: ToolCall[]; raw?: unknown[] }
  | { type: 'tool_result'; callId: string; name: string; output: string };

export interface ProviderRequest {
  system: string;
  items: ConversationItem[];
  tools: ToolSpec[];
  /** When set, a text answer must be JSON matching this schema. */
  finalSchema?: { name: string; schema: Record<string, unknown> };
  /** Require a tool call (play turns end only through save_turn). */
  requireTool: boolean;
  maxOutputTokens: number;
  reasoningEffort?: string | null;
  signal: AbortSignal;
}

export interface ProviderResponse {
  assistant: Extract<ConversationItem, { type: 'assistant' }>;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** "completed", or "incomplete" when the output limit was hit. */
  status: string;
}

export type ProviderErrorCategory = 'timeout' | 'unavailable' | 'rate_limited' | 'auth' | 'bad_request' | 'bad_response';

export class ProviderError extends Error {
  constructor(
    public category: ProviderErrorCategory,
    message: string,
    /** False when the provider rejected the request outright, so nothing was billed. */
    public possiblyBilled: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly paid: boolean;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  /** Cheap reachability check for the startup doctor (no paid generation). */
  check(): Promise<string>;
}

// ---------------------------------------------------------------- OpenAI Responses

interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  reasoningEffort: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Test seam: replaces the official client's fetch. */
  fetch?: typeof fetch;
}

export function createOpenAiProvider(opts: OpenAiOptions): ModelProvider {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
    maxRetries: 0,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  const toInput = (items: ConversationItem[]): unknown[] => {
    const out: unknown[] = [];
    for (const item of items) {
      if (item.type === 'user') out.push({ role: 'user', content: item.text });
      else if (item.type === 'tool_result') out.push({ type: 'function_call_output', call_id: item.callId, output: item.output });
      else if (item.raw) out.push(...item.raw);
      else {
        if (item.text) out.push({ role: 'assistant', content: item.text });
        for (const c of item.toolCalls) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
      }
    }
    return out;
  };

  return {
    name: 'openai',
    model: opts.model,
    paid: true,
    inputUsdPerMillion: opts.inputUsdPerMillion,
    outputUsdPerMillion: opts.outputUsdPerMillion,

    async complete(req) {
      const body: Record<string, unknown> = {
        model: opts.model,
        instructions: req.system,
        input: toInput(req.items),
        tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true })),
        reasoning: { effort: req.reasoningEffort ?? opts.reasoningEffort },
        max_output_tokens: req.maxOutputTokens,
        store: false,
        include: ['reasoning.encrypted_content'],
      };
      if (req.tools.length) body.tool_choice = req.requireTool ? 'required' : 'auto';
      if (req.finalSchema) body.text = { format: { type: 'json_schema', name: req.finalSchema.name, strict: true, schema: req.finalSchema.schema } };

      let res: OpenAI.Responses.Response;
      try {
        res = (await client.responses.create(body as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming, {
          signal: req.signal,
        })) as OpenAI.Responses.Response;
      } catch (err) {
        throw mapOpenAiError(err, req.signal);
      }

      const toolCalls: ToolCall[] = [];
      const texts: string[] = [];
      const raw: unknown[] = [];
      for (const item of res.output ?? []) {
        raw.push(item);
        if (item.type === 'function_call') toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
        else if (item.type === 'message') {
          for (const part of item.content ?? []) if (part.type === 'output_text') texts.push(part.text);
        }
      }
      return {
        assistant: { type: 'assistant', text: texts.length ? texts.join('\n') : null, toolCalls, raw },
        usage: { inputTokens: res.usage?.input_tokens ?? null, outputTokens: res.usage?.output_tokens ?? null },
        status: res.status ?? 'completed',
      };
    },

    async check() {
      try {
        const m = await client.models.retrieve(opts.model);
        return `OpenAI model ${m.id} is available to this key`;
      } catch (err) {
        throw mapOpenAiError(err, new AbortController().signal);
      }
    },
  };
}

function mapOpenAiError(err: unknown, signal: AbortSignal): ProviderError {
  if (signal.aborted) return new ProviderError('timeout', 'model call timed out or was cancelled', true);
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError('timeout', 'OpenAI request timed out', true);
  if (err instanceof OpenAI.APIConnectionError) return new ProviderError('unavailable', 'OpenAI not reachable', true);
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    const detail = String(err.message ?? '').slice(0, 300);
    if (status === 401 || status === 403) return new ProviderError('auth', `OpenAI rejected the API key (HTTP ${status}); check OPENAI_API_KEY`, false);
    if (status === 429) return new ProviderError('rate_limited', `OpenAI rate limit or quota (HTTP 429): ${detail}`, false);
    if (status >= 400 && status < 500) return new ProviderError('bad_request', `OpenAI HTTP ${status}: ${detail}`, false);
    return new ProviderError('unavailable', `OpenAI HTTP ${status}: ${detail}`, true);
  }
  return new ProviderError('unavailable', `OpenAI call failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`, true);
}

// ---------------------------------------------------------------- Ollama

interface OllamaOptions {
  url: string;
  model: string;
  numCtx: number;
  fetch?: typeof fetch;
}

interface OllamaMessage {
  role: string;
  content?: string;
  tool_calls?: { id?: string; function: { name: string; arguments: unknown } }[];
}

export function createOllamaProvider(opts: OllamaOptions): ModelProvider {
  const doFetch = opts.fetch ?? fetch;
  let seq = 0;

  const toMessages = (system: string, items: ConversationItem[]) => {
    const msgs: Record<string, unknown>[] = [{ role: 'system', content: system }];
    for (const item of items) {
      if (item.type === 'user') msgs.push({ role: 'user', content: item.text });
      else if (item.type === 'tool_result') msgs.push({ role: 'tool', content: item.output, tool_name: item.name });
      else {
        msgs.push({
          role: 'assistant',
          content: item.text ?? '',
          ...(item.toolCalls.length
            ? { tool_calls: item.toolCalls.map((c) => ({ function: { name: c.name, arguments: safeParse(c.arguments) } })) }
            : {}),
        });
      }
    }
    return msgs;
  };

  return {
    name: 'ollama',
    model: opts.model,
    paid: false,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,

    async complete(req) {
      const body: Record<string, unknown> = {
        model: opts.model,
        stream: false,
        messages: toMessages(req.system, req.items),
        tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        options: { num_ctx: opts.numCtx, num_predict: req.maxOutputTokens, temperature: 0.7 },
        keep_alive: '30m',
      };
      // Ollama applies `format` to the final text; only send it when no tool is pending.
      if (req.finalSchema && !req.requireTool) body.format = req.finalSchema.schema;

      let res: Response;
      try {
        res = await doFetch(`${opts.url}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch {
        if (req.signal.aborted) throw new ProviderError('timeout', 'Ollama call timed out', false);
        throw new ProviderError('unavailable', `Ollama not reachable at ${opts.url}`, false);
      }
      const text = await res.text();
      if (!res.ok) throw new ProviderError(res.status === 404 ? 'bad_request' : 'unavailable', `Ollama HTTP ${res.status}: ${text.slice(0, 200)}`, false);
      let json: { message?: OllamaMessage; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError('bad_response', 'Ollama returned non-JSON', false);
      }
      const msg = json.message ?? { role: 'assistant' };
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c) => ({
        id: c.id ?? `ollama_${++seq}`,
        name: c.function.name,
        arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
      }));
      return {
        assistant: { type: 'assistant', text: msg.content ? msg.content : null, toolCalls },
        usage: { inputTokens: json.prompt_eval_count ?? null, outputTokens: json.eval_count ?? null },
        status: json.done_reason === 'length' ? 'incomplete' : 'completed',
      };
    },

    async check() {
      let res: Response;
      try {
        res = await doFetch(`${opts.url}/api/tags`);
      } catch {
        throw new ProviderError('unavailable', `Ollama not reachable at ${opts.url}`, false);
      }
      const json = (await res.json()) as { models?: { name: string }[] };
      const names = (json.models ?? []).map((m) => m.name);
      if (!names.includes(opts.model)) {
        throw new ProviderError('bad_request', `Ollama is running but model ${opts.model} is not pulled (have: ${names.join(', ') || 'none'})`, false);
      }
      return `Ollama model ${opts.model} is available at ${opts.url}`;
    },
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function createProvider(config: AppConfig): ModelProvider {
  const p = config.provider;
  if (p.kind === 'openai') {
    if (!p.apiKey) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
    return createOpenAiProvider({
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
      model: p.model,
      reasoningEffort: p.reasoningEffort,
      inputUsdPerMillion: p.inputUsdPerMillion,
      outputUsdPerMillion: p.outputUsdPerMillion,
    });
  }
  return createOllamaProvider({ url: p.url, model: p.model, numCtx: p.numCtx });
}
