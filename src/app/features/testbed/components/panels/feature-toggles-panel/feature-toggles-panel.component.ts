import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { CapabilitySummary, FeatureSupport, RenderingSettings } from '../../../controls.model';
import { PanelComponent } from '../../../../../shared/ui/panel/panel.component';
import { SectionHeaderComponent } from '../../../../../shared/ui/section-header/section-header.component';

@Component({
  selector: 'app-feature-toggles-panel',
  templateUrl: './feature-toggles-panel.component.html',
  styleUrl: './feature-toggles-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PanelComponent, SectionHeaderComponent],
})
export class FeatureTogglesPanelComponent {
  readonly settings = input.required<RenderingSettings>();
  readonly capabilities = input.required<CapabilitySummary>();

  readonly features = computed<FeatureSupport[]>(() => {
    const caps = this.capabilities();
    const isWebGpu = this.settings().rendererMode === 'webgpu';

    return [
      { key: 'msaa', label: 'MSAA', supported: caps.webgl2 && !isWebGpu },
      { key: 'fxaa', label: 'FXAA', supported: !isWebGpu },
      { key: 'smaa', label: 'SMAA', supported: !isWebGpu },
      { key: 'taa', label: 'TAA', supported: !isWebGpu },
      { key: 'ssao', label: 'SSAO', supported: !isWebGpu },
      { key: 'ssr', label: 'SSR', supported: false, detail: 'WebGPU SSR pending' },
      { key: 'gi', label: 'Global Illumination', supported: false },
      { key: 'ray', label: 'Ray Tracing', supported: false },
      { key: 'path', label: 'Path Tracing', supported: false },
      { key: 'dof', label: 'Depth of Field', supported: !isWebGpu },
      { key: 'vol', label: 'Volumetric Lighting', supported: false },
      { key: 'lens', label: 'Lens Flares', supported: true },
      { key: 'vignette', label: 'Vignette', supported: true },
      { key: 'chromatic', label: 'Chromatic Aberration', supported: !isWebGpu },
      { key: 'film', label: 'Film Grain', supported: !isWebGpu },
    ];
  });
}
