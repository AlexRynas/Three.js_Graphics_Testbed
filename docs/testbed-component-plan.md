# Testbed Component Decomposition Plan

## Structure

### Feature Components (Testbed)
- Topbar — brand/title + action buttons; inputs: status, canBenchmark; outputs: runBenchmark, exportMetrics, toggleGui
	- Template mapping: header.topbar, .brand, .top-actions
	- Uses: PillButton (Run benchmark, Export metrics, Toggle GUI)
- Viewport — canvas container + overlays; inputs: rendererLabel, metrics, status, benchmark
	- Template mapping: .viewport with canvas, hud, status-bar
	- Uses: Hud, StatusBar
- Hud — metrics overlay panel; inputs: rendererLabel, metrics
	- Template mapping: .hud with repeated .hud-row items
	- Uses: HudList (or repeated HudListRow), handles GPU n/a fallback
- StatusBar — status text + benchmark progress chip; inputs: status, benchmark
	- Template mapping: .status-bar with optional .status-chip
	- Uses: PillButton or compact chip styling (if shared chip is added later)
- Sidebar — wrapper for right-side panel sections; projected content or composed children
	- Template mapping: aside.panel with multiple section blocks
	- Uses: Panel, SectionHeader for each section title
- CollectionsPanel — list of collections with selection; inputs: collections, activeId; outputs: select
	- Template mapping: Collections section with .button-grid
	- Uses: Panel, SectionHeader, SelectButton
- PresetsPanel — preset list + save UI; inputs: presets, presetName; outputs: apply, delete, updateName, save
	- Template mapping: Presets section with .preset-list, .preset-row, field, and save button
	- Uses: Panel, SectionHeader, SelectButton, IconButton, LabeledField, PillButton
- CapabilitiesPanel — capability grid; inputs: capabilityRows
	- Template mapping: Capabilities section with .cap-grid
	- Uses: Panel, SectionHeader, StatGrid
- InspectorPanel — mesh/material/texture stats; inputs: inspector
	- Template mapping: Scene Inspector section with .inspector-grid
	- Uses: Panel, SectionHeader, StatGrid
- FeatureTogglesPanel — feature support list + hint; inputs: featureRows
	- Template mapping: Feature Toggles section with .feature-list, hint text
	- Uses: Panel, SectionHeader, HudList (or simple list styling)
- GuiDock — lil-gui host container; input: visible
	- Template mapping: .gui-dock host element

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

### Iteration 1: Shared UI Foundation
- Extract Panel, SectionHeader, PillButton, SelectButton, IconButton
- Extract LabeledField, StatGrid, HudList
- Establish base styles and tokens for shared UI
- Verify bindings for shared component inputs/outputs where applicable
- Check for any errors related to the changes and fix them if any.

### Iteration 2: Layout Shell
- Create Topbar, Viewport, Sidebar, GuiDock
- Wire inputs/outputs and move template sections
- Replace raw buttons/headers with shared UI components
- Move top-level layout styles
- Clean up unused layout styles and verify bindings in touched areas
- Check for any errors related to the changes and fix them if any.

### Iteration 3: Panels
- Create CollectionsPanel and PresetsPanel
- Create CapabilitiesPanel and InspectorPanel
- Create FeatureTogglesPanel
- Compose panels using Panel + SectionHeader and shared list/field controls
- Move panel-specific styles
- Clean up unused panel styles and verify bindings in touched areas
- Check for any errors related to the changes and fix them if any.

### Iteration 4: HUD
- Create Hud and StatusBar
- Hook up metrics and status bindings
- Use HudList for consistent label/value rows
- Move HUD-related styles
- Clean up unused HUD styles and verify bindings in touched areas
- Check for any errors related to the changes and fix them if any.
