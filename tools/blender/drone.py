"""Cargo drone — a small autonomous hauler that ferries ore from miners to the station.

Run via `bun run models drone`.
Exports root empty "Drone" (nose -> +Y in Blender, i.e. -Z in three.js like the ship) and an
empty "DroneThruster" at the nozzle. Glow materials end in "Glow".
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _lib as L  # noqa: E402
import bmesh  # noqa: E402
import bpy  # noqa: E402

args = L.parse_args("drone")
L.reset_scene()
root = L.link(bpy.data.objects.new("Drone", None))

PAINT = L.detail_mat("Paint", L.srgb("#b9bcc0"), 0.15, 0.45, panel=3.0, wear=0.5)
HAZARD = L.hazard_mat("Hazard", scale=4.0)
METAL = L.detail_mat("Metal", L.srgb("#4a4e55"), 0.85, 0.38, panel=5.0, grime=0.5)
DARK = L.detail_mat("Dark", L.srgb("#24262b"), 0.7, 0.55, panel=6.0, grime=0.3)
ENGINE = L.plain_mat("EngineGlow", L.srgb("#bfefff"), emission=L.srgb("#8fdcff"), strength=6.0)
LAMP = L.plain_mat("LampGlow", L.srgb("#ffd9a0"), emission=L.srgb("#ffb050"), strength=4.0)

parts = []


def part(obj, mat, smooth=True, angle=35):
    obj.parent = root
    L.set_mat(obj, mat)
    L.shade(obj, smooth, angle)
    parts.append(obj)
    return obj


PROFILE = [(1.0, 0.0), (0.75, 0.6), (0.3, 0.9), (-0.3, 0.9), (-0.75, 0.6),
           (-1.0, 0.0), (-0.8, -0.5), (-0.3, -0.7), (0.3, -0.7), (0.8, -0.5)]
part(L.loft_y("Body", PROFILE, [(0.55, 0.16, 0.1, 0.0), (0.3, 0.3, 0.2, 0.02),
                                (-0.35, 0.32, 0.22, 0.02), (-0.6, 0.24, 0.18, 0.0)],
              tip=(0, 0.72, -0.02)), PAINT, angle=30)
for side in (1, -1):
    pod = L.obox("CargoPod", (0.42 * side, -0.1, -0.03), (0.26, 0.7, 0.26))
    part(L.bevel(pod, 0.03), HAZARD, angle=40)
    arm = L.obox("Arm", (0.27 * side, -0.1, 0.0), (0.12, 0.2, 0.06))
    part(arm, METAL, False)
    part(L.cylinder_y("Lamp", 0.04, 0.04, 0.06, 0.28, 8), DARK).location = (0.42 * side, 0, -0.03)
    lamp = L.ellipsoid("LampLens", (0.42 * side, 0.32, -0.03), (0.035, 0.02, 0.035), 8, 4)
    lamp.parent = root
    L.set_mat(lamp, LAMP)
part(L.cylinder_y("Nozzle", 0.14, 0.1, 0.18, -0.7, 12, cap=False), DARK)
part(L.box("Sensor", (0, 0.15, 0.22), (0.12, 0.2, 0.06)), DARK, False)

bm = bmesh.new()
bmesh.ops.create_circle(bm, cap_ends=True, segments=12, radius=0.1)
bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=L.rot_x(90))
bmesh.ops.translate(bm, verts=bm.verts, vec=(0, -0.66, 0))
glow = L.mesh_obj("EngineGlow", bm, parent=root)
L.set_mat(glow, ENGINE)

mount = L.link(bpy.data.objects.new("DroneThruster", None), root)
mount.location = (0, -0.8, 0)

body = L.join(parts, "DroneHull")
body.parent = root
L.unwrap(body)
L.bake_atlas(body, "drone", os.path.join(args["previews"], "tex"), size=512, mat_name="DroneBody")
L.export(args)
L.render_previews(args, [
    ("top", (0, 0, 5), (0, 0, 0), 2.0),
    ("persp", (1.6, -1.8, 1.3), (0, 0, 0), None),
])
