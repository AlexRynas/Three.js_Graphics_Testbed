import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  viewChild,
} from '@angular/core';

import { HudListComponent, HudListRow } from '../../../../shared/ui/hud-list/hud-list.component';

type FrameMetrics = {
  fps: number;
  minFps: number;
  cpuMs: number;
  maxFrameTime: number;
  drawCalls: number;
  triangles: number;
  memoryMb: number;
  gpuMs: number | null;
};

type BenchmarkState = {
  active: boolean;
  progress: number;
  sampleCount: number;
  duration: number;
};

@Component({
  selector: 'app-viewport',
  templateUrl: './viewport.component.html',
  styleUrl: './viewport.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, HudListComponent],
})
export class ViewportComponent {
  readonly rendererLabel = input('WebGL');
  readonly metrics = input<FrameMetrics>({
    fps: 0,
    minFps: 0,
    cpuMs: 0,
    maxFrameTime: 0,
    drawCalls: 0,
    triangles: 0,
    memoryMb: 0,
    gpuMs: null,
  });
  readonly status = input('');
  readonly benchmark = input<BenchmarkState>({
    active: false,
    progress: 0,
    sampleCount: 0,
    duration: 0,
  });

  readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly viewportRef = viewChild.required<ElementRef<HTMLDivElement>>('viewport');

  readonly hudRows = computed<HudListRow[]>(() => {
    const metrics = this.metrics();
    return [
      { key: 'renderer', label: 'Renderer', value: this.rendererLabel() },
      { key: 'fps', label: 'FPS', value: metrics.fps },
      { key: 'drawCalls', label: 'Draw Calls', value: metrics.drawCalls },
      { key: 'triangles', label: 'Triangles', value: metrics.triangles },
      { key: 'cpu', label: 'CPU ms', value: metrics.cpuMs },
      { key: 'gpu', label: 'GPU ms', value: metrics.gpuMs ?? 'n/a' },
    ];
  });

  get canvas(): HTMLCanvasElement {
    return this.canvasRef().nativeElement;
  }

  get viewport(): HTMLDivElement {
    return this.viewportRef().nativeElement;
  }
}
