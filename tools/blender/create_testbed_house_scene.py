from __future__ import annotations

import math
from contextlib import contextmanager
from pathlib import Path

try:
    import bpy
    from mathutils import Vector
except ImportError as error:
    raise SystemExit(
        'This script must run inside Blender 4.5 with bpy available. '
        f'Import failure: {error}'
    )


SCRIPT_VERSION = '0.1.1'
PREFIX = 'TESTBED_'
COLLECTION_NAME = 'TestbedHouseSource'
CAMERA_NAME = f'{PREFIX}Camera'
CONTROL_TARGET_NAME = 'EXPORT_CONTROL_TARGET'
SUN_LIGHT_NAME = f'{PREFIX}SunLight'
FILL_LIGHT_NAME = f'{PREFIX}FillLight'
REPO_HDR_RELATIVE_PATH = Path('public') / 'monochrome_studio_03_1k.hdr'


def main() -> None:
    collection = rebuild_generated_scene()
    mesh_count = sum(1 for object_ in collection.objects if object_.type == 'MESH')
    print(
        f'Created {mesh_count} mesh objects in collection "{collection.name}" '
        f'for prepare_testbed_collection.py v{SCRIPT_VERSION} coverage.'
    )
    print('Save the .blend file, then run prepare_testbed_collection.py from Blender\'s Scripting tab.')


def rebuild_generated_scene() -> object:
    delete_generated_content()
    collection = ensure_collection(COLLECTION_NAME)
    set_active_collection(collection)
    material_library = build_material_library()
    create_house_structure(material_library)
    create_furniture(material_library)
    target = create_control_target(collection)
    configure_camera(target)
    configure_lights(target)
    configure_world_environment()
    bpy.context.view_layer.update()
    return collection


def delete_generated_content() -> None:
    collection = bpy.data.collections.get(COLLECTION_NAME)
    if collection is not None:
        for object_ in list(collection.objects):
            bpy.data.objects.remove(object_, do_unlink=True)
        if bpy.context.scene.collection.children.get(collection.name) is not None:
            bpy.context.scene.collection.children.unlink(collection)
        bpy.data.collections.remove(collection)

    for object_name in (CAMERA_NAME, CONTROL_TARGET_NAME, SUN_LIGHT_NAME, FILL_LIGHT_NAME):
        object_ = bpy.data.objects.get(object_name)
        if object_ is not None:
            bpy.data.objects.remove(object_, do_unlink=True)

    purge_prefixed_blocks(bpy.data.materials)
    purge_prefixed_blocks(bpy.data.meshes)
    purge_prefixed_blocks(bpy.data.cameras)
    purge_prefixed_blocks(bpy.data.lights)


def purge_prefixed_blocks(data_blocks: object) -> None:
    for block in list(data_blocks):
        if block.name.startswith(PREFIX):
            data_blocks.remove(block)


def ensure_collection(name: str) -> object:
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection


def set_active_collection(collection: object) -> None:
    layer_collection = find_layer_collection(bpy.context.view_layer.layer_collection, collection)
    if layer_collection is not None:
        bpy.context.view_layer.active_layer_collection = layer_collection


def find_layer_collection(layer_collection: object, collection: object) -> object | None:
    if layer_collection.collection == collection:
        return layer_collection
    for child in layer_collection.children:
        result = find_layer_collection(child, collection)
        if result is not None:
            return result
    return None


