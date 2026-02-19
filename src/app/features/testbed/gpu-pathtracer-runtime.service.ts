import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { DenoiseMaterial, WebGLPathTracer } from 'three-gpu-pathtracer';

import { RenderingSettings } from './controls.model';
import { RendererInstance } from './frame-stats-tracker';
import { CameraInstance, SceneInstance } from './testbed-runtime.service';
import { SSR_WEBGL_FLOOR_TAG } from './constants';

@Injectable({ providedIn: 'root' })
export class GpuPathTracerRuntimeService {
  private pathTracer: WebGLPathTracer | null = null;
  private denoiseMaterial: DenoiseMaterial | null = null;
  private denoiseQuad: FullScreenQuad | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private denoiserEnabled = false;

  private readonly convertedMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private readonly overriddenVisibility = new Map<THREE.Object3D, boolean>();
  private readonly lodStates = new Map<THREE.LOD, { autoUpdate: boolean; visible: boolean[] }>();

  initialize(renderer: RendererInstance | null): boolean {
    if (!(renderer instanceof THREE.WebGLRenderer)) {
      this.dispose();
      return false;
    }

    if (this.pathTracer && this.renderer === renderer) {
      return true;
    }

    this.dispose();

    this.renderer = renderer;
    this.pathTracer = new WebGLPathTracer(renderer);
    this.pathTracer.rasterizeScene = true;
    this.pathTracer.renderToCanvas = true;
    this.pathTracer.synchronizeRenderSize = true;
    const pathTracerWithStableNoise = this.pathTracer as WebGLPathTracer & {
      stableNoise?: boolean;
    };
    pathTracerWithStableNoise.stableNoise = true;
    this.pathTracer.renderDelay = 0;
    this.pathTracer.fadeDuration = 0;

    this.denoiseMaterial = new DenoiseMaterial();
    this.denoiseQuad = new FullScreenQuad(this.denoiseMaterial);

    this.pathTracer.renderToCanvasCallback = (target, webglRenderer, quad) => {
      const previousAutoClear = webglRenderer.autoClear;
      webglRenderer.autoClear = false;
      if (this.denoiserEnabled && this.denoiseMaterial && this.denoiseQuad) {
        this.denoiseMaterial.map = target.texture;
        this.denoiseQuad.render(webglRenderer);
      } else {
        quad.render(webglRenderer);
      }
      webglRenderer.autoClear = previousAutoClear;
    };

    return true;
  }

  hasScene(): boolean {
    return this.pathTracer !== null && this.scene !== null && this.camera !== null;
  }

  setSceneWithPrep(
    scene: SceneInstance | null,
    camera: CameraInstance | null,
    settings: RenderingSettings,
  ): boolean {
    if (!this.pathTracer || !(scene instanceof THREE.Scene) || !(camera instanceof THREE.Camera)) {
      return false;
    }

    this.restorePreparedSceneState();
    this.prepareSceneForPathTracing(scene);
    this.applySettings(settings);

    this.pathTracer.setScene(scene, camera);
    this.scene = scene;
    this.camera = camera;
    return true;
  }

  render(settings: RenderingSettings): void {
    if (!this.pathTracer) {
      return;
    }

    this.applySettings(settings);

    this.pathTracer.renderSample();
  }

  updateCamera(camera: CameraInstance | null): void {
    if (!this.pathTracer || !(camera instanceof THREE.Camera)) {
      return;
    }

    this.camera = camera;
    this.pathTracer.setCamera(camera);
  }

  updateMaterials(): void {
    this.pathTracer?.updateMaterials();
  }

  updateLights(): void {
    this.pathTracer?.updateLights();
  }

  updateEnvironment(): void {
    this.pathTracer?.updateEnvironment();
  }

  reset(): void {
    this.pathTracer?.reset();
  }

  deactivate(): void {
    this.restorePreparedSceneState();
    this.scene = null;
    this.camera = null;
    this.pathTracer?.reset();
  }

