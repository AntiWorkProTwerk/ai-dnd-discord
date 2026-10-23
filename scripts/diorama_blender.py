"""Builds a tabletop-miniature diorama of a battle map snapshot and renders it (runs inside Blender).

  blender --background --factory-startup --python-exit-code 1 --python scripts/diorama_blender.py -- \
    --scene snapshot.json --out diorama.png [--engine eevee|workbench] [--turntable out.mp4]

The snapshot is the bot's public battle map (see src/maps.ts): grid size, terrain features and
token positions with colors. Names are never drawn. One grid cell is one Blender unit. Prints one
JSON line.
"""
import json
import math
import sys
import time

import bpy  # type: ignore[import-not-found]
from mathutils import Vector  # type: ignore[import-not-found]

PERSON = 1.25  # figure height in cells (a 6 ft person on 5 ft squares)


def args():
    import argparse

    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--scene', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--engine', default='eevee', choices=['eevee', 'workbench'])
    p.add_argument('--width', type=int, default=1024)
    p.add_argument('--height', type=int, default=576)
    p.add_argument('--turntable', default=None)
    p.add_argument('--frames', type=int, default=48)
    return p.parse_args(argv)


def hex_rgba(h, alpha=1.0):
    h = h.lstrip('#')
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, alpha)


_materials = {}


def material(name, color, rough=0.6, metal=0.0, emission=None):
    key = (name, color, rough, metal, emission)
    if key in _materials:
        return _materials[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = hex_rgba(color)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emission:
        bsdf.inputs['Emission Color'].default_value = hex_rgba(emission)
        bsdf.inputs['Emission Strength'].default_value = 1.5
    m.diffuse_color = hex_rgba(color)  # used by Workbench
    _materials[key] = m
    return m


def add(obj, mat):
    obj.data.materials.append(mat)
    return obj


def box(x0, y0, w, d, h, mat, z0=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x0 + w / 2, -(y0 + d / 2), z0 + h / 2))
    o = bpy.context.active_object
    o.scale = (w, d, h)
    return add(o, mat)


def figure(t):
    cx = t['x'] + t['size'] / 2
    cy = -(t['y'] + t['size'] / 2)
    s = t['size']
    down = t['hp'] == 'down'
    body = material(f"tok-{t['color']}-{down}", '#8a8a8a' if down else t['color'], rough=0.45)
    base = material('base', '#2b2a2f', rough=0.35)
    ring = material('turn', '#ffcc33', rough=0.3, metal=0.6, emission='#ffcc33')
    bpy.ops.mesh.primitive_cylinder_add(radius=0.42 * s, depth=0.08, location=(cx, cy, 0.04), vertices=40)
    add(bpy.context.active_object, ring if t['isTurn'] else base)
    if down:
        # A fallen figure lies on its base.
        bpy.ops.mesh.primitive_cylinder_add(radius=0.16 * s, depth=0.9 * s, location=(cx, cy, 0.24), rotation=(0, math.pi / 2, 0.6))
        add(bpy.context.active_object, body)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.15 * s, location=(cx + 0.5 * s * math.cos(0.6), cy + 0.5 * s * math.sin(0.6), 0.24))
        add(bpy.context.active_object, body)
        return
    h = PERSON * (1 if s == 1 else 0.85 * s)
    bpy.ops.mesh.primitive_cone_add(radius1=0.24 * s, radius2=0.17 * s, depth=h * 0.62, location=(cx, cy, 0.08 + h * 0.31), vertices=32)
    add(bpy.context.active_object, body)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.15 * s, location=(cx, cy, 0.08 + h * 0.62 + 0.13 * s), segments=32, ring_count=16)
    add(bpy.context.active_object, body)
    bpy.ops.object.shade_smooth()


