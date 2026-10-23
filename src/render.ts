// Text rendering for Discord. Player-facing renderers read only data a player may see: no
// gm_notes, no gm-visibility records, no other players' private records, no raw tool output.
import { getRecord, listMembers, memberCharacterIds, monthUsage, parseConfig, type Db } from './database.js';
import { formatRoll, type RollRecord } from './dice.js';
import type { Diff } from './records.js';
import { playerCanSee } from './tools.js';
import { formatClock, sceneData, timeMin } from './storylines.js';
import type { CampaignRow, RecordRow, TurnRow } from './types.js';

export const DISCORD_LIMIT = 2000;
const SAFE_LIMIT = 1900;

/** Neutralises mass mentions in addition to allowedMentions on every send/edit. */
export function sanitize(text: string): string {
  return text.replace(/@(everyone|here)/g, '@​$1').replace(/<@[!&]?(\d+)>/g, '@​user');
}

/** Splits text into Discord-sized chunks at paragraph, line or word boundaries. */
export function splitMessage(text: string, limit = SAFE_LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.length ? out : ['(no content)'];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function short(v: unknown): string {
  if (v === undefined) return '(none)';
  if (typeof v === 'string') return clip(v, 60);
  return clip(JSON.stringify(v), 60);
}

function nameOf(db: Db, campaignId: string, id: unknown): string {
  if (typeof id !== 'string') return 'nowhere';
  return getRecord(db, campaignId, id)?.name ?? 'somewhere';
}

/** Mechanical receipts generated from accepted deltas and public rolls, not from the narration. */
const SCENE_BOOKKEEPING = /^(participants_ids|initiative|positions|map|pending_decision|turn_of_id|round|time_min|time|busy_until_min|status|main|private)(.|$)/;

export function receipts(db: Db, turn: TurnRow): string[] {
  const lines: string[] = [];
  const rolls = JSON.parse(turn.rolls_json) as RollRecord[];
  const changes = JSON.parse(turn.changes_json ?? '{}') as { diffs?: Diff[]; roll_ids?: string[] };
  const used = new Set(changes.roll_ids ?? rolls.map((r) => r.check_id));
  for (const r of rolls) if (r.visibility === 'public' && used.has(r.check_id)) lines.push(formatRoll(r));
  // Scene bookkeeping (participants, initiative, map positions, clock) is shown by the storyline
  // header and the battle map, not as raw changes.
  const diffs = (changes.diffs ?? []).filter((d) => !d.hidden && !(d.kind === 'scene' && SCENE_BOOKKEEPING.test(d.field.replace(/^data./, ''))));
  for (const d of diffs.slice(0, 10)) {
    if (d.field === 'created') lines.push(`➕ ${d.name} (${d.kind})`);
    else if (d.field === 'archived') lines.push(`✖ ${d.name} removed`);
    else if (d.field === 'parent') lines.push(`↪ ${d.name}: ${nameOf(db, turn.campaign_id, d.before)} → ${nameOf(db, turn.campaign_id, d.after)}`);
    else lines.push(`• ${d.name} ${d.field.replace(/^data\./, '')}: ${short(d.before)} → ${short(d.after)}`);
  }
  if (diffs.length > 10) lines.push(`• …and ${diffs.length - 10} more changes`);
  return lines;
}

export function renderPlay(db: Db, turn: TurnRow): string[] {
  const who = turn.actor_character_id ? (getRecord(db, turn.campaign_id, turn.actor_character_id)?.name ?? 'Someone') : 'Someone';
  const head = `**${sanitize(who)}:** ${sanitize(clip(turn.input_text, 1500))}`;
  const body = sanitize(turn.public_reply ?? '');
  const rec = receipts(db, turn);
  const story = storylineLabel(db, turn);
  const text = [...(story ? [`-# ${story}`] : []), head, '', body, ...(rec.length ? ['', ...rec.map((l) => `-# ${sanitize(l)}`)] : [])].join('\n');
  return splitMessage(text);
}

/** "📍 Brawl at the Tallow and Tide · round 2 · Day 1, 18:40" for the storyline a turn was played in. */
export function storylineLabel(db: Db, turn: TurnRow): string | null {
  if (!turn.scene_id) return null;
  const scene = getRecord(db, turn.campaign_id, turn.scene_id);
  if (!scene || scene.visibility === 'gm') return null;
  const d = sceneData(scene);
  const parts = [`📍 ${sanitize(scene.name)}`];
  if (typeof d.round === 'number' && d.round > 0) parts.push(`round ${d.round}`);
  const t = timeMin(scene);
  if (t !== null) parts.push(formatClock(t));
  else if (typeof d.time === 'string') parts.push(sanitize(d.time).slice(0, 60));
  return parts.join(' · ');
}

function formatValue(v: unknown, indent = ''): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) {
    if (!v.length) return 'none';
    if (v.every((x) => typeof x !== 'object' || x === null)) return v.join(', ');
    return v.map((x) => `\n${indent}  - ${formatValue(x, indent + '  ')}`).join('');
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    // Compact {current, max} style pairs.
    if (entries.length === 2 && 'current' in (v as object) && 'max' in (v as object)) {
      const o = v as { current: unknown; max: unknown };
      return `${String(o.current)}/${String(o.max)}`;
    }
    if (entries.every(([, x]) => typeof x !== 'object' || x === null)) return entries.map(([k, x]) => `${k} ${String(x)}`).join(', ');
    return entries.map(([k, x]) => `\n${indent}  ${k}: ${formatValue(x, indent + '  ')}`).join('');
  }
  return String(v);
}

