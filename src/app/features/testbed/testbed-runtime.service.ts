import { Injectable } from '@angular/core';
import * as THREE from 'three';
import * as THREE_WEBGPU from 'three/webgpu';
import { diffuseColor, metalness, mrt, normalView, output, pass, velocity } from 'three/tsl';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { TAARenderPass } from 'three/examples/jsm/postprocessing/TAARenderPass.js';
import { SSRPass } from 'three/examples/jsm/postprocessing/SSRPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { FilmPass } from 'three/examples/jsm/postprocessing/FilmPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { CapabilitySummary, RenderingSettings, RendererMode, Vector3Tuple } from './controls.model';
import { RendererInstance } from './frame-stats-tracker';

export type ThreeModule = typeof THREE | typeof THREE_WEBGPU;

export type SceneInstance = THREE.Scene | THREE_WEBGPU.Scene;
export type CameraInstance = THREE.PerspectiveCamera | THREE_WEBGPU.PerspectiveCamera;
export type GroupInstance = THREE.Group | THREE_WEBGPU.Group;
export type TextureInstance = THREE.Texture | THREE_WEBGPU.Texture;

export type WebGpuPostBundle = {
  postProcessing: THREE_WEBGPU.PostProcessing;
  scenePass: ReturnType<typeof pass>;
  camera: THREE.PerspectiveCamera;
};

export type ComposerBundle = {
  composer: EffectComposer | null;
  renderPass: RenderPass | null;
  ssrPass: SSRPass | null;
  fxaaPass: ShaderPass | null;
  smaaPass: SMAAPass | null;
  taaPass: TAARenderPass | null;
  gtaoPass: GTAOPass | null;
  dofPass: BokehPass | null;
  filmPass: FilmPass | null;
  vignettePass: ShaderPass | null;
  finalPass: OutputPass | null;
  webgpu: WebGpuPostBundle | null;
};

type RendererBuildResult =
  | {
      renderer: THREE.WebGLRenderer;
      rendererLabel: 'WebGL';
      usingMsaa: boolean;
      currentMode: 'webgl';
      threeModule: typeof THREE;
    }
  | {
      renderer: THREE_WEBGPU.WebGPURenderer;
      rendererLabel: 'WebGPU';
      usingMsaa: false;
      currentMode: 'webgpu';
      threeModule: typeof THREE_WEBGPU;
    };

@Injectable({ providedIn: 'root' })
export class TestbedRuntimeService {
  resolveRendererMode(
    requested: RenderingSettings['rendererMode'],
    capabilities: CapabilitySummary,
  ): RendererMode {
    if (requested === 'webgpu' && !capabilities.webgpu) {
      return 'webgl';
    }
    return requested;
  }

  getThreeModule(mode: 'webgl'): typeof THREE;
  getThreeModule(mode: 'webgpu'): typeof THREE_WEBGPU;
  getThreeModule(mode: RendererMode): ThreeModule {
    return mode === 'webgpu' ? THREE_WEBGPU : THREE;
  }

