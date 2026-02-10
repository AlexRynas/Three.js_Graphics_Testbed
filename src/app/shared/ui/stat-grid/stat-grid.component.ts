import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type StatGridRow = {
  key?: string;
  label: string;
  value: string | number;
};

@Component({
  selector: 'app-stat-grid',
  template: `
    @for (row of rows(); track row.key ?? row.label) {
      <div class="stat-card">
        <span class="stat-label">{{ row.label }}</span>
        <span class="stat-value">{{ row.value }}</span>
      </div>
    }
  `,
  styleUrl: './stat-grid.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class StatGridComponent {
  readonly rows = input<StatGridRow[]>([]);
}
