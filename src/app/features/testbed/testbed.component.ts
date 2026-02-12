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
import { Lensflare } from 'three/examples/jsm/objects/Lensflare.js';
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
import { LightingEffectsService } from './lighting-effects.service';
import { PresetService } from './preset.service';
import { RenderingSettingsService } from './rendering-settings.service';
import { SceneContentService } from './scene-content.service';
import { SceneOptimizationService } from './scene-optimization.service';
import { StatsSample } from './metrics.model';
import { TestbedRuntimeService } from './testbed-runtime.service';
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
  private readonly lightingEffectsService = inject(LightingEffectsService);
  private readonly presetService = inject(PresetService);
  private readonly renderingSettingsService = inject(RenderingSettingsService);
  private readonly sceneContentService = inject(SceneContentService);
  private readonly sceneOptimizationService = inject(SceneOptimizationService);
  private readonly runtimeService = inject(TestbedRuntimeService);
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
    return this.runtimeService.resolveRendererMode(requested, this.capabilitySummary());
  }

  private setThreeModule(mode: 'webgl' | 'webgpu'): void {
    this.activeThree = this.runtimeService.getThreeModule(mode);
  }

  private async createRenderer(canvas: HTMLCanvasElement, mode: 'webgl' | 'webgpu'): Promise<void> {
    this.disposeRenderer();
    const result = await this.runtimeService.createRenderer(canvas, mode, this.settings());
    this.activeThree = result.threeModule;
    this.renderer = result.renderer;
    this.rendererLabel.set(result.rendererLabel);
    this.usingMsaa = result.usingMsaa;
    this.currentMode = result.currentMode;
  }

  private initScene(): void {
    const setup = this.runtimeService.createScene(this.activeThree);
    this.scene = setup.scene;
    this.camera = setup.camera;
    this.primaryLight = setup.primaryLight;

    this.applyEnvironment(null);
  }

  private initControls(): void {
    if (!this.camera) {
      return;
    }

    this.controls = this.runtimeService.createControls(
      this.camera,
      this.viewportShell().canvas,
      this.sceneSettings().autoRotate,
    );
  }

  private initComposer(): void {
    const bundle = this.runtimeService.createComposer(
      this.renderer,
      this.scene,
      this.camera,
      this.activeThree,
      this.settings(),
    );
    this.composer = bundle.composer;
    this.renderPass = bundle.renderPass;
    this.fxaaPass = bundle.fxaaPass;
    this.smaaPass = bundle.smaaPass;
    this.taaPass = bundle.taaPass;
    this.ssaoPass = bundle.ssaoPass;
    this.dofPass = bundle.dofPass;
    this.filmPass = bundle.filmPass;
    this.vignettePass = bundle.vignettePass;
    this.chromaticPass = bundle.chromaticPass;

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
    this.runtimeService.updateSize(this.renderer, this.camera, this.viewportShell().viewport, {
      composer: this.composer,
      renderPass: this.renderPass,
      fxaaPass: this.fxaaPass,
      smaaPass: this.smaaPass,
      taaPass: this.taaPass,
      ssaoPass: this.ssaoPass,
      dofPass: this.dofPass,
      filmPass: this.filmPass,
      vignettePass: this.vignettePass,
      chromaticPass: this.chromaticPass,
    });
  }

  private updateComposerSize(): void {
    this.runtimeService.updateComposerSize(
      {
        composer: this.composer,
        renderPass: this.renderPass,
        fxaaPass: this.fxaaPass,
        smaaPass: this.smaaPass,
        taaPass: this.taaPass,
        ssaoPass: this.ssaoPass,
        dofPass: this.dofPass,
        filmPass: this.filmPass,
        vignettePass: this.vignettePass,
        chromaticPass: this.chromaticPass,
      },
      this.viewportShell().viewport,
    );
  }

  private getViewportSize(): { width: number; height: number } {
    return this.runtimeService.getViewportSize(this.viewportShell().viewport);
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
    this.lightingEffectsService.applyEnvironment(
      this.scene,
      this.renderer,
      this.activeThree,
      hdrTexture,
    );
  }

  private applyLensFlares(settings: RenderingSettings): void {
    this.lensflare = this.lightingEffectsService.syncLensFlares(
      this.primaryLight,
      this.lensflare,
      settings.lensFlares,
      this.activeThree,
    );
  }

  private async loadCollection(collection: CollectionRef): Promise<void> {
    this.status.set(`Loading collection: ${collection.displayName}...`);
    const result = await this.sceneContentService.loadCollection({
      collection,
      scene: this.scene,
      threeModule: this.activeThree,
      sceneSettings: this.sceneSettings(),
      activeGroup: this.activeGroup,
      applyEnvironment: (hdrTexture) => this.applyEnvironment(hdrTexture),
    });

    this.currentManifest = result.manifest;
    this.activeGroup = result.activeGroup;
    this.refreshInspector();

    if (result.procedural) {
      this.status.set('Procedural scene loaded.');
      return;
    }

    this.status.set(`Loaded ${collection.displayName}.`);
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
    this.activeGroup = this.sceneContentService.clearActiveGroup(
      this.scene,
      this.activeGroup,
      this.activeThree,
    );
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
