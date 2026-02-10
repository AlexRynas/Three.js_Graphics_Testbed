import { Injectable, signal } from '@angular/core';
import { CapabilitySummary } from './controls.model';

const defaultCapabilities: CapabilitySummary = {
  webgpu: false,
  webgl2: false,
  maxTextureSize: 0,
  maxAnisotropy: 1,
  msaaSamples: 0,
  shaderPrecision: 'unknown',
  compressedTextures: [],
  gpuTimerQuery: false
};

@Injectable({ providedIn: 'root' })
export class CapabilitiesService {
  private readonly capabilitiesSignal = signal<CapabilitySummary>(defaultCapabilities);
  readonly capabilities = this.capabilitiesSignal.asReadonly();

  async detect(): Promise<CapabilitySummary> {
    if (typeof document === 'undefined') {
      return this.capabilitiesSignal();
    }

    const webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;

    const canvas = document.createElement('canvas');
    const webgl2 = canvas.getContext('webgl2');
    const webgl = webgl2 ?? canvas.getContext('webgl');

    if (!webgl) {
      const fallback = { ...defaultCapabilities, webgpu: webgpuAvailable };
      this.capabilitiesSignal.set(fallback);
      return fallback;
    }

    const gl = webgl as WebGLRenderingContext | WebGL2RenderingContext;
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const maxAnisotropy = this.getMaxAnisotropy(gl);
    const msaaSamples = this.getMsaaSamples(gl);
    const shaderPrecision = this.getShaderPrecision(gl);
    const compressedTextures = this.getCompressedTextureSupport(gl);
    const gpuTimerQuery = this.supportsGpuTimer(gl);

    const summary: CapabilitySummary = {
      webgpu: webgpuAvailable,
      webgl2: Boolean(webgl2),
      maxTextureSize,
      maxAnisotropy,
      msaaSamples,
      shaderPrecision,
      compressedTextures,
      gpuTimerQuery
    };

    this.capabilitiesSignal.set(summary);
    return summary;
  }

  private getMaxAnisotropy(gl: WebGLRenderingContext | WebGL2RenderingContext): number {
    type AnisotropyExt = { MAX_TEXTURE_MAX_ANISOTROPY_EXT: number };
    const ext =
      gl.getExtension('EXT_texture_filter_anisotropic') ||
      gl.getExtension('MOZ_EXT_texture_filter_anisotropic') ||
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');

    if (!ext) {
      return 1;
    }

    const anisotropyExt = ext as AnisotropyExt;
    return (gl.getParameter(anisotropyExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) ?? 1;
  }

  private getMsaaSamples(gl: WebGLRenderingContext | WebGL2RenderingContext): number {
    if (gl instanceof WebGL2RenderingContext) {
      const samples = gl.getParameter(gl.SAMPLES) as number;
      return Number.isFinite(samples) ? samples : 0;
    }

    return 0;
  }

  private getShaderPrecision(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
    const format = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (!format) {
      return 'unknown';
    }

    if (format.precision > 0) {
      return 'highp';
    }

    const medium = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);
    return medium && medium.precision > 0 ? 'mediump' : 'lowp';
  }

  private getCompressedTextureSupport(gl: WebGLRenderingContext | WebGL2RenderingContext): string[] {
    const extensions = [
      'WEBGL_compressed_texture_astc',
      'WEBGL_compressed_texture_etc',
      'WEBGL_compressed_texture_etc1',
      'WEBGL_compressed_texture_pvrtc',
      'WEBGL_compressed_texture_s3tc',
      'WEBGL_compressed_texture_s3tc_srgb'
    ];

    return extensions.filter((name) => Boolean(gl.getExtension(name)));
  }

  private supportsGpuTimer(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
    return Boolean(
      gl.getExtension('EXT_disjoint_timer_query_webgl2') ||
        gl.getExtension('EXT_disjoint_timer_query')
    );
  }
}
