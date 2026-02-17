import { Injectable } from '@angular/core';
import type { DirectionalLight, Node } from 'three/webgpu';
import { float, mul, oneMinus, vec2 } from 'three/tsl';
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
  RenderingControlConstraints,
  RenderingSettings,
  RenderingSupport,
  SceneSettings,
  ShadowType,
} from './controls.model';
import { RendererInstance } from './frame-stats-tracker';
import { ComposerBundle, ThreeModule, SceneInstance } from './testbed-runtime.service';

type PostProcessingPasses = ComposerBundle;

type ShadowApplyResult = {
  fallbackMessage: string | null;
  appliedType: ShadowType;
};

@Injectable({ providedIn: 'root' })
export class RenderingSettingsService {
  private lastShadowSignature: string | null = null;
  private readonly toggleControlToSettingKey: Partial<
    Record<keyof RenderingSupport['controls'], keyof RenderingSettings>
  > = {
    gtaoEnabled: 'gtaoEnabled',
    ssrEnabled: 'ssrEnabled',
    depthOfField: 'depthOfField',
    vignette: 'vignette',
    lensFlares: 'lensFlares',
    filmGrain: 'filmGrain',
  };

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
    switch (toneMapping) {
      case 'none':
        renderer.toneMapping = THREE.NoToneMapping;
        break;
      case 'linear':
        renderer.toneMapping = THREE.LinearToneMapping;
        break;
      case 'reinhard':
        renderer.toneMapping = THREE.ReinhardToneMapping;
        break;
      case 'cineon':
        renderer.toneMapping = THREE.CineonToneMapping;
        break;
      case 'aces':
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        break;
      case 'neutral':
        renderer.toneMapping = THREE.CustomToneMapping;
        break;
    }

