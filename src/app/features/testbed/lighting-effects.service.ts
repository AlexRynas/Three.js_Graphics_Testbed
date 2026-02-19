import { Injectable } from '@angular/core';
import { WebGLRenderer } from 'three';
import { BlurredEnvMapGenerator } from 'three-gpu-pathtracer';

import { RendererMode } from './controls.model';
import { RendererInstance } from './frame-stats-tracker';
import { SceneInstance, TextureInstance, ThreeModule } from './testbed-runtime.service';

const PT_SOURCE_ENV_TAG = '__ptSourceEnvironment';
const PT_ENV_MODE_TAG = '__ptEnvironmentMode';
const PT_BLURRED_ENV_TAG = '__ptBlurredEnvironment';
const PT_ENVIRONMENT_BLUR = 0.35;

@Injectable({ providedIn: 'root' })
export class LightingEffectsService {
  applyEnvironment(
    scene: SceneInstance | null,
    renderer: RendererInstance | null,
    threeModule: ThreeModule,
    mode: RendererMode,
    hdrTexture: TextureInstance | null,
    enabled: boolean,
  ): void {
    const THREE = threeModule;
    if (!scene) {
      hdrTexture?.dispose();
      return;
    }

    if (!enabled) {
      hdrTexture?.dispose();
      this.disposeEnvironment(scene);
      return;
    }

    if (mode !== 'webgl' && mode !== 'webgpu') {
      hdrTexture?.dispose();
      return;
    }

    const previousSource = scene.userData[PT_SOURCE_ENV_TAG] as TextureInstance | null | undefined;
    if (previousSource && previousSource !== hdrTexture) {
      previousSource.dispose();
      scene.userData[PT_SOURCE_ENV_TAG] = null;
    }

    const previousBlurred = scene.userData[PT_BLURRED_ENV_TAG] as TextureInstance | null | undefined;
    if (previousBlurred) {
      previousBlurred.dispose();
      scene.userData[PT_BLURRED_ENV_TAG] = null;
    }

    const previousEnvironment = scene.environment;
    if (hdrTexture) {
      hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
      hdrTexture.needsUpdate = true;
      scene.userData[PT_SOURCE_ENV_TAG] = hdrTexture;
      scene.environment = hdrTexture;
    } else {
      scene.userData[PT_SOURCE_ENV_TAG] = null;
      scene.environment = null;
    }

    if (previousEnvironment && previousEnvironment !== scene.environment) {
      previousEnvironment.dispose();
    }

    scene.userData[PT_ENV_MODE_TAG] = false;
  }

  switchPathTracingEnvironment(
    scene: SceneInstance | null,
    renderer: RendererInstance | null,
    threeModule: ThreeModule,
    pathTracingEnabled: boolean,
  ): void {
    const THREE = threeModule;
    if (!scene) {
      return;
    }

    const inPathTracingMode = Boolean(scene.userData[PT_ENV_MODE_TAG]);
    if (inPathTracingMode === pathTracingEnabled) {
      return;
    }

    const sourceEnvironment = scene.userData[PT_SOURCE_ENV_TAG] as TextureInstance | null | undefined;
    const previousBlurred = scene.userData[PT_BLURRED_ENV_TAG] as TextureInstance | null | undefined;
    const previousEnvironment = scene.environment;

    if (pathTracingEnabled) {
      if (previousBlurred) {
        previousBlurred.dispose();
        scene.userData[PT_BLURRED_ENV_TAG] = null;
      }

      if (!renderer || !sourceEnvironment || !this.isWebGlRenderer(renderer)) {
        scene.environment = null;
        if (previousEnvironment && previousEnvironment !== sourceEnvironment) {
          previousEnvironment.dispose();
        }
        scene.userData[PT_ENV_MODE_TAG] = true;
        return;
      }

      sourceEnvironment.mapping = THREE.EquirectangularReflectionMapping;
      sourceEnvironment.needsUpdate = true;

      const generator = new BlurredEnvMapGenerator(renderer);
      const blurredEnvironment = generator.generate(sourceEnvironment, PT_ENVIRONMENT_BLUR) as TextureInstance;
      generator.dispose();

      scene.userData[PT_BLURRED_ENV_TAG] = blurredEnvironment;
      scene.environment = blurredEnvironment;

      if (previousEnvironment && previousEnvironment !== sourceEnvironment) {
        previousEnvironment.dispose();
      }

      scene.userData[PT_ENV_MODE_TAG] = true;
      return;
    }

    if (previousBlurred) {
      previousBlurred.dispose();
      scene.userData[PT_BLURRED_ENV_TAG] = null;
    }

    if (sourceEnvironment) {
      sourceEnvironment.mapping = THREE.EquirectangularReflectionMapping;
      sourceEnvironment.needsUpdate = true;
      scene.environment = sourceEnvironment;
    } else {
      scene.environment = null;
    }

    if (previousEnvironment && previousEnvironment !== sourceEnvironment) {
      previousEnvironment.dispose();
    }

    scene.userData[PT_ENV_MODE_TAG] = false;
  }

  private disposeEnvironment(scene: SceneInstance): void {
    const sourceEnvironment = scene.userData[PT_SOURCE_ENV_TAG] as TextureInstance | null | undefined;
    if (sourceEnvironment) {
      sourceEnvironment.dispose();
      scene.userData[PT_SOURCE_ENV_TAG] = null;
    }

    const blurredEnvironment = scene.userData[PT_BLURRED_ENV_TAG] as TextureInstance | null | undefined;
    if (blurredEnvironment) {
      blurredEnvironment.dispose();
      scene.userData[PT_BLURRED_ENV_TAG] = null;
    }

    scene.userData[PT_ENV_MODE_TAG] = false;

    const environment = scene.environment;
    if (environment) {
      environment.dispose();
      scene.environment = null;
    }
  }

  private isWebGlRenderer(renderer: RendererInstance): renderer is WebGLRenderer {
    return Boolean((renderer as { isWebGLRenderer?: boolean }).isWebGLRenderer);
  }
}