/** Direct database rendering of a player's own sheet and inventory (no model call). */
export function renderSheet(db: Db, campaign: CampaignRow, userId: string, characterId?: string): string {
  const member = listMembers(db, campaign.id).find((m) => m.discord_user_id === userId);
  if (!member?.character_record_id) return 'You have no character in this campaign yet. Use `/rpg character` to create one.';
  const ch = getRecord(db, campaign.id, characterId ?? member.character_record_id);
  if (!ch) return 'Your character record is missing; ask the owner.';
  const lines = [`**${sanitize(ch.name)}**${ch.archived_at ? ' _(retired)_' : ''}`];
  const owned = memberCharacterIds(member);
  if (owned.length > 1) {
    const names = owned.map((id) => `${sanitize(getRecord(db, campaign.id, id)?.name ?? id)}${id === member.character_record_id ? ' (active)' : ''}`);
    lines.push(`-# You control: ${names.join(', ')}. Pick one with the \`as\` option.`);
  }
  const location = ch.parent_id ? getRecord(db, campaign.id, ch.parent_id) : undefined;
  if (location && playerCanSee(location, userId)) lines.push(`Location: ${sanitize(location.name)}`);
  const data = JSON.parse(ch.data_json) as Record<string, unknown>;
  for (const [k, v] of Object.entries(data)) lines.push(`**${k}:** ${sanitize(formatValue(v))}`);
  const inv = inventory(db, campaign.id, ch.id, userId, 0);
  lines.push('', '**Inventory**', ...(inv.length ? inv : ['(empty)']));
  return clip(lines.join('\n'), 3800);
}

function inventory(db: Db, campaignId: string, parentId: string, userId: string, depth: number): string[] {
  if (depth > 3) return [];
  const kids = db
    .prepare('SELECT * FROM records WHERE campaign_id = ? AND parent_id = ? AND archived_at IS NULL ORDER BY kind, name LIMIT 60')
    .all(campaignId, parentId) as RecordRow[];
  const out: string[] = [];
  for (const k of kids.filter((r) => playerCanSee(r, userId))) {
    const d = JSON.parse(k.data_json) as Record<string, unknown>;
    const qty = typeof d.quantity === 'number' && d.quantity !== 1 ? ` ×${d.quantity}` : '';
    const extra = Object.entries(d)
      .filter(([key]) => key !== 'quantity' && key !== 'description')
      .slice(0, 4)
      .map(([key, v]) => `${key} ${formatValue(v)}`)
      .join('; ');
    out.push(`${'  '.repeat(depth)}- ${sanitize(k.name)}${qty}${extra ? ` — ${sanitize(clip(extra, 160))}` : ''}`);
    out.push(...inventory(db, campaignId, k.id, userId, depth + 1));
  }
  return out;
}

export function renderDiffs(diffs: Diff[], max = 30): string[] {
  return diffs.slice(0, max).map((d) => {
    const hidden = d.hidden ? ' 🔒' : '';
    if (d.field === 'created') return `+ ${d.kind} **${d.name}**${hidden}: ${clip(JSON.stringify((d.after as { data?: unknown })?.data ?? {}), 200)}`;
    if (d.field === 'archived') return `✖ archive **${d.name}**${hidden}`;
    if (d.field === 'parent') return `↪ move **${d.name}**${hidden}: ${short(d.before)} → ${short(d.after)}`;
    return `• **${d.name}** ${d.field}${hidden}: ${short(d.before)} → ${short(d.after)}`;
  });
}

export function renderUsage(db: Db, campaign: CampaignRow, limits: { campaignMonthlyUsd: number; globalMonthlyUsd: number; maxTurnUsd: number }): string {
  const u = monthUsage(db, campaign.id);
  const spent = u.cost_usd + u.reserved_usd;
  const lines = [
    `**Model usage this month — ${sanitize(parseConfig(campaign).title)}**`,
    `Model calls: ${u.calls} across ${u.turns} requests`,
    `Tokens: ${u.input_tokens.toLocaleString()} in / ${u.output_tokens.toLocaleString()} out`,
    `Spend: $${u.cost_usd.toFixed(4)}${u.reserved_usd > 0 ? ` (+ $${u.reserved_usd.toFixed(4)} held for in-flight or uncertain calls)` : ''}`,
    `Budget: $${limits.campaignMonthlyUsd.toFixed(2)} — remaining $${Math.max(0, limits.campaignMonthlyUsd - spent).toFixed(4)}; per-request ceiling $${limits.maxTurnUsd.toFixed(3)}`,
  ];
  if (limits.globalMonthlyUsd > 0) {
    const g = monthUsage(db);
    lines.push(`Bot-wide: $${(g.cost_usd + g.reserved_usd).toFixed(4)} of $${limits.globalMonthlyUsd.toFixed(2)}`);
  }
  const problems = db
    .prepare(`SELECT id, mode, status, error, created_at FROM turns WHERE campaign_id = ? AND status IN ('needs_attention', 'aborted') ORDER BY id DESC LIMIT 5`)
    .all(campaign.id) as { id: number; mode: string; status: string; error: string | null; created_at: string }[];
  if (problems.length) {
    lines.push('', '**Recent failures**');
    for (const p of problems) lines.push(`turn ${p.id} (${p.mode}, ${p.status}, ${p.created_at.slice(0, 16)}): ${clip(p.error ?? 'no detail', 160)}`);
  }
  return lines.join('\n');
}
