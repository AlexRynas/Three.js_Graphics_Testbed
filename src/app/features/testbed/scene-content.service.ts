import { Injectable, inject } from '@angular/core';
import { reflector } from 'three/tsl';
import { ReflectorForSSRPass } from 'three/examples/jsm/objects/ReflectorForSSRPass.js';

import { AssetService } from './asset.service';
import {
  CollectionManifest,
  CollectionRef,
  RendererMode,
  SceneSettings,
  Vector3Tuple,
} from './controls.model';
import {
  GroupInstance,
  SceneInstance,
  TextureInstance,
  ThreeModule,
} from './testbed-runtime.service';
import {
  SSR_WEBGPU_BASE_COLOR_NODE,
  SSR_WEBGL_FLOOR_TAG,
  SSR_WEBGL_SOURCE_FLOOR_TAG,
  SSR_WEBGPU_REFLECTOR_NODE,
} from './constants';

type LoadCollectionParams = {
  collection: CollectionRef;
  scene: SceneInstance | null;
  threeModule: ThreeModule;
  rendererMode: RendererMode;
  sceneSettings: SceneSettings;
  activeGroup: GroupInstance | null;
  applyEnvironment: (hdrTexture: TextureInstance | null, environmentUrl: string | null) => void;
};

type LoadCollectionResult = {
  manifest: CollectionManifest | null;
  activeGroup: GroupInstance | null;
  procedural: boolean;
  initialCameraPosition: Vector3Tuple;
  initialControlTarget: Vector3Tuple;
};

const PROCEDURAL_INITIAL_CAMERA_POSITION: Vector3Tuple = [0, 10, 30];
const PROCEDURAL_INITIAL_CONTROL_TARGET: Vector3Tuple = [0, 5, 0];

@Injectable({ providedIn: 'root' })
export class SceneContentService {
  private readonly assetService = inject(AssetService);

  clearActiveGroup(
    scene: SceneInstance | null,
    activeGroup: GroupInstance | null,
    threeModule: ThreeModule,
  ): GroupInstance | null {
    const THREE = threeModule;
    if (!scene || !activeGroup) {
      return null;
    }

    scene.remove(activeGroup);
    activeGroup.traverse((object) => {
      if (typeof object.userData?.[SSR_WEBGPU_REFLECTOR_NODE]?.dispose === 'function') {
        object.userData[SSR_WEBGPU_REFLECTOR_NODE].dispose();
      }

      if (typeof (object as { dispose?: () => void }).dispose === 'function') {
        (object as unknown as { dispose: () => void }).dispose();
      }

      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        if (Array.isArray(object.material)) {
          object.material.forEach((material) => material.dispose());
        } else {
          object.material.dispose();
        }
      }
    });

