// Parallel storylines. A storyline is an ordinary active `scene` record; its participants are the
// characters playing in it. Each player character is in at most one active scene; anyone in none
// belongs to the main storyline. This module only reads records (routing, clocks, Discord thread
// mapping) and adds no gameplay rules: the GM still decides what happens in each scene.
import { getRecord, playerCharacterOwners, newRecordId, nowIso, type Db } from './database.js';
import type { CampaignConfig, RecordRow } from './types.js';

export interface SceneData {
  status?: string;
  main?: boolean;
  participants_ids?: unknown;
  time_min?: unknown;
  busy_until_min?: unknown;
  private?: boolean;
  round?: unknown;
  time?: unknown;
  pending_decision?: unknown;
  turn_of_id?: unknown;
}

export const DEFAULT_SYNC_WINDOW_MINUTES = 60;
/** Storylines with no activity for this long stop holding back the shared clock. */
export const IDLE_STORYLINE_MINUTES = 30;

export function sceneData(r: RecordRow): SceneData {
  try {
    return JSON.parse(r.data_json) as SceneData;
  } catch {
    return {};
  }
}

export function participants(r: RecordRow): string[] {
  const p = sceneData(r).participants_ids;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}

export function timeMin(r: RecordRow): number | null {
  const t = sceneData(r).time_min;
  return typeof t === 'number' && Number.isFinite(t) ? t : null;
}

export function isActiveScene(r: RecordRow): boolean {
  if (r.kind !== 'scene' || r.archived_at) return false;
  const s = sceneData(r).status;
  return s === undefined || s === 'active';
}

export function activeScenes(db: Db, campaignId: string): RecordRow[] {
  return (db.prepare(`SELECT * FROM records WHERE campaign_id = ? AND kind = 'scene' AND archived_at IS NULL ORDER BY created_at, id`).all(campaignId) as RecordRow[]).filter(
    isActiveScene,
  );
}

/** The main storyline: the scene flagged `main`, else the oldest active scene. */
export function mainScene(db: Db, campaignId: string, scenes = activeScenes(db, campaignId)): RecordRow | undefined {
  return scenes.find((s) => sceneData(s).main === true) ?? scenes[0];
}

export function isMain(db: Db, scene: RecordRow): boolean {
  return mainScene(db, scene.campaign_id)?.id === scene.id;
}

/** The storyline a character is playing in: the active scene listing them, else the main one. */
export function storylineOf(db: Db, campaignId: string, characterId: string | null): RecordRow | undefined {
  const scenes = activeScenes(db, campaignId);
  if (characterId) {
    const own = scenes.find((s) => participants(s).includes(characterId));
    if (own) return own;
  }
  return mainScene(db, campaignId, scenes);
}

/** Queue key: actions in one storyline resolve in order; different storylines run concurrently. */
export function storylineKey(campaignId: string, sceneId: string | null | undefined): string {
  return `${campaignId}:story:${sceneId ?? 'main'}`;
}

export function playerCharacterIds(db: Db, campaignId: string): Set<string> {
  return new Set(playerCharacterOwners(db, campaignId).keys());
}

/**
 * The shared world clock: the earliest in-world time among active storylines that have player
 * characters and were active recently. Idle storylines do not hold everyone else back.
 */
export function worldClock(db: Db, campaignId: string, opts: { excludeSceneId?: string; now?: number } = {}): number | null {
  const pcs = playerCharacterIds(db, campaignId);
  const cutoff = (opts.now ?? Date.now()) - IDLE_STORYLINE_MINUTES * 60_000;
  let min: number | null = null;
  for (const s of activeScenes(db, campaignId)) {
    if (s.id === opts.excludeSceneId) continue;
    if (!participants(s).some((p) => pcs.has(p))) continue;
    if (Date.parse(s.updated_at) < cutoff) continue;
    // A storyline busy with a long action is already "living through" it: it counts at its finish
    // time, so it never holds the rest of the world back.
    const t = timeMin(s);
    const busy = sceneData(s).busy_until_min;
    const effective = typeof busy === 'number' && Number.isFinite(busy) && (t === null || busy > t) ? busy : t;
    if (effective !== null && (min === null || effective < min)) min = effective;
  }
  return min;
}

export function syncWindow(config: CampaignConfig): number {
  const w = config.time_sync_window_minutes;
  return typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : DEFAULT_SYNC_WINDOW_MINUTES;
}

