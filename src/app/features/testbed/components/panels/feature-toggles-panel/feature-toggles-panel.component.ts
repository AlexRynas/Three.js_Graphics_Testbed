import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { FeatureSupport } from '../../../controls.model';
import { PanelComponent } from '../../../../../shared/ui/panel/panel.component';
import { SectionHeaderComponent } from '../../../../../shared/ui/section-header/section-header.component';

@Component({
  selector: 'app-feature-toggles-panel',
  templateUrl: './feature-toggles-panel.component.html',
  styleUrl: './feature-toggles-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PanelComponent, SectionHeaderComponent],
})
export class FeatureTogglesPanelComponent {
  readonly features = input<FeatureSupport[]>([]);
}
