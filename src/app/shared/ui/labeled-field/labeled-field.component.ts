import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'label[appLabeledField]',
  template: '<span class="field-label">{{ label() }}</span><ng-content></ng-content>',
  styleUrl: './labeled-field.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LabeledFieldComponent {
  readonly label = input('');
}