export function formatClock(min: number | null): string {
  if (min === null) return 'unknown';
  const day = Math.floor(min / 1440) + 1;
  const h = Math.floor((min % 1440) / 60);
  const m = Math.floor(min % 60);
  return `Day ${day}, ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- Discord thread mapping

export interface ThreadLink {
  recordId: string;
  scene_id: string;
  thread_id: string;
  private: boolean;
  archived: boolean;
  notified_busy_until?: number;
  /** Discord users added to the thread so far. */
  members?: string[];
  /** A player asked for this storyline's thread (side:true or the 🧵 button). */
  requested?: boolean;
}

const THREAD_KIND = '_discord_thread';

export function threadFor(db: Db, campaignId: string, sceneId: string): ThreadLink | undefined {
  const r = db.prepare(`SELECT * FROM records WHERE campaign_id = ? AND kind = ? AND name = ?`).get(campaignId, THREAD_KIND, sceneId) as RecordRow | undefined;
  if (!r) return undefined;
  return { recordId: r.id, ...(JSON.parse(r.data_json) as Omit<ThreadLink, 'recordId'>) };
}

/** Application-owned mapping record (reserved kind, invisible and unwritable for the model). */
export function saveThread(db: Db, campaignId: string, sceneId: string, patch: Partial<Omit<ThreadLink, 'recordId' | 'scene_id'>>): void {
  const cur = threadFor(db, campaignId, sceneId);
  const ts = nowIso();
  if (cur) {
    const { recordId, ...data } = cur;
    db.prepare('UPDATE records SET data_json = ?, version = version + 1, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...data, ...patch }), ts, recordId);
  } else {
    db.prepare(
      `INSERT INTO records (id, campaign_id, kind, name, parent_id, visibility, data_json, gm_notes_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'gm', ?, '{}', 1, ?, ?)`,
    ).run(newRecordId('discord_thread'), campaignId, THREAD_KIND, sceneId, JSON.stringify({ scene_id: sceneId, thread_id: '', private: false, archived: false, ...patch }), ts, ts);
  }
}

/** Resolves a campaign from a Discord thread channel the bot created. */
export function campaignIdForThread(db: Db, threadId: string): string | undefined {
  const r = db.prepare(`SELECT campaign_id FROM records WHERE kind IN (?, ?) AND json_extract(data_json, '$.thread_id') = ?`).get(THREAD_KIND, PRIVATE_KIND, threadId) as
    | { campaign_id: string }
    | undefined;
  return r?.campaign_id;
}

export function sceneName(db: Db, campaignId: string, sceneId: string | null): string | null {
  if (!sceneId) return null;
  return getRecord(db, campaignId, sceneId)?.name ?? null;
}

// ---------------------------------------------------------------- private threads

const PRIVATE_KIND = '_discord_private';

/**
 * A player's private thread with the DM (whispered actions, thoughts, secret questions). One per
 * player per campaign; not tied to any place or storyline.
 */
export function privateThreadFor(db: Db, campaignId: string, userId: string): { recordId: string; thread_id: string } | undefined {
  const r = db.prepare(`SELECT * FROM records WHERE campaign_id = ? AND kind = ? AND name = ?`).get(campaignId, PRIVATE_KIND, userId) as RecordRow | undefined;
  return r ? { recordId: r.id, ...(JSON.parse(r.data_json) as { thread_id: string }) } : undefined;
}

export function savePrivateThread(db: Db, campaignId: string, userId: string, threadId: string): void {
  const cur = privateThreadFor(db, campaignId, userId);
  const ts = nowIso();
  if (cur) db.prepare('UPDATE records SET data_json = ?, version = version + 1, updated_at = ? WHERE id = ?').run(JSON.stringify({ user_id: userId, thread_id: threadId }), ts, cur.recordId);
  else
    db.prepare(
      `INSERT INTO records (id, campaign_id, kind, name, parent_id, visibility, data_json, gm_notes_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'gm', ?, '{}', 1, ?, ?)`,
    ).run(newRecordId('discord_private'), campaignId, PRIVATE_KIND, userId, JSON.stringify({ user_id: userId, thread_id: threadId }), ts, ts);
}

/** The user whose private thread this channel is, if any. */
export function privateThreadOwner(db: Db, campaignId: string, threadId: string): string | undefined {
  const r = db.prepare(`SELECT name FROM records WHERE campaign_id = ? AND kind = ? AND json_extract(data_json, '$.thread_id') = ?`).get(campaignId, PRIVATE_KIND, threadId) as { name: string } | undefined;
  return r?.name;
}
