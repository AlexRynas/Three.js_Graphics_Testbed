import { ChangeDetectionStrategy, Component } from '@angular/core';

import { PanelComponent } from '../../../../shared/ui/panel/panel.component';

@Component({
  selector: 'app-sidebar',
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PanelComponent],
})
export class SidebarComponent {}
