import { Injectable } from '@angular/core';
import type { Node } from 'three/webgpu';
import { float, mul, oneMinus, vec2 } from 'three/tsl';
import { chromaticAberration } from 'three/examples/jsm/tsl/display/ChromaticAberrationNode.js';
import { dof } from 'three/examples/jsm/tsl/display/DepthOfFieldNode.js';
import { film } from 'three/examples/jsm/tsl/display/FilmNode.js';
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js';
import { ssr } from 'three/examples/jsm/tsl/display/SSRNode.js';
import { traa } from 'three/examples/jsm/tsl/display/TRAANode.js';

import {
  CapabilitySummary,
  RendererMode,
  RenderingSettings,
  RenderingSupport,
  SceneSettings,
} from './controls.model';
import { RendererInstance } from './frame-stats-tracker';
import { ComposerBundle, ThreeModule, SceneInstance } from './testbed-runtime.service';

type PostProcessingPasses = ComposerBundle;

@Injectable({ providedIn: 'root' })
export class RenderingSettingsService {
  applyToneMapping(
    renderer: RendererInstance | null,
    threeModule: ThreeModule,
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
    rendererMode: RendererMode,
    viewportSize: { width: number; height: number },
  ): void {
    const support = this.getAvailability(rendererMode);

    if (passes.webgpu) {
      const { width, height } = viewportSize;
      const scenePass = passes.webgpu.scenePass;
      let outputNode: Node = scenePass.getTextureNode('output');

      if (settings.ssaoEnabled && settings.screenSpaceShadows && support.controls.ssaoEnabled) {
        const aoNode = ao(scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), passes.webgpu.camera);
        aoNode.radius.value = Math.max(0.05, settings.ssaoRadius * 0.025);
        aoNode.samples.value = settings.ssaoQuality === 'high' ? 24 : settings.ssaoQuality === 'low' ? 8 : 16;
        aoNode.setSize(width, height);
        outputNode = mul(outputNode, oneMinus(aoNode.getTextureNode()));
      }

      if (settings.depthOfField && support.controls.depthOfField) {
        outputNode = dof(
          outputNode,
          scenePass.getViewZNode('depth'),
          settings.dofFocus,
          Math.max(0.1, settings.dofAperture * 350),
          Math.max(0.1, settings.dofMaxBlur * 120),
        );
      }

      if (settings.ssrEnabled && support.controls.ssrEnabled) {
        const ssrNode = ssr(
          outputNode,
          scenePass.getTextureNode('depth'),
          scenePass.getTextureNode('normal'),
          scenePass.getTextureNode('metalness'),
          null,
          passes.webgpu.camera,
        );
        ssrNode.setSize(width, height);
        outputNode = ssrNode;
      }

      if (settings.antialiasing === 'fxaa' && support.antialiasingModes.fxaa) {
        outputNode = fxaa(outputNode);
      }

      if (settings.antialiasing === 'smaa' && support.antialiasingModes.smaa) {
        const smaaNode = smaa(outputNode);
        smaaNode.setSize(width, height);
        outputNode = smaaNode;
      }

      if (settings.antialiasing === 'taa' && support.antialiasingModes.taa) {
        outputNode = traa(
          outputNode,
          scenePass.getTextureNode('depth'),
          scenePass.getTextureNode('velocity'),
          passes.webgpu.camera,
        );
      }

      if (settings.filmGrain && support.controls.filmGrain) {
        outputNode = film(outputNode, float(0.24));
      }

      if (settings.chromaticAberration && support.controls.chromaticAberration) {
        outputNode = chromaticAberration(outputNode, float(0.45), vec2(0.5, 0.5), float(1));
      }

      passes.webgpu.postProcessing.outputNode = outputNode;
      passes.webgpu.postProcessing.needsUpdate = true;
      return;
    }

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
    scene: SceneInstance | null,
    threeModule: ThreeModule,
    settings: RenderingSettings,
    capabilitySummary: CapabilitySummary,
  ): void {
    const THREE = threeModule;
    if (!renderer || !scene) {
      return;
    }

    const maxAniso = capabilitySummary.maxAnisotropy;
    const targetAniso = Math.min(settings.anisotropy, maxAniso || 1);

    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        const material = object.material;
        if (material instanceof THREE.MeshStandardMaterial) {
          const maps = [
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
    rendererMode: RendererMode,
    rendererLabel: string,
  ): string | null {
    const support = this.getAvailability(rendererMode);
    const unsupported: string[] = [];

    if (!support.antialiasingModes[settings.antialiasing]) {
      unsupported.push(settings.antialiasing.toUpperCase());
    }

    if (settings.ssaoEnabled && !support.controls.ssaoEnabled) unsupported.push('SSAO');
    if (settings.depthOfField && !support.controls.depthOfField) unsupported.push('Depth of Field');
    if (settings.chromaticAberration && !support.controls.chromaticAberration) {
      unsupported.push('Chromatic Aberration');
    }
    if (settings.vignette && !support.controls.vignette) unsupported.push('Vignette');
    if (settings.lensFlares && !support.controls.lensFlares) unsupported.push('Lens Flares');
    if (settings.filmGrain && !support.controls.filmGrain) unsupported.push('Film Grain');
    if (settings.ssrEnabled && !support.controls.ssrEnabled) unsupported.push('SSR');
    if (settings.globalIllumination) unsupported.push('Global Illumination');
    if (settings.rayTracing) unsupported.push('Ray Tracing');
    if (settings.pathTracing) unsupported.push('Path Tracing');
    if (settings.volumetricLighting) unsupported.push('Volumetric Lighting');

    if (unsupported.length === 0) {
      return null;
    }

    return `Unsupported in ${rendererLabel}: ${unsupported.join(', ')}`;
  }

  getAvailability(rendererMode: RendererMode): RenderingSupport {
    const isWebGpu = rendererMode === 'webgpu';

    return {
      antialiasingModes: {
        none: true,
        msaa: !isWebGpu,
        fxaa: true,
        smaa: true,
        taa: true,
      },
      controls: {
        msaaSamples: !isWebGpu,
        smaaQuality: true,
        taaSamples: true,
        ssaoEnabled: true,
        ssrEnabled: isWebGpu,
        ssaoRadius: true,
        ssaoQuality: true,
        depthOfField: true,
        dofFocus: true,
        dofAperture: true,
        dofMaxBlur: true,
        chromaticAberration: true,
        vignette: !isWebGpu,
        lensFlares: true,
        filmGrain: true,
      },
    };
  }
}