    return null;
  }

  async loadCollection(params: LoadCollectionParams): Promise<LoadCollectionResult> {
    const { collection, scene, threeModule, rendererMode, sceneSettings } = params;
    const THREE = threeModule;

    const clearedGroup = this.clearActiveGroup(scene, params.activeGroup, threeModule);

    const manifest = collection.manifestUrl
      ? await this.assetService.loadManifest(collection.manifestUrl)
      : null;

    if (!scene) {
      const initialView = this.resolveInitialView(manifest);
      return {
        manifest,
        activeGroup: clearedGroup,
        procedural: false,
        initialCameraPosition: initialView.initialCameraPosition,
        initialControlTarget: initialView.initialControlTarget,
      };
    }

    if (!manifest || !manifest.lods || manifest.lods.length === 0) {
      params.applyEnvironment(null, null);
      const proceduralGroup = this.buildProceduralScene(
        scene,
        threeModule,
        rendererMode,
      );
      return {
        manifest,
        activeGroup: proceduralGroup,
        procedural: true,
        initialCameraPosition: PROCEDURAL_INITIAL_CAMERA_POSITION,
        initialControlTarget: PROCEDURAL_INITIAL_CONTROL_TARGET,
      };
    }

    if (manifest.environment) {
      try {
        const hdr = await this.assetService.loadHdr(manifest.environment);
        params.applyEnvironment(hdr as TextureInstance, manifest.environment);
      } catch {
        params.applyEnvironment(null, manifest.environment);
      }
    } else {
      params.applyEnvironment(null, null);
    }

    const group = new THREE.Group();
    scene.add(group);

    await this.loadLod(manifest.lods, group, threeModule, sceneSettings, rendererMode);

    const initialView = this.resolveInitialView(manifest);

    return {
      manifest,
      activeGroup: group,
      procedural: false,
      initialCameraPosition: initialView.initialCameraPosition,
      initialControlTarget: initialView.initialControlTarget,
    };
  }

  private resolveInitialView(manifest: CollectionManifest | null): {
    initialCameraPosition: Vector3Tuple;
    initialControlTarget: Vector3Tuple;
  } {
    if (!manifest) {
      return {
        initialCameraPosition: PROCEDURAL_INITIAL_CAMERA_POSITION,
        initialControlTarget: PROCEDURAL_INITIAL_CONTROL_TARGET,
      };
    }

    return {
      initialCameraPosition: manifest.initialCameraPosition,
      initialControlTarget: manifest.initialControlTarget,
    };
  }

  private async loadLod(
    lods: string[],
    group: GroupInstance,
    threeModule: ThreeModule,
    sceneSettings: SceneSettings,
    rendererMode: RendererMode,
  ): Promise<void> {
    const THREE = threeModule;
    const lod = new THREE.LOD();
    group.add(lod);

    await this.loadLodLevel(lods[0], lod, 0, threeModule, sceneSettings, rendererMode);

    const higher = lods.slice(1);
    higher.forEach((url, index) => {
      const distance = (index + 1) * 12 + sceneSettings.lodBias * 3;
      void this.loadLodLevel(url, lod, distance, threeModule, sceneSettings, rendererMode);
    });
  }

  private async loadLodLevel(
    url: string,
    lod: InstanceType<ThreeModule['LOD']>,
    distance: number,
    threeModule: ThreeModule,
    sceneSettings: SceneSettings,
    rendererMode: RendererMode,
  ): Promise<void> {
    const THREE = threeModule;
    try {
      const gltf = (await this.assetService.loadGltf(url)) as { scene: GroupInstance };
      const scene = gltf.scene;
      const floorMeshes: Array<InstanceType<ThreeModule['Mesh']>> = [];

      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
          if (object.material instanceof THREE.MeshStandardMaterial) {
            object.material.envMapIntensity = sceneSettings.environmentIntensity;
          }

          if (this.isFloorName(object.name)) {
            floorMeshes.push(object);
          }
        }
      });

      floorMeshes.forEach((mesh) => {
        if (rendererMode === 'webgl') {
          this.addWebglFloorReflector(mesh, THREE);
          return;
        }

        this.applyWebgpuFloorReflector(mesh, THREE);
      });

      lod.addLevel(scene, distance);
    } catch {}
  }

  private buildProceduralScene(
    scene: SceneInstance,
    threeModule: ThreeModule,
    rendererMode: RendererMode,
  ): GroupInstance {
    const THREE = threeModule;
    const group = new THREE.Group();
    group.name = 'Procedural Scene';
    scene.add(group);

    // Walls
    const wallGeometry = new THREE.PlaneGeometry(1, 1);

    // Left wall - red
    const redWallMaterial = new THREE.MeshPhysicalMaterial({ color: '#ff0000' });
    const leftWall = new THREE.Mesh(wallGeometry, redWallMaterial);
    leftWall.name = 'Left Wall';
    leftWall.scale.set(20, 15, 1);
    leftWall.rotation.y = Math.PI * 0.5;
    leftWall.position.set(-10, 7.5, 0);
    leftWall.receiveShadow = true;
    group.add(leftWall);

    // Right wall - green
    const greenWallMaterial = new THREE.MeshPhysicalMaterial({ color: '#00ff00' });
    const rightWall = new THREE.Mesh(wallGeometry, greenWallMaterial);
    rightWall.name = 'Right Wall';
    rightWall.scale.set(20, 15, 1);
    rightWall.rotation.y = Math.PI * -0.5;
    rightWall.position.set(10, 7.5, 0);
    rightWall.receiveShadow = true;
    group.add(rightWall);

    // Dark gray walls and floor
    const darkGrayMaterial = new THREE.MeshPhysicalMaterial({ color: '#A9A9A9' });
    // Light gray boxes
    const lightGrayMaterial = new THREE.MeshPhysicalMaterial({ color: '#D3D3D3' });

    // Floor
    const floorMaterial = darkGrayMaterial.clone(); // Clone to have separate instance for reflector adjustments
    const floor = new THREE.Mesh(wallGeometry, floorMaterial);
    floor.name = 'Floor';
    floor.scale.set(20, 20, 1);
    floor.rotation.x = Math.PI * -0.5;
    floor.receiveShadow = true;
    group.add(floor);

    if (rendererMode === 'webgl') {
      this.addWebglFloorReflector(floor, THREE);
    } else {
      this.applyWebgpuFloorReflector(floor, THREE);
    }

    // Back wall
    const backWall = new THREE.Mesh(wallGeometry, darkGrayMaterial);
    backWall.name = 'Back Wall';
    backWall.scale.set(15, 20, 1);
    backWall.rotation.z = Math.PI * -0.5;
    backWall.position.set(0, 7.5, -10);
    backWall.receiveShadow = true;
    group.add(backWall);

    // Ceiling
    const ceiling = new THREE.Mesh(wallGeometry, darkGrayMaterial);
    ceiling.name = 'Ceiling';
    ceiling.scale.set(20, 20, 1);
    ceiling.rotation.x = Math.PI * 0.5;
    ceiling.position.set(0, 15, 0);
    ceiling.receiveShadow = true;
    group.add(ceiling);

    // Boxes
    const tallBoxGeometry = new THREE.BoxGeometry(5, 7, 5);
    const tallBox = new THREE.Mesh(tallBoxGeometry, lightGrayMaterial);
    tallBox.name = 'Tall Box';
    tallBox.rotation.y = Math.PI * 0.25;
    tallBox.position.set(-3, 3.5, -2);
    tallBox.castShadow = true;
    tallBox.receiveShadow = true;
    group.add(tallBox);

    const shortBoxGeometry = new THREE.BoxGeometry(4, 4, 4);
    const shortBox = new THREE.Mesh(shortBoxGeometry, lightGrayMaterial);
    shortBox.name = 'Short Box';
    shortBox.rotation.y = Math.PI * -0.1;
    shortBox.position.set(4, 2, 4);
    shortBox.castShadow = true;
    shortBox.receiveShadow = true;
    group.add(shortBox);

    // Main light
    const pointLight = new THREE.PointLight('#ffffff', 100);
    pointLight.name = 'Main Point Light';
    pointLight.position.set(0, 14.45, 0);
    pointLight.distance = 100;
    pointLight.castShadow = true;
    pointLight.shadow.mapSize.width = 1024;
    pointLight.shadow.mapSize.height = 1024;
    pointLight.shadow.bias = -0.0025;
    group.add(pointLight);

    // Main light mesh (to visualize the light source)
    const pointLightMeshGeometry = new THREE.CylinderGeometry(2.5, 2.5, 1, 64);
    const pointLightMeshMaterial = new THREE.MeshBasicMaterial();
    const pointLightMesh = new THREE.Mesh(pointLightMeshGeometry, pointLightMeshMaterial);
    pointLightMesh.name = 'Main Light Source Mesh';
    pointLightMesh.position.y = 15;
    group.add(pointLightMesh);

    // Ambient light
    const ambientLight = new THREE.AmbientLight('#0c0c0c');
    ambientLight.name = 'Ambient Light';
    group.add(ambientLight);

    return group;
  }

  private isFloorName(name: string): boolean {
    return name.trim().toLowerCase().includes('floor');
  }

  private addWebglFloorReflector(
    mesh: InstanceType<ThreeModule['Mesh']>,
    threeModule: ThreeModule,
  ): void {
    const THREE = threeModule;
    if (!(mesh instanceof THREE.Mesh) || !mesh.parent) {
      return;
    }

    const reflector = new ReflectorForSSRPass(mesh.geometry.clone(), {
      color: 0x808080,
      useDepthTexture: true,
      textureWidth: 1024,
      textureHeight: 1024,
    }) as unknown as InstanceType<ThreeModule['Mesh']>;

    reflector.name = mesh.name;
    reflector.position.copy(mesh.position);
    reflector.quaternion.copy(mesh.quaternion);
    reflector.scale.copy(mesh.scale);
    reflector.castShadow = mesh.castShadow;
    reflector.receiveShadow = true;
    reflector.userData = {
      ...mesh.userData,
      [SSR_WEBGL_FLOOR_TAG]: true,
      [SSR_WEBGL_SOURCE_FLOOR_TAG]: mesh,
    };

    reflector.visible = false;
    mesh.visible = true;
    mesh.parent.add(reflector);
  }

  private applyWebgpuFloorReflector(
    mesh: InstanceType<ThreeModule['Mesh']>,
    threeModule: ThreeModule,
  ): void {
    const THREE = threeModule;
    if (!(mesh instanceof THREE.Mesh)) {
      return;
    }

    const floorReflectorNode = reflector({
      target: mesh,
      resolutionScale: 0.75,
      bounces: true,
    });

    const applyToMaterial = (material: unknown): void => {
      if (!(material instanceof THREE.MeshStandardMaterial)) {
        return;
      }

      const materialWithNode = material as unknown as {
        colorNode?: unknown;
        userData?: Record<string, unknown>;
      };

      const userData = materialWithNode.userData ?? (materialWithNode.userData = {});
      if (!(SSR_WEBGPU_BASE_COLOR_NODE in userData)) {
        userData[SSR_WEBGPU_BASE_COLOR_NODE] = materialWithNode.colorNode ?? null;
      }

      material.needsUpdate = true;
    };

    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material) => applyToMaterial(material));
    } else {
      applyToMaterial(mesh.material);
    }

    mesh.userData[SSR_WEBGPU_REFLECTOR_NODE] = floorReflectorNode;
  }
}
