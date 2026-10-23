// Discord adapter: command definitions, delivery payloads (no mentions), interaction-token expiry
// handling and channel fallback with a de-duplication nonce. The REST client is faked.
import { describe, expect, it } from 'vitest';
import type { Client } from 'discord.js';
import { buildCommands, canSetUp, createDiscordDelivery } from '../src/discord.js';
import { loadConfig } from '../src/config.js';
import { DeliveryError } from '../src/turns.js';
import { sanitize, splitMessage } from '../src/render.js';

function fakeClient() {
  const calls: { method: string; route: string; body: Record<string, unknown> }[] = [];
  const rest = {
    patch: async (route: string, opts: { body: Record<string, unknown> }) => {
      calls.push({ method: 'patch', route, body: opts.body });
      return { id: 'edited' };
    },
    post: async (route: string, opts: { body: Record<string, unknown> }) => {
      calls.push({ method: 'post', route, body: opts.body });
      return { id: `posted${calls.length}` };
    },
  };
  return { client: { rest } as unknown as Client, calls };
}

const fresh = () => ({ application_id: 'app', token: 'tok', created_at: new Date().toISOString() });
const stale = () => ({ application_id: 'app', token: 'tok', created_at: new Date(Date.now() - 20 * 60_000).toISOString() });

describe('commands', () => {
  it('registers one /rpg command with every subcommand, guild-only', () => {
    const [cmd] = buildCommands();
    const subs = (cmd!.options ?? []).map((o) => o.name).sort();
    expect(subs).toEqual(['ask', 'backup', 'character', 'configure', 'gm', 'import', 'pause', 'play', 'recap', 'resume', 'setup', 'sheet', 'start', 'undo', 'usage']);
    expect(cmd!.contexts).toEqual([0]);
    expect(cmd!.default_member_permissions ?? null).toBeNull();
  });

  it('only channel managers or configured admins may create a campaign', () => {
    const config = loadConfig({ BOT_ADMIN_USER_IDS: 'admin-1' });
    const mk = (id: string, manage: boolean) => ({ user: { id }, memberPermissions: { has: () => manage } }) as never;
    expect(canSetUp(mk('x', false), config)).toBe(false);
    expect(canSetUp(mk('x', true), config)).toBe(true);
    expect(canSetUp(mk('admin-1', false), config)).toBe(true);
  });
});

describe('delivery', () => {
  it('edits the deferred reply first, follows up after, and disables all mentions', async () => {
    const { client, calls } = fakeClient();
    const d = createDiscordDelivery(client);
    await d.send({ channelId: 'c', ephemeral: false, interaction: fresh() }, { content: 'hi @everyone' }, 0, 'n0');
    await d.send({ channelId: 'c', ephemeral: true, interaction: fresh() }, { content: 'more' }, 1, 'n1');
    expect(calls[0]!.method).toBe('patch');
    expect(decodeURIComponent(calls[0]!.route)).toContain('/messages/@original');
    expect(calls[1]!.method).toBe('post');
    expect(calls[1]!.body.flags).toBe(64);
    for (const c of calls) expect(c.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('falls back to a channel message with an enforced nonce when the token expired', async () => {
    const { client, calls } = fakeClient();
    const d = createDiscordDelivery(client);
    await d.send({ channelId: 'chan', ephemeral: false, interaction: stale() }, { content: 'late reply' }, 0, 't12c0');
    expect(calls[0]!.route).toBe('/channels/chan/messages');
    expect(calls[0]!.body).toMatchObject({ nonce: 't12c0', enforce_nonce: true, allowed_mentions: { parse: [] } });
  });

  it('never posts private output publicly once the token expired', async () => {
    const { client, calls } = fakeClient();
    const d = createDiscordDelivery(client);
    await expect(d.send({ channelId: 'chan', ephemeral: true, interaction: stale() }, { content: 'secret' }, 0, 'x')).rejects.toBeInstanceOf(DeliveryError);
    expect(calls).toHaveLength(0);
  });
});

describe('rendering', () => {
  it('respects Discord length limits and neutralises mass mentions', () => {
    const chunks = splitMessage('word '.repeat(1500));
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(sanitize('@everyone <@123>')).not.toMatch(/@everyone|<@123>/);
  });
});
