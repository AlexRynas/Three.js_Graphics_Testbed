import type { WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import { StatsSample } from './metrics.model';
import { RendererMode } from './controls.model';

export type RendererInstance = WebGLRenderer | WebGPURenderer;

type Webgl2TimerQueryExt = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
};

type Webgl1TimerQueryExt = Webgl2TimerQueryExt & {
  QUERY_RESULT_AVAILABLE_EXT: number;
  QUERY_RESULT_EXT: number;
  createQueryEXT: () => WebGLQuery | null;
  deleteQueryEXT: (query: WebGLQuery) => void;
  beginQueryEXT: (target: number, query: WebGLQuery) => void;
  endQueryEXT: (target: number) => void;
  getQueryObjectEXT: (query: WebGLQuery, pname: number) => number | boolean;
};

class WebglGpuTimer {
  private readonly gl: WebGLRenderingContext | WebGL2RenderingContext;
  private readonly extWebgl2: Webgl2TimerQueryExt | null;
  private readonly extWebgl1: Webgl1TimerQueryExt | null;
  private currentQuery: WebGLQuery | null = null;
  private readonly pendingQueries: WebGLQuery[] = [];
  private lastGpuMs: number | null = null;

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.gl = gl;
    this.extWebgl2 =
      gl instanceof WebGL2RenderingContext
        ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as Webgl2TimerQueryExt | null)
        : null;
    this.extWebgl1 = this.extWebgl2
      ? null
      : (gl.getExtension('EXT_disjoint_timer_query') as Webgl1TimerQueryExt | null);
  }

  get isAvailable(): boolean {
    return Boolean(this.extWebgl2 || this.extWebgl1);
  }

  begin(): void {
    if (!this.isAvailable || this.currentQuery) {
      return;
    }

    if (this.extWebgl2 && this.gl instanceof WebGL2RenderingContext) {
      const gl2 = this.gl as WebGL2RenderingContext;
      const query = gl2.createQuery();
      if (!query) {
        return;
      }
      this.currentQuery = query;
      gl2.beginQuery(this.extWebgl2.TIME_ELAPSED_EXT, query);
      return;
    }

    if (this.extWebgl1) {
      const query = this.extWebgl1.createQueryEXT();
      if (!query) {
        return;
      }
      this.currentQuery = query;
      this.extWebgl1.beginQueryEXT(this.extWebgl1.TIME_ELAPSED_EXT, query);
    }
  }

  end(): void {
    if (!this.isAvailable || !this.currentQuery) {
      return;
    }

    if (this.extWebgl2 && this.gl instanceof WebGL2RenderingContext) {
      const gl2 = this.gl as WebGL2RenderingContext;
      gl2.endQuery(this.extWebgl2.TIME_ELAPSED_EXT);
      this.pendingQueries.push(this.currentQuery);
      this.currentQuery = null;
      this.collect();
      return;
    }

    if (this.extWebgl1) {
      this.extWebgl1.endQueryEXT(this.extWebgl1.TIME_ELAPSED_EXT);
      this.pendingQueries.push(this.currentQuery);
      this.currentQuery = null;
      this.collect();
    }
  }

  getLatestMs(): number | null {
    this.collect();
    return this.lastGpuMs;
  }

  dispose(): void {
    if (this.extWebgl2 && this.gl instanceof WebGL2RenderingContext) {
      const gl2 = this.gl as WebGL2RenderingContext;
      this.pendingQueries.forEach((query) => gl2.deleteQuery(query));
    } else if (this.extWebgl1) {
      this.pendingQueries.forEach((query) => this.extWebgl1?.deleteQueryEXT(query));
    }
    this.pendingQueries.length = 0;
    this.currentQuery = null;
  }

  private collect(): void {
    if (!this.isAvailable || this.pendingQueries.length === 0) {
      return;
    }

    if (this.extWebgl2 && this.gl instanceof WebGL2RenderingContext) {
      const gl2 = this.gl as WebGL2RenderingContext;
      const disjoint = gl2.getParameter(this.extWebgl2.GPU_DISJOINT_EXT) as boolean;
      for (let index = this.pendingQueries.length - 1; index >= 0; index -= 1) {
        const query = this.pendingQueries[index];
        const available = gl2.getQueryParameter(query, gl2.QUERY_RESULT_AVAILABLE) as boolean;
        if (available && !disjoint) {
          const ns = gl2.getQueryParameter(query, gl2.QUERY_RESULT) as number;
          this.lastGpuMs = ns / 1_000_000;
          gl2.deleteQuery(query);
          this.pendingQueries.splice(index, 1);
        }
      }
      return;
    }

    if (this.extWebgl1) {
      const disjoint = this.gl.getParameter(this.extWebgl1.GPU_DISJOINT_EXT) as boolean;
      for (let index = this.pendingQueries.length - 1; index >= 0; index -= 1) {
        const query = this.pendingQueries[index];
        const available = this.extWebgl1.getQueryObjectEXT(
          query,
          this.extWebgl1.QUERY_RESULT_AVAILABLE_EXT,
        ) as boolean;
        if (available && !disjoint) {
          const ns = this.extWebgl1.getQueryObjectEXT(query, this.extWebgl1.QUERY_RESULT_EXT) as number;
          this.lastGpuMs = ns / 1_000_000;
          this.extWebgl1.deleteQueryEXT(query);
          this.pendingQueries.splice(index, 1);
        }
      }
    }
  }
}

export class FrameStatsTracker {
  private lastFrameTime = performance.now();
  private cpuStart = 0;
  private lastSample: StatsSample = { fps: 0, cpu: 0, gpu: null };
  private gpuTimer: WebglGpuTimer | null = null;

  init(renderer: RendererInstance, mode: RendererMode): void {
    this.dispose();
    this.lastFrameTime = performance.now();
    if (mode !== 'webgl' || !('getContext' in renderer)) {
      return;
    }

    const context = renderer.getContext();
    if (context) {
      const timer = new WebglGpuTimer(context);
      this.gpuTimer = timer.isAvailable ? timer : null;
    }
  }

  beginFrame(): void {
    this.cpuStart = performance.now();
    this.gpuTimer?.begin();
  }

  endFrame(): StatsSample {
    this.gpuTimer?.end();
    const now = performance.now();
    const delta = now - this.lastFrameTime;
    this.lastFrameTime = now;

    const fps = delta > 0 ? 1000 / delta : this.lastSample.fps;
    const cpu = Math.max(0, now - this.cpuStart);
    const gpu = this.gpuTimer?.getLatestMs() ?? null;

    this.lastSample = {
      fps,
      cpu,
      gpu,
    };

    return this.lastSample;
  }

  dispose(): void {
    this.gpuTimer?.dispose();
    this.gpuTimer = null;
  }
}
