import { ChangeDetectionStrategy, Component, input } from '@angular/core';

type ButtonType = 'button' | 'submit' | 'reset';

@Component({
  selector: 'button[appIconButton]',
  template: '<ng-content></ng-content>',
  styleUrl: './icon-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'icon-button',
    '[attr.type]': 'type()',
  },
})
export class IconButtonComponent {
  readonly type = input<ButtonType>('button');
}
