import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { Preset } from '../../../controls.model';
import { IconButtonComponent } from '../../../../../shared/ui/icon-button/icon-button.component';
import { LabeledFieldComponent } from '../../../../../shared/ui/labeled-field/labeled-field.component';
import { PanelComponent } from '../../../../../shared/ui/panel/panel.component';
import { PillButtonComponent } from '../../../../../shared/ui/pill-button/pill-button.component';
import { SectionHeaderComponent } from '../../../../../shared/ui/section-header/section-header.component';
import { SelectButtonComponent } from '../../../../../shared/ui/select-button/select-button.component';

@Component({
  selector: 'app-presets-panel',
  templateUrl: './presets-panel.component.html',
  styleUrl: './presets-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IconButtonComponent,
    LabeledFieldComponent,
    PanelComponent,
    PillButtonComponent,
    SectionHeaderComponent,
    SelectButtonComponent,
  ],
})
export class PresetsPanelComponent {
  readonly presets = input<Preset[]>([]);
  readonly presetName = input('');

  readonly apply = output<Preset>();
  readonly delete = output<Preset>();
  readonly updateName = output<string>();
  readonly save = output<void>();

  onNameInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.updateName.emit(input?.value ?? '');
  }
}
