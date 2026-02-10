import { ChangeDetectionStrategy, Component, input } from '@angular/core';

type ButtonType = 'button' | 'submit' | 'reset';

@Component({
  selector: 'button[appSelectButton]',
  template: '<ng-content></ng-content>',
  styleUrl: './select-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'select-button',
    '[class.active]': 'active()',
    '[attr.type]': 'type()',
  },
})
export class SelectButtonComponent {
  readonly active = input(false);
  readonly type = input<ButtonType>('button');
}
