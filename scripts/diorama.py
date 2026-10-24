"""Renders the 3D scene (scripts/scene_blender.py) with Blender under the local pipeline's shared GPU lock: the
cinematic shot, the diorama (--view diorama, optionally --turntable) or the top-down map (--view map).

Run with the 2D workshop's interpreter (it provides the lock and the ComfyUI client):
  D:/Godot/local-2d-pipeline/.venv/Scripts/python.exe scripts/diorama.py \
    --pipeline-root D:/Godot/local-2d-pipeline --blender "C:/.../blender.exe" \
    --scene spec.json --out out.png [--view shot|diorama|map] [--px 96] [--turntable diorama.mp4]

ComfyUI's models are unloaded first when it is idle, so Blender has the VRAM. Prints one JSON line.
"""
import argparse
import contextlib
import io
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--pipeline-root', required=True)
    p.add_argument('--blender', required=True)
    p.add_argument('--scene', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--engine', default='eevee')
    p.add_argument('--turntable', default=None)
    p.add_argument('--timeout', type=int, default=300)
    p.add_argument('--script', default='scene_blender.py', choices=['scene_blender.py'])
    p.add_argument('--view', default='shot', choices=['shot', 'diorama', 'map'])
    p.add_argument('--px', type=int, default=None)
    a = p.parse_args()
    started = time.monotonic()
    sys.path.insert(0, str(Path(a.pipeline_root)))
    from workshop.offline import enable
    enable()
    from workshop.common import shared

    module = shared()
    with module.gpu_lock():
        with contextlib.suppress(Exception), contextlib.redirect_stdout(io.StringIO()):
            queue = module.api('/queue')
            if not queue.get('queue_running') and not queue.get('queue_pending'):
                module.api('/free', {'unload_models': True, 'free_memory': True})
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        cmd = [a.blender, '--background', '--factory-startup', '--python-exit-code', '1', '--python', str(HERE / a.script), '--',
               '--scene', a.scene, '--out', a.out, '--engine', a.engine, '--view', a.view]
        if a.px:
            cmd += ['--px', str(a.px)]
        if a.turntable:
            cmd += ['--turntable', a.turntable]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=a.timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        line = next((l for l in reversed(proc.stdout.splitlines()) if l.startswith('{"ok"')), None)
        if not line:
            raise RuntimeError(f'Blender exited {proc.returncode} without a result: {(proc.stderr or proc.stdout)[-400:]}')
        result = json.loads(line)
        if not result.get('ok'):
            raise RuntimeError(result.get('error', 'Blender render failed'))
    result['seconds'] = round(time.monotonic() - started, 1)
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:  # reported to the bot as a single JSON line
        busy = 'Another pipeline GPU job is running' in str(exc)
        print(json.dumps({'ok': False, 'busy': busy, 'error': f'{type(exc).__name__}: {exc}'[:600]}))
        sys.exit(1)
