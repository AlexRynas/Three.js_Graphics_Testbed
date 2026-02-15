import { Injectable } from '@angular/core';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { SceneInstance, ThreeModule } from './testbed-runtime.service';

@Injectable({ providedIn: 'root' })
export class SceneOptimizationService {
  applyEnvironmentIntensity(
    scene: SceneInstance | null,
    threeModule: ThreeModule,
    intensity: number,
  ): void {
    const THREE = threeModule;
    if (!scene) {
      return;
    }

    const sceneWithEnvironmentIntensity = scene as SceneInstance & {
      environmentIntensity?: number;
    };
    if (sceneWithEnvironmentIntensity.environment) {
      sceneWithEnvironmentIntensity.environmentIntensity = intensity;
    }

    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (
          material instanceof THREE.MeshStandardMaterial ||
          material instanceof THREE.MeshPhysicalMaterial
        ) {
          material.envMapIntensity = intensity;
        }
      });
    });
  }

  updateLodBias(scene: SceneInstance | null, threeModule: ThreeModule, bias: number): void {
    const THREE = threeModule;
    if (!scene) {
      return;
    }

    scene.traverse((object) => {
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

  applyBvh(scene: SceneInstance | null, threeModule: ThreeModule, enabled: boolean): boolean {
    const THREE = threeModule;
    if (!enabled || !scene) {
      return false;
    }

    const geometryProto = THREE.BufferGeometry.prototype as InstanceType<ThreeModule['BufferGeometry']> & {
      computeBoundsTree?: () => void;
      disposeBoundsTree?: () => void;
    };
    geometryProto.computeBoundsTree = computeBoundsTree;
    geometryProto.disposeBoundsTree = disposeBoundsTree;

    const meshProto = THREE.Mesh.prototype as InstanceType<ThreeModule['Mesh']> & {
      raycast: typeof acceleratedRaycast;
    };
    meshProto.raycast = acceleratedRaycast;

    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        const geometry = object.geometry as InstanceType<ThreeModule['BufferGeometry']> & {
          boundsTree?: MeshBVH;
        };
        if (!geometry.boundsTree) {
          geometry.computeBoundsTree?.();
        }
      }
    });

    return true;
  }
}
