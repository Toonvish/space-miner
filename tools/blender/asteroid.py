"""Asteroid variants — displaced icospheres with craters, baked into one shared atlas.

Run via `bun run models asteroid`.
Exports meshes "Asteroid0".."Asteroid3", all centred at the origin, sharing material "Rock".
The game normalises each to radius 1 and scales/stretches them per instance.
"""

import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _lib as L  # noqa: E402
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector, noise  # noqa: E402

args = L.parse_args("asteroid")
L.reset_scene()

VARIANTS = 4
SPACING = 3.5


def make_rock(index):
    rng = random.Random(1000 + index * 77)
    seed = Vector((rng.uniform(-50, 50), rng.uniform(-50, 50), rng.uniform(-50, 50)))
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)

    craters = []
    for _ in range(rng.randint(3, 6)):
        c = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
        craters.append((c, rng.uniform(0.22, 0.5), rng.uniform(0.08, 0.16)))

    stretch = Vector((1.0, rng.uniform(0.75, 0.95), rng.uniform(0.62, 0.85)))
    for v in bm.verts:
        n = v.co.normalized()
        d = 1.0
        d += 0.30 * noise.fractal(n * 1.2 + seed, 0.6, 2.0, 4)
        d += 0.06 * noise.fractal(n * 4.5 + seed * 1.3, 0.5, 2.0, 3)
        for c, size, depth in craters:
            x = n.angle(c) / size
            if x < 1.0:
                d -= depth * (1.0 - x * x)
            elif x < 1.35:
                d += depth * 0.35 * (1.0 - (x - 1.0) / 0.35)  # raised rim
        v.co = Vector((n.x * stretch.x, n.y * stretch.y, n.z * stretch.z)) * d

    # random tumble so variants don't share an obvious "up"
    rot = (Matrix.Rotation(rng.uniform(0, math.tau), 3, "X")
           @ Matrix.Rotation(rng.uniform(0, math.tau), 3, "Z"))
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=rot)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(index * SPACING, 0, 0))
    obj = L.mesh_obj(f"Asteroid{index}", bm)
    L.shade(obj, smooth=True, angle=70)
    return obj, seed


rock_src = L.rock_mat(
    "RockSrc",
    dark=L.srgb("#2f2b28"), light=L.srgb("#77706a"), tint=L.srgb("#6a5546"),
    ore=L.srgb("#d0902e"), seed=3.0, ore_amount=0.6,
)
rocks = []
for i in range(VARIANTS):
    obj, _ = make_rock(i)
    L.set_mat(obj, rock_src)
    rocks.append(obj)

# bake all variants into one atlas, then split them back apart
body = L.join(rocks, "Rocks")
L.unwrap(body, margin=0.006)
L.bake_atlas(body, "asteroid", os.path.join(args["previews"], "tex"), size=1024,
             ao_strength=0.85, mat_name="Rock")

bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.separate(type="LOOSE")
bpy.ops.object.mode_set(mode="OBJECT")

parts = [o for o in bpy.context.scene.objects if o.type == "MESH"]
parts.sort(key=lambda o: sum((o.matrix_world @ v.co).x for v in o.data.vertices) / len(o.data.vertices))
for i, o in enumerate(parts):
    c = sum((v.co for v in o.data.vertices), Vector()) / len(o.data.vertices)
    o.data.transform(Matrix.Translation(-c))
    o.location = (0, 0, 0)
    o.name = o.data.name = f"Asteroid{i}"

L.export(args)

# lay them out for the preview only
for i, o in enumerate(parts):
    o.location = ((i - (len(parts) - 1) / 2) * 2.6, 0, 0)
L.render_previews(args, [
    ("top", (0, 0, 12), (0, 0, 0), 11.0),
    ("persp", (2.0, -9.0, 4.5), (0, 0, 0), None),
])
