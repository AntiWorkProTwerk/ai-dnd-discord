"""Renders a cinematic 3D picture of a tabletop RPG scene from a scene spec (runs inside Blender).

  blender --background --factory-startup --python-exit-code 1 --python scripts/scene_blender.py -- \
    --scene spec.json --out out.png [--engine eevee|cycles] [--width 1280 --height 720]

The spec (see src/scene3d.ts) describes the room (floor/wall materials, time of day, weather),
features on the grid (walls, doors, furniture by shape), the people (with optional GLB miniature
models) and a camera hint (from the acting character toward the focus group). One grid cell is one
Blender unit; world x = grid x, world y = -grid y (grid y grows toward the south). The room and the
furniture are procedural; people are the character miniatures when available, else a stylized
figure in their color. Prints exactly one JSON line: {"ok": true, "path", "seconds"} or
{"ok": false, "error"} (exit 1).
"""
import json
import math
import os
import random
import sys
import time

import bpy  # type: ignore[import-not-found]
from mathutils import Vector  # type: ignore[import-not-found]

PERSON = 1.25  # figure height in cells (a 6 ft person on 5 ft squares)
WALL_H = 3.0


def args():
    import argparse

    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--scene', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--engine', default='eevee', choices=['eevee', 'cycles'])
    p.add_argument('--width', type=int, default=1280)
    p.add_argument('--height', type=int, default=720)
    p.add_argument('--view', default='shot', choices=['shot', 'diorama', 'map'])
    p.add_argument('--px', type=int, default=64, help='map view: pixels per grid cell')
    p.add_argument('--turntable', default=None, help='diorama view: also write a rotating mp4 here')
    p.add_argument('--frames', type=int, default=48)
    return p.parse_args(argv)


# ---------------------------------------------------------------- materials

def hex_rgba(h, alpha=1.0):
    h = h.lstrip('#')
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, alpha)


def shade(h, k):
    """Scales a hex color's brightness (k < 1 darker)."""
    h = h.lstrip('#')
    c = [max(0, min(255, int(int(h[i:i + 2], 16) * k))) for i in (0, 2, 4)]
    return '#%02x%02x%02x' % tuple(c)


_materials = {}


def material(name, color, rough=0.6, metal=0.0, emission=None, strength=1.5):
    key = (name, color, rough, metal, emission, strength)
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
        bsdf.inputs['Emission Strength'].default_value = strength
    m.diffuse_color = hex_rgba(color)
    _materials[key] = m
    return m


class Nodes:
    """Tiny helper for building shader node trees."""

    def __init__(self, mat):
        self.nt = mat.node_tree
        self.bsdf = self.nt.nodes.get('Principled BSDF')

    def new(self, kind, **inputs):
        n = self.nt.nodes.new(kind)
        for k, v in inputs.items():
            n.inputs[k].default_value = v
        return n

    def link(self, a, b):
        self.nt.links.new(a, b)

    def coords(self, mode, scale=(1.0, 1.0, 1.0)):
        """Texture coordinates in world space: 'floor' -> (x, y), 'wall' -> (x + y, z),
        'wallv' -> (z, x + y) (vertical planks), 'world' -> position."""
        geo = self.new('ShaderNodeNewGeometry')
        if mode == 'world':
            vec = geo.outputs['Position']
        else:
            sep = self.new('ShaderNodeSeparateXYZ')
            self.link(geo.outputs['Position'], sep.inputs[0])
            comb = self.new('ShaderNodeCombineXYZ')
            if mode == 'floor':
                self.link(sep.outputs[0], comb.inputs[0])
                self.link(sep.outputs[1], comb.inputs[1])
            else:
                add = self.new('ShaderNodeMath')
                add.operation = 'ADD'
                self.link(sep.outputs[0], add.inputs[0])
                self.link(sep.outputs[1], add.inputs[1])
                u, v = (add.outputs[0], sep.outputs[2]) if mode == 'wall' else (sep.outputs[2], add.outputs[0])
                self.link(u, comb.inputs[0])
                self.link(v, comb.inputs[1])
            vec = comb.outputs[0]
        if scale != (1.0, 1.0, 1.0):
            mp = self.new('ShaderNodeMapping')
            mp.inputs['Scale'].default_value = scale
            self.link(vec, mp.inputs['Vector'])
            vec = mp.outputs[0]
        return vec

    def noise(self, vec, scale, detail=4.0, rough=0.55):
        n = self.new('ShaderNodeTexNoise', Scale=scale, Detail=detail, Roughness=rough)
        self.link(vec, n.inputs['Vector'])
        return n.outputs[0]

    def mix(self, fac, a, b, blend='MIX'):
        m = self.new('ShaderNodeMix')
        m.data_type = 'RGBA'
        m.blend_type = blend
        for sock, val in ((m.inputs[0], fac), (m.inputs[6], a), (m.inputs[7], b)):
            if isinstance(val, (int, float)):
                sock.default_value = val
            elif isinstance(val, str):
                sock.default_value = hex_rgba(val)
            else:
                self.link(val, sock)
        return m.outputs[2]

    def ramp(self, fac, lo, hi, c0=(0, 0, 0, 1), c1=(1, 1, 1, 1)):
        r = self.new('ShaderNodeValToRGB')
        r.color_ramp.elements[0].position = lo
        r.color_ramp.elements[0].color = c0
        r.color_ramp.elements[1].position = hi
        r.color_ramp.elements[1].color = c1
        self.link(fac, r.inputs[0])
        return r.outputs[0]

    def bump(self, height, strength=0.3, distance=0.02, invert=False):
        b = self.new('ShaderNodeBump', Strength=strength, Distance=distance)
        b.invert = invert
        self.link(height, b.inputs['Height'])
        self.link(b.outputs[0], self.bsdf.inputs['Normal'])

    def color(self, sock):
        self.link(sock, self.bsdf.inputs['Base Color'])

    def brick(self, vec, c1, c2, mortar, width, row, msize, offset=0.5, freq=2, bias=0.0):
        b = self.new('ShaderNodeTexBrick', Scale=1.0, **{'Mortar Size': msize, 'Mortar Smooth': 0.2,
                                                         'Brick Width': width, 'Row Height': row, 'Bias': bias})
        b.offset = offset
        b.offset_frequency = freq
        b.inputs['Color1'].default_value = hex_rgba(c1)
        b.inputs['Color2'].default_value = hex_rgba(c2)
        b.inputs['Mortar'].default_value = hex_rgba(mortar)
        self.link(vec, b.inputs['Vector'])
        return b.outputs[0], b.outputs[1]


def surface(kind, mode='floor', wet=False):
    """A procedural material for a floor/wall/ground surface type (`wet`: rain-soaked, with puddles)."""
    key = ('surface', kind, mode, wet)
    if key in _materials:
        return _materials[key]
    m = bpy.data.materials.new(f'{kind}-{mode}')
    m.use_nodes = True
    n = Nodes(m)
    bsdf = n.bsdf
    wall = mode != 'floor'
    rough = 0.8
    if kind == 'wood':
        vec = n.coords('wallv' if wall else 'floor')
        col, mortar = n.brick(vec, '#6a4429', '#3f2716', '#24160c', 1.9, 0.22, 0.008, offset=0.5, freq=2, bias=-0.1)
        grain = n.noise(n.coords('wallv' if wall else 'floor', (0.7, 18.0, 1.0)), 2.5, 6.0, 0.6)
        col = n.mix(0.45, col, n.ramp(grain, 0.3, 0.75, hex_rgba('#5a5a5a'), hex_rgba('#ffffff')), 'MULTIPLY')
        n.color(col)
        n.bump(mortar, 0.5, 0.02, invert=True)
        rough = 0.6
    elif kind in ('stone', 'brick'):
        vec = n.coords('wall' if wall else 'floor')
        if kind == 'stone':
            col, mortar = n.brick(vec, '#77736a', '#4c4943', '#24221f', 0.62 if wall else 0.75, 0.32 if wall else 0.5, 0.02, bias=0.0)
        else:
            col, mortar = n.brick(vec, '#7e3d2b', '#5a2a1d', '#3b342c', 0.48, 0.16, 0.014)
        dirt = n.noise(n.coords('world'), 3.0, 6.0, 0.6)
        col = n.mix(0.5, col, n.ramp(dirt, 0.25, 0.8, hex_rgba('#6a6a6a'), hex_rgba('#ffffff')), 'MULTIPLY')
        n.color(col)
        n.bump(mortar, 0.7, 0.03, invert=True)
        rough = 0.85
    elif kind == 'cobbles':
        vec = n.coords('wall' if wall else 'floor')
        vor = n.new('ShaderNodeTexVoronoi', Scale=6.5)
        n.link(vec, vor.inputs['Vector'])
        edge = n.new('ShaderNodeTexVoronoi', Scale=6.5)
        edge.feature = 'DISTANCE_TO_EDGE'
        n.link(vec, edge.inputs['Vector'])
        sep = n.new('ShaderNodeSeparateColor')
        n.link(vor.outputs[1], sep.inputs[0])
        stones = n.mix(sep.outputs[0], '#3e3a34', '#6f685e')
        gap = n.ramp(edge.outputs[0], 0.0, 0.07)
        col = n.mix(gap, '#1f1c18', stones)
        dirt = n.noise(n.coords('world'), 4.0, 5.0, 0.6)
        col = n.mix(0.4, col, n.ramp(dirt, 0.3, 0.8, hex_rgba('#7a7a7a'), hex_rgba('#ffffff')), 'MULTIPLY')
        n.color(col)
        n.bump(gap, 0.55, 0.03)
        rough = 0.75
    elif kind == 'water':
        vec = n.coords('world')
        ripple = n.noise(n.coords('world', (1.0, 1.0, 1.0)), 2.5, 3.0, 0.5)
        n.color(n.mix(ripple, '#061a20', '#0f3440'))
        n.bump(n.noise(vec, 9.0, 2.0), 0.12, 0.02)
        bsdf.inputs['Specular IOR Level'].default_value = 0.25  # dark water, not a mirror of the sky
        rough = 0.12
    else:
        palette = {
            'plaster': ('#a99a80', '#8b7e68', 0.9), 'dirt': ('#4f3b27', '#2f2318', 0.95),
            'grass': ('#4a6a2c', '#27401a', 0.9), 'sand': ('#c4a878', '#9c8459', 0.9),
            'snow': ('#eef2f7', '#d3dbe6', 0.55),
        }
        a, b, rough = palette.get(kind, palette['dirt'])
        big = n.noise(n.coords('world'), 0.8, 3.0, 0.5)
        fine = n.noise(n.coords('world'), 9.0, 6.0, 0.6)
        col = n.mix(n.ramp(big, 0.35, 0.65), b, a)
        col = n.mix(0.35, col, n.ramp(fine, 0.3, 0.7, hex_rgba('#707070'), hex_rgba('#ffffff')), 'MULTIPLY')
        n.color(col)
        n.bump(fine, 0.35 if kind != 'plaster' else 0.12, 0.02)
    bsdf.inputs['Roughness'].default_value = rough
    if wet and kind != 'water':
        # Darker, glossy ground with mirror-like puddles in the low spots.
        pud = n.ramp(n.noise(n.coords('world'), 0.55, 3.0, 0.5), 0.56, 0.6)
        n.link(n.ramp(pud, 0.0, 1.0, (0.32, 0.32, 0.32, 1), (0.03, 0.03, 0.03, 1)), bsdf.inputs['Roughness'])
        base = bsdf.inputs['Base Color'].links[0].from_socket if bsdf.inputs['Base Color'].links else None
        if base is not None:
            darker = n.mix(0.55, base, '#5a5a5a', 'MULTIPLY')
            n.color(n.mix(pud, darker, '#0a0c10'))
        for node in n.nt.nodes:  # water fills the joints: softer relief, or every edge glints
            if node.bl_idname == 'ShaderNodeBump':
                node.inputs['Strength'].default_value *= 0.35
    _materials[key] = m
    return m