def build_material_library() -> dict[str, object]:
    return {
        'wall': create_ready_orm_material(
            f'{PREFIX}WallReady',
            ((0.83, 0.78, 0.72), (0.76, 0.71, 0.66)),
            roughness_metallic=(0.45, 0.05),
            noise_scale=8.0,
            metallic_scale=0.7,
            roughness_floor=0.28,
        ),
        'ceiling': create_partial_material(
            f'{PREFIX}CeilingPartial',
            ((0.55, 0.18, 0.12), (0.42, 0.11, 0.08)),
            noise_scale=12.0,
        ),
        'wood': create_split_ready_material(
            f'{PREFIX}WoodReady',
            ((0.58, 0.36, 0.22), (0.44, 0.27, 0.16)),
            roughness_value=0.65,
            metallic_value=0.02,
            noise_scale=10.0,
            metallic_scale=0.5,
            roughness_floor=0.3,
        ),
        'glass': create_ready_orm_material(
            f'{PREFIX}GlassReady',
            ((0.68, 0.83, 0.93), (0.52, 0.73, 0.86)),
            roughness_metallic=(0.08, 0.0),
            noise_scale=5.0,
            transmission=0.88,
            roughness=0.08,
        ),
        'stone': create_ready_orm_material(
            f'{PREFIX}StoneReady',
            ((0.53, 0.55, 0.6), (0.38, 0.4, 0.44)),
            roughness_metallic=(0.55, 0.02),
            noise_scale=18.0,
        ),
        'fabric': create_bake_required_material(
            f'{PREFIX}FabricBakeRequired',
            ((0.2, 0.48, 0.6), (0.1, 0.26, 0.32)),
            noise_scale=14.0,
        ),
        'ceramic': create_partial_material(
            f'{PREFIX}CeramicPartial',
            ((0.95, 0.96, 0.98), (0.82, 0.86, 0.9)),
            noise_scale=6.0,
        ),
        'metal': create_split_ready_material(
            f'{PREFIX}MetalReady',
            ((0.76, 0.78, 0.8), (0.58, 0.62, 0.66)),
            roughness_value=0.34,
            metallic_value=0.78,
            noise_scale=20.0,
            metallic_scale=0.85,
            roughness_floor=0.24,
        ),
    }


def get_node_input(node: object, *socket_names: str) -> object:
    for socket_name in socket_names:
        socket = node.inputs.get(socket_name)
        if socket is not None:
            return socket

    available = ', '.join(socket.name for socket in node.inputs)
    expected = ', '.join(socket_names)
    raise KeyError(f'Unable to find node input matching [{expected}]. Available inputs: {available}')


def set_node_input_default(node: object, value: float, *socket_names: str) -> None:
    get_node_input(node, *socket_names).default_value = value


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def create_palette_texture_output(
    nodes: object,
    links: object,
    vector_socket: object,
    palette: tuple[tuple[float, float, float], tuple[float, float, float]],
    noise_scale: float,
    location_x: float,
    location_y: float,
    blend_type: str,
    mix_factor: float,
) -> object:
    checker = nodes.new('ShaderNodeTexChecker')
    checker.location = (location_x, location_y + 140)
    checker.inputs['Color1'].default_value = (*palette[0], 1.0)
    checker.inputs['Color2'].default_value = (*palette[1], 1.0)
    checker.inputs['Scale'].default_value = max(noise_scale * 0.45, 3.0)

    noise = nodes.new('ShaderNodeTexNoise')
    noise.location = (location_x, location_y - 40)
    noise.inputs['Scale'].default_value = max(noise_scale * 0.85, 1.0)
    noise.inputs['Detail'].default_value = 5.0

    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.location = (location_x + 220, location_y - 40)
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (*palette[0], 1.0)
    ramp.color_ramp.elements[1].position = 0.65
    ramp.color_ramp.elements[1].color = (*palette[1], 1.0)

    mix = nodes.new('ShaderNodeMixRGB')
    mix.location = (location_x + 470, location_y + 60)
    mix.blend_type = blend_type
    mix.inputs['Fac'].default_value = mix_factor

    links.new(vector_socket, checker.inputs['Vector'])
    links.new(vector_socket, noise.inputs['Vector'])
    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(checker.outputs['Color'], mix.inputs['Color1'])
    links.new(ramp.outputs['Color'], mix.inputs['Color2'])
    return mix.outputs['Color']


def create_scalar_noise_output(
    nodes: object,
    links: object,
    vector_socket: object,
    noise_scale: float,
    base_value: float,
    variation: float,
    location_x: float,
    location_y: float,
    floor_value: float | None = None,
    scale_value: float = 1.0,
) -> object:
    noise = nodes.new('ShaderNodeTexNoise')
    noise.location = (location_x, location_y)
    noise.inputs['Scale'].default_value = max(noise_scale, 1.0)
    noise.inputs['Detail'].default_value = 4.0

    map_range = nodes.new('ShaderNodeMapRange')
    map_range.location = (location_x + 220, location_y)
    map_range.clamp = True
    map_range.inputs[1].default_value = 0.0
    map_range.inputs[2].default_value = 1.0
    map_range.inputs[3].default_value = clamp01(base_value - variation)
    map_range.inputs[4].default_value = clamp01(base_value + variation)

    links.new(vector_socket, noise.inputs['Vector'])
    links.new(noise.outputs['Fac'], map_range.inputs[0])

    output_socket = map_range.outputs[0]

    if floor_value is not None:
        maximum = nodes.new('ShaderNodeMath')
        maximum.location = (location_x + 440, location_y)
        maximum.operation = 'MAXIMUM'
        maximum.inputs[1].default_value = floor_value
        links.new(output_socket, maximum.inputs[0])
        output_socket = maximum.outputs[0]

    if scale_value != 1.0:
        multiply = nodes.new('ShaderNodeMath')
        multiply.location = (location_x + 660, location_y)
        multiply.operation = 'MULTIPLY'
        multiply.inputs[1].default_value = scale_value
        links.new(output_socket, multiply.inputs[0])
        output_socket = multiply.outputs[0]

    return output_socket