def main():
    a = args()
    started = time.monotonic()
    snap = json.loads(open(a.scene, encoding='utf-8').read())
    cols, rows = snap['cols'], snap['rows']
    tokens = snap['tokens']

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    # Floor with a faint grid: a checker of two close tones, one cell per square.
    floor = material('floor', '#b9ad96', rough=0.85)
    nodes = floor.node_tree.nodes
    checker = nodes.new('ShaderNodeTexChecker')
    checker.inputs['Color1'].default_value = hex_rgba('#bdb19a')
    checker.inputs['Color2'].default_value = hex_rgba('#ada189')
    checker.inputs['Scale'].default_value = 1.0
    coord = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (1.0, 1.0, 1.0)
    floor.node_tree.links.new(coord.outputs['Object'], mapping.inputs['Vector'])
    floor.node_tree.links.new(mapping.outputs['Vector'], checker.inputs['Vector'])
    floor.node_tree.links.new(checker.outputs['Color'], nodes.get('Principled BSDF').inputs['Base Color'])
    bpy.ops.mesh.primitive_plane_add(size=1, location=(cols / 2, -rows / 2, 0))
    plane = bpy.context.active_object
    plane.scale = (cols, rows, 1)
    bpy.ops.object.transform_apply(scale=True)
    add(plane, floor)
    # The table the diorama stands on.
    box(-1, -1, cols + 2, rows + 2, 0.3, material('table', '#3a2a1e', rough=0.5), z0=-0.31)

    front = max((t['y'] + t['size'] for t in tokens), default=rows)
    mats = {
        'wall': (material('wall', '#8e8676', rough=0.9), 1.6),
        'object': (material('object', '#7a5a3c', rough=0.6), 0.8),
        'cover': (material('cover', '#8a8478', rough=0.8), 0.5),
        'door': (material('door', '#6b4222', rough=0.6), 0.06),
        'stairs': (material('stairs', '#a39a88', rough=0.8), 0.3),
    }
    for f in snap['features']:
        k = f['kind']
        if k in ('wall', 'object', 'cover', 'stairs') and f['y'] >= front:
            continue  # cut away what stands between the figures and the camera
        if k in mats:
            m, h = mats[k]
            box(f['x'], f['y'], f['w'], f['h'], h, m)
        elif k in ('water', 'pit', 'difficult'):
            color = {'water': '#3f78b5', 'pit': '#111111', 'difficult': '#8f7550'}[k]
            box(f['x'], f['y'], f['w'], f['h'], 0.02, material(k, color, rough=0.1 if k == 'water' else 0.9), z0=0.0)
        elif k == 'light':
            light = bpy.data.lights.new('lamp', 'POINT')
            light.energy = 60
            light.color = hex_rgba('#ffd08a')[:3]
            o = bpy.data.objects.new('lamp', light)
            o.location = (f['x'] + f['w'] / 2, -(f['y'] + f['h'] / 2), 1.8)
            scene.collection.objects.link(o)
    for t in tokens:
        figure(t)

    # Light: a warm key sun, a soft fill from the world.
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.0
    sun.angle = math.radians(8)
    so = bpy.data.objects.new('sun', sun)
    so.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(so)
    world = bpy.data.worlds.new('world')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = hex_rgba('#20202a')
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    scene.world = world

    # Camera: from the south, about 40 degrees up, framing the figures with two cells of margin.
    if tokens:
        xs = [t['x'] for t in tokens] + [t['x'] + t['size'] for t in tokens]
        ys = [t['y'] for t in tokens] + [t['y'] + t['size'] for t in tokens]
        x0, x1, y0, y1 = max(0, min(xs) - 2), min(cols, max(xs) + 2), max(0, min(ys) - 2), min(rows, max(ys) + 1)
    else:
        x0, x1, y0, y1 = 0, cols, 0, rows
    target = Vector(((x0 + x1) / 2, -(y0 + y1) / 2, 0.4))
    span = max(x1 - x0, (y1 - y0) * 1.6, 5)
    dist = span * 1.05 + 2
    elev = math.radians(40)
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 35
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    pivot = bpy.data.objects.new('pivot', None)
    pivot.location = target
    scene.collection.objects.link(pivot)
    cam.parent = pivot
    cam.location = (0, -dist * math.cos(elev), dist * math.sin(elev))
    track = cam.constraints.new('TRACK_TO')
    track.target = pivot
    track.track_axis = 'TRACK_NEGATIVE_Z'
    track.up_axis = 'UP_Y'

    r = scene.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = a.width, a.height, 100
    if a.engine == 'workbench':
        r.engine = 'BLENDER_WORKBENCH'
        scene.display.shading.light = 'STUDIO'
        scene.display.shading.color_type = 'MATERIAL'
    else:
        for name in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
            try:
                r.engine = name
                break
            except TypeError:
                continue
        try:
            scene.eevee.taa_render_samples = 32
        except AttributeError:
            pass
    scene.view_settings.view_transform = 'AgX' if 'AgX' in [i.identifier for i in scene.view_settings.bl_rna.properties['view_transform'].enum_items] else 'Filmic'

    r.filepath = a.out
    r.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)

    video = None
    if a.turntable:
        pivot.rotation_euler = (0, 0, 0)
        pivot.keyframe_insert('rotation_euler', frame=1)
        pivot.rotation_euler = (0, 0, math.radians(360))
        pivot.keyframe_insert('rotation_euler', frame=a.frames + 1)
        for fc in pivot.animation_data.action.fcurves if hasattr(pivot.animation_data.action, 'fcurves') else []:
            for kp in fc.keyframe_points:
                kp.interpolation = 'LINEAR'
        scene.frame_start, scene.frame_end = 1, a.frames
        r.fps = 12
        r.resolution_x, r.resolution_y = 960, 540
        try:
            r.image_settings.media_type = 'VIDEO'
        except (AttributeError, TypeError):
            pass
        r.image_settings.file_format = 'FFMPEG'
        r.ffmpeg.format = 'MPEG4'
        r.ffmpeg.codec = 'H264'
        r.ffmpeg.constant_rate_factor = 'MEDIUM'
        r.filepath = a.turntable
        bpy.ops.render.render(animation=True)
        video = a.turntable

    print(json.dumps({'ok': True, 'path': a.out, 'video': video, 'seconds': round(time.monotonic() - started, 1)}))


try:
    main()
except Exception as exc:  # reported to the wrapper as one JSON line
    print(json.dumps({'ok': False, 'error': f'{type(exc).__name__}: {exc}'[:600]}))
    sys.exit(1)
