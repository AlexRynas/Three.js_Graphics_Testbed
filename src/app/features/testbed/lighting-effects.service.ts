import { Injectable } from '@angular/core';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { RendererMode } from './controls.model';
import { RendererInstance } from './frame-stats-tracker';
import { SceneInstance, TextureInstance, ThreeModule } from './testbed-runtime.service';

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

    const previousEnvironment = scene.environment;
    if (hdrTexture) {
      const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;
      scene.environment = envMap;
      hdrTexture.dispose();
    } else {
      const envMap = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envMap;
    }

    if (previousEnvironment && previousEnvironment !== scene.environment) {
      previousEnvironment.dispose();
    }

    pmremGenerator.dispose();
  }

  private disposeEnvironment(scene: SceneInstance): void {
    const environment = scene.environment;
    if (environment) {
      environment.dispose();
      scene.environment = null;
    }
  }
}