def create_bump_normal_output(
    nodes: object,
    links: object,
    vector_socket: object,
    noise_scale: float,
    location_x: float,
    location_y: float,
    strength: float,
    distance: float,
) -> object:
    noise = nodes.new('ShaderNodeTexNoise')
    noise.location = (location_x, location_y)
    noise.inputs['Scale'].default_value = max(noise_scale, 1.0)
    noise.inputs['Detail'].default_value = 8.0
    noise.inputs['Roughness'].default_value = 0.6

    bump = nodes.new('ShaderNodeBump')
    bump.location = (location_x + 220, location_y)
    bump.inputs['Strength'].default_value = strength
    bump.inputs['Distance'].default_value = distance

    links.new(vector_socket, noise.inputs['Vector'])
    links.new(noise.outputs['Fac'], bump.inputs['Height'])
    return bump.outputs['Normal']


def create_ready_orm_material(
    name: str,
    base_palette: tuple[tuple[float, float, float], tuple[float, float, float]],
    roughness_metallic: tuple[float, float],
    noise_scale: float,
    transmission: float = 0.0,
    roughness: float | None = None,
    metallic_scale: float = 1.0,
    roughness_floor: float = 0.18,
) -> object:
    material = new_material(name)
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (760, 0)
    principled = nodes.new('ShaderNodeBsdfPrincipled')
    principled.location = (480, 0)
    set_node_input_default(principled, 0.28 if transmission <= 0.0 else 0.45, 'Specular IOR Level', 'Specular')
    set_node_input_default(principled, 0.0, 'Coat Weight', 'Coat')
    set_node_input_default(principled, transmission, 'Transmission Weight', 'Transmission')

    tex_coord = nodes.new('ShaderNodeTexCoord')
    tex_coord.location = (-1120, 100)
    mapping = nodes.new('ShaderNodeMapping')
    mapping.location = (-900, 100)
    links.new(tex_coord.outputs['Generated'], mapping.inputs['Vector'])
    mapping.inputs['Scale'].default_value[0] = noise_scale
    mapping.inputs['Scale'].default_value[1] = noise_scale
    mapping.inputs['Scale'].default_value[2] = noise_scale
    base_color_output = create_palette_texture_output(
        nodes,
        links,
        mapping.outputs['Vector'],
        base_palette,
        noise_scale,
        -700,
        -20,
        blend_type='MULTIPLY',
        mix_factor=0.5,
    )
    roughness_output = create_scalar_noise_output(
        nodes,
        links,
        mapping.outputs['Vector'],
        max(noise_scale * 0.75, 1.0),
        roughness_metallic[0] if roughness is None else roughness,
        0.08,
        -700,
        -280,
        floor_value=roughness_floor if roughness is None else None,
    )
    metallic_output = create_scalar_noise_output(
        nodes,
        links,
        mapping.outputs['Vector'],
        max(noise_scale * 0.55, 1.0),
        roughness_metallic[1],
        0.05,
        -700,
        -460,
        scale_value=metallic_scale,
    )
    normal_output = create_bump_normal_output(
        nodes,
        links,
        mapping.outputs['Vector'],
        max(noise_scale * 0.9, 1.0),
        -700,
        -700,
        strength=0.2 if transmission <= 0.0 else 0.08,
        distance=0.08,
    )

    links.new(base_color_output, get_node_input(principled, 'Base Color'))
    links.new(roughness_output, get_node_input(principled, 'Roughness'))
    links.new(metallic_output, get_node_input(principled, 'Metallic'))
    links.new(normal_output, get_node_input(principled, 'Normal'))
    links.new(principled.outputs['BSDF'], output.inputs['Surface'])
    return material


