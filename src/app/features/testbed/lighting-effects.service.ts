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
import {
  DirectionalLightInstance,
  SceneInstance,
  TextureInstance,
  ThreeModule,
} from './testbed-runtime.service';

export type LensflareInstance = WebGlLensflare | LensflareMesh;

@Injectable({ providedIn: 'root' })
export class LightingEffectsService {
  applyEnvironment(
    scene: SceneInstance | null,
    renderer: RendererInstance | null,
    threeModule: ThreeModule,
    mode: RendererMode,
    hdrTexture: TextureInstance | null,
  ): void {
    const THREE = threeModule;
    if (!scene || !renderer || mode !== 'webgl' || !('getContext' in renderer)) {
      return;
    }

    const pmremGenerator = new THREE.PMREMGenerator(renderer as never);
    pmremGenerator.compileEquirectangularShader();

    if (hdrTexture) {
      const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;
      scene.environment = envMap;
      scene.background = new THREE.Color('#070b10');
      hdrTexture.dispose();
    } else {
      const envMap = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envMap;
      scene.background = new THREE.Color('#0b1117');
    }

    pmremGenerator.dispose();
  }

  syncLensFlares(
    primaryLight: DirectionalLightInstance | null,
    currentLensflare: LensflareInstance | null,
    enabled: boolean,
    threeModule: ThreeModule,
    mode: RendererMode,
  ): LensflareInstance | null {
    if (!primaryLight) {
      return currentLensflare;
    }

    const needsWebGpu = mode === 'webgpu';
    const hasWebGpuFlare = Boolean(currentLensflare && 'isLensflareMesh' in currentLensflare);
    if (currentLensflare && hasWebGpuFlare !== needsWebGpu) {
      primaryLight.remove(currentLensflare);
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
      primaryLight.add(flare);
      return flare;
    }

    if (!enabled && currentLensflare) {
      primaryLight.remove(currentLensflare);
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