def wood(tone='#5a3b23', name='wood'):
    """Furniture wood: noisy grain along a horizontal axis."""
    key = ('wood', tone)
    if key in _materials:
        return _materials[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    n = Nodes(m)
    grain = n.noise(n.coords('world', (6.0, 6.0, 30.0)), 1.5, 5.0, 0.6)
    n.color(n.mix(n.ramp(grain, 0.3, 0.7), shade(tone, 0.6), tone))
    n.bump(grain, 0.15, 0.01)
    n.bsdf.inputs['Roughness'].default_value = 0.55
    _materials[key] = m
    return m


def emissive(name, color, strength):
    key = ('emit', name, color, strength)
    if key in _materials:
        return _materials[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = hex_rgba(color)
    b.inputs['Emission Color'].default_value = hex_rgba(color)
    b.inputs['Emission Strength'].default_value = strength
    _materials[key] = m
    return m


# ---------------------------------------------------------------- geometry

def add(obj, mat):
    if mat.name not in obj.data.materials:
        obj.data.materials.append(mat)
    return obj


# Cubes and cylinders share one unit mesh per shape and material: a street of houses is hundreds of
# pieces, and bpy.ops primitive operators (one scene update each) made that take 20 seconds.
_meshes = {}


def unit_mesh(kind, mat, verts=16, ratio=1.0):
    import bmesh  # type: ignore[import-not-found]

    key = (kind, mat.name, verts, round(ratio, 3))
    if key in _meshes:
        return _meshes[key]
    bm = bmesh.new()
    if kind == 'cube':
        bmesh.ops.create_cube(bm, size=1.0)
    else:
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=verts, radius1=1.0, radius2=ratio, depth=1.0)
    mesh = bpy.data.meshes.new(kind)
    bm.to_mesh(mesh)
    bm.free()
    if kind != 'cube':
        for p in mesh.polygons:
            p.use_smooth = True
    mesh.materials.append(mat)
    _meshes[key] = mesh
    return mesh


def place(mesh, loc, rot=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0)):
    o = bpy.data.objects.new(mesh.name, mesh)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = rot
    o.scale = scale
    return o


def box(x0, y0, w, d, h, mat, z0=0.0):
    """Axis-aligned box over a grid rectangle (top-left x0, y0; w x d cells)."""
    return place(unit_mesh('cube', mat), (x0 + w / 2, -(y0 + d / 2), z0 + h / 2), scale=(w, d, h))


class Frame:
    """A local frame on the floor: origin at a world point, rotated by `angle` about Z. Local +x is
    the piece's long axis, local -y its front."""

    def __init__(self, wx, wy, angle):
        self.o = Vector((wx, wy, 0))
        self.a = angle

    def at(self, lx, ly, z):
        c, s = math.cos(self.a), math.sin(self.a)
        return Vector((self.o.x + c * lx - s * ly, self.o.y + s * lx + c * ly, z))

    def cube(self, lx, ly, z0, sx, sy, sz, mat, tilt=(0.0, 0.0)):
        return place(unit_mesh('cube', mat), self.at(lx, ly, z0 + sz / 2), (tilt[0], tilt[1], self.a), (sx, sy, sz))

    def cyl(self, lx, ly, z0, r, h, mat, verts=16, axis='z', r2=None):
        if axis == 'z':
            loc, rot = self.at(lx, ly, z0 + h / 2), (0, 0, self.a)
        elif axis == 'y':  # lying along local y (e.g. a wheel axle across the piece)
            loc, rot = self.at(lx, ly, z0), (math.pi / 2, 0, self.a)
        else:  # along local x
            loc, rot = self.at(lx, ly, z0), (0, math.pi / 2, self.a)
        mesh = unit_mesh('cyl', mat, verts, 1.0 if r2 is None else r2 / r)
        return place(mesh, loc, rot, (r, r, h))

    def ico(self, lx, ly, z, r, mat, scale=(1, 1, 1), sub=1, seed=0):
        bpy.ops.mesh.primitive_ico_sphere_add(radius=r, subdivisions=sub, location=self.at(lx, ly, z))
        o = bpy.context.active_object
        o.scale = scale
        rnd = random.Random(seed)
        for v in o.data.vertices:  # lumpy, hand-made look
            v.co *= 1 + rnd.uniform(-0.12, 0.12)
        o.rotation_euler = (0, 0, rnd.uniform(0, math.tau))
        return add(o, mat)


def smooth(o):
    if all(p.use_smooth for p in o.data.polygons):
        return o
    if o.data.users > 1:
        o.data = o.data.copy()
    for p in o.data.polygons:
        p.use_smooth = True
    return o


# ---------------------------------------------------------------- people

def import_glb(path):
    """Imports a GLB; returns its new top-level objects and meshes, or None."""
    if not path or not os.path.isfile(path):
        return None
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=path)
    except Exception:
        return None
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    if not meshes:
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)
        return None
    for o in meshes:  # generated PBR maps read as glossy plastic: cloth, skin and hair are matte
        for slot in o.material_slots:
            m = slot.material
            if not m or not m.use_nodes:
                continue
            for n in m.node_tree.nodes:
                if n.bl_idname != 'ShaderNodeBsdfPrincipled':
                    continue
                rough = n.inputs['Roughness']
                if rough.links:
                    lk = rough.links[0]
                    mp = m.node_tree.nodes.new('ShaderNodeMapRange')
                    mp.inputs['To Min'].default_value = 0.55
                    mp.inputs['To Max'].default_value = 1.0
                    m.node_tree.links.new(lk.from_socket, mp.inputs['Value'])
                    m.node_tree.links.new(mp.outputs['Result'], rough)
                else:
                    rough.default_value = max(rough.default_value, 0.6)
                n.inputs['Specular IOR Level'].default_value = 0.3
    return [o for o in new if o.parent is None], meshes


def fallback_figure(color, fight, seed):
    """A stylized cloaked figure in the person's color, standing at the origin facing -Y, 1.25 tall."""
    rnd = random.Random(seed)
    f = Frame(0, 0, 0)
    cloth = material(f'cloth-{color}', color, rough=0.75)
    dark = material(f'cloth-dark-{color}', shade(color, 0.45), rough=0.8)
    skin = material('skin', rnd.choice(['#c99a78', '#a8785a', '#7a5238', '#e0b896']), rough=0.55)
    leather = material('leather', '#3a2618', rough=0.6)
    metal = material('steel', '#9aa0a8', rough=0.3, metal=0.9)
    cloak = material(f'cloak-{color}', shade(color, 0.8), rough=0.8)
    trim = material(f'trim-{color}', shade(color, 1.35), rough=0.6)
    parts = []

    def sphere(r, loc, mat, scale=(1, 1, 1), seg=16):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=seg, ring_count=seg // 2, location=loc)
        o = bpy.context.active_object
        o.scale = scale
        parts.append(smooth(add(o, mat)))
        return o

    for side in (-1, 1):  # legs and boots
        parts.append(smooth(f.cyl(0.08 * side, 0, 0.0, 0.065, 0.5, dark, verts=12)))
        parts.append(smooth(f.cube(0.08 * side, -0.04, 0.0, 0.11, 0.2, 0.13, leather)))
    parts.append(smooth(f.cyl(0, 0.035, 0.1, 0.29, 0.86, cloak, verts=24, r2=0.14)))   # cloak
    parts.append(smooth(f.cyl(0, 0.035, 0.08, 0.295, 0.05, trim, verts=24)))           # cloak hem
    parts.append(smooth(f.cyl(0, -0.01, 0.3, 0.2, 0.5, cloth, verts=20, r2=0.17)))     # tunic
    parts.append(smooth(f.cyl(0, -0.01, 0.56, 0.185, 0.06, leather, verts=20)))        # belt
    parts.append(smooth(f.cube(0, -0.19, 0.55, 0.06, 0.02, 0.08, metal)))              # buckle
    sphere(0.22, (0, 0.01, 0.9), cloak, (1.0, 0.7, 0.42))                              # shoulders
    sphere(0.09, (0, -0.05, 1.06), skin, seg=20)                                      # face
    sphere(0.125, (0, 0.035, 1.09), cloak, (1.0, 1.05, 1.08), seg=20)                    # hood
    for side in (-1, 1):  # sleeves and hands, a little forward
        bpy.ops.mesh.primitive_cone_add(radius1=0.075, radius2=0.055, depth=0.45, vertices=12,
                                        location=(0.235 * side, -0.05, 0.7), rotation=(0.3, 0.16 * side, 0))
        parts.append(smooth(add(bpy.context.active_object, cloth)))
        sphere(0.048, (0.27 * side, -0.13, 0.47), skin, seg=10)
    if fight:  # a sword in the right hand
        # Held in the right hand (local -x: the figure faces -Y), raised forward.
        parts.append(f.cube(-0.27, -0.35, 0.38, 0.035, 0.012, 0.62, metal, tilt=(math.pi / 4, 0)))
        parts.append(f.cube(-0.27, -0.15, 0.46, 0.16, 0.035, 0.035, leather, tilt=(math.pi / 4, 0)))
    return parts


def stage(tops, meshes, cx, cy, height, theta, down):
    """Stands (or lays down) a set of objects modelled standing on z=0 facing -Y: scales them to
    `height`, centers them on their feet at world (cx, cy) and turns them to face angle theta."""
    bpy.context.view_layer.update()
    verts = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    lo = Vector((min(p.x for p in verts), min(p.y for p in verts), min(p.z for p in verts)))
    hi = Vector((max(p.x for p in verts), max(p.y for p in verts), max(p.z for p in verts)))
    tall = max(hi.z - lo.z, 1e-6)
    cut = lo.z + 0.12 * tall
    feet = [p for p in verts if p.z <= cut] or [(lo + hi) / 2]
    fx = sum(p.x for p in feet) / len(feet)
    fy = sum(p.y for p in feet) / len(feet)
    k = height / tall
    inner = bpy.data.objects.new('person-inner', None)
    outer = bpy.data.objects.new('person', None)
    bpy.context.scene.collection.objects.link(inner)
    bpy.context.scene.collection.objects.link(outer)
    for o in tops:
        o.parent = inner
    inner.parent = outer
    outer.scale = (k, k, k)
    if down:
        # On its back. The body rests on the floor: a weapon held out in front would otherwise prop
        # it up in mid-air, so the few lowest points (a blade tip) are allowed to sink into the floor.
        inner.location = (-fx, -fy, -lo.z - tall / 2)
        outer.rotation_euler = (-math.pi / 2, 0, theta)
        ys = sorted(p.y for p in verts)
        back = ys[int(len(ys) * 0.85)] if len(ys) > 40 else hi.y
        outer.location = (cx, cy, k * (back - fy) + 0.01)
    else:
        inner.location = (-fx, -fy, -lo.z)
        outer.rotation_euler = (0, 0, theta)
        outer.location = (cx, cy, 0.0)
    return outer


def person(p, fight, idx):
    s = p.get('size') or 1
    cx, cy = p['x'], -p['y']
    face = p.get('face') or {}
    vx, vy = face.get('x', p['x']) - p['x'], -(face.get('y', p['y'] + 1) - p['y'])
    if abs(vx) + abs(vy) < 1e-6:
        vx, vy = 0.0, -1.0
    theta = math.atan2(vx, -vy)  # rotates local -Y onto (vx, vy)
    height = PERSON * (1 if s == 1 else 0.85 * s)
    got = import_glb(p.get('model'))
    if got is None:
        parts = fallback_figure(p.get('color') or '#888888', fight and not p.get('down'), idx)
        got = (parts, parts)
    stage(got[0], got[1], cx, cy, height, theta, bool(p.get('down')))
    if p.get('wounded') or p.get('down'):
        blood = material('blood', '#1c0202', rough=0.45)
        rnd = random.Random(idx * 7 + 3)
        for i in range(4 if p.get('down') else 2):
            r = rnd.uniform(0.04, 0.11) * (1.4 if p.get('down') else 1.0)
            bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=0.004, vertices=14,
                                                location=(cx + rnd.uniform(-0.35, 0.35), cy + rnd.uniform(-0.35, 0.35), 0.004))
            o = bpy.context.active_object
            o.scale = (1.0, rnd.uniform(0.5, 1.0), 1.0)
            o.rotation_euler = (0, 0, rnd.uniform(0, math.pi))
            add(o, blood)


# ---------------------------------------------------------------- furniture

def facing_center(f, spec):
    """Angle for a piece's frame so its long axis follows its footprint and its front (local -Y)
    faces the middle of the room."""
    cx, cy = f['x'] + f['w'] / 2, f['y'] + f['h'] / 2
    tx, ty = spec['cols'] / 2 - cx, spec['rows'] / 2 - cy  # grid direction toward the center
    if f['w'] >= f['h']:
        return 0.0 if ty >= 0 else math.pi  # front toward grid +y (world -y) or the opposite
    return math.pi / 2 if tx >= 0 else -math.pi / 2


