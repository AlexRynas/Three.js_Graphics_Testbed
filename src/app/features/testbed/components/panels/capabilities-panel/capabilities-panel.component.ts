import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { CapabilitySummary } from '../../../controls.model';
import { PanelComponent } from '../../../../../shared/ui/panel/panel.component';
import { SectionHeaderComponent } from '../../../../../shared/ui/section-header/section-header.component';
import { StatGridComponent, StatGridRow } from '../../../../../shared/ui/stat-grid/stat-grid.component';

@Component({
  selector: 'app-capabilities-panel',
  templateUrl: './capabilities-panel.component.html',
  styleUrl: './capabilities-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PanelComponent, SectionHeaderComponent, StatGridComponent],
})
export class CapabilitiesPanelComponent {
  readonly capabilities = input.required<CapabilitySummary>();

  readonly rows = computed<StatGridRow[]>(() => {
    const caps = this.capabilities();
    return [
      { key: 'webgpu', label: 'WebGPU', value: caps.webgpu ? 'Available' : 'Unavailable' },
      { key: 'webgl2', label: 'WebGL2', value: caps.webgl2 ? 'Yes' : 'No' },
      { key: 'maxTextureSize', label: 'Max Texture', value: `${caps.maxTextureSize}px` },
      { key: 'maxAnisotropy', label: 'Max Anisotropy', value: `${caps.maxAnisotropy}x` },
      { key: 'msaa', label: 'MSAA Samples', value: `${caps.msaaSamples}` },
      { key: 'shaderPrecision', label: 'Shader Precision', value: caps.shaderPrecision },
      {
        key: 'compressed',
        label: 'Compressed Tex',
        value: caps.compressedTextures.length > 0 ? caps.compressedTextures.join(', ') : 'None',
      },
      { key: 'gpuTimer', label: 'GPU Timer', value: caps.gpuTimerQuery ? 'Yes' : 'No' },
    ];
  });
}
