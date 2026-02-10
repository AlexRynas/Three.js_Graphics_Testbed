import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
import * as THREE_WEBGPU from 'three/webgpu';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { TAARenderPass } from 'three/examples/jsm/postprocessing/TAARenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { FilmPass } from 'three/examples/jsm/postprocessing/FilmPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';
import { RGBShiftShader } from 'three/examples/jsm/shaders/RGBShiftShader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import GUI from 'lil-gui';
import {
  CollectionManifest,
  CollectionRef,
  FeatureSupport,
  InspectorSnapshot,
  Preset,
  RenderingSettings,
  SceneSettings,
  defaultRenderingSettings,
  defaultSceneSettings,
} from './controls.model';
import { AssetService } from './asset.service';
import { CapabilitiesService } from './capabilities.service';
import { PresetService } from './preset.service';
import { IconButtonComponent } from '../../shared/ui/icon-button/icon-button.component';
import { LabeledFieldComponent } from '../../shared/ui/labeled-field/labeled-field.component';
import { PillButtonComponent } from '../../shared/ui/pill-button/pill-button.component';
import { SectionHeaderComponent } from '../../shared/ui/section-header/section-header.component';
import { SelectButtonComponent } from '../../shared/ui/select-button/select-button.component';
import { StatGridComponent } from '../../shared/ui/stat-grid/stat-grid.component';
import { GuiDockComponent } from './components/gui-dock/gui-dock.component';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { TopbarComponent } from './components/topbar/topbar.component';
import { ViewportComponent } from './components/viewport/viewport.component';

type RendererInstance = THREE.WebGLRenderer | THREE_WEBGPU.WebGPURenderer;
type StatsSample = {
  fps: number;
  cpu: number;
  gpu: number | null;
};

interface FrameMetrics {
  fps: number;
  minFps: number;
  cpuMs: number;
  maxFrameTime: number;
  drawCalls: number;
  triangles: number;
  memoryMb: number;
  gpuMs: number | null;
}

interface BenchmarkState {
  active: boolean;
  progress: number;
  sampleCount: number;
  duration: number;
}

type Webgl2TimerQueryExt = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
};

type Webgl1TimerQueryExt = Webgl2TimerQueryExt & {
  QUERY_RESULT_AVAILABLE_EXT: number;
  QUERY_RESULT_EXT: number;
  createQueryEXT: () => WebGLQuery | null;
  deleteQueryEXT: (query: WebGLQuery) => void;
  beginQueryEXT: (target: number, query: WebGLQuery) => void;
  endQueryEXT: (target: number) => void;
  getQueryObjectEXT: (query: WebGLQuery, pname: number) => number | boolean;
};

class WebglGpuTimer {
  private readonly gl: WebGLRenderingContext | WebGL2RenderingContext;
  private readonly extWebgl2: Webgl2TimerQueryExt | null;
  private readonly extWebgl1: Webgl1TimerQueryExt | null;
  private currentQuery: WebGLQuery | null = null;
  private readonly pendingQueries: WebGLQuery[] = [];
  private lastGpuMs: number | null = null;

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.gl = gl;
    this.extWebgl2 =
      gl instanceof WebGL2RenderingContext
        ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as Webgl2TimerQueryExt | null)
        : null;
    this.extWebgl1 = this.extWebgl2
      ? null
      : (gl.getExtension('EXT_disjoint_timer_query') as Webgl1TimerQueryExt | null);
  }

  get isAvailable(): boolean {
    return Boolean(this.extWebgl2 || this.extWebgl1);
  }

  begin(): void {
    if (!this.isAvailable || this.currentQuery) {
      return;
    }

    if (this.extWebgl2 && this.gl instanceof WebGL2RenderingContext) {
      const gl2 = this.gl as WebGL2RenderingContext;
      const query = gl2.createQuery();
      if (!query) {
        return;
      }
      this.currentQuery = query;
      gl2.beginQuery(this.extWebgl2.TIME_ELAPSED_EXT, query);
      return;
    }

    if (this.extWebgl1) {
      const query = this.extWebgl1.createQueryEXT();
      if (!query) {
        return;
      }
      this.currentQuery = query;
      this.extWebgl1.beginQueryEXT(this.extWebgl1.TIME_ELAPSED_EXT, query);
    }
  }

  end(): void {
    if (!this.isAvailable || !this.currentQuery) {
      return;
    }

    if (this.extWebgl2 && this.gl instanceof WebGL2RenderingContext) {
      const gl2 = this.gl as WebGL2RenderingContext;
      gl2.endQuery(this.extWebgl2.TIME_ELAPSED_EXT);
      this.pendingQueries.push(this.currentQuery);
      this.currentQuery = null;
      this.collect();
      return;
    }

    if (this.extWebgl1) {
      this.extWebgl1.endQueryEXT(this.extWebgl1.TIME_ELAPSED_EXT);
      this.pendingQueries.push(this.currentQuery);
      this.currentQuery = null;
      this.collect();
    }
  }

  getLatestMs(): number | null {
    this.collect();
    return this.lastGpuMs;
  }

  dispose(): void {
    if (this.extWebgl2 && this.gl instanceof WebGL2RenderingContext) {
      const gl2 = this.gl as WebGL2RenderingContext;
      this.pendingQueries.forEach((query) => gl2.deleteQuery(query));
    } else if (this.extWebgl1) {
      this.pendingQueries.forEach((query) => this.extWebgl1?.deleteQueryEXT(query));
    }
    this.pendingQueries.length = 0;
    this.currentQuery = null;
  }

  private collect(): void {
    if (!this.isAvailable || this.pendingQueries.length === 0) {
      return;
    }

    if (this.extWebgl2 && this.gl instanceof WebGL2RenderingContext) {
      const gl2 = this.gl as WebGL2RenderingContext;
      const disjoint = gl2.getParameter(this.extWebgl2.GPU_DISJOINT_EXT) as boolean;
      for (let index = this.pendingQueries.length - 1; index >= 0; index -= 1) {
        const query = this.pendingQueries[index];
        const available = gl2.getQueryParameter(query, gl2.QUERY_RESULT_AVAILABLE) as boolean;
        if (available && !disjoint) {
          const ns = gl2.getQueryParameter(query, gl2.QUERY_RESULT) as number;
          this.lastGpuMs = ns / 1_000_000;
          gl2.deleteQuery(query);
          this.pendingQueries.splice(index, 1);
        }
      }
      return;
    }

    if (this.extWebgl1) {
      const disjoint = this.gl.getParameter(this.extWebgl1.GPU_DISJOINT_EXT) as boolean;
      for (let index = this.pendingQueries.length - 1; index >= 0; index -= 1) {
        const query = this.pendingQueries[index];
        const available = this.extWebgl1.getQueryObjectEXT(
          query,
          this.extWebgl1.QUERY_RESULT_AVAILABLE_EXT,
        ) as boolean;
        if (available && !disjoint) {
          const ns = this.extWebgl1.getQueryObjectEXT(
            query,
            this.extWebgl1.QUERY_RESULT_EXT,
          ) as number;
          this.lastGpuMs = ns / 1_000_000;
          this.extWebgl1.deleteQueryEXT(query);
          this.pendingQueries.splice(index, 1);
        }
      }
    }
  }
}