def build_table(fr, L, D, m):
    top = 0.78
    fr.cube(0, 0, top - 0.07, L - 0.1, D - 0.15, 0.07, m['wood'])
    for sx in (-1, 1):
        for sy in (-1, 1):
            fr.cube(sx * (L / 2 - 0.16), sy * (D / 2 - 0.16), 0, 0.08, 0.08, top - 0.07, m['wood_dark'])
    rnd = m['rnd']
    for i in range(max(1, int(L))):  # mugs and a candle
        lx = -L / 2 + 0.35 + i * (L - 0.5) / max(1, int(L)) + rnd.uniform(-0.1, 0.1)
        smooth(fr.cyl(lx, rnd.uniform(-0.15, 0.15), top, 0.045, 0.1, m['pewter'], verts=10))
    fr.cyl(0.05, 0.05, top, 0.03, 0.12, m['wax'], verts=8)
    flame = fr.ico(0.05, 0.05, top + 0.15, 0.022, m['flame'], scale=(1, 1, 1.7), sub=1)
    point_light(flame.location + Vector((0, 0, 0.05)), 6, '#ffb060', radius=0.02)


def build_counter(fr, L, D, m):
    h = 1.05
    fr.cube(0, 0.05, 0, L - 0.05, D - 0.25, h - 0.06, m['wood_dark'])
    fr.cube(0, 0.0, h - 0.06, L, D - 0.05, 0.06, m['wood'])
    for i in range(int(L * 2)):  # front panels
        fr.cube(-L / 2 + 0.25 + i * 0.5, -(D - 0.25) / 2 + 0.05, 0.1, 0.4, 0.02, h - 0.3, m['wood'])
    rnd = m['rnd']
    for i in range(int(L * 1.5)):  # bottles
        g = m['glass'][i % len(m['glass'])]
        lx = -L / 2 + 0.3 + i * (L - 0.6) / max(1, int(L * 1.5) - 1)
        ly = rnd.uniform(0.0, 0.25)
        smooth(fr.cyl(lx, ly, h, 0.045, 0.2, g, verts=10))
        smooth(fr.cyl(lx, ly, h + 0.2, 0.045, 0.08, g, verts=10, r2=0.015))
    for i in range(max(1, int(L / 2))):
        smooth(fr.cyl(-L / 2 + 0.6 + i * 1.6, -0.1, h, 0.05, 0.11, m['pewter'], verts=10))


def build_bench(fr, L, D, m):
    fr.cube(0, 0, 0.4, L - 0.1, 0.35, 0.06, m['wood'])
    for sx in (-1, 1):
        fr.cube(sx * (L / 2 - 0.2), 0, 0, 0.06, 0.3, 0.4, m['wood_dark'])


def build_chair(fr, L, D, m):
    fr.cube(0, 0, 0.44, 0.45, 0.45, 0.05, m['wood'])
    for sx in (-1, 1):
        for sy in (-1, 1):
            fr.cube(sx * 0.19, sy * 0.19, 0, 0.05, 0.05, 0.44, m['wood_dark'])
    for sx in (-1, 1):
        fr.cube(sx * 0.19, 0.2, 0.49, 0.05, 0.05, 0.5, m['wood_dark'])
    fr.cube(0, 0.2, 0.82, 0.43, 0.04, 0.14, m['wood'])


