export type RendererMode = 'webgl' | 'webgpu';
export type AntiAliasingMode = 'none' | 'msaa' | 'fxaa' | 'smaa' | 'taa';
export type TextureFiltering = 'linear' | 'trilinear' | 'anisotropic';
export type QualityLevel = 'low' | 'medium' | 'high';
export type ShadowType = 'basic' | 'pcf' | 'pcfSoft' | 'vsm';
export type RenderingControlKey =
  | 'smaaQuality'
  | 'taaSamples'
  | 'ssaoEnabled'
  | 'ssrEnabled'
  | 'ssaoRadius'
  | 'ssaoQuality'
  | 'depthOfField'
  | 'dofFocus'
  | 'dofAperture'
  | 'dofMaxBlur'
  | 'vignette'
  | 'lensFlares'
  | 'filmGrain';
export type ToneMapping = 'none' | 'linear' | 'reinhard' | 'cineon' | 'aces' | 'neutral';

export interface RenderingSupport {
  antialiasingModes: Record<AntiAliasingMode, boolean>;
  controls: Record<RenderingControlKey, boolean>;
}

export interface RenderingSettings {
  rendererMode: RendererMode;
  antialiasing: AntiAliasingMode;
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
  shadowType: ShadowType;
  screenSpaceShadows: boolean;
  vignette: boolean;
  lensFlares: boolean;
  filmGrain: boolean;
}

export interface SceneSettings {
  environmentIntensity: number;
  exposure: number;
  toneMapping: ToneMapping;
  autoRotate: boolean;
  lodBias: number;
  bvhEnabled: boolean;
}

export interface CollectionRef {
  id: string;
  displayName: string;
  manifestUrl?: string;
}

export type Vector3Tuple = [number, number, number];

export interface CollectionManifest {
  name: string;
  displayName: string;
  thumbnail?: string;
  lods: string[];
  environment?: string;
  initialCameraPosition: Vector3Tuple;
  initialControlTarget: Vector3Tuple;
}

export interface Preset {
  name: string;
  rendering: RenderingSettings;
  scene: SceneSettings;
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
  shadowType: 'pcf',
  screenSpaceShadows: true,
  vignette: true,
  lensFlares: true,
  filmGrain: false,
};

export const defaultSceneSettings: SceneSettings = {
  environmentIntensity: 1,
  exposure: 1,
  toneMapping: 'none',
  autoRotate: true,
  lodBias: 0,
  bvhEnabled: false,
};
