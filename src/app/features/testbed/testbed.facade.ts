import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import {
  CollectionRef,
  InspectorSnapshot,
  Preset,
  RenderingControlConstraints,
  RenderingSupport,
  RenderingSettings,
  SceneSettings,
  defaultRenderingSettings,
  defaultSceneSettings,
  RendererMode,
} from './controls.model';
import { AssetService } from './asset.service';
import { BenchmarkService } from './benchmark.service';
import { CapabilitiesService } from './capabilities.service';
import { FrameStatsTracker, RendererInstance } from './frame-stats-tracker';
import { InspectorService } from './inspector.service';
import { LightingEffectsService } from './lighting-effects.service';
import { PresetService } from './preset.service';
import { RenderingSettingsService } from './rendering-settings.service';
import { SceneContentService } from './scene-content.service';
import { SceneOptimizationService } from './scene-optimization.service';
import { StatsSample } from './metrics.model';
import {
  CameraInstance,
  ComposerBundle,
  GroupInstance,
  SceneInstance,
  TestbedRuntimeService,
  TextureInstance,
  ThreeModule,
} from './testbed-runtime.service';
import { ViewportComponent } from './components/viewport/viewport.component';

@Injectable()
export class TestbedFacade {
  private readonly assetService = inject(AssetService);
  private readonly benchmarkService = inject(BenchmarkService);
  private readonly capabilitiesService = inject(CapabilitiesService);
  private readonly inspectorService = inject(InspectorService);
  private readonly lightingEffectsService = inject(LightingEffectsService);
  private readonly presetService = inject(PresetService);
  private readonly renderingSettingsService = inject(RenderingSettingsService);
  private readonly sceneContentService = inject(SceneContentService);
  private readonly sceneOptimizationService = inject(SceneOptimizationService);
  private readonly runtimeService = inject(TestbedRuntimeService);

  private renderer: RendererInstance | null = null;
  private composerBundle: ComposerBundle;

  private scene: SceneInstance | null = null;
  private camera: CameraInstance | null = null;
  private controls: OrbitControls | null = null;
  private activeThree: ThreeModule;
  private clock: InstanceType<ThreeModule['Clock']> | null = null;
  private frameStats: FrameStatsTracker | null = null;
  private latestStats: StatsSample | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private activeGroup: GroupInstance | null = null;
  private usingMsaa = true;
  private currentMode: RendererMode = 'webgl';
  private activeEnvironmentUrl: string | null = null;
  private environmentLoadToken = 0;
  private environmentEnabledApplied = defaultSceneSettings.environmentMapEnabled;

  private viewportShellRef: ViewportComponent | null = null;

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
  readonly sceneControlConstraints = signal<RenderingControlConstraints>({});

  readonly capabilitySummary = this.capabilitiesService.capabilities;
  readonly presets = this.presetService.presets;
  readonly renderingSupport = computed<RenderingSupport>(() => {
    const settings = this.settings();
    const mode = this.resolveRendererMode(settings.rendererMode);
    const availability = this.renderingSettingsService.getAvailability(mode, settings);
    return this.renderingSettingsService.mergeControlConstraints(
      availability,
      this.sceneControlConstraints(),
    );
  });

  constructor() {
    this.activeThree = this.runtimeService.getThreeModule('webgl');
    this.composerBundle = this.runtimeService.createEmptyComposerBundle();

    effect(() => {
      const settings = this.settings();
      const sceneSettings = this.sceneSettings();
      void this.applySettings(settings, sceneSettings);
    });
  }

