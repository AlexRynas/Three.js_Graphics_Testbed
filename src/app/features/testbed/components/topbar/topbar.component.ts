import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { PillButtonComponent } from '../../../../shared/ui/pill-button/pill-button.component';

@Component({
  selector: 'app-topbar',
  templateUrl: './topbar.component.html',
  styleUrl: './topbar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PillButtonComponent],
})
export class TopbarComponent {
  readonly status = input('');
  readonly canBenchmark = input(true);

  readonly runBenchmark = output<void>();
  readonly exportMetrics = output<void>();
  readonly toggleGui = output<void>();
}