class FrameStatsTracker {
  private lastFrameTime = performance.now();
  private cpuStart = 0;
  private lastSample: StatsSample = { fps: 0, cpu: 0, gpu: null };
  private gpuTimer: WebglGpuTimer | null = null;

  init(renderer: RendererInstance): void {
    this.dispose();
    this.lastFrameTime = performance.now();
    if (renderer instanceof THREE.WebGLRenderer) {
      const timer = new WebglGpuTimer(renderer.getContext());
      this.gpuTimer = timer.isAvailable ? timer : null;
    }
  }

  beginFrame(): void {
    this.cpuStart = performance.now();
    this.gpuTimer?.begin();
  }

  endFrame(): StatsSample {
    this.gpuTimer?.end();
    const now = performance.now();
    const delta = now - this.lastFrameTime;
    this.lastFrameTime = now;

    const fps = delta > 0 ? 1000 / delta : this.lastSample.fps;
    const cpu = Math.max(0, now - this.cpuStart);
    const gpu = this.gpuTimer?.getLatestMs() ?? null;

    this.lastSample = {
      fps,
      cpu,
      gpu,
    };

    return this.lastSample;
  }

  dispose(): void {
    this.gpuTimer?.dispose();
    this.gpuTimer = null;
  }
}

@Component({
  selector: 'app-testbed',
  templateUrl: './testbed.component.html',
  styleUrl: './testbed.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    IconButtonComponent,
    LabeledFieldComponent,
    PillButtonComponent,
    SectionHeaderComponent,
    SelectButtonComponent,
    StatGridComponent,
    GuiDockComponent,
    SidebarComponent,
    TopbarComponent,
    ViewportComponent,
  ],
  host: {
    class: 'testbed-host',
  },
})
export class TestbedComponent implements AfterViewInit {
  readonly viewportShell = viewChild.required(ViewportComponent);
  readonly guiDock = viewChild.required(GuiDockComponent);

  private readonly assetService = inject(AssetService);
  private readonly capabilitiesService = inject(CapabilitiesService);
  private readonly presetService = inject(PresetService);
  private readonly destroyRef = inject(DestroyRef);

  private renderer: RendererInstance | null = null;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private fxaaPass: ShaderPass | null = null;
  private smaaPass: SMAAPass | null = null;
  private taaPass: TAARenderPass | null = null;
  private ssaoPass: SSAOPass | null = null;
  private dofPass: BokehPass | null = null;
  private filmPass: FilmPass | null = null;
  private vignettePass: ShaderPass | null = null;
  private chromaticPass: ShaderPass | null = null;

  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private activeThree: typeof THREE = THREE;
  private clock: THREE.Clock | null = null;
  private frameStats: FrameStatsTracker | null = null;
  private latestStats: StatsSample | null = null;
  private gui: GUI | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private currentManifest: CollectionManifest | null = null;
  private activeGroup: THREE.Group | null = null;
  private primaryLight: THREE.DirectionalLight | null = null;
  private lensflare: Lensflare | null = null;
  private usingMsaa = true;
  private currentMode: 'webgl' | 'webgpu' = 'webgl';

  private benchmarkFrames: number[] = [];
  private benchmarkFrameTimes: number[] = [];
  private benchmarkStart = 0;

  readonly status = signal('Initializing renderer...');
  readonly rendererLabel = signal('WebGL');
  readonly guiVisible = signal(true);
  readonly settings = signal<RenderingSettings>({ ...defaultRenderingSettings });
  readonly sceneSettings = signal<SceneSettings>({ ...defaultSceneSettings });
  readonly collections = signal<CollectionRef[]>([]);
  readonly activeCollectionId = signal('procedural');
  readonly inspector = signal<InspectorSnapshot>({
    meshCount: 0,
    materialCount: 0,
    textureCount: 0,
    lodCount: 0,
    bvhCount: 0,
  });
  readonly presetName = signal('Custom');
  readonly metrics = signal<FrameMetrics>({
    fps: 0,
    minFps: 0,
    cpuMs: 0,
    maxFrameTime: 0,
    drawCalls: 0,
    triangles: 0,
    memoryMb: 0,
    gpuMs: null,
  });
  readonly benchmark = signal<BenchmarkState>({
    active: false,
    progress: 0,
    sampleCount: 0,
    duration: 12,
  });

  readonly capabilitySummary = this.capabilitiesService.capabilities;

