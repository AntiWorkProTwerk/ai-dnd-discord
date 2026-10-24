// 3D renders of a scene: Blender builds one scene from the public game state (scene3d.ts: room,
// furniture, a figure or saved miniature for each token) and renders it with one of three
// cameras: the cinematic shot (🎨), a raised 3/4 diorama view with a floor grid (🧊, optionally a
// short turntable video) and a flat top-down view that the battle map (🗺️) draws its overlays
// on. Exact positions, no AI, no extra hands. Runs under the local pipeline's shared GPU lock on
// the same queue as paintings.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectRoot } from './database.js';
import { ImageBusyError } from './images.js';
import type { SceneSpec } from './scene3d.js';
import type { TurnRow } from './types.js';

export interface DioramaConfig {
  enabled: boolean;
  blender: string;
  pipelineRoot: string;
  python: string;
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
    timeoutMs: (Number(env.DIORAMA_TIMEOUT_SECONDS) || 300) * 1000,
  };
}

export interface MiniatureBuilder {
  build(portraitPath: string, outPath: string, workDir: string): Promise<{ path: string; seconds: number }>;
}

/** Portrait to GLB through the local 3D pipeline's pinned TRELLIS.2 graph (about 3 minutes; Pixal3D if memory runs out). */
export function createMiniatureBuilder(cfg: DioramaConfig): MiniatureBuilder {
  const script = path.join(projectRoot(), 'scripts', 'miniature.py');
  return {
    build(portraitPath, outPath, workDir) {
      return new Promise((resolve, reject) => {
        const args = [script, '--pipeline-root', cfg.pipelineRoot, '--image', portraitPath, '--out', outPath, '--work', workDir];
        execFile(cfg.python, args, { timeout: 20 * 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          const line = stdout.trim().split(/\r?\n/).pop() ?? '';
          let r: { ok: boolean; path?: string; seconds?: number; error?: string; busy?: boolean };
          try {
            r = JSON.parse(line);
          } catch {
            return reject(new Error(err ? String(err.message).slice(0, 300) : 'no output from miniature builder'));
          }
          if (r.ok) return resolve({ path: r.path!, seconds: r.seconds ?? 0 });
          reject(r.busy ? new ImageBusyError('the GPU is busy with another pipeline job') : new Error(r.error ?? 'miniature build failed'));
        });
      });
    },
  };
}

export function dioramaPathFor(dataDir: string, turn: Pick<TurnRow, 'campaign_id' | 'id'>, ext: 'png' | 'mp4' = 'png'): string {
  return path.join(dataDir, 'images', turn.campaign_id, `diorama-turn-${turn.id}.${ext}`);
}

export type SceneView = 'shot' | 'diorama' | 'map';

export interface SceneRenderOptions {
  /** Camera: the cinematic shot (default), the raised diorama view, or flat top-down for maps. */
  view?: SceneView;
  /** Map view only: pixels per grid cell (the image is cols*px by rows*px). */
  px?: number;
  /** Diorama view only: also write a short rotating video here. */
  turntable?: string;
}

export interface SceneRenderResult {
  path: string;
  video: string | null;
  seconds: number;
}

export interface SceneRenderer {
  render(spec: SceneSpec, outPath: string, opts?: SceneRenderOptions): Promise<SceneRenderResult>;
}

/** 3D scene renders (scripts/scene_blender.py) through the GPU-locked wrapper (scripts/diorama.py). */
export function createSceneRenderer(cfg: DioramaConfig, engine: 'eevee' | 'cycles' = 'eevee'): SceneRenderer {
  const script = path.join(projectRoot(), 'scripts', 'diorama.py');
  return {
    render(spec, outPath, opts = {}) {
      return new Promise((resolve, reject) => {
        const specFile = path.join(os.tmpdir(), `dmbot-scene-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8');
        const view = opts.view ?? 'shot';
        const args = [script, '--pipeline-root', cfg.pipelineRoot, '--blender', cfg.blender, '--script', 'scene_blender.py', '--scene', specFile, '--out', outPath, '--engine', engine, '--timeout', String(Math.round(cfg.timeoutMs / 1000)), '--view', view];
        if (view === 'map' && opts.px) args.push('--px', String(opts.px));
        if (view === 'diorama' && opts.turntable) args.push('--turntable', opts.turntable);
        execFile(cfg.python, args, { timeout: cfg.timeoutMs + 30_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          fs.rmSync(specFile, { force: true });
          const line = stdout.trim().split(/\r?\n/).pop() ?? '';
          let r: { ok: boolean; path?: string; video?: string | null; seconds?: number; error?: string; busy?: boolean };
          try {
            r = JSON.parse(line);
          } catch {
            return reject(new Error(err ? String(err.message).slice(0, 300) : 'no output from scene renderer'));
          }
          if (r.ok) return resolve({ path: r.path!, video: r.video ?? null, seconds: r.seconds ?? 0 });
          reject(r.busy ? new ImageBusyError('the GPU is busy with another pipeline job') : new Error(r.error ?? `scene render (${view}) failed`));
        });
      });
    },
  };
}
