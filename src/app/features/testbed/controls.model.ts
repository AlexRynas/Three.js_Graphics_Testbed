export type RendererMode = 'webgl' | 'webgpu';
export type AntiAliasingMode = 'none' | 'msaa' | 'fxaa' | 'smaa' | 'taa';
export type TextureFiltering = 'linear' | 'trilinear' | 'anisotropic';
export type QualityLevel = 'low' | 'medium' | 'high';

export interface RenderingSettings {
  rendererMode: RendererMode;
  antialiasing: AntiAliasingMode;
  msaaSamples: number;
  smaaQuality: QualityLevel;
  taaSamples: number;
  ssaoEnabled: boolean;
  ssaoRadius: number;
  ssaoQuality: QualityLevel;
  ssrEnabled: boolean;
  globalIllumination: boolean;
  rayTracing: boolean;
  pathTracing: boolean;
  anisotropy: number;
  textureFiltering: TextureFiltering;
  depthOfField: boolean;
  dofFocus: number;
  dofAperture: number;
  dofMaxBlur: number;
  volumetricLighting: boolean;
  contactShadows: boolean;
  screenSpaceShadows: boolean;
  chromaticAberration: boolean;
  vignette: boolean;
  lensFlares: boolean;
  filmGrain: boolean;
}

export interface SceneSettings {
  environmentIntensity: number;
  exposure: number;
  toneMapping: 'none' | 'aces' | 'neutral';
  autoRotate: boolean;
  lodBias: number;
  bvhEnabled: boolean;
}

export interface CollectionRef {
  id: string;
  displayName: string;
  manifestUrl?: string;
}

export interface CollectionManifest {
  name: string;
  displayName: string;
  thumbnail?: string;
  lods: string[];
  environment?: string;
}

export interface Preset {
  name: string;
  rendering: RenderingSettings;
  scene: SceneSettings;
}

export interface FeatureSupport {
  key: string;
  label: string;
  supported: boolean;
  detail?: string;
}

export interface CapabilitySummary {
  webgpu: boolean;
  webgl2: boolean;
  maxTextureSize: number;
  maxAnisotropy: number;
  msaaSamples: number;
  shaderPrecision: string;
  compressedTextures: string[];
  gpuTimerQuery: boolean;
}

export interface InspectorSnapshot {
  meshCount: number;
  materialCount: number;
  textureCount: number;
  lodCount: number;
  bvhCount: number;
}

export const defaultRenderingSettings: RenderingSettings = {
  rendererMode: 'webgl',
  antialiasing: 'msaa',
  msaaSamples: 4,
  smaaQuality: 'medium',
  taaSamples: 4,
  ssaoEnabled: true,
  ssaoRadius: 12,
  ssaoQuality: 'medium',
  ssrEnabled: false,
  globalIllumination: false,
  rayTracing: false,
  pathTracing: false,
  anisotropy: 8,
  textureFiltering: 'trilinear',
  depthOfField: false,
  dofFocus: 5,
  dofAperture: 0.018,
  dofMaxBlur: 0.01,
  volumetricLighting: false,
  contactShadows: true,
  screenSpaceShadows: true,
  chromaticAberration: false,
  vignette: true,
  lensFlares: true,
  filmGrain: false
};

export const defaultSceneSettings: SceneSettings = {
  environmentIntensity: 1,
  exposure: 1,
  toneMapping: 'aces',
  autoRotate: true,
  lodBias: 0,
  bvhEnabled: false
};
