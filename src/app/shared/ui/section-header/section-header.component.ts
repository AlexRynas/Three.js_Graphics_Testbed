import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'h3[appSectionHeader]',
  template: '<ng-content></ng-content>',
  styleUrl: './section-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SectionHeaderComponent {}