def create_split_ready_material(
    name: str,
    base_palette: tuple[tuple[float, float, float], tuple[float, float, float]],
    roughness_value: float,
    metallic_value: float,
    noise_scale: float,
    metallic_scale: float = 1.0,
    roughness_floor: float = 0.18,
) -> object:
    material = new_material(name)
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (760, 0)
    principled = nodes.new('ShaderNodeBsdfPrincipled')
    principled.location = (480, 0)
    set_node_input_default(principled, 0.28, 'Specular IOR Level', 'Specular')
    set_node_input_default(principled, 0.0, 'Coat Weight', 'Coat')

    tex_coord = nodes.new('ShaderNodeTexCoord')
    tex_coord.location = (-1120, 100)
    mapping = nodes.new('ShaderNodeMapping')
    mapping.location = (-900, 100)
    links.new(tex_coord.outputs['Generated'], mapping.inputs['Vector'])
    mapping.inputs['Scale'].default_value[0] = noise_scale
    mapping.inputs['Scale'].default_value[1] = noise_scale
    mapping.inputs['Scale'].default_value[2] = noise_scale
    base_color_output = create_palette_texture_output(
        nodes,
        links,
        mapping.outputs['Vector'],
        base_palette,
        noise_scale,
        -700,
        -20,
        blend_type='OVERLAY',
        mix_factor=0.55,
    )
    roughness_output = create_scalar_noise_output(
        nodes,
        links,
        mapping.outputs['Vector'],
        max(noise_scale * 0.7, 1.0),
        roughness_value,
        0.06,
        -700,
        -320,
        floor_value=roughness_floor,
    )
    metallic_output = create_scalar_noise_output(
        nodes,
        links,
        mapping.outputs['Vector'],
        max(noise_scale * 0.45, 1.0),
        metallic_value,
        0.04,
        -700,
        -520,
        scale_value=metallic_scale,
    )
    normal_output = create_bump_normal_output(
        nodes,
        links,
        mapping.outputs['Vector'],
        max(noise_scale * 0.85, 1.0),
        -700,
        -720,
        strength=0.16,
        distance=0.06,
    )

    links.new(base_color_output, get_node_input(principled, 'Base Color'))
    links.new(roughness_output, get_node_input(principled, 'Roughness'))
    links.new(metallic_output, get_node_input(principled, 'Metallic'))
    links.new(normal_output, get_node_input(principled, 'Normal'))
    links.new(principled.outputs['BSDF'], output.inputs['Surface'])
    return material


def create_partial_material(
    name: str,
    base_palette: tuple[tuple[float, float, float], tuple[float, float, float]],
    noise_scale: float,
) -> object:
    material = new_material(name)
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (660, 0)
    principled = nodes.new('ShaderNodeBsdfPrincipled')
    principled.location = (420, 0)
    set_node_input_default(principled, 0.55, 'Roughness')
    set_node_input_default(principled, 0.04, 'Metallic')

    tex_coord = nodes.new('ShaderNodeTexCoord')
    tex_coord.location = (-900, 100)
    mapping = nodes.new('ShaderNodeMapping')
    mapping.location = (-690, 100)
    links.new(tex_coord.outputs['Generated'], mapping.inputs['Vector'])
    mapping.inputs['Scale'].default_value[0] = noise_scale
    mapping.inputs['Scale'].default_value[1] = noise_scale
    mapping.inputs['Scale'].default_value[2] = noise_scale
    base_color_output = create_palette_texture_output(
        nodes,
        links,
        mapping.outputs['Vector'],
        base_palette,
        noise_scale,
        -520,
        -40,
        blend_type='SOFT_LIGHT',
        mix_factor=0.35,
    )

    links.new(base_color_output, get_node_input(principled, 'Base Color'))
    links.new(principled.outputs['BSDF'], output.inputs['Surface'])
    return material


