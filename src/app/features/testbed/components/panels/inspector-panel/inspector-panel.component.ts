import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { PanelComponent } from '../../../../../shared/ui/panel/panel.component';
import { SectionHeaderComponent } from '../../../../../shared/ui/section-header/section-header.component';
import { StatGridComponent, StatGridRow } from '../../../../../shared/ui/stat-grid/stat-grid.component';

@Component({
  selector: 'app-inspector-panel',
  templateUrl: './inspector-panel.component.html',
  styleUrl: './inspector-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PanelComponent, SectionHeaderComponent, StatGridComponent],
})
export class InspectorPanelComponent {
  readonly rows = input<StatGridRow[]>([]);
}
