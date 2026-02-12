import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { PanelComponent } from '../../../../../shared/ui/panel/panel.component';
import { SectionHeaderComponent } from '../../../../../shared/ui/section-header/section-header.component';
import { SelectButtonComponent } from '../../../../../shared/ui/select-button/select-button.component';

type CollectionItem = {
  id: string;
  displayName: string;
};

@Component({
  selector: 'app-collections-panel',
  templateUrl: './collections-panel.component.html',
  styleUrl: './collections-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PanelComponent, SectionHeaderComponent, SelectButtonComponent],
})
export class CollectionsPanelComponent {
  readonly collections = input<CollectionItem[]>([]);
  readonly activeId = input('');

  readonly select = output<string>();
}