  async createRenderer(
    canvas: HTMLCanvasElement,
    mode: RendererMode,
    settings: RenderingSettings,
  ): Promise<RendererBuildResult> {
    const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

    if (mode === 'webgpu' && hasWebGpu) {
      const threeModule = this.getThreeModule('webgpu');
      const renderer = new threeModule.WebGPURenderer({ canvas, antialias: false });
      await renderer.init();
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.outputColorSpace = threeModule.SRGBColorSpace;

      return {
        renderer,
        rendererLabel: 'WebGPU',
        usingMsaa: false,
        currentMode: 'webgpu',
        threeModule,
      };
    }

    const threeModule = this.getThreeModule('webgl');
    const msaaEnabled = settings.antialiasing === 'msaa';
    const renderer = new threeModule.WebGLRenderer({
      canvas,
      antialias: msaaEnabled,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.outputColorSpace = threeModule.SRGBColorSpace;

    return {
      renderer,
      rendererLabel: 'WebGL',
      usingMsaa: msaaEnabled,
      currentMode: 'webgl',
      threeModule,
    };
  }

  createScene(threeModule: ThreeModule): {
    scene: SceneInstance;
    camera: CameraInstance;
  } {
    const scene = new threeModule.Scene();
    scene.name = 'Main Scene';
    scene.background = new threeModule.Color('#0b1117');

    const camera = new threeModule.PerspectiveCamera(55, 1, 0.1, 200);
    camera.name = 'Main Camera';

    const grid = new threeModule.GridHelper(50, 50, 0x1b3b3b, 0x10222c);
    grid.name = 'Grid Helper';
    grid.position.y = -0.01;
    scene.add(grid);

    return {
      scene,
      camera,
    };
  }

  createControls(
    camera: CameraInstance,
    canvas: HTMLCanvasElement,
    autoRotate: boolean,
  ): OrbitControls {
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 0.5;
    return controls;
  }

  applyCameraAndControlTarget(
    camera: CameraInstance | null,
    controls: OrbitControls | null,
    cameraPosition: Vector3Tuple,
    controlTarget: Vector3Tuple,
  ): void {
    if (!camera || !controls) {
      return;
    }

    camera.position.set(cameraPosition[0], cameraPosition[1], cameraPosition[2]);
    controls.target.set(controlTarget[0], controlTarget[1], controlTarget[2]);
    controls.update();
  }

  createComposer(
    renderer: RendererInstance | null,
    scene: SceneInstance | null,
    camera: CameraInstance | null,
    mode: RendererMode,
    settings: RenderingSettings,
  ): ComposerBundle {
    if (!renderer || !scene || !camera) {
      return this.createEmptyComposerBundle();
    }

    if (mode === 'webgpu' && renderer instanceof THREE_WEBGPU.WebGPURenderer) {
      const scenePass = pass(scene, camera);
      scenePass.setMRT(
        mrt({
          output,
          diffuseColor,
          normal: normalView,
          velocity,
          metalness,
        }),
      );

      const postProcessing = new THREE_WEBGPU.PostProcessing(
        renderer,
        scenePass.getTextureNode('output'),
      );
      return {
        ...this.createEmptyComposerBundle(),
        webgpu: {
          postProcessing,
          scenePass,
          camera,
        },
      };
    }

    if (!(renderer instanceof THREE.WebGLRenderer)) {
      return this.createEmptyComposerBundle();
    }

    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const ssrPass = new SSRPass({
      renderer,
      scene,
      camera,
      width: 1,
      height: 1,
      selects: null,
      groundReflector: null,
    });
    composer.addPass(ssrPass);

    const gtaoPass = new GTAOPass(scene, camera, 1, 1);
    composer.addPass(gtaoPass);

    const dofPass = new BokehPass(scene, camera, {
      focus: settings.dofFocus,
      aperture: settings.dofAperture,
      maxblur: settings.dofMaxBlur,
    });
    composer.addPass(dofPass);

    const fxaaPass = new ShaderPass(FXAAShader);
    composer.addPass(fxaaPass);

    const smaaPass = new SMAAPass();
    composer.addPass(smaaPass);

    const taaPass = new TAARenderPass(scene, camera);
    composer.addPass(taaPass);

    const filmPass = new FilmPass(0.25, false);
    composer.addPass(filmPass);

    const vignettePass = new ShaderPass(VignetteShader);
    composer.addPass(vignettePass);

    const finalPass = new OutputPass();
    composer.addPass(finalPass);

    return {
      composer,
      renderPass,
      ssrPass,
      fxaaPass,
      smaaPass,
      taaPass,
      gtaoPass,
      dofPass,
      filmPass,
      vignettePass,
      finalPass,
      webgpu: null,
    };
  }

  createEmptyComposerBundle(): ComposerBundle {
    return {
      composer: null,
      renderPass: null,
      ssrPass: null,
      fxaaPass: null,
      smaaPass: null,
      taaPass: null,
      gtaoPass: null,
      dofPass: null,
      filmPass: null,
      vignettePass: null,
      finalPass: null,
      webgpu: null,
    };
  }

  getViewportSize(viewport: HTMLElement): { width: number; height: number } {
    const { clientWidth, clientHeight } = viewport;
    return {
      width: Math.max(1, clientWidth),
      height: Math.max(1, clientHeight),
    };
  }

  updateComposerSize(bundle: ComposerBundle, viewport: HTMLElement): void {
    const { width, height } = this.getViewportSize(viewport);

    if (bundle.webgpu) {
      bundle.webgpu.scenePass.setSize(width, height);
    }

    if (!bundle.composer) {
      return;
    }

    bundle.composer.setSize(width, height);

    if (bundle.fxaaPass) {
      bundle.fxaaPass.material.uniforms['resolution'].value.set(1 / width, 1 / height);
    }

    if (bundle.smaaPass) {
      bundle.smaaPass.setSize(width, height);
    }

    if (bundle.gtaoPass) {
      bundle.gtaoPass.setSize(width, height);
    }

    if (bundle.ssrPass) {
      bundle.ssrPass.setSize(width, height);
    }
  }

  updateSize(
    renderer: RendererInstance | null,
    camera: CameraInstance | null,
    viewport: HTMLElement,
    bundle: ComposerBundle,
    mode: RendererMode,
  ): void {
    if (!renderer || !camera) {
      return;
    }

    const { clientWidth, clientHeight } = viewport;
    if (clientWidth === 0 || clientHeight === 0) {
      return;
    }

    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();

    renderer.setSize(clientWidth, clientHeight, false);
    this.updateComposerSize(bundle, viewport);

    if (mode === 'webgpu' && bundle.webgpu) {
      bundle.webgpu.postProcessing.needsUpdate = true;
    }
  }
}