  async afterViewInit(viewportShell: ViewportComponent, destroyRef: DestroyRef): Promise<void> {
    this.viewportShellRef = viewportShell;

    await this.capabilitiesService.detect();
    await this.initialize();

    destroyRef.onDestroy(() => {
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
    this.settings.set({ ...defaultRenderingSettings, ...preset.rendering });
    this.sceneSettings.set({ ...defaultSceneSettings, ...preset.scene });
    this.presetName.set(preset.name);
  }

  deletePreset(preset: Preset): void {
    this.presetService.deletePreset(preset.name);
  }

  updatePresetName(name: string): void {
    this.presetName.set(name);
  }

  updateRenderingSetting<K extends keyof RenderingSettings>(
    key: K,
    value: RenderingSettings[K],
  ): void {
    this.settings.update((current) => ({ ...current, [key]: value }));
  }

  updateSceneSetting<K extends keyof SceneSettings>(key: K, value: SceneSettings[K]): void {
    this.sceneSettings.update((current) => ({ ...current, [key]: value }));
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

    this.downloadJson(result, `benchmark-${Date.now()}.json`);
  }

  exportSceneJson(): void {
    if (!this.scene) {
      return;
    }

    const collectionId = this.activeCollectionId().trim() || 'scene';
    const sceneJson = this.scene.toJSON();
    this.downloadJson(sceneJson, `scene-${collectionId}-${Date.now()}.json`);
  }

  private downloadJson(payload: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(objectUrl);
  }

  private async initialize(): Promise<void> {
    const viewportShell = this.viewportShellRef;
    if (!viewportShell) {
      return;
    }

    const collectionList = await this.assetService.loadCollectionsIndex();
    this.collections.set(collectionList);
    this.presetService.setInitialPresets(this.assetService.buildDefaultPresets());

    const canvas = viewportShell.canvas;
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

  private resolveRendererMode(requested: RenderingSettings['rendererMode']): RendererMode {
    return this.runtimeService.resolveRendererMode(requested, this.capabilitySummary());
  }

  private setThreeModule(mode: RendererMode): void {
    this.activeThree =
      mode === 'webgpu'
        ? this.runtimeService.getThreeModule('webgpu')
        : this.runtimeService.getThreeModule('webgl');
  }

  private async createRenderer(canvas: HTMLCanvasElement, mode: RendererMode): Promise<void> {
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
    this.refreshSceneControlConstraints();

    this.applyEnvironment(null, null);
  }

  private initControls(): void {
    const viewportShell = this.viewportShellRef;
    if (!this.camera || !viewportShell) {
      return;
    }

    this.controls = this.runtimeService.createControls(
      this.camera,
      viewportShell.canvas,
      this.sceneSettings().autoRotate,
    );
  }

  private initComposer(): void {
    this.composerBundle = this.runtimeService.createComposer(
      this.renderer,
      this.scene,
      this.camera,
      this.currentMode,
      this.settings(),
    );

    this.updateComposerSize();
    this.renderingSettingsService.applyPostProcessing(
      this.composerBundle,
      this.settings(),
      this.currentMode,
      this.getViewportSize(),
      this.scene,
    );
  }

  private initFrameStats(): void {
    if (!this.renderer) {
      return;
    }

    if (!this.frameStats) {
      this.frameStats = new FrameStatsTracker();
    }

    this.frameStats.init(this.renderer, this.currentMode);
  }

  private setupResizeObserver(): void {
    const viewportShell = this.viewportShellRef;
    if (!viewportShell) {
      return;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.updateSize());
    this.resizeObserver.observe(viewportShell.viewport);
    this.updateSize();
  }

  private updateSize(): void {
    const viewportShell = this.viewportShellRef;
    if (!viewportShell) {
      return;
    }

    this.runtimeService.updateSize(
      this.renderer,
      this.camera,
      viewportShell.viewport,
      this.composerBundle,
      this.currentMode,
    );
  }

  private updateComposerSize(): void {
    const viewportShell = this.viewportShellRef;
    if (!viewportShell) {
      return;
    }

    this.runtimeService.updateComposerSize(this.composerBundle, viewportShell.viewport);
  }

  private getViewportSize(): { width: number; height: number } {
    const viewportShell = this.viewportShellRef;
    if (!viewportShell) {
      return { width: 1, height: 1 };
    }

    return this.runtimeService.getViewportSize(viewportShell.viewport);
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

    const baseSupport = this.renderingSettingsService.getAvailability(resolvedMode, settings);
    const effectiveSupport = this.renderingSettingsService.mergeControlConstraints(
      baseSupport,
      this.sceneControlConstraints(),
    );
    const normalizedSettings = this.renderingSettingsService.normalizeSettingsForSupport(
      settings,
      effectiveSupport,
    );
    if (normalizedSettings !== settings) {
      this.settings.set(normalizedSettings);
      return;
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
    if (sceneSettings.environmentMapEnabled !== this.environmentEnabledApplied) {
      this.environmentEnabledApplied = sceneSettings.environmentMapEnabled;
      await this.syncEnvironmentFromState();
    }
    this.sceneOptimizationService.applyEnvironmentIntensity(
      this.scene,
      this.activeThree,
      sceneSettings.environmentIntensity,
    );
    this.sceneOptimizationService.updateLodBias(
      this.scene,
      this.activeThree,
      sceneSettings.lodBias,
    );
    this.renderingSettingsService.applyPostProcessing(
      this.composerBundle,
      settings,
      this.currentMode,
      this.getViewportSize(),
      this.scene,
    );
    const shadowResult = this.renderingSettingsService.applyShadowSettings(
      this.renderer,
      settings,
      this.activeThree,
      this.currentMode,
      this.scene,
    );
    this.renderingSettingsService.applyTextureFiltering(
      this.renderer,
      this.scene,
      this.activeThree,
      settings,
      this.capabilitySummary(),
    );
    if (
      this.sceneOptimizationService.applyBvh(this.scene, this.activeThree, sceneSettings.bvhEnabled)
    ) {
      this.refreshInspector();
    }
    const unsupported = this.renderingSettingsService.getUnsupportedLabel(
      settings,
      this.currentMode,
      this.rendererLabel(),
    );
    if (shadowResult?.fallbackMessage) {
      this.status.set(shadowResult.fallbackMessage);
    } else if (unsupported) {
      this.status.set(unsupported);
    } else if (this.status().startsWith('Unsupported in')) {
      this.status.set('Ready');
    } else if (this.status().startsWith('Shadow type')) {
      this.status.set('Ready');
    }
  }

  private needsMsaaRebuild(settings: RenderingSettings): boolean {
    const wantsMsaa = settings.antialiasing === 'msaa';
    return wantsMsaa !== this.usingMsaa;
  }

  private async reloadRenderer(mode: RendererMode): Promise<void> {
    const viewportShell = this.viewportShellRef;
    if (!viewportShell) {
      return;
    }

    const backendChanged = mode !== this.currentMode;
    if (backendChanged) {
      this.activeGroup = this.sceneContentService.clearActiveGroup(
        this.scene,
        this.activeGroup,
        this.activeThree,
      );
    }

    let canvas = viewportShell.canvas;
    if (backendChanged) {
      canvas = viewportShell.resetCanvas();
      this.controls?.dispose();
      this.controls = null;
    }

    this.setThreeModule(mode);
    await this.createRenderer(canvas, mode);
    if (backendChanged) {
      this.initControls();
    }
    this.initFrameStats();
    this.initComposer();
    this.updateSize();
    this.startLoop();
    const active = this.collections().find((item) => item.id === this.activeCollectionId());
    if (active) {
      await this.loadCollection(active);
    }
    this.status.set(`Renderer switched to ${mode.toUpperCase()}.`);
  }

  private async syncEnvironmentFromState(): Promise<void> {
    this.environmentLoadToken += 1;
    const token = this.environmentLoadToken;
    if (!this.sceneSettings().environmentMapEnabled) {
      this.applyEnvironment(null, this.activeEnvironmentUrl);
      return;
    }

    const environmentUrl = this.activeEnvironmentUrl;
    if (!environmentUrl) {
      this.applyEnvironment(null, null);
      return;
    }

    try {
      const hdr = (await this.assetService.loadHdr(environmentUrl)) as TextureInstance;
      if (token !== this.environmentLoadToken) {
        hdr.dispose();
        return;
      }

      this.applyEnvironment(hdr, environmentUrl);
    } catch {
      if (token !== this.environmentLoadToken) {
        return;
      }

      this.applyEnvironment(null, environmentUrl);
    }
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

  private applyEnvironment(
    hdrTexture: TextureInstance | null,
    environmentUrl: string | null,
  ): void {
    this.activeEnvironmentUrl = environmentUrl;
    this.environmentEnabledApplied = this.sceneSettings().environmentMapEnabled;
    this.lightingEffectsService.applyEnvironment(
      this.scene,
      this.renderer,
      this.activeThree,
      this.currentMode,
      hdrTexture,
      this.sceneSettings().environmentMapEnabled,
    );
    this.sceneOptimizationService.applyEnvironmentIntensity(
      this.scene,
      this.activeThree,
      this.sceneSettings().environmentIntensity,
    );
  }

  private async loadCollection(collection: CollectionRef): Promise<void> {
    this.status.set(`Loading collection: ${collection.displayName}...`);
    const result = await this.sceneContentService.loadCollection({
      collection,
      scene: this.scene,
      threeModule: this.activeThree,
      rendererMode: this.currentMode,
      sceneSettings: this.sceneSettings(),
      activeGroup: this.activeGroup,
      applyEnvironment: (hdrTexture, environmentUrl) =>
        this.applyEnvironment(hdrTexture, environmentUrl),
    });

    this.activeGroup = result.activeGroup;
    this.refreshSceneControlConstraints();
    this.runtimeService.applyCameraAndControlTarget(
      this.camera,
      this.controls,
      result.initialCameraPosition,
      result.initialControlTarget,
    );
    this.renderingSettingsService.applyPostProcessing(
      this.composerBundle,
      this.settings(),
      this.currentMode,
      this.getViewportSize(),
      this.scene,
    );
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

  private refreshSceneControlConstraints(): void {
    const constraints = this.renderingSettingsService.getSceneControlConstraints(this.scene);
    this.sceneControlConstraints.set(constraints);
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

    if (this.composerBundle.webgpu) {
      this.composerBundle.webgpu.postProcessing.render();
    } else if (this.composerBundle.composer) {
      this.composerBundle.composer.render(delta);
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
    this.composerBundle = this.runtimeService.createEmptyComposerBundle();
    this.scene = null;
    this.camera = null;
    this.sceneControlConstraints.set({});
    this.frameStats?.dispose();
    this.frameStats = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.viewportShellRef = null;
  }
}
