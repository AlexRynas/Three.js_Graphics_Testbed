import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import {
  AntiAliasingMode,
  CapabilitySummary,
  QualityLevel,
  RenderingControlKey,
  RendererMode,
  RenderingSettings,
  RenderingSupport,
  SceneSettings,
  ShadowType,
  TextureFiltering,
} from '../../controls.model';
import { LabeledFieldComponent } from '../../../../shared/ui/labeled-field/labeled-field.component';
import { PanelComponent } from '../../../../shared/ui/panel/panel.component';
import { SectionHeaderComponent } from '../../../../shared/ui/section-header/section-header.component';

export type RenderingSettingUpdate = {
  key: keyof RenderingSettings;
  value: RenderingSettings[keyof RenderingSettings];
};

export type SceneSettingUpdate = {
  key: keyof SceneSettings;
  value: SceneSettings[keyof SceneSettings];
};

@Component({
  selector: 'app-settings-dock',
  templateUrl: './settings-dock.component.html',
  styleUrl: './settings-dock.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LabeledFieldComponent, PanelComponent, SectionHeaderComponent],
  host: {
    class: 'settings-dock-host',
    '[class.hidden]': '!visible()',
    '[attr.aria-hidden]': '!visible()',
  },
})
export class SettingsDockComponent {
  readonly visible = input(true);
  readonly settings = input.required<RenderingSettings>();
  readonly sceneSettings = input.required<SceneSettings>();
  readonly capabilities = input.required<CapabilitySummary>();
  readonly renderingSupport = input.required<RenderingSupport>();

  readonly renderingUpdated = output<RenderingSettingUpdate>();
  readonly sceneUpdated = output<SceneSettingUpdate>();

  protected readonly rendererModes: RendererMode[] = ['webgl', 'webgpu'];
  protected readonly antialiasingModes: AntiAliasingMode[] = ['none', 'msaa', 'fxaa', 'smaa', 'taa'];
  protected readonly qualityLevels: QualityLevel[] = ['low', 'medium', 'high'];
  protected readonly textureModes: TextureFiltering[] = ['linear', 'trilinear', 'anisotropic'];
  protected readonly shadowTypes: ShadowType[] = ['basic', 'pcf', 'pcfSoft', 'vsm'];
  protected readonly toneMappingModes: Array<SceneSettings['toneMapping']> = ['none', 'linear', 'reinhard', 'cineon', 'aces', 'neutral'];
  protected readonly showSmaaQuality = computed(() => this.settings().antialiasing === 'smaa');
  protected readonly showTaaSamples = computed(() => this.settings().antialiasing === 'taa');
  protected readonly showGtaoChildren = computed(() => this.settings().gtaoEnabled);
  protected readonly showDofChildren = computed(() => this.settings().depthOfField);
  protected readonly showAnisotropy = computed(() => this.settings().textureFiltering === 'anisotropic');

  updateRendererMode(value: string): void {
    if (!this.rendererModes.includes(value as RendererMode)) {
      return;
    }

    this.emitRendering('rendererMode', value as RendererMode);
  }

  updateAntialiasing(value: string): void {
    if (!this.antialiasingModes.includes(value as AntiAliasingMode)) {
      return;
    }

    this.emitRendering('antialiasing', value as AntiAliasingMode);
  }

  updateSmaaQuality(value: string): void {
    if (!this.qualityLevels.includes(value as QualityLevel)) {
      return;
    }

    this.emitRendering('smaaQuality', value as QualityLevel);
  }

  updateGtaoQuality(value: string): void {
    if (!this.qualityLevels.includes(value as QualityLevel)) {
      return;
    }

    this.emitRendering('gtaoQuality', value as QualityLevel);
  }

  updateTextureFiltering(value: string): void {
    if (!this.textureModes.includes(value as TextureFiltering)) {
      return;
    }

    this.emitRendering('textureFiltering', value as TextureFiltering);
  }

  updateShadowType(value: string): void {
    if (!this.shadowTypes.includes(value as ShadowType)) {
      return;
    }

    this.emitRendering('shadowType', value as ShadowType);
  }

  updateToneMapping(value: string): void {
    if (!this.toneMappingModes.includes(value as SceneSettings['toneMapping'])) {
      return;
    }

    this.emitScene('toneMapping', value as SceneSettings['toneMapping']);
  }

  updateRenderingNumber(
    key:
      | 'taaSamples'
      | 'gtaoRadius'
      | 'anisotropy'
      | 'dofFocus'
      | 'dofAperture'
      | 'dofMaxBlur',
    value: number,
  ): void {
    this.emitRendering(key, value);
  }

  updateSceneNumber(key: 'environmentIntensity' | 'exposure' | 'lodBias', value: number): void {
    this.emitScene(key, value);
  }

  updateRenderingBoolean(
    key:
      | 'gtaoEnabled'
      | 'ssrEnabled'
      | 'depthOfField'
      | 'vignette'
      | 'filmGrain'
      | 'lensFlares'
      | 'contactShadows',
    checked: boolean,
  ): void {
    this.emitRendering(key, checked);
  }

  updateSceneBoolean(key: 'environmentMapEnabled' | 'autoRotate' | 'bvhEnabled', checked: boolean): void {
    this.emitScene(key, checked);
  }

  private emitRendering<K extends keyof RenderingSettings>(key: K, value: RenderingSettings[K]): void {
    this.renderingUpdated.emit({ key, value });
  }

  private emitScene<K extends keyof SceneSettings>(key: K, value: SceneSettings[K]): void {
    this.sceneUpdated.emit({ key, value });
  }

  protected isAntialiasingSupported(mode: AntiAliasingMode): boolean {
    return this.renderingSupport().antialiasingModes[mode];
  }

  protected isControlSupported(key: RenderingControlKey): boolean {
    return this.renderingSupport().controls[key];
  }

  protected getControlHint(key: RenderingControlKey): string | null {
    return this.renderingSupport().controlHints[key] ?? null;
  }
}