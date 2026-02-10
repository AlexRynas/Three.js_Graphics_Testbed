import { ChangeDetectionStrategy, Component, ElementRef, inject, input } from '@angular/core';

@Component({
  selector: 'div[appGuiDock]',
  template: '<ng-content></ng-content>',
  styleUrl: './gui-dock.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'gui-dock',
    '[class.hidden]': '!visible()',
  },
})
export class GuiDockComponent {
  readonly host = inject(ElementRef<HTMLDivElement>);
  readonly visible = input(true);

  get element(): HTMLDivElement {
    return this.host.nativeElement;
  }
}
