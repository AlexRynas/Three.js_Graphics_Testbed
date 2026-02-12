import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { BenchmarkState } from '../../metrics.model';

@Component({
  selector: 'app-status-bar',
  templateUrl: './status-bar.component.html',
  styleUrl: './status-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class StatusBarComponent {
  readonly status = input('');
  readonly benchmark = input<BenchmarkState>({
    active: false,
    progress: 0,
    sampleCount: 0,
    duration: 0,
  });
}
