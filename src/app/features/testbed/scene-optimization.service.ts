import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

@Injectable({ providedIn: 'root' })
export class SceneOptimizationService {
  applyEnvironmentIntensity(
    scene: THREE.Scene | null,
    threeModule: typeof THREE,
    intensity: number,
  ): void {
    const THREE = threeModule;
    if (!scene) {
      return;
    }

    scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
        object.material.envMapIntensity = intensity;
      }
    });
  }

  updateLodBias(scene: THREE.Scene | null, threeModule: typeof THREE, bias: number): void {
    const THREE = threeModule;
    if (!scene) {
      return;
    }

    scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.LOD) {
        object.levels.forEach((level, index) => {
          if (index === 0) {
            level.distance = 0;
          } else {
            level.distance = index * 12 + bias * 3;
          }
        });
      }
    });
  }

  applyBvh(scene: THREE.Scene | null, threeModule: typeof THREE, enabled: boolean): boolean {
    const THREE = threeModule;
    if (!enabled || !scene) {
      return false;
    }

    const geometryProto = THREE.BufferGeometry.prototype as THREE.BufferGeometry & {
      computeBoundsTree?: () => void;
      disposeBoundsTree?: () => void;
    };
    geometryProto.computeBoundsTree = computeBoundsTree;
    geometryProto.disposeBoundsTree = disposeBoundsTree;

    const meshProto = THREE.Mesh.prototype as THREE.Mesh & {
      raycast: typeof acceleratedRaycast;
    };
    meshProto.raycast = acceleratedRaycast;

    scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh) {
        const geometry = object.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
        if (!geometry.boundsTree) {
          geometry.computeBoundsTree?.();
        }
      }
    });

    return true;
  }
}
