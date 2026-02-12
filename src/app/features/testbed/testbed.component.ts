import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  Preset,
  RenderingSettings,
  SceneSettings,
} from './controls.model';
import { CapabilitiesPanelComponent } from './components/panels/capabilities-panel/capabilities-panel.component';
import { CollectionsPanelComponent } from './components/panels/collections-panel/collections-panel.component';
import { FeatureTogglesPanelComponent } from './components/panels/feature-toggles-panel/feature-toggles-panel.component';
import { InspectorPanelComponent } from './components/panels/inspector-panel/inspector-panel.component';
import { PresetsPanelComponent } from './components/panels/presets-panel/presets-panel.component';
import { HudComponent } from './components/hud/hud.component';
import { SettingsDockComponent } from './components/settings-dock/settings-dock.component';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { StatusBarComponent } from './components/status-bar/status-bar.component';
import { TopbarComponent } from './components/topbar/topbar.component';
import { ViewportComponent } from './components/viewport/viewport.component';
import { TestbedFacade } from './testbed.facade';

@Component({
  selector: 'app-testbed',
  templateUrl: './testbed.component.html',
  styleUrl: './testbed.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    CapabilitiesPanelComponent,
    CollectionsPanelComponent,
    FeatureTogglesPanelComponent,
    InspectorPanelComponent,
    PresetsPanelComponent,
    HudComponent,
    SettingsDockComponent,
    SidebarComponent,
    StatusBarComponent,
    TopbarComponent,
    ViewportComponent,
  ],
  host: {
    class: 'testbed-host',
  },
  providers: [TestbedFacade],
})
export class TestbedComponent implements AfterViewInit {
  readonly viewportShell = viewChild.required(ViewportComponent);

  private readonly facade = inject(TestbedFacade);
  private readonly destroyRef = inject(DestroyRef);

  readonly status = this.facade.status;
  readonly rendererLabel = this.facade.rendererLabel;
  readonly guiVisible = this.facade.guiVisible;
  readonly settings = this.facade.settings;
  readonly sceneSettings = this.facade.sceneSettings;
  readonly collections = this.facade.collections;
  readonly activeCollectionId = this.facade.activeCollectionId;
  readonly inspector = this.facade.inspector;
  readonly presetName = this.facade.presetName;
  readonly metrics = this.facade.metrics;
  readonly benchmark = this.facade.benchmark;
  readonly capabilitySummary = this.facade.capabilitySummary;
  readonly renderingSupport = this.facade.renderingSupport;
  readonly presets = this.facade.presets;

  async ngAfterViewInit(): Promise<void> {
    await this.facade.afterViewInit(this.viewportShell(), this.destroyRef);
  }

  toggleGui(): void {
    this.facade.toggleGui();
  }

  async selectCollection(id: string): Promise<void> {
    await this.facade.selectCollection(id);
  }

  applyPreset(preset: Preset): void {
    this.facade.applyPreset(preset);
  }

  deletePreset(preset: Preset): void {
    this.facade.deletePreset(preset);
  }

  updatePresetName(name: string): void {
    this.facade.updatePresetName(name);
  }

  savePreset(): void {
    this.facade.savePreset();
  }

  updateRenderingSetting(event: {
    key: keyof RenderingSettings;
    value: RenderingSettings[keyof RenderingSettings];
  }): void {
    this.facade.updateRenderingSetting(event.key, event.value);
  }

  updateSceneSetting(event: {
    key: keyof SceneSettings;
    value: SceneSettings[keyof SceneSettings];
  }): void {
    this.facade.updateSceneSetting(event.key, event.value);
  }

  async runBenchmark(): Promise<void> {
    await this.facade.runBenchmark();
  }

  exportMetrics(): void {
    this.facade.exportMetrics();
  }
}
