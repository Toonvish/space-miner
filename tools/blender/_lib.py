"""Shared Blender helpers: geometry, procedural materials, texture baking, export, previews.

Pipeline (PS2/GameCube-era look):
  1. Build low-poly parts with procedural "detail" materials (panel lines, grime, wear).
  2. Join the textured parts into one mesh, auto-unwrap, and bake a small atlas:
       albedo (with ambient occlusion multiplied in), tangent normal map,
       metal/roughness map (G = roughness, B = metallic, glTF layout).
  3. Replace the procedural materials with one image-based "Body" material.
  4. Export .glb (+ editable .blend) and render preview images.
Parts that should stay untextured (glass, glowing lights) are kept as separate objects.
"""

import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector


# ---------------------------------------------------------------- args / scene
def parse_args(default_name):
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return {
        "glb": argv[0] if len(argv) > 0 else f"{default_name}.glb",
        "previews": argv[1] if len(argv) > 1 else ".",
        "blend": argv[2] if len(argv) > 2 else None,
        "name": default_name,
    }


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def srgb(hexstr):
    """Hex sRGB -> linear RGB tuple (Blender colours are linear)."""
    h = hexstr.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


# ---------------------------------------------------------------- geometry
def link(obj, parent=None):
    bpy.context.scene.collection.objects.link(obj)
    if parent:
        obj.parent = parent
    return obj


def mesh_obj(name, bm, parent=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me), parent)


def rot_x(deg):
    return Matrix.Rotation(math.radians(deg), 3, "X")


def prism(name, pts, z0, z1, parent=None):
    """Extrude a 2D polygon (XY) between z0 and z1."""
    bm = bmesh.new()
    bot = [bm.verts.new((x, y, z0)) for x, y in pts]
    top = [bm.verts.new((x, y, z1)) for x, y in pts]
    bm.faces.new(bot)
    bm.faces.new(top)
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bot[i], bot[j], top[j], top[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, parent)


def box(name, center, size, parent=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    bmesh.ops.translate(bm, vec=center, verts=bm.verts)
    return mesh_obj(name, bm, parent)


def obox(name, pos, size, rot=(0.0, 0.0, 0.0), parent=None):
    """Box centred on its own origin, then placed at `pos` and rotated (euler, radians)
    about its own centre. Use this instead of `box` whenever the box gets rotated."""
    o = box(name, (0, 0, 0), size, parent)
    o.location = pos
    o.rotation_euler = rot
    return o


def cylinder_y(name, r_back, r_front, depth, y_center, segments=16, cap=True, parent=None):
    """Cylinder/cone along Y. r_back at the -Y end, r_front at the +Y end."""
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm, cap_ends=cap, cap_tris=False, segments=segments,
        radius1=r_back, radius2=r_front, depth=depth,
    )
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=rot_x(-90))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, y_center, 0))
    return mesh_obj(name, bm, parent)


