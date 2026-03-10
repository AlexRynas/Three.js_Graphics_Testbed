from __future__ import annotations

import builtins
from datetime import datetime
import importlib.util
import json
import re
import shutil
import tempfile
import traceback
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from types import SimpleNamespace

try:
    import bpy
    from mathutils import Vector
except ImportError as error:
    raise SystemExit(
        'This script must run inside Blender 4.5 with bpy available. '
        f'Import failure: {error}'
    )


SCRIPT_VERSION = '0.2.0'
CONTROL_TARGET_MARKERS = (
    'EXPORT_CONTROL_TARGET',
    'CollectionControlTarget',
    'InitialControlTarget',
)
LOD_SUFFIX_PATTERN = re.compile(r'^(?P<base>.+)_LOD(?P<level>[012])$')
IMAGE_NAME_HINTS = {
    'ao': ('_ao', 'ao_', 'occlusion', 'ambientocclusion'),
    'base_color': ('basecolor', 'base_color', 'albedo', 'diffuse'),
    'emissive': ('emissive', 'emission', 'glow'),
    'metallic': ('metallic', 'metalness', 'metal'),
    'normal': ('normal', 'norm'),
    'orm': ('orm', 'occlusionroughnessmetallic', 'rma'),
    'roughness': ('roughness', 'rough'),
}
STAGE_ORDER = (
    'inspect',
    'analyze',
    'bake',
    'export-high',
    'export-medium',
    'export-low',
    'package',
)
STAGE_DESCRIPTIONS = {
    'inspect': 'Resolve the source collection, validate scene prerequisites, create the output layout, and derive initial camera metadata.',
    'analyze': 'Inspect mesh LOD bundles, analyze materials and textures, and detect Auto Bake 2 availability without exporting assets.',
    'bake': 'Run only the bake preparation or Auto Bake 2 verification path so bake warnings can be reviewed separately.',
    'export-high': 'Export only the high-detail GLB package using LOD0 or the best available source mesh.',
    'export-medium': 'Export only the medium-detail GLB package using LOD1 or a generated decimated mesh.',
    'export-low': 'Export only the low-detail GLB package using LOD2 or a generated decimated mesh.',
    'package': 'Render the thumbnail, copy the HDR environment, write manifest/report files, and print the index snippet.',
}


@dataclass(slots=True)
class ExportConfig:
    collection_name_override: str | None = None
    display_name_override: str | None = None
    export_root_override: str | None = None
    high_texture_size: int = 4096
    medium_texture_size: int = 2048
    low_texture_size: int = 1024
    medium_decimate_ratio: float = 0.55
    low_decimate_ratio: float = 0.28
    thumbnail_size: int = 1024
    bake_behavior: str = 'auto'
    write_report: bool = True
    verify_autobake_adapter: bool = False
    log_path_override: str | None = None
    stages: tuple[str, ...] = ('all',)


DEFAULT_CONFIG = ExportConfig()


@dataclass(slots=True)
class ExportPaths:
    package_root: Path
    manifest_path: Path
    high_glb_path: Path
    medium_glb_path: Path
    low_glb_path: Path
    thumbnail_path: Path
    hdr_dir: Path
    report_path: Path


@dataclass(slots=True)
class QualityPlan:
    level: int
    label: str
    glb_path: Path
    decimate_ratio: float | None
    texture_size: int


@dataclass(slots=True)
class MaterialAnalysis:
    name: str
    status: str
    base_color_image: object | None = None
    normal_image: object | None = None
    metallic_image: object | None = None
    roughness_image: object | None = None
    ao_image: object | None = None
    emissive_image: object | None = None
    orm_image: object | None = None
    missing: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass(slots=True)
class MeshBundle:
    base_name: str
    source_object: object | None = None
    existing_lods: dict[int, object] = field(default_factory=dict)

    def best_seed(self) -> object | None:
        if 0 in self.existing_lods:
            return self.existing_lods[0]
        if self.source_object is not None:
            return self.source_object
        if self.existing_lods:
            return self.existing_lods[min(self.existing_lods.keys())]
        return None

    def resolve_for_level(self, level: int) -> tuple[object | None, bool]:
        if level in self.existing_lods:
            return self.existing_lods[level], False
        if level == 0 and self.source_object is not None:
            return self.source_object, False
        seed = self.best_seed()
        return seed, seed is not None


@dataclass(slots=True)
class AutoBakeStatus:
    installed: bool
    operators_available: bool
    property_roots: dict[str, bool]
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    used: bool = False


@dataclass(slots=True)
class ReportSnapshot:
    message_count: int
    warning_count: int
    error_count: int


