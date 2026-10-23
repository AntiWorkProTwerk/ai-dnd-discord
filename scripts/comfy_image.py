"""Scene illustration bridge to the local 2D asset workshop (no paid or remote services).

Run with the workshop's own interpreter, e.g.
  D:/Godot/local-2d-pipeline/.venv/Scripts/python.exe scripts/comfy_image.py \
    --pipeline-root D:/Godot/local-2d-pipeline --prompt-file p.txt --out scene.png

It reuses the workshop's code rather than re-implementing it: the shared GPU lock, the offline
ComfyUI launcher (API and custom nodes disabled), the pinned FLUX.2 Klein text-to-image graph
builder, the audited node allowlist and job-scoped cancellation. Prints one JSON line.
"""
import argparse
import contextlib
import hashlib
import io
import json
import shutil
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

MAX_REFS = 4  # FLUX.2 Klein reference-image limit
MAX_REF_BYTES = 20 * 1024 * 1024


def upload_dedup(module, path):
    """Uploads a reference image under a content-hash name (overwriting), so repeated use of the
    same portrait does not grow ComfyUI's input folder."""
    data = path.read_bytes()
    name = 'dmbot_' + hashlib.sha256(data).hexdigest()[:20] + '.png'
    boundary = uuid.uuid4().hex
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'
        'Content-Type: image/png\r\n\r\n'
    ).encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    request = urllib.request.Request(module.URL + '/upload/image', data=body, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(request, timeout=60) as response:
        item = json.load(response)
    return '/'.join(p for p in [item.get('subfolder'), item['name']] if p)


def add_references(module, graph, refs, megapixels):
    """Chains FLUX.2 ReferenceLatent conditioning (positive and negative) for each reference image,
    the same core-node pattern as the pipeline's pinned image-edit graph. Output size is unchanged."""
    guider = next(k for k, n in graph.items() if n['class_type'] == 'CFGGuider')
    vae = next(k for k, n in graph.items() if n['class_type'] == 'VAELoader')
    pos, neg = graph[guider]['inputs']['positive'], graph[guider]['inputs']['negative']
    for i, ref in enumerate(refs):
        name = upload_dedup(module, ref)
        graph[f'ref{i}_load'] = {'class_type': 'LoadImage', 'inputs': {'image': name}}
        graph[f'ref{i}_scale'] = {'class_type': 'ImageScaleToTotalPixels', 'inputs': {'image': [f'ref{i}_load', 0], 'upscale_method': 'lanczos', 'megapixels': megapixels, 'resolution_steps': 1}}
        graph[f'ref{i}_enc'] = {'class_type': 'VAEEncode', 'inputs': {'pixels': [f'ref{i}_scale', 0], 'vae': [vae, 0]}}
        graph[f'ref{i}_pos'] = {'class_type': 'ReferenceLatent', 'inputs': {'conditioning': pos, 'latent': [f'ref{i}_enc', 0]}}
        graph[f'ref{i}_neg'] = {'class_type': 'ReferenceLatent', 'inputs': {'conditioning': neg, 'latent': [f'ref{i}_enc', 0]}}
        pos, neg = [f'ref{i}_pos', 0], [f'ref{i}_neg', 0]
    graph[guider]['inputs']['positive'] = pos
    graph[guider]['inputs']['negative'] = neg


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--pipeline-root', required=True)
    parser.add_argument('--prompt-file', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--seed', type=int, default=4207)
    parser.add_argument('--width', type=int, default=1024)
    parser.add_argument('--height', type=int, default=576)
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--steps', type=int, default=4, help='sampling steps (FLUX.2 Klein distilled default: 4)')
    parser.add_argument('--unload', action='store_true', help='free GPU memory after the image')
    parser.add_argument('--ref', action='append', default=[], help='reference image (PNG under --ref-root), up to 4')
    parser.add_argument('--ref-root', default=None, help='references must live under this folder')
    parser.add_argument('--ref-megapixels', type=float, default=0.4)
    args = parser.parse_args()

    started = time.monotonic()
    root = Path(args.pipeline_root)
    sys.path.insert(0, str(root))
    from workshop.offline import enable
    enable()  # loopback only, same guard the workshop uses
    from workshop.common import shared
    from workshop.acquire import cancel_owned, validate_graph, verify_service

    module = shared()
    prompt = Path(args.prompt_file).read_text(encoding='utf-8')
    refs = [Path(r).resolve() for r in args.ref]
    if len(refs) > MAX_REFS:
        raise ValueError(f'at most {MAX_REFS} reference images')
    ref_root = Path(args.ref_root).resolve() if args.ref_root else None
    for ref in refs:
        if ref.suffix.lower() != '.png' or not ref.is_file() or ref.stat().st_size > MAX_REF_BYTES:
            raise ValueError(f'reference must be an existing PNG of at most 20 MB: {ref}')
        if ref_root and ref_root not in ref.parents:
            raise ValueError(f'reference outside {ref_root}: {ref}')
    if not 0.05 <= args.ref_megapixels <= 1.5:
        raise ValueError('ref-megapixels must be 0.05-1.5')
    for value in (args.width, args.height):
        if value % 16 or not 256 <= value <= 1536:
            raise ValueError('width/height must be multiples of 16 between 256 and 1536')

    # Non-blocking: raises if another pipeline GPU job (3D, Blender, 2D) holds the lock.
    with module.gpu_lock():
        with contextlib.redirect_stdout(io.StringIO()):
            module.start()
        verify_service(module)
        schemas = module.api('/object_info')
        graph = module.workflows.concept(schemas, prompt, args.seed, args.width)
        graph['68']['inputs']['value'] = args.width
        graph['69']['inputs']['value'] = args.height
        if not 1 <= args.steps <= 50:
            raise ValueError('steps must be 1-50')
        for node in graph.values():
            if node['class_type'] == 'Flux2Scheduler':
                node['inputs']['steps'] = args.steps
        graph['save']['inputs']['filename_prefix'] = 'dmbot/scene'
        if refs:
            add_references(module, graph, refs, args.ref_megapixels)
        validate_graph(graph, schemas)

        queue = module.api('/queue')
        if queue.get('queue_running') or queue.get('queue_pending'):
            raise RuntimeError('ComfyUI is busy with another job')
        response = module.api('/prompt', {'prompt': graph, 'client_id': str(uuid.uuid4())})
        if response.get('node_errors'):
            raise RuntimeError(str(response['node_errors'])[:500])
        prompt_id = response['prompt_id']
        try:
            while time.monotonic() - started < args.timeout:
                history = module.api('/history/' + prompt_id)
                if prompt_id in history:
                    result = history[prompt_id]
                    if result['status']['status_str'] != 'success':
                        raise RuntimeError(str(result['status'])[:500])
                    with tempfile.TemporaryDirectory() as tmp:
                        files = module.copy_outputs(result, Path(tmp), {'.png'})
                        if not files:
                            raise RuntimeError('ComfyUI returned no image')
                        out = Path(args.out)
                        out.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(files[0], out)
                    break
                time.sleep(0.5)
            else:
                cancel_owned(module, prompt_id)
                raise TimeoutError(f'image generation timed out after {args.timeout}s')
        finally:
            if args.unload:
                queue = module.api('/queue')
                if not queue.get('queue_running') and not queue.get('queue_pending'):
                    module.api('/free', {'unload_models': True, 'free_memory': True})

    print(json.dumps({'ok': True, 'path': str(Path(args.out).resolve()), 'seconds': round(time.monotonic() - started, 1), 'refs': len(refs), 'vram_mb': module.vram()}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:  # reported to the bot as a single JSON line
        busy = 'Another pipeline GPU job is running' in str(exc) or 'busy' in str(exc).lower()
        print(json.dumps({'ok': False, 'busy': busy, 'error': f'{type(exc).__name__}: {exc}'[:600]}))
        sys.exit(1)
