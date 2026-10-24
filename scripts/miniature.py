"""Turns a character portrait into a 3D miniature (GLB) with the local 3D pipeline (no paid services).

Run with the 2D workshop's interpreter, which loads the 3D pipeline's asset module:
  D:/Godot/local-2d-pipeline/.venv/Scripts/python.exe scripts/miniature.py \
    --pipeline-root D:/Godot/local-2d-pipeline --image portrait.png --out miniature.glb --work logs/

It reuses the pipeline's pinned Pixal3D image-to-model graph, its GPU lock, its offline ComfyUI
launcher and its job runner (saved graphs, history, OOM-safe settings). Takes a few minutes.
Prints one JSON line.
"""
import argparse
import contextlib
import io
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--pipeline-root', required=True)
    p.add_argument('--image', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--work', required=True, help='folder for the saved graph, history and job files')
    p.add_argument('--seed', type=int, default=11)
    # TRELLIS.2 at 1024 with 2048 textures: about 3 minutes on a 12 GB card, and a face you can
    # recognize (512/512 Pixal3D gave a smeared mask). Built once per character and portrait.
    p.add_argument('--triangles', type=int, default=40000)
    p.add_argument('--resolution', type=int, default=1024, choices=[512, 1024])
    p.add_argument('--texture', type=int, default=2048)
    p.add_argument('--backend', default='trellis2', choices=['pixal3d', 'trellis2'])
    a = p.parse_args()
    started = time.monotonic()
    image = Path(a.image).resolve()
    if image.suffix.lower() != '.png' or not image.is_file():
        raise ValueError(f'portrait must be an existing PNG: {image}')
    if not 2000 <= a.triangles <= 40000:
        raise ValueError('triangles must be 2000-40000')
    sys.path.insert(0, str(Path(a.pipeline_root)))
    from workshop.offline import enable
    enable()
    from workshop.common import shared

    module = shared()
    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    with module.gpu_lock():
        with contextlib.redirect_stdout(io.StringIO()):
            module.start()
            schemas = module.api('/object_info')
            uploaded = module.upload(image)
            settings = dict(image=uploaded, seed=a.seed, backend=a.backend, resolution=a.resolution, texture=a.texture, triangles=a.triangles)
            try:
                result = module.run_graph(module.workflows.generate(schemas, **settings), work, 'miniature')
            except RuntimeError as exc:
                if not any(t in str(exc).lower() for t in ('out of memory', 'outofmemory', 'cuda error: memory')):
                    raise
                # Out of memory: the lighter backend at its default geometry, still with usable textures.
                settings.update(backend='pixal3d', resolution=512, texture=1024, triangles=min(a.triangles, 20000))
                result = module.run_graph(module.workflows.generate(schemas, **settings), work, 'miniature-retry')
        with tempfile.TemporaryDirectory() as tmp:
            files = module.copy_outputs(result, Path(tmp), {'.glb'})
            if not files:
                raise RuntimeError('the 3D pipeline returned no GLB')
            out = Path(a.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(files[0], out)
    print(json.dumps({'ok': True, 'path': str(Path(a.out).resolve()), 'seconds': round(time.monotonic() - started, 1), 'settings': {k: v for k, v in settings.items() if k != 'image'}}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:  # reported to the bot as a single JSON line
        busy = 'Another pipeline GPU job is running' in str(exc) or 'already has a job' in str(exc)
        print(json.dumps({'ok': False, 'busy': busy, 'error': f'{type(exc).__name__}: {exc}'[:600]}))
        sys.exit(1)