def build_barrel(fr, L, D, m):
    rnd = m['rnd']
    n = max(1, int(round(L * D)))
    spots = [(0, 0)] if n == 1 else [(-L / 2 + 0.5 + i % int(L) * 1.0, -D / 2 + 0.5 + i // int(L) * 1.0) for i in range(int(L) * int(D))]
    for lx, ly in spots:
        lx += rnd.uniform(-0.05, 0.05)
        smooth(fr.cyl(lx, ly, 0, 0.3, 0.45, m['barrel'], verts=20, r2=0.35))
        smooth(fr.cyl(lx, ly, 0.45, 0.35, 0.45, m['barrel'], verts=20, r2=0.3))
        for z in (0.12, 0.45, 0.78):
            r = 0.3 + 0.05 * (1 - abs(z - 0.45) / 0.45) + 0.012
            smooth(fr.cyl(lx, ly, z - 0.025, r, 0.05, m['iron'], verts=20))
        fr.cyl(lx, ly, 0.9, 0.29, 0.015, m['wood_dark'], verts=20)


def build_crate(fr, L, D, m):
    rnd = m['rnd']
    for i in range(max(1, int(L))):
        lx = -L / 2 + 0.5 + i
        s = rnd.uniform(0.7, 0.82)
        c = fr.cube(lx, 0, 0, s, s, s, m['crate'])
        c.rotation_euler.z += rnd.uniform(-0.15, 0.15)
        for sy in (-1, 1):  # slats
            fr.cube(lx, sy * (s / 2 + 0.01), 0.05, s - 0.05, 0.03, 0.06, m['wood_dark'])
            fr.cube(lx, sy * (s / 2 + 0.01), s - 0.12, s - 0.05, 0.03, 0.06, m['wood_dark'])
        if i == 0 and rnd.random() < 0.6:
            fr.cube(lx + 0.05, 0.02, s, s * 0.7, s * 0.7, s * 0.6, m['crate'])


def build_bed(fr, L, D, m):
    fr.cube(0, 0, 0, L - 0.1, D - 0.1, 0.35, m['wood_dark'])
    fr.cube(0, 0, 0.35, L - 0.2, D - 0.2, 0.15, m['linen'])
    fr.cube(0.15, 0, 0.5, L * 0.6, D - 0.15, 0.05, m['blanket'])
    fr.cube(L / 2 - 0.35, 0, 0.5, 0.35, D * 0.6, 0.1, m['linen'])
    fr.cube(L / 2 - 0.05, 0, 0, 0.08, D - 0.1, 0.9, m['wood_dark'])


def build_shelf(fr, L, D, m):
    h = 2.1
    fr.cube(0, 0.2, 0, L - 0.1, 0.06, h, m['wood_dark'])
    for sx in (-1, 1):
        fr.cube(sx * (L / 2 - 0.08), 0, 0, 0.06, 0.45, h, m['wood_dark'])
    rnd = m['rnd']
    for z in (0.05, 0.6, 1.15, 1.7):
        fr.cube(0, 0, z, L - 0.2, 0.42, 0.04, m['wood'])
        x = -L / 2 + 0.15
        while x < L / 2 - 0.25:  # books and jars
            if rnd.random() < 0.8:
                w = rnd.uniform(0.04, 0.09)
                bh = rnd.uniform(0.25, 0.42)
                fr.cube(x + w / 2, 0.02, z + 0.04, w, 0.28, bh, m['books'][rnd.randrange(len(m['books']))])
                x += w + 0.01
            else:
                smooth(fr.cyl(x + 0.07, 0, z + 0.04, 0.06, 0.16, m['glass'][rnd.randrange(len(m['glass']))], verts=10))
                x += 0.16


def build_hearth(fr, L, D, m):
    """A stone fireplace with an open firebox, logs, flames and a warm light. Front is local -y."""
    h, stone = 1.3, m['stone']
    front = -D / 2 + 0.1
    ow, oh = min(0.9, L * 0.55), 0.75  # opening
    back = 0.35
    fr.cube(0, back / 2 + 0.05, 0, L, D - back - 0.1, h, stone)               # back mass
    for sx in (-1, 1):                                                        # jambs
        jw = (L - ow) / 2
        fr.cube(sx * (ow / 2 + jw / 2), front + (back + 0.1) / 2, 0, jw, back + 0.1, h, stone)
    fr.cube(0, front + (back + 0.1) / 2, oh, ow, back + 0.1, h - oh, stone)    # lintel
    fr.cube(0, front - 0.05, h, L + 0.2, D - 0.0, 0.12, m['wood_dark'])        # mantel
    fr.cube(0, 0.15, h + 0.12, L * 0.65, D * 0.6, WALL_H - h - 0.12, stone)  # chimney breast
    fr.cube(0, front + 0.3, 0, ow, 0.1, oh, m['soot'])                       # sooty back of firebox
    fr.cube(0, front + 0.2, 0, ow, 0.3, 0.04, m['soot'])
    for i in range(3):
        fr.cyl(-0.1 + i * 0.1, front + 0.2, 0.09, 0.045, ow * 0.7, m['wood_dark'], verts=8, axis='x')
    for i, (lx, s) in enumerate(((-0.13, 0.14), (0.0, 0.22), (0.14, 0.12))):
        fr.ico(lx, front + 0.2, 0.12 + s * 0.6, s * 0.5, m['fire'], scale=(1, 1, 2.0), sub=1, seed=i)
    point_light(fr.at(0, front - 0.25, 0.45), 260, '#ff8a3a', radius=0.2, name='hearth')


def build_pillar(fr, L, D, m):
    stone = m['stone']
    fr.cube(0, 0, 0, 0.8, 0.8, 0.25, stone)
    smooth(fr.cyl(0, 0, 0.25, 0.3, WALL_H - 0.5, stone, verts=20))
    fr.cube(0, 0, WALL_H - 0.25, 0.8, 0.8, 0.25, stone)


def build_cart(fr, L, D, m):
    fr.cube(0, 0, 0.55, L - 0.3, D - 0.15, 0.08, m['wood'])
    for sy in (-1, 1):
        fr.cube(0, sy * (D - 0.2) / 2, 0.63, L - 0.3, 0.05, 0.3, m['wood'])
    for sx in (-1, 1):
        fr.cube(sx * (L - 0.35) / 2, 0, 0.63, 0.05, D - 0.15, 0.3, m['wood'])
    for sy in (-1, 1):
        fr.cyl(0, sy * (D / 2 - 0.02), 0.4, 0.4, 0.08, m['wood_dark'], verts=20, axis='y')
        fr.cyl(0, sy * (D / 2 + 0.01), 0.4, 0.1, 0.1, m['iron'], verts=10, axis='y')
        fr.cube(-L / 2 - 0.1, sy * 0.25, 0.45, 1.0, 0.05, 0.05, m['wood_dark'], tilt=(0, -0.25))
    fr.cube(0.2, 0, 0.63, 0.6, 0.5, 0.25, m['sack'])


def build_stairs(fr, L, D, m):
    steps = max(4, int(L * 3))
    run = L / steps
    for i in range(steps):
        z = (i + 1) * (1.5 / steps)
        fr.cube(-L / 2 + run * (i + 0.5), 0, 0, run, D - 0.05, z, m['stone'] if m['outdoor'] else m['wood'])


def build_tree(fr, L, D, m):
    s = max(1.0, min(L, D))
    rnd = m['rnd']
    smooth(fr.cyl(0, 0, 0, 0.14 * s, 1.9 * s, m['bark'], verts=10, r2=0.08 * s))
    for i in range(5):  # a clump of lumpy foliage balls
        a = i * 2.4
        rr = 0.0 if i == 0 else 0.45 * s
        fr.ico(math.cos(a) * rr, math.sin(a) * rr, (2.0 + (0.45 if i == 0 else rnd.uniform(-0.1, 0.25))) * s,
               (0.85 if i == 0 else 0.6) * s, m['leaves'], scale=(1, 1, 0.85), sub=2, seed=rnd.randrange(999))


def build_rock(fr, L, D, m):
    rnd = m['rnd']
    fr.ico(0, 0, 0.15, 0.45 * min(L, D), m['rock'], scale=(L / max(1, min(L, D)), 1.0, 0.6), sub=2, seed=rnd.randrange(999))
    if L * D > 1:
        fr.ico(L * 0.3, D * 0.2, 0.05, 0.25, m['rock'], scale=(1, 1, 0.6), sub=1, seed=rnd.randrange(999))


def build_block(fr, L, D, m, kind):
    if kind == 'cover':  # a low stone wall
        fr.cube(0, 0, 0, L - 0.05, D - 0.3, 1.0, m['stone'])
    else:
        fr.cube(0, 0, 0, L - 0.05, D - 0.05, 0.9, m['crate'])


BUILDERS = {
    'table': build_table, 'counter': build_counter, 'bench': build_bench, 'chair': build_chair,
    'barrel': build_barrel, 'crate': build_crate, 'bed': build_bed, 'shelf': build_shelf,
    'hearth': build_hearth, 'pillar': build_pillar, 'cart': build_cart, 'stairs': build_stairs,
    'tree': build_tree, 'rock': build_rock,
}
TALL = {'shelf', 'hearth', 'pillar', 'tree', 'stairs', 'door', 'window'}


def point_light(loc, watts, color, radius=0.1, name='lamp'):
    light = bpy.data.lights.new(name, 'POINT')
    light.energy = watts
    light.color = hex_rgba(color)[:3]
    light.shadow_soft_size = radius
    o = bpy.data.objects.new(name, light)
    o.location = loc
    bpy.context.scene.collection.objects.link(o)
    return o


def area_light(loc, target, watts, color, size=2.0, name='area'):
    light = bpy.data.lights.new(name, 'AREA')
    light.energy = watts
    light.color = hex_rgba(color)[:3]
    light.size = size
    light.volume_factor = 0.0  # studio-style fill: no visible beam in the haze
    o = bpy.data.objects.new(name, light)
    o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.collection.objects.link(o)
    return o


# ---------------------------------------------------------------- scene logic

def seg_hits_rect(p, q, r, pad=0.0):
    """Does the 2D segment p->q (grid coords) cross the rectangle r = (x, y, w, h)?"""
    x0, y0, x1, y1 = r[0] - pad, r[1] - pad, r[0] + r[2] + pad, r[1] + r[3] + pad
    t0, t1 = 0.0, 1.0
    dx, dy = q[0] - p[0], q[1] - p[1]
    for d, a, lo, hi in ((dx, p[0], x0, x1), (dy, p[1], y0, y1)):
        if abs(d) < 1e-9:
            if a < lo or a > hi:
                return False
            continue
        ta, tb = (lo - a) / d, (hi - a) / d
        if ta > tb:
            ta, tb = tb, ta
        t0, t1 = max(t0, ta), min(t1, tb)
        if t0 > t1:
            return False
    return True


def person_points(p):
    """World points a camera must see to show a person whole."""
    s = p.get('size') or 1
    x, y = p['x'], -p['y']
    h = PERSON * (1 if s == 1 else 0.85 * s)
    r = 0.35 * s
    if p.get('down'):
        return [Vector((x + dx, y + dy, z)) for dx in (-h / 2, h / 2) for dy in (-h / 2, h / 2) for z in (0.0, 0.35)]
    return [Vector((x + dx, y + dy, z)) for dx in (-r, r) for dy in (-r, r) for z in (0.0, h + 0.08)]


def place_camera(spec, cam, scene):
    """Over-the-shoulder 3/4 view: behind and to one side of camera.from, looking at camera.at,
    pulled back until every focus person fits in the frame. Returns the camera grid position."""
    from bpy_extras.object_utils import world_to_camera_view  # type: ignore[import-not-found]

    people = spec.get('people') or []
    focus = [p for p in people if p.get('focus')] or people
    c = spec.get('camera') or {}
    if focus:
        cx = sum(p['x'] for p in focus) / len(focus)
        cy = sum(p['y'] for p in focus) / len(focus)
    else:
        cx, cy = spec['cols'] / 2, spec['rows'] / 2
    at = c.get('at') or {'x': cx, 'y': cy}
    fr = c.get('from') or at
    ax, ay = at['x'], at['y']
    dx, dy = ax - fr['x'], ay - fr['y']
    n = math.hypot(dx, dy)
    if n < 0.5:
        # No action direction: look at the lone figure's front from a 3/4 angle if it faces somewhere,
        # else from the south-east.
        face = focus[0].get('face') if len(focus) == 1 else None
        if face and math.hypot(face['x'] - focus[0]['x'], face['y'] - focus[0]['y']) > 0.1:
            fx, fy = face['x'] - focus[0]['x'], face['y'] - focus[0]['y']
            a = math.atan2(fy, fx) + math.radians(35)
            dx, dy = -math.cos(a), -math.sin(a)  # direction camera -> target
        else:
            dx, dy = -1 / math.sqrt(2), -1 / math.sqrt(2)
        ox, oy = ax, ay
        swing = 0.0
    else:
        dx, dy = dx / n, dy / n
        ox, oy = fr['x'], fr['y']
        swing = math.radians(52)  # a 3/4 two-shot: both faces, not the back of the actor's head
    # Choose the side that keeps the camera nearer the middle of the map.
    mx, my = spec['cols'] / 2, spec['rows'] / 2
    best = None
    for side in (1, -1):
        a = side * swing
        bx = -(dx * math.cos(a) - dy * math.sin(a))
        by = -(dx * math.sin(a) + dy * math.cos(a))
        score = math.hypot(ox + bx * 3 - mx, oy + by * 3 - my)
        if best is None or score < best[0]:
            best = (score, bx, by)
    _, bx, by = best
    pts = [pt for p in focus for pt in person_points(p)]
    if pts:  # aim at the middle of the focus group so the frame is used well
        tx = (min(p.x for p in pts) + max(p.x for p in pts)) / 2
        ty = (min(p.y for p in pts) + max(p.y for p in pts)) / 2
        target = Vector((tx, ty, 0.82))
    else:
        target = Vector((ax, -ay, 0.8))
    def put(dist, target):
        h = min(1.12 + 0.06 * max(0.0, dist - 4.0), 1.7)  # eye level (about 1.7 m), rising a little when far
        gx, gy = ox + bx * dist, oy + by * dist
        cam.location = (gx, -gy, h)
        cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
        bpy.context.view_layer.update()
        return gx, gy, h

    def fit(target):
        dist = 1.5
        while True:
            put(dist, target)
            uv = [world_to_camera_view(scene, cam, pt) for pt in pts]
            if dist > 22 or all(d > 0.5 and 0.08 <= u <= 0.92 and 0.05 <= v <= 0.93 for u, v, d in uv):
                return dist, uv
            dist += 0.2

    dist, uv = fit(target)
    if uv:
        # Re-aim at the middle of what the camera sees of the group, then fit again: centers the
        # composition instead of leaving one side of the frame empty.
        for _ in range(2):
            uc = (min(u for u, _, _ in uv) + max(u for u, _, _ in uv)) / 2 - 0.5
            vc = (min(v for _, v, _ in uv) + max(v for _, v, _ in uv)) / 2 - 0.5
            depth = (target - cam.location).length
            span_w = 2 * depth * math.tan(cam.data.angle / 2)
            right = cam.matrix_world.to_3x3() @ Vector((1, 0, 0))
            right.z = 0
            target = target + right * (uc * span_w)
            target.z = max(0.6, min(1.1, target.z + vc * span_w * scene.render.resolution_y / scene.render.resolution_x))
            dist, uv = fit(target)
    dist += 0.2  # a little breathing room beyond the tightest fit
    gx, gy, h = put(dist, target)
    if os.environ.get('SCENE_DEBUG'):
        print(f'camera dist={dist:.2f} h={h:.2f} grid=({gx:.2f},{gy:.2f}) at=({ax:.2f},{ay:.2f})', file=sys.stderr)
    return (gx, gy), (ax, ay), target


TIME = {
    # sun color, sun strength (outdoor), elevation deg, sky horizon, sky zenith, indoor ambient
    'dawn': ('#ffb8a8', 2.2, 10, '#e8a8a0', '#5a6a9a', '#1c1418'),
    'day': ('#fff1dc', 4.0, 52, '#b8cde0', '#4a7ab8', '#2e2c2a'),
    'dusk': ('#ff9a50', 3.2, 12, '#e88a50', '#2a2850', '#1e1814'),
    'night': ('#8aa0ff', 0.9, 35, '#1c2640', '#060a16', '#0e1018'),
}


OVERCAST = {  # horizon, zenith under cloud
    'dawn': ('#6a6870', '#2c3040'),
    'day': ('#8c949c', '#4c5560'),
    'dusk': ('#4e5260', '#1a1e2a'),
    'night': ('#161a24', '#06080c'),
}


def setup_world(scene, spec, view='shot'):
    t = TIME.get(spec.get('time'), TIME['dusk'])
    world = bpy.data.worlds.new('world')
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes['Background']
    if spec.get('indoor'):
        bg.inputs['Color'].default_value = hex_rgba(t[5])
        bg.inputs['Strength'].default_value = 1.0
    else:
        # A gradient sky with soft noise clouds; in rain, fog or snow a low grey overcast.
        overcast = spec.get('weather') in ('rain', 'fog', 'snow', 'storm')
        horizon, zenith = (t[3], t[4]) if not overcast else OVERCAST.get(spec.get('time'), OVERCAST['dusk'])
        coord = nt.nodes.new('ShaderNodeTexCoord')
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        nt.links.new(coord.outputs['Generated'], sep.inputs[0])
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].position = 0.0
        ramp.color_ramp.elements[0].color = hex_rgba(horizon)
        ramp.color_ramp.elements[1].position = 0.5
        ramp.color_ramp.elements[1].color = hex_rgba(zenith)
        nt.links.new(sep.outputs[2], ramp.inputs[0])
        clouds = nt.nodes.new('ShaderNodeTexNoise')
        clouds.inputs['Scale'].default_value = 2.2
        clouds.inputs['Detail'].default_value = 8.0
        clouds.inputs['Roughness'].default_value = 0.6
        mapping = nt.nodes.new('ShaderNodeMapping')
        mapping.inputs['Scale'].default_value = (1.0, 1.0, 3.5)  # flattened toward the horizon
        nt.links.new(coord.outputs['Generated'], mapping.inputs['Vector'])
        nt.links.new(mapping.outputs[0], clouds.inputs['Vector'])
        cover = nt.nodes.new('ShaderNodeValToRGB')
        cover.color_ramp.elements[0].position = 0.35 if overcast else 0.52
        cover.color_ramp.elements[1].position = 0.75
        nt.links.new(clouds.outputs[0], cover.inputs[0])
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        nt.links.new(cover.outputs[0], mix.inputs[0])
        nt.links.new(ramp.outputs[0], mix.inputs[6])
        mix.inputs[7].default_value = hex_rgba(shade(horizon, 0.75) if overcast else shade(horizon, 1.15))
        nt.links.new(mix.outputs[2], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = 0.7 if overcast else 0.9
    # Atmosphere: a light haze indoors (smoke, lamp glow), fog outdoors in rain or fog. It lives in a
    # box around the scene: a world volume would swallow the world light (EEVEE treats it as
    # infinite) and the sun with it.
    weather = spec.get('weather')
    if spec.get('indoor'):
        density, vcol = 0.014, '#c8b8a0'
        region = (0, 0, spec['cols'], spec['rows'], WALL_H + 0.3)
    else:
        density = {'fog': 0.07, 'rain': 0.02, 'snow': 0.025}.get(weather, 0.01)  # always a little aerial haze
        vcol = '#aab4c0' if weather in ('fog', 'rain', 'snow') else t[3]
        region = (-120, -120, spec['cols'] + 240, spec['rows'] + 240, 30)
    if view == 'map':
        scene.world = world
        return
    if view == 'diorama':
        density *= 0.3
    fog = bpy.data.materials.new('fog')
    fog.use_nodes = True
    fnt = fog.node_tree
    fnt.nodes.remove(fnt.nodes.get('Principled BSDF'))
    fv = fnt.nodes.new('ShaderNodeVolumePrincipled')
    fv.inputs['Density'].default_value = density
    fv.inputs['Color'].default_value = hex_rgba(vcol)
    fv.inputs['Anisotropy'].default_value = 0.3
    fnt.links.new(fv.outputs[0], fnt.nodes.get('Material Output').inputs['Volume'])
    box(region[0], region[1], region[2], region[3], region[4], fog, z0=-0.5)
    bpy.context.active_object.visible_shadow = False
    scene.world = world


def precipitation(spec, cam, target):
    """Rain streaks or snow flakes in the air between the camera and a little past the action, as
    one mesh of small camera-facing quads (cheap in any engine)."""
    weather = spec.get('weather')
    if spec.get('indoor') or weather not in ('rain', 'snow'):
        return
    rnd = random.Random(7)
    fwd = (target - cam.location)
    reach = fwd.length + 6
    fwd.normalize()
    right = fwd.cross(Vector((0, 0, 1))).normalized()
    verts, faces = [], []
    n = 1400 if weather == 'rain' else 900
    for i in range(n):
        d = rnd.uniform(3.2, reach)
        half = d * 0.75
        c = cam.location + fwd * d + right * rnd.uniform(-half, half)
        c.z = rnd.uniform(0.0, 4.5)
        if weather == 'rain':
            w, h = 0.0012 + 0.0003 * d, rnd.uniform(0.18, 0.4)
            tilt = right * 0.06 * h
            quad = [c - right * w - tilt + Vector((0, 0, -h / 2)), c + right * w - tilt + Vector((0, 0, -h / 2)),
                    c + right * w + tilt + Vector((0, 0, h / 2)), c - right * w + tilt + Vector((0, 0, h / 2))]
        else:  # a small hexagonal flake facing the camera
            w = rnd.uniform(0.008, 0.018)
            quad = [c + right * (w * math.cos(a)) + Vector((0, 0, w * math.sin(a))) for a in (i2 * math.pi / 3 for i2 in range(6))]
        k = len(verts)
        verts.extend(quad)
        faces.append(tuple(range(k, k + len(quad))))
    mesh = bpy.data.meshes.new(weather)
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    o = bpy.data.objects.new(weather, mesh)
    bpy.context.scene.collection.objects.link(o)
    o.visible_shadow = False
    m = bpy.data.materials.new(weather)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get('Principled BSDF')
    col = '#c8d4e0' if weather == 'rain' else '#f4f8ff'
    b.inputs['Base Color'].default_value = hex_rgba(col)
    b.inputs['Emission Color'].default_value = hex_rgba(col)
    b.inputs['Emission Strength'].default_value = 0.08 if weather == 'rain' else 0.3
    mix = nt.nodes.new('ShaderNodeMixShader')
    mix.inputs[0].default_value = 0.14 if weather == 'rain' else 0.85  # mostly see-through streaks
    nt.links.new(nt.nodes.new('ShaderNodeBsdfTransparent').outputs[0], mix.inputs[1])
    nt.links.new(b.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes.get('Material Output').inputs['Surface'])
    add(o, m)


def furniture_mats(spec):
    rnd = random.Random(spec.get('seed') or spec.get('cols', 0) * 31 + spec.get('rows', 0))  # one place, one look
    return {
        'rnd': rnd,
        'outdoor': not spec.get('indoor'),
        'wood': wood('#6b4428', 'wood'),
        'wood_dark': wood('#3f2817', 'wood-dark'),
        'barrel': wood('#5e3b20', 'barrel'),
        'crate': wood('#8a6a42', 'crate'),
        'bark': wood('#3a2a1e', 'bark'),
        'iron': material('iron', '#2a2a2e', rough=0.45, metal=0.8),
        'pewter': material('pewter', '#8c8a86', rough=0.35, metal=0.8),
        'wax': material('wax', '#e8dcc0', rough=0.4),
        'flame': emissive('flame', '#ffb050', 20),
        'fire': emissive('fire', '#ff7a20', 30),
        'soot': material('soot', '#0c0a09', rough=0.95),
        'stone': surface('stone', 'wall'),
        'rock': material('rock', '#6a665e', rough=0.9),
        'leaves': material('leaves', '#2f4a22', rough=0.85),
        'linen': material('linen', '#d8d0bc', rough=0.85),
        'blanket': material('blanket', '#6a2a2a', rough=0.9),
        'sack': material('sack', '#a08a60', rough=0.95),
        'glass': [material(f'glass{i}', c, rough=0.15) for i, c in enumerate(('#2a5a2a', '#5a2a1a', '#3a3a6a', '#8a7a3a'))],
        'books': [material(f'book{i}', c, rough=0.7) for i, c in enumerate(('#6a2020', '#20406a', '#2a5a2a', '#7a5a2a', '#3a2a4a'))],
    }


def in_wall_orientation(f, wall_cells):
    x, y, w, h = f['x'], f['y'], f['w'], f['h']
    if (x - 1, y) in wall_cells or (x + w, y) in wall_cells:
        return 0.0
    if (x, y - 1) in wall_cells or (x, y + h) in wall_cells:
        return math.pi / 2
    return 0.0 if w >= h else math.pi / 2


def build_opening(f, spec, wall_rects, m):
    """A door or window set into a wall (or a free-standing door frame)."""
    shape = 'window' if f.get('shape') == 'window' else 'door'
    cells = {(cx, cy) for r in wall_rects for cx in range(r[0], r[0] + r[2]) for cy in range(r[1], r[1] + r[3])}
    angle = in_wall_orientation(f, cells)
    L = f['w'] if angle == 0 else f['h']
    fr = Frame(f['x'] + f['w'] / 2, -(f['y'] + f['h'] / 2), angle)
    in_wall = (f['x'], f['y']) in cells
    depth = 1.06 if in_wall else 0.15
    width = min(0.95, L - 0.05) if L <= 1 else L - 0.3
    if shape == 'door':
        fr.cube(0, 0, 0, width, depth, 2.1, m['door'])
        for i in range(int(width / 0.2)):  # plank seams
            fr.cube(-width / 2 + 0.2 * (i + 1), 0, 0.02, 0.012, depth + 0.01, 2.05, m['wood_dark'])
        for z in (0.35, 1.7):  # iron straps
            fr.cube(0, 0, z, width - 0.06, depth + 0.02, 0.07, m['iron'])
        fr.cube(0, 0, 2.1, width + 0.2, depth + 0.02, 0.15, m['wood_dark'])  # lintel
        if not in_wall:
            for sx in (-1, 1):
                fr.cube(sx * (width / 2 + 0.06), 0, 0, 0.12, 0.2, 2.25, m['wood_dark'])
    else:
        lit = spec.get('time') in ('day', 'dusk', 'dawn')
        col = {'day': '#cfe0f0', 'dusk': '#ffb070', 'dawn': '#ffc0b0'}.get(spec.get('time'), '#1a2440')
        pane = emissive(f'pane-{col}', col, 6 if lit else 0.6)
        fr.cube(0, 0, 1.0, width, depth - 0.02, 1.1, pane)
        fr.cube(0, 0, 0.92, width + 0.15, depth + 0.04, 0.1, m['wood_dark'])
        fr.cube(0, 0, 2.1, width + 0.15, depth + 0.04, 0.1, m['wood_dark'])
        fr.cube(0, 0, 1.0, 0.05, depth + 0.02, 1.1, m['wood_dark'])
        fr.cube(0, 0, 1.52, width, depth + 0.02, 0.05, m['wood_dark'])
        if lit:
            mx, my = spec['cols'] / 2, spec['rows'] / 2
            inward = Vector((mx - (f['x'] + 0.5), -(my - (f['y'] + 0.5)), 0))
            n = fr.at(0, 1, 0) - fr.at(0, 0, 0)
            n = n if n.dot(inward) > 0 else -n
            loc = fr.at(0, 0, 1.55) + n * 0.6
            area_light(loc, loc + n * 2 - Vector((0, 0, 1.0)), 60, col, size=1.0, name='window')


def ceiling(spec, m, walls):
    """A plank ceiling on heavy beams across the short side of the room."""
    cols, rows = spec['cols'], spec['rows']
    box(-0.5, -0.5, cols + 1, rows + 1, 0.12, surface('wood', 'floor'), z0=WALL_H)
    across_x = cols <= rows
    n = int((rows if across_x else cols) / 2)
    for i in range(n + 1):
        t = 1 + i * 2
        if across_x:
            box(-0.2, t - 0.15, cols + 0.4, 0.3, 0.32, m['wood_dark'], z0=WALL_H - 0.32)
        else:
            box(t - 0.15, -0.2, 0.3, rows + 0.4, 0.32, m['wood_dark'], z0=WALL_H - 0.32)


def chandelier(at, m):
    """An iron ring of candles hanging over the action, its warm light on the people below."""
    x, y = at
    z = WALL_H - 0.75
    fr = Frame(x, y, 0)
    fr.cyl(0, 0, z + 0.05, 0.012, WALL_H - z - 0.05, m['iron'], verts=6)
    fr.cyl(0, 0, z, 0.42, 0.04, m["iron"], verts=24)
    for i in range(6):
        a = i * math.tau / 6
        cx, cy = math.cos(a) * 0.4, math.sin(a) * 0.4
        fr.cyl(cx, cy, z + 0.04, 0.025, 0.12, m['wax'], verts=8)
        fr.ico(cx, cy, z + 0.2, 0.02, m['flame'], scale=(1, 1, 1.8), sub=1, seed=i)
    point_light(Vector((x, y, z + 0.1)), 300, '#ffb46a', radius=0.4, name='chandelier')


def build_lantern(loc, m, post=True):
    """A lantern on a post (light features) with its point light."""
    x, y, z = loc
    fr = Frame(x, y, 0)
    if post:
        fr.cyl(0, 0, 0, 0.05, z - 0.2, m['iron'], verts=8)
        fr.cube(0, 0, 0, 0.3, 0.3, 0.05, m['iron'])
    fr.cube(0, 0, z - 0.2, 0.2, 0.2, 0.03, m['iron'])
    fr.cube(0, 0, z - 0.17, 0.14, 0.14, 0.22, emissive('lantern', '#ffc070', 12))
    fr.cyl(0, 0, z + 0.05, 0.13, 0.1, m['iron'], verts=4, r2=0.0)
    point_light(Vector((x, y, z)), 90, '#ffb066', radius=0.12)


def sconce(loc, normal, m):
    """A wall torch bracket with a flame and its light, `normal` pointing into the room."""
    x, y, z = loc
    ang = math.atan2(normal.x, -normal.y)
    fr = Frame(x, y, ang + math.pi)  # local +y points into the wall
    fr.cube(0, 0.02, z - 0.15, 0.12, 0.04, 0.3, m['iron'])
    fr.cyl(0, -0.12, z - 0.05, 0.035, 0.32, m['wood_dark'], verts=8)
    fr.ico(0, -0.12, z + 0.18, 0.06, m['fire'], scale=(1, 1, 1.8), sub=1)
    point_light(Vector((x, y, z + 0.25)) + normal * 0.35, 110, '#ff9a4a', radius=0.1, name='sconce')


TOWN = {'cobbles', 'stone', 'brick', 'plaster', 'wood'}
_glows = [0]  # window lights placed so far (each light costs render time)


def per_object(n, a, b):
    """A color between a and b that differs per object (one shader for a whole street of houses)."""
    info = n.new('ShaderNodeObjectInfo')
    return n.mix(info.outputs['Random'], a, b)


def plaster():
    """Lime plaster, a different tint per house, with stains."""
    key = ('plaster',)
    if key in _materials:
        return _materials[key]
    m = bpy.data.materials.new('plaster')
    m.use_nodes = True
    n = Nodes(m)
    big = n.noise(n.coords('world'), 1.2, 4.0, 0.6)
    fine = n.noise(n.coords('world'), 14.0, 6.0, 0.6)
    tint = per_object(n, '#c4b28c', '#8f8a80')
    col = n.mix(1.0, tint, n.ramp(big, 0.3, 0.75, hex_rgba('#b8b8b8'), hex_rgba('#ffffff')), 'MULTIPLY')
    col = n.mix(0.3, col, n.ramp(fine, 0.3, 0.7, hex_rgba('#808080'), hex_rgba('#ffffff')), 'MULTIPLY')
    n.color(col)
    n.bump(fine, 0.15, 0.02)
    n.bsdf.inputs['Roughness'].default_value = 0.92
    _materials[key] = m
    return m


def roof_tiles():
    key = ('tiles',)
    if key in _materials:
        return _materials[key]
    m = bpy.data.materials.new('tiles')
    m.use_nodes = True
    n = Nodes(m)
    col, mortar = n.brick(n.coords('world', (1.0, 1.0, 1.0)), '#ffffff', '#b0b0b0', '#606060', 0.3, 0.16, 0.012)
    col = n.mix(1.0, col, per_object(n, '#5a3428', '#3c3a40'), 'MULTIPLY')
    dirt = n.noise(n.coords('world'), 2.0, 5.0, 0.6)
    n.color(n.mix(0.4, col, n.ramp(dirt, 0.3, 0.8, hex_rgba('#606060'), hex_rgba('#ffffff')), 'MULTIPLY'))
    n.bump(mortar, 0.6, 0.03, invert=True)
    n.bsdf.inputs['Roughness'].default_value = 0.8
    _materials[key] = m
    return m


def house(fr, w, d, h, a, rnd, lit, m):
    """A timber-framed town house facing local -y: stone plinth, plaster between dark beams, a
    jettied upper floor, a tiled roof with eaves, framed windows (warm when lit), a door, a chimney."""
    beam = m['wood_dark']
    stone = surface('stone', 'wall')
    wall = plaster()
    plinth = 0.45
    fr.cube(0, 0, 0, w, d, plinth, stone)
    ground = h * 0.5
    fr.cube(0, 0, plinth, w - 0.04, d - 0.04, ground - plinth, wall)
    jet = 0.18  # the upper floor overhangs the street
    fr.cube(0, -jet / 2, ground, w + 0.1, d + jet, h - ground, wall)
    front = -d / 2 - 0.02
    upper = front - jet
    for z0, z1, y in ((plinth, ground, front), (ground, h, upper)):  # timber frame on the facade
        span = w + (0.1 if y == upper else 0)
        n = max(2, int(span / 0.9))
        for i in range(n + 1):
            fr.cube(-span / 2 + i * span / n, y, z0, 0.1, 0.05, z1 - z0, beam)
        fr.cube(0, y, z1 - 0.1, span, 0.06, 0.12, beam)
        fr.cube(0, y, z0, span, 0.06, 0.1, beam)
        if y == upper:  # a pair of braces
            for sx in (-1, 1):
                b = fr.cube(sx * span * 0.3, y, z0 + (z1 - z0) * 0.5 - 0.3, 0.08, 0.04, 0.9, beam)
                b.rotation_euler = (0, sx * 0.7, a)
    # Roof with eaves.
    hw, hd, rise = w / 2 + 0.35, (d + jet) / 2 + 0.4, (d + jet) * 0.5
    verts = [(sx * hw, sy * hd, 0) for sx in (-1, 1) for sy in (-1, 1)] + [(-hw, 0, rise), (hw, 0, rise)]
    faces = [(0, 1, 4), (2, 5, 3), (0, 4, 5, 2), (1, 3, 5, 4), (0, 2, 3, 1)]
    mesh = bpy.data.meshes.new('roof')
    mesh.from_pydata(verts, [], faces)
    o = bpy.data.objects.new('roof', mesh)
    bpy.context.scene.collection.objects.link(o)
    o.location = fr.at(0, -jet / 2, h)
    o.rotation_euler = (0, 0, a)
    sol = o.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.08
    add(o, roof_tiles())
    # Gable ends in plaster under the roof.
    gv = [(sx * (w / 2 + 0.05), sy * ((d + jet) / 2), 0) for sx in (-1, 1) for sy in (-1, 1)] + [(-(w / 2 + 0.05), 0, rise * 0.92), (w / 2 + 0.05, 0, rise * 0.92)]
    gm = bpy.data.meshes.new('gable')
    gm.from_pydata(gv, [], [(0, 1, 4), (2, 5, 3)])
    g = bpy.data.objects.new('gable', gm)
    bpy.context.scene.collection.objects.link(g)
    g.location = fr.at(0, -jet / 2, h)
    g.rotation_euler = (0, 0, a)
    add(g, wall)
    if rnd.random() < 0.7:
        fr.cube(w * rnd.choice((-0.28, 0.28)), 0.2, h, 0.45, 0.45, rise + 0.6, stone)
    # Door and windows.
    dx = rnd.uniform(-w * 0.25, w * 0.25)
    fr.cube(dx, front - 0.01, plinth, 0.75, 0.06, 1.55, m['door'])
    fr.cube(dx, front - 0.03, plinth + 1.55, 0.9, 0.08, 0.1, beam)
    dark = material('dark-window', '#0d1014', rough=0.15)
    glow = emissive('house-window', '#ffb468', 5)
    slots = [(x, plinth + 0.55, front) for x in (-w * 0.33, w * 0.33) if abs(x - dx) > 0.75]
    slots += [(x, ground + 0.45, upper) for x in (-w * 0.3, 0.0, w * 0.3)[: 2 if w < 3.6 else 3]]
    for (x, z, y) in slots:
        on = lit and rnd.random() < 0.6
        fr.cube(x, y - 0.01, z, 0.5, 0.05, 0.6, glow if on else dark)
        fr.cube(x, y - 0.03, z + 0.27, 0.06, 0.05, 0.06, beam)
        fr.cube(x, y - 0.03, z, 0.6, 0.06, 0.07, beam)
        fr.cube(x, y - 0.03, z + 0.6, 0.6, 0.06, 0.07, beam)
        fr.cube(x, y - 0.035, z + 0.3, 0.5, 0.04, 0.035, beam)
        fr.cube(x, y - 0.035, z + 0.3, 0.035, 0.04, 0.6, beam)
        if on and rnd.random() < 0.5 and _glows[0] < 4:
            _glows[0] += 1
            point_light(fr.at(x, y - 0.8, z + 0.3), 25, '#ffa860', radius=0.25, name='window-glow')
        elif not on and rnd.random() < 0.5:  # shutters
            for sx in (-1, 1):
                fr.cube(x + sx * 0.4, y - 0.02, z, 0.25, 0.04, 0.6, m['door'])


def backdrop(spec, cam_grid, sight, m):
    """Outdoors: a ring of simple silhouettes around the map (houses in a town, trees and rocks in
    the wild) so the world does not end at a flat horizon. Kept out of the camera's way."""
    cols, rows = spec['cols'], spec['rows']
    rnd = random.Random((spec.get('seed') or cols * 7 + rows * 3 + len(spec.get('features') or [])) + 7)
    town = (spec.get('floor') or 'dirt') in TOWN
    cx, cy = cols / 2, rows / 2
    base = math.hypot(cols, rows) / 2 + 1.5
    lit = spec.get('time') in ('dusk', 'night', 'dawn')
    placed = []
    tries = 0
    want = 16 if town else 34
    while len(placed) < want and tries < 600:
        tries += 1
        ang = rnd.uniform(0, math.tau)
        dist = base + rnd.uniform(1.0, 14.0 if town else 22.0)
        x, y = cx + math.cos(ang) * dist * (cols / max(cols, rows) * 0.5 + 0.5), cy + math.sin(ang) * dist
        size = rnd.uniform(3.0, 5.0) if town else rnd.uniform(1.0, 1.8)
        reach = (size * 0.75 + 1.5) if town else size * 0.6 + 0.5  # keep clear of the map itself
        if -reach < x < cols + reach and -reach < y < rows + reach:
            continue
        if math.hypot(x - cam_grid[0], y - cam_grid[1]) < 4.0 + size / 2:
            continue
        if any(seg_hits_rect(cam_grid, q, (x - size / 2, y - size / 2, size, size), pad=0.5) for q in sight):
            continue
        if any(math.hypot(x - px, y - py) < (size + ps) / 2 + 0.4 for px, py, ps in placed):
            continue
        placed.append((x, y, size))
        # Face the map: local -y toward its center.
        dx, dy = cx - x, -(cy - y)
        a = math.atan2(dx, -dy)
        a = round(a / (math.pi / 2)) * (math.pi / 2) + rnd.uniform(-0.12, 0.12)
        fr = Frame(x, -y, a)
        if town:
            house(fr, size, rnd.uniform(2.6, 3.6), rnd.uniform(2.6, 4.2), a, rnd, lit, m)
        elif rnd.random() < 0.72:
            build_tree(fr, size, size, m)
        else:
            build_rock(fr, size, size * rnd.uniform(0.7, 1.0), m)


def dress(spec, faces, wall_cells, m, skip):
    """A sparse room gets a little set dressing (barrels, crates, a shelf) in free cells against the
    walls, away from people and doors. The choice never depends on the camera, so the map, the
    diorama and the shot show the same room; skip(cell) only hides a piece in front of the lens."""

    feats = spec.get('features') or []
    used = m['used']
    for f in feats:
        if f.get('kind') == 'wall':
            continue
        pad = 1 if f.get('kind') == 'door' or f.get('shape') in ('door', 'hearth') else 0
        for x in range(int(f['x']) - pad, int(f['x'] + f['w']) + pad):
            for y in range(int(f['y']) - pad, int(f['y'] + f['h']) + pad):
                used.add((x, y))
    furniture = sum(1 for f in feats if f.get('kind') in ('object', 'cover') and f.get('shape') not in ('door', 'window'))
    if furniture >= 5:
        return
    people = spec.get('people') or []
    rnd = random.Random((spec.get('seed') or len(faces) * 13 + spec['cols']) + 13)
    free = []
    for (px, py, nx, ny, cell) in faces:
        cx, cy = cell[0] + 0.5, cell[1] + 0.5
        if cell in used or any(math.hypot(cx - p['x'], cy - p['y']) < 1.6 for p in people):
            continue
        corner = sum(((cell[0] + dx, cell[1] + dy) in wall_cells) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))) >= 2
        free.append((corner, rnd.random(), cell, nx, ny))
    free.sort(key=lambda c: (not c[0], c[1]))
    placed = 0
    for corner, _, cell, nx, ny in free:
        if placed >= 4 - min(furniture, 3) or cell in used:
            continue
        if skip(cell):
            placed += 1
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    used.add((cell[0] + dx, cell[1] + dy))
            continue
        ang = math.atan2(nx, ny)  # front (local -y) faces into the room
        fr = Frame(cell[0] + 0.5, -(cell[1] + 0.5), ang)
        kind = ['barrel', 'crate', 'barrel', 'shelf'][placed % 4] if not corner else rnd.choice(['barrel', 'crate'])
        if kind == 'shelf':
            fr = Frame(cell[0] + 0.5 - nx * 0.25, -(cell[1] + 0.5 - ny * 0.25), ang)
        BUILDERS[kind](fr, 1, 1, m)
        m['props'].add(cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                used.add((cell[0] + dx, cell[1] + dy))
        placed += 1


# ---------------------------------------------------------------- overview views (map, diorama)

def place_overview(spec, cam, scene, view):
    """map: an orthographic camera straight down, framing exactly the grid (image x = grid x, image y =
    grid y). diorama: a raised 3/4 view from the south-east fitting the whole map. Returns the same
    (camera grid position, look-at grid position, target) triple as place_camera."""
    from bpy_extras.object_utils import world_to_camera_view  # type: ignore[import-not-found]

    cols, rows = spec['cols'], spec['rows']
    cx, cy = cols / 2, rows / 2
    if view == 'map':
        cam.data.type = 'ORTHO'
        cam.data.sensor_fit = 'HORIZONTAL' if cols >= rows else 'VERTICAL'
        cam.data.ortho_scale = cols if cols >= rows else rows
        cam.data.clip_end = 100
        cam.location = (cx, -cy, 40)
        cam.rotation_euler = (0, 0, 0)
        return (cx, cy), (cx, cy), Vector((cx, -cy, 0))
    az, el = math.radians(28), math.radians(52)
    dx, dy = math.sin(az), math.cos(az)  # grid direction from the center toward the camera (south-east)
    target = Vector((cx, -cy, 0.2))
    pts = [Vector((x, -y, z)) for x in (0, cols) for y in (0, rows) for z in (0.0, 1.3)]
    pts += [pt for p in spec.get('people') or [] for pt in person_points(p)]
    dist = 3.0
    while True:
        h = dist * math.cos(el)
        cam.location = (cx + dx * h, -(cy + dy * h), dist * math.sin(el))
        cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
        bpy.context.view_layer.update()
        uv = [world_to_camera_view(scene, cam, pt) for pt in pts]
        if dist > 60 or all(d > 0 and 0.02 <= u <= 0.98 and 0.03 <= v <= 0.97 for u, v, d in uv):
            break
        dist += 0.25
    h = dist * math.cos(el)
    return (cx + dx * h, cy + dy * h), (cx, cy), target


def overview_lighting(scene, spec, view, target):
    """Even, readable light for the map and the diorama (the shot has its own cinematic lighting)."""
    tod = spec.get('time') or 'dusk'
    world = scene.world
    bg = world.node_tree.nodes['Background']
    if view == 'map' or spec.get('indoor'):
        for link in list(bg.inputs['Color'].links):
            world.node_tree.links.remove(link)
        bg.inputs['Color'].default_value = hex_rgba('#8c9098' if view == 'map' else '#5a5652')
        bg.inputs['Strength'].default_value = 1.0
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.0 if view == 'map' else 4.0
    sun.color = hex_rgba('#fff4e6' if view == 'map' or tod == 'day' else '#ffe6c8')[:3]
    sun.angle = math.radians(25 if view == 'map' else 10)  # the map: from overhead, soft, no long shadows
    so = bpy.data.objects.new('sun', sun)
    so.rotation_euler = (math.radians(4 if view == 'map' else 38), 0, math.radians(35))
    del target
    scene.collection.objects.link(so)


def grid_overlay(cols, rows):
    """Thin dark lines on the cell boundaries, floating just above the floor (the diorama's grid)."""
    m = bpy.data.materials.new('grid')
    m.use_nodes = True
    nt = m.node_tree
    out = nt.nodes.get('Material Output')
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = hex_rgba('#0c0c0c')
    bsdf.inputs['Roughness'].default_value = 0.9
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(geo.outputs['Position'], sep.inputs[0])

    def near_line(sock):
        fr = nt.nodes.new('ShaderNodeMath')
        fr.operation = 'FRACT'
        nt.links.new(sock, fr.inputs[0])
        inv = nt.nodes.new('ShaderNodeMath')
        inv.operation = 'SUBTRACT'
        inv.inputs[0].default_value = 1.0
        nt.links.new(fr.outputs[0], inv.inputs[1])
        mn = nt.nodes.new('ShaderNodeMath')
        mn.operation = 'MINIMUM'
        nt.links.new(fr.outputs[0], mn.inputs[0])
        nt.links.new(inv.outputs[0], mn.inputs[1])
        lt = nt.nodes.new('ShaderNodeMath')
        lt.operation = 'LESS_THAN'
        lt.inputs[1].default_value = 0.022
        nt.links.new(mn.outputs[0], lt.inputs[0])
        return lt.outputs[0]

    both = nt.nodes.new('ShaderNodeMath')
    both.operation = 'MAXIMUM'
    nt.links.new(near_line(sep.outputs[0]), both.inputs[0])
    nt.links.new(near_line(sep.outputs[1]), both.inputs[1])
    alpha = nt.nodes.new('ShaderNodeMath')
    alpha.operation = 'MULTIPLY'
    alpha.inputs[1].default_value = 0.6
    nt.links.new(both.outputs[0], alpha.inputs[0])
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(alpha.outputs[0], mix.inputs[0])
    nt.links.new(nt.nodes.new('ShaderNodeBsdfTransparent').outputs[0], mix.inputs[1])
    nt.links.new(bsdf.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    bpy.ops.mesh.primitive_plane_add(size=1, location=(cols / 2, -rows / 2, 0.006))
    g = bpy.context.active_object
    g.scale = (cols, rows, 1)
    g.visible_shadow = False
    add(g, m)


def token_base(p):
    """A colored base under each figure in the diorama (grey and thin for someone waiting to join)."""
    s = p.get('size') or 1
    col = '#8a8a8a' if p.get('waiting') else (p.get('color') or '#888888')
    mat = material(f'base-{col}', col, rough=0.5, emission=col, strength=0.4)
    Frame(p['x'], -p['y'], 0).cyl(0, 0, 0.0, 0.42 * s, 0.02 if p.get('waiting') else 0.035, mat, verts=32)


def turntable(scene, cam, target, a):
    """A short loop orbiting the diorama, written next to the still."""
    pivot = bpy.data.objects.new('pivot', None)
    scene.collection.objects.link(pivot)
    pivot.location = target
    bpy.context.view_layer.update()
    world = cam.matrix_world.copy()
    cam.parent = pivot
    cam.matrix_world = world
    pivot.rotation_euler = (0, 0, 0)
    pivot.keyframe_insert('rotation_euler', frame=1)
    pivot.rotation_euler = (0, 0, math.radians(360))
    pivot.keyframe_insert('rotation_euler', frame=a.frames + 1)
    action = pivot.animation_data.action
    for fc in getattr(action, 'fcurves', []) or []:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
    try:  # Blender 5 layered actions
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for fc in bag.fcurves:
                        for kp in fc.keyframe_points:
                            kp.interpolation = 'LINEAR'
    except AttributeError:
        pass
    r = scene.render
    scene.frame_start, scene.frame_end = 1, a.frames
    r.fps = 12
    r.resolution_x, r.resolution_y = 960, 540
    try:
        scene.eevee.taa_render_samples = 16
    except AttributeError:
        pass
    try:
        r.image_settings.media_type = 'VIDEO'
    except (AttributeError, TypeError):
        pass
    r.image_settings.file_format = 'FFMPEG'
    r.ffmpeg.format = 'MPEG4'
    r.ffmpeg.codec = 'H264'
    r.ffmpeg.constant_rate_factor = 'MEDIUM'
    r.filepath = os.path.abspath(a.turntable)
    bpy.ops.render.render(animation=True)
    return r.filepath


def main():
    a = args()
    started = time.monotonic()
    spec = json.loads(open(a.scene, encoding='utf-8').read())
    cols, rows = int(spec.get('cols') or 10), int(spec.get('rows') or 8)
    spec['cols'], spec['rows'] = cols, rows
    indoor = bool(spec.get('indoor'))
    features = spec.get('features') or []
    people = spec.get('people') or []
    tod = spec.get('time') or 'dusk'

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    # Camera first: what it sees decides which walls are cut away.
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 35
    cam_data.clip_start = 0.05
    cam_data.clip_end = 300
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    r = scene.render
    view = a.view
    r.resolution_x, r.resolution_y = (cols * a.px, rows * a.px) if view == 'map' else (a.width, a.height)
    r.resolution_percentage = 100
    if view == 'shot':
        cam_grid, at_grid, target = place_camera(spec, cam, scene)
    else:
        cam_grid, at_grid, target = place_overview(spec, cam, scene, view)
    focus = [p for p in people if p.get('focus')] or people
    # Lines of sight from the camera to each person in focus, stopping just short of them (so a
    # table between two fighters stays, but a crate in front of the lens goes). Overviews cut
    # nothing away; their sight lines only keep backdrop houses off the map.
    sight = []
    if view == 'shot':
        for p in focus:
            vx, vy = p['x'] - cam_grid[0], p['y'] - cam_grid[1]
            dd = math.hypot(vx, vy)
            if dd > 0.6:
                sight.append((p['x'] - vx / dd * 0.45, p['y'] - vy / dd * 0.45))
    else:
        sight = [(0, 0), (cols, 0), (0, rows), (cols, rows), (cols / 2, rows / 2)]

    def blocks_view(rect):
        if view != 'shot':
            return False
        if rect[0] - 0.1 <= cam_grid[0] <= rect[0] + rect[2] + 0.1 and rect[1] - 0.1 <= cam_grid[1] <= rect[1] + rect[3] + 0.1:
            return True
        return any(seg_hits_rect(cam_grid, q, rect, pad=0.15) for q in sight)

    m = furniture_mats(spec)
    m['door'] = wood('#4a2e18', 'door')
    m['used'] = set()
    m['props'] = set()

    # Ground.
    wet = not indoor and spec.get('weather') in ('rain', 'storm')
    floor_mat = surface(spec.get('floor') or ('wood' if indoor else 'dirt'), 'floor', wet=wet)
    if indoor:
        box(0, 0, cols, rows, 0.1, floor_mat, z0=-0.1)
    else:
        bpy.ops.mesh.primitive_plane_add(size=1, location=(cols / 2, -rows / 2, 0))
        g = bpy.context.active_object
        g.scale = (cols + 600, rows + 600, 1)
        add(g, floor_mat)
        if view != 'map':
            backdrop(spec, cam_grid, sight, m)

    # Walls (cut away those between the camera and the action).
    wall_mat = surface(spec.get('wall') or 'stone', 'wall')
    wall_h = 0.8 if view == 'diorama' else WALL_H if indoor else 2.4  # a diorama's walls are cut low to see in
    kept_walls = []
    for f in features:
        if f.get('kind') != 'wall':
            continue
        rect = (int(f['x']), int(f['y']), int(f['w']), int(f['h']))
        if blocks_view(rect):
            continue
        kept_walls.append(rect)
        if indoor and (spec.get('wall') or 'wood') in ('wood', 'plaster'):
            # Wood panelling to chair-rail height, lime plaster above, as in a tavern or house.
            box(rect[0], rect[1], rect[2], rect[3], 1.0, surface('wood', 'wall'))
            box(rect[0] + 0.03, rect[1] + 0.03, rect[2] - 0.06, rect[3] - 0.06, wall_h - 1.0, plaster(), z0=1.0)
            box(rect[0] - 0.03, rect[1] - 0.03, rect[2] + 0.06, rect[3] + 0.06, 0.08, m['wood_dark'], z0=0.98)
        else:
            box(rect[0], rect[1], rect[2], rect[3], wall_h, wall_mat)
        # A dark timber skirting and top beam make the wall read at a glance.
        box(rect[0] - 0.02, rect[1] - 0.02, rect[2] + 0.04, rect[3] + 0.04, 0.18, m['wood_dark'])
        if indoor:
            box(rect[0] - 0.03, rect[1] - 0.03, rect[2] + 0.06, rect[3] + 0.06, 0.2, m['wood_dark'], z0=wall_h - 0.2)
    kept_cells = {(x, y) for rr in kept_walls for x in range(rr[0], rr[0] + rr[2]) for y in range(rr[1], rr[1] + rr[3])}
    all_walls = [(int(f['x']), int(f['y']), int(f['w']), int(f['h'])) for f in features if f.get('kind') == 'wall']
    all_cells = {(x, y) for rr in all_walls for x in range(rr[0], rr[0] + rr[2]) for y in range(rr[1], rr[1] + rr[3])}

    # Interior wall faces, one point per wall cell: (x, y on the face line, inward normal nx, ny).
    faces = []
    for (x, y, w, h) in kept_walls:
        if w >= h:
            ny = 1 if rows / 2 > y + h / 2 else -1
            pts = [(x + 0.5 + i, y + h if ny > 0 else y, 0, ny) for i in range(w)]
        else:
            nx = 1 if cols / 2 > x + w / 2 else -1
            pts = [(x + w if nx > 0 else x, y + 0.5 + i, nx, 0) for i in range(h)]
        for (px, py, nx, ny) in pts:
            inside = (int(math.floor(px + nx * 0.5)), int(math.floor(py + ny * 0.5)))
            if inside in all_cells or not (0 <= inside[0] < cols and 0 <= inside[1] < rows):
                continue
            faces.append((px, py, nx, ny, inside))
    if indoor:
        # Timber posts every few cells break up long walls.
        for i, (px, py, nx, ny, _) in enumerate(faces):
            if (int(px) + int(py)) % 3 == 0:
                bx, by = (px - 0.5, py) if ny else (px, py - 0.5)
                box(bx - 0.1 + nx * 0.06, by - 0.1 + ny * 0.06, 0.2, 0.2, wall_h, m['wood_dark'])
        # Dressing goes against every wall (cut away or not), so all views agree on the room.
        faces_all = []
        for (x, y, w, h) in all_walls:
            if w >= h:
                ny = 1 if rows / 2 > y + h / 2 else -1
                pts = [(x + 0.5 + i, y + h if ny > 0 else y, 0, ny) for i in range(w)]
            else:
                nx = 1 if cols / 2 > x + w / 2 else -1
                pts = [(x + w if nx > 0 else x, y + 0.5 + i, nx, 0) for i in range(h)]
            for (px, py, nx, ny) in pts:
                inside = (int(math.floor(px + nx * 0.5)), int(math.floor(py + ny * 0.5)))
                if inside not in all_cells and 0 <= inside[0] < cols and 0 <= inside[1] < rows:
                    faces_all.append((px, py, nx, ny, inside))
        dress(spec, faces_all, all_cells, m,
              lambda c: blocks_view((c[0], c[1], 1, 1)) or (view == 'shot' and math.hypot(c[0] + 0.5 - cam_grid[0], c[1] + 0.5 - cam_grid[1]) < 2.5))

    # Features.
    lights = 0
    for f in features:
        kind, shape = f.get('kind'), f.get('shape') or 'block'
        rect = (f['x'], f['y'], f['w'], f['h'])
        wx, wy = f['x'] + f['w'] / 2, -(f['y'] + f['h'] / 2)
        if kind == 'wall':
            continue
        if kind in ('water', 'pit', 'difficult'):
            if kind == 'water':
                box(*rect[:2], f['w'], f['h'], 0.02, surface('water'), z0=0.0)
            elif kind == 'pit':
                # A black hole with a ragged stone rim.
                box(*rect[:2], f['w'], f['h'], 0.012, material('pit', '#020202', rough=1.0), z0=0.0)
                fr = Frame(wx, wy, 0)
                for i in range(int(2 * (f['w'] + f['h']) * 3)):
                    t = i / (2 * (f['w'] + f['h']) * 3)
                    per = t * 2 * (f['w'] + f['h'])
                    if per < f['w']:
                        lx, ly = per - f['w'] / 2, -f['h'] / 2
                    elif per < f['w'] + f['h']:
                        lx, ly = f['w'] / 2, per - f['w'] - f['h'] / 2
                    elif per < 2 * f['w'] + f['h']:
                        lx, ly = f['w'] / 2 - (per - f['w'] - f['h']), f['h'] / 2
                    else:
                        lx, ly = -f['w'] / 2, f['h'] / 2 - (per - 2 * f['w'] - f['h'])
                    fr.ico(lx, ly, 0.03, m['rnd'].uniform(0.08, 0.15), m['rock'], scale=(1, 1, 0.55), sub=1, seed=i)
            else:
                # Rubble: scattered stones and broken boards on a dirt patch.
                box(*rect[:2], f['w'], f['h'], 0.012, surface('dirt'), z0=0.0)
                fr = Frame(wx, wy, 0)
                rr = m['rnd']
                for i in range(int(f['w'] * f['h'] * 6)):
                    fr.ico(rr.uniform(-f['w'] / 2 + 0.12, f['w'] / 2 - 0.12), rr.uniform(-f['h'] / 2 + 0.12, f['h'] / 2 - 0.12),
                           0.03, rr.uniform(0.06, 0.18), m['rock'], scale=(1, 1, 0.6), sub=1, seed=i)
                for i in range(int(f['w'] * f['h'])):
                    b = fr.cube(rr.uniform(-f['w'] / 2 + 0.3, f['w'] / 2 - 0.3), rr.uniform(-f['h'] / 2 + 0.3, f['h'] / 2 - 0.3),
                                0.02, 0.7, 0.12, 0.04, m['wood_dark'], tilt=(0, rr.uniform(-0.15, 0.15)))
                    b.rotation_euler.z = rr.uniform(0, math.pi)
            if shape not in BUILDERS:
                continue
        if kind == 'light':
            if blocks_view(rect):  # keep the light, drop the post that would hide the action
                point_light(Vector((wx, wy, 2.2)), 90, '#ffb066', radius=0.12)
            else:
                build_lantern((wx, wy, 1.7 if not indoor else 1.9), m)
            lights += 1
            continue
        if kind == 'door' or shape in ('door', 'window'):
            cell = (int(f['x']), int(f['y']))
            if cell in all_cells and cell not in kept_cells:
                continue  # its wall was cut away
            if cell not in all_cells and blocks_view(rect):
                continue
            if view == 'diorama':
                if shape != 'window':
                    box(f['x'] + 0.1, f['y'] + 0.1, f['w'] - 0.2, f['h'] - 0.2, 0.04, m['door'])
                continue
            build_opening(f, spec, kept_walls, m)
            continue
        if blocks_view(rect):
            continue  # cut away: it stands between the camera and the people in focus
        if math.hypot(wx - cam_grid[0], -wy - cam_grid[1]) < 1.0:
            continue  # right in the lens
        if shape == 'hearth':
            lights += 1
        if shape == 'chair':
            tables = [t for t in features if t.get('shape') == 'table']
            if tables:
                t = min(tables, key=lambda t: math.hypot(t['x'] + t['w'] / 2 - (f['x'] + 0.5), t['y'] + t['h'] / 2 - (f['y'] + 0.5)))
                dx, dy = (t['x'] + t['w'] / 2) - (f['x'] + 0.5), -((t['y'] + t['h'] / 2) - (f['y'] + 0.5))
                ang = math.atan2(dx, -dy)
                ang = round(ang / (math.pi / 2)) * (math.pi / 2)
            else:
                ang = facing_center(f, spec)
            L, D = 1, 1
        else:
            ang = facing_center(f, spec)
            L, D = (f['w'], f['h']) if f['w'] >= f['h'] else (f['h'], f['w'])
        fr = Frame(wx, wy, ang)
        if shape in BUILDERS:
            BUILDERS[shape](fr, L, D, m)
        else:
            build_block(fr, L, D, m, kind)

    if indoor and view == 'shot':
        ceiling(spec, m, all_walls)
        if not m.get('hanging'):
            chandelier((target.x, target.y), m)  # extra light: the wall torches still come

    # People.
    for i, p in enumerate(people):
        person(p, bool(spec.get('fight')), i)

    # Lighting.
    setup_world(scene, spec, view)
    side0 = (cam.location - target).cross(Vector((0, 0, 1)))
    side0.z = 0
    side0 = side0.normalized() if side0.length > 1e-6 else Vector((1, 0, 0))
    t = TIME.get(tod, TIME['dusk'])
    overcast = spec.get('weather') in ('rain', 'fog', 'snow', 'storm')
    tx, ty = target.x, target.y
    if view == 'shot':
        if indoor:
            # Wall torches near the action on walls that are still standing.
            cands = [fc[:4] for fc in faces if fc[4] not in m['props']]
            cands.sort(key=lambda c: math.hypot(c[0] - at_grid[0], c[1] - at_grid[1]))
            chosen = []
            for c in cands:
                if math.hypot(c[0] - cam_grid[0], c[1] - cam_grid[1]) < 2.0:
                    continue
                if all(math.hypot(c[0] - o[0], c[1] - o[1]) >= 3.0 for o in chosen):
                    chosen.append(c)
                if len(chosen) >= (3 if lights == 0 else 1):
                    break
            for (px, py, nx, ny) in chosen:
                nrm = Vector((nx, -ny, 0))
                sconce(Vector((px, -py, 1.9)) + nrm * 0.02, nrm, m)
            if not chosen and lights == 0:
                point_light(Vector((tx + 1.5, ty + 1.0, 2.6)), 150, '#ffb066', radius=0.2)
            # Soft daylight / dusk glow through the open top, kept low so the lamps rule.
            if tod != 'night':
                sun = bpy.data.lights.new('sun', 'SUN')
                sun.energy = {'day': 3.0, 'dawn': 0.8, 'dusk': 0.7}[tod]
                sun.color = hex_rgba(t[0])[:3]
                sun.angle = math.radians(5)
                so = bpy.data.objects.new('sun', sun)
                so.rotation_euler = (math.radians(90 - max(t[2], 35)), 0, math.radians(35))
                scene.collection.objects.link(so)
        else:
            sun = bpy.data.lights.new('sun', 'SUN')
            sun.energy = t[1] * (0.3 if overcast else 1.0)
            sun.color = hex_rgba('#a8b4c8' if overcast else t[0])[:3]
            sun.angle = math.radians(25 if overcast else 3)  # soft, shadowless light under cloud
            so = bpy.data.objects.new('sun', sun)
            # Light from the side/back of the camera direction for modelling and long shadows.
            cdir = math.atan2(cam.location.y - ty, cam.location.x - tx)
            so.rotation_euler = (math.radians(90 - t[2]), 0, cdir + math.radians(90 + 60))
            scene.collection.objects.link(so)
            if tod in ('night', 'dusk') and lights == 0:
                # A street lantern behind the group, to one side: a warm pool of light (and a reflection
                # on wet stone) against the cool evening.
                back = Vector((tx, ty, 0)) - Vector((cam.location.x - tx, cam.location.y - ty, 0)).normalized() * 1.6 + side0 * 1.8
                if all(math.hypot(back.x - p['x'], back.y + p['y']) > 0.9 for p in people):
                    build_lantern((back.x, back.y, 1.75), m)
                else:
                    point_light(Vector((tx, ty, 1.7)) + side0 * 0.8, 120, '#ff9a4a', radius=0.15, name='torch')
        # A soft key on the faces from the camera's side (cinematic fill).
        key_col = {'dusk': '#ffd6b8', 'dawn': '#ffdcd6', 'day': '#fff4e8', 'night': '#a8b8ff'}[tod]
        if overcast and not indoor:
            key_col = '#c4d0e4'
        off = (cam.location - target)
        off.z = 0
        off.normalize()
        side = Vector((-off.y, off.x, 0))
        key = cam.location + side * 1.5 + Vector((0, 0, 1.4))  # just behind and above the lens
        kd = (key - target).length
        spot = bpy.data.lights.new('key', 'SPOT')
        spot.energy = {'night': 500, 'dusk': 700, 'dawn': 700, 'day': 450}[tod] * (1.0 if indoor else 0.9 if overcast else 0.5) * (kd / 5.0) ** 2
        spot.color = hex_rgba(key_col)[:3]
        spot.spot_size = math.radians(50)
        spot.spot_blend = 0.9
        spot.shadow_soft_size = 0.6
        spot.volume_factor = 0.0
        ko = bpy.data.objects.new('key', spot)
        ko.location = key
        ko.rotation_euler = (target - key).to_track_quat('-Z', 'Y').to_euler()
        scene.collection.objects.link(ko)
        # A rim light from behind the focus group, separating the figures from the background.
        area_light(target - off * 3.0 - side * 1.2 + Vector((0, 0, 2.6)), target + Vector((0, 0, 0.6)),
                   150 if indoor else 80, '#8aa0ff' if tod == 'night' or (overcast and not indoor) else '#ffb070', size=1.5, name='rim')
    else:
        overview_lighting(scene, spec, view, target)

    if view == 'shot':
        precipitation(spec, cam, target)
    if view == 'diorama':
        grid_overlay(cols, rows)
        for p in people:
            token_base(p)

    # Depth of field on the focus point.
    cam_data.dof.use_dof = view == 'shot'
    cam_data.dof.focus_distance = (cam.location - target).length
    cam_data.dof.aperture_fstop = 4.0

    # Render settings.
    if a.engine == 'cycles':
        r.engine = 'CYCLES'
        scene.cycles.samples = 64
        scene.cycles.use_denoising = True
        try:
            scene.cycles.denoiser = 'OPENIMAGEDENOISE'
        except Exception:
            pass
        scene.cycles.max_bounces = 4
        try:  # use a GPU when there is one
            prefs = bpy.context.preferences.addons['cycles'].preferences
            for backend in ('OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'):
                try:
                    prefs.compute_device_type = backend
                    prefs.get_devices()
                except TypeError:
                    continue
                gpus = [d for d in prefs.devices if d.type == backend]
                if gpus:
                    for d in prefs.devices:
                        d.use = d.type == backend
                    scene.cycles.device = 'GPU'
                    break
        except Exception:
            pass
    else:
        for name in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
            try:
                r.engine = name
                break
            except TypeError:
                continue
        ee = scene.eevee
        for attr, val in (('taa_render_samples', 48), ('use_shadows', True), ('use_raytracing', True),
                          ('volumetric_tile_size', '8'), ('volumetric_samples', 48), ('volumetric_end', 60.0 if indoor else 140.0),
                          ('use_volumetric_shadows', True), ('use_fast_gi', True)):
            try:
                setattr(ee, attr, val)
            except (AttributeError, TypeError):
                pass
    try:
        scene.view_settings.view_transform = 'AgX'
        scene.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    if view == 'map':
        try:
            scene.eevee.taa_render_samples = 16
        except AttributeError:
            pass
    else:
        setup_post(scene)

    out = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    r.filepath = out
    r.image_settings.file_format = 'PNG'
    if os.environ.get("SCENE_DEBUG"):
        print(f"built in {time.monotonic() - started:.1f}s, {len(bpy.data.objects)} objects, {len(bpy.data.lights)} lights, {len(bpy.data.materials)} materials", file=sys.stderr)
    bpy.ops.render.render(write_still=True)
    if not os.path.isfile(out):
        raise RuntimeError(f'render produced no file at {out}')
    video = turntable(scene, cam, target, a) if view == 'diorama' and a.turntable else None
    print(json.dumps({'ok': True, 'path': out, 'video': video, 'view': view, 'seconds': round(time.monotonic() - started, 1)}))


def setup_post(scene):
    """Bloom and a gentle vignette in the compositor (skipped if this Blender lacks the API)."""
    try:
        tree = bpy.data.node_groups.new('post', 'CompositorNodeTree')
        tree.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        scene.compositing_node_group = tree
        nodes, links = tree.nodes, tree.links
        rl = nodes.new('CompositorNodeRLayers')
        out = nodes.new('NodeGroupOutput')
        glare = nodes.new('CompositorNodeGlare')
        glare.inputs['Type'].default_value = 'Bloom'
        glare.inputs['Threshold'].default_value = 0.9
        glare.inputs['Strength'].default_value = 0.35
        glare.inputs['Size'].default_value = 0.6
        links.new(rl.outputs['Image'], glare.inputs['Image'])
        last = glare.outputs['Image']
        try:
            mask = nodes.new('CompositorNodeEllipseMask')
            mask.inputs['Size'].default_value = (0.95, 0.95)
            mask.inputs['Value'].default_value = 1.0
            blur = nodes.new('CompositorNodeBlur')
            blur.inputs['Size'].default_value = (220, 220)
            links.new(mask.outputs['Mask'], blur.inputs['Image'])
            mix = nodes.new('ShaderNodeMix')
            mix.data_type = 'RGBA'
            mix.blend_type = 'MULTIPLY'
            mix.inputs[0].default_value = 1.0
            links.new(last, mix.inputs[6])
            ramp = nodes.new('ShaderNodeValToRGB')
            ramp.color_ramp.elements[0].color = (0.45, 0.45, 0.45, 1)
            links.new(blur.outputs['Image'], ramp.inputs[0])
            links.new(ramp.outputs[0], mix.inputs[7])
            last = mix.outputs[2]
        except Exception:
            pass
        links.new(last, out.inputs[0])
        scene.render.use_compositing = True
    except Exception:
        pass


try:
    main()
except Exception as exc:  # reported to the wrapper as one JSON line
    print(json.dumps({'ok': False, 'error': f'{type(exc).__name__}: {exc}'[:600]}))
    sys.exit(1)
