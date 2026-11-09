"""Automatic mining drone, deployed by the player next to asteroids.

Run via `bun run models miner`.
Exports root empty "Miner" with the static body and a child empty "Turret" (rotates about
the vertical axis; the barrel points along +X). Empty "MinerEmitter" marks the barrel tip.
Glow materials: "StatusGlow" (recoloured per miner by the game), "MinerBeamGlow".
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _lib as L  # noqa: E402
import bmesh  # noqa: E402
import bpy  # noqa: E402

args = L.parse_args("miner")
L.reset_scene()


def mats():
    return {
        "paint": L.detail_mat("Paint", L.srgb("#a3a7ad"), 0.15, 0.45, panel=2.2, wear=0.5),
        "accent": L.detail_mat("Accent", L.srgb("#c9a227"), 0.1, 0.5, panel=3.0, grime=0.4),
        "metal": L.detail_mat("Metal", L.srgb("#4a4e55"), 0.85, 0.38, panel=4.0, grime=0.5),
        "dark": L.detail_mat("Dark", L.srgb("#24262b"), 0.7, 0.55, panel=5.0, grime=0.3),
        "solar": L.detail_mat("Solar", L.srgb("#1b2f55"), 0.4, 0.25, panel=9.0, grime=0.15),
    }


STATUS = L.plain_mat("StatusGlow", L.srgb("#80ff9a"), emission=L.srgb("#40ff70"), strength=4.0)
BEAM = L.plain_mat("MinerBeamGlow", L.srgb("#fff0a0"), emission=L.srgb("#ffd23a"), strength=5.0)


def cyl_z(name, r1, r2, depth, center, segments=12, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segments,
                          radius1=r1, radius2=r2, depth=depth)
    bmesh.ops.translate(bm, verts=bm.verts, vec=center)
    return L.mesh_obj(name, bm)


def cyl_x(name, r, length, x0, z, segments=10):
    o = L.cylinder_y(name, r, r, length, 0, segments=segments)
    o.rotation_euler.z = -math.pi / 2
    o.location = (x0 + length / 2, 0, z)
    return o


root = L.link(bpy.data.objects.new("Miner", None))
turret = L.link(bpy.data.objects.new("Turret", None), root)

# ---------------------------------------------------------------- body
M = mats()
body_parts = []


def add(lst, obj, m, parent, smooth=True, angle=35):
    obj.parent = parent
    L.set_mat(obj, m)
    L.shade(obj, smooth, angle)
    lst.append(obj)
    return obj


add(body_parts, L.bevel(cyl_z("Hull", 0.9, 0.78, 0.45, (0, 0, 0), 8), 0.04), M["paint"], root, angle=40)
add(body_parts, cyl_z("Deck", 0.6, 0.55, 0.12, (0, 0, 0.28), 16), M["dark"], root)
add(body_parts, cyl_z("Spike", 0.35, 0.02, 0.9, (0, 0, -0.65), 8), M["metal"], root)
for k, a_deg in enumerate((90, 210, 330)):
    a = math.radians(a_deg)
    strut = L.obox("Strut", (math.cos(a) * 1.05, math.sin(a) * 1.05, 0.05), (0.6, 0.08, 0.08), (0, 0, a))
    add(body_parts, strut, M["metal"], root, False)
    panel = L.obox("Solar", (math.cos(a) * 1.6, math.sin(a) * 1.6, 0.06), (0.75, 0.62, 0.035), (0, 0, a))
    add(body_parts, panel, M["solar"], root, False)
for a_deg in (30, 150):
    a = math.radians(a_deg)
    hop = L.obox("Hopper", (math.cos(a) * 0.7, math.sin(a) * 0.7, 0.18), (0.38, 0.32, 0.3), (0, 0, a))
    add(body_parts, L.bevel(hop, 0.03), M["accent"], root, angle=40)
status = L.ellipsoid("Status", (0, -0.62, 0.3), (0.07, 0.07, 0.07), 8, 4)
status.parent = root
L.set_mat(status, STATUS)

body = L.join(body_parts, "MinerHull")
body.parent = root
L.unwrap(body)
L.bake_atlas(body, "miner_body", os.path.join(args["previews"], "tex"), size=512, mat_name="MinerBody")

# ---------------------------------------------------------------- turret (separate mesh so it can rotate)
M = mats()
tur_parts = []
add(tur_parts, cyl_z("TurretBase", 0.28, 0.24, 0.22, (0, 0, 0.44), 12), M["paint"], turret)
add(tur_parts, L.box("TurretHead", (0.12, 0, 0.6), (0.42, 0.26, 0.2)), M["accent"], turret, angle=40)
add(tur_parts, cyl_x("Barrel", 0.06, 0.62, 0.3, 0.6), M["dark"], turret)
add(tur_parts, cyl_x("Coil", 0.09, 0.14, 0.55, 0.6), M["metal"], turret)
tip = L.ellipsoid("Tip", (0.95, 0, 0.6), (0.06, 0.06, 0.06), 8, 4)
tip.parent = turret
L.set_mat(tip, BEAM)
tb = L.join(tur_parts, "TurretMesh")
tb.parent = turret
L.unwrap(tb)
L.bake_atlas(tb, "miner_turret", os.path.join(args["previews"], "tex"), size=512, mat_name="TurretBody")

emitter = L.link(bpy.data.objects.new("MinerEmitter", None), turret)
emitter.location = (1.0, 0, 0.6)

L.export(args)
L.render_previews(args, [
    ("top", (0, 0, 8), (0, 0, 0), 4.6),
    ("persp", (3.2, -3.6, 2.8), (0, 0, 0), None),
])