def create_bake_required_material(
    name: str,
    palette: tuple[tuple[float, float, float], tuple[float, float, float]],
    noise_scale: float,
) -> object:
    material = new_material(name)
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (620, 0)
    principled = nodes.new('ShaderNodeBsdfPrincipled')
    principled.location = (360, 0)
    set_node_input_default(principled, 0.72, 'Roughness')

    tex_coord = nodes.new('ShaderNodeTexCoord')
    tex_coord.location = (-920, 80)
    mapping = nodes.new('ShaderNodeMapping')
    mapping.location = (-700, 80)
    mapping.inputs['Scale'].default_value[0] = noise_scale
    mapping.inputs['Scale'].default_value[1] = noise_scale
    noise = nodes.new('ShaderNodeTexNoise')
    noise.location = (-500, 120)
    noise.inputs['Scale'].default_value = noise_scale
    voronoi = nodes.new('ShaderNodeTexVoronoi')
    voronoi.location = (-500, -120)
    voronoi.inputs['Scale'].default_value = noise_scale * 0.65
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.location = (-250, 80)
    ramp.color_ramp.elements[0].color = (*palette[0], 1.0)
    ramp.color_ramp.elements[1].color = (*palette[1], 1.0)
    bump = nodes.new('ShaderNodeBump')
    bump.location = (-250, -180)
    bump.inputs['Strength'].default_value = 0.18
    bump.inputs['Distance'].default_value = 0.07

    links.new(tex_coord.outputs['UV'], mapping.inputs['Vector'])
    links.new(mapping.outputs['Vector'], noise.inputs['Vector'])
    links.new(mapping.outputs['Vector'], voronoi.inputs['Vector'])
    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(voronoi.outputs['Distance'], bump.inputs['Height'])
    links.new(ramp.outputs['Color'], get_node_input(principled, 'Base Color'))
    links.new(bump.outputs['Normal'], get_node_input(principled, 'Normal'))
    links.new(principled.outputs['BSDF'], output.inputs['Surface'])
    return material


def new_material(name: str) -> object:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.node_tree.nodes.clear()
    return material


def create_house_structure(materials: dict[str, object]) -> None:
    create_box('Floor', (12.0, 10.0, 0.2), (0.0, 0.0, 0.1), materials['wood'])
    create_box('Ceiling', (12.0, 4.6, 0.18), (0.0, 2.7, 3.2), materials['ceiling'])
    create_box('LeftWall', (0.22, 10.0, 3.0), (-5.9, 0.0, 1.6), materials['wall'])
    create_box('RightWall', (0.22, 10.0, 3.0), (5.9, 0.0, 1.6), materials['wall'])
    create_box('BackWall', (12.0, 0.22, 3.0), (0.0, 4.9, 1.6), materials['wall'])
    create_box('WindowLiving', (0.12, 2.2, 1.1), (-5.8, -1.2, 1.7), materials['glass'])


def create_furniture(materials: dict[str, object]) -> None:
    create_box('KitchenCounter', (2.8, 0.9, 0.9), (-4.0, 3.7, 0.55), materials['stone'])
    create_box('Sofa_LOD0', (2.6, 1.0, 1.0), (-3.1, -1.4, 0.55), materials['fabric'])
    create_box('Sofa_LOD1', (2.45, 0.95, 0.92), (-3.1, -1.4, 0.55), materials['fabric'])
    create_box('Sofa_LOD2', (2.3, 0.9, 0.84), (-3.1, -1.4, 0.55), materials['fabric'])
    create_box('Bed', (2.4, 1.8, 0.8), (-3.1, 2.5, 0.48), materials['fabric'])
    create_box('Wardrobe', (1.6, 0.65, 2.2), (-5.0, 1.9, 1.1), materials['wood'], apply_scale=False)
    create_cylinder('Toilet', 0.36, 0.74, (4.2, -3.0, 0.38), materials['ceramic'], vertices=12)
    shower = create_box('Shower', (1.45, 1.45, 2.2), (4.3, -0.25, 1.15), materials['glass'])
    remove_uv_layers(shower)
    create_cylinder('LivingLamp', 0.22, 1.7, (-0.3, -3.3, 0.9), materials['metal'], vertices=10, apply_scale=False)


def create_control_target(collection: object) -> object:
    bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0.0, 0.0, 1.2))
    target = bpy.context.active_object
    target.name = CONTROL_TARGET_NAME
    target.empty_display_size = 0.55
    link_object_to_collection(target, collection)
    return target


def configure_camera(target: object) -> None:
    bpy.ops.object.camera_add(location=(0.0, -14.5, 9.4))
    camera = bpy.context.active_object
    camera.name = CAMERA_NAME
    camera.data.name = f'{CAMERA_NAME}_Data'
    camera.data.lens = 28
    orient_towards(camera, target.location + Vector((0.0, 0.0, 0.3)))
    bpy.context.scene.camera = camera


