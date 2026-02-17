import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  CollectionManifest,
  CollectionRef,
  defaultRenderingSettings,
  defaultSceneSettings,
  Preset
} from './controls.model';

const DEFAULT_COLLECTIONS: CollectionRef[] = [
  {
    id: 'procedural',
    displayName: 'Procedural Demo'
  }
];

@Injectable({ providedIn: 'root' })
export class AssetService {
  private readonly http = inject(HttpClient);

  async loadCollectionsIndex(): Promise<CollectionRef[]> {
    try {
      const collections = (await firstValueFrom(
        this.http.get<CollectionRef[]>('/assets/collections-index.json')
      )) as CollectionRef[];
      return Array.isArray(collections) && collections.length > 0 ? collections : DEFAULT_COLLECTIONS;
    } catch {
      return DEFAULT_COLLECTIONS;
    }
  }

  async loadManifest(manifestUrl: string): Promise<CollectionManifest | null> {
    if (!manifestUrl) {
      return null;
    }

    try {
      return (await firstValueFrom(
        this.http.get<CollectionManifest>(manifestUrl)
      )) as CollectionManifest;
    } catch {
      return null;
    }
  }

  async loadGltf(url: string): Promise<unknown> {
    const module = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const { GLTFLoader } = module;
    const loader = new GLTFLoader();

    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf: unknown) => resolve(gltf),
        undefined,
        (error: unknown) => reject(error)
      );
    });
  }

  async loadHdr(url: string): Promise<unknown> {
    const module = await import('three/examples/jsm/loaders/RGBELoader.js');
    const { RGBELoader } = module;
    const loader = new RGBELoader();

    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (texture: unknown) => resolve(texture),
        undefined,
        (error: unknown) => reject(error)
      );
    });
  }

  buildDefaultPresets(): Preset[] {
    const low: Preset = {
      name: 'Low',
      rendering: {
        ...defaultRenderingSettings,
        antialiasing: 'fxaa',
        shadowType: 'basic',
        gtaoEnabled: false,
        textureFiltering: 'linear',
        depthOfField: false,
        filmGrain: false
      },
      scene: {
        ...defaultSceneSettings,
        environmentIntensity: 0.7,
        exposure: 0.9
      }
    };

    const medium: Preset = {
      name: 'Medium',
      rendering: {
        ...defaultRenderingSettings,
        antialiasing: 'smaa',
        shadowType: 'pcf',
        gtaoEnabled: true,
        gtaoQuality: 'medium',
        textureFiltering: 'trilinear',
        filmGrain: false
      },
      scene: {
        ...defaultSceneSettings
      }
    };

    const high: Preset = {
      name: 'High',
      rendering: {
        ...defaultRenderingSettings,
        antialiasing: 'taa',
        shadowType: 'pcfSoft',
        gtaoEnabled: true,
        gtaoQuality: 'high',
        textureFiltering: 'anisotropic',
        depthOfField: true,
        filmGrain: true
      },
      scene: {
        ...defaultSceneSettings,
        environmentIntensity: 1.2,
        exposure: 1.1
      }
    };

    return [low, medium, high];
  }
}
