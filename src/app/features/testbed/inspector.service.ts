import { Injectable } from '@angular/core';
import * as THREE from 'three';

import { InspectorSnapshot } from './controls.model';

@Injectable({ providedIn: 'root' })
export class InspectorService {
  buildSnapshot(scene: THREE.Scene, threeModule: typeof THREE): InspectorSnapshot {
    const THREE = threeModule;
    let meshCount = 0;
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    let lodCount = 0;
    let bvhCount = 0;

    scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.LOD) {
        lodCount += 1;
      }

      if (object instanceof THREE.Mesh) {
        meshCount += 1;
        const material = object.material;
        if (Array.isArray(material)) {
          material.forEach((item) => materials.add(item));
        } else {
          materials.add(material);
        }

        const geometry = object.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
        if (geometry.boundsTree) {
          bvhCount += 1;
        }

        if (material instanceof THREE.MeshStandardMaterial) {
          const maps: Array<THREE.Texture | null> = [
            material.map,
            material.normalMap,
            material.roughnessMap,
            material.metalnessMap,
            material.emissiveMap,
          ];
          maps.forEach((texture) => {
            if (texture) {
              textures.add(texture);
            }
          });
        }
      }
    });

    return {
      meshCount,
      materialCount: materials.size,
      textureCount: textures.size,
      lodCount,
      bvhCount,
    };
  }
}
