"""Player ship — MK-II ore hauler "Kestrel". Industrial, low-poly, baked textures.

Run via `bun run models ship`.
Blender coords (Z up): nose +Y, engines -Y. After glTF export: nose -Z, engines +Z.
Game-facing names: material "Body" (baked atlas), "Glass", "EngineGlow", "NavRed", "NavGreen";
empties "ThrusterMount" (main engine), "ThrusterMountL"/"ThrusterMountR" (pod engines),
"DrillMountL"/"DrillMountR" (mining laser muzzles).
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _lib as L  # noqa: E402
import bmesh  # noqa: E402
import bpy  # noqa: E402

args = L.parse_args("ship")
L.reset_scene()
root = L.link(bpy.data.objects.new("Ship", None))

# ---------------------------------------------------------------- bake-source materials
HULL = L.detail_mat("Hull", L.srgb("#c3c5c3"), metal=0.2, rough=0.45, panel=1.6, wear=0.6)
FRAME = L.detail_mat("Frame", L.srgb("#34373c"), metal=0.75, rough=0.42, panel=3.5, grime=0.5)
ACCENT = L.detail_mat("Accent", L.srgb("#e09a08"), metal=0.15, rough=0.5, panel=2.2, grime=0.25)
HAZARD = L.hazard_mat("Hazard", scale=7.0)
DARK = L.detail_mat("Dark", L.srgb("#1d1f23"), metal=0.6, rough=0.6, panel=6.0, grime=0.25)

GLASS = L.plain_mat("Glass", L.srgb("#0d1a22"), metal=0.0, rough=0.06)
GLOW = L.plain_mat("EngineGlow", L.srgb("#bfefff"), emission=L.srgb("#8fdcff"), strength=6.0)
NAV_R = L.plain_mat("NavRed", L.srgb("#ff2a2a"), emission=L.srgb("#ff2a2a"), strength=5.0)
NAV_G = L.plain_mat("NavGreen", L.srgb("#2aff6a"), emission=L.srgb("#2aff6a"), strength=5.0)

textured = []


def part(obj, mat, smooth=True, angle=35):
    obj.parent = root
    L.set_mat(obj, mat)
    L.shade(obj, smooth, angle)
    textured.append(obj)
    return obj


def plain(obj, mat):
    obj.parent = root
    L.set_mat(obj, mat)
    return obj


def cyl_z(name, r1, r2, depth, center, segments=12, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segments,
                          radius1=r1, radius2=r2, depth=depth)
    bmesh.ops.translate(bm, verts=bm.verts, vec=center)
    return L.mesh_obj(name, bm)


def nozzle(name, r_back, r_front, depth, y_center, x=0.0, z=0.0):
    housing = L.cylinder_y(name + "Housing", r_front * 1.1, r_front * 1.15, depth * 0.8, y_center + depth * 0.75, 12)
    housing.location = (x, 0, z)
    part(L.bevel(housing, 0.015), FRAME)
    bell = L.cylinder_y(name + "Bell", r_back, r_front, depth, y_center, 12, cap=False)
    bell.location = (x, 0, z)
    part(L.solidify(bell, 0.025), DARK)
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, segments=12, radius=r_front * 0.95)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=L.rot_x(90))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y_center + depth * 0.35, z))
    plain(L.mesh_obj(name + "Glow", bm), GLOW)


# ---------------------------------------------------------------- spine
PROFILE = [(1.0, -0.1), (0.85, 0.55), (0.45, 0.85), (-0.45, 0.85), (-0.85, 0.55),
           (-1.0, -0.1), (-0.8, -0.6), (-0.35, -0.8), (0.35, -0.8), (0.8, -0.6)]
spine = L.loft_y("Spine", PROFILE, [
    (1.25, 0.26, 0.2, 0.0), (0.7, 0.36, 0.26, 0.02), (-0.4, 0.4, 0.28, 0.02),
    (-1.15, 0.38, 0.27, 0.01), (-1.45, 0.32, 0.24, 0.0),
])
part(spine, HULL, angle=30)
# armoured nose wedge
part(L.loft_y("Nose", PROFILE, [(1.75, 0.08, 0.06, -0.03), (1.25, 0.27, 0.21, 0.0)],
              tip=(0, 1.85, -0.04)), FRAME, angle=30)

# bridge: boxy raised cockpit block with a slanted window strip
bridge = L.obox("Bridge", (0, 0.92, 0.3), (0.5, 0.62, 0.22))
part(L.bevel(bridge, 0.04), HULL, angle=40)
win = L.obox("Window", (0, 1.2, 0.33), (0.4, 0.08, 0.12), (math.radians(-35), 0, 0))
plain(win, GLASS)
for sx in (-1, 1):
    plain(L.obox("SideWindow", (0.252 * sx, 0.98, 0.33), (0.02, 0.3, 0.07)), GLASS)
part(L.obox("BridgeBand", (0, 0.66, 0.3), (0.52, 0.08, 0.24)), HAZARD, False)

# dorsal ore hatches + sensor mast
for i, y in enumerate((0.2, -0.35)):
    part(L.bevel(L.obox(f"Hatch{i}", (0, y, 0.3), (0.46, 0.42, 0.06)), 0.02), ACCENT, angle=40)
    part(L.obox(f"HatchSeam{i}", (0, y, 0.335), (0.02, 0.4, 0.01)), DARK, False)
part(cyl_z("Mast", 0.03, 0.02, 0.5, (-0.18, -0.85, 0.5), 6), FRAME)
part(cyl_z("Dish", 0.13, 0.05, 0.05, (-0.18, -0.85, 0.75), 12), HULL)

# ---------------------------------------------------------------- outrigger ore pods
POD_X = 1.05
for side, s in ((1, "R"), (-1, "L")):
    x = POD_X * side
    pod = L.obox("Pod" + s, (x, -0.2, 0.0), (0.5, 2.1, 0.42))
    part(L.bevel(pod, 0.06, 2), HULL, angle=40)
    part(L.obox("PodTop" + s, (x, -0.35, 0.215), (0.38, 1.3, 0.03)), FRAME, False)
    part(L.obox("PodStripe" + s, (x, 0.6, 0.0), (0.52, 0.18, 0.44)), HAZARD, False)
    part(L.obox("PodKeel" + s, (x, -0.2, -0.23), (0.3, 1.9, 0.06)), DARK, False)
    # truss beams to the spine
    for j, y in enumerate((0.45, -0.75)):
        beam = L.obox(f"Beam{s}{j}", (x * 0.6, y, 0.02), (POD_X * 0.75, 0.16, 0.12))
        part(beam, FRAME, False)
        brace = L.obox(f"Brace{s}{j}", (x * 0.6, y, 0.02), (POD_X * 0.7, 0.05, 0.05), (0, 0, side * 0.6))
        part(brace, DARK, False)
    # radiator fin
    fin = L.obox("Radiator" + s, (x + side * 0.42, -0.55, 0.0), (0.36, 0.9, 0.025))
    part(fin, FRAME, False)
    for k in range(4):
        part(L.obox(f"FinRib{s}{k}", (x + side * 0.42, -0.9 + k * 0.23, 0.02), (0.34, 0.04, 0.02)), ACCENT, False)
    # mining laser turret on the pod nose
    part(cyl_z("TurretBase" + s, 0.17, 0.15, 0.12, (x, 0.95, 0.24), 10), FRAME)
    head = L.obox("TurretHead" + s, (x, 1.0, 0.34), (0.2, 0.3, 0.12))
    part(L.bevel(head, 0.02), ACCENT, angle=40)
    barrel = L.cylinder_y("Barrel" + s, 0.035, 0.03, 0.42, 1.3, 8)
    barrel.location = (x, 0, 0.34)
    part(barrel, DARK)
    # pod engine
    nozzle("PodEngine" + s, 0.15, 0.11, 0.2, -1.42, x=x, z=0.0)
    # nav light on the outer front corner
    nav = L.ellipsoid("Nav" + s, (x + side * 0.27, 0.75, 0.05), (0.035, 0.05, 0.035), 8, 4)
    plain(nav, NAV_G if side > 0 else NAV_R)

# ---------------------------------------------------------------- main engine
nozzle("Main", 0.27, 0.2, 0.3, -1.62)
part(L.obox("EngineCollar", (0, -1.36, 0.0), (0.62, 0.12, 0.36)), HAZARD, False)

# ---------------------------------------------------------------- mounts
for name, loc in [("ThrusterMount", (0, -1.8, 0)),
                  ("ThrusterMountL", (-POD_X, -1.55, 0)), ("ThrusterMountR", (POD_X, -1.55, 0)),
                  ("DrillMountL", (-POD_X, 1.52, 0.34)), ("DrillMountR", (POD_X, 1.52, 0.34))]:
    e = L.link(bpy.data.objects.new(name, None), root)
    e.location = loc

# ---------------------------------------------------------------- bake + export
body = L.join(textured, "Body")
body.parent = root
L.unwrap(body)
L.bake_atlas(body, "ship", os.path.join(args["previews"], "tex"), size=1024)
L.export(args)
L.render_previews(args, [
    ("top", (0, 0, 10), (0, 0, 0), 4.6),
    ("persp", (3.4, -3.4, 2.6), (0, -0.1, 0), None),
    ("front", (-2.8, 3.6, 1.7), (0, 0.1, 0), None),
])
