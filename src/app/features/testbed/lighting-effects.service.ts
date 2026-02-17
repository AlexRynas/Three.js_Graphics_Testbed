import { Injectable } from '@angular/core';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  Lensflare as WebGlLensflare,
  LensflareElement as WebGlLensflareElement,
} from 'three/examples/jsm/objects/Lensflare.js';
import {
  LensflareElement as WebGpuLensflareElement,
  LensflareMesh,
} from 'three/examples/jsm/objects/LensflareMesh.js';

import { RendererMode } from './controls.model';
import { RendererInstance } from './frame-stats-tracker';
import { SceneInstance, TextureInstance, ThreeModule } from './testbed-runtime.service';

export type LensflareInstance = WebGlLensflare | LensflareMesh;

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

  syncLensFlares(
    scene: SceneInstance | null,
    currentLensflare: LensflareInstance | null,
    enabled: boolean,
    threeModule: ThreeModule,
    mode: RendererMode,
  ): LensflareInstance | null {
    if (!scene) {
      if (currentLensflare && 'dispose' in currentLensflare) {
        currentLensflare.dispose();
      }
      return null;
    }

    const getAllLightSourcesOfScene = (
      obj: SceneInstance,
    ): InstanceType<
      ThreeModule['DirectionalLight'] | ThreeModule['PointLight'] | ThreeModule['SpotLight']
    >[] => {
      const lights: InstanceType<
        ThreeModule['DirectionalLight'] | ThreeModule['PointLight'] | ThreeModule['SpotLight']
      >[] = [];
      obj.traverse((child) => {
        if (
          child instanceof threeModule.DirectionalLight ||
          child instanceof threeModule.PointLight ||
          child instanceof threeModule.SpotLight
        ) {
          lights.push(child);
        }
      });
      return lights;
    };

    const removeLensflareFromLightSources = (
      lightSources: InstanceType<
        ThreeModule['DirectionalLight'] | ThreeModule['PointLight'] | ThreeModule['SpotLight']
      >[],
    ) => {
      lightSources.forEach((light) => {
        if (currentLensflare && currentLensflare.parent === light) {
          light.remove(currentLensflare);
        }
      });
    };

    const lightSources = getAllLightSourcesOfScene(scene);
    if (lightSources.length === 0) {
      if (currentLensflare && 'dispose' in currentLensflare) {
        currentLensflare.dispose();
      }
      return null;
    }

    const needsWebGpu = mode === 'webgpu';
    const hasWebGpuFlare = Boolean(currentLensflare && 'isLensflareMesh' in currentLensflare);
    if (currentLensflare && hasWebGpuFlare !== needsWebGpu) {
      removeLensflareFromLightSources(lightSources);
      if ('dispose' in currentLensflare) {
        currentLensflare.dispose();
      }
      currentLensflare = null;
    }

    if (enabled && !currentLensflare) {
      const flare = mode === 'webgpu' ? new LensflareMesh() : new WebGlLensflare();
      if (mode === 'webgpu') {
        flare.addElement(
          new WebGpuLensflareElement(this.createFlareTexture('#f7b545', threeModule), 96, 0),
        );
        flare.addElement(
          new WebGpuLensflareElement(this.createFlareTexture('#45e3c2', threeModule), 128, 0.4),
        );
      } else {
        flare.addElement(
          new WebGlLensflareElement(this.createFlareTexture('#f7b545', threeModule), 96, 0),
        );
        flare.addElement(
          new WebGlLensflareElement(this.createFlareTexture('#45e3c2', threeModule), 128, 0.4),
        );
      }
      lightSources.forEach((light) => light.add(flare));
      return flare;
    }

    if (!enabled && currentLensflare) {
      removeLensflareFromLightSources(lightSources);
      if ('dispose' in currentLensflare) {
        currentLensflare.dispose();
      }
      return null;
    }

    return currentLensflare;
  }

  private createFlareTexture(color: string, threeModule: ThreeModule): TextureInstance {
    const THREE = threeModule;
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
}
