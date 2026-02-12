import { Injectable, signal } from '@angular/core';

import { RenderingSettings, SceneSettings } from './controls.model';
import { BenchmarkState, FrameMetrics, StatsSample } from './metrics.model';

type RendererInfoSnapshot = {
  drawCalls: number;
  triangles: number;
};

type BenchmarkResultInput = {
  renderer: string;
  preset: string;
  settings: {
    rendering: RenderingSettings;
    scene: SceneSettings;
  };
};

@Injectable({ providedIn: 'root' })
export class BenchmarkService {
  private benchmarkFrames: number[] = [];
  private benchmarkFrameTimes: number[] = [];
  private benchmarkStart = 0;

  readonly metrics = signal<FrameMetrics>({
    fps: 0,
    minFps: 0,
    cpuMs: 0,
    maxFrameTime: 0,
    drawCalls: 0,
    triangles: 0,
    memoryMb: 0,
    gpuMs: null,
  });

  readonly benchmark = signal<BenchmarkState>({
    active: false,
    progress: 0,
    sampleCount: 0,
    duration: 12,
  });

  startBenchmark(): boolean {
    if (this.benchmark().active) {
      return false;
    }

    this.benchmarkFrames = [];
    this.benchmarkFrameTimes = [];
    this.benchmarkStart = performance.now();

    this.benchmark.update((current) => ({
      active: true,
      progress: 0,
      sampleCount: 0,
      duration: current.duration,
    }));

    return true;
  }

  updateBenchmarkProgress(time: number): { progress: number; completed: boolean } {
    const current = this.benchmark();
    const elapsed = (time - this.benchmarkStart) / 1000;
    const progress = Math.min(elapsed / current.duration, 1);

    this.benchmark.set({
      active: progress < 1,
      progress,
      sampleCount: this.benchmarkFrames.length,
      duration: current.duration,
    });

    return {
      progress,
      completed: progress >= 1,
    };
  }

  recordBenchmarkSample(sample: StatsSample | null): void {
    if (!sample) {
      return;
    }

    this.benchmarkFrames.push(sample.fps);
    this.benchmarkFrameTimes.push(sample.cpu);
    this.benchmark.update((current) => ({
      active: current.active,
      progress: current.progress,
      sampleCount: this.benchmarkFrames.length,
      duration: current.duration,
    }));
  }

  updateMetrics(
    sample: StatsSample | null,
    rendererInfo: RendererInfoSnapshot,
    memoryMb: number,
  ): void {
    const fps = sample ? sample.fps : 0;
    const cpuMs = sample ? sample.cpu : 0;
    const current = this.metrics();
    const roundedFps = Math.round(fps);

    this.metrics.set({
      fps: roundedFps,
      minFps: current.minFps === 0 ? roundedFps : Math.min(current.minFps, roundedFps),
      cpuMs: Math.round(cpuMs * 100) / 100,
      maxFrameTime: Math.max(current.maxFrameTime, cpuMs),
      drawCalls: rendererInfo.drawCalls,
      triangles: rendererInfo.triangles,
      memoryMb,
      gpuMs: sample?.gpu ?? null,
    });
  }

  buildBenchmarkResult(input: BenchmarkResultInput): Record<string, unknown> | null {
    if (this.benchmarkFrames.length === 0) {
      return null;
    }

    const avgFps =
      this.benchmarkFrames.reduce((sum, value) => sum + value, 0) / this.benchmarkFrames.length;
    const minFps = Math.min(...this.benchmarkFrames);
    const maxFrameTime = Math.max(...this.benchmarkFrameTimes);
    const metrics = this.metrics();

    return {
      renderer: input.renderer,
      preset: input.preset,
      avgFps: Math.round(avgFps),
      minFps: Math.round(minFps),
      maxFrameTime: Math.round(maxFrameTime * 100) / 100,
      drawCalls: metrics.drawCalls,
      triangles: metrics.triangles,
      memoryMb: metrics.memoryMb,
      gpuMs: metrics.gpuMs,
      settings: input.settings,
    };
  }
}