  readonly capabilityRows = computed(() => {
    const caps = this.capabilitySummary();
    return [
      { key: 'webgpu', label: 'WebGPU', value: caps.webgpu ? 'Available' : 'Unavailable' },
      { key: 'webgl2', label: 'WebGL2', value: caps.webgl2 ? 'Yes' : 'No' },
      { key: 'maxTextureSize', label: 'Max Texture', value: `${caps.maxTextureSize}px` },
      { key: 'maxAnisotropy', label: 'Max Anisotropy', value: `${caps.maxAnisotropy}x` },
      { key: 'msaa', label: 'MSAA Samples', value: `${caps.msaaSamples}` },
      { key: 'shaderPrecision', label: 'Shader Precision', value: caps.shaderPrecision },
      {
        key: 'compressed',
        label: 'Compressed Tex',
        value: caps.compressedTextures.length > 0 ? caps.compressedTextures.join(', ') : 'None',
      },
      { key: 'gpuTimer', label: 'GPU Timer', value: caps.gpuTimerQuery ? 'Yes' : 'No' },
    ];
  });

  readonly inspectorRows = computed(() => {
    const inspector = this.inspector();
    return [
      { key: 'meshes', label: 'Meshes', value: inspector.meshCount },
      { key: 'materials', label: 'Materials', value: inspector.materialCount },
      { key: 'textures', label: 'Textures', value: inspector.textureCount },
      { key: 'lod', label: 'LOD Nodes', value: inspector.lodCount },
      { key: 'bvh', label: 'BVH Meshes', value: inspector.bvhCount },
    ];
  });

  readonly featureRows = computed<FeatureSupport[]>(() => {
    const caps = this.capabilitySummary();
    const isWebGpu = this.settings().rendererMode === 'webgpu';

    return [
      { key: 'msaa', label: 'MSAA', supported: caps.webgl2 && !isWebGpu },
      { key: 'fxaa', label: 'FXAA', supported: !isWebGpu },
      { key: 'smaa', label: 'SMAA', supported: !isWebGpu },
      { key: 'taa', label: 'TAA', supported: !isWebGpu },
      { key: 'ssao', label: 'SSAO', supported: !isWebGpu },
      { key: 'ssr', label: 'SSR', supported: false, detail: 'WebGPU SSR pending' },
      { key: 'gi', label: 'Global Illumination', supported: false },
      { key: 'ray', label: 'Ray Tracing', supported: false },
      { key: 'path', label: 'Path Tracing', supported: false },
      { key: 'dof', label: 'Depth of Field', supported: !isWebGpu },
      { key: 'vol', label: 'Volumetric Lighting', supported: false },
      { key: 'lens', label: 'Lens Flares', supported: true },
      { key: 'vignette', label: 'Vignette', supported: true },
      { key: 'chromatic', label: 'Chromatic Aberration', supported: !isWebGpu },
      { key: 'film', label: 'Film Grain', supported: !isWebGpu },
    ];
  });

  readonly presets = this.presetService.presets;

  constructor() {
    effect(() => {
      const settings = this.settings();
      const sceneSettings = this.sceneSettings();
      void this.applySettings(settings, sceneSettings);
    });
  }

  async ngAfterViewInit(): Promise<void> {
    await this.capabilitiesService.detect();
    await this.initialize();

    this.destroyRef.onDestroy(() => {
      this.dispose();
    });
  }

  toggleGui(): void {
    this.guiVisible.update((visible) => !visible);
  }

  async selectCollection(id: string): Promise<void> {
    const collection = this.collections().find((item) => item.id === id) ?? null;
    if (!collection) {
      return;
    }

    this.activeCollectionId.set(collection.id);
    await this.loadCollection(collection);
  }

  applyPreset(preset: Preset): void {
    this.settings.set({ ...preset.rendering });
    this.sceneSettings.set({ ...preset.scene });
    this.presetName.set(preset.name);
  }

  deletePreset(preset: Preset): void {
    this.presetService.deletePreset(preset.name);
  }

  updatePresetName(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (input) {
      this.presetName.set(input.value);
    }
  }

  savePreset(): void {
    const name = this.presetName().trim();
    if (!name) {
      return;
    }

    this.presetService.savePreset({
      name,
      rendering: { ...this.settings() },
      scene: { ...this.sceneSettings() },
    });
  }

  async runBenchmark(): Promise<void> {
    if (this.benchmark().active) {
      return;
    }

    this.status.set('Running benchmark path...');
    this.benchmarkFrames = [];
    this.benchmarkFrameTimes = [];
    this.benchmarkStart = performance.now();
    this.benchmark.set({
      active: true,
      progress: 0,
      sampleCount: 0,
      duration: this.benchmark().duration,
    });
  }

