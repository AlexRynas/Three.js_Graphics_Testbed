import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import {
  CapabilitySummary,
  FeatureSupport,
  RenderingSettings,
  RenderingSupport,
} from '../../../controls.model';
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
  readonly renderingSupport = input.required<RenderingSupport>();

  readonly features = computed<FeatureSupport[]>(() => {
    const caps = this.capabilities();
    const support = this.renderingSupport();

    return [
      { key: 'msaa', label: 'MSAA', supported: caps.webgl2 && support.antialiasingModes.msaa },
      { key: 'fxaa', label: 'FXAA', supported: support.antialiasingModes.fxaa },
      { key: 'smaa', label: 'SMAA', supported: support.antialiasingModes.smaa },
      { key: 'taa', label: 'TAA', supported: support.antialiasingModes.taa },
      { key: 'ssao', label: 'SSAO', supported: support.controls.ssaoEnabled },
      { key: 'ssr', label: 'SSR', supported: support.controls.ssrEnabled },
      { key: 'gi', label: 'Global Illumination', supported: false },
      { key: 'ray', label: 'Ray Tracing', supported: false },
      { key: 'path', label: 'Path Tracing', supported: false },
      { key: 'dof', label: 'Depth of Field', supported: support.controls.depthOfField },
      { key: 'vol', label: 'Volumetric Lighting', supported: false },
      { key: 'lens', label: 'Lens Flares', supported: support.controls.lensFlares },
      { key: 'vignette', label: 'Vignette', supported: support.controls.vignette },
      { key: 'film', label: 'Film Grain', supported: support.controls.filmGrain },
    ];
  });
}