def configure_lights(target: object) -> None:
    bpy.ops.object.light_add(type='SUN', location=(-3.0, -6.0, 8.5))
    sun = bpy.context.active_object
    sun.name = SUN_LIGHT_NAME
    sun.data.name = f'{SUN_LIGHT_NAME}_Data'
    sun.data.energy = 2.2
    orient_towards(sun, target.location)

    bpy.ops.object.light_add(type='AREA', location=(2.5, -2.2, 4.3))
    fill = bpy.context.active_object
    fill.name = FILL_LIGHT_NAME
    fill.data.name = f'{FILL_LIGHT_NAME}_Data'
    fill.data.energy = 1800
    fill.data.shape = 'RECTANGLE'
    fill.data.size = 5.0
    fill.data.size_y = 3.0
    orient_towards(fill, target.location + Vector((0.0, 0.0, 0.8)))


def configure_world_environment() -> None:
    scene = bpy.context.scene
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new(f'{PREFIX}World')
        scene.world = world

    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()

    background = nodes.new('ShaderNodeBackground')
    background.location = (120, 0)
    background.inputs['Strength'].default_value = 0.8
    output = nodes.new('ShaderNodeOutputWorld')
    output.location = (360, 0)
    links.new(background.outputs['Background'], output.inputs['Surface'])

    hdr_path = resolve_repo_hdr_path()
    if hdr_path is None or not hdr_path.exists():
        sky = nodes.new('ShaderNodeTexSky')
        sky.location = (-140, 0)
        sky.sun_elevation = math.radians(42.0)
        links.new(sky.outputs['Color'], background.inputs['Color'])
        return

    environment = nodes.new('ShaderNodeTexEnvironment')
    environment.location = (-320, 0)
    environment.image = bpy.data.images.load(str(hdr_path), check_existing=True)
    links.new(environment.outputs['Color'], background.inputs['Color'])


def resolve_repo_hdr_path() -> Path | None:
    search_roots: list[Path] = []
    script_file = globals().get('__file__')
    if script_file:
        search_roots.append(Path(script_file).resolve())

    text = getattr(bpy.context.space_data, 'text', None)
    if text is not None and text.filepath:
        search_roots.append(Path(bpy.path.abspath(text.filepath)).resolve())

    if bpy.data.filepath:
        search_roots.append(Path(bpy.data.filepath).resolve())

    search_roots.append(Path.cwd())

    for root in search_roots:
        current = root if root.is_dir() else root.parent
        for candidate in [current, *current.parents]:
            hdr_path = candidate / REPO_HDR_RELATIVE_PATH
            if hdr_path.exists():
                return hdr_path
    return None


def create_box(
    name: str,
    size: tuple[float, float, float],
    location: tuple[float, float, float],
    material: object,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    apply_scale: bool = True,
) -> object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    object_ = bpy.context.active_object
    object_.name = name
    object_.data.name = f'{PREFIX}{name}_Mesh'
    object_.scale = (size[0] * 0.5, size[1] * 0.5, size[2] * 0.5)
    assign_material(object_, material)
    if apply_scale:
        apply_object_scale(object_)
    return object_


def create_cylinder(
    name: str,
    radius: float,
    depth: float,
    location: tuple[float, float, float],
    material: object,
    vertices: int = 8,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    apply_scale: bool = True,
) -> object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    object_ = bpy.context.active_object
    object_.name = name
    object_.data.name = f'{PREFIX}{name}_Mesh'
    assign_material(object_, material)
    if apply_scale:
        apply_object_scale(object_)
    return object_


def assign_material(object_: object, material: object) -> None:
    object_.data.materials.clear()
    object_.data.materials.append(material)


def remove_uv_layers(object_: object) -> None:
    mesh = object_.data
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])


def link_object_to_collection(object_: object, collection: object) -> None:
    if collection not in object_.users_collection:
        collection.objects.link(object_)
    for current_collection in list(object_.users_collection):
        if current_collection != collection:
            current_collection.objects.unlink(object_)


def apply_object_scale(object_: object) -> None:
    with active_object(object_):
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def orient_towards(object_: object, target: Vector) -> None:
    direction = target - object_.location
    object_.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


@contextmanager
def active_object(object_: object):
    previous_active = bpy.context.view_layer.objects.active
    previous_selection = list(bpy.context.selected_objects)
    try:
        bpy.ops.object.select_all(action='DESELECT')
        object_.select_set(True)
        bpy.context.view_layer.objects.active = object_
        yield object_
    finally:
        bpy.ops.object.select_all(action='DESELECT')
        for selected in previous_selection:
            if selected.name in bpy.context.scene.objects:
                selected.select_set(True)
        if previous_active is not None and previous_active.name in bpy.context.scene.objects:
            bpy.context.view_layer.objects.active = previous_active


if __name__ == '__main__':
    main()