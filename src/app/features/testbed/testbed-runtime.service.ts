import { Injectable } from '@angular/core';
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

import { CapabilitySummary, RenderingSettings } from './controls.model';
import { RendererInstance } from './frame-stats-tracker';

export type ComposerBundle = {
  composer: EffectComposer | null;
  renderPass: RenderPass | null;
  fxaaPass: ShaderPass | null;
  smaaPass: SMAAPass | null;
  taaPass: TAARenderPass | null;
  ssaoPass: SSAOPass | null;
  dofPass: BokehPass | null;
  filmPass: FilmPass | null;
  vignettePass: ShaderPass | null;
  chromaticPass: ShaderPass | null;
};

type RendererBuildResult = {
  renderer: RendererInstance;
  rendererLabel: string;
  usingMsaa: boolean;
  currentMode: 'webgl' | 'webgpu';
  threeModule: typeof THREE;
};

@Injectable({ providedIn: 'root' })
export class TestbedRuntimeService {
  resolveRendererMode(
    requested: RenderingSettings['rendererMode'],
    capabilities: CapabilitySummary,
  ): 'webgl' | 'webgpu' {
    if (requested === 'webgpu' && !capabilities.webgpu) {
      return 'webgl';
    }
    return requested;
  }

  getThreeModule(mode: 'webgl' | 'webgpu'): typeof THREE {
    return mode === 'webgpu' ? (THREE_WEBGPU as unknown as typeof THREE) : THREE;
  }

  async createRenderer(
    canvas: HTMLCanvasElement,
    mode: 'webgl' | 'webgpu',
    settings: RenderingSettings,
  ): Promise<RendererBuildResult> {
    const threeModule = this.getThreeModule(mode);
    const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

    if (mode === 'webgpu' && hasWebGpu) {
      const renderer = new THREE_WEBGPU.WebGPURenderer({ canvas, antialias: false });
      await renderer.init();
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.outputColorSpace = THREE_WEBGPU.SRGBColorSpace;

      return {
        renderer,
        rendererLabel: 'WebGPU',
        usingMsaa: false,
        currentMode: 'webgpu',
        threeModule,
      };
    }

    const THREE = threeModule;
    const msaaEnabled = settings.antialiasing === 'msaa';
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: msaaEnabled,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    return {
      renderer,
      rendererLabel: 'WebGL',
      usingMsaa: msaaEnabled,
      currentMode: 'webgl',
      threeModule,
    };
  }

  createScene(threeModule: typeof THREE): {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    primaryLight: THREE.DirectionalLight;
  } {
    const THREE = threeModule;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1117');

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
    camera.position.set(5, 4.5, 8);

    const grid = new THREE.GridHelper(40, 40, 0x1b3b3b, 0x10222c);
    grid.position.y = -0.01;
    scene.add(grid);

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
    scene.add(floor);

    const ambient = new THREE.AmbientLight(0x9fb3c8, 0.35);
    scene.add(ambient);

    const primaryLight = new THREE.DirectionalLight(0xffffff, 1.2);
    primaryLight.position.set(6, 8, 4);
    primaryLight.castShadow = true;
    primaryLight.shadow.mapSize.set(2048, 2048);
    primaryLight.shadow.camera.near = 1;
    primaryLight.shadow.camera.far = 40;
    scene.add(primaryLight);

    const rimLight = new THREE.PointLight(0x45e3c2, 0.9, 40);
    rimLight.position.set(-5, 4, -6);
    scene.add(rimLight);

    return {
      scene,
      camera,
      primaryLight,
    };
  }

  createControls(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    autoRotate: boolean,
  ): OrbitControls {
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 0.5;
    return controls;
  }

  createComposer(
    renderer: RendererInstance | null,
    scene: THREE.Scene | null,
    camera: THREE.PerspectiveCamera | null,
    threeModule: typeof THREE,
    settings: RenderingSettings,
  ): ComposerBundle {
    const THREE = threeModule;
    if (!renderer || !scene || !camera) {
      return {
        composer: null,
        renderPass: null,
        fxaaPass: null,
        smaaPass: null,
        taaPass: null,
        ssaoPass: null,
        dofPass: null,
        filmPass: null,
        vignettePass: null,
        chromaticPass: null,
      };
    }

    if (!(renderer instanceof THREE.WebGLRenderer)) {
      return {
        composer: null,
        renderPass: null,
        fxaaPass: null,
        smaaPass: null,
        taaPass: null,
        ssaoPass: null,
        dofPass: null,
        filmPass: null,
        vignettePass: null,
        chromaticPass: null,
      };
    }

    const webglRenderer = renderer as THREE.WebGLRenderer;
    const composer = new EffectComposer(webglRenderer);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const fxaaPass = new ShaderPass(FXAAShader);
    composer.addPass(fxaaPass);

    const smaaPass = new SMAAPass();
    composer.addPass(smaaPass);

    const taaPass = new TAARenderPass(scene, camera);
    composer.addPass(taaPass);

    const ssaoPass = new SSAOPass(scene, camera, 1, 1);
    composer.addPass(ssaoPass);

    const dofPass = new BokehPass(scene, camera, {
      focus: settings.dofFocus,
      aperture: settings.dofAperture,
      maxblur: settings.dofMaxBlur,
    });
    composer.addPass(dofPass);

    const filmPass = new FilmPass(0.25, false);
    composer.addPass(filmPass);

    const vignettePass = new ShaderPass(VignetteShader);
    composer.addPass(vignettePass);

    const chromaticPass = new ShaderPass(RGBShiftShader);
    composer.addPass(chromaticPass);

    return {
      composer,
      renderPass,
      fxaaPass,
      smaaPass,
      taaPass,
      ssaoPass,
      dofPass,
      filmPass,
      vignettePass,
      chromaticPass,
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
    if (!bundle.composer) {
      return;
    }

    const { width, height } = this.getViewportSize(viewport);
    bundle.composer.setSize(width, height);

    if (bundle.fxaaPass) {
      bundle.fxaaPass.material.uniforms['resolution'].value.set(1 / width, 1 / height);
    }

    if (bundle.smaaPass) {
      bundle.smaaPass.setSize(width, height);
    }

    if (bundle.ssaoPass) {
      bundle.ssaoPass.setSize(width, height);
    }
  }

  updateSize(
    renderer: RendererInstance | null,
    camera: THREE.PerspectiveCamera | null,
    viewport: HTMLElement,
    bundle: ComposerBundle,
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
  }
}
