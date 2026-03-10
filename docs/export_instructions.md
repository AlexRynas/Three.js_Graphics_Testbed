# Instructions for Preparing Blender and UE Projects for Export

To standardize assets for the Three.js test project, export all collections to GLB format (binary glTF). Draco-compressed geometry and KTX2 texture payloads are supported by the current runtime, so you can use them when optimizing browser delivery. Create three variants per collection: low-res (simplified geometry, 4K textures downscaled to 1K, basic LOD), medium (original with optimizations), high-res (full detail, 8K textures if available). Host exports in the project's `public/` folder so Angular serves them directly at runtime.

## Naming conventions and repo layout

- Place the index at `public/collections-index.json`.
- Each collection: `public/collections/<collection-name>/`
  - thumbnails/  (png thumbnails)
  - export/low/, export/medium/, export/high/  (.glb outputs)
  - hdr/  (environment .exr/.hdr)
  - manifest.json
- LOD naming: `meshName_LOD0`, `meshName_LOD1`, `meshName_LOD2` (`LOD0` = highest detail).
- `manifestUrl` entries in `collections-index.json` may be absolute or relative to the index file.
- `thumbnail`, `lods`, and `environment` entries inside `manifest.json` may be absolute or relative to that manifest file.

## Blender workflow

The canonical usage guide for the Blender export script lives in [../tools/README.md](../tools/README.md). Use that document for the current Scripting workspace workflow, stage commands, and logging behavior.

1. Scene cleanup
   - Apply transforms (Ctrl+A) to all meshes (Location, Rotation, Scale).
   - Remove non-renderable helper objects and cameras.
   - Ensure correct orientation (Y forward / Z up), triangulate if preferred.
2. Materials → PBR maps
   - Convert all materials to Principled BSDF (metallic/roughness workflow).
   - Bake or ensure the following exported texture sets per material:
     - BaseColor (albedo) — sRGB
     - Normal map — non-color
     - Metallic — non-color (packed into ORM)
     - Roughness — non-color (packed into ORM)
     - Ambient Occlusion (AO) — non-color (optional, packed into ORM)
     - Emissive — sRGB (if needed)
   - Create a single ORM texture where R = Occlusion, G = Roughness, B = Metallic to reduce texture count.
3. Texture settings
   - Use power-of-two dimensions where possible.
   - Generate mipmaps (Blender exporter will not generate GPU mipmaps; ensure sizes are mip-friendly).
   - Save high-quality originals (EXR/HDR for environment maps). Export 8-bit PNG or JPEG for baseColor if size-critical; keep PNG for lossless.
4. UVs and tangents
   - Ensure each mesh has valid UV islands and no overlapping when needed.
   - Enable tangents in export (so normal maps work correctly).
5. LODs
   - Create LOD objects named with the LOD suffix in the same .blend file.
   - Low-res: Apply Decimate modifier (ratio 0.5) to meshes, downscale textures to 1K in Image Editor, bake simple LOD (2 levels).
   - Medium: Keep original geometry, compress textures to 2K-4K, add LOD (3 levels).
   - High-res: Retain full detail, use original textures (PNG for diffuse/normal, EXR for HDR env maps).
6. Bake pass instructions (if procedural or complex materials)
   - Bake each map at desired resolution (2048/4096 as needed).
   - For ORM packing: bake AO to R, Roughness to G, Metallic to B and combine into one image.
7. Export glTF (.glb)
   - File → Export → glTF 2.0:
     - Format: Binary (.glb)
     - Include: Selected Objects or Scene as appropriate
     - Geometry: Apply Modifiers, UVs, Materials
     - Animation: export only if needed
     - Images: Copy
     - Export tangents: enabled
     - Compression: enable Draco
   - For high/medium/low exports: export as separate .glb files.
8. Postprocess (local tools)
   - Texture compression to KTX2 (Basis Universal)
     - Use `toktx` or `basisu` tools to transcode PNG/JPEG to KTX2 with BasisU.
     - Run KTX2 conversion and update the glTF to reference KTX2 images (tools exist to replace images or use gltfpack with KTX2 support).

## Unreal Engine workflow

1. TODO

## Manifest and metadata

- Create `manifest.json` per collection with these fields: `name`, `displayName`, `thumbnail`, `initialCameraPosition`, `initialControlTarget`, `lods`, and optional `environment`.
- Keep `lods` ordered from highest to lowest detail so `lods[0]` is the nearest, highest-detail asset.
- The canonical example manifest lives in `README.md`.
