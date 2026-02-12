export type StatsSample = {
  fps: number;
  cpu: number;
  gpu: number | null;
};

export interface FrameMetrics {
  fps: number;
  minFps: number;
  cpuMs: number;
  maxFrameTime: number;
  drawCalls: number;
  triangles: number;
  memoryMb: number;
  gpuMs: number | null;
}

export interface BenchmarkState {
  active: boolean;
  progress: number;
  sampleCount: number;
  duration: number;
}
