import { Injectable } from '@angular/core';

import { InspectorSnapshot } from './controls.model';
import { SceneInstance, ThreeModule } from './testbed-runtime.service';

@Injectable({ providedIn: 'root' })
export class InspectorService {
  buildSnapshot(scene: SceneInstance, threeModule: ThreeModule): InspectorSnapshot {
    const THREE = threeModule;
    let meshCount = 0;
    const materials = new Set<InstanceType<ThreeModule['Material']>>();
    const textures = new Set<InstanceType<ThreeModule['Texture']>>();
    let lodCount = 0;
    let bvhCount = 0;

    scene.traverse((object) => {
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

        const geometry = object.geometry as InstanceType<ThreeModule['BufferGeometry']> & {
          boundsTree?: unknown;
        };
        if (geometry.boundsTree) {
          bvhCount += 1;
        }

        if (material instanceof THREE.MeshStandardMaterial) {
          const maps = [
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
