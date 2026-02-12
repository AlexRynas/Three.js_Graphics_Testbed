import { Injectable } from '@angular/core';
import * as THREE from 'three';
import * as THREE_WEBGPU from 'three/webgpu';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { TAARenderPass } from 'three/examples/jsm/postprocessing/TAARenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { FilmPass } from 'three/examples/jsm/postprocessing/FilmPass.js';

import { CapabilitySummary, RenderingSettings, SceneSettings } from './controls.model';
import { RendererInstance } from './frame-stats-tracker';

type PostProcessingPasses = {
  composer: EffectComposer | null;
  fxaaPass: ShaderPass | null;
  smaaPass: SMAAPass | null;
  taaPass: TAARenderPass | null;
  ssaoPass: SSAOPass | null;
  dofPass: BokehPass | null;
  filmPass: FilmPass | null;
  vignettePass: ShaderPass | null;
  chromaticPass: ShaderPass | null;
};

@Injectable({ providedIn: 'root' })
export class RenderingSettingsService {
  applyToneMapping(
    renderer: RendererInstance | null,
    threeModule: typeof THREE,
    sceneSettings: SceneSettings,
  ): void {
    const THREE = threeModule;
    if (!renderer || !('toneMapping' in renderer)) {
      return;
    }

    const toneMapping = sceneSettings.toneMapping;
    if (toneMapping === 'aces') {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
    } else if (toneMapping === 'neutral') {
      renderer.toneMapping = THREE.NeutralToneMapping;
    } else {
      renderer.toneMapping = THREE.NoToneMapping;
    }

    renderer.toneMappingExposure = sceneSettings.exposure;
  }

  applyPostProcessing(
    passes: PostProcessingPasses,
    settings: RenderingSettings,
    rendererMode: RenderingSettings['rendererMode'],
    viewportSize: { width: number; height: number },
  ): void {
    if (!passes.composer) {
      return;
    }

    const isWebGpu = rendererMode === 'webgpu';
    const aa = settings.antialiasing;
    const { width, height } = viewportSize;

    if (passes.fxaaPass) {
      passes.fxaaPass.enabled = !isWebGpu && aa === 'fxaa';
    }
    if (passes.smaaPass) {
      passes.smaaPass.enabled = !isWebGpu && aa === 'smaa';
      const qualityScale =
        settings.smaaQuality === 'low' ? 0.75 : settings.smaaQuality === 'high' ? 1.25 : 1;
      passes.smaaPass.setSize(width * qualityScale, height * qualityScale);
    }
    if (passes.taaPass) {
      passes.taaPass.enabled = !isWebGpu && aa === 'taa';
      passes.taaPass.sampleLevel = Math.max(0, settings.taaSamples - 1);
    }

    if (passes.ssaoPass) {
      passes.ssaoPass.enabled = !isWebGpu && settings.ssaoEnabled && settings.screenSpaceShadows;
      const qualityBoost = settings.ssaoQuality === 'high' ? 1.4 : settings.ssaoQuality === 'low' ? 0.8 : 1;
      passes.ssaoPass.kernelRadius = settings.ssaoRadius * qualityBoost;
    }

    if (passes.dofPass) {
      passes.dofPass.enabled = !isWebGpu && settings.depthOfField;
      passes.dofPass.materialBokeh.uniforms['focus'].value = settings.dofFocus;
      passes.dofPass.materialBokeh.uniforms['aperture'].value = settings.dofAperture;
      passes.dofPass.materialBokeh.uniforms['maxblur'].value = settings.dofMaxBlur;
    }

    if (passes.filmPass) {
      passes.filmPass.enabled = !isWebGpu && settings.filmGrain;
    }

    if (passes.vignettePass) {
      passes.vignettePass.enabled = settings.vignette;
    }

    if (passes.chromaticPass) {
      passes.chromaticPass.enabled = !isWebGpu && settings.chromaticAberration;
    }
  }

  applyShadowSettings(renderer: RendererInstance | null, settings: RenderingSettings): void {
    if (!renderer || !('shadowMap' in renderer)) {
      return;
    }

    renderer.shadowMap.enabled = settings.contactShadows;
  }

  applyTextureFiltering(
    renderer: RendererInstance | null,
    scene: THREE.Scene | null,
    threeModule: typeof THREE,
    settings: RenderingSettings,
    capabilitySummary: CapabilitySummary,
  ): void {
    const THREE = threeModule;
    if (!renderer || !scene) {
      return;
    }

    const maxAniso = capabilitySummary.maxAnisotropy;
    const targetAniso = Math.min(settings.anisotropy, maxAniso || 1);

    scene.traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh) {
        const material = object.material;
        if (material instanceof THREE.MeshStandardMaterial) {
          const maps: Array<THREE.Texture | null> = [
            material.map,
            material.normalMap,
            material.roughnessMap,
            material.metalnessMap,
            material.emissiveMap,
          ];

          maps.forEach((texture) => {
            if (!texture) {
              return;
            }

            if (settings.textureFiltering === 'linear') {
              texture.minFilter = THREE.LinearFilter;
              texture.magFilter = THREE.LinearFilter;
              texture.anisotropy = 1;
            } else if (settings.textureFiltering === 'trilinear') {
              texture.minFilter = THREE.LinearMipmapLinearFilter;
              texture.magFilter = THREE.LinearFilter;
              texture.anisotropy = 1;
            } else {
              texture.minFilter = THREE.LinearMipmapLinearFilter;
              texture.magFilter = THREE.LinearFilter;
              texture.anisotropy = targetAniso;
            }

            texture.needsUpdate = true;
          });
        }
      }
    });
  }

  getUnsupportedLabel(
    settings: RenderingSettings,
    rendererMode: RenderingSettings['rendererMode'],
    rendererLabel: string,
  ): string | null {
    const unsupported: string[] = [];
    const isWebGpu = rendererMode === 'webgpu';

    if (isWebGpu) {
      if (settings.antialiasing === 'fxaa') unsupported.push('FXAA');
      if (settings.antialiasing === 'smaa') unsupported.push('SMAA');
      if (settings.antialiasing === 'taa') unsupported.push('TAA');
      if (settings.ssaoEnabled) unsupported.push('SSAO');
      if (settings.depthOfField) unsupported.push('Depth of Field');
      if (settings.chromaticAberration) unsupported.push('Chromatic Aberration');
      if (settings.filmGrain) unsupported.push('Film Grain');
    }

    if (settings.ssrEnabled) unsupported.push('SSR');
    if (settings.globalIllumination) unsupported.push('Global Illumination');
    if (settings.rayTracing) unsupported.push('Ray Tracing');
    if (settings.pathTracing) unsupported.push('Path Tracing');
    if (settings.volumetricLighting) unsupported.push('Volumetric Lighting');

    if (unsupported.length === 0) {
      return null;
    }

    return `Unsupported in ${rendererLabel}: ${unsupported.join(', ')}`;
  }
}
