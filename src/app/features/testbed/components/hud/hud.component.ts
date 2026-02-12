import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { FrameMetrics } from '../../metrics.model';
import { HudListComponent, HudListRow } from '../../../../shared/ui/hud-list/hud-list.component';

@Component({
  selector: 'app-hud',
  templateUrl: './hud.component.html',
  styleUrl: './hud.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, HudListComponent],
})
export class HudComponent {
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

  readonly rows = computed<HudListRow[]>(() => {
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
}
