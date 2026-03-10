import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import {
  CollectionManifest,
  CollectionRef,
  defaultRenderingSettings,
  defaultSceneSettings,
  Preset
} from './controls.model';
import { RendererInstance } from './frame-stats-tracker';

const DEFAULT_COLLECTIONS: CollectionRef[] = [
  {
    id: 'procedural',
    displayName: 'Procedural Demo'
  }
];

const COLLECTIONS_INDEX_URL = '/collections-index.json';
const DRACO_DECODER_PATH = '/draco/gltf/';
const BASIS_TRANSCODER_PATH = '/basis/';

@Injectable({ providedIn: 'root' })
export class AssetService {
  private readonly http = inject(HttpClient);
  private renderer: RendererInstance | null = null;
  private dracoLoaderPromise: Promise<DRACOLoader> | null = null;
  private ktx2LoaderPromise: Promise<KTX2Loader | null> | null = null;

  setRenderer(renderer: RendererInstance | null): void {
    if (this.renderer === renderer) {
      return;
    }

    this.renderer = renderer;
    this.ktx2LoaderPromise = null;
  }

  async loadCollectionsIndex(): Promise<CollectionRef[]> {
    const indexUrl = this.resolveUrl(COLLECTIONS_INDEX_URL);

    try {
      const collections = (await firstValueFrom(
        this.http.get<CollectionRef[]>(indexUrl)
      )) as CollectionRef[];

      if (!Array.isArray(collections) || collections.length === 0) {
        return DEFAULT_COLLECTIONS;
      }

      return collections.map((collection) => ({
        ...collection,
        manifestUrl: collection.manifestUrl
          ? this.resolveUrl(collection.manifestUrl, indexUrl)
          : undefined,
      }));
    } catch {
      return DEFAULT_COLLECTIONS;
    }
  }

  async loadManifest(manifestUrl: string): Promise<CollectionManifest | null> {
    if (!manifestUrl) {
      return null;
    }

    try {
      const resolvedManifestUrl = this.resolveUrl(manifestUrl);
      const manifest = (await firstValueFrom(
        this.http.get<CollectionManifest>(resolvedManifestUrl)
      )) as CollectionManifest;

      return {
        ...manifest,
        thumbnail: manifest.thumbnail
          ? this.resolveUrl(manifest.thumbnail, resolvedManifestUrl)
          : undefined,
        lods: manifest.lods.map((lodUrl) => this.resolveUrl(lodUrl, resolvedManifestUrl)),
        environment: manifest.environment
          ? this.resolveUrl(manifest.environment, resolvedManifestUrl)
          : undefined,
      };
    } catch {
      return null;
    }
  }

  async loadGltf(url: string): Promise<unknown> {
    const loader = await this.createGltfLoader();

    return new Promise((resolve, reject) => {
      loader.load(
        this.resolveUrl(url),
        (gltf: unknown) => resolve(gltf),
        undefined,
        (error: unknown) => reject(error)
      );
    });
  }

  async loadHdr(url: string): Promise<unknown> {
    const extension = this.resolveEnvironmentExtension(url);

    if (!extension) {
      throw new Error(`Unsupported environment map format: ${url}`);
    }

    if (extension === 'hdr') {
      const module = await import('three/examples/jsm/loaders/HDRLoader.js');
      const { HDRLoader } = module;
      const loader = new HDRLoader();

      return new Promise((resolve, reject) => {
        loader.load(
          this.resolveUrl(url),
          (texture: unknown) => resolve(texture),
          undefined,
          (error: unknown) => reject(error)
        );
      });
    }

    const module = await import('three/examples/jsm/loaders/EXRLoader.js');
    const { EXRLoader } = module;
    const loader = new EXRLoader();

    return new Promise((resolve, reject) => {
      loader.load(
        this.resolveUrl(url),
        (texture: unknown) => resolve(texture),
        undefined,
        (error: unknown) => reject(error)
      );
    });
  }

  private resolveEnvironmentExtension(url: string): 'hdr' | 'exr' | null {
    const normalized = url.split('#')[0]?.split('?')[0]?.toLowerCase() ?? '';

    if (normalized.endsWith('.hdr')) {
      return 'hdr';
    }

    if (normalized.endsWith('.exr')) {
      return 'exr';
    }

    return null;
  }

  private async createGltfLoader(): Promise<GLTFLoader> {
    const module = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const { GLTFLoader } = module;
    const loader = new GLTFLoader();

    loader.setDRACOLoader(await this.getDracoLoader());

    const ktx2Loader = await this.getKtx2Loader();
    if (ktx2Loader) {
      loader.setKTX2Loader(ktx2Loader);
    }

    return loader;
  }

  private async getDracoLoader(): Promise<DRACOLoader> {
    if (!this.dracoLoaderPromise) {
      this.dracoLoaderPromise = import('three/examples/jsm/loaders/DRACOLoader.js').then(
        ({ DRACOLoader }) => {
          const loader = new DRACOLoader();
          loader.setDecoderPath(DRACO_DECODER_PATH);
          return loader;
        }
      );
    }

    return this.dracoLoaderPromise;
  }

  private async getKtx2Loader(): Promise<KTX2Loader | null> {
    if (!this.renderer) {
      return null;
    }

    if (!this.ktx2LoaderPromise) {
      this.ktx2LoaderPromise = import('three/examples/jsm/loaders/KTX2Loader.js').then(
        ({ KTX2Loader }) => {
          const loader = new KTX2Loader();
          loader.setTranscoderPath(BASIS_TRANSCODER_PATH);
          loader.detectSupport(this.renderer as never);
          return loader;
        }
      );
    }

    return this.ktx2LoaderPromise;
  }

  private resolveUrl(url: string, baseUrl?: string): string {
    try {
      return new URL(url, baseUrl ?? this.getDocumentBaseUrl()).toString();
    } catch {
      return url;
    }
  }

  private getDocumentBaseUrl(): string {
    if (typeof document !== 'undefined') {
      return document.baseURI;
    }

    if (typeof location !== 'undefined') {
      return location.href;
    }

    return 'http://localhost/';
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
