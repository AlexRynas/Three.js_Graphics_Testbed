import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { InspectorSnapshot } from '../../../controls.model';
import { PanelComponent } from '../../../../../shared/ui/panel/panel.component';
import { SectionHeaderComponent } from '../../../../../shared/ui/section-header/section-header.component';
import { StatGridComponent, StatGridRow } from '../../../../../shared/ui/stat-grid/stat-grid.component';

@Component({
  selector: 'app-inspector-panel',
  templateUrl: './inspector-panel.component.html',
  styleUrl: './inspector-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PanelComponent, SectionHeaderComponent, StatGridComponent],
})
export class InspectorPanelComponent {
  readonly inspector = input.required<InspectorSnapshot>();

  readonly rows = computed<StatGridRow[]>(() => {
    const inspector = this.inspector();
    return [
      { key: 'meshes', label: 'Meshes', value: inspector.meshCount },
      { key: 'materials', label: 'Materials', value: inspector.materialCount },
      { key: 'textures', label: 'Textures', value: inspector.textureCount },
      { key: 'lod', label: 'LOD Nodes', value: inspector.lodCount },
      { key: 'bvh', label: 'BVH Meshes', value: inspector.bvhCount },
    ];
  });
}
