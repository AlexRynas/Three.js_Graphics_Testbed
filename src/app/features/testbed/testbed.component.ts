import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
import GUI from 'lil-gui';
import {
  CollectionManifest,
  CollectionRef,
  InspectorSnapshot,
  Preset,
  RenderingSettings,
  SceneSettings,
  defaultRenderingSettings,
  defaultSceneSettings,
} from './controls.model';
import { AssetService } from './asset.service';
import { BenchmarkService } from './benchmark.service';
import { CapabilitiesService } from './capabilities.service';
import { FrameStatsTracker, RendererInstance } from './frame-stats-tracker';
import { GuiBridgeService } from './gui-bridge.service';
import { InspectorService } from './inspector.service';
import { PresetService } from './preset.service';
import { RenderingSettingsService } from './rendering-settings.service';
import { SceneOptimizationService } from './scene-optimization.service';
import { StatsSample } from './metrics.model';
import { CapabilitiesPanelComponent } from './components/panels/capabilities-panel/capabilities-panel.component';
import { CollectionsPanelComponent } from './components/panels/collections-panel/collections-panel.component';
import { FeatureTogglesPanelComponent } from './components/panels/feature-toggles-panel/feature-toggles-panel.component';
import { InspectorPanelComponent } from './components/panels/inspector-panel/inspector-panel.component';
import { PresetsPanelComponent } from './components/panels/presets-panel/presets-panel.component';
import { GuiDockComponent } from './components/gui-dock/gui-dock.component';
import { HudComponent } from './components/hud/hud.component';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { StatusBarComponent } from './components/status-bar/status-bar.component';
import { TopbarComponent } from './components/topbar/topbar.component';
import { ViewportComponent } from './components/viewport/viewport.component';

@Component({
  selector: 'app-testbed',
  templateUrl: './testbed.component.html',
  styleUrl: './testbed.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    CapabilitiesPanelComponent,
    CollectionsPanelComponent,
    FeatureTogglesPanelComponent,
    InspectorPanelComponent,
    PresetsPanelComponent,
    GuiDockComponent,
    HudComponent,
    SidebarComponent,
    StatusBarComponent,
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
  private readonly benchmarkService = inject(BenchmarkService);
  private readonly capabilitiesService = inject(CapabilitiesService);
  private readonly guiBridgeService = inject(GuiBridgeService);
  private readonly inspectorService = inject(InspectorService);
  private readonly presetService = inject(PresetService);
  private readonly renderingSettingsService = inject(RenderingSettingsService);
  private readonly sceneOptimizationService = inject(SceneOptimizationService);
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
  readonly metrics = this.benchmarkService.metrics;
  readonly benchmark = this.benchmarkService.benchmark;

  readonly capabilitySummary = this.capabilitiesService.capabilities;

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

  updatePresetName(name: string): void {
    this.presetName.set(name);
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
    if (!this.benchmarkService.startBenchmark()) {
      return;
    }

    this.status.set('Running benchmark path...');
  }

  exportMetrics(): void {
    const result = this.benchmarkService.buildBenchmarkResult({
      renderer: this.rendererLabel(),
      preset: this.presetName(),
      settings: {
        rendering: this.settings(),
        scene: this.sceneSettings(),
      },
    });
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
    this.renderingSettingsService.applyPostProcessing(
      {
        composer: this.composer,
        fxaaPass: this.fxaaPass,
        smaaPass: this.smaaPass,
        taaPass: this.taaPass,
        ssaoPass: this.ssaoPass,
        dofPass: this.dofPass,
        filmPass: this.filmPass,
        vignettePass: this.vignettePass,
        chromaticPass: this.chromaticPass,
      },
      this.settings(),
      this.settings().rendererMode,
      this.getViewportSize(),
    );
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
    this.gui = this.guiBridgeService.mount({
      host: this.guiDock().element,
      existingGui: this.gui,
      rendering: this.settings(),
      scene: this.sceneSettings(),
      onCommit: (rendering, scene) => {
        this.settings.set({ ...rendering });
        this.sceneSettings.set({ ...scene });
      },
    });
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
    this.sceneOptimizationService.applyEnvironmentIntensity(
      this.scene,
      this.activeThree,
      sceneSettings.environmentIntensity,
    );
    this.sceneOptimizationService.updateLodBias(this.scene, this.activeThree, sceneSettings.lodBias);
    this.renderingSettingsService.applyPostProcessing(
      {
        composer: this.composer,
        fxaaPass: this.fxaaPass,
        smaaPass: this.smaaPass,
        taaPass: this.taaPass,
        ssaoPass: this.ssaoPass,
        dofPass: this.dofPass,
        filmPass: this.filmPass,
        vignettePass: this.vignettePass,
        chromaticPass: this.chromaticPass,
      },
      settings,
      this.settings().rendererMode,
      this.getViewportSize(),
    );
    this.renderingSettingsService.applyShadowSettings(this.renderer, settings);
    this.applyLensFlares(settings);
    this.renderingSettingsService.applyTextureFiltering(
      this.renderer,
      this.scene,
      this.activeThree,
      settings,
      this.capabilitySummary(),
    );
    if (this.sceneOptimizationService.applyBvh(this.scene, this.activeThree, sceneSettings.bvhEnabled)) {
      this.refreshInspector();
    }
    const unsupported = this.renderingSettingsService.getUnsupportedLabel(
      settings,
      this.settings().rendererMode,
      this.rendererLabel(),
    );
    if (unsupported) {
      this.status.set(unsupported);
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
    this.renderingSettingsService.applyToneMapping(this.renderer, this.activeThree, sceneSettings);
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
    if (!this.scene) {
      return;
    }

    this.inspector.set(this.inspectorService.buildSnapshot(this.scene, this.activeThree));
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

    const info = this.renderer.info;
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    const memoryMb = perf.memory
      ? Math.round((perf.memory.usedJSHeapSize / 1024 / 1024) * 10) / 10
      : 0;

    this.benchmarkService.updateMetrics(
      this.latestStats,
      {
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
      },
      memoryMb,
    );
  }

  private updateBenchmarkPath(time: number): void {
    const { progress, completed } = this.benchmarkService.updateBenchmarkProgress(time);
    this.moveCameraAlongPath(progress);

    if (completed) {
      this.status.set('Benchmark complete. Metrics ready to export.');
    }
  }

  private recordBenchmarkSample(): void {
    this.benchmarkService.recordBenchmarkSample(this.latestStats);
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
