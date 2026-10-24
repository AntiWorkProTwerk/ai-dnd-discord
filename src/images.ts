// Optional scene illustrations from the owner's local image pipeline (ComfyUI + FLUX through the
// local 2D asset workshop). Free to run: no paid or remote model is involved, and image prompts
// are built from public narration and public records only, so GM secrets never reach a picture.
// Images never change game state.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRecord, projectRoot, type Db } from './database.js';
import { describePlacement, mapSnapshot, type MapSnapshot } from './maps.js';
import { storylineOf } from './storylines.js';
import { log } from './log.js';
import type { RecordRow, TurnRow } from './types.js';

export interface ImageConfig {
  enabled: boolean;
  pipelineRoot: string;
  python: string;
  width: number;
  height: number;
  timeoutMs: number;
  style: string;
  maxQueue: number;
  unloadAfter: boolean;
  steps: number;
  /** `portraits`: pass the focus characters' portraits as reference images (IMAGE_REFERENCES). */
  references: 'off' | 'portraits';
  /** `render3d`: 🎨 renders the scene in Blender with the saved 3D models; `paint`: FLUX painting (IMAGE_MODE). */
  mode: 'render3d' | 'paint';
}

export function loadImageConfig(env: NodeJS.ProcessEnv = process.env): ImageConfig {
  const root = env.IMAGE_PIPELINE_ROOT?.trim() || 'D:/Godot/local-2d-pipeline';
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: (env.IMAGE_GENERATION ?? 'off').trim().toLowerCase() === 'comfy',
    pipelineRoot: root,
    python: env.IMAGE_PYTHON?.trim() || path.join(root, '.venv', 'Scripts', 'python.exe'),
    width: num(env.IMAGE_WIDTH, 1024),
    height: num(env.IMAGE_HEIGHT, 576),
    timeoutMs: num(env.IMAGE_TIMEOUT_SECONDS, 300) * 1000,
    style:
      env.IMAGE_STYLE?.trim() ||
      'Highly detailed digital fantasy illustration, dramatic cinematic lighting, painterly textures, rich color, sharp focus',
    maxQueue: num(env.IMAGE_MAX_QUEUE, 4),
    unloadAfter: (env.IMAGE_UNLOAD_AFTER ?? 'false').trim().toLowerCase() === 'true',
    // FLUX.2 Klein is tuned for 4 steps; 8 measurably improved figure coherence for ~1-2 s more.
    steps: num(env.IMAGE_STEPS, 8),
    references: (env.IMAGE_REFERENCES ?? 'portraits').trim().toLowerCase() === 'off' ? 'off' : 'portraits',
    mode: (env.IMAGE_MODE ?? 'render3d').trim().toLowerCase() === 'paint' ? 'paint' : 'render3d',
  };
}

// ---------------------------------------------------------------- prompt

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);

