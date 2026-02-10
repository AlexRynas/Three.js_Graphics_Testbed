import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type HudListRow = {
  key?: string;
  label: string;
  value: string | number;
};

@Component({
  selector: 'app-hud-list',
  template: `
    @for (row of rows(); track row.key ?? row.label) {
      <div class="hud-row">
        <span class="hud-label">{{ row.label }}</span>
        <span class="hud-value">{{ row.value }}</span>
      </div>
    }
  `,
  styleUrl: './hud-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class HudListComponent {
  readonly rows = input<HudListRow[]>([]);
}