    renderer.toneMappingExposure = sceneSettings.exposure;
  }

  applyPostProcessing(
    passes: PostProcessingPasses,
    settings: RenderingSettings,
    rendererMode: RendererMode,
    viewportSize: { width: number; height: number },
    scene: SceneInstance | null,
  ): void {
    const support = this.getAvailability(rendererMode);

    if (passes.webgpu) {
      const { width, height } = viewportSize;
      const scenePass = passes.webgpu.scenePass;
      let outputNode: Node = scenePass.getTextureNode('output');

      if (settings.gtaoEnabled && support.controls.gtaoEnabled) {
        const aoNode = ao(
          scenePass.getTextureNode('depth'),
          scenePass.getTextureNode('normal'),
          passes.webgpu.camera,
        );
        aoNode.radius.value = Math.max(0.05, settings.gtaoRadius * 0.025);
        aoNode.samples.value =
          settings.gtaoQuality === 'high' ? 24 : settings.gtaoQuality === 'low' ? 8 : 16;
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

    if (passes.gtaoPass) {
      passes.gtaoPass.enabled = !isWebGpu && settings.gtaoEnabled;
      const quality = settings.gtaoQuality;
      const qualityBoost = quality === 'high' ? 1.25 : quality === 'low' ? 0.8 : 1;
      const samples = quality === 'high' ? 24 : quality === 'low' ? 8 : 16;
      const pdRadius = quality === 'high' ? 10 : quality === 'low' ? 6 : 8;

      passes.gtaoPass.output = 0;
      passes.gtaoPass.blendIntensity = quality === 'low' ? 0.95 : 1;
      passes.gtaoPass.updateGtaoMaterial({
        radius: Math.max(0.05, settings.gtaoRadius * 0.025 * qualityBoost),
        samples,
        distanceFallOff: quality === 'low' ? 0.85 : 1,
        thickness: quality === 'high' ? 1.1 : 1,
      });
      passes.gtaoPass.updatePdMaterial({
        lumaPhi: quality === 'high' ? 12 : 10,
        depthPhi: quality === 'high' ? 2.5 : 2,
        normalPhi: quality === 'high' ? 3.5 : 3,
        radius: pdRadius,
        radiusExponent: quality === 'high' ? 2.2 : 2,
        rings: quality === 'low' ? 2 : 3,
        samples: quality === 'low' ? 8 : 16,
      });
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
      passes.vignettePass.enabled = !isWebGpu && settings.vignette;
    }
  }

  applyShadowSettings(
    renderer: RendererInstance | null,
    settings: RenderingSettings,
    threeModule: ThreeModule,
    rendererMode: RendererMode,
    scene: SceneInstance | null,
  ): ShadowApplyResult | null {
    if (!renderer || !('shadowMap' in renderer)) {
      return null;
    }

    renderer.shadowMap.enabled = settings.contactShadows;

    const { type, resolvedType } = this.resolveShadowType(
      settings.shadowType,
      threeModule,
      rendererMode,
    );
    renderer.shadowMap.type = type as typeof renderer.shadowMap.type;

    const shadowSignature = `${settings.contactShadows}:${resolvedType}:${rendererMode}`;
    if (shadowSignature !== this.lastShadowSignature) {
      this.lastShadowSignature = shadowSignature;
      this.refreshShadowMaterials(scene, threeModule);
    }

    if (resolvedType === settings.shadowType) {
      return {
        fallbackMessage: null,
        appliedType: resolvedType,
      };
    }

    return {
      fallbackMessage: `Shadow type ${settings.shadowType.toUpperCase()} is unavailable in ${rendererMode.toUpperCase()}; using ${this.shadowTypeLabel(resolvedType)}.`,
      appliedType: resolvedType,
    };
  }

  private refreshShadowMaterials(scene: SceneInstance | null, threeModule: ThreeModule): void {
    if (!scene) {
      return;
    }

    const THREE = threeModule;
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }

      if (Array.isArray(object.material)) {
        object.material.forEach((material) => {
          material.needsUpdate = true;
        });
        return;
      }

      object.material.needsUpdate = true;
    });
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

    if (settings.gtaoEnabled && !support.controls.gtaoEnabled) unsupported.push('GTAO');
    if (settings.depthOfField && !support.controls.depthOfField) unsupported.push('Depth of Field');
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
        smaaQuality: true,
        taaSamples: true,
        gtaoEnabled: true,
        ssrEnabled: isWebGpu,
        gtaoRadius: true,
        gtaoQuality: true,
        depthOfField: true,
        dofFocus: true,
        dofAperture: true,
        dofMaxBlur: true,
        vignette: !isWebGpu,
        lensFlares: true,
        filmGrain: true,
      },
      controlHints: {},
    };
  }

  getSceneControlConstraints(scene: SceneInstance | null): RenderingControlConstraints {
    const constraints: RenderingControlConstraints = {};

    // Here you can define restrictions that are imposed on any graphic settings if the scene does not meet the requirements.
    // if (!this.checkSomeSceneRequirement(scene)) {
    //   constraints.someGraphicalSetting = {
    //     supported: false,
    //     hint: 'Hint for the user why this setting is unavailable based on the current scene content',
    //   };
    // }

    return constraints;
  }

  mergeControlConstraints(
    support: RenderingSupport,
    constraints: RenderingControlConstraints,
  ): RenderingSupport {
    const mergedControls = { ...support.controls };
    const mergedControlHints: Partial<Record<keyof RenderingSupport['controls'], string>> = {
      ...support.controlHints,
    };

    Object.entries(constraints).forEach(([key, constraint]) => {
      if (!constraint) {
        return;
      }

      const controlKey = key as keyof RenderingSupport['controls'];
      mergedControls[controlKey] = mergedControls[controlKey] && constraint.supported;

      if (!mergedControls[controlKey] && constraint.hint) {
        mergedControlHints[controlKey] = constraint.hint;
      }
    });

    return {
      ...support,
      controls: mergedControls,
      controlHints: mergedControlHints,
    };
  }

  normalizeSettingsForSupport(
    settings: RenderingSettings,
    support: RenderingSupport,
  ): RenderingSettings {
    let normalizedSettings = settings;

    Object.entries(this.toggleControlToSettingKey).forEach(([control, settingKey]) => {
      if (!settingKey) {
        return;
      }

      const controlKey = control as keyof RenderingSupport['controls'];
      const settingsKey = settingKey as keyof RenderingSettings;
      const settingValue = normalizedSettings[settingsKey];

      if (typeof settingValue !== 'boolean') {
        return;
      }

      if (settingValue && !support.controls[controlKey]) {
        normalizedSettings = {
          ...normalizedSettings,
          [settingsKey]: false,
        };
      }
    });

    return normalizedSettings;
  }

  private resolveShadowType(
    requested: ShadowType,
    threeModule: ThreeModule,
    rendererMode: RendererMode,
  ): { type: number; resolvedType: ShadowType } {
    const fallbackType: ShadowType = 'pcf';
    if (requested === 'vsm' && rendererMode === 'webgpu') {
      return {
        type: threeModule.PCFShadowMap,
        resolvedType: fallbackType,
      };
    }

    switch (requested) {
      case 'basic':
        return { type: threeModule.BasicShadowMap, resolvedType: 'basic' };
      case 'pcf':
        return { type: threeModule.PCFShadowMap, resolvedType: 'pcf' };
      case 'pcfSoft':
        return { type: threeModule.PCFSoftShadowMap, resolvedType: 'pcfSoft' };
      case 'vsm':
        return { type: threeModule.VSMShadowMap, resolvedType: 'vsm' };
    }
  }

  private shadowTypeLabel(mode: ShadowType): string {
    if (mode === 'pcfSoft') {
      return 'PCF Soft';
    }

    return mode.toUpperCase();
  }
}
