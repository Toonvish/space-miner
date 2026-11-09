"""Home station: a core hub plus one repeatable piece per module type.

Run via `bun run models station`.
Exports root empties "Core", "CargoModule", "DrillModule", "FuelModule", "TractorModule", "RangeModule",
all at the origin. Each module piece = truss + pod, built along +X from x=0 to x=MODULE_LEN,
so the game can chain pieces outward along an arm. Each part has its own baked atlas
("<Part>Body" material). Emissive materials end in "Glow" (rendered unlit in the game).
Blender Z is up (towards the camera); the game places the station below the flight plane.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _lib as L  # noqa: E402
import bmesh  # noqa: E402
import bpy  # noqa: E402

args = L.parse_args("station")
L.reset_scene()

MODULE_LEN = 3.6
TRUSS_LEN = 1.4
POD_X = 2.5

# ---------------------------------------------------------------- materials
def paint():
    return L.detail_mat("Paint", L.srgb("#a3a7ad"), metal=0.15, rough=0.45, panel=0.9, wear=0.4)


MATS = {}


def mat(key):
    """Bake-source materials are created per part (they are consumed by the bake)."""
    if key not in MATS:
        MATS[key] = {
            "paint": lambda: L.detail_mat("Paint", L.srgb("#a3a7ad"), 0.15, 0.45, panel=0.9, wear=0.4),
            "white": lambda: L.detail_mat("White", L.srgb("#c9ccd0"), 0.1, 0.4, panel=0.7, grime=0.3),
            "accent": lambda: L.detail_mat("Accent", L.srgb("#b8400a"), 0.1, 0.5, panel=1.4, grime=0.3),
            "blue": lambda: L.detail_mat("Blue", L.srgb("#2c5478"), 0.15, 0.5, panel=3.0, grime=0.35),
            "olive": lambda: L.detail_mat("Olive", L.srgb("#5c5a33"), 0.1, 0.55, panel=3.0, grime=0.4),
            "metal": lambda: L.detail_mat("Metal", L.srgb("#4a4e55"), 0.85, 0.38, panel=2.5, grime=0.5),
            "dark": lambda: L.detail_mat("Dark", L.srgb("#24262b"), 0.7, 0.55, panel=3.0, grime=0.3),
        }[key]()
    return MATS[key]


GLOW = {
    "window": L.plain_mat("WindowGlow", L.srgb("#ffd9a0"), emission=L.srgb("#ffc070"), strength=3.0),
    "pad": L.plain_mat("PadGlow", L.srgb("#9ff0ff"), emission=L.srgb("#5fe0ff"), strength=4.0),
    "drill": L.plain_mat("DrillGlow", L.srgb("#ffb070"), emission=L.srgb("#ff6a1a"), strength=5.0),
    "tractor": L.plain_mat("TractorGlow", L.srgb("#a0fff0"), emission=L.srgb("#3fffd8"), strength=4.0),
    "beacon": L.plain_mat("BeaconGlow", L.srgb("#ff4040"), emission=L.srgb("#ff2020"), strength=5.0),
    "optics": L.plain_mat("OpticsGlow", L.srgb("#fff0d0"), emission=L.srgb("#ffd8a0"), strength=5.0),
}


# ---------------------------------------------------------------- part builder
class Part:
    def __init__(self, name, offset_x):
        self.name = name
        self.root = L.link(bpy.data.objects.new(name, None))
        self.root.location = (offset_x, 0, 0)  # spread out while baking (no shared AO)
        self.textured = []

    def add(self, obj, key, smooth=True, angle=35):
        obj.parent = self.root
        L.set_mat(obj, mat(key))
        L.shade(obj, smooth, angle)
        self.textured.append(obj)
        return obj

    def glow(self, obj, key):
        obj.parent = self.root
        L.set_mat(obj, GLOW[key])
        return obj

    def finish(self, tex_dir, size):
        body = L.join(self.textured, self.name + "Body")
        body.parent = self.root
        L.unwrap(body)
        L.bake_atlas(body, f"station_{self.name}", tex_dir, size=size, mat_name=self.name + "Body")
        MATS.clear()  # bake consumed these materials
        return body


def cyl_z(name, r1, r2, depth, center, segments=16, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segments,
                          radius1=r1, radius2=r2, depth=depth)
    bmesh.ops.translate(bm, verts=bm.verts, vec=center)
    return L.mesh_obj(name, bm)


def cyl_x(name, r, length, x0, y=0.0, z=0.0, segments=10):
    o = L.cylinder_y(name, r, r, length, 0, segments=segments)
    o.rotation_euler.z = -math.pi / 2  # +Y -> +X
    o.location = (x0 + length / 2, y, z)
    return o


def torus(name, major, minor, center, seg=32, minor_seg=8):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor,
                                     major_segments=seg, minor_segments=minor_seg, location=center)
    o = bpy.context.active_object
    o.name = name
    return o


def truss(part, x0, x1, half=0.32, rod=0.07):
    """Square lattice truss along X with frames, plus a central pipe."""
    length = x1 - x0
    for sy in (-1, 1):
        for sz in (-1, 1):
            part.add(L.box("Rod", (x0 + length / 2, sy * half, sz * half), (length, rod, rod)), "metal", False)
    n = max(2, round(length / 0.7))
    for i in range(n + 1):
        x = x0 + length * i / n
        for sy in (-1, 1):
            part.add(L.box("FrameZ", (x, sy * half, 0), (rod, rod, half * 2)), "metal", False)
        for sz in (-1, 1):
            part.add(L.box("FrameY", (x, 0, sz * half), (rod, half * 2, rod)), "metal", False)
    part.add(cyl_x("Pipe", 0.09, length, x0), "accent")


# ---------------------------------------------------------------- core hub
def build_core(p):
    p.add(L.bevel(cyl_z("Hull", 3.0, 2.8, 1.2, (0, 0, 0), 24), 0.05), "paint", angle=40)
    p.add(L.bevel(cyl_z("Deck", 2.3, 2.1, 0.5, (0, 0, 0.85), 24), 0.04), "white", angle=40)
    p.add(cyl_z("PadRim", 1.75, 1.75, 0.06, (0, 0, 1.11), 32), "accent")
    p.add(cyl_z("Pad", 1.6, 1.6, 0.06, (0, 0, 1.14), 32), "dark")
    p.add(cyl_z("Belly", 2.4, 1.2, 0.7, (0, 0, -0.95), 16), "metal")
    # docking ring + spokes
    p.add(torus("Ring", 3.9, 0.22, (0, 0, 0), 40, 8), "metal")
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        s = L.obox("Spoke", (math.cos(a) * 3.4, math.sin(a) * 3.4, 0), (1.1, 0.3, 0.25), (0, 0, a))
        p.add(s, "metal", False)
    # arm sockets (cargo +X, drill +Y, fuel -X, tractor -Y)
    for k in range(4):
        a = k * math.pi / 2
        s = L.obox("Socket", (math.cos(a) * 3.45, math.sin(a) * 3.45, 0), (0.9, 0.9, 0.9), (0, 0, a))
        p.add(L.bevel(s, 0.05), "dark", angle=40)
    # greebles on the deck
    for k in range(6):
        a = k * math.tau / 6 + 0.3
        g = L.obox("Greeble", (math.cos(a) * 1.95, math.sin(a) * 1.95, 1.15), (0.35, 0.22, 0.12), (0, 0, a))
        p.add(L.bevel(g, 0.02), "metal", False)
    # antenna mast
    p.add(cyl_z("Mast", 0.06, 0.04, 1.4, (1.5, -1.5, 1.6), 8), "metal")
    p.glow(L.ellipsoid("Beacon", (1.5, -1.5, 2.35), (0.09, 0.09, 0.09), 8, 4), "beacon")
    # windows around the hull and pad lights
    for k in range(20):
        a = k * math.tau / 20
        w = L.obox("Window", (math.cos(a) * 2.93, math.sin(a) * 2.93, 0.15), (0.06, 0.32, 0.14), (0, 0, a))
        p.glow(w, "window")
    for k in range(12):
        a = k * math.tau / 12
        p.glow(L.box("PadLight", (math.cos(a) * 1.68, math.sin(a) * 1.68, 1.16), (0.1, 0.1, 0.04)), "pad")


# ---------------------------------------------------------------- module pieces
def build_cargo(p):
    truss(p, 0, TRUSS_LEN)
    p.add(L.box("Base", (POD_X, 0, -0.55), (2.2, 2.2, 0.14)), "dark", False)
    for i, (dx, dy, key) in enumerate([(-0.52, -0.52, "accent"), (0.52, -0.52, "blue"),
                                       (-0.52, 0.52, "olive"), (0.52, 0.52, "accent")]):
        p.add(L.bevel(L.box(f"Container{i}", (POD_X + dx, dy, -0.02), (0.98, 0.98, 0.92)), 0.03), key, angle=40)
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(L.box("Post", (POD_X + sx * 1.05, sy * 1.05, 0.0), (0.1, 0.1, 1.2)), "metal", False)


def build_drill(p):
    truss(p, 0, TRUSS_LEN)
    p.add(L.bevel(cyl_z("Lab", 1.05, 0.95, 0.9, (POD_X, 0, 0), 8), 0.04), "white", angle=40)
    p.add(cyl_z("Tower", 0.38, 0.32, 0.7, (POD_X, 0, 0.8), 12), "metal")
    p.add(cyl_z("Emitter", 0.32, 0.12, 0.35, (POD_X, 0, 1.32), 12), "dark")
    p.glow(L.ellipsoid("Lens", (POD_X, 0, 1.52), (0.12, 0.12, 0.1), 10, 6), "drill")
    for sy in (-1, 1):
        p.add(L.box("Radiator", (POD_X, sy * 1.25, 0.1), (1.5, 0.05, 0.75)), "dark", False)
        p.glow(L.box("LabWindow", (POD_X, sy * 0.99, 0.15), (0.6, 0.04, 0.12)), "drill")


def build_fuel(p):
    truss(p, 0, TRUSS_LEN)
    p.add(L.box("Spine", (POD_X, 0, -0.1), (0.5, 2.6, 0.35)), "metal", False)
    for sy in (-1, 1):
        p.add(L.ellipsoid("Tank", (POD_X, sy * 0.95, 0.1), (0.85, 0.85, 0.85), 20, 10), "white")
        p.add(cyl_z("Band", 0.875, 0.875, 0.16, (POD_X, sy * 0.95, 0.1), 20), "accent")
        p.add(cyl_z("Valve", 0.12, 0.1, 0.25, (POD_X, sy * 0.95, 1.0), 8), "metal")


def build_tractor(p):
    truss(p, 0, TRUSS_LEN)
    p.add(L.bevel(cyl_z("Base", 0.95, 0.85, 0.55, (POD_X, 0, -0.1), 6), 0.04), "paint", angle=40)
    p.add(torus("Emitter", 1.05, 0.12, (POD_X, 0, 0.45), 32, 8), "metal")
    p.glow(torus("Field", 0.88, 0.05, (POD_X, 0, 0.47), 32, 6), "tractor")
    p.add(cyl_z("Mast", 0.08, 0.05, 1.0, (POD_X, 0, 0.7), 8), "metal")
    dish = L.ellipsoid("Dish", (POD_X, 0, 1.25), (0.5, 0.5, 0.15), 16, 6)
    p.add(dish, "white")
    p.glow(L.ellipsoid("Feed", (POD_X, 0, 1.42), (0.07, 0.07, 0.07), 8, 4), "tractor")


def build_range(p):
    """Beam optics: a ring of angled focusing mirrors around a bright collimator."""
    truss(p, 0, TRUSS_LEN)
    p.add(L.bevel(cyl_z("Base", 1.0, 0.9, 0.4, (POD_X, 0, -0.2), 8), 0.04), "paint", angle=40)
    p.add(cyl_z("Collimator", 0.22, 0.16, 1.0, (POD_X, 0, 0.45), 12), "metal")
    p.glow(L.ellipsoid("Focus", (POD_X, 0, 1.0), (0.13, 0.13, 0.13), 10, 6), "optics")
    for k in range(6):
        a = k * math.tau / 6
        m = L.obox("Mirror", (POD_X + math.cos(a) * 0.72, math.sin(a) * 0.72, 0.35), (0.06, 0.5, 0.42),
                   (0, math.radians(-25), a))  # tilted towards the focus
        p.add(m, "white", False)
    p.add(torus("MirrorRing", 0.78, 0.05, (POD_X, 0, 0.08), 24, 6), "accent")


# ---------------------------------------------------------------- build, bake, export
tex_dir = os.path.join(args["previews"], "tex")
parts = []
for i, (name, fn, size) in enumerate([
    ("Core", build_core, 1024),
    ("CargoModule", build_cargo, 512),
    ("DrillModule", build_drill, 512),
    ("FuelModule", build_fuel, 512),
    ("TractorModule", build_tractor, 512),
    ("RangeModule", build_range, 512),
]):
    p = Part(name, i * 14.0)
    fn(p)
    p.finish(tex_dir, size)
    parts.append(p)

for p in parts:
    p.root.location = (0, 0, 0)
L.export(args)

# preview: a station with a few levels on each arm
import copy  # noqa: E402,F401

def place_copy(src_root, loc, rot_z):
    new_root = bpy.data.objects.new(src_root.name + "_prev", None)
    L.link(new_root)
    new_root.location = loc
    new_root.rotation_euler.z = rot_z
    for c in src_root.children:
        o = c.copy()
        L.link(o)
        o.parent = new_root
    return new_root

levels = {"CargoModule": (0, 3), "DrillModule": (math.pi / 2, 2), "FuelModule": (math.pi, 1),
          "TractorModule": (-math.pi / 2, 2), "RangeModule": (math.pi / 4, 2)}
for p in parts[1:]:
    rot, n = levels[p.name]
    for k in range(n):
        r = 3.9 + k * MODULE_LEN
        place_copy(p.root, (math.cos(rot) * r, math.sin(rot) * r, 0), rot)
    p.root.location = (0, 0, -100)  # hide originals below the preview
L.render_previews(args, [
    ("top", (0, 0, 40), (0, 0, 0), 32.0),
    ("persp", (14, -16, 14), (0, 0, 0), None),
])
