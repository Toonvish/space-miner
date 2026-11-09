"""Player mining ship — low-poly, baked textures (PS2/GameCube-era look).

Run via `bun run models ship`.
Blender coords (Z up): nose +Y, engine -Y. After glTF export: nose -Z, engine +Z.
Game-facing names: material "Body" (baked atlas), "Glass", "EngineGlow", "NavRed",
"NavGreen"; empty "ThrusterMount" at the nozzle exit, "DrillMountL/R" at the barrel tips.
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
PAINT = L.detail_mat("Paint", L.srgb("#9da2a8"), metal=0.15, rough=0.42, panel=1.1, wear=0.5)
WING = L.detail_mat("WingPaint", L.srgb("#9da2a8"), metal=0.15, rough=0.45, panel=1.2,
                    accent=L.srgb("#b8400a"), accent_from_x=0.98)
ACCENT = L.detail_mat("Accent", L.srgb("#b8400a"), metal=0.1, rough=0.5, panel=1.8, grime=0.3)
METAL = L.detail_mat("Metal", L.srgb("#4a4e55"), metal=0.85, rough=0.38, panel=4.0, grime=0.6)
DARK = L.detail_mat("DarkMetal", L.srgb("#24262b"), metal=0.7, rough=0.55, panel=5.0, grime=0.3)

# untextured, exported as-is
GLASS = L.plain_mat("Glass", L.srgb("#0d1a22"), metal=0.0, rough=0.06)
GLOW = L.plain_mat("EngineGlow", L.srgb("#bfefff"), emission=L.srgb("#8fdcff"), strength=6.0)
NAV_R = L.plain_mat("NavRed", L.srgb("#ff2a2a"), emission=L.srgb("#ff2a2a"), strength=5.0)
NAV_G = L.plain_mat("NavGreen", L.srgb("#2aff6a"), emission=L.srgb("#2aff6a"), strength=5.0)

textured = []


def part(obj, mat, smooth=True, angle=35):
    L.set_mat(obj, mat)
    L.shade(obj, smooth, angle)
    textured.append(obj)
    return obj


# ---------------------------------------------------------------- fuselage
PROFILE = [  # cross-section, x/z in -1..1, with chines for a mechanical look
    (1.0, 0.0), (0.8, 0.55), (0.35, 0.95), (-0.35, 0.95), (-0.8, 0.55),
    (-1.0, 0.0), (-0.85, -0.45), (-0.4, -0.7), (0.4, -0.7), (0.85, -0.45),
]
STATIONS = [  # (y, half width, half height, z offset), front -> back
    (1.45, 0.12, 0.08, -0.02),
    (1.0, 0.25, 0.16, 0.0),
    (0.4, 0.38, 0.24, 0.03),
    (-0.3, 0.44, 0.27, 0.04),
    (-0.95, 0.41, 0.26, 0.03),
    (-1.2, 0.35, 0.23, 0.02),
]
hull = L.loft_y("Hull", PROFILE, STATIONS, tip=(0, 1.85, -0.03), parent=root)
part(hull, PAINT, angle=30)

# nose cap in accent colour (slightly larger shell over the tip)
nose = L.loft_y("NoseCap", PROFILE, [(1.47, 0.135, 0.095, -0.02), (1.25, 0.2, 0.135, -0.01)],
                tip=(0, 1.87, -0.03), parent=root)
part(nose, ACCENT, angle=30)

# canopy
canopy = L.ellipsoid("Canopy", (0, 0.58, 0.19), (0.19, 0.42, 0.13), 16, 8, parent=root)
L.set_mat(canopy, GLASS)
L.shade(canopy, True, 80)

# canopy frame: thin ring around the base
frame = L.ellipsoid("CanopyFrame", (0, 0.58, 0.19), (0.205, 0.44, 0.05), 16, 4, parent=root)
part(frame, DARK)

# ---------------------------------------------------------------- wings
WING_PTS = [(0.35, 0.15), (1.22, -0.58), (1.26, -0.86), (0.98, -0.94), (0.35, -0.86)]
for side in (1, -1):
    s = "R" if side > 0 else "L"
    w = L.prism("Wing" + s, [(x * side, y) for x, y in WING_PTS], -0.055, -0.005, parent=root)
    part(L.bevel(w, 0.012), WING, smooth=False)

    # intake on the fuselage side
    intake = L.box("Intake" + s, (0.42 * side, 0.1, -0.02), (0.16, 0.55, 0.15), parent=root)
    part(L.bevel(intake, 0.02), PAINT, angle=40)
    mouth = L.box("IntakeMouth" + s, (0.42 * side, 0.375, -0.02), (0.12, 0.02, 0.11), parent=root)
    part(mouth, DARK, smooth=False)

    # wing-tip pod with a mining-laser barrel
    pod = L.cylinder_y("Pod" + s, 0.07, 0.06, 0.6, -0.66, segments=10, parent=root)
    pod.location = (1.24 * side, 0, -0.03)
    part(L.bevel(pod, 0.01), METAL)
    barrel = L.cylinder_y("Barrel" + s, 0.025, 0.02, 0.28, -0.24, segments=8, parent=root)
    barrel.location = (1.24 * side, 0, -0.03)
    part(barrel, DARK)

    nav = L.ellipsoid("Nav" + s, (1.32 * side, -0.72, -0.03), (0.03, 0.05, 0.03), 8, 4, parent=root)
    L.set_mat(nav, NAV_G if side > 0 else NAV_R)

# ---------------------------------------------------------------- tail fin
fin = L.prism("Fin", [(0.12, -0.5), (0.55, -1.0), (0.56, -1.18), (0.12, -1.16)], -0.018, 0.018,
              parent=root)
fin.rotation_euler.y = math.radians(-90)  # local X -> world Z
part(L.bevel(fin, 0.008), ACCENT, smooth=False)

# ---------------------------------------------------------------- greebles
for i, (x, y, sx, sy) in enumerate([(0.17, -0.45, 0.12, 0.3), (-0.17, -0.45, 0.12, 0.3),
                                     (0.0, 0.02, 0.22, 0.16), (0.2, -0.95, 0.1, 0.14),
                                     (-0.2, -0.95, 0.1, 0.14)]):
    g = L.box(f"Greeble{i}", (x, y, 0.3), (sx, sy, 0.05), parent=root)
    part(L.bevel(g, 0.01), METAL if i < 2 else DARK, angle=40)

# ---------------------------------------------------------------- engine
housing = L.cylinder_y("EngineHousing", 0.29, 0.31, 0.3, -1.33, segments=16, parent=root)
part(L.bevel(housing, 0.015), METAL)
nozzle = L.cylinder_y("Nozzle", 0.3, 0.22, 0.3, -1.63, segments=16, cap=False, parent=root)
part(L.solidify(nozzle, 0.03), DARK)

bm = bmesh.new()
bmesh.ops.create_circle(bm, cap_ends=True, segments=16, radius=0.21)
bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=L.rot_x(90))
bmesh.ops.translate(bm, verts=bm.verts, vec=(0, -1.5, 0))
glow = L.mesh_obj("EngineGlow", bm, parent=root)
L.set_mat(glow, GLOW)

mount = L.link(bpy.data.objects.new("ThrusterMount", None), root)
mount.location = (0, -1.8, 0)

# drill emitters at the tips of the wing-pod barrels
for side, s in ((1, "R"), (-1, "L")):
    dm = L.link(bpy.data.objects.new("DrillMount" + s, None), root)
    dm.location = (1.24 * side, -0.08, -0.03)

# ---------------------------------------------------------------- bake + export
body = L.join(textured, "Body")
body.parent = root
L.unwrap(body)
L.bake_atlas(body, "ship", os.path.join(args["previews"], "tex"), size=1024)
L.export(args)
L.render_previews(args, [
    ("top", (0, -0.1, 10), (0, -0.1, 0), 4.2),
    ("persp", (3.0, -3.2, 2.4), (0, -0.2, 0), None),
    ("front", (-2.6, 3.4, 1.5), (0, 0, 0), None),
])
