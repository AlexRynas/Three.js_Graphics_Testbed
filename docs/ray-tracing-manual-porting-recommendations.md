# Manual Porting Recommendations: `erichlof/THREE.js-RayTracing-Renderer`

This note summarizes a realistic way to manually port selected ideas from
`erichlof/THREE.js-RayTracing-Renderer` into this project without attempting a
full, immediate renderer replacement.

## Goal and Scope

- Treat ray tracing as a **new optional rendering backend** for WebGL.
- Start with a constrained MVP (analytic primitives + basic materials).
- Defer full arbitrary-scene + full PBR parity to later phases.

## Recommended Porting Strategy

## 1) Create a dedicated backend layer

- Add a `raytracing` backend mode in runtime/facade services.
- Keep existing WebGL/WebGPU raster pipelines untouched.
- Use the same viewport/camera/control lifecycle as current renderer modes.

Why: isolates risk and keeps current features stable.

## 2) Port the rendering pipeline skeleton first

Port these ideas before scene-specific shading:

- Full-screen triangle pass.
- Accumulation texture (`previous frame` blending).
- Reset accumulation on camera motion / scene edits.
- Uniform set for camera matrix, aperture, focus distance, sample/frame counters.

Why: this is the core architecture that all scene/material work depends on.

## 3) Start with a minimal material model

For MVP:

- `DIFFUSE`
- `METAL`
- `TRANSPARENT` (basic refraction + Fresnel)

Defer for first milestone:

- complex clearcoat layering details,
- broader artistic controls,
- custom denoise paths.

Why: immediate visual value with manageable complexity.

## 4) Use analytic primitives first, then triangles

Phase A:

- sphere, plane/rectangle, box
- simple scene assembly and transform uniforms (inverse matrices)

Phase B:

- triangle mesh ingestion path
- BVH or equivalent acceleration data upload

Why: proves intersection + shading flow quickly, then scales to real assets.

## 5) Add one-way compatibility mapping from current settings

Map current settings to ray tracing equivalents where possible:

- exposure / tone mapping
- camera DOF parameters
- quality presets (sample count, bounce count)

Avoid promising parity for SSR/GTAO/TAA/etc in ray tracing mode.

Why: consistent UX without misleading feature parity.

## Practical Reuse Candidates from the Source Repo

- Intersection utility patterns and shape routines.
- Accumulation and sample progression logic.
- Ray/material loop structure and bounce control.
- Dynamic object transform update pattern via inverse matrices.

## Areas That Require Significant New Work

- Generic ingestion of arbitrary project scenes.
- Reliable glTF triangle pipeline with robust acceleration structure updates.
- Full PBR parity with Three.js materials and texture workflows.
- Broad feature compatibility with existing post-processing stack.
- Ongoing maintenance against Three.js version evolution.

## Suggested Implementation Phases

## Phase 0: Prototype shell (1-2 weeks)

- Add backend mode scaffolding.
- Render full-screen pass with accumulation reset behavior.

## Phase 1: MVP ray tracing (2-4 weeks)

- Analytic primitives.
- Basic materials and reflections/refractions.
- Camera controls + stable accumulation.

## Phase 2: Scene integration (3-6+ weeks)

- Triangle scene path.
- Acceleration data generation/upload.
- Asset update invalidation and rebuild policies.

## Phase 3: Material parity hardening (ongoing)

- Incremental PBR feature mapping.
- Quality/performance presets and fallback behavior.
- Cross-device validation.

## Recommended Guardrails

- Keep ray tracing mode explicitly labeled as experimental until Phase 2 is complete.
- Add hard quality caps for interactive mode (max bounces/samples).
- Provide deterministic fallback to current WebGL/WebGPU raster modes.
- Track unsupported material/feature cases in UI status messages.

## Bottom Line

Manual porting is feasible, but should be executed as a phased backend project.
Trying to jump directly to "any scene + full PBR parity" will significantly
increase implementation risk and timeline.