  exportMetrics(): void {
    const result = this.buildBenchmarkResult();
    if (!result) {
      return;
    }

    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `benchmark-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  private async initialize(): Promise<void> {
    const collectionList = await this.assetService.loadCollectionsIndex();
    this.collections.set(collectionList);
    this.presetService.setInitialPresets(this.assetService.buildDefaultPresets());

    const canvas = this.viewportShell().canvas;
    const rendererMode = this.resolveRendererMode(this.settings().rendererMode);
    this.settings.update((current) => ({ ...current, rendererMode }));
    this.setThreeModule(rendererMode);
    const THREE = this.activeThree;
    this.clock = new THREE.Clock();

    await this.createRenderer(canvas, rendererMode);
    this.initScene();
    this.initControls();
    this.initComposer();
    this.initFrameStats();
    this.setupResizeObserver();
    this.buildGui();

    const activeCollection =
      this.collections().find((collection) => collection.id === this.activeCollectionId()) ??
      this.collections()[0];

    if (activeCollection) {
      this.activeCollectionId.set(activeCollection.id);
      await this.loadCollection(activeCollection);
    }

    this.startLoop();
    this.status.set('Ready');
  }

  private resolveRendererMode(requested: RenderingSettings['rendererMode']): 'webgl' | 'webgpu' {
    const caps = this.capabilitySummary();
    if (requested === 'webgpu' && !caps.webgpu) {
      return 'webgl';
    }
    return requested;
  }

  private setThreeModule(mode: 'webgl' | 'webgpu'): void {
    this.activeThree = mode === 'webgpu' ? (THREE_WEBGPU as unknown as typeof THREE) : THREE;
  }

  private async createRenderer(canvas: HTMLCanvasElement, mode: 'webgl' | 'webgpu'): Promise<void> {
    this.disposeRenderer();
    this.setThreeModule(mode);
    const THREE = this.activeThree;

    const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    if (mode === 'webgpu' && hasWebGpu) {
      const renderer = new THREE_WEBGPU.WebGPURenderer({ canvas, antialias: false });
      await renderer.init();
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.outputColorSpace = THREE_WEBGPU.SRGBColorSpace;
      this.renderer = renderer;
      this.rendererLabel.set('WebGPU');
      this.usingMsaa = false;
      this.currentMode = 'webgpu';
      return;
    }

    const msaaEnabled = this.settings().antialiasing === 'msaa';
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: msaaEnabled,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    this.rendererLabel.set('WebGL');
    this.usingMsaa = msaaEnabled;
    this.currentMode = 'webgl';
  }

  private initScene(): void {
    const THREE = this.activeThree;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0b1117');

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
    this.camera.position.set(5, 4.5, 8);

    const grid = new THREE.GridHelper(40, 40, 0x1b3b3b, 0x10222c);
    grid.position.y = -0.01;
    this.scene.add(grid);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(12, 64),
      new THREE.MeshStandardMaterial({
        color: 0x0f1a22,
        metalness: 0.1,
        roughness: 0.7,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const ambient = new THREE.AmbientLight(0x9fb3c8, 0.35);
    this.scene.add(ambient);

    this.primaryLight = new THREE.DirectionalLight(0xffffff, 1.2);
    this.primaryLight.position.set(6, 8, 4);
    this.primaryLight.castShadow = true;
    this.primaryLight.shadow.mapSize.set(2048, 2048);
    this.primaryLight.shadow.camera.near = 1;
    this.primaryLight.shadow.camera.far = 40;
    this.scene.add(this.primaryLight);

    const rimLight = new THREE.PointLight(0x45e3c2, 0.9, 40);
    rimLight.position.set(-5, 4, -6);
    this.scene.add(rimLight);

    this.applyEnvironment(null);
  }

  private initControls(): void {
    if (!this.camera) {
      return;
    }

    const controls = new OrbitControls(this.camera, this.viewportShell().canvas);
    controls.enableDamping = true;
    controls.autoRotate = this.sceneSettings().autoRotate;
    controls.autoRotateSpeed = 0.5;
    this.controls = controls;
  }

  private initComposer(): void {
    const THREE = this.activeThree;
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }

    if (!(this.renderer instanceof THREE.WebGLRenderer)) {
      this.composer = null;
      return;
    }

    const renderer = this.renderer as THREE.WebGLRenderer;
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.fxaaPass = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaaPass);

    this.smaaPass = new SMAAPass();
    this.composer.addPass(this.smaaPass);

    this.taaPass = new TAARenderPass(this.scene, this.camera);
    this.composer.addPass(this.taaPass);

    this.ssaoPass = new SSAOPass(this.scene, this.camera, 1, 1);
    this.composer.addPass(this.ssaoPass);

    this.dofPass = new BokehPass(this.scene, this.camera, {
      focus: this.settings().dofFocus,
      aperture: this.settings().dofAperture,
      maxblur: this.settings().dofMaxBlur,
    });
    this.composer.addPass(this.dofPass);

    this.filmPass = new FilmPass(0.25, false);
    this.composer.addPass(this.filmPass);

    this.vignettePass = new ShaderPass(VignetteShader);
    this.composer.addPass(this.vignettePass);

    this.chromaticPass = new ShaderPass(RGBShiftShader);
    this.composer.addPass(this.chromaticPass);

    this.updateComposerSize();
    this.applyPostProcessing(this.settings());
  }

  private initFrameStats(): void {
    if (!this.renderer) {
      return;
    }

    if (!this.frameStats) {
      this.frameStats = new FrameStatsTracker();
    }

    this.frameStats.init(this.renderer);
  }

  private setupResizeObserver(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.updateSize());
    this.resizeObserver.observe(this.viewportShell().viewport);
    this.updateSize();
  }

  private updateSize(): void {
    if (!this.renderer || !this.camera) {
      return;
    }

    const { clientWidth, clientHeight } = this.viewportShell().viewport;
    if (clientWidth === 0 || clientHeight === 0) {
      return;
    }

    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.updateComposerSize();
  }

  private updateComposerSize(): void {
    if (!this.composer) {
      return;
    }

    const { width, height } = this.getViewportSize();
    this.composer.setSize(width, height);

    if (this.fxaaPass) {
      this.fxaaPass.material.uniforms['resolution'].value.set(1 / width, 1 / height);
    }

    if (this.smaaPass) {
      this.smaaPass.setSize(width, height);
    }

    if (this.ssaoPass) {
      this.ssaoPass.setSize(width, height);
    }
  }

  private getViewportSize(): { width: number; height: number } {
    const { clientWidth, clientHeight } = this.viewportShell().viewport;
    return {
      width: Math.max(1, clientWidth),
      height: Math.max(1, clientHeight),
    };
  }

  private buildGui(): void {
    this.gui?.destroy();
    const gui = new GUI({ width: 320, autoPlace: false, title: 'Graphics Control Deck' });
    this.guiDock().element.appendChild(gui.domElement);
    this.gui = gui;

    const settingsState: RenderingSettings = { ...this.settings() };
    const sceneState: SceneSettings = { ...this.sceneSettings() };

    const rendererFolder = gui.addFolder('Renderer');
    rendererFolder
      .add(settingsState, 'rendererMode', ['webgl', 'webgpu'])
      .name('Mode')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    rendererFolder
      .add(settingsState, 'antialiasing', ['none', 'msaa', 'fxaa', 'smaa', 'taa'])
      .name('AA')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    rendererFolder
      .add(settingsState, 'msaaSamples', 0, 8, 1)
      .name('MSAA Samples')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    rendererFolder
      .add(settingsState, 'smaaQuality', ['low', 'medium', 'high'])
      .name('SMAA Quality')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    rendererFolder
      .add(settingsState, 'taaSamples', 1, 8, 1)
      .name('TAA Samples')
      .onChange(() => this.commitSettings(settingsState, sceneState));

    const postFolder = gui.addFolder('Post FX');
    postFolder
      .add(settingsState, 'ssaoEnabled')
      .name('SSAO')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    postFolder
      .add(settingsState, 'ssaoRadius', 1, 32, 1)
      .name('SSAO Radius')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    postFolder
      .add(settingsState, 'ssaoQuality', ['low', 'medium', 'high'])
      .name('SSAO Quality')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    postFolder
      .add(settingsState, 'ssrEnabled')
      .name('SSR')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    postFolder
      .add(settingsState, 'depthOfField')
      .name('Depth of Field')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    postFolder
      .add(settingsState, 'dofFocus', 1, 20, 0.1)
      .name('DOF Focus')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    postFolder
      .add(settingsState, 'dofAperture', 0.001, 0.05, 0.001)
      .name('DOF Aperture')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    postFolder
      .add(settingsState, 'dofMaxBlur', 0.001, 0.02, 0.001)
      .name('DOF Blur')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    postFolder
      .add(settingsState, 'chromaticAberration')
      .name('Chromatic')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    postFolder
      .add(settingsState, 'vignette')
      .name('Vignette')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    postFolder
      .add(settingsState, 'filmGrain')
      .name('Film Grain')
      .onChange(() => this.commitSettings(settingsState, sceneState));

    const qualityFolder = gui.addFolder('Texture + Filtering');
    qualityFolder
      .add(settingsState, 'anisotropy', 1, 16, 1)
      .name('Anisotropy')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    qualityFolder
      .add(settingsState, 'textureFiltering', ['linear', 'trilinear', 'anisotropic'])
      .name('Filtering')
      .onChange(() => this.commitSettings(settingsState, sceneState));

    const sceneFolder = gui.addFolder('Scene');
    sceneFolder
      .add(sceneState, 'environmentIntensity', 0, 2, 0.05)
      .name('Env Intensity')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    sceneFolder
      .add(sceneState, 'exposure', 0.4, 2, 0.05)
      .name('Exposure')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    sceneFolder
      .add(sceneState, 'toneMapping', ['none', 'aces', 'neutral'])
      .name('Tone Mapping')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    sceneFolder
      .add(sceneState, 'autoRotate')
      .name('Auto Rotate')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    sceneFolder
      .add(sceneState, 'lodBias', -2, 2, 0.25)
      .name('LOD Bias')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    sceneFolder
      .add(sceneState, 'bvhEnabled')
      .name('GPU BVH')
      .onChange(() => this.commitSettings(settingsState, sceneState));

    const extrasFolder = gui.addFolder('Extras');
    extrasFolder
      .add(settingsState, 'lensFlares')
      .name('Lens Flares')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    extrasFolder
      .add(settingsState, 'contactShadows')
      .name('Contact Shadows')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    extrasFolder
      .add(settingsState, 'screenSpaceShadows')
      .name('Screen Space Shadows')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    extrasFolder
      .add(settingsState, 'volumetricLighting')
      .name('Volumetric Lighting')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    extrasFolder
      .add(settingsState, 'globalIllumination')
      .name('Global Illumination')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    extrasFolder
      .add(settingsState, 'rayTracing')
      .name('Ray Tracing')
      .onChange(() => this.commitSettings(settingsState, sceneState));
    extrasFolder
      .add(settingsState, 'pathTracing')
      .name('Path Tracing')
      .onChange(() => this.commitSettings(settingsState, sceneState));
  }

  private commitSettings(rendering: RenderingSettings, scene: SceneSettings): void {
    this.settings.set({ ...rendering });
    this.sceneSettings.set({ ...scene });
  }

  private async applySettings(
    settings: RenderingSettings,
    sceneSettings: SceneSettings,
  ): Promise<void> {
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }

    const resolvedMode = this.resolveRendererMode(settings.rendererMode);
    if (settings.rendererMode !== resolvedMode) {
      this.settings.update((current) => ({ ...current, rendererMode: resolvedMode }));
    }

    if (
      resolvedMode !== this.currentMode ||
      (resolvedMode === 'webgl' && this.needsMsaaRebuild(settings))
    ) {
      await this.reloadRenderer(resolvedMode);
      return;
    }

    this.updateToneMapping(sceneSettings);
    this.updateControls(sceneSettings);
    this.applyEnvironmentIntensity(sceneSettings.environmentIntensity);
    this.updateLodBias(sceneSettings.lodBias);
    this.applyPostProcessing(settings);
    this.applyShadowSettings(settings);
    this.applyLensFlares(settings);
    this.applyTextureFiltering(settings);
    this.applyBvh(sceneSettings.bvhEnabled);
    this.updateUnsupportedStatus(settings);
  }

  private updateUnsupportedStatus(settings: RenderingSettings): void {
    const unsupported: string[] = [];
    const isWebGpu = this.settings().rendererMode === 'webgpu';

    if (isWebGpu) {
      if (settings.antialiasing === 'fxaa') unsupported.push('FXAA');
      if (settings.antialiasing === 'smaa') unsupported.push('SMAA');
      if (settings.antialiasing === 'taa') unsupported.push('TAA');
      if (settings.ssaoEnabled) unsupported.push('SSAO');
      if (settings.depthOfField) unsupported.push('Depth of Field');
      if (settings.chromaticAberration) unsupported.push('Chromatic Aberration');
      if (settings.filmGrain) unsupported.push('Film Grain');
    }

    if (settings.ssrEnabled) unsupported.push('SSR');
    if (settings.globalIllumination) unsupported.push('Global Illumination');
    if (settings.rayTracing) unsupported.push('Ray Tracing');
    if (settings.pathTracing) unsupported.push('Path Tracing');
    if (settings.volumetricLighting) unsupported.push('Volumetric Lighting');

    if (unsupported.length > 0) {
      this.status.set(`Unsupported in ${this.rendererLabel()}: ${unsupported.join(', ')}`);
    } else if (this.status().startsWith('Unsupported in')) {
      this.status.set('Ready');
    }
  }

  private needsMsaaRebuild(settings: RenderingSettings): boolean {
    const wantsMsaa = settings.antialiasing === 'msaa';
    return wantsMsaa !== this.usingMsaa;
  }

  private async reloadRenderer(mode: 'webgl' | 'webgpu'): Promise<void> {
    const canvas = this.viewportShell().canvas;
    this.setThreeModule(mode);
    await this.createRenderer(canvas, mode);
    this.initFrameStats();
    this.initComposer();
    this.updateSize();
    const active = this.collections().find((item) => item.id === this.activeCollectionId());
    if (active) {
      await this.loadCollection(active);
    }
    this.status.set(`Renderer switched to ${mode.toUpperCase()}.`);
  }

  private updateToneMapping(sceneSettings: SceneSettings): void {
    const THREE = this.activeThree;
    if (!this.renderer || !('toneMapping' in this.renderer)) {
      return;
    }

    const toneMapping = sceneSettings.toneMapping;
    if (toneMapping === 'aces') {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    } else if (toneMapping === 'neutral') {
      this.renderer.toneMapping = THREE.NeutralToneMapping;
    } else {
      this.renderer.toneMapping = THREE.NoToneMapping;
    }

    this.renderer.toneMappingExposure = sceneSettings.exposure;
  }

  private updateControls(sceneSettings: SceneSettings): void {
    if (!this.controls) {
      return;
    }

    this.controls.autoRotate = sceneSettings.autoRotate;
  }

  private applyEnvironment(hdrTexture: THREE.Texture | null): void {
    const THREE = this.activeThree;
    if (!this.scene || !(this.renderer instanceof THREE.WebGLRenderer)) {
      return;
    }

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer as THREE.WebGLRenderer);
    pmremGenerator.compileEquirectangularShader();

    if (hdrTexture) {
      const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;
      this.scene.environment = envMap;
      this.scene.background = new THREE.Color('#070b10');
      hdrTexture.dispose();
    } else {
      const envMap = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = envMap;
      this.scene.background = new THREE.Color('#0b1117');
    }

    pmremGenerator.dispose();
  }

  private applyEnvironmentIntensity(intensity: number): void {
    const THREE = this.activeThree;
    if (!this.scene) {
      return;
    }

    this.scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
        object.material.envMapIntensity = intensity;
      }
    });
  }

  private updateLodBias(bias: number): void {
    const THREE = this.activeThree;
    if (!this.scene) {
      return;
    }

    this.scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.LOD) {
        object.levels.forEach((level, index) => {
          if (index === 0) {
            level.distance = 0;
          } else {
            level.distance = index * 12 + bias * 3;
          }
        });
      }
    });
  }

  private applyPostProcessing(settings: RenderingSettings): void {
    if (!this.composer) {
      return;
    }

    const isWebGpu = this.settings().rendererMode === 'webgpu';
    const aa = settings.antialiasing;
    const { width, height } = this.getViewportSize();

    if (this.fxaaPass) {
      this.fxaaPass.enabled = !isWebGpu && aa === 'fxaa';
    }
    if (this.smaaPass) {
      this.smaaPass.enabled = !isWebGpu && aa === 'smaa';
      const qualityScale =
        settings.smaaQuality === 'low' ? 0.75 : settings.smaaQuality === 'high' ? 1.25 : 1;
      this.smaaPass.setSize(width * qualityScale, height * qualityScale);
    }
    if (this.taaPass) {
      this.taaPass.enabled = !isWebGpu && aa === 'taa';
      this.taaPass.sampleLevel = Math.max(0, settings.taaSamples - 1);
    }

    if (this.ssaoPass) {
      this.ssaoPass.enabled = !isWebGpu && settings.ssaoEnabled && settings.screenSpaceShadows;
      const qualityBoost =
        settings.ssaoQuality === 'high' ? 1.4 : settings.ssaoQuality === 'low' ? 0.8 : 1;
      this.ssaoPass.kernelRadius = settings.ssaoRadius * qualityBoost;
    }

    if (this.dofPass) {
      this.dofPass.enabled = !isWebGpu && settings.depthOfField;
      this.dofPass.materialBokeh.uniforms['focus'].value = settings.dofFocus;
      this.dofPass.materialBokeh.uniforms['aperture'].value = settings.dofAperture;
      this.dofPass.materialBokeh.uniforms['maxblur'].value = settings.dofMaxBlur;
    }

    if (this.filmPass) {
      this.filmPass.enabled = !isWebGpu && settings.filmGrain;
    }

    if (this.vignettePass) {
      this.vignettePass.enabled = settings.vignette;
    }

    if (this.chromaticPass) {
      this.chromaticPass.enabled = !isWebGpu && settings.chromaticAberration;
    }
  }

  private applyShadowSettings(settings: RenderingSettings): void {
    if (!this.renderer || !('shadowMap' in this.renderer)) {
      return;
    }

    this.renderer.shadowMap.enabled = settings.contactShadows;
  }

  private applyLensFlares(settings: RenderingSettings): void {
    if (!this.primaryLight) {
      return;
    }

    if (settings.lensFlares && !this.lensflare) {
      const flare = new Lensflare();
      flare.addElement(new LensflareElement(this.createFlareTexture('#f7b545'), 96, 0));
      flare.addElement(new LensflareElement(this.createFlareTexture('#45e3c2'), 128, 0.4));
      this.primaryLight.add(flare);
      this.lensflare = flare;
    }

    if (!settings.lensFlares && this.lensflare) {
      this.primaryLight.remove(this.lensflare);
      if ('dispose' in this.lensflare) {
        this.lensflare.dispose();
      }
      this.lensflare = null;
    }
  }

  private createFlareTexture(color: string): THREE.Texture {
    const THREE = this.activeThree;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) {
      return new THREE.Texture();
    }

    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      8,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.4, color);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private applyTextureFiltering(settings: RenderingSettings): void {
    const THREE = this.activeThree;
    if (!this.renderer) {
      return;
    }

    const maxAniso = this.capabilitySummary().maxAnisotropy;
    const targetAniso = Math.min(settings.anisotropy, maxAniso || 1);

    this.scene?.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh) {
        const material = object.material;
        if (material instanceof THREE.MeshStandardMaterial) {
          const maps: Array<THREE.Texture | null> = [
            material.map,
            material.normalMap,
            material.roughnessMap,
            material.metalnessMap,
            material.emissiveMap,
          ];

          maps.forEach((texture) => {
            if (!texture) {
              return;
            }

            if (settings.textureFiltering === 'linear') {
              texture.minFilter = THREE.LinearFilter;
              texture.magFilter = THREE.LinearFilter;
              texture.anisotropy = 1;
            } else if (settings.textureFiltering === 'trilinear') {
              texture.minFilter = THREE.LinearMipmapLinearFilter;
              texture.magFilter = THREE.LinearFilter;
              texture.anisotropy = 1;
            } else {
              texture.minFilter = THREE.LinearMipmapLinearFilter;
              texture.magFilter = THREE.LinearFilter;
              texture.anisotropy = targetAniso;
            }

            texture.needsUpdate = true;
          });
        }
      }
    });
  }

  private applyBvh(enabled: boolean): void {
    const THREE = this.activeThree;
    if (!enabled || !this.scene) {
      return;
    }

    const geometryProto = THREE.BufferGeometry.prototype as THREE.BufferGeometry & {
      computeBoundsTree?: () => void;
      disposeBoundsTree?: () => void;
    };
    geometryProto.computeBoundsTree = computeBoundsTree;
    geometryProto.disposeBoundsTree = disposeBoundsTree;

    const meshProto = THREE.Mesh.prototype as THREE.Mesh & {
      raycast: typeof acceleratedRaycast;
    };
    meshProto.raycast = acceleratedRaycast;

    this.scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh) {
        const geometry = object.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
        if (!geometry.boundsTree) {
          geometry.computeBoundsTree?.();
        }
      }
    });

    this.refreshInspector();
  }

  private async loadCollection(collection: CollectionRef): Promise<void> {
    const THREE = this.activeThree;
    this.status.set(`Loading collection: ${collection.displayName}...`);
    this.clearActiveGroup();

    const manifest = collection.manifestUrl
      ? await this.assetService.loadManifest(collection.manifestUrl)
      : null;

    this.currentManifest = manifest;

    if (!manifest || !manifest.lods || manifest.lods.length === 0) {
      this.buildProceduralScene();
      this.status.set('Procedural scene loaded.');
      return;
    }

    if (manifest.environment) {
      try {
        const hdr = await this.assetService.loadHdr(manifest.environment);
        this.applyEnvironment(hdr as THREE.Texture);
      } catch {
        this.applyEnvironment(null);
      }
    } else {
      this.applyEnvironment(null);
    }

    const group = new THREE.Group();
    this.activeGroup = group;
    this.scene?.add(group);

    await this.loadLod(manifest.lods, group);
    this.status.set(`Loaded ${manifest.displayName}.`);
  }

  private async loadLod(lods: string[], group: THREE.Group): Promise<void> {
    const THREE = this.activeThree;
    if (!this.scene) {
      return;
    }

    const lod = new THREE.LOD();
    group.add(lod);

    await this.loadLodLevel(lods[0], lod, 0);

    const higher = lods.slice(1);
    higher.forEach((url, index) => {
      const distance = (index + 1) * 12 + this.sceneSettings().lodBias * 3;
      void this.loadLodLevel(url, lod, distance);
    });

    this.refreshInspector();
  }

  private async loadLodLevel(url: string, lod: THREE.LOD, distance: number): Promise<void> {
    const THREE = this.activeThree;
    try {
      const gltf = (await this.assetService.loadGltf(url)) as { scene: THREE.Group };
      const scene = gltf.scene;
      scene.traverse((object: THREE.Object3D) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
          if (object.material instanceof THREE.MeshStandardMaterial) {
            object.material.envMapIntensity = this.sceneSettings().environmentIntensity;
          }
        }
      });
      lod.addLevel(scene, distance);
    } catch {
      this.status.set(`Failed to load LOD: ${url}`);
    }
  }

  private buildProceduralScene(): void {
    const THREE = this.activeThree;
    if (!this.scene) {
      return;
    }

    const group = new THREE.Group();
    this.activeGroup = group;
    this.scene.add(group);

    const materialA = new THREE.MeshStandardMaterial({
      color: 0x1f8f82,
      metalness: 0.4,
      roughness: 0.35,
    });
    const materialB = new THREE.MeshStandardMaterial({
      color: 0xf7b545,
      metalness: 0.2,
      roughness: 0.5,
    });
    const materialC = new THREE.MeshStandardMaterial({
      color: 0xff6b4a,
      metalness: 0.7,
      roughness: 0.2,
    });

    const geoA = new THREE.TorusKnotGeometry(1.2, 0.4, 180, 32);
    const geoB = new THREE.IcosahedronGeometry(1.2, 2);
    const geoC = new THREE.BoxGeometry(1.6, 1.6, 1.6);

    const meshA = new THREE.Mesh(geoA, materialA);
    meshA.position.set(-2.6, 1.6, 0);
    meshA.castShadow = true;

    const meshB = new THREE.Mesh(geoB, materialB);
    meshB.position.set(0.2, 1.2, -1.8);
    meshB.castShadow = true;

    const meshC = new THREE.Mesh(geoC, materialC);
    meshC.position.set(2.6, 1.1, 1.6);
    meshC.castShadow = true;

    group.add(meshA, meshB, meshC);

    this.refreshInspector();
  }

  private clearActiveGroup(): void {
    const THREE = this.activeThree;
    if (!this.scene || !this.activeGroup) {
      return;
    }

    this.scene.remove(this.activeGroup);
    this.activeGroup.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        if (Array.isArray(object.material)) {
          object.material.forEach((material: THREE.Material) => material.dispose());
        } else {
          object.material.dispose();
        }
      }
    });
    this.activeGroup = null;
  }

  private refreshInspector(): void {
    const THREE = this.activeThree;
    if (!this.scene) {
      return;
    }

    let meshCount = 0;
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    let lodCount = 0;
    let bvhCount = 0;

    this.scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.LOD) {
        lodCount += 1;
      }

      if (object instanceof THREE.Mesh) {
        meshCount += 1;
        const material = object.material;
        if (Array.isArray(material)) {
          material.forEach((item) => materials.add(item));
        } else {
          materials.add(material);
        }

        if ((object.geometry as any).boundsTree) {
          bvhCount += 1;
        }

        if (material instanceof THREE.MeshStandardMaterial) {
          const maps: Array<THREE.Texture | null> = [
            material.map,
            material.normalMap,
            material.roughnessMap,
            material.metalnessMap,
            material.emissiveMap,
          ];
          maps.forEach((texture) => {
            if (texture) {
              textures.add(texture);
            }
          });
        }
      }
    });

    this.inspector.set({
      meshCount,
      materialCount: materials.size,
      textureCount: textures.size,
      lodCount,
      bvhCount,
    });
  }

  private startLoop(): void {
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }

    this.renderer.setAnimationLoop((time: number) => {
      this.renderFrame(time);
    });
  }

  private renderFrame(time: number): void {
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }

    const delta = this.clock?.getDelta() ?? 0;
    this.frameStats?.beginFrame();
    this.controls?.update();
    if (this.benchmark().active) {
      this.updateBenchmarkPath(time);
    }

    if (this.composer) {
      this.composer.render(delta);
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    this.latestStats = this.frameStats ? this.frameStats.endFrame() : null;
    this.updateMetrics();

    if (this.benchmark().active) {
      this.recordBenchmarkSample();
    }
  }

  private updateMetrics(): void {
    if (!this.renderer) {
      return;
    }

    const stats = this.latestStats;
    const fps = stats ? stats.fps : 0;
    const cpuMs = stats ? stats.cpu : 0;
    const current = this.metrics();

    const info = this.renderer.info;
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    const memoryMb = perf.memory
      ? Math.round((perf.memory.usedJSHeapSize / 1024 / 1024) * 10) / 10
      : 0;

    this.metrics.set({
      fps: Math.round(fps),
      minFps: current.minFps === 0 ? Math.round(fps) : Math.min(current.minFps, Math.round(fps)),
      cpuMs: Math.round(cpuMs * 100) / 100,
      maxFrameTime: Math.max(current.maxFrameTime, cpuMs),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      memoryMb,
      gpuMs: stats?.gpu ?? null,
    });
  }

  private updateBenchmarkPath(time: number): void {
    const elapsed = (time - this.benchmarkStart) / 1000;
    const duration = this.benchmark().duration;

    const t = Math.min(elapsed / duration, 1);
    this.moveCameraAlongPath(t);

    this.benchmark.set({
      active: t < 1,
      progress: t,
      sampleCount: this.benchmarkFrames.length,
      duration,
    });

    if (t >= 1) {
      this.status.set('Benchmark complete. Metrics ready to export.');
    }
  }

  private recordBenchmarkSample(): void {
    if (!this.latestStats) {
      return;
    }

    this.benchmarkFrames.push(this.latestStats.fps);
    this.benchmarkFrameTimes.push(this.latestStats.cpu);
    const current = this.benchmark();
    this.benchmark.set({
      active: current.active,
      progress: current.progress,
      sampleCount: this.benchmarkFrames.length,
      duration: current.duration,
    });
  }

  private moveCameraAlongPath(t: number): void {
    if (!this.camera || !this.controls) {
      return;
    }

    const angle = t * Math.PI * 2;
    const radius = 8 + Math.sin(t * Math.PI * 2) * 1.2;
    this.camera.position.set(
      Math.cos(angle) * radius,
      4 + Math.cos(angle * 2) * 1.2,
      Math.sin(angle) * radius,
    );
    this.controls.target.set(0, 1.2, 0);
  }

  private buildBenchmarkResult(): Record<string, unknown> | null {
    if (this.benchmarkFrames.length === 0) {
      return null;
    }

    const avgFps =
      this.benchmarkFrames.reduce((sum, value) => sum + value, 0) / this.benchmarkFrames.length;
    const minFps = Math.min(...this.benchmarkFrames);
    const maxFrameTime = Math.max(...this.benchmarkFrameTimes);
    const info = this.renderer?.info;

    return {
      renderer: this.rendererLabel(),
      preset: this.presetName(),
      avgFps: Math.round(avgFps),
      minFps: Math.round(minFps),
      maxFrameTime: Math.round(maxFrameTime * 100) / 100,
      drawCalls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      memoryMb: this.metrics().memoryMb,
      gpuMs: this.metrics().gpuMs,
      settings: {
        rendering: this.settings(),
        scene: this.sceneSettings(),
      },
    };
  }

  private disposeRenderer(): void {
    if (!this.renderer) {
      return;
    }

    this.renderer.setAnimationLoop(null);
    if ('dispose' in this.renderer) {
      this.renderer.dispose();
    }
    this.renderer = null;
    this.frameStats?.dispose();
    this.frameStats = null;
    this.latestStats = null;
  }

  private dispose(): void {
    this.disposeRenderer();
    this.clearActiveGroup();
    this.controls?.dispose();
    this.controls = null;
    this.composer = null;
    this.scene = null;
    this.camera = null;
    this.frameStats?.dispose();
    this.frameStats = null;
    this.gui?.destroy();
    this.gui = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }
}
