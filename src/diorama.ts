// 3D diorama renders of a battle map: Blender builds a tabletop-miniature scene from the public
// map snapshot (walls and furniture as blocks, a figure on a base for each token) and renders a
// still, optionally a short turntable video. Exact positions, no AI, no extra hands. Runs under
// the local pipeline's shared GPU lock on the same queue as paintings.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectRoot } from './database.js';
import { ImageBusyError } from './images.js';
import type { MapSnapshot } from './maps.js';
import type { TurnRow } from './types.js';

export interface DioramaConfig {
  enabled: boolean;
  blender: string;
  pipelineRoot: string;
  python: string;
  engine: 'eevee' | 'workbench';
  timeoutMs: number;
}

/** Blender's path from BLENDER_PATH, else the local 3D pipeline's config.json. */
function findBlender(env: NodeJS.ProcessEnv): string {
  if (env.BLENDER_PATH?.trim()) return env.BLENDER_PATH.trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(env.PIPELINE_3D_ROOT?.trim() || 'D:/Godot/local-3d-pipeline', 'config.json'), 'utf8')) as { blender?: string };
    if (cfg.blender) return cfg.blender;
  } catch {
    /* fall through */
  }
  return 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe';
}

export function loadDioramaConfig(env: NodeJS.ProcessEnv = process.env): DioramaConfig {
  const root = env.IMAGE_PIPELINE_ROOT?.trim() || 'D:/Godot/local-2d-pipeline';
  return {
    enabled: (env.DIORAMA ?? 'off').trim().toLowerCase() === 'on',
    blender: findBlender(env),
    pipelineRoot: root,
    python: env.IMAGE_PYTHON?.trim() || path.join(root, '.venv', 'Scripts', 'python.exe'),
    engine: (env.DIORAMA_ENGINE ?? 'eevee').trim().toLowerCase() === 'workbench' ? 'workbench' : 'eevee',
    timeoutMs: (Number(env.DIORAMA_TIMEOUT_SECONDS) || 300) * 1000,
  };
}

export interface DioramaResult {
  path: string;
  video: string | null;
  seconds: number;
}

export interface DioramaRenderer {
  render(snapshot: MapSnapshot, outPath: string, opts?: { turntable?: string }): Promise<DioramaResult>;
}

export function createDioramaRenderer(cfg: DioramaConfig): DioramaRenderer {
  const script = path.join(projectRoot(), 'scripts', 'diorama.py');
  return {
    render(snapshot, outPath, opts = {}) {
      return new Promise((resolve, reject) => {
        const sceneFile = path.join(os.tmpdir(), `dmbot-diorama-${process.pid}-${Date.now()}.json`);
        fs.writeFileSync(sceneFile, JSON.stringify(snapshot), 'utf8');
        const args = [script, '--pipeline-root', cfg.pipelineRoot, '--blender', cfg.blender, '--scene', sceneFile, '--out', outPath, '--engine', cfg.engine, '--timeout', String(Math.round(cfg.timeoutMs / 1000))];
        if (opts.turntable) args.push('--turntable', opts.turntable);
        execFile(cfg.python, args, { timeout: cfg.timeoutMs + 30_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          fs.rmSync(sceneFile, { force: true });
          const line = stdout.trim().split(/\r?\n/).pop() ?? '';
          let r: { ok: boolean; path?: string; video?: string | null; seconds?: number; error?: string; busy?: boolean };
          try {
            r = JSON.parse(line);
          } catch {
            return reject(new Error(err ? String(err.message).slice(0, 300) : 'no output from diorama renderer'));
          }
          if (r.ok) return resolve({ path: r.path!, video: r.video ?? null, seconds: r.seconds ?? 0 });
          reject(r.busy ? new ImageBusyError('the GPU is busy with another pipeline job') : new Error(r.error ?? 'diorama render failed'));
        });
      });
    },
  };
}

export function dioramaPathFor(dataDir: string, turn: Pick<TurnRow, 'campaign_id' | 'id'>, ext: 'png' | 'mp4' = 'png'): string {
  return path.join(dataDir, 'images', turn.campaign_id, `diorama-turn-${turn.id}.${ext}`);
}
