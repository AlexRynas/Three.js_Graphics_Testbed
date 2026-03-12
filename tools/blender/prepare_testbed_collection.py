from __future__ import annotations

import builtins
from datetime import datetime
import importlib.util
import json
import re
import shutil
import sys
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


SCRIPT_VERSION = '0.5.1'
SESSION_LOG_FILENAME_SUFFIX = '_prepare_testbed_collection_session.log'
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
    'repair',
    'bake',
    'export-high',
    'export-medium',
    'export-low',
    'package',
)
STAGE_DESCRIPTIONS = {
    'inspect': 'Resolve the source collection, validate scene prerequisites, create the output layout, derive initial camera metadata, and inspect materials, textures, LOD bundles, and Auto Bake 2 availability.',
    'repair': 'Automatically repair inspect-stage warnings by making linked assets local when possible, applying scale, generating UV maps, assigning default materials, and enabling World nodes.',
    'bake': 'Run Auto Bake 2 when needed, then complete the session through the add-on confirm flow.',
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


@dataclass(slots=True)
class StageRunState:
    async_complete: bool = False


@dataclass(slots=True)
class AutoBakeProgressSnapshot:
    bake_status: str
    object_counts: dict[str, int]
    queue_counts: dict[str, int]
    active_object: str | None
    active_item: str | None

    def signature(self) -> tuple[object, ...]:
        return (
            self.bake_status,
            tuple(sorted(self.object_counts.items())),
            tuple(sorted(self.queue_counts.items())),
            self.active_object,
            self.active_item,
        )


@dataclass(slots=True)
class AsyncStageMonitor:
    on_start: object
    on_poll: object


class ExportReport:
    def __init__(self, log_path: Path | None = None, reset_log: bool = False) -> None:
        self.messages: list[str] = []
        self.warnings: list[str] = []
        self.errors: list[str] = []
        self.log_path = log_path
        if self.log_path is not None:
            ensure_directory(self.log_path.parent)
            if reset_log or not self.log_path.exists():
                self.log_path.write_text('', encoding='utf-8')

    def _emit(self, message: str) -> None:
        if self.log_path is not None:
            with self.log_path.open('a', encoding='utf-8') as handle:
                handle.write(message)
                handle.write('\n')

    def capture_external_line(self, message: str) -> None:
        warning_match = re.match(r'^(?:WARNING:\s+|\d{2}:\d{2}:\d{2}\s+\|\s+WARNING:\s+)(.+)$', message)
        if warning_match is not None:
            self.warnings.append(warning_match.group(1).strip())

        error_match = re.match(
            r'^(?:ERROR:\s+|CRITICAL:\s+|\d{2}:\d{2}:\d{2}\s+\|\s+(?:ERROR|CRITICAL):\s+)(.+)$',
            message,
        )
        if error_match is not None:
            self.errors.append(error_match.group(1).strip())

        self._emit(message)

    def summary(self, message: str) -> None:
        print(message)
        self._emit(message)

    def system(self, message: str) -> None:
        stream = getattr(sys, '__stdout__', None)
        if stream is not None:
            stream.write(f'{message}\n')
            stream.flush()
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


class _ReportLogStream:
    def __init__(self, report: ExportReport) -> None:
        self.report = report
        self._buffer = ''

    def write(self, message: str) -> int:
        if not message:
            return 0

        self._buffer += message
        while '\n' in self._buffer:
            line, self._buffer = self._buffer.split('\n', 1)
            self.report.capture_external_line(line.rstrip('\r'))
        return len(message)

    def flush(self) -> None:
        if self._buffer:
            self.report.capture_external_line(self._buffer.rstrip('\r'))
            self._buffer = ''


@contextmanager
def capture_gltf_export_diagnostics(report: ExportReport) -> object:
    stream = _ReportLogStream(report)
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    debug_module = None
    original_messages = None

    try:
        sys.stdout = stream
        sys.stderr = stream

        try:
            debug_module = importlib.import_module('io_scene_gltf2.io.com.debug')
        except ImportError:
            debug_module = None

        if debug_module is not None:
            original_messages = debug_module.Log.messages
            debug_module.Log.messages = lambda self: []

        yield
    finally:
        if debug_module is not None and original_messages is not None:
            debug_module.Log.messages = original_messages
        stream.flush()
        sys.stdout = original_stdout
        sys.stderr = original_stderr


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


def resolve_default_session_log_path() -> Path:
    if bpy.data.filepath:
        blend_path = Path(bpy.data.filepath).resolve()
        return (blend_path.parent / 'export-logs' / f'{blend_path.stem}{SESSION_LOG_FILENAME_SUFFIX}').resolve()
    return (Path(tempfile.gettempdir()) / 'threejs_testbed_export_logs' / f'unsaved{SESSION_LOG_FILENAME_SUFFIX}').resolve()


def get_export_runtime_namespace() -> SimpleNamespace:
    namespace = getattr(builtins, 'testbed_export', None)
    if namespace is None:
        namespace = register_console_helpers()
    return namespace


def resolve_log_destination(config: ExportConfig) -> tuple[Path | None, bool]:
    if config.log_path_override:
        return Path(config.log_path_override).expanduser().resolve(), False

    namespace = get_export_runtime_namespace()
    session_log_path = getattr(namespace, 'session_log_path', None)
    if session_log_path is None:
        session_log_path = resolve_default_session_log_path()
        namespace.session_log_path = session_log_path
        return session_log_path, True
    return session_log_path, False


def write_run_separator(report: ExportReport, requested_stages: tuple[str, ...]) -> None:
    if report.log_path is None:
        return
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    report._emit('')
    report._emit('=' * 72)
    report._emit(
        f'Run started: {timestamp} | stages: {", ".join(requested_stages)} | script v{SCRIPT_VERSION}'
    )
    report._emit('=' * 72)


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


def start_async_stage_monitor(
    stage_name: str,
    report: ExportReport,
    snapshot: ReportSnapshot,
    monitor: AsyncStageMonitor,
) -> None:
    try:
        monitor.on_start(stage_name, report, snapshot)
    except Exception as error:
        report.error(f'Stage "{stage_name}" async monitor failed to start: {error}')
        raise


def run_stage(
    stage_name: str,
    report: ExportReport,
    callback: object,
    state: StageRunState | None = None,
) -> object:
    builtins._testbed_active_report = report
    print_stage_header(stage_name)
    snapshot = take_report_snapshot(report)
    try:
        result = callback()
        if isinstance(result, AsyncStageMonitor):
            start_async_stage_monitor(stage_name, report, snapshot, result)
            if state is not None:
                state.async_complete = True
            return result
        return result
    except Exception as error:
        report.error(f'Stage "{stage_name}" failed: {error}')
        raise
    finally:
        if not (state is not None and state.async_complete):
            print_stage_summary(stage_name, report, snapshot)
        if getattr(builtins, '_testbed_active_report', None) is report:
            del builtins._testbed_active_report


def slugify(value: str) -> str:
    normalized = re.sub(r'[^a-zA-Z0-9]+', '_', value.strip()).strip('_').lower()
    return normalized or 'collection'


def sanitize_package_name(value: str) -> str:
    normalized = re.sub(r'[^a-zA-Z0-9]+', '_', value.strip()).strip('_')
    return normalized or 'Collection'


def title_case_slug(value: str) -> str:
    return value.replace('_', ' ').replace('-', ' ').strip().title()


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def ensure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def relative_manifest_path(target_path: Path, manifest_path: Path) -> str:
    return target_path.relative_to(manifest_path.parent).as_posix()


def collect_images_from_node_tree(
    node_tree: object | None,
    images: dict[int, object],
    visited_trees: set[int] | None = None,
) -> None:
    if node_tree is None:
        return

    if visited_trees is None:
        visited_trees = set()

    tree_pointer = int(node_tree.as_pointer())
    if tree_pointer in visited_trees:
        return
    visited_trees.add(tree_pointer)

    for node in node_tree.nodes:
        image = getattr(node, 'image', None)
        if image is not None:
            images[int(image.as_pointer())] = image

        child_tree = getattr(node, 'node_tree', None)
        if child_tree is not None:
            collect_images_from_node_tree(child_tree, images, visited_trees)


def collect_scene_material_images() -> list[object]:
    images: dict[int, object] = {}
    for object_ in bpy.context.scene.objects:
        if getattr(object_, 'type', None) != 'MESH':
            continue
        for slot in object_.material_slots:
            material = slot.material
            if material is None or not getattr(material, 'use_nodes', False):
                continue
            collect_images_from_node_tree(material.node_tree, images)
    return list(images.values())


def infer_image_extension(image: object) -> str:
    format_name = str(getattr(image, 'file_format', '') or '').upper()
    extensions = {
        'BMP': '.bmp',
        'HDR': '.hdr',
        'JPEG': '.jpg',
        'JPEG2000': '.jp2',
        'OPEN_EXR': '.exr',
        'OPEN_EXR_MULTILAYER': '.exr',
        'PNG': '.png',
        'TARGA': '.tga',
        'TARGA_RAW': '.tga',
        'TIFF': '.tif',
        'WEBP': '.webp',
    }
    return extensions.get(format_name, '.png')


def resolve_image_save_path(image: object, fallback_dir: Path) -> Path:
    for attribute_name in ('filepath_raw', 'filepath'):
        raw_path = getattr(image, attribute_name, '')
        if raw_path:
            return Path(bpy.path.abspath(raw_path)).resolve()

    ensure_directory(fallback_dir)
    target_stem = sanitize_package_name(getattr(image, 'name', 'image'))
    target_path = fallback_dir / f'{target_stem}{infer_image_extension(image)}'
    suffix = 1
    while target_path.exists():
        target_path = fallback_dir / f'{target_stem}_{suffix}{infer_image_extension(image)}'
        suffix += 1
    return target_path


def save_dirty_material_images(report: ExportReport) -> int:
    if bpy.data.filepath:
        fallback_dir = Path(bpy.data.filepath).resolve().parent / 'autobake-images'
    else:
        fallback_dir = Path(tempfile.gettempdir()) / 'threejs_testbed_autobake_images'

    saved_images = 0
    for image in collect_scene_material_images():
        if not getattr(image, 'is_dirty', False):
            continue
        if getattr(image, 'type', '') in {'RENDER_RESULT', 'COMPOSITING'}:
            continue

        target_path = resolve_image_save_path(image, fallback_dir)
        ensure_directory(target_path.parent)

        if not getattr(image, 'filepath_raw', ''):
            image.filepath_raw = str(target_path)
        if not getattr(image, 'filepath', ''):
            image.filepath = str(target_path)
        if not getattr(image, 'file_format', ''):
            image.file_format = 'PNG'

        try:
            image.save()
            saved_images += 1
        except RuntimeError as error:
            report.warn(f'Failed to save baked image "{image.name}" to "{target_path}": {error}')

    if saved_images:
        report.summary(f'Saved {saved_images} dirty baked image(s) to disk.')
    else:
        report.summary('No dirty baked images needed saving after confirm.')
    return saved_images


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

    collection_id = config.collection_name_override or source_collection.name or Path(bpy.data.filepath).stem
    display_name = config.display_name_override or collection_id
    return source_collection, collection_id, display_name


def configure_cycles_gpu_render(report: ExportReport) -> None:
    scene = bpy.context.scene

    try:
        scene.render.engine = 'CYCLES'
    except TypeError as error:
        raise RuntimeError(f'Failed to switch the render engine to Cycles: {error}') from error

    cycles_settings = getattr(scene, 'cycles', None)
    if cycles_settings is None:
        raise RuntimeError('Cycles render settings are unavailable after switching the render engine to Cycles.')

    try:
        cycles_settings.device = 'GPU'
    except TypeError as error:
        raise RuntimeError(f'Failed to switch the Cycles device to GPU Compute: {error}') from error

    report.summary('Configured Blender render engine to Cycles with GPU Compute.')


def validate_scene(
    source_collection: object,
    report: ExportReport,
    emit_warnings: bool = True,
) -> list[object]:
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
        if emit_warnings and object_.library is not None:
            report.warn(f'Object "{object_.name}" is linked from an external library; export will use the evaluated object state.')

        if emit_warnings and any(abs(value - 1.0) > 0.0001 for value in object_.scale[:]):
            report.warn(
                f'Object "{object_.name}" has unapplied scale. '
                'Apply scale before export so generated LODs and bounds stay consistent.'
            )

        mesh = object_.data
        if emit_warnings and hasattr(mesh, 'uv_layers') and len(mesh.uv_layers) == 0:
            report.warn(f'Object "{object_.name}" has no UV map; baking and texture export may fail.')

        if emit_warnings and (not object_.material_slots or all(slot.material is None for slot in object_.material_slots)):
            report.warn(f'Object "{object_.name}" has no assigned material slots.')

    world = bpy.context.scene.world
    if emit_warnings and (world is None or not world.use_nodes or world.node_tree is None):
        report.warn('The active World does not use nodes; no HDR environment file will be emitted.')

    return mesh_objects


def object_has_unapplied_scale(object_: object) -> bool:
    return any(abs(value - 1.0) > 0.0001 for value in object_.scale[:])


def object_has_uv_warning(object_: object) -> bool:
    mesh = getattr(object_, 'data', None)
    return bool(mesh is not None and hasattr(mesh, 'uv_layers') and len(mesh.uv_layers) == 0)


def object_has_material_warning(object_: object) -> bool:
    return bool(not object_.material_slots or all(slot.material is None for slot in object_.material_slots))


@contextmanager
def activate_object(object_: object) -> object:
    with preserve_selection():
        active_object = bpy.context.view_layer.objects.active
        if active_object is not None and getattr(active_object, 'mode', 'OBJECT') != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        bpy.ops.object.select_all(action='DESELECT')
        object_.select_set(True)
        bpy.context.view_layer.objects.active = object_
        bpy.context.view_layer.update()
        try:
            yield
        finally:
            current_active = bpy.context.view_layer.objects.active
            if current_active is not None and getattr(current_active, 'mode', 'OBJECT') != 'OBJECT':
                bpy.ops.object.mode_set(mode='OBJECT')


def make_object_data_local(object_: object, report: ExportReport) -> object:
    if object_.library is None:
        return object_

    try:
        object_.make_local()
        if getattr(object_.data, 'library', None) is not None and hasattr(object_.data, 'make_local'):
            object_.data.make_local()
        for slot in object_.material_slots:
            material = slot.material
            if material is not None and getattr(material, 'library', None) is not None and hasattr(material, 'make_local'):
                material.make_local()
        report.summary(f'Made linked object "{object_.name}" local for repair operations.')
    except Exception as error:
        report.warn(f'Could not make linked object "{object_.name}" local automatically: {error}')
    return object_


def apply_object_scale(object_: object, report: ExportReport) -> bool:
    if not object_has_unapplied_scale(object_):
        return False

    with activate_object(object_):
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    report.summary(f'Applied scale for object "{object_.name}".')
    return True


def ensure_object_uv_map(object_: object, report: ExportReport) -> bool:
    if not object_has_uv_warning(object_):
        return False

    mesh = object_.data
    mesh.uv_layers.new(name='UVMap')
    try:
        with activate_object(object_):
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.smart_project()
            bpy.ops.object.mode_set(mode='OBJECT')
        report.summary(f'Generated a UV map for object "{object_.name}" with Smart UV Project.')
        return True
    except Exception as error:
        report.warn(f'Created a UV layer for object "{object_.name}", but Smart UV Project failed: {error}')
        return True


def ensure_object_material_slot(object_: object, report: ExportReport) -> bool:
    if not object_has_material_warning(object_):
        return False

    mesh = object_.data
    material = bpy.data.materials.get(f'{sanitize_package_name(object_.name)}_Material')
    if material is None:
        material = bpy.data.materials.new(name=f'{sanitize_package_name(object_.name)}_Material')
        material.use_nodes = True

    if len(object_.material_slots) == 0:
        mesh.materials.append(material)
    else:
        assigned = False
        for index, slot in enumerate(object_.material_slots):
            if slot.material is None:
                object_.material_slots[index].material = material
                assigned = True
                break
        if not assigned:
            mesh.materials.append(material)

    report.summary(f'Assigned default material "{material.name}" to object "{object_.name}".')
    return True


def ensure_world_uses_nodes(report: ExportReport) -> bool:
    scene = bpy.context.scene
    world = scene.world
    changed = False

    if world is None:
        world = bpy.data.worlds.new('TestbedWorld')
        scene.world = world
        changed = True

    if not world.use_nodes:
        world.use_nodes = True
        changed = True

    if world.node_tree is None:
        world.use_nodes = True
        changed = True

    if changed:
        report.summary(f'Enabled World nodes for "{world.name}".')
    return changed


def repair_scene_warnings(source_collection: object, report: ExportReport) -> dict[str, int]:
    mesh_objects = [
        object_
        for object_ in iter_collection_objects(source_collection)
        if object_.type == 'MESH' and not object_.hide_get()
    ]
    repairs = {
        'localized_objects': 0,
        'applied_scale': 0,
        'generated_uv_maps': 0,
        'assigned_materials': 0,
        'enabled_world_nodes': 0,
    }

    for object_ in mesh_objects:
        if object_.library is not None:
            previous_name = object_.name
            make_object_data_local(object_, report)
            if object_.library is None:
                repairs['localized_objects'] += 1
            elif object_.name != previous_name:
                repairs['localized_objects'] += 1

        if object_has_unapplied_scale(object_):
            if apply_object_scale(object_, report):
                repairs['applied_scale'] += 1

        if object_has_uv_warning(object_):
            if ensure_object_uv_map(object_, report):
                repairs['generated_uv_maps'] += 1

        if object_has_material_warning(object_):
            if ensure_object_material_slot(object_, report):
                repairs['assigned_materials'] += 1

    if ensure_world_uses_nodes(report):
        repairs['enabled_world_nodes'] += 1

    return repairs


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
    normalized = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', name)
    tokens = {
        token
        for token in re.split(r'[^a-z0-9]+', normalized.lower())
        if token
    }
    hits: set[str] = set()
    for key, fragments in IMAGE_NAME_HINTS.items():
        normalized_fragments = {
            re.sub(r'[^a-z0-9]+', '', fragment.lower())
            for fragment in fragments
        }
        if any(fragment in tokens for fragment in normalized_fragments):
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

        should_attach_orm = (
            analysis.orm_image is not None
            or analysis.ao_image is not None
            or analysis.roughness_image is None
            or analysis.metallic_image is None
        )
        if should_attach_orm:
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

    triangulate_modifier = object_copy.modifiers.new(name='TestbedTriangulate', type='TRIANGULATE')
    if hasattr(triangulate_modifier, 'keep_custom_normals'):
        triangulate_modifier.keep_custom_normals = True

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
        with capture_gltf_export_diagnostics(report):
            bpy.ops.export_scene.gltf(**base_kwargs, **draco_kwargs)
    except TypeError as error:
        report.warn(f'Draco export settings were not accepted by Blender; retrying without Draco. Detail: {error}')
        with capture_gltf_export_diagnostics(report):
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

    report.info('No Environment Texture node was found in the active World; the runtime will fall back to /monochrome_studio_03_1k.hdr.')
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
        self.module = self._load_module()
        self.status = self._detect_status()
        self.prepared_objects: list[object] = []
        self.previous_material_settings: dict[str, object] = {}
        self.previous_preference_settings: dict[str, object] = {}

    def _load_module(self) -> object | None:
        try:
            return importlib.import_module('bl_ext.user_default.auto_bake')
        except ImportError:
            return None

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

    def _read_bake_status(self) -> str:
        if self.module is not None and hasattr(self.module, 'bake_status'):
            value = getattr(self.module, 'bake_status')
            if isinstance(value, str) and value:
                return value
        return 'UNKNOWN'

    def _count_statuses(self, items: object) -> dict[str, int]:
        counts: dict[str, int] = {}
        for item in items or []:
            status = getattr(item, 'Status', None)
            if not status:
                continue
            counts[status] = counts.get(status, 0) + 1
        return counts

    def _active_object_name(self) -> str | None:
        object_queue = getattr(self.scene, 'autobake_object_queue_list', None)
        if object_queue is None:
            return None
        for item in object_queue:
            if getattr(item, 'Status', None) == 'Baking' and getattr(item, 'Object', None) is not None:
                return item.Object.name
        return None

    def _active_item_name(self) -> str | None:
        queue_list = getattr(self.scene, 'autobake_queue_list', None)
        if queue_list is None:
            return None
        for item in queue_list:
            if getattr(item, 'Status', None) != 'Baking':
                continue
            item_type = getattr(item, 'Type', 'Unknown')
            item_size = getattr(item, 'Size', 0)
            item_multiplier = getattr(item, 'Multiplier', 0.0)
            scale_label = f'{item_size}px' if item_size else f'{item_multiplier:.2f}x'
            return f'{item_type} ({scale_label})'
        return None

    def _capture_progress_snapshot(self) -> AutoBakeProgressSnapshot:
        object_queue = getattr(self.scene, 'autobake_object_queue_list', None)
        queue_list = getattr(self.scene, 'autobake_queue_list', None)
        return AutoBakeProgressSnapshot(
            bake_status=self._read_bake_status(),
            object_counts=self._count_statuses(object_queue),
            queue_counts=self._count_statuses(queue_list),
            active_object=self._active_object_name(),
            active_item=self._active_item_name(),
        )

    def _session_is_active(self, snapshot: AutoBakeProgressSnapshot) -> bool:
        if snapshot.bake_status not in {'IDLE', 'UNKNOWN'}:
            return True
        active_states = {'Pending', 'Baking'}
        return any(status in active_states for status in snapshot.object_counts) or any(
            status in active_states for status in snapshot.queue_counts
        )

    def _format_counts(self, counts: dict[str, int]) -> str:
        if not counts:
            return 'none'
        return ', '.join(f'{status}={count}' for status, count in sorted(counts.items()))

    def _log_progress_snapshot(self, snapshot: AutoBakeProgressSnapshot) -> None:
        details: list[str] = [
            f'bake_status={snapshot.bake_status}',
            f'objects[{self._format_counts(snapshot.object_counts)}]',
            f'items[{self._format_counts(snapshot.queue_counts)}]',
        ]
        if snapshot.active_object is not None:
            details.append(f'active_object="{snapshot.active_object}"')
        if snapshot.active_item is not None:
            details.append(f'active_item="{snapshot.active_item}"')
        self.report.system(f'Bake progress: {"; ".join(details)}')

    def create_progress_monitor(self) -> AsyncStageMonitor:
        adapter = self

        class BakeProgressMonitor:
            def __init__(self) -> None:
                self.last_signature: tuple[object, ...] | None = None
                self.finished = False

            def start(self, stage_name: str, report: ExportReport, snapshot: ReportSnapshot) -> None:
                namespace = get_export_runtime_namespace()
                namespace.autobake_stage_monitor = self
                report.summary(
                    'Auto Bake 2 session started. Progress will continue in the console and session log until the add-on returns to idle.'
                )
                self.poll(stage_name, report, snapshot)

            def poll(self, stage_name: str, report: ExportReport, snapshot: ReportSnapshot) -> float | None:
                if self.finished:
                    return None
                try:
                    current = adapter._capture_progress_snapshot()
                    signature = current.signature()
                    if signature != self.last_signature:
                        adapter._log_progress_snapshot(current)
                        self.last_signature = signature

                    if adapter._session_is_active(current):
                        return 0.5

                    report.summary('Auto Bake 2 session finished.')
                    adapter.finalize_bake_session()
                    print_stage_summary(stage_name, report, snapshot)
                    self.finished = True
                    namespace = get_export_runtime_namespace()
                    if getattr(namespace, 'autobake_stage_monitor', None) is self:
                        namespace.autobake_stage_monitor = None
                    return None
                except Exception as error:
                    report.error(f'Bake progress monitor failed: {error}')
                    report.log_traceback()
                    print_stage_summary(stage_name, report, snapshot)
                    self.finished = True
                    namespace = get_export_runtime_namespace()
                    if getattr(namespace, 'autobake_stage_monitor', None) is self:
                        namespace.autobake_stage_monitor = None
                    return None

        monitor = BakeProgressMonitor()

        def start_monitor(stage_name: str, report: ExportReport, snapshot: ReportSnapshot) -> None:
            monitor.start(stage_name, report, snapshot)
            bpy.app.timers.register(
                lambda: monitor.poll(stage_name, report, snapshot),
                first_interval=0.5,
            )

        return AsyncStageMonitor(
            on_start=start_monitor,
            on_poll=monitor.poll,
        )

    def ensure_bake_list(self, texture_size: int) -> bool:
        bake_list = getattr(self.scene, 'autobake_bake_list', None)
        properties = getattr(self.scene, 'autobake_properties', None)
        if bake_list is None or properties is None:
            self.status.errors.append('Auto Bake 2 bake-list properties are unavailable on the current scene.')
            self.report.warn('Auto Bake 2 session setup failed: bake-list properties are unavailable on the current scene.')
            return False

        if bake_list and any(item.Gate for item in bake_list):
            return True

        bake_list.clear()
        properties.ab_bake_list_item_count = 0
        properties.ab_channel_pack_r = 'Ambient Occlusion'
        properties.ab_channel_pack_g = 'Roughness'
        properties.ab_channel_pack_b = 'Metallic'

        for bake_type in ('Base Color', 'Normal', 'Channel Packing'):
            item = bake_list.add()
            item.Type = bake_type
            item.Size = texture_size
            item.Gate = True

        self.report.summary(
            f'Auto Bake 2 seeded the bake list with Base Color, Normal, and Channel Packing at {texture_size}px.'
        )
        return True

    def _select_objects(self, objects: list[object]) -> list[object]:
        bpy.ops.object.select_all(action='DESELECT')
        selected_objects: list[object] = []
        for object_ in objects:
            if object_.name not in self.scene.objects:
                continue
            object_.select_set(True)
            selected_objects.append(object_)
        if selected_objects:
            bpy.context.view_layer.objects.active = selected_objects[0]
            bpy.context.view_layer.update()
        return selected_objects

    def _prepare_objects(self, source_objects: list[object], target_objects: list[object]) -> list[object]:
        eligible_objects: list[object] = []
        seen_names: set[str] = set()
        for object_ in [*target_objects, *source_objects]:
            if object_ is None or getattr(object_, 'type', None) != 'MESH':
                continue
            if object_.name in seen_names or object_.hide_get() or object_.name not in self.scene.objects:
                continue
            seen_names.add(object_.name)
            eligible_objects.append(object_)

        prepared_objects: list[object] = []
        total_objects = len(eligible_objects)
        progress_steps = min(total_objects, 20)
        last_reported_bucket = 0
        for processed_count, object_ in enumerate(eligible_objects, start=1):
            prepared_objects.append(object_)
            progress_bucket = (processed_count * progress_steps + total_objects - 1) // total_objects
            if progress_bucket != last_reported_bucket:
                last_reported_bucket = progress_bucket
        return prepared_objects

    def _get_autobake_preferences(self) -> object | None:
        if self.module is None:
            return None
        preferences = bpy.context.preferences
        addon = preferences.addons.get(self.module.__name__)
        if addon is not None:
            return addon.preferences
        addon = preferences.addons.get('auto_bake')
        if addon is not None:
            return addon.preferences
        return None

    def _configure_material_application(self) -> None:
        properties = getattr(self.scene, 'autobake_properties', None)
        if properties is None:
            raise RuntimeError('Auto Bake 2 scene properties are unavailable.')

        setting_names = (
            'ab_final_material',
            'ab_remove_nodes',
            'ab_final_object',
            'reuse_elements',
            'ab_apply_textures',
            'ab_final_shader',
            'ab_shared_textures',
        )
        self.previous_material_settings = {
            name: getattr(properties, name)
            for name in setting_names
            if hasattr(properties, name)
        }
        properties.ab_final_material = True
        properties.ab_remove_nodes = True
        properties.ab_final_object = True
        properties.reuse_elements = True
        properties.ab_apply_textures = 'Last'
        properties.ab_final_shader = 'ShaderNodeBsdfPrincipled'
        properties.ab_shared_textures = False

    def _restore_material_application(self) -> None:
        if not self.previous_material_settings:
            return
        properties = getattr(self.scene, 'autobake_properties', None)
        if properties is None:
            self.previous_material_settings = {}
            return
        for name, value in self.previous_material_settings.items():
            if hasattr(properties, name):
                setattr(properties, name, value)
        self.previous_material_settings = {}

        preferences = self._get_autobake_preferences()
        if preferences is not None:
            for name, value in self.previous_preference_settings.items():
                if hasattr(preferences, name):
                    setattr(preferences, name, value)
        self.previous_preference_settings = {}

    def _confirm_bake_results(self) -> bool:
        preferences = self._get_autobake_preferences()
        if preferences is not None and hasattr(preferences, 'ab_swap_object'):
            self.previous_preference_settings = {'ab_swap_object': preferences.ab_swap_object}
            preferences.ab_swap_object = 'Ask'

        result = bpy.ops.autobake.confirm('EXEC_DEFAULT', do_swap=True, swap_object='Baked')
        if 'FINISHED' not in result:
            self.report.warn(
                f'Auto Bake 2 confirm operator did not finish successfully: {sorted(result)}'
            )
            return False

        self.report.summary(
            'Auto Bake 2 confirmed the bake results and swapped baked objects with their generated final objects.'
        )
        return True

    def _save_baked_images(self) -> None:
        save_dirty_material_images(self.report)

    def finalize_bake_session(self) -> None:
        try:
            if self._confirm_bake_results():
                self._save_baked_images()
        finally:
            self._restore_material_application()

    def configure_session(
        self,
        source_objects: list[object],
        target_objects: list[object],
        texture_size: int,
    ) -> bool:
        if not self.can_run():
            return False

        prepared_objects = self._prepare_objects(source_objects, target_objects)
        if not prepared_objects:
            self.status.errors.append('No visible mesh objects were available for Auto Bake 2.')
            self.report.warn('Auto Bake 2 session setup failed: no visible mesh objects were available for baking.')
            return False
        if not self.ensure_bake_list(texture_size):
            return False

        try:
            self.scene.autobake_properties.ab_selected_to_active = False
            self._configure_material_application()
            self.prepared_objects = self._select_objects(prepared_objects)
            self.status.used = True
            self.report.summary(
                f'Auto Bake 2 prepared {len(self.prepared_objects)} selected object(s) for baking and enabled Final Material, Remove Nodes, Final Object, and Reuse Elements.'
            )
            return True
        except Exception as error:
            self.prepared_objects = []
            self._restore_material_application()
            self.status.errors.append(str(error))
            self.report.warn(f'Auto Bake 2 session setup failed: {error}')
            return False

    def start_session(self) -> AsyncStageMonitor | None:
        if not self.can_run():
            return None

        selected_objects = self._select_objects(self.prepared_objects) if self.prepared_objects else list(bpy.context.selected_objects)
        if not selected_objects:
            message = 'Auto Bake 2 start operator failed: no visible mesh objects were available for selection.'
            self.status.errors.append(message)
            self.report.warn(message)
            return None

        try:
            bpy.ops.autobake.start(rebake=False, index=0, object=False, start_none=False)
            self.status.used = True
            return self.create_progress_monitor()
        except Exception as error:
            self._restore_material_application()
            self.status.errors.append(str(error))
            self.report.warn(f'Auto Bake 2 start operator failed: {error}')
            return None

    def verify(
        self,
        source_objects: list[object],
        target_objects: list[object],
        texture_size: int,
    ) -> AsyncStageMonitor | None:
        if not self.can_run():
            self.report.warn('Auto Bake 2 verification was requested, but the add-on is not available.')
            return None
        if not self.configure_session(source_objects, target_objects, texture_size):
            self.report.warn('Auto Bake 2 verification could not configure a bake session.')
            return None
        return self.start_session()


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
    collection_id: str,
    display_name: str,
    paths: ExportPaths,
    initial_camera_position: list[float],
    initial_control_target: list[float],
    environment_path: str | None,
) -> dict[str, object]:
    manifest: dict[str, object] = {
        'name': collection_id,
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


def build_index_snippet(collection_id: str, display_name: str, paths: ExportPaths) -> str:
    snippet = {
        'id': collection_id,
        'displayName': display_name,
        'manifestUrl': f'collections/{paths.package_root.name}/manifest.json',
    }
    return json.dumps(snippet, indent=2)


def write_report_file(
    paths: ExportPaths,
    collection_id: str,
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
        f'Collection id: {collection_id}',
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


def update_export_runtime_log_state(log_path: Path | None) -> None:
    if log_path is None:
        return
    namespace = get_export_runtime_namespace()
    namespace.session_log_path = log_path


def execute_export(config: ExportConfig) -> dict[str, object]:
    requested_stages = resolve_requested_stages(config)
    log_path, reset_log = resolve_log_destination(config)
    report = ExportReport(log_path=log_path, reset_log=reset_log)
    update_export_runtime_log_state(log_path)
    write_run_separator(report, requested_stages)
    report.summary(f'Starting Three.js Graphics Testbed collection export script v{SCRIPT_VERSION}.')
    report.summary(f'Executing stages: {", ".join(requested_stages)}')
    if report.log_path is not None:
        report.summary(f'Detailed log file: {report.log_path}')

    blend_path = Path(bpy.data.filepath).resolve() if bpy.data.filepath else None
    try:
        stage_state: dict[str, object] = {
            'source_collection': None,
            'collection_id': None,
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
            'cycles_configured': False,
            'autobake_described': False,
        }

        def ensure_scene_context(
            *,
            emit_warnings: bool = False,
            require_cycles: bool = False,
        ) -> None:
            if require_cycles and not stage_state['cycles_configured']:
                configure_cycles_gpu_render(report)
                stage_state['cycles_configured'] = True

            if stage_state['mesh_objects'] is not None:
                return

            source_collection, collection_id, display_name = resolve_source_collection(config, report)
            mesh_objects = validate_scene(
                source_collection,
                report,
                emit_warnings=emit_warnings,
            )
            assert blend_path is not None
            package_name = sanitize_package_name(collection_id)
            paths = build_output_paths(blend_path, package_name, config)
            create_package_layout(paths)
            initial_camera_position, initial_control_target = derive_initial_view(
                mesh_objects,
                source_collection,
                collection_id,
            )
            stage_state.update(
                {
                    'source_collection': source_collection,
                    'collection_id': collection_id,
                    'package_name': package_name,
                    'display_name': display_name,
                    'mesh_objects': mesh_objects,
                    'paths': paths,
                    'initial_camera_position': initial_camera_position,
                    'initial_control_target': initial_control_target,
                }
            )

        def invalidate_analysis_context() -> None:
            stage_state.update(
                {
                    'analysis_cache': None,
                    'bundles': None,
                    'quality_plans': None,
                    'autobake': None,
                    'bake_required_materials': None,
                    'autobake_described': False,
                }
            )

        def ensure_analysis_context() -> None:
            ensure_scene_context()
            if stage_state['analysis_cache'] is not None:
                return

            mesh_objects = stage_state['mesh_objects']
            assert blend_path is not None
            analysis_cache = analyze_materials(mesh_objects, blend_path.parent, report)
            bundles = build_mesh_bundles(mesh_objects)
            quality_plans = build_quality_plans(stage_state['paths'], config)
            autobake = AutoBake2Adapter(report)
            bake_required_materials = [
                analysis for analysis in analysis_cache.values() if analysis.status == 'bake-required'
            ]
            stage_state.update(
                {
                    'analysis_cache': analysis_cache,
                    'bundles': bundles,
                    'quality_plans': quality_plans,
                    'autobake': autobake,
                    'bake_required_materials': bake_required_materials,
                }
            )

        def describe_autobake_once() -> None:
            ensure_analysis_context()
            if stage_state['autobake_described']:
                return
            stage_state['autobake'].describe()
            stage_state['autobake_described'] = True

        def inspect_stage() -> None:
            invalidate_analysis_context()
            stage_state.update(
                {
                    'source_collection': None,
                    'collection_id': None,
                    'package_name': None,
                    'display_name': None,
                    'mesh_objects': None,
                    'paths': None,
                    'initial_camera_position': None,
                    'initial_control_target': None,
                }
            )
            ensure_scene_context(emit_warnings=True, require_cycles=True)
            ensure_analysis_context()
            describe_autobake_once()
            source_collection = stage_state['source_collection']
            collection_id = stage_state['collection_id']
            package_name = stage_state['package_name']
            mesh_objects = stage_state['mesh_objects']
            analysis_cache = stage_state['analysis_cache']
            bundles = stage_state['bundles']
            bake_required_materials = stage_state['bake_required_materials']
            report.info(
                f'Using source collection "{source_collection.name}", collection id "{collection_id}", '
                f'and package slug "{package_name}".'
            )
            report.summary(
                f'Inspect summary: collection="{source_collection.name}", visible meshes={len(mesh_objects)}, '
                f'collection id="{collection_id}", package slug="{package_name}".'
            )
            report.summary(
                'Material analysis summary: '
                f'{sum(1 for analysis in analysis_cache.values() if analysis.status == "ready")} ready, '
                f'{sum(1 for analysis in analysis_cache.values() if analysis.status == "partial")} partial, '
                f'{len(bake_required_materials)} bake-required.'
            )
            report.summary(f'LOD bundle count: {len(bundles)}')
            log_material_analysis_details(analysis_cache, report)
            log_object_analysis_details(mesh_objects, bundles, report)

        def repair_stage() -> None:
            ensure_scene_context(require_cycles=True)
            source_collection = stage_state['source_collection']
            repairs = repair_scene_warnings(source_collection, report)
            invalidate_analysis_context()
            stage_state.update(
                {
                    'mesh_objects': None,
                    'initial_camera_position': None,
                    'initial_control_target': None,
                }
            )
            ensure_scene_context(emit_warnings=True, require_cycles=True)
            ensure_analysis_context()
            describe_autobake_once()
            report.summary(
                'Repair summary: '
                f'localized={repairs["localized_objects"]}, '
                f'scale_applied={repairs["applied_scale"]}, '
                f'uv_generated={repairs["generated_uv_maps"]}, '
                f'materials_assigned={repairs["assigned_materials"]}, '
                f'world_nodes_enabled={repairs["enabled_world_nodes"]}.'
            )

        def bake_stage() -> None:
            ensure_scene_context(require_cycles=True)
            ensure_analysis_context()
            describe_autobake_once()
            autobake = stage_state['autobake']
            mesh_objects = stage_state['mesh_objects']
            bake_required_materials = stage_state['bake_required_materials']
            if config.verify_autobake_adapter:
                return autobake.verify(mesh_objects[:1], mesh_objects[:1], config.high_texture_size)
            if bake_required_materials and config.bake_behavior in {'auto', 'autobake'}:
                report.summary(
                    'Some materials are procedural or incomplete. The script will select all visible mesh objects '
                    'and launch Auto Bake 2 with an auto-seeded bake list when needed. The script enables Final Material, '
                    'Remove Nodes, Final Object, and Reuse Elements, then finishes by running Auto Bake 2\'s Confirm flow '
                    'with Swap Object enabled.'
                )
                if not autobake.configure_session(mesh_objects, mesh_objects, config.high_texture_size):
                    return
                invalidate_analysis_context()
                return autobake.start_session()
            if bake_required_materials and config.bake_behavior == 'manual':
                report.warn(
                    'Some materials need baking. Manual or direct Blender bake fallback is still required for these node graphs.'
                )
                return
            report.summary('No bake action was required for the selected scene and bake settings.')

        def export_single_stage(stage_name: str) -> None:
            ensure_analysis_context()
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
            ensure_scene_context(require_cycles=True)
            paths = stage_state['paths']
            validate_packaging_inputs(paths)
            render_thumbnail(paths, config.thumbnail_size, report)
            environment_source = detect_environment_image(report)
            environment_manifest_path = copy_environment_image(environment_source, paths, report)
            manifest = build_manifest(
                stage_state['collection_id'],
                stage_state['display_name'],
                paths,
                stage_state['initial_camera_position'],
                stage_state['initial_control_target'],
                environment_manifest_path,
            )
            write_manifest(manifest, paths, report)
            index_snippet = build_index_snippet(
                stage_state['collection_id'],
                stage_state['display_name'],
                paths,
            )
            if config.write_report:
                autobake_status = stage_state['autobake'].status if stage_state['autobake'] is not None else AutoBake2Adapter(report).status
                write_report_file(
                    paths,
                    stage_state['collection_id'],
                    stage_state['display_name'],
                    manifest,
                    index_snippet,
                    report,
                    autobake_status,
                    requested_stages,
                )
            print_console_summary(paths, index_snippet, report)

        if 'inspect' in requested_stages:
            run_stage('inspect', report, inspect_stage)

        if 'repair' in requested_stages:
            run_stage('repair', report, repair_stage)

        if 'bake' in requested_stages:
            bake_stage_state = StageRunState()
            run_stage('bake', report, bake_stage, state=bake_stage_state)

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
            'collection_id': stage_state['collection_id'],
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
            'collection_id': None,
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
    print("  run_testbed_export_stage('repair')")
    print("  run_testbed_export_stage('bake')")
    print(r"  run_testbed_export_stage('inspect', log_path_override='F:/tmp/testbed-inspect.log')")
    print("  run_testbed_export_stages('export-high', 'export-medium', 'export-low')")
    print("  run_testbed_export_stage('package')")
    print('These helpers store the last result at testbed_export.last_result and do not echo it unless echo_result=True is passed.')
    print('By default, all commands append to a single session log file until you provide log_path_override.')
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
        session_log_path=None,
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