class ExportReport:
    def __init__(self, log_path: Path | None = None) -> None:
        self.messages: list[str] = []
        self.warnings: list[str] = []
        self.errors: list[str] = []
        self.log_path = log_path
        if self.log_path is not None:
            ensure_directory(self.log_path.parent)
            self.log_path.write_text('', encoding='utf-8')

    def _emit(self, message: str) -> None:
        if self.log_path is not None:
            with self.log_path.open('a', encoding='utf-8') as handle:
                handle.write(message)
                handle.write('\n')

    def summary(self, message: str) -> None:
        print(message)
        self._emit(message)

    def log_traceback(self) -> None:
        traceback_text = traceback.format_exc().rstrip()
        if traceback_text:
            self._emit(traceback_text)

    def info(self, message: str) -> None:
        self.messages.append(message)
        self._emit(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        self._emit(f'WARNING: {message}')

    def error(self, message: str) -> None:
        self.errors.append(message)
        self._emit(f'ERROR: {message}')


def print_stage_catalog() -> None:
    print('Available execution stages:')
    for stage_name in STAGE_ORDER:
        print(f'- {stage_name}: {STAGE_DESCRIPTIONS[stage_name]}')


def build_export_config(**overrides: object) -> ExportConfig:
    config_values = asdict(DEFAULT_CONFIG)
    for key, value in overrides.items():
        if key not in config_values:
            raise TypeError(f'Unknown export config option: {key}')
        config_values[key] = value
    return ExportConfig(**config_values)


def resolve_log_path(config: ExportConfig) -> Path | None:
    if config.log_path_override:
        return Path(config.log_path_override).expanduser().resolve()

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    if bpy.data.filepath:
        blend_path = Path(bpy.data.filepath).resolve()
        return (blend_path.parent / 'export-logs' / f'{blend_path.stem}_prepare_testbed_collection_{timestamp}.log').resolve()
    return (Path(tempfile.gettempdir()) / 'threejs_testbed_export_logs' / f'unsaved_prepare_testbed_collection_{timestamp}.log').resolve()


def resolve_requested_stages(config: ExportConfig) -> tuple[str, ...]:
    if 'all' in config.stages:
        return STAGE_ORDER

    deduplicated: list[str] = []
    for stage_name in config.stages:
        if stage_name not in STAGE_ORDER:
            raise ValueError(f'Unknown stage: {stage_name}')
        if stage_name not in deduplicated:
            deduplicated.append(stage_name)
    return tuple(deduplicated)


def take_report_snapshot(report: ExportReport) -> ReportSnapshot:
    return ReportSnapshot(
        message_count=len(report.messages),
        warning_count=len(report.warnings),
        error_count=len(report.errors),
    )


def print_stage_header(stage_name: str) -> None:
    report = getattr(builtins, '_testbed_active_report', None)
    if report is not None:
        report.summary(f'\n=== Stage: {stage_name} ===')
        report.summary(STAGE_DESCRIPTIONS[stage_name])
        return
    print(f'\n=== Stage: {stage_name} ===')
    print(STAGE_DESCRIPTIONS[stage_name])


def summarize_issue_groups(messages: list[str]) -> list[tuple[str, int]]:
    grouped: dict[str, int] = {}
    for message in messages:
        normalized = re.sub(r'"[^"]+"', '"<name>"', message)
        normalized = re.sub(r'(?<![A-Za-z])[A-Za-z]:[^\n]+', '<path>', normalized)
        grouped[normalized] = grouped.get(normalized, 0) + 1
    return sorted(grouped.items(), key=lambda item: (-item[1], item[0]))


def print_stage_summary(stage_name: str, report: ExportReport, snapshot: ReportSnapshot) -> None:
    stage_warnings = report.warnings[snapshot.warning_count:]
    stage_errors = report.errors[snapshot.error_count:]
    warning_groups = summarize_issue_groups(stage_warnings)
    error_groups = summarize_issue_groups(stage_errors)
    report.summary(
        f'--- Stage complete: {stage_name} '
        f'(warnings={len(stage_warnings)}, errors={len(stage_errors)})'
    )
    if stage_warnings:
        report.summary('Stage warning groups:')
        for warning, count in warning_groups[:5]:
            report.summary(f'  - {count}x {warning}')
        if len(warning_groups) > 5:
            report.summary(f'  - {len(warning_groups) - 5} more warning groups in the log file.')
    if stage_errors:
        report.summary('Stage error groups:')
        for error, count in error_groups:
            report.summary(f'  - {count}x {error}')


def run_stage(stage_name: str, report: ExportReport, callback: object) -> object:
    builtins._testbed_active_report = report
    print_stage_header(stage_name)
    snapshot = take_report_snapshot(report)
    try:
        return callback()
    except Exception as error:
        report.error(f'Stage "{stage_name}" failed: {error}')
        raise
    finally:
        print_stage_summary(stage_name, report, snapshot)
        if getattr(builtins, '_testbed_active_report', None) is report:
            del builtins._testbed_active_report


def slugify(value: str) -> str:
    normalized = re.sub(r'[^a-zA-Z0-9]+', '_', value.strip()).strip('_').lower()
    return normalized or 'collection'


def title_case_slug(value: str) -> str:
    return value.replace('_', ' ').replace('-', ' ').strip().title()


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def ensure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def relative_manifest_path(target_path: Path, manifest_path: Path) -> str:
    return target_path.relative_to(manifest_path.parent).as_posix()


def object_has_meshes(collection: object) -> bool:
    return any(object_.type == 'MESH' for object_ in iter_collection_objects(collection))


def iter_collection_objects(collection: object) -> list[object]:
    objects: list[object] = []

    def visit(current: object) -> None:
        objects.extend(list(current.objects))
        for child in current.children:
            visit(child)

    visit(collection)
    return objects


def resolve_source_collection(config: ExportConfig, report: ExportReport) -> tuple[object, str, str]:
    scene = bpy.context.scene
    active_layer_collection = getattr(bpy.context.view_layer, 'active_layer_collection', None)
    active_collection = active_layer_collection.collection if active_layer_collection else None

    named_collection = None
    if config.collection_name_override:
        named_collection = bpy.data.collections.get(config.collection_name_override)
        if named_collection and not object_has_meshes(named_collection):
            report.warn(
                f'Named collection "{config.collection_name_override}" exists but contains no meshes; '
                'falling back to the active or first populated collection.'
            )
            named_collection = None

    if named_collection is not None:
        source_collection = named_collection
    elif active_collection is not None and object_has_meshes(active_collection):
        source_collection = active_collection
    else:
        source_collection = next(
            (collection for collection in bpy.data.collections if object_has_meshes(collection)),
            scene.collection,
        )

    package_name = slugify(config.collection_name_override or source_collection.name or Path(bpy.data.filepath).stem)
    display_name = config.display_name_override or title_case_slug(package_name)
    return source_collection, package_name, display_name


def validate_scene(source_collection: object, report: ExportReport) -> list[object]:
    if not bpy.data.filepath:
        raise RuntimeError('The .blend file must be saved before export can run.')

    camera = bpy.context.scene.camera
    if camera is None:
        raise RuntimeError('An active scene camera is required to derive the manifest view metadata.')

    mesh_objects = [
        object_
        for object_ in iter_collection_objects(source_collection)
        if object_.type == 'MESH' and not object_.hide_get()
    ]
    if not mesh_objects:
        raise RuntimeError('The source collection does not contain any visible mesh objects to export.')

    for object_ in mesh_objects:
        if object_.library is not None:
            report.warn(f'Object "{object_.name}" is linked from an external library; export will use the evaluated object state.')

        unapplied_transforms: list[str] = []
        if any(abs(value) > 0.0001 for value in object_.location[:]):
            unapplied_transforms.append('location')
        if any(abs(value) > 0.0001 for value in object_.rotation_euler[:]):
            unapplied_transforms.append('rotation')
        if any(abs(value - 1.0) > 0.0001 for value in object_.scale[:]):
            unapplied_transforms.append('scale')
        if unapplied_transforms:
            report.warn(
                f'Object "{object_.name}" has unapplied transforms: {", ".join(unapplied_transforms)}.'
            )

        mesh = object_.data
        if hasattr(mesh, 'uv_layers') and len(mesh.uv_layers) == 0:
            report.warn(f'Object "{object_.name}" has no UV map; baking and texture export may fail.')

        if not object_.material_slots or all(slot.material is None for slot in object_.material_slots):
            report.warn(f'Object "{object_.name}" has no assigned material slots.')

    world = bpy.context.scene.world
    if world is None or not world.use_nodes or world.node_tree is None:
        report.warn('The active World does not use nodes; no HDR environment file will be emitted.')

    return mesh_objects


def build_output_paths(blend_path: Path, package_name: str, config: ExportConfig) -> ExportPaths:
    if config.export_root_override:
        package_root = Path(config.export_root_override).expanduser().resolve()
    else:
        package_root = (blend_path.parent / 'collections' / package_name).resolve()

    manifest_path = package_root / 'manifest.json'
    return ExportPaths(
        package_root=package_root,
        manifest_path=manifest_path,
        high_glb_path=package_root / 'export' / 'high' / f'{package_name}_LOD0.glb',
        medium_glb_path=package_root / 'export' / 'medium' / f'{package_name}_LOD1.glb',
        low_glb_path=package_root / 'export' / 'low' / f'{package_name}_LOD2.glb',
        thumbnail_path=package_root / 'thumbnails' / f'{package_name}.png',
        hdr_dir=package_root / 'hdr',
        report_path=package_root / 'export-report.txt',
    )


def create_package_layout(paths: ExportPaths) -> None:
    ensure_directory(paths.package_root)
    ensure_directory(paths.high_glb_path.parent)
    ensure_directory(paths.medium_glb_path.parent)
    ensure_directory(paths.low_glb_path.parent)
    ensure_directory(paths.thumbnail_path.parent)
    ensure_directory(paths.hdr_dir)


def validate_packaging_inputs(paths: ExportPaths) -> None:
    missing_paths = [
        path
        for path in (paths.high_glb_path, paths.medium_glb_path, paths.low_glb_path)
        if not path.exists()
    ]
    if missing_paths:
        missing_labels = ', '.join(str(path) for path in missing_paths)
        raise RuntimeError(
            'The package stage requires all GLB exports to exist first. '
            f'Missing outputs: {missing_labels}'
        )


def vector_to_tuple(vector: Vector) -> list[float]:
    return [round(float(vector.x), 6), round(float(vector.y), 6), round(float(vector.z), 6)]


def find_named_target_marker(source_collection: object, package_name: str) -> object | None:
    names = set(CONTROL_TARGET_MARKERS)
    names.add(f'{package_name}_control_target')
    names.add(f'{source_collection.name}_control_target')
    for object_ in iter_collection_objects(source_collection):
        if object_.name in names:
            return object_
    for object_ in bpy.context.scene.objects:
        if object_.name in names:
            return object_
    return None


def compute_bounds_center_and_radius(mesh_objects: list[object]) -> tuple[Vector, float]:
    corners: list[Vector] = []
    for object_ in mesh_objects:
        for bound_corner in object_.bound_box:
            corners.append(object_.matrix_world @ Vector(bound_corner))

    min_corner = Vector((min(corner.x for corner in corners), min(corner.y for corner in corners), min(corner.z for corner in corners)))
    max_corner = Vector((max(corner.x for corner in corners), max(corner.y for corner in corners), max(corner.z for corner in corners)))
    center = (min_corner + max_corner) * 0.5
    radius = max((max_corner - min_corner).length * 0.5, 1.5)
    return center, radius


def derive_initial_view(mesh_objects: list[object], source_collection: object, package_name: str) -> tuple[list[float], list[float]]:
    camera = bpy.context.scene.camera
    camera_position = camera.matrix_world.translation.copy()

    marker = find_named_target_marker(source_collection, package_name)
    if marker is not None:
        return vector_to_tuple(camera_position), vector_to_tuple(marker.matrix_world.translation)

    bounds_center, bounds_radius = compute_bounds_center_and_radius(mesh_objects)
    forward = camera.matrix_world.to_quaternion() @ Vector((0.0, 0.0, -1.0))
    to_center = bounds_center - camera_position
    projected_distance = to_center.dot(forward.normalized())
    fallback_distance = max(bounds_radius * 2.0, 3.0)
    target_distance = projected_distance if projected_distance > 0.5 else fallback_distance
    target_distance = clamp(target_distance, bounds_radius * 0.75, max(bounds_radius * 4.0, 30.0))
    control_target = camera_position + forward.normalized() * target_distance
    return vector_to_tuple(camera_position), vector_to_tuple(control_target)


def build_quality_plans(paths: ExportPaths, config: ExportConfig) -> list[QualityPlan]:
    return [
        QualityPlan(level=0, label='high', glb_path=paths.high_glb_path, decimate_ratio=None, texture_size=config.high_texture_size),
        QualityPlan(level=1, label='medium', glb_path=paths.medium_glb_path, decimate_ratio=config.medium_decimate_ratio, texture_size=config.medium_texture_size),
        QualityPlan(level=2, label='low', glb_path=paths.low_glb_path, decimate_ratio=config.low_decimate_ratio, texture_size=config.low_texture_size),
    ]


def build_mesh_bundles(mesh_objects: list[object]) -> dict[str, MeshBundle]:
    bundles: dict[str, MeshBundle] = {}
    for object_ in mesh_objects:
        match = LOD_SUFFIX_PATTERN.match(object_.name)
        if match:
            base_name = match.group('base')
            level = int(match.group('level'))
            bundle = bundles.setdefault(base_name, MeshBundle(base_name=base_name))
            bundle.existing_lods[level] = object_
            continue

        bundle = bundles.setdefault(object_.name, MeshBundle(base_name=object_.name))
        if bundle.source_object is None:
            bundle.source_object = object_

    return bundles


def resolve_texture_hints(name: str) -> set[str]:
    normalized = re.sub(r'[^a-z0-9]+', '', name.lower())
    hits: set[str] = set()
    for key, fragments in IMAGE_NAME_HINTS.items():
        if any(fragment in normalized for fragment in fragments):
            hits.add(key)
    return hits


def find_principled_node(material: object) -> object | None:
    if not getattr(material, 'use_nodes', False) or material.node_tree is None:
        return None
    for node in material.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            return node
    return None


def trace_image_from_socket(socket: object, depth: int = 0, visited: set[tuple[str, str]] | None = None) -> object | None:
    if socket is None or not socket.is_linked:
        return None
    if visited is None:
        visited = set()
    if depth > 8:
        return None

    for link in socket.links:
        node = link.from_node
        key = (node.name, link.from_socket.name)
        if key in visited:
            continue
        visited.add(key)

        if node.type == 'TEX_IMAGE' and getattr(node, 'image', None) is not None:
            return node.image

        if node.type in {'NORMAL_MAP', 'SEPARATE_COLOR', 'SEPARATE_RGB'}:
            for input_socket in node.inputs:
                image = trace_image_from_socket(input_socket, depth + 1, visited)
                if image is not None:
                    return image

        for input_socket in node.inputs:
            image = trace_image_from_socket(input_socket, depth + 1, visited)
            if image is not None:
                return image

    return None


def analyze_material(material: object, blend_dir: Path, report: ExportReport) -> MaterialAnalysis:
    analysis = MaterialAnalysis(name=material.name, status='ready')
    principled = find_principled_node(material)
    if principled is None:
        analysis.status = 'bake-required'
        analysis.notes.append('Material is not using a Principled BSDF node tree.')
        return analysis

    base_socket = principled.inputs.get('Base Color')
    normal_socket = principled.inputs.get('Normal')
    roughness_socket = principled.inputs.get('Roughness')
    metallic_socket = principled.inputs.get('Metallic')
    emissive_socket = principled.inputs.get('Emission Color') or principled.inputs.get('Emission')

    analysis.base_color_image = trace_image_from_socket(base_socket)
    analysis.normal_image = trace_image_from_socket(normal_socket)
    analysis.roughness_image = trace_image_from_socket(roughness_socket)
    analysis.metallic_image = trace_image_from_socket(metallic_socket)
    analysis.emissive_image = trace_image_from_socket(emissive_socket)

    if material.node_tree is not None:
        for node in material.node_tree.nodes:
            if node.type != 'TEX_IMAGE' or getattr(node, 'image', None) is None:
                continue
            hints = resolve_texture_hints(node.image.name + ' ' + node.name + ' ' + getattr(node, 'label', ''))
            if analysis.orm_image is None and 'orm' in hints:
                analysis.orm_image = node.image
            if analysis.ao_image is None and 'ao' in hints:
                analysis.ao_image = node.image

            image_path = resolve_image_path(node.image)
            if image_path is not None and image_path.exists():
                try:
                    image_path.relative_to(blend_dir)
                except ValueError:
                    report.warn(
                        f'Material "{material.name}" references an external texture outside the blend folder: {image_path}'
                    )

    if analysis.base_color_image is None:
        analysis.missing.append('base_color')
    if analysis.roughness_image is None and analysis.orm_image is None:
        analysis.missing.append('roughness')
    if analysis.metallic_image is None and analysis.orm_image is None:
        analysis.missing.append('metallic')

    if analysis.base_color_image is None and not analysis.orm_image and not analysis.normal_image:
        analysis.status = 'bake-required'
    elif analysis.missing:
        analysis.status = 'partial'

    return analysis


def describe_image_reference(image: object | None) -> str:
    if image is None:
        return 'none'

    image_path = resolve_image_path(image)
    if image_path is None:
        return image.name
    return f'{image.name} ({image_path.name})'


def log_material_analysis_details(analysis_cache: dict[str, MaterialAnalysis], report: ExportReport) -> None:
    report.info('Material analysis details:')
    for material_name in sorted(analysis_cache.keys()):
        analysis = analysis_cache[material_name]
        report.info(
            '  '
            f'{analysis.name}: status={analysis.status}; '
            f'missing={", ".join(analysis.missing) if analysis.missing else "none"}; '
            f'base_color={describe_image_reference(analysis.base_color_image)}; '
            f'normal={describe_image_reference(analysis.normal_image)}; '
            f'roughness={describe_image_reference(analysis.roughness_image)}; '
            f'metallic={describe_image_reference(analysis.metallic_image)}; '
            f'ao={describe_image_reference(analysis.ao_image)}; '
            f'emissive={describe_image_reference(analysis.emissive_image)}; '
            f'orm={describe_image_reference(analysis.orm_image)}'
        )
        if analysis.notes:
            for note in analysis.notes:
                report.info(f'    note: {note}')


def describe_object_materials(object_: object) -> str:
    materials = [slot.material.name for slot in object_.material_slots if slot.material is not None]
    if not materials:
        return 'none'
    return ', '.join(materials)


def log_object_analysis_details(
    mesh_objects: list[object],
    bundles: dict[str, MeshBundle],
    report: ExportReport,
) -> None:
    report.info('Object analysis details:')
    for object_ in sorted(mesh_objects, key=lambda item: item.name):
        match = LOD_SUFFIX_PATTERN.match(object_.name)
        bundle_name = match.group('base') if match else object_.name
        bundle = bundles.get(bundle_name)
        bundle_lods = sorted(bundle.existing_lods.keys()) if bundle is not None else []
        lod_label = f'LOD{match.group("level")}' if match else 'source'
        report.info(
            '  '
            f'{object_.name}: role={lod_label}; '
            f'bundle={bundle_name}; '
            f'available_lods={", ".join(f"LOD{level}" for level in bundle_lods) if bundle_lods else "generated-from-source"}; '
            f'materials={describe_object_materials(object_)}'
        )


def resolve_image_path(image: object) -> Path | None:
    filepath = getattr(image, 'filepath', '')
    if not filepath:
        return None
    resolved = bpy.path.abspath(filepath)
    return Path(resolved).resolve()


def compute_scaled_dimensions(image: object, target_size: int) -> tuple[int, int]:
    width = max(int(image.size[0]), 1)
    height = max(int(image.size[1]), 1)
    longest = max(width, height)
    if longest <= target_size:
        return width, height
    scale = target_size / float(longest)
    return max(1, int(width * scale)), max(1, int(height * scale))


def create_image_variant(
    source_image: object,
    target_dir: Path,
    stem: str,
    target_size: int,
    temp_images: list[object],
    report: ExportReport,
) -> object | None:
    width, height = compute_scaled_dimensions(source_image, target_size)
    ensure_directory(target_dir)
    target_path = target_dir / f'{stem}.png'

    image_copy = source_image.copy()
    temp_images.append(image_copy)
    if image_copy.size[0] != width or image_copy.size[1] != height:
        image_copy.scale(width, height)
    image_copy.file_format = 'PNG'
    image_copy.filepath_raw = str(target_path)
    try:
        image_copy.save()
        loaded = bpy.data.images.load(str(target_path), check_existing=True)
        temp_images.append(loaded)
        return loaded
    except RuntimeError as error:
        report.warn(f'Failed to write resized texture "{target_path.name}": {error}')
        return None


def ensure_non_color(image: object) -> None:
    if hasattr(image, 'colorspace_settings'):
        try:
            image.colorspace_settings.name = 'Non-Color'
        except TypeError:
            pass


def build_scaled_pixel_source(image: object, width: int, height: int, temp_images: list[object]) -> object:
    scaled = image.copy()
    temp_images.append(scaled)
    if scaled.size[0] != width or scaled.size[1] != height:
        scaled.scale(width, height)
    return scaled


def create_orm_image(
    analysis: MaterialAnalysis,
    target_dir: Path,
    stem: str,
    target_size: int,
    temp_images: list[object],
    report: ExportReport,
) -> object | None:
    if analysis.orm_image is not None:
        return create_image_variant(analysis.orm_image, target_dir, stem, target_size, temp_images, report)

    source_images = [image for image in (analysis.ao_image, analysis.roughness_image, analysis.metallic_image) if image is not None]
    if not source_images:
        return None

    width, height = compute_scaled_dimensions(source_images[0], target_size)
    ao_source = build_scaled_pixel_source(analysis.ao_image, width, height, temp_images) if analysis.ao_image else None
    rough_source = build_scaled_pixel_source(analysis.roughness_image, width, height, temp_images) if analysis.roughness_image else None
    metallic_source = build_scaled_pixel_source(analysis.metallic_image, width, height, temp_images) if analysis.metallic_image else None

    output = bpy.data.images.new(name=f'{stem}_ORM', width=width, height=height, alpha=False)
    temp_images.append(output)
    ensure_non_color(output)

    pixel_count = width * height
    pixels = [1.0] * (pixel_count * 4)
    ao_pixels = list(ao_source.pixels[:]) if ao_source else None
    rough_pixels = list(rough_source.pixels[:]) if rough_source else None
    metallic_pixels = list(metallic_source.pixels[:]) if metallic_source else None

    for index in range(pixel_count):
        offset = index * 4
        pixels[offset] = ao_pixels[offset] if ao_pixels else 1.0
        pixels[offset + 1] = rough_pixels[offset] if rough_pixels else 1.0
        pixels[offset + 2] = metallic_pixels[offset] if metallic_pixels else 0.0
        pixels[offset + 3] = 1.0

    output.pixels = pixels
    output.file_format = 'PNG'
    ensure_directory(target_dir)
    target_path = target_dir / f'{stem}.png'
    output.filepath_raw = str(target_path)
    try:
        output.save()
        loaded = bpy.data.images.load(str(target_path), check_existing=True)
        temp_images.append(loaded)
        ensure_non_color(loaded)
        return loaded
    except RuntimeError as error:
        report.warn(f'Failed to write packed ORM texture "{target_path.name}": {error}')
        return None


def duplicate_materials_for_object(
    object_copy: object,
    quality: QualityPlan,
    material_cache: dict[tuple[str, str], object],
    analysis_cache: dict[str, MaterialAnalysis],
    staging_dir: Path,
    temp_images: list[object],
    report: ExportReport,
) -> None:
    for index, slot in enumerate(object_copy.material_slots):
        source_material = slot.material
        if source_material is None:
            continue

        cache_key = (source_material.name_full, quality.label)
        cached_material = material_cache.get(cache_key)
        if cached_material is not None:
            object_copy.material_slots[index].material = cached_material
            continue

        material_copy = source_material.copy()
        material_cache[cache_key] = material_copy
        object_copy.material_slots[index].material = material_copy
        analysis = analysis_cache.get(source_material.name_full)
        if analysis is None or not material_copy.use_nodes or material_copy.node_tree is None:
            continue

        for node in material_copy.node_tree.nodes:
            if node.type != 'TEX_IMAGE' or getattr(node, 'image', None) is None:
                continue
            image_variant = create_image_variant(
                node.image,
                staging_dir / quality.label,
                f'{slugify(material_copy.name)}_{slugify(node.name)}',
                quality.texture_size,
                temp_images,
                report,
            )
            if image_variant is not None:
                node.image = image_variant

        orm_variant = create_orm_image(
            analysis,
            staging_dir / quality.label,
            f'{slugify(material_copy.name)}_orm',
            quality.texture_size,
            temp_images,
            report,
        )
        if orm_variant is not None:
            attach_orm_nodes(material_copy, orm_variant, report)


def attach_orm_nodes(material: object, orm_image: object, report: ExportReport) -> None:
    if material.node_tree is None:
        return
    principled = find_principled_node(material)
    if principled is None:
        return

    node_tree = material.node_tree
    tex_node = node_tree.nodes.new('ShaderNodeTexImage')
    tex_node.name = 'Testbed ORM'
    tex_node.label = 'Testbed ORM'
    tex_node.image = orm_image
    ensure_non_color(orm_image)

    separate_node = node_tree.nodes.new('ShaderNodeSeparateColor')
    separate_node.name = 'Testbed ORM Separate'
    separate_node.label = 'Testbed ORM Separate'

    tex_node.location = (principled.location.x - 500, principled.location.y - 250)
    separate_node.location = (principled.location.x - 250, principled.location.y - 250)
    node_tree.links.new(tex_node.outputs['Color'], separate_node.inputs['Color'])
    node_tree.links.new(separate_node.outputs['Green'], principled.inputs['Roughness'])
    node_tree.links.new(separate_node.outputs['Blue'], principled.inputs['Metallic'])

    gltf_output = next(
        (
            node
            for node in node_tree.nodes
            if node.type == 'GROUP' and getattr(node.node_tree, 'name', '') == 'glTF Material Output'
        ),
        None,
    )
    if gltf_output is not None and 'Occlusion' in gltf_output.inputs:
        node_tree.links.new(separate_node.outputs['Red'], gltf_output.inputs['Occlusion'])
    else:
        report.warn(
            f'Material "{material.name}" received a packed ORM texture, but no glTF Material Output node was found for AO export.'
        )


def duplicate_object_for_quality(
    source_object: object,
    quality: QualityPlan,
    generated: bool,
    material_cache: dict[tuple[str, str], object],
    analysis_cache: dict[str, MaterialAnalysis],
    staging_dir: Path,
    temp_images: list[object],
    report: ExportReport,
) -> object:
    object_copy = source_object.copy()
    object_copy.data = source_object.data.copy()
    object_copy.animation_data_clear()
    object_copy.parent = None
    object_copy.matrix_world = source_object.matrix_world.copy()

    base_name_match = LOD_SUFFIX_PATTERN.match(source_object.name)
    base_name = base_name_match.group('base') if base_name_match else source_object.name
    object_copy.name = f'{base_name}_LOD{quality.level}'

    if generated and quality.decimate_ratio is not None:
        modifier = object_copy.modifiers.new(name='TestbedDecimate', type='DECIMATE')
        modifier.ratio = quality.decimate_ratio
        modifier.use_collapse_triangulate = True

    duplicate_materials_for_object(
        object_copy,
        quality,
        material_cache,
        analysis_cache,
        staging_dir,
        temp_images,
        report,
    )
    return object_copy


@contextmanager
def preserve_selection() -> object:
    previous_selection = list(bpy.context.selected_objects)
    previous_active = bpy.context.view_layer.objects.active
    try:
        yield
    finally:
        bpy.ops.object.select_all(action='DESELECT')
        for object_ in previous_selection:
            if object_.name in bpy.context.scene.objects:
                object_.select_set(True)
        if previous_active and previous_active.name in bpy.context.scene.objects:
            bpy.context.view_layer.objects.active = previous_active


def export_glb(filepath: Path, report: ExportReport) -> None:
    base_kwargs = {
        'filepath': str(filepath),
        'export_format': 'GLB',
        'use_selection': True,
        'export_apply': True,
        'export_tangents': True,
        'export_materials': 'EXPORT',
        'export_image_format': 'AUTO',
    }

    draco_kwargs = {
        'export_draco_mesh_compression_enable': True,
        'export_draco_mesh_compression_level': 6,
        'export_draco_position_quantization': 14,
        'export_draco_normal_quantization': 10,
        'export_draco_texcoord_quantization': 12,
        'export_draco_color_quantization': 10,
        'export_draco_generic_quantization': 12,
    }

    try:
        bpy.ops.export_scene.gltf(**base_kwargs, **draco_kwargs)
    except TypeError as error:
        report.warn(f'Draco export settings were not accepted by Blender; retrying without Draco. Detail: {error}')
        bpy.ops.export_scene.gltf(**base_kwargs)


def build_quality_objects(
    bundles: dict[str, MeshBundle],
    quality: QualityPlan,
    material_cache: dict[tuple[str, str], object],
    analysis_cache: dict[str, MaterialAnalysis],
    staging_dir: Path,
    temp_images: list[object],
    report: ExportReport,
) -> list[object]:
    quality_objects: list[object] = []
    for bundle in bundles.values():
        source_object, generated = bundle.resolve_for_level(quality.level)
        if source_object is None:
            report.warn(f'No mesh source could be resolved for base object "{bundle.base_name}" at LOD{quality.level}.')
            continue
        quality_objects.append(
            duplicate_object_for_quality(
                source_object,
                quality,
                generated,
                material_cache,
                analysis_cache,
                staging_dir,
                temp_images,
                report,
            )
        )
    return quality_objects


def cleanup_temp_images(temp_images: list[object]) -> None:
    for image in reversed(temp_images):
        try:
            if getattr(image, 'users', 0) == 0:
                bpy.data.images.remove(image)
        except RuntimeError:
            continue


def cleanup_temp_objects(temp_collection: object, temp_objects: list[object], material_cache: dict[tuple[str, str], object]) -> None:
    for object_ in temp_objects:
        data_block = getattr(object_, 'data', None)
        try:
            bpy.data.objects.remove(object_, do_unlink=True)
        except RuntimeError:
            continue
        if data_block is not None and getattr(data_block, 'users', 0) == 0:
            try:
                bpy.data.meshes.remove(data_block)
            except RuntimeError:
                pass

    for material in set(material_cache.values()):
        try:
            if material.users == 0:
                bpy.data.materials.remove(material)
        except RuntimeError:
            continue

    try:
        bpy.context.scene.collection.children.unlink(temp_collection)
    except RuntimeError:
        pass
    try:
        bpy.data.collections.remove(temp_collection)
    except RuntimeError:
        pass


def analyze_materials(mesh_objects: list[object], blend_dir: Path, report: ExportReport) -> dict[str, MaterialAnalysis]:
    analyses: dict[str, MaterialAnalysis] = {}
    for object_ in mesh_objects:
        for slot in object_.material_slots:
            material = slot.material
            if material is None or material.name_full in analyses:
                continue
            analyses[material.name_full] = analyze_material(material, blend_dir, report)
    return analyses


def detect_environment_image(report: ExportReport) -> Path | None:
    world = bpy.context.scene.world
    if world is None or not world.use_nodes or world.node_tree is None:
        return None

    for node in world.node_tree.nodes:
        if node.type != 'TEX_ENVIRONMENT' or getattr(node, 'image', None) is None:
            continue
        image_path = resolve_image_path(node.image)
        if image_path is None or not image_path.exists():
            report.warn(f'World environment image for node "{node.name}" is missing on disk and will be skipped.')
            return None
        if image_path.suffix.lower() not in {'.hdr', '.exr'}:
            report.warn(f'World environment image "{image_path.name}" is not HDR or EXR and will be skipped.')
            return None
        return image_path

    report.warn('No Environment Texture node was found in the active World; the runtime will fall back to /monochrome_studio_03_1k.hdr.')
    return None


def copy_environment_image(environment_path: Path | None, paths: ExportPaths, report: ExportReport) -> str | None:
    if environment_path is None:
        return None
    target_path = paths.hdr_dir / environment_path.name
    shutil.copy2(environment_path, target_path)
    report.summary(f'Copied environment map to {target_path}')
    return relative_manifest_path(target_path, paths.manifest_path)


def render_thumbnail(paths: ExportPaths, size: int, report: ExportReport) -> None:
    scene = bpy.context.scene
    render = scene.render
    previous_settings = {
        'filepath': render.filepath,
        'image_settings_file_format': render.image_settings.file_format,
        'resolution_x': render.resolution_x,
        'resolution_y': render.resolution_y,
        'resolution_percentage': render.resolution_percentage,
    }

    try:
        render.filepath = str(paths.thumbnail_path)
        render.image_settings.file_format = 'PNG'
        render.resolution_x = size
        render.resolution_y = size
        render.resolution_percentage = 100
        bpy.ops.render.render(write_still=True)
        report.summary(f'Rendered thumbnail to {paths.thumbnail_path}')
    finally:
        render.filepath = previous_settings['filepath']
        render.image_settings.file_format = previous_settings['image_settings_file_format']
        render.resolution_x = previous_settings['resolution_x']
        render.resolution_y = previous_settings['resolution_y']
        render.resolution_percentage = previous_settings['resolution_percentage']


class AutoBake2Adapter:
    def __init__(self, report: ExportReport) -> None:
        self.report = report
        self.scene = bpy.context.scene
        self.status = self._detect_status()

    def _detect_status(self) -> AutoBakeStatus:
        module_spec = importlib.util.find_spec('bl_ext.user_default.auto_bake')
        autobake_ops = getattr(bpy.ops, 'autobake', None)
        operators_available = autobake_ops is not None and all(
            hasattr(autobake_ops, operator_name)
            for operator_name in (
                'load_source',
                'load_target',
                'list_add',
                'start',
                'confirm',
                'export',
                'rebake',
                'rebake_object',
            )
        )

        property_roots = {
            property_name: hasattr(self.scene, property_name)
            for property_name in (
                'autobake_bake_list',
                'autobake_element_list',
                'autobake_properties',
                'autobake_source_list',
                'autobake_tile_list',
                'autobake_results',
            )
        }
        status = AutoBakeStatus(
            installed=module_spec is not None,
            operators_available=operators_available,
            property_roots=property_roots,
        )

        if status.installed and not status.operators_available:
            status.warnings.append('Auto Bake 2 appears installed, but bpy.ops.autobake is missing expected operators.')
        if status.operators_available and not all(property_roots.values()):
            status.warnings.append('Auto Bake 2 operators exist, but one or more expected scene property roots are missing.')
        return status

    def describe(self) -> None:
        if self.status.installed:
            self.report.summary('Detected Auto Bake 2 add-on module bl_ext.user_default.auto_bake.')
        else:
            self.report.summary('Auto Bake 2 add-on module was not detected.')

        if self.status.operators_available:
            self.report.summary('Verified bpy.ops.autobake operator namespace.')

        for warning in self.status.warnings:
            self.report.warn(warning)

    def can_run(self) -> bool:
        return self.status.installed and self.status.operators_available

    def _select_objects(self, objects: list[object]) -> None:
        bpy.ops.object.select_all(action='DESELECT')
        for object_ in objects:
            object_.select_set(True)
        if objects:
            bpy.context.view_layer.objects.active = objects[0]

    def configure_session(self, source_objects: list[object], target_objects: list[object]) -> bool:
        if not self.can_run():
            return False

        try:
            with preserve_selection():
                self._select_objects(source_objects)
                bpy.ops.autobake.load_source(clear=True)

                self._select_objects(target_objects)
                bpy.ops.autobake.load_target(method='Target', clear=True)

                bpy.ops.autobake.list_add(
                    use_ctrl=False,
                    iteration=2,
                    scale_method='Multiply',
                    multiply_value=2.0,
                    divide_value=2.0,
                )
            self.status.used = True
            self.report.summary('Auto Bake 2 populated source, target, and bake list state.')
            return True
        except Exception as error:
            self.status.errors.append(str(error))
            self.report.warn(f'Auto Bake 2 session setup failed: {error}')
            return False

    def start_session(self) -> bool:
        if not self.can_run():
            return False
        try:
            bpy.ops.autobake.start(rebake=False, index=0, object=False, start_none=False)
            self.status.used = True
            self.report.summary('Auto Bake 2 start operator completed.')
        except Exception as error:
            self.status.errors.append(str(error))
            self.report.warn(f'Auto Bake 2 start operator failed: {error}')
            return False

        try:
            bpy.ops.autobake.confirm(swap_object='Baked', do_swap=False)
            self.report.summary('Auto Bake 2 confirm operator completed.')
        except Exception as error:
            self.report.warn(f'Auto Bake 2 confirm operator was not required or failed safely: {error}')
        return True

    def verify(self, source_objects: list[object], target_objects: list[object]) -> None:
        if not self.can_run():
            self.report.warn('Auto Bake 2 verification was requested, but the add-on is not available.')
            return
        if not self.configure_session(source_objects, target_objects):
            self.report.warn('Auto Bake 2 verification could not configure a bake session.')
            return
        self.start_session()


def export_quality_level(
    quality: QualityPlan,
    bundles: dict[str, MeshBundle],
    analysis_cache: dict[str, MaterialAnalysis],
    staging_dir: Path,
    report: ExportReport,
) -> bool:
    material_cache: dict[tuple[str, str], object] = {}
    temp_images: list[object] = []
    temp_collection = bpy.data.collections.new(f'__TESTBED_EXPORT_{quality.label.upper()}')
    bpy.context.scene.collection.children.link(temp_collection)

    quality_objects = build_quality_objects(
        bundles,
        quality,
        material_cache,
        analysis_cache,
        staging_dir,
        temp_images,
        report,
    )
    if not quality_objects:
        cleanup_temp_images(temp_images)
        cleanup_temp_objects(temp_collection, quality_objects, material_cache)
        return False

    for object_ in quality_objects:
        temp_collection.objects.link(object_)

    try:
        ensure_directory(quality.glb_path.parent)
        with preserve_selection():
            bpy.ops.object.select_all(action='DESELECT')
            for object_ in quality_objects:
                object_.select_set(True)
            bpy.context.view_layer.objects.active = quality_objects[0]
            export_glb(quality.glb_path, report)
        report.summary(f'Exported {quality.label} GLB to {quality.glb_path}')
        return True
    finally:
        cleanup_temp_images(temp_images)
        cleanup_temp_objects(temp_collection, quality_objects, material_cache)


def build_manifest(
    package_name: str,
    display_name: str,
    paths: ExportPaths,
    initial_camera_position: list[float],
    initial_control_target: list[float],
    environment_path: str | None,
) -> dict[str, object]:
    manifest: dict[str, object] = {
        'name': package_name,
        'displayName': display_name,
        'thumbnail': relative_manifest_path(paths.thumbnail_path, paths.manifest_path),
        'lods': [
            relative_manifest_path(paths.high_glb_path, paths.manifest_path),
            relative_manifest_path(paths.medium_glb_path, paths.manifest_path),
            relative_manifest_path(paths.low_glb_path, paths.manifest_path),
        ],
        'initialCameraPosition': initial_camera_position,
        'initialControlTarget': initial_control_target,
    }
    if environment_path is not None:
        manifest['environment'] = environment_path
    return manifest


def write_manifest(manifest: dict[str, object], paths: ExportPaths, report: ExportReport) -> None:
    with paths.manifest_path.open('w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2)
        handle.write('\n')
    report.summary(f'Wrote manifest to {paths.manifest_path}')


def build_index_snippet(package_name: str, display_name: str) -> str:
    snippet = {
        'id': package_name,
        'displayName': display_name,
        'manifestUrl': f'collections/{package_name}/manifest.json',
    }
    return json.dumps(snippet, indent=2)


def write_report_file(
    paths: ExportPaths,
    package_name: str,
    display_name: str,
    manifest: dict[str, object],
    index_snippet: str,
    report: ExportReport,
    autobake_status: AutoBakeStatus,
    executed_stages: tuple[str, ...],
) -> None:
    lines = [
        'Three.js Graphics Testbed Blender export report',
        f'Script version: {SCRIPT_VERSION}',
        f'Collection id: {package_name}',
        f'Display name: {display_name}',
        f'Manifest path: {paths.manifest_path}',
        f'Executed stages: {", ".join(executed_stages)}',
        '',
        'Outputs',
        f'- {paths.high_glb_path}',
        f'- {paths.medium_glb_path}',
        f'- {paths.low_glb_path}',
        f'- {paths.thumbnail_path}',
        '',
        'Manifest',
        json.dumps(manifest, indent=2),
        '',
        'Auto Bake 2',
        f'- Installed: {autobake_status.installed}',
        f'- Operators available: {autobake_status.operators_available}',
        f'- Used: {autobake_status.used}',
    ]

    if report.warnings:
        lines.extend(['', 'Warnings'])
        lines.extend(f'- {warning}' for warning in report.warnings)
    if autobake_status.errors:
        lines.extend(['', 'Auto Bake 2 errors'])
        lines.extend(f'- {error}' for error in autobake_status.errors)

    lines.extend(
        [
            '',
            'Collections index entry',
            index_snippet,
            '',
            'Manual next step',
            'Copy this generated collection folder into the Angular app public/collections/ directory yourself.',
            '',
            'KTX2 guidance',
            'KTX2 conversion is a separate post-export step.',
            'Install KTX-Software so toktx is available on PATH.',
            'Install Node.js and the glTF Transform CLI.',
            'Example commands after toktx is available:',
            f'- gltf-transform etc1s {paths.high_glb_path.name} {paths.high_glb_path.stem}_etc1s.glb',
            f'- gltf-transform uastc {paths.high_glb_path.name} {paths.high_glb_path.stem}_uastc.glb',
            'Alternative meshoptimizer path:',
            f'- gltfpack -tc -i {paths.high_glb_path.name} -o {paths.high_glb_path.stem}_gltfpack.glb',
        ]
    )

    with paths.report_path.open('w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines) + '\n')
    report.summary(f'Wrote export report to {paths.report_path}')


def print_console_summary(paths: ExportPaths, index_snippet: str, report: ExportReport) -> None:
    report.info('Paste this into public/collections-index.json manually:')
    report.info(index_snippet)
    report.info('For KTX2 conversion after install:')
    report.info(f'  gltf-transform etc1s {paths.high_glb_path.name} {paths.high_glb_path.stem}_etc1s.glb')
    report.info(f'  gltf-transform uastc {paths.high_glb_path.name} {paths.high_glb_path.stem}_uastc.glb')
    report.info(f'  gltfpack -tc -i {paths.high_glb_path.name} -o {paths.high_glb_path.stem}_gltfpack.glb')
    report.summary('\n=== Three.js Graphics Testbed Export Summary ===')
    report.summary(f'Package root: {paths.package_root}')
    report.summary(f'Manifest: {paths.manifest_path}')
    report.summary(f'Collections index snippet saved in the detailed log: {report.log_path}')
    report.summary('Copy the generated collection folder into public/collections/ manually before local testing.')
    report.summary('See the detailed log for the index snippet, KTX2 command examples, and full warnings.')


def execute_export(config: ExportConfig) -> dict[str, object]:
    requested_stages = resolve_requested_stages(config)
    report = ExportReport(log_path=resolve_log_path(config))
    report.summary(f'Starting Three.js Graphics Testbed collection export script v{SCRIPT_VERSION}.')
    report.summary(f'Executing stages: {", ".join(requested_stages)}')
    if report.log_path is not None:
        report.summary(f'Detailed log file: {report.log_path}')

    blend_path = Path(bpy.data.filepath).resolve() if bpy.data.filepath else None
    try:
        stage_state: dict[str, object] = {
            'source_collection': None,
            'package_name': None,
            'display_name': None,
            'mesh_objects': None,
            'paths': None,
            'initial_camera_position': None,
            'initial_control_target': None,
            'analysis_cache': None,
            'bundles': None,
            'quality_plans': None,
            'autobake': None,
            'bake_required_materials': None,
        }

        def inspect_stage() -> None:
            source_collection, package_name, display_name = resolve_source_collection(config, report)
            mesh_objects = validate_scene(source_collection, report)
            assert blend_path is not None
            paths = build_output_paths(blend_path, package_name, config)
            create_package_layout(paths)
            initial_camera_position, initial_control_target = derive_initial_view(
                mesh_objects,
                source_collection,
                package_name,
            )
            report.info(f'Using source collection "{source_collection.name}" and package id "{package_name}".')
            stage_state.update(
                {
                    'source_collection': source_collection,
                    'package_name': package_name,
                    'display_name': display_name,
                    'mesh_objects': mesh_objects,
                    'paths': paths,
                    'initial_camera_position': initial_camera_position,
                    'initial_control_target': initial_control_target,
                }
            )
            report.summary(
                f'Inspect summary: collection="{source_collection.name}", visible meshes={len(mesh_objects)}, package id="{package_name}".'
            )

        def analyze_stage() -> None:
            mesh_objects = stage_state['mesh_objects']
            assert blend_path is not None
            analysis_cache = analyze_materials(mesh_objects, blend_path.parent, report)
            bundles = build_mesh_bundles(mesh_objects)
            quality_plans = build_quality_plans(stage_state['paths'], config)
            autobake = AutoBake2Adapter(report)
            autobake.describe()
            bake_required_materials = [
                analysis for analysis in analysis_cache.values() if analysis.status == 'bake-required'
            ]
            report.summary(
                'Material analysis summary: '
                f'{sum(1 for analysis in analysis_cache.values() if analysis.status == "ready")} ready, '
                f'{sum(1 for analysis in analysis_cache.values() if analysis.status == "partial")} partial, '
                f'{len(bake_required_materials)} bake-required.'
            )
            report.summary(f'LOD bundle count: {len(bundles)}')
            log_material_analysis_details(analysis_cache, report)
            log_object_analysis_details(mesh_objects, bundles, report)
            stage_state.update(
                {
                    'analysis_cache': analysis_cache,
                    'bundles': bundles,
                    'quality_plans': quality_plans,
                    'autobake': autobake,
                    'bake_required_materials': bake_required_materials,
                }
            )

        def bake_stage() -> None:
            autobake = stage_state['autobake']
            mesh_objects = stage_state['mesh_objects']
            bake_required_materials = stage_state['bake_required_materials']
            if config.verify_autobake_adapter:
                autobake.verify(mesh_objects[:1], mesh_objects[:1])
                return
            if bake_required_materials and config.bake_behavior in {'auto', 'autobake'}:
                report.warn(
                    'Some materials are procedural or incomplete. The script will attempt to configure Auto Bake 2, '
                    'but fully automatic baking still depends on the scene and add-on configuration.'
                )
                autobake.configure_session(mesh_objects, mesh_objects)
                autobake.start_session()
                return
            if bake_required_materials and config.bake_behavior == 'manual':
                report.warn(
                    'Some materials need baking. Manual or direct Blender bake fallback is still required for these node graphs.'
                )
                return
            report.summary('No bake action was required for the selected scene and bake settings.')

        def export_single_stage(stage_name: str) -> None:
            quality_lookup = {quality.label: quality for quality in stage_state['quality_plans']}
            quality = quality_lookup[stage_name.removeprefix('export-')]
            staging_dir = Path(tempfile.mkdtemp(prefix=f'{stage_state["package_name"]}_blendprep_'))
            try:
                if not export_quality_level(
                    quality,
                    stage_state['bundles'],
                    stage_state['analysis_cache'],
                    staging_dir,
                    report,
                ):
                    raise RuntimeError(f'The {quality.label} export stage did not produce any objects to export.')
            finally:
                shutil.rmtree(staging_dir, ignore_errors=True)

        def package_stage() -> None:
            paths = stage_state['paths']
            validate_packaging_inputs(paths)
            render_thumbnail(paths, config.thumbnail_size, report)
            environment_source = detect_environment_image(report)
            environment_manifest_path = copy_environment_image(environment_source, paths, report)
            manifest = build_manifest(
                stage_state['package_name'],
                stage_state['display_name'],
                paths,
                stage_state['initial_camera_position'],
                stage_state['initial_control_target'],
                environment_manifest_path,
            )
            write_manifest(manifest, paths, report)
            index_snippet = build_index_snippet(stage_state['package_name'], stage_state['display_name'])
            if config.write_report:
                write_report_file(
                    paths,
                    stage_state['package_name'],
                    stage_state['display_name'],
                    manifest,
                    index_snippet,
                    report,
                    stage_state['autobake'].status,
                    requested_stages,
                )
            print_console_summary(paths, index_snippet, report)

        if 'inspect' in requested_stages or any(
            stage_name in requested_stages
            for stage_name in ('analyze', 'bake', 'export-high', 'export-medium', 'export-low', 'package')
        ):
            run_stage('inspect', report, inspect_stage)

        if 'analyze' in requested_stages or any(
            stage_name in requested_stages
            for stage_name in ('bake', 'export-high', 'export-medium', 'export-low', 'package')
        ):
            run_stage('analyze', report, analyze_stage)

        if 'bake' in requested_stages:
            run_stage('bake', report, bake_stage)

        for export_stage_name in ('export-high', 'export-medium', 'export-low'):
            if export_stage_name in requested_stages:
                run_stage(
                    export_stage_name,
                    report,
                    lambda stage_name=export_stage_name: export_single_stage(stage_name),
                )

        if 'package' in requested_stages:
            run_stage('package', report, package_stage)

        return {
            'success': True,
            'requested_stages': requested_stages,
            'report': report,
            'package_name': stage_state['package_name'],
            'display_name': stage_state['display_name'],
            'paths': stage_state['paths'],
            'log_path': report.log_path,
            'autobake_status': stage_state['autobake'].status if stage_state['autobake'] is not None else None,
        }
    except Exception as error:
        if not report.errors:
            report.error(str(error))
        report.log_traceback()
        report.summary(f'Execution failed. See the detailed log: {report.log_path}')
        return {
            'success': False,
            'requested_stages': requested_stages,
            'report': report,
            'package_name': None,
            'display_name': None,
            'paths': None,
            'log_path': report.log_path,
            'autobake_status': None,
            'error': str(error),
        }


def store_last_export_result(result: dict[str, object]) -> None:
    namespace = getattr(builtins, 'testbed_export', None)
    if namespace is not None:
        namespace.last_result = result


def get_last_export_result() -> dict[str, object] | None:
    namespace = getattr(builtins, 'testbed_export', None)
    if namespace is None:
        return None
    return getattr(namespace, 'last_result', None)


def run_export_stages(*stage_names: str, echo_result: bool = False, **config_overrides: object) -> dict[str, object] | None:
    requested_stages = tuple(stage_names) if stage_names else ('all',)
    config = build_export_config(stages=requested_stages, **config_overrides)
    result = execute_export(config)
    store_last_export_result(result)
    print('Saved last export result to testbed_export.last_result.')
    if result.get('log_path') is not None:
        print(f'Detailed log file: {result["log_path"]}')
    if not result.get('success', False):
        print('The command finished with errors. See the detailed log for the full traceback and diagnostics.')
    if echo_result:
        return result
    return None


def run_export_stage(stage_name: str, echo_result: bool = False, **config_overrides: object) -> dict[str, object] | None:
    return run_export_stages(stage_name, echo_result=echo_result, **config_overrides)


def print_console_usage() -> None:
    print('Three.js Graphics Testbed export helpers are registered for Blender\'s Python console.')
    print('Run this script from the Scripting tab once, then use one of these commands in the Python console:')
    print('  list_testbed_export_stages()')
    print("  run_testbed_export_stage('inspect')")
    print("  run_testbed_export_stages('inspect', 'analyze')")
    print("  run_testbed_export_stage('bake', bake_behavior='manual')")
    print(r"  run_testbed_export_stage('inspect', log_path_override='F:/tmp/testbed-inspect.log')")
    print("  run_testbed_export_stages('export-high', 'export-medium', 'export-low')")
    print("  run_testbed_export_stage('package')")
    print('These helpers store the last result at testbed_export.last_result and do not echo it unless echo_result=True is passed.')
    print('Optional keyword arguments:')
    print('  collection_name_override, display_name_override, export_root_override,')
    print('  high_texture_size, medium_texture_size, low_texture_size,')
    print('  medium_decimate_ratio, low_decimate_ratio, thumbnail_size,')
    print('  bake_behavior, write_report, verify_autobake_adapter, log_path_override')


def register_console_helpers() -> SimpleNamespace:
    namespace = SimpleNamespace(
        help=print_console_usage,
        list_stages=print_stage_catalog,
        run_stage=run_export_stage,
        run_stages=run_export_stages,
        get_last_result=get_last_export_result,
        build_config=build_export_config,
        default_config=DEFAULT_CONFIG,
        last_result=None,
    )

    bpy.app.driver_namespace['testbed_export'] = namespace
    builtins.testbed_export = namespace
    builtins.testbed_export_help = print_console_usage
    builtins.list_testbed_export_stages = print_stage_catalog
    builtins.run_testbed_export_stage = run_export_stage
    builtins.run_testbed_export_stages = run_export_stages
    builtins.get_last_testbed_export_result = get_last_export_result
    builtins.build_testbed_export_config = build_export_config
    return namespace


def main() -> None:
    register_console_helpers()
    print_console_usage()


if __name__ == '__main__':
    main()