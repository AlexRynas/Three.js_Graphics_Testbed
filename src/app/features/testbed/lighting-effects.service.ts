import { Injectable } from '@angular/core';
import * as THREE from 'three';
import * as THREE_WEBGPU from 'three/webgpu';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';

import { RendererInstance } from './frame-stats-tracker';

@Injectable({ providedIn: 'root' })
export class LightingEffectsService {
  applyEnvironment(
    scene: THREE.Scene | null,
    renderer: RendererInstance | null,
    threeModule: typeof THREE,
    hdrTexture: THREE.Texture | null,
  ): void {
    const THREE = threeModule;
    if (!scene || !(renderer instanceof THREE.WebGLRenderer)) {
      return;
    }

    const pmremGenerator = new THREE.PMREMGenerator(renderer as THREE.WebGLRenderer);
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
    primaryLight: THREE.DirectionalLight | null,
    currentLensflare: Lensflare | null,
    enabled: boolean,
    threeModule: typeof THREE,
  ): Lensflare | null {
    if (!primaryLight) {
      return currentLensflare;
    }

    if (enabled && !currentLensflare) {
      const flare = new Lensflare();
      flare.addElement(new LensflareElement(this.createFlareTexture('#f7b545', threeModule), 96, 0));
      flare.addElement(
        new LensflareElement(this.createFlareTexture('#45e3c2', threeModule), 128, 0.4),
      );
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

  private createFlareTexture(color: string, threeModule: typeof THREE): THREE.Texture {
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
