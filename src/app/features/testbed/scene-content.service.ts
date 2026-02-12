import { Injectable, inject } from '@angular/core';
import * as THREE from 'three';

import { AssetService } from './asset.service';
import { CollectionManifest, CollectionRef, SceneSettings } from './controls.model';

type LoadCollectionParams = {
  collection: CollectionRef;
  scene: THREE.Scene | null;
  threeModule: typeof THREE;
  sceneSettings: SceneSettings;
  activeGroup: THREE.Group | null;
  applyEnvironment: (hdrTexture: THREE.Texture | null) => void;
};

type LoadCollectionResult = {
  manifest: CollectionManifest | null;
  activeGroup: THREE.Group | null;
  procedural: boolean;
};

@Injectable({ providedIn: 'root' })
export class SceneContentService {
  private readonly assetService = inject(AssetService);

  clearActiveGroup(
    scene: THREE.Scene | null,
    activeGroup: THREE.Group | null,
    threeModule: typeof THREE,
  ): THREE.Group | null {
    const THREE = threeModule;
    if (!scene || !activeGroup) {
      return null;
    }

    scene.remove(activeGroup);
    activeGroup.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        if (Array.isArray(object.material)) {
          object.material.forEach((material: THREE.Material) => material.dispose());
        } else {
          object.material.dispose();
        }
      }
    });

    return null;
  }

  async loadCollection(params: LoadCollectionParams): Promise<LoadCollectionResult> {
    const { collection, scene, threeModule, sceneSettings } = params;
    const THREE = threeModule;

    const clearedGroup = this.clearActiveGroup(scene, params.activeGroup, threeModule);

    const manifest = collection.manifestUrl
      ? await this.assetService.loadManifest(collection.manifestUrl)
      : null;

    if (!scene) {
      return {
        manifest,
        activeGroup: clearedGroup,
        procedural: false,
      };
    }

    if (!manifest || !manifest.lods || manifest.lods.length === 0) {
      const proceduralGroup = this.buildProceduralScene(scene, threeModule);
      return {
        manifest,
        activeGroup: proceduralGroup,
        procedural: true,
      };
    }

    if (manifest.environment) {
      try {
        const hdr = await this.assetService.loadHdr(manifest.environment);
        params.applyEnvironment(hdr as THREE.Texture);
      } catch {
        params.applyEnvironment(null);
      }
    } else {
      params.applyEnvironment(null);
    }

    const group = new THREE.Group();
    scene.add(group);

    await this.loadLod(manifest.lods, group, threeModule, sceneSettings);

    return {
      manifest,
      activeGroup: group,
      procedural: false,
    };
  }

  private async loadLod(
    lods: string[],
    group: THREE.Group,
    threeModule: typeof THREE,
    sceneSettings: SceneSettings,
  ): Promise<void> {
    const THREE = threeModule;
    const lod = new THREE.LOD();
    group.add(lod);

    await this.loadLodLevel(lods[0], lod, 0, threeModule, sceneSettings);

    const higher = lods.slice(1);
    higher.forEach((url, index) => {
      const distance = (index + 1) * 12 + sceneSettings.lodBias * 3;
      void this.loadLodLevel(url, lod, distance, threeModule, sceneSettings);
    });
  }

  private async loadLodLevel(
    url: string,
    lod: THREE.LOD,
    distance: number,
    threeModule: typeof THREE,
    sceneSettings: SceneSettings,
  ): Promise<void> {
    const THREE = threeModule;
    try {
      const gltf = (await this.assetService.loadGltf(url)) as { scene: THREE.Group };
      const scene = gltf.scene;
      scene.traverse((object: THREE.Object3D) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
          if (object.material instanceof THREE.MeshStandardMaterial) {
            object.material.envMapIntensity = sceneSettings.environmentIntensity;
          }
        }
      });
      lod.addLevel(scene, distance);
    } catch {
    }
  }

  private buildProceduralScene(scene: THREE.Scene, threeModule: typeof THREE): THREE.Group {
    const THREE = threeModule;
    const group = new THREE.Group();
    scene.add(group);

    const materialA = new THREE.MeshStandardMaterial({
      color: 0x1f8f82,
      metalness: 0.4,
      roughness: 0.35,
    });
    const materialB = new THREE.MeshStandardMaterial({
      color: 0xf7b545,
      metalness: 0.2,
      roughness: 0.5,
    });
    const materialC = new THREE.MeshStandardMaterial({
      color: 0xff6b4a,
      metalness: 0.7,
      roughness: 0.2,
    });

    const geoA = new THREE.TorusKnotGeometry(1.2, 0.4, 180, 32);
    const geoB = new THREE.IcosahedronGeometry(1.2, 2);
    const geoC = new THREE.BoxGeometry(1.6, 1.6, 1.6);

    const meshA = new THREE.Mesh(geoA, materialA);
    meshA.position.set(-2.6, 1.6, 0);
    meshA.castShadow = true;

    const meshB = new THREE.Mesh(geoB, materialB);
    meshB.position.set(0.2, 1.2, -1.8);
    meshB.castShadow = true;

    const meshC = new THREE.Mesh(geoC, materialC);
    meshC.position.set(2.6, 1.1, 1.6);
    meshC.castShadow = true;

    group.add(meshA, meshB, meshC);

    return group;
  }
}
