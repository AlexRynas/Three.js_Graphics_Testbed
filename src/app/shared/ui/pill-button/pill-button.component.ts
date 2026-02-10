import { ChangeDetectionStrategy, Component, input } from '@angular/core';

type ButtonType = 'button' | 'submit' | 'reset';
type PillVariant = 'solid' | 'ghost';

@Component({
  selector: 'button[appPillButton]',
  template: '<ng-content></ng-content>',
  styleUrl: './pill-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pill',
    '[class.ghost]': "variant() === 'ghost'",
    '[attr.type]': 'type()',
  },
})
export class PillButtonComponent {
  readonly variant = input<PillVariant>('solid');
  readonly type = input<ButtonType>('button');
}