  dispose(): void {
    this.deactivate();

    this.pathTracer?.dispose();
    this.pathTracer = null;

    this.denoiseQuad?.dispose();
    this.denoiseQuad = null;

    this.denoiseMaterial?.dispose();
    this.denoiseMaterial = null;

    this.renderer = null;
  }

  private applySettings(settings: RenderingSettings): void {
    if (!this.pathTracer) {
      return;
    }

    this.pathTracer.bounces = Math.max(1, Math.round(settings.pathTracingBounces));
    this.pathTracer.minSamples = Math.max(1, Math.round(settings.pathTracingMinSamples));
    this.pathTracer.renderScale = THREE.MathUtils.clamp(settings.pathTracingRenderScale, 0.25, 1);
    const tiles = THREE.MathUtils.clamp(Math.round(settings.pathTracingTiles), 1, 6);
    this.pathTracer.tiles.set(tiles, tiles);
    this.pathTracer.dynamicLowRes = settings.pathTracingDynamicLowRes;
    this.pathTracer.lowResScale = THREE.MathUtils.clamp(settings.pathTracingLowResScale, 0.1, 1);
    this.pathTracer.filterGlossyFactor = THREE.MathUtils.clamp(
      settings.pathTracingFilterGlossyFactor,
      0,
      1,
    );

    this.denoiserEnabled = settings.pathTracingDenoiserEnabled;
    if (this.denoiseMaterial) {
      this.denoiseMaterial.sigma = THREE.MathUtils.clamp(settings.pathTracingDenoiserSigma, 0.5, 16);
      this.denoiseMaterial.threshold = THREE.MathUtils.clamp(
        settings.pathTracingDenoiserThreshold,
        0.001,
        0.2,
      );
      this.denoiseMaterial.kSigma = 1;
    }
  }

