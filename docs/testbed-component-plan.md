# Testbed Component Decomposition Plan

## Structure

### Feature Components (Testbed)
- TestbedTopbar — brand/title + action buttons; inputs: status, canBenchmark; outputs: runBenchmark, exportMetrics, toggleGui
- TestbedViewport — canvas container and overlay slots; inputs: rendererLabel, metrics, status, benchmark
- TestbedHud — the metrics overlay panel; inputs: rendererLabel, metrics
- TestbedStatusBar — status + benchmark progress chip; inputs: status, benchmark
- TestbedSidebar — wrapper for right-side panel sections; projected content or composed children
- CollectionsPanel — list of collections with selection; inputs: collections, activeId; outputs: select
- PresetsPanel — preset list + save UI; inputs: presets, presetName; outputs: apply, delete, updateName, save
- CapabilitiesPanel — capability grid; inputs: capabilityRows
- InspectorPanel — mesh/material/texture stats; inputs: inspector
- FeatureTogglesPanel — feature support list + hint; inputs: featureRows
- GuiDock — lil-gui host container; input: visible

### Shared UI Components
- Panel — glass card with header and content (used by sidebar sections)
- SectionHeader — uppercase label styling for panel headings
- PillButton — gradient pill, with variant="solid|ghost" and disabled state
- SelectButton — selectable list button with active state
- IconButton — small icon-only action (used for preset delete)
- LabeledField — label + input wrapper
- StatGrid — small two-column key/value grid (capabilities/inspector)
- HudList — compact label/value list with consistent spacing and typography

## Iterations

### Iteration 1: Layout Shell
- Create TestbedTopbar, TestbedViewport, TestbedSidebar, GuiDock
- Wire inputs/outputs and move template sections
- Move top-level layout styles
- Clean up unused layout styles and verify bindings in touched areas

### Iteration 2: Panels
- Create CollectionsPanel and PresetsPanel
- Create CapabilitiesPanel and InspectorPanel
- Create FeatureTogglesPanel
- Move panel-specific styles
- Clean up unused panel styles and verify bindings in touched areas

### Iteration 3: HUD
- Create TestbedHud and TestbedStatusBar
- Hook up metrics and status bindings
- Move HUD-related styles
- Clean up unused HUD styles and verify bindings in touched areas

### Iteration 4: Shared UI
- Extract Panel, SectionHeader, and button components
- Extract LabeledField, StatGrid, HudList
- Replace local markup with shared components
- Clean up unused shared styles and verify bindings in touched areas
