"""Player ship — "Kestrel" heavy mining frigate. Dark, layered hard-surface armour.

Run via `bun run models ship`.
Blender coords (Z up): nose +Y, engines -Y. After glTF export: nose -Z, engines +Z.
Game-facing names: material "Body" (baked atlas), "Accent" (near-white trim, tinted per pilot), "Glass", "EngineGlow", "NavRed", "NavGreen",
other "*Glow" materials (running lights); empties "ThrusterMount" (centre engine pair),
"ThrusterMountL"/"ThrusterMountR" (sponson engine pairs), "DrillMountL"/"DrillMountR".
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
# dark gunmetal with bright worn edges so the faceted shapes read against space
HULL = L.detail_mat("Hull", L.srgb("#24211f"), metal=0.25, rough=0.62, panel=1.2, grime=0.35, wear=0.3)
PLATE = L.detail_mat("Plate", L.srgb("#141316"), metal=0.3, rough=0.55, panel=1.7, grime=0.3, wear=0.35)
# near-white so the game can tint it with each pilot's colour (material "Accent")
TRIM = L.detail_mat("Trim", L.srgb("#e6e6e6"), metal=0.3, rough=0.35, panel=4.0, grime=0.25)
DARK = L.detail_mat("Dark", L.srgb("#151517"), metal=0.6, rough=0.55, panel=6.0, grime=0.2)
VENT = L.detail_mat("Vent", L.srgb("#45413d"), metal=0.7, rough=0.4, panel=9.0, grime=0.5)

GLASS = L.plain_mat("Glass", L.srgb("#0c1820"), metal=0.0, rough=0.05)
GLOW = L.plain_mat("EngineGlow", L.srgb("#cfefff"), emission=L.srgb("#8fd0ff"), strength=7.0)
NAV_R = L.plain_mat("NavRed", L.srgb("#ff3020"), emission=L.srgb("#ff3020"), strength=5.0)
NAV_G = L.plain_mat("NavGreen", L.srgb("#30ff70"), emission=L.srgb("#30ff70"), strength=5.0)
LASER = L.plain_mat("LaserGlow", L.srgb("#ffd0a0"), emission=L.srgb("#ff7a2a"), strength=6.0)
AMBER = L.plain_mat("RunGlow", L.srgb("#ffb050"), emission=L.srgb("#ff9a30"), strength=5.0)

textured = []
accent = []  # baked separately into the tintable "Accent" material


def part(obj, mat, smooth=True, angle=25):
    obj.parent = root
    L.set_mat(obj, mat)
    L.shade(obj, smooth, angle)
    (accent if mat is TRIM else textured).append(obj)
    return obj


def plain(obj, mat):
    obj.parent = root
    L.set_mat(obj, mat)
    return obj


def plate(name, pts, z0, z1, mat, bevel=0.012, mirror=False):
    """Faceted armour plate from a top-down outline. `mirror` adds the -X twin."""
    sides = ((1, ""), (-1, "L")) if mirror else ((1, ""),)
    out = []
    for sx, suffix in sides:
        o = L.prism(name + suffix, [(x * sx, y) for x, y in pts], z0, z1)
        out.append(part(L.bevel(o, bevel), mat, smooth=False))
    return out


def cyl_z(name, r1, r2, depth, center, segments=10):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments,
                          radius1=r1, radius2=r2, depth=depth)
    bmesh.ops.translate(bm, verts=bm.verts, vec=center)
    return L.mesh_obj(name, bm)


def nozzle(name, r, y, x, z=0.0):
    """Recessed engine bell with a glowing core, facing -Y."""
    housing = L.cylinder_y(name + "Housing", r * 1.3, r * 1.25, 0.22, y + 0.16, 8)
    housing.location = (x, 0, z)
    part(L.bevel(housing, 0.012), PLATE, smooth=False)
    bell = L.cylinder_y(name + "Bell", r * 1.15, r * 0.9, 0.16, y, 12, cap=False)
    bell.location = (x, 0, z)
    part(L.solidify(bell, 0.02), DARK)
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, segments=12, radius=r * 0.88)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=L.rot_x(90))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y + 0.05, z))
    plain(L.mesh_obj(name + "Glow", bm), GLOW)


def spike(name, base, length, yaw_deg, pitch_deg, r=0.018):
    """Thin antenna spike swept backwards."""
    o = L.cylinder_y(name, r, r * 0.4, length, -length / 2, 6)
    o.location = base
    o.rotation_euler = (math.radians(pitch_deg), 0, math.radians(yaw_deg))
    part(o, PLATE)
    return o


def cannon(name, x, y_back, y_front, z, s=1.0, pylon_to=None):
    """Mining laser cannon pointing +Y: receiver block, heat-sink fins, barrel with
    focusing coils (accent colour), muzzle shroud and a glowing lens.
    `pylon_to` = z of the surface above/below to attach a pylon strut to.
    Returns the muzzle position (for the DrillMount empty)."""
    length = y_front - y_back
    rec_len = 0.38 * s
    part(L.bevel(L.obox(name + "Receiver", (x, y_back + rec_len / 2, z), (0.17 * s, rec_len, 0.14 * s)), 0.015),
         PLATE, smooth=False)
    part(L.obox(name + "Cap", (x, y_back + rec_len * 0.45, z + 0.075 * s), (0.11 * s, rec_len * 0.7, 0.02 * s)),
         VENT, smooth=False)
    for k in range(3):  # heat-sink fins on the outside of the receiver
        fy = y_back + 0.08 * s + k * 0.1 * s
        for sx in (-1, 1):
            part(L.obox(f"{name}Fin{k}{sx}", (x + sx * 0.1 * s, fy, z), (0.035 * s, 0.03 * s, 0.11 * s)), DARK, smooth=False)
    b0 = y_back + rec_len
    b1 = y_front - 0.1 * s
    barrel = L.cylinder_y(name + "Barrel", 0.032 * s, 0.032 * s, b1 - b0, (b0 + b1) / 2, 8)
    barrel.location = (x, 0, z)
    part(barrel, DARK)
    for k in range(3):
        cy = b0 + (k + 0.6) * (b1 - b0) / 3.4
        coil = L.cylinder_y(f"{name}Coil{k}", 0.058 * s, 0.058 * s, 0.045 * s, cy, 10)
        coil.location = (x, 0, z)
        part(coil, TRIM)
    muzzle = L.cylinder_y(name + "Muzzle", 0.045 * s, 0.06 * s, 0.11 * s, y_front - 0.055 * s, 10)
    muzzle.location = (x, 0, z)
    part(muzzle, PLATE)
    plain(L.ellipsoid(name + "Lens", (x, y_front + 0.002, z), (0.035 * s, 0.02 * s, 0.035 * s), 8, 4), LASER)
    if pylon_to is not None:
        h = abs(pylon_to - z)
        part(L.obox(name + "Pylon", (x, y_back + rec_len * 0.5, (z + pylon_to) / 2), (0.05 * s, rec_len * 0.8, h)),
             PLATE, smooth=False)
    return (x, y_front + 0.06, z)


# ---------------------------------------------------------------- core hull (wide, low, sharp chines)
PROFILE = [(1.0, 0.0), (0.7, 0.75), (-0.7, 0.75), (-1.0, 0.0), (-0.75, -0.55), (0.75, -0.55)]
part(L.loft_y("Hull", PROFILE, [
    (1.3, 0.2, 0.1, 0.0), (0.6, 0.42, 0.2, 0.0), (-0.4, 0.58, 0.26, 0.0),
    (-1.5, 0.62, 0.28, 0.0), (-1.9, 0.56, 0.24, 0.0),
], tip=(0, 2.05, -0.02)), HULL, smooth=False)

# layered dorsal armour, stepping up towards the stern
plate("DeckFront", [(0, 1.75), (0.3, 1.05), (0.4, 0.25), (-0.4, 0.25), (-0.3, 1.05)], 0.1, 0.19, PLATE)
plate("DeckMid", [(0.32, 0.55), (0.55, -0.35), (0.52, -1.35), (-0.52, -1.35), (-0.55, -0.35), (-0.32, 0.55)],
      0.17, 0.32, HULL)
plate("Crest", [(0.14, 0.3), (0.24, -0.95), (0.1, -1.25), (-0.1, -1.25), (-0.24, -0.95), (-0.14, 0.3)],
      0.31, 0.43, PLATE)
plate("CrestTrim", [(0.05, 0.15), (0.09, -1.0), (-0.09, -1.0), (-0.05, 0.15)], 0.43, 0.46, TRIM, 0.005)
plate("SternDeck", [(0.6, -1.3), (0.62, -1.85), (-0.62, -1.85), (-0.6, -1.3)], 0.12, 0.26, PLATE)
plate("ShoulderPlate", [(0.4, 0.2), (0.62, -0.25), (0.66, -1.1), (0.5, -0.9), (0.45, -0.2)], 0.25, 0.36, PLATE,
      mirror=True)

# cockpit: angled armoured block with a narrow window slit
plate("Cockpit", [(0, 1.45), (0.18, 1.05), (0.2, 0.6), (-0.2, 0.6), (-0.18, 1.05)], 0.19, 0.3, HULL)
win = L.obox("Window", (0, 1.12, 0.29), (0.22, 0.24, 0.03), (math.radians(-12), 0, 0))
plain(win, GLASS)

# vents and sensor blocks
for i, (x, y, sx, sy) in enumerate([(0.36, -0.7, 0.16, 0.36), (-0.36, -0.7, 0.16, 0.36),
                                     (0.0, -1.55, 0.5, 0.12), (0.28, 0.05, 0.1, 0.18), (-0.28, 0.05, 0.1, 0.18)]):
    part(L.bevel(L.obox(f"Vent{i}", (x, y, 0.33 if i < 2 else 0.27), (sx, sy, 0.05)), 0.008), VENT, smooth=False)

# ---------------------------------------------------------------- sponsons, blades, mandibles
SPONSON = [(0.55, 0.65), (1.0, 0.25), (1.22, -0.55), (1.18, -1.65), (0.72, -1.85), (0.55, -1.0)]
plate("Sponson", SPONSON, -0.14, 0.14, HULL, 0.02, mirror=True)
plate("SponsonTop", [(0.65, 0.4), (0.98, 0.1), (1.12, -0.6), (1.08, -1.5), (0.78, -1.62), (0.66, -0.9)],
      0.14, 0.22, PLATE, mirror=True)
plate("SponsonTrim", [(1.0, 0.05), (1.12, -0.6), (1.08, -0.9), (0.98, -0.3)], 0.22, 0.25, TRIM, 0.005,
      mirror=True)
plate("Blade", [(1.12, -0.25), (1.72, -1.05), (1.78, -1.45), (1.16, -1.15)], -0.03, 0.04, PLATE, 0.01, mirror=True)
plate("BladeTrim", [(1.2, -0.3), (1.7, -0.98), (1.66, -1.06), (1.17, -0.4)], 0.04, 0.06, TRIM, 0.004, mirror=True)
plate("BladeLower", [(1.1, -0.9), (1.5, -1.55), (1.48, -1.8), (1.1, -1.55)], -0.1, -0.04, HULL, 0.01, mirror=True)
if os.environ.get("SHIP_LASER", "pylon") == "mandible":  # forward prongs only carry the nose-gun variant
    plate("Mandible", [(0.5, 0.55), (0.78, 1.45), (0.72, 1.82), (0.56, 1.78), (0.44, 0.95)], -0.08, 0.1, PLATE,
          0.012, mirror=True)
    plate("MandibleTrim", [(0.6, 1.0), (0.74, 1.5), (0.68, 1.55), (0.56, 1.05)], 0.1, 0.13, TRIM, 0.005, mirror=True)

# Mining laser placement — try variants with SHIP_LASER=<name> (see LASER_VARIANTS).
LASER_VARIANTS = {
    # name: (x, y_back, y_front, z, scale, pylon_to)
    "mandible": (0.64, 1.25, 1.95, 0.16, 0.9, 0.1),     # on top of the forward mandibles (old spot)
    "sponson": (1.02, -0.05, 1.05, 0.29, 1.0, 0.22),    # on the sponson nose, outboard of the hull
    "pylon": (1.32, -0.75, 0.75, 0.0, 1.05, None),      # outer pylon along the sponson's outer edge
    "wingtip": (1.8, -1.35, -0.2, 0.0, 0.95, None),     # on the blade tips, classic fighter wingtip guns
}
LASER_VARIANT = os.environ.get("SHIP_LASER", "pylon")
lx, ly0, ly1, lz, lscale, lpylon = LASER_VARIANTS[LASER_VARIANT]
muzzles = {}

for side, s in ((1, "R"), (-1, "L")):
    muzzles[s] = cannon("Laser" + s, lx * side, ly0, ly1, lz, lscale, lpylon)
    if LASER_VARIANT == "pylon":  # struts tying the outer gun to the sponson
        for k, y in enumerate((-0.45, 0.1)):
            part(L.obox(f"LaserStrut{s}{k}", ((lx - 0.12) * side, y, 0.0), (0.2, 0.08, 0.06)), DARK, smooth=False)
    if LASER_VARIANT == "wingtip":  # fairing joining the blade tip to the gun
        part(L.obox(f"LaserFairing{s}", ((lx - 0.06) * side, -1.15, 0.0), (0.12, 0.35, 0.08)), PLATE, smooth=False)
    # sponson engine pair
    for k, dx in enumerate((-0.14, 0.14)):
        nozzle(f"SponsonEngine{s}{k}", 0.1, -1.98, (0.95 + dx) * side, 0.0)
    # antenna spikes and running lights
    spike("Spike" + s, (0.58 * side, -1.1, 0.34), 0.9, 160 * side, -8)
    spike("SpikeShort" + s, (1.05 * side, -1.2, 0.22), 0.55, 150 * side, -5)
    plain(L.ellipsoid("Run" + s, (1.76 * side, -1.42, 0.05), (0.035, 0.035, 0.035), 8, 4), AMBER)
    plain(L.ellipsoid("RunTail" + s, (0.58 * side, -1.88, 0.3), (0.03, 0.03, 0.03), 8, 4), AMBER)
    plain(L.ellipsoid("Nav" + s, (1.02 * side, 0.22, 0.16), (0.035, 0.05, 0.03), 8, 4), NAV_G if side > 0 else NAV_R)

# centre engine pair
for k, x in enumerate((-0.2, 0.2)):
    nozzle(f"MainEngine{k}", 0.15, -2.05, x, 0.04)

# ---------------------------------------------------------------- mounts
for name, loc in [("ThrusterMount", (0, -2.18, 0.04)),
                  ("ThrusterMountL", (-0.95, -2.1, 0)), ("ThrusterMountR", (0.95, -2.1, 0)),
                  ("DrillMountL", muzzles["L"]), ("DrillMountR", muzzles["R"])]:
    e = L.link(bpy.data.objects.new(name, None), root)
    e.location = loc

# ---------------------------------------------------------------- bake + export
body = L.join(textured, "Body")
body.parent = root
L.unwrap(body)
L.bake_atlas(body, "ship", os.path.join(args["previews"], "tex"), size=1024)
trim = L.join(accent, "AccentTrim")
trim.parent = root
L.unwrap(trim)
L.bake_atlas(trim, "ship_accent", os.path.join(args["previews"], "tex"), size=256, mat_name="Accent")
L.export(args)
L.render_previews(args, [
    ("top", (0, -0.1, 10), (0, -0.1, 0), 4.8),
    ("persp", (-3.4, -3.6, 2.4), (0, -0.2, 0), None),
    ("front", (2.8, 3.8, 1.8), (0, 0.1, 0), None),
    ("game", (0, -3.6, 11), (0, 0, 0), None),  # roughly the in-game camera angle
])