  private prepareSceneForPathTracing(scene: THREE.Scene): void {
    scene.updateMatrixWorld(true);

    scene.traverse((object) => {
      if (object instanceof THREE.LOD) {
        this.forceLod0(object);
      }

      if (object.userData?.[SSR_WEBGL_FLOOR_TAG]) {
        this.overrideVisibility(object, false);
      }

      if (object instanceof THREE.InstancedMesh) {
        this.overrideVisibility(object, false);
        return;
      }

      if (!(object instanceof THREE.Mesh)) {
        return;
      }

      if (this.hasInterleavedAttributes(object.geometry)) {
        this.overrideVisibility(object, false);
        return;
      }

      const originalMaterial = object.material;
      const convertedMaterial = Array.isArray(originalMaterial)
        ? originalMaterial.map((material) => this.convertMaterial(material))
        : this.convertMaterial(originalMaterial);

      if (convertedMaterial !== originalMaterial) {
        this.convertedMaterials.set(object, originalMaterial);
        object.material = convertedMaterial;
      }

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => this.normalizeMaterialTextures(material));
    });
  }

  private restorePreparedSceneState(): void {
    this.convertedMaterials.forEach((material, mesh) => {
      mesh.material = material;
    });
    this.convertedMaterials.clear();

    this.overriddenVisibility.forEach((visible, object) => {
      object.visible = visible;
    });
    this.overriddenVisibility.clear();

    this.lodStates.forEach((state, lod) => {
      lod.autoUpdate = state.autoUpdate;
      lod.levels.forEach((level, index) => {
        level.object.visible = state.visible[index] ?? level.object.visible;
      });
    });
    this.lodStates.clear();
  }

  private forceLod0(lod: THREE.LOD): void {
    if (!this.lodStates.has(lod)) {
      this.lodStates.set(lod, {
        autoUpdate: lod.autoUpdate,
        visible: lod.levels.map((level) => level.object.visible),
      });
    }

    lod.autoUpdate = false;
    lod.levels.forEach((level, index) => {
      level.object.visible = index === 0;
    });
  }

  private convertMaterial(material: THREE.Material): THREE.Material {
    if (
      material instanceof THREE.MeshStandardMaterial ||
      material instanceof THREE.MeshPhysicalMaterial
    ) {
      return material;
    }

    const convertedMaterial = new THREE.MeshStandardMaterial({
      color: this.readColor(material),
      map: this.readTexture(material, 'map'),
      normalMap: this.readTexture(material, 'normalMap'),
      roughnessMap: this.readTexture(material, 'roughnessMap'),
      metalnessMap: this.readTexture(material, 'metalnessMap'),
      emissiveMap: this.readTexture(material, 'emissiveMap'),
      roughness: this.readNumber(material, 'roughness', 0.8),
      metalness: this.readNumber(material, 'metalness', 0.1),
      transparent: this.readBoolean(material, 'transparent', false),
      opacity: this.readNumber(material, 'opacity', 1),
      side: this.readSide(material, THREE.FrontSide),
      alphaTest: this.readNumber(material, 'alphaTest', 0),
      emissive: this.readEmissive(material),
      emissiveIntensity: this.readNumber(material, 'emissiveIntensity', 1),
    });

    convertedMaterial.name = material.name;
    convertedMaterial.visible = material.visible;
    convertedMaterial.needsUpdate = true;
    return convertedMaterial;
  }

  private normalizeMaterialTextures(material: THREE.Material): void {
    const mapKeys = [
      'map',
      'normalMap',
      'roughnessMap',
      'metalnessMap',
      'emissiveMap',
      'aoMap',
      'alphaMap',
      'transmissionMap',
      'thicknessMap',
      'specularIntensityMap',
    ];

    mapKeys.forEach((key) => {
      const texture = this.readTexture(material, key);
      if (!texture) {
        return;
      }

      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
    });
  }

  private overrideVisibility(object: THREE.Object3D, visible: boolean): void {
    if (!this.overriddenVisibility.has(object)) {
      this.overriddenVisibility.set(object, object.visible);
    }

    object.visible = visible;
  }

  private hasInterleavedAttributes(geometry: THREE.BufferGeometry): boolean {
    return Object.values(geometry.attributes).some((attribute) => {
      const candidate = attribute as unknown as Record<string, unknown>;
      return (
        typeof candidate['isInterleavedBufferAttribute'] === 'boolean' &&
        Boolean(candidate['isInterleavedBufferAttribute'])
      );
    });
  }

  private readTexture(material: THREE.Material, key: string): THREE.Texture | null {
    const candidate = (material as unknown as Record<string, unknown>)[key];
    return candidate instanceof THREE.Texture ? candidate : null;
  }

  private readNumber(material: THREE.Material, key: string, fallback: number): number {
    const candidate = (material as unknown as Record<string, unknown>)[key];
    return typeof candidate === 'number' ? candidate : fallback;
  }

  private readBoolean(material: THREE.Material, key: string, fallback: boolean): boolean {
    const candidate = (material as unknown as Record<string, unknown>)[key];
    return typeof candidate === 'boolean' ? candidate : fallback;
  }

  private readSide(material: THREE.Material, fallback: THREE.Side): THREE.Side {
    const candidate = (material as unknown as Record<string, unknown>)['side'];
    if (
      candidate === THREE.FrontSide ||
      candidate === THREE.BackSide ||
      candidate === THREE.DoubleSide
    ) {
      return candidate;
    }

    return fallback;
  }

  private readColor(material: THREE.Material): THREE.ColorRepresentation {
    const candidate = (material as unknown as Record<string, unknown>)['color'];
    return candidate instanceof THREE.Color ? candidate.clone() : '#ffffff';
  }

  private readEmissive(material: THREE.Material): THREE.ColorRepresentation {
    const candidate = (material as unknown as Record<string, unknown>)['emissive'];
    return candidate instanceof THREE.Color ? candidate.clone() : '#000000';
  }
}
