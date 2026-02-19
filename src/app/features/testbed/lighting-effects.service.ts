import { Injectable } from '@angular/core';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { RendererMode } from './controls.model';
import { RendererInstance } from './frame-stats-tracker';
import { SceneInstance, TextureInstance, ThreeModule } from './testbed-runtime.service';

const PT_SOURCE_ENV_TAG = '__ptSourceEnvironment';
const PT_ENV_MODE_TAG = '__ptEnvironmentMode';

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
    if (!scene || !renderer) {
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

    const pmremGenerator = new THREE.PMREMGenerator(renderer as never);
    pmremGenerator.compileEquirectangularShader();

    const previousSource = scene.userData[PT_SOURCE_ENV_TAG] as TextureInstance | null | undefined;
    if (previousSource && previousSource !== hdrTexture) {
      previousSource.dispose();
      scene.userData[PT_SOURCE_ENV_TAG] = null;
    }

    const previousEnvironment = scene.environment;
    if (hdrTexture) {
      const sourceTexture = hdrTexture.clone() as TextureInstance;
      sourceTexture.mapping = THREE.EquirectangularReflectionMapping;
      sourceTexture.needsUpdate = true;
      scene.userData[PT_SOURCE_ENV_TAG] = sourceTexture;

      const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;
      scene.environment = envMap;
      hdrTexture.dispose();
    } else {
      scene.userData[PT_SOURCE_ENV_TAG] = null;
      const envMap = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envMap;
    }

    if (previousEnvironment && previousEnvironment !== scene.environment) {
      previousEnvironment.dispose();
    }

    pmremGenerator.dispose();

    scene.userData[PT_ENV_MODE_TAG] = false;
  }

  switchPathTracingEnvironment(
    scene: SceneInstance | null,
    renderer: RendererInstance | null,
    threeModule: ThreeModule,
    pathTracingEnabled: boolean,
  ): void {
    const THREE = threeModule;
    if (!scene || !renderer) {
      return;
    }

    const inPathTracingMode = Boolean(scene.userData[PT_ENV_MODE_TAG]);
    if (inPathTracingMode === pathTracingEnabled) {
      return;
    }

    const sourceEnvironment = scene.userData[PT_SOURCE_ENV_TAG] as TextureInstance | null | undefined;
    const previousEnvironment = scene.environment;

    if (pathTracingEnabled) {
      if (previousEnvironment && previousEnvironment !== sourceEnvironment) {
        previousEnvironment.dispose();
      }

      if (sourceEnvironment) {
        sourceEnvironment.mapping = THREE.EquirectangularReflectionMapping;
        sourceEnvironment.needsUpdate = true;
        scene.environment = sourceEnvironment;
      } else {
        scene.environment = null;
      }

      scene.userData[PT_ENV_MODE_TAG] = true;
      return;
    }

    const pmremGenerator = new THREE.PMREMGenerator(renderer as never);
    pmremGenerator.compileEquirectangularShader();

    if (sourceEnvironment) {
      const envMap = pmremGenerator.fromEquirectangular(sourceEnvironment).texture;
      scene.environment = envMap;
    } else {
      const envMap = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envMap;
    }

    pmremGenerator.dispose();

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
    scene.userData[PT_ENV_MODE_TAG] = false;

    const environment = scene.environment;
    if (environment) {
      environment.dispose();
      scene.environment = null;
    }
  }
}
