import { Injectable } from '@angular/core';
import GUI from 'lil-gui';

import { RenderingSettings, SceneSettings } from './controls.model';

type GuiBridgeOptions = {
  host: HTMLElement;
  existingGui: GUI | null;
  rendering: RenderingSettings;
  scene: SceneSettings;
  onCommit: (rendering: RenderingSettings, scene: SceneSettings) => void;
};

@Injectable({ providedIn: 'root' })
export class GuiBridgeService {
  mount(options: GuiBridgeOptions): GUI {
    options.existingGui?.destroy();

    const gui = new GUI({ width: 320, autoPlace: false, title: 'Graphics Control Deck' });
    options.host.appendChild(gui.domElement);

    const settingsState: RenderingSettings = { ...options.rendering };
    const sceneState: SceneSettings = { ...options.scene };
    const commit = () => options.onCommit(settingsState, sceneState);

    const rendererFolder = gui.addFolder('Renderer');
    rendererFolder.add(settingsState, 'rendererMode', ['webgl', 'webgpu']).name('Mode').onChange(commit);
    rendererFolder
      .add(settingsState, 'antialiasing', ['none', 'msaa', 'fxaa', 'smaa', 'taa'])
      .name('AA')
      .onChange(commit);
    rendererFolder.add(settingsState, 'msaaSamples', 0, 8, 1).name('MSAA Samples').onChange(commit);
    rendererFolder
      .add(settingsState, 'smaaQuality', ['low', 'medium', 'high'])
      .name('SMAA Quality')
      .onChange(commit);
    rendererFolder.add(settingsState, 'taaSamples', 1, 8, 1).name('TAA Samples').onChange(commit);

    const postFolder = gui.addFolder('Post FX');
    postFolder.add(settingsState, 'ssaoEnabled').name('SSAO').onChange(commit);
    postFolder.add(settingsState, 'ssaoRadius', 1, 32, 1).name('SSAO Radius').onChange(commit);
    postFolder
      .add(settingsState, 'ssaoQuality', ['low', 'medium', 'high'])
      .name('SSAO Quality')
      .onChange(commit);
    postFolder.add(settingsState, 'ssrEnabled').name('SSR').onChange(commit);
    postFolder.add(settingsState, 'depthOfField').name('Depth of Field').onChange(commit);
    postFolder.add(settingsState, 'dofFocus', 1, 20, 0.1).name('DOF Focus').onChange(commit);
    postFolder.add(settingsState, 'dofAperture', 0.001, 0.05, 0.001).name('DOF Aperture').onChange(commit);
    postFolder.add(settingsState, 'dofMaxBlur', 0.001, 0.02, 0.001).name('DOF Blur').onChange(commit);
    postFolder.add(settingsState, 'chromaticAberration').name('Chromatic').onChange(commit);
    postFolder.add(settingsState, 'vignette').name('Vignette').onChange(commit);
    postFolder.add(settingsState, 'filmGrain').name('Film Grain').onChange(commit);

    const qualityFolder = gui.addFolder('Texture + Filtering');
    qualityFolder.add(settingsState, 'anisotropy', 1, 16, 1).name('Anisotropy').onChange(commit);
    qualityFolder
      .add(settingsState, 'textureFiltering', ['linear', 'trilinear', 'anisotropic'])
      .name('Filtering')
      .onChange(commit);

    const sceneFolder = gui.addFolder('Scene');
    sceneFolder.add(sceneState, 'environmentIntensity', 0, 2, 0.05).name('Env Intensity').onChange(commit);
    sceneFolder.add(sceneState, 'exposure', 0.4, 2, 0.05).name('Exposure').onChange(commit);
    sceneFolder.add(sceneState, 'toneMapping', ['none', 'aces', 'neutral']).name('Tone Mapping').onChange(commit);
    sceneFolder.add(sceneState, 'autoRotate').name('Auto Rotate').onChange(commit);
    sceneFolder.add(sceneState, 'lodBias', -2, 2, 0.25).name('LOD Bias').onChange(commit);
    sceneFolder.add(sceneState, 'bvhEnabled').name('GPU BVH').onChange(commit);

    const extrasFolder = gui.addFolder('Extras');
    extrasFolder.add(settingsState, 'lensFlares').name('Lens Flares').onChange(commit);
    extrasFolder.add(settingsState, 'contactShadows').name('Contact Shadows').onChange(commit);
    extrasFolder.add(settingsState, 'screenSpaceShadows').name('Screen Space Shadows').onChange(commit);
    extrasFolder.add(settingsState, 'volumetricLighting').name('Volumetric Lighting').onChange(commit);
    extrasFolder.add(settingsState, 'globalIllumination').name('Global Illumination').onChange(commit);
    extrasFolder.add(settingsState, 'rayTracing').name('Ray Tracing').onChange(commit);
    extrasFolder.add(settingsState, 'pathTracing').name('Path Tracing').onChange(commit);

    return gui;
  }
}
