import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'aside[appPanel]',
  template: '<ng-content></ng-content>',
  styleUrl: './panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PanelComponent {}