def loft_y(name, profile, stations, tip=None, parent=None):
    """Loft a closed 2D profile (x, z in -1..1) through stations (y, half_w, half_h, z_off).
    Stations go from front (+Y) to back. `tip` adds a pointed nose vertex in front."""
    bm = bmesh.new()
    rings = []
    for y, w, h, zo in stations:
        rings.append([bm.verts.new((px * w, y, pz * h + zo)) for px, pz in profile])
    n = len(profile)
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if tip:
        t = bm.verts.new(tip)
        for i in range(n):
            bm.faces.new((rings[0][(i + 1) % n], rings[0][i], t))
    else:
        bm.faces.new(rings[0])
    bm.faces.new(list(reversed(rings[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_obj(name, bm, parent)


def ellipsoid(name, center, radii, segments=16, rings=8, parent=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * radii[0], v.co.y * radii[1], v.co.z * radii[2])) + Vector(center)
    return mesh_obj(name, bm, parent)


def bevel(obj, width=0.015, segments=1):
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    return obj


def solidify(obj, thickness):
    obj.modifiers.new("Solidify", "SOLIDIFY").thickness = thickness
    return obj


def shade(obj, smooth=True, angle=35):
    """Smooth shading with hard edges above `angle` (keeps low-poly forms crisp)."""
    for p in obj.data.polygons:
        p.use_smooth = smooth
    if smooth:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        for e in bm.edges:
            if len(e.link_faces) == 2:
                e.smooth = e.calc_face_angle() < math.radians(angle)
        bm.to_mesh(obj.data)
        bm.free()
    return obj


def set_mat(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


def apply_modifiers(obj):
    if not obj.modifiers:
        return obj
    dg = bpy.context.evaluated_depsgraph_get()
    new_mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    obj.modifiers.clear()
    obj.data = new_mesh
    return obj


# ---------------------------------------------------------------- materials
def _sock(node, ident, out=False):
    socks = node.outputs if out else node.inputs
    return next(s for s in socks if s.identifier == ident)


def _new_mat(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    return m


def detail_mat(name, base, metal=0.1, rough=0.5, panel=1.6, grime=0.45,
               accent=None, accent_from_x=None, wear=0.0):
    """Procedural painted-metal material used only as a bake source.

    - panel lines from a brick texture in object space (recessed via bump)
    - large-scale grime and fine speckle
    - optional accent paint where |x| > accent_from_x (e.g. wing tips)
    - optional edge wear exposing bright metal (Cycles pointiness)
    """
    m = _new_mat(name)
    m["bake_metal"] = metal
    nt, N, L = m.node_tree, m.node_tree.nodes, m.node_tree.links
    bsdf = N["Principled BSDF"]
    tc = N.new("ShaderNodeTexCoord")
    obj_co = tc.outputs["Object"]

    # panels: irregular plate sizes with a slight per-plate tone variation
    br = N.new("ShaderNodeTexBrick")
    br.offset = 0.35
    br.offset_frequency = 3
    br.squash = 0.55
    br.squash_frequency = 2
    br.inputs["Scale"].default_value = panel
    br.inputs["Mortar Size"].default_value = 0.008
    br.inputs["Mortar Smooth"].default_value = 0.3
    br.inputs["Brick Width"].default_value = 1.1
    br.inputs["Row Height"].default_value = 0.38
    br.inputs["Bias"].default_value = 0.0
    br.inputs["Color1"].default_value = (*base, 1)
    br.inputs["Color2"].default_value = (*(c * 0.86 for c in base), 1)
    br.inputs["Mortar"].default_value = (*(c * 0.55 for c in base), 1)
    L.new(obj_co, br.inputs["Vector"])
    panel_fac = br.outputs["Fac"]

    nz = N.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 4.0
    nz.inputs["Detail"].default_value = 8.0
    nz.inputs["Roughness"].default_value = 0.6
    L.new(obj_co, nz.inputs["Vector"])
    gr = N.new("ShaderNodeMapRange")
    gr.inputs["From Min"].default_value = 0.42
    gr.inputs["From Max"].default_value = 0.78
    gr.inputs["To Max"].default_value = grime
    L.new(nz.outputs["Fac"], gr.inputs["Value"])

    sp = N.new("ShaderNodeTexNoise")
    sp.inputs["Scale"].default_value = 70.0
    sp.inputs["Detail"].default_value = 2.0
    L.new(obj_co, sp.inputs["Vector"])
    spr = N.new("ShaderNodeMapRange")
    spr.inputs["From Min"].default_value = 0.5
    spr.inputs["From Max"].default_value = 0.8
    spr.inputs["To Max"].default_value = 0.25
    L.new(sp.outputs["Fac"], spr.inputs["Value"])

    color = None  # socket carrying the current colour
    color = br.outputs["Color"]

    def mix(fac_socket, b_color, blend="MIX", fac_value=None):
        mx = N.new("ShaderNodeMix")
        mx.data_type = "RGBA"
        mx.blend_type = blend
        mx.clamp_result = True
        if fac_socket is not None:
            L.new(fac_socket, _sock(mx, "Factor_Float"))
        else:
            _sock(mx, "Factor_Float").default_value = fac_value
        L.new(color, _sock(mx, "A_Color"))
        if isinstance(b_color, tuple):
            _sock(mx, "B_Color").default_value = (*b_color, 1)
        else:
            L.new(b_color, _sock(mx, "B_Color"))
        return _sock(mx, "Result_Color", out=True)

    if accent is not None and accent_from_x is not None:
        sx = N.new("ShaderNodeSeparateXYZ")
        L.new(obj_co, sx.inputs[0])
        ab = N.new("ShaderNodeMath")
        ab.operation = "ABSOLUTE"
        L.new(sx.outputs["X"], ab.inputs[0])
        gt = N.new("ShaderNodeMath")
        gt.operation = "GREATER_THAN"
        gt.inputs[1].default_value = accent_from_x
        L.new(ab.outputs[0], gt.inputs[0])
        color = mix(gt.outputs[0], accent)

    if wear > 0:
        geo = N.new("ShaderNodeNewGeometry")
        wr = N.new("ShaderNodeMapRange")
        wr.inputs["From Min"].default_value = 0.52
        wr.inputs["From Max"].default_value = 0.62
        wr.inputs["To Max"].default_value = wear
        L.new(geo.outputs["Pointiness"], wr.inputs["Value"])
        color = mix(wr.outputs["Result"], srgb("#c9ccd0"))

    color = mix(gr.outputs["Result"], srgb("#4a4238"), blend="MULTIPLY")
    color = mix(spr.outputs["Result"], srgb("#2a2622"))
    pf = N.new("ShaderNodeMath")
    pf.operation = "MULTIPLY"
    pf.inputs[1].default_value = 0.45
    L.new(panel_fac, pf.inputs[0])
    color = mix(pf.outputs[0], srgb("#15161a"))
    L.new(color, bsdf.inputs["Base Color"])

    rr = N.new("ShaderNodeMapRange")
    rr.inputs["To Min"].default_value = max(0.0, rough - 0.08)
    rr.inputs["To Max"].default_value = min(1.0, rough + 0.2)
    L.new(nz.outputs["Fac"], rr.inputs["Value"])
    L.new(rr.outputs["Result"], bsdf.inputs["Roughness"])
    bsdf.inputs["Metallic"].default_value = metal

    bump = N.new("ShaderNodeBump")
    bump.invert = True
    bump.inputs["Strength"].default_value = 0.6
    bump.inputs["Distance"].default_value = 0.01
    L.new(panel_fac, bump.inputs["Height"])
    L.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def plain_mat(name, color, metal=0.0, rough=0.5, emission=None, strength=0.0):
    """Untextured material (glass, lights). Exported as-is."""
    m = _new_mat(name)
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    if emission:
        b.inputs["Emission Color"].default_value = (*emission, 1)
        b.inputs["Emission Strength"].default_value = strength
    return m


def rock_mat(name, dark, light, tint, ore, seed=0.0, ore_amount=0.5):
    """Procedural asteroid rock used as a bake source: mottled stone, hairline cracks,
    and thin ore veins (amount 0..1)."""
    m = _new_mat(name)
    m["bake_metal"] = 0.0
    N, L = m.node_tree.nodes, m.node_tree.links
    bsdf = N["Principled BSDF"]
    co = N.new("ShaderNodeTexCoord").outputs["Object"]

    def noise(scale, detail=6.0, rough=0.55, offset=0.0):
        mp = N.new("ShaderNodeMapping")
        mp.inputs["Location"].default_value = (seed + offset, seed * 0.7, offset)
        L.new(co, mp.inputs["Vector"])
        nz = N.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = scale
        nz.inputs["Detail"].default_value = detail
        nz.inputs["Roughness"].default_value = rough
        L.new(mp.outputs["Vector"], nz.inputs["Vector"])
        return nz.outputs["Fac"]

    def mrange(sock, a, b, lo=0.0, hi=1.0):
        r = N.new("ShaderNodeMapRange")
        r.inputs["From Min"].default_value = a
        r.inputs["From Max"].default_value = b
        r.inputs["To Min"].default_value = lo
        r.inputs["To Max"].default_value = hi
        L.new(sock, r.inputs["Value"])
        return r.outputs["Result"]

    def mix(fac, a, b, blend="MIX"):
        mx = N.new("ShaderNodeMix")
        mx.data_type = "RGBA"
        mx.blend_type = blend
        mx.clamp_result = True
        L.new(fac, _sock(mx, "Factor_Float"))
        for ident, v in (("A_Color", a), ("B_Color", b)):
            if isinstance(v, tuple):
                _sock(mx, ident).default_value = (*v, 1)
            else:
                L.new(v, _sock(mx, ident))
        return _sock(mx, "Result_Color", out=True)

    # base stone: two tones + large-scale tint patches
    col = mix(mrange(noise(3.0, 8.0), 0.35, 0.7), dark, light)
    col = mix(mrange(noise(0.9, 3.0, 0.5, 5.0), 0.45, 0.75, 0.0, 0.6), col, tint)

    # cracks (voronoi cell edges)
    vor = N.new("ShaderNodeTexVoronoi")
    vor.feature = "DISTANCE_TO_EDGE"
    vor.inputs["Scale"].default_value = 3.5
    L.new(co, vor.inputs["Vector"])
    cracks = mrange(vor.outputs["Distance"], 0.0, 0.035, 1.0, 0.0)
    crack_mask = N.new("ShaderNodeMath")
    crack_mask.operation = "MULTIPLY"
    L.new(cracks, crack_mask.inputs[0])
    L.new(mrange(noise(2.0, 2.0, 0.5, 9.0), 0.45, 0.6), crack_mask.inputs[1])
    col = mix(crack_mask.outputs[0], col, (0.02, 0.018, 0.016))

    # ore veins: thin band around the 0.5 iso-line of a noise field
    vn = N.new("ShaderNodeMath")
    vn.operation = "SUBTRACT"
    L.new(noise(1.6, 4.0, 0.5, 13.0), vn.inputs[0])
    vn.inputs[1].default_value = 0.5
    va = N.new("ShaderNodeMath")
    va.operation = "ABSOLUTE"
    L.new(vn.outputs[0], va.inputs[0])
    vein = mrange(va.outputs[0], 0.0, 0.004 + 0.01 * ore_amount, 1.0, 0.0)
    region = N.new("ShaderNodeMath")  # veins only show up in some patches
    region.operation = "MULTIPLY"
    L.new(vein, region.inputs[0])
    L.new(mrange(noise(0.7, 2.0, 0.5, 31.0), 0.5, 0.62), region.inputs[1])
    col = mix(region.outputs[0], col, ore)
    L.new(col, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.88

    # bump: fine grit + crack grooves
    add = N.new("ShaderNodeMath")
    add.operation = "SUBTRACT"
    L.new(noise(14.0, 6.0, 0.6, 21.0), add.inputs[0])
    L.new(crack_mask.outputs[0], add.inputs[1])
    bump = N.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.5
    bump.inputs["Distance"].default_value = 0.03
    L.new(add.outputs[0], bump.inputs["Height"])
    L.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def hazard_mat(name, a=None, b=None, scale=6.0, angle=45.0):
    """Diagonal yellow/black hazard stripes with grime (bake source)."""
    a = a or srgb("#d9a51c")
    b = b or srgb("#16161a")
    m = _new_mat(name)
    m["bake_metal"] = 0.1
    N, Lk = m.node_tree.nodes, m.node_tree.links
    bsdf = N["Principled BSDF"]
    co = N.new("ShaderNodeTexCoord").outputs["Object"]
    mp = N.new("ShaderNodeMapping")
    mp.inputs["Rotation"].default_value = (0, 0, math.radians(angle))
    Lk.new(co, mp.inputs["Vector"])
    wave = N.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.wave_profile = "SAW"
    wave.inputs["Scale"].default_value = scale
    wave.inputs["Distortion"].default_value = 0.0
    Lk.new(mp.outputs["Vector"], wave.inputs["Vector"])
    step = N.new("ShaderNodeMath")
    step.operation = "GREATER_THAN"
    step.inputs[1].default_value = 0.5
    Lk.new(wave.outputs["Fac"], step.inputs[0])
    mx = N.new("ShaderNodeMix")
    mx.data_type = "RGBA"
    Lk.new(step.outputs[0], _sock(mx, "Factor_Float"))
    _sock(mx, "A_Color").default_value = (*a, 1)
    _sock(mx, "B_Color").default_value = (*b, 1)
    nz = N.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 5.0
    nz.inputs["Detail"].default_value = 8.0
    Lk.new(co, nz.inputs["Vector"])
    gr = N.new("ShaderNodeMapRange")
    gr.inputs["From Min"].default_value = 0.45
    gr.inputs["From Max"].default_value = 0.8
    gr.inputs["To Max"].default_value = 0.5
    Lk.new(nz.outputs["Fac"], gr.inputs["Value"])
    mul = N.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    Lk.new(gr.outputs["Result"], _sock(mul, "Factor_Float"))
    Lk.new(_sock(mx, "Result_Color", out=True), _sock(mul, "A_Color"))
    _sock(mul, "B_Color").default_value = (*srgb("#4a4238"), 1)
    Lk.new(_sock(mul, "Result_Color", out=True), bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.6
    bsdf.inputs["Metallic"].default_value = 0.1
    return m


# ---------------------------------------------------------------- baking
def join(objs, name):
    for o in objs:
        apply_modifiers(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    body.name = name
    body.data.name = name
    return body


def unwrap(obj, margin=0.008):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def _img(name, size, data=True):
    img = bpy.data.images.new(name, size, size, alpha=False)
    if data:
        img.colorspace_settings.name = "Non-Color"
    return img


def _px(img):
    a = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(-1, 4)


def bake_atlas(body, name, tex_dir, size=1024, ao_strength=0.75, mat_name="Body"):
    """Bake body's procedural materials into albedo / normal / metal-rough images
    and replace them with a single image-based material named `Body`."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("BakeWorld")
    scene.world.light_settings.distance = 0.6  # AO reach

    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    mats = [s.material for s in body.material_slots]

    def target(img):
        for m in mats:
            nodes = m.node_tree.nodes
            node = nodes.get("BakeTarget") or nodes.new("ShaderNodeTexImage")
            node.name = "BakeTarget"
            node.image = img
            nodes.active = node

    def bake(kind, img, samples, **kw):
        target(img)
        scene.cycles.samples = samples
        bpy.ops.object.bake(type=kind, margin=12, use_clear=True, **kw)
        print(f"[bake] {name} {kind}")

    albedo = _img(f"{name}_albedo", size, data=False)
    ao = _img(f"{name}_ao", size)
    rough = _img(f"{name}_rough", size // 2)
    metal = _img(f"{name}_metal", size // 2)
    normal = _img(f"{name}_normal", size)

    # Diffuse colour pass ignores metallic surfaces -> bake with metallic 0.
    for m in mats:
        m.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.0
    bake("DIFFUSE", albedo, 4, pass_filter={"COLOR"})
    bake("AO", ao, 48)
    bake("ROUGHNESS", rough, 4)
    for m in mats:  # metallic value -> emission, then bake EMIT
        b = m.node_tree.nodes["Principled BSDF"]
        v = float(m.get("bake_metal", 0.0))
        b.inputs["Emission Color"].default_value = (v, v, v, 1)
        b.inputs["Emission Strength"].default_value = 1.0
    bake("EMIT", metal, 1)
    bake("NORMAL", normal, 4, normal_space="TANGENT")

    # albedo *= AO (classic baked-lighting look)
    a = _px(albedo)
    o = _px(ao)[:, 0]
    a[:, :3] *= (1.0 - ao_strength + ao_strength * o)[:, None]
    albedo.pixels.foreach_set(a.ravel())

    mr_img = _img(f"{name}_mr", size // 2)
    mr = np.ones((size // 2 * size // 2, 4), dtype=np.float32)
    mr[:, 1] = _px(rough)[:, 0]
    mr[:, 2] = _px(metal)[:, 0]
    mr_img.pixels.foreach_set(mr.ravel())

    os.makedirs(tex_dir, exist_ok=True)
    for img in (albedo, normal, mr_img):
        img.filepath_raw = os.path.join(tex_dir, img.name + ".png")
        img.file_format = "PNG"
        img.save()
    for img in (ao, rough, metal):
        bpy.data.images.remove(img)

    # final image-based material
    m = _new_mat(mat_name)
    N, L = m.node_tree.nodes, m.node_tree.links
    b = N["Principled BSDF"]
    t_alb = N.new("ShaderNodeTexImage")
    t_alb.image = albedo
    L.new(t_alb.outputs["Color"], b.inputs["Base Color"])
    t_mr = N.new("ShaderNodeTexImage")
    t_mr.image = mr_img
    sep = N.new("ShaderNodeSeparateColor")
    L.new(t_mr.outputs["Color"], sep.inputs["Color"])
    L.new(sep.outputs["Green"], b.inputs["Roughness"])
    L.new(sep.outputs["Blue"], b.inputs["Metallic"])
    t_n = N.new("ShaderNodeTexImage")
    t_n.image = normal
    nm = N.new("ShaderNodeNormalMap")
    L.new(t_n.outputs["Color"], nm.inputs["Color"])
    L.new(nm.outputs["Normal"], b.inputs["Normal"])

    body.data.materials.clear()
    body.data.materials.append(m)
    for old in mats:
        bpy.data.materials.remove(old)
    return m


# ---------------------------------------------------------------- export / previews
def export(args):
    glb = os.path.abspath(args["glb"])
    os.makedirs(os.path.dirname(glb), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=glb, export_format="GLB", export_apply=True, export_yup=True,
        export_image_format="WEBP",
    )
    print(f"[{args['name']}] exported {args['glb']} ({os.path.getsize(glb) // 1024} KB)")
    if args["blend"]:
        blend = os.path.abspath(args["blend"])
        os.makedirs(os.path.dirname(blend), exist_ok=True)
        bpy.ops.file.pack_all()
        bpy.ops.wm.save_as_mainfile(filepath=blend)


def render_previews(args, shots):
    """shots: list of (label, cam_location, look_at, ortho_scale_or_None)."""
    scene = bpy.context.scene
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    try:
        world.use_nodes = True
    except Exception:
        pass
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.012, 0.016, 0.035, 1)
    bg.inputs["Strength"].default_value = 1.0

    sun_d = bpy.data.lights.new("Sun", "SUN")
    sun_d.energy = 4.0
    sun_d.color = (1.0, 0.96, 0.9)
    sun = link(bpy.data.objects.new("Sun", sun_d))
    sun.rotation_euler = (math.radians(40), math.radians(-30), math.radians(35))
    rim_d = bpy.data.lights.new("Rim", "SUN")
    rim_d.energy = 1.2
    rim_d.color = (0.6, 0.75, 1.0)
    rim = link(bpy.data.objects.new("Rim", rim_d))
    rim.rotation_euler = (math.radians(-60), math.radians(40), 0)

    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = False
    scene.render.resolution_x = scene.render.resolution_y = 640
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    os.makedirs(args["previews"], exist_ok=True)

    for label, loc, look, ortho in shots:
        cd = bpy.data.cameras.new(label)
        if ortho:
            cd.type = "ORTHO"
            cd.ortho_scale = ortho
        cam = link(bpy.data.objects.new(label, cd))
        cam.location = loc
        cam.rotation_euler = (Vector(look) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.camera = cam
        scene.render.filepath = os.path.join(args["previews"], f"{args['name']}_{label}.png")
        bpy.ops.render.render(write_still=True)
    print(f"[{args['name']}] previews rendered")