function plain(text: string): string {
  return text
    .replace(/\*\*|__|\*|_|`|~~|^#+\s*|^>\s*/gm, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function publicData(r: RecordRow | undefined): Record<string, unknown> | null {
  if (!r || r.visibility !== 'public' || r.kind.startsWith('_')) return null;
  try {
    return JSON.parse(r.data_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Short visual description of a character from its public sheet. */
export function heroLook(r: RecordRow | undefined): string {
  const d = publicData(r);
  if (!d || !r) return '';
  const str = (k: string) => (typeof d[k] === 'string' && (d[k] as string).length > 0 ? (d[k] as string) : undefined);
  // One descriptive field is enough; bare class names tend to be painted as signs.
  const main = str('appearance') ?? str('concept') ?? str('description') ?? [str('ancestry') ?? str('species'), str('archetype') ?? str('class')].filter(Boolean).join(' ');
  return clip(plain(main), 200).replace(/[.;]+$/, '');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Sentences about game mechanics or turn order describe nothing a painter can show. */
const MECHANICS = /\b(turn|round|initiative|rolls?|rolled|checks?|DC|AC|HP|hit points?|damage|bonus|modifier|xp|gp|sp|unhurt|unharmed|reaction|saving throw|attack roll|charges?|what do you|what will you|your move|decision|next|acts?)\b/i;

const PREPOSITIONS = new Set(['on', 'in', 'at', 'of', 'from', 'near', 'to', 'toward', 'towards', 'across', 'into', 'beyond', 'past', 'inside', 'outside', 'by']);

/**
 * Image models paint proper names as garbled lettering, so names become visual descriptions:
 * the acting character is "the hero", public people get their role, items stay as plain words,
 * places and story titles are dropped. Only public records are consulted, so hidden names are
 * never described; any remaining unknown proper noun is removed.
 */
export function namer(db: Db, campaignId: string, labels: Map<string, string>): (text: string) => string {
  const rows = db
    .prepare(`SELECT * FROM records WHERE campaign_id = ? AND visibility = 'public' AND archived_at IS NULL AND kind NOT LIKE '\\_%' ESCAPE '\\' LIMIT 400`)
    .all(campaignId) as RecordRow[];
  const subs: [RegExp, string][] = [];
  for (const r of rows) {
    let label: string;
    if (labels.has(r.id)) label = labels.get(r.id)!;
    else if (r.kind === 'item') label = r.name.toLowerCase();
    else if (r.kind === 'location') label = 'the place';
    else if (r.kind === 'npc' || r.kind === 'character') label = roleLabel(r);
    else label = ''; // scenes, quests, factions, events: titles, not visuals
    // "The Tallow and Tide" also matches "the Tallow and Tide" (and the bare "Tallow and Tide").
    const core = r.name.replace(/^(the|a|an)\s+/i, '');
    subs.push([new RegExp(`\\b(?:(?:the|a|an)\\s+)?${escapeRe(core)}\\b`, 'gi'), label]);
    if (r.kind === 'npc' || r.kind === 'character') {
      for (const word of r.name.split(/\s+/)) if (/^[A-Z][a-z]{3,}$/.test(word)) subs.push([new RegExp(`\\b${word}\\b`, 'g'), label]);
    }
  }
  subs.sort((a, b) => b[0].source.length - a[0].source.length);
  return (text) => {
    let out = text;
    for (const [re, label] of subs) out = out.replace(re, label);
    out = out
      .replace(/\b[Yy]ou[’']re\b/g, 'the hero is')
      .replace(/\b[Yy]ou[’']ve\b/g, 'the hero has')
      .replace(/\b[Yy]ou[’']ll\b/g, 'the hero will')
      .replace(/\b[Yy]ou[’']d\b/g, 'the hero would')
      .replace(/\b[Yy]ours\b/g, "the hero's")
      .replace(/\b[Yy]our\b/g, "the hero's")
      .replace(/\b[Yy]ourself\b/g, 'the hero')
      .replace(/\b[Yy]ou(\s+)(haven|don|aren|weren)[’']t\b/g, (_m, sp: string, w: string) => `the hero${sp}${({ haven: 'has', don: 'does', aren: 'is', weren: 'was' } as Record<string, string>)[w]}n't`)
      .replace(/\b[Yy]ou(\s+)([a-z]+)\b(?![’'])/g, (_m, sp: string, w: string) => `the hero${sp}${thirdPerson(w)}`)
      .replace(/\b[Yy]ou\b/g, 'the hero');
    // Remove any proper noun left mid-sentence (unknown names, place names, titles).
    return out
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => {
        const words = sentence.split(' ');
        const keep: string[] = [];
        for (let i = 0; i < words.length; i++) {
          const w = words[i]!;
          if (i > 0 && /^[A-Z][a-z’']+[.,;:!?]?$/.test(w) && w !== 'I') {
            let j = i;
            // Extend over "of", "the" and "and" when another capitalized word follows.
            while (
              j + 1 < words.length &&
              !/[.,;:!?]$/.test(words[j]!) &&
              (/^[A-Z][a-z’']+[.,;:!?]?$/.test(words[j + 1]!) || (/^(of|the|and)$/.test(words[j + 1]!) && /^[A-Z]/.test(words[j + 2] ?? '')))
            )
              j++;
            const punct = /[.,;:!?]$/.exec(words[j]!)?.[0] ?? '';
            if (/^(the|a|an)$/i.test(keep[keep.length - 1] ?? '')) keep.pop();
            const prev = keep[keep.length - 1]?.toLowerCase();
            if (prev && PREPOSITIONS.has(prev)) {
              keep.pop();
              // "on the Stein shores," -> drop the dangling common noun that ended the phrase too.
              const next = words[j + 1];
              if (!punct && next && /^[a-z]+[.,;:!?]$/.test(next)) {
                j++;
                const p2 = /[.,;:!?]$/.exec(next)?.[0] ?? '';
                if (p2 && keep.length) keep[keep.length - 1] += p2;
              }
            } else keep.push('someone');
            if (punct && keep.length) keep[keep.length - 1] += punct;
            i = j;
            continue;
          }
          keep.push(w);
        }
        return keep.join(' ');
      })
      .join(' ')
      .replace(/\b(a|an|the) (a|an|the) /gi, '$1 ')
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };
}

/** Drops quoted dialogue: a distilled image model renders quotes as gibberish speech bubbles. */
function withoutDialogue(text: string): string {
  return text
    .replace(/[“"][^”"]{0,600}[”"]/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Visual sentences only: no questions, no mechanics, no numbers (prices become painted text). */
function visualSentences(text: string): string {
  return text
    .split(/(?<=[.!?…])\s+/)
    .filter((s) => s && !/\?\s*$/.test(s))
    .map((s) => {
      // Keep the visual clauses of a sentence that also mentions turns or numbers.
      const clauses = s.replace(/[.!…]+$/, '').split(/;\s+|,\s+(?=(?:and|but|while)\s)/);
      const kept = clauses.filter((c) => !MECHANICS.test(c) && !/\d/.test(c));
      return kept.length ? `${kept.join('; ')}.` : '';
    })
    .filter(Boolean)
    .join(' ');
}

const NOT_VERBS = new Set(['is', 'was', 'were', 'are', 'am', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'did', 'do', 'does', 'and', 'or', 'but', 'with', 'in', 'on', 'at', 'of', 'to', 'from', 'who', 'that', 'alone', 'too', 'all', 'still', 'also', 'just', 'now', 'then', 'never', 'always', 'already', 'again', 'both', 'here', 'there', 'instead', 'together', 'yourself']);
const IRREGULAR: Record<string, string> = { are: 'is', have: 'has', do: 'does', were: 'was' };

/** "you step" -> "the hero steps": a present-tense verb after a replaced "you" gets third-person -s. */
function thirdPerson(w: string): string {
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (NOT_VERBS.has(w) || /(ed|ing|ly|s)$/.test(w) || w.length < 3) return w;
  if (/(sh|ch|x|z|o)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

/** A short role label for a person: "the innkeeper", or a generic one when no short role is known. */
function roleLabel(r: RecordRow): string {
  const d = publicData(r) ?? {};
  const role = ['role', 'occupation', 'title']
    .map((k) => (typeof d[k] === 'string' ? (d[k] as string).split(/[,;(]/)[0]!.trim() : ''))
    .find((v) => v.length > 0 && v.length < 40);
  return role ? `the ${plain(role).toLowerCase().replace(/^(a|an|the)\s+/, '')}` : r.kind === 'character' ? 'a companion' : 'a local';
}

const lowerArticle = (s: string) => s.replace(/^(a|an|the)\s+/i, (m) => m.toLowerCase());

const listJoin = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The storyline (scene record) the turn was played in. */
export function sceneFor(db: Db, turn: Pick<TurnRow, 'campaign_id' | 'scene_id'>, actor: RecordRow | undefined): RecordRow | undefined {
  const byTurn = turn.scene_id ? getRecord(db, turn.campaign_id, turn.scene_id) : undefined;
  return byTurn ?? (actor ? storylineOf(db, turn.campaign_id, actor.id) : undefined);
}

export function isFight(scene: RecordRow | undefined): boolean {
  const d = publicData(scene);
  if (!d) return false;
  return (Array.isArray(d.initiative) && d.initiative.length > 1) || (typeof d.round === 'number' && d.round > 0) || d.combat === true;
}

export interface CastMember {
  record: RecordRow;
  label: string;
  /** Visible state: wounds, simple conditions, carried items, weapon in hand. */
  details: string;
}

/**
 * The public people in the storyline, with labels that tell them apart: the acting character is
 * "the hero", other player characters "the companion" (or "the first/second companion"), others
 * their role.
 */
export function castOf(db: Db, campaignId: string, scene: RecordRow | undefined, actor: RecordRow | undefined): CastMember[] {
  const d = publicData(scene);
  const ids = [...new Set([...(actor ? [actor.id] : []), ...(d && Array.isArray(d.participants_ids) ? (d.participants_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [])])];
  const rows = ids.map((id) => getRecord(db, campaignId, id)).filter((r): r is RecordRow => !!r && !r.archived_at && !!publicData(r));
  const companions = rows.filter((r) => r.id !== actor?.id && r.kind === 'character');
  const ordinal = ['first', 'second', 'third', 'fourth', 'fifth'];
  return rows.map((r) => {
    let label: string;
    if (r.id === actor?.id) label = 'the hero';
    else if (r.kind === 'character') label = companions.length === 1 ? 'the companion' : `the ${ordinal[companions.indexOf(r)] ?? 'other'} companion`;
    else label = roleLabel(r);
    return { record: r, label, details: visibleState(db, campaignId, r) };
  });
}

/** What a painter could see about a person: hurt or down, simple conditions, weapon and gear. */
export function visibleState(db: Db, campaignId: string, r: RecordRow): string {
  const d = publicData(r) ?? {};
  const bits: string[] = [];
  const hp = d.hp as { current?: unknown; max?: unknown } | undefined;
  if (hp && typeof hp.current === 'number' && typeof hp.max === 'number' && hp.max > 0) {
    if (hp.current <= 0) bits.push('collapsed and badly hurt');
    else if (hp.current / hp.max <= 0.5) bits.push('bloodied and wounded');
  }
  if (Array.isArray(d.conditions)) {
    for (const c of d.conditions.slice(0, 2)) if (typeof c === 'string' && c.length < 20 && !MECHANICS.test(c) && !/\d/.test(c)) bits.push(c.toLowerCase());
  }
  const weapon = Array.isArray(d.attacks) && typeof d.attacks[0] === 'string' ? (d.attacks[0] as string).split(/[+(,]/)[0]!.trim().toLowerCase() : '';
  const gear = (db.prepare(`SELECT name FROM records WHERE campaign_id = ? AND parent_id = ? AND kind = 'item' AND visibility = 'public' AND archived_at IS NULL ORDER BY created_at LIMIT 3`).all(campaignId, r.id) as { name: string }[])
    .map((x) => x.name.toLowerCase())
    .filter((n) => n.length < 40 && !/\d/.test(n));
  const carried = [...new Set([weapon, ...gear].filter((x) => x && x.length < 40 && !/\d/.test(x)))];
  if (carried.length) bits.push(`carrying ${listJoin(carried.map((x) => (/^(a|an|the|some)\s/.test(x) || /s$/.test(x) ? x : `${/^[aeiou]/.test(x) ? 'an' : 'a'} ${x}`)))}`);
  return bits.join(', ');
}

/**
 * Builds a scene prompt from the turn's public narration and the current public game state (the
 * storyline's people, their looks, wounds and gear, whether a fight is on) and the public
 * location, with no model call. Never reads gm_notes or non-public records.
 * FLUX.2 Klein is distilled (CFG 1, no negative prompt), so the prompt only describes what to show.
 */
export function buildScenePrompt(db: Db, turn: TurnRow, style: string, tone = ''): string {
  return buildScenePlan(db, turn, style, tone).prompt;
}

export interface ScenePlan {
  prompt: string;
  /** Portrait files passed as reference images, in prompt order. */
  refs: string[];
  /** Record IDs the picture focuses on (at most 3). */
  focus: string[];
}

const MAX_FOCUS = 3;
/** More reference portraits made the model swap features between people; two stays reliable. */
const MAX_PORTRAIT_REFS = 2;

/**
 * The scene prompt plus reference portraits. Focus: the actor, whose turn it is, people named in
 * the narration, then the nearest on the battle map. Player characters in focus with a portrait
 * are passed as references; positions come from the battle map, in words.
 */
export function buildScenePlan(db: Db, turn: TurnRow, style: string, tone = '', portraitOf: (recordId: string) => string | null = () => null): ScenePlan {
  const actor = turn.actor_character_id ? getRecord(db, turn.campaign_id, turn.actor_character_id) : undefined;
  const story = sceneFor(db, turn, actor);
  const cast = castOf(db, turn.campaign_id, story, actor);
  const stored = (JSON.parse(turn.delivery_json || '{}') as { map_snapshot?: MapSnapshot }).map_snapshot;
  // A made-up sketch places nobody: only a real battle map gives the painting a composition.
  const snapshot = (stored?.sketch ? null : stored) ?? mapSnapshot(db, turn.campaign_id, story);
  const labels = new Map(cast.map((c) => [c.record.id, c.label]));
  if (actor) labels.set(actor.id, 'the hero');
  const names = namer(db, turn.campaign_id, labels);
  const placeId = (publicData(story) ? story?.parent_id : null) ?? actor?.parent_id;
  const place = placeId ? getRecord(db, turn.campaign_id, placeId) : undefined;
  const placeData = publicData(place);
  const parts = [style];

  // Only the GM's narration is used, never the player's raw message: the narration is what
  // actually happened, and it has already been through the GM's content boundaries. A reply that
  // is all turn-order talk falls back to the latest visual narration in the same storyline.
  const visual = (t: Pick<TurnRow, 'public_reply'>) => names(visualSentences(withoutDialogue(plain(t.public_reply ?? ''))));
  let scene = visual(turn);
  if (!scene && story) {
    const earlier = db
      .prepare(`SELECT public_reply FROM turns WHERE campaign_id = ? AND scene_id = ? AND mode = 'play' AND id < ? AND status IN ('committed', 'delivered') AND json_extract(delivery_json, '$.whisper') IS NULL ORDER BY id DESC LIMIT 3`)
      .all(turn.campaign_id, story.id, turn.id) as Pick<TurnRow, 'public_reply'>[];
    scene = earlier.map(visual).find(Boolean) ?? '';
  }
  const fighting = cast.length > 1 && isFight(story);
  const focus = focusOf(cast, actor, story, snapshot, turn.public_reply ?? '');
  const focusCast = cast.filter((c) => focus.includes(c.record.id));
  const others = focusCast.filter((c) => c.record.id !== actor?.id);
  const background = cast.length - focusCast.length;

  // Reference portraits first, so the prompt can name them: "Image 1 shows the hero…".
  const refs: string[] = [];
  const refLabels: string[] = [];
  for (const c of focusCast) {
    if (refs.length >= MAX_PORTRAIT_REFS || c.record.kind !== 'character') continue;
    const file = portraitOf(c.record.id);
    if (file) {
      refs.push(file);
      refLabels.push(c.label);
    }
  }
  if (refs.length) {
    // Reference sheets otherwise tempt the model into side-by-side panels with people repeated.
    parts.push('One single continuous scene in one frame, not a split panel or collage; each person appears only once');
    parts.push(
      `${refLabels.map((l, i) => `${i ? 'image' : 'Image'} ${i + 1} shows ${l}`).join(' and ')}: keep ${refs.length > 1 ? "each one's" : 'their'} face, hair, beard, build and clothes exactly as in ${refs.length > 1 ? 'their' : 'that'} image, and do not give their features to anyone else`,
    );
  }

  if (!scene) scene = fighting && others.length ? `The hero fights in a chaotic brawl with ${listJoin(others.map((c) => c.label))}` : 'The hero stands ready, the scene quiet and tense';
  parts.push(clip(scene, 480));
  if (fighting && !/\b(fight|brawl|battle|melee|combat|swing|strike|struck|attack)/i.test(scene)) parts.push('A fight is under way');
  if (snapshot) {
    const placement = names(describePlacement(snapshot, new Map(focusCast.map((c) => [c.record.id, c.label]))));
    if (placement && focusCast.length > 1) parts.push(`Composition: ${placement}`);
  }

  // Everyone in focus, from the current game state: look, condition and what they carry.
  const look = names(heroLook(actor));
  const heroCast = cast.find((c) => c.record.id === actor?.id);
  const heroBits = [lowerArticle(look), heroCast ? names(heroCast.details) : ''];
  if (heroBits.some(Boolean)) parts.push(`The hero is ${heroBits.filter(Boolean).join(', ')}`);
  if (others.length) {
    parts.push(
      `Also in the scene: ${others
        .map((c) => [c.label, lowerArticle(names(heroLook(c.record))), names(c.details)].filter(Boolean).join(', '))
        .join('; ')}`,
    );
  }
  if (background > 0) parts.push(background === 1 ? 'One more figure in the background' : 'A few more figures in the background');
  if (place && placeData && typeof placeData.description === 'string') {
    const setting = names(visualSentences(plain(placeData.description)));
    if (setting) parts.push(`Setting: ${clip(setting, 160)}`);
  }
  const mood = tone.split(/[,;.]/)[0]?.trim();
  if (mood && mood.length <= 30 && !/rain|snow|storm/i.test(mood)) parts.push(`${mood} atmosphere`);
  parts.push('A wordless image');
  const prompt = parts
    .map((p) => p.replace(/[.\s]+$/, ''))
    .join('. ')
    .concat('.')
    .replace(/(^|[.!?…]\s+)([a-z])/g, (_m, pre: string, c: string) => pre + c.toUpperCase());
  return { prompt, refs, focus };
}

/** At most three people in focus: fewer figures means fewer anatomy errors and swapped faces. */
export function focusOf(cast: CastMember[], actor: RecordRow | undefined, scene: RecordRow | undefined, snapshot: MapSnapshot | null | undefined, narration: string): string[] {
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !out.includes(id) && out.length < MAX_FOCUS && cast.some((c) => c.record.id === id)) out.push(id);
  };
  add(actor?.id);
  const d = publicData(scene);
  add(typeof d?.turn_of_id === 'string' ? d.turn_of_id : undefined);
  for (const c of cast) {
    const words = c.record.name.split(/\s+/).filter((w) => w.length > 3);
    if (words.some((w) => new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(narration))) add(c.record.id);
  }
  const me = snapshot?.tokens.find((t) => t.id === actor?.id);
  const byDistance = [...cast].sort((a, b) => {
    const ta = snapshot?.tokens.find((t) => t.id === a.record.id);
    const tb = snapshot?.tokens.find((t) => t.id === b.record.id);
    const dist = (t: typeof ta) => (t && me ? Math.max(Math.abs(t.x - me.x), Math.abs(t.y - me.y)) : 99);
    return dist(ta) - dist(tb);
  });
  for (const c of byDistance) add(c.record.id);
  return out;
}

// ---------------------------------------------------------------- generator

export interface ImageResult {
  path: string;
  seconds: number;
}

export interface GenerateOptions {
  width?: number;
  height?: number;
  steps?: number;
  /** Reference images (portraits, layout guide) for FLUX.2 ReferenceLatent conditioning; at most 4. */
  refs?: string[];
  /** Folder every reference must be inside (the bot's image folder). */
  refRoot?: string;
}

export interface ImageGenerator {
  generate(prompt: string, seed: number, outPath: string, opts?: GenerateOptions): Promise<ImageResult>;
}

export class ImageBusyError extends Error {}

/** Runs the bridge script with the workshop's interpreter. Retries briefly if the GPU is busy. */
export function createWorkshopGenerator(cfg: ImageConfig): ImageGenerator {
  const script = path.join(projectRoot(), 'scripts', 'comfy_image.py');
  const once = (prompt: string, seed: number, outPath: string, opts: GenerateOptions) =>
    new Promise<ImageResult & { busy?: boolean; error?: string; ok: boolean }>((resolve) => {
      const promptFile = path.join(os.tmpdir(), `dmbot-prompt-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf8');
      const args = [script, '--pipeline-root', cfg.pipelineRoot, '--prompt-file', promptFile, '--out', outPath, '--seed', String(seed), '--width', String(opts.width ?? cfg.width), '--height', String(opts.height ?? cfg.height), '--timeout', String(Math.round(cfg.timeoutMs / 1000)), '--steps', String(opts.steps ?? cfg.steps)];
      for (const ref of (opts.refs ?? []).slice(0, 4)) args.push('--ref', ref);
      if (opts.refs?.length && opts.refRoot) args.push('--ref-root', opts.refRoot);
      if (cfg.unloadAfter) args.push('--unload');
      execFile(cfg.python, args, { timeout: cfg.timeoutMs + 30_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        fs.rmSync(promptFile, { force: true });
        const line = stdout.trim().split(/\r?\n/).pop() ?? '';
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, path: '', seconds: 0, error: err ? String(err.message).slice(0, 300) : 'no output from image bridge' });
        }
      });
    });
  return {
    async generate(prompt, seed, outPath, opts = {}) {
      for (let attempt = 1; ; attempt++) {
        const r = await once(prompt, seed, outPath, opts);
        if (r.ok) return { path: r.path, seconds: r.seconds };
        if (r.busy && attempt < 4) {
          await new Promise((res) => setTimeout(res, 15_000));
          continue;
        }
        if (r.busy) throw new ImageBusyError('the GPU is busy with another pipeline job');
        throw new Error(r.error ?? 'image generation failed');
      }
    },
  };
}

/** One image at a time on the GPU, with a bounded backlog. */
export class ImageQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(private readonly max: number) {}
  get size(): number {
    return this.pending;
  }
  run<T>(job: () => Promise<T>): Promise<T> | null {
    if (this.pending >= this.max) return null;
    this.pending++;
    const next = this.chain.then(job, job).finally(() => this.pending--);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export function imagePathFor(dataDir: string, turn: TurnRow): string {
  return path.join(dataDir, 'images', turn.campaign_id, `turn-${turn.id}.png`);
}

export function logImageError(turnId: number, err: unknown): void {
  log.warn('image generation failed', { turn: turnId, err });
}
