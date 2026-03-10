# Instructions for Preparing Blender and UE Projects for Export

To standardize assets for the Three.js test project, export all collections to GLB format (binary GLTF) with Draco compression for optimized loading in the browser. This preserves PBR materials, textures, and geometry while reducing file sizes. Create three variants per collection: low-res (simplified geometry, 4K textures downscaled to 1K, basic LOD), medium (original with optimizations), high-res (full detail, 8K textures if available). Host exports locally in the project's `src/assets` folder for fast, async loading via Three.js GLTFLoader. Use tools like gltfpack or Blender's built-in optimizer post-export to minify.

## Naming conventions and repo layout

- Each collection: /collections/<collection-name>/
  - thumbnails/  (png thumbnails)
  - export/low/, export/medium/, export/high/  (.glb outputs)
  - hdr/  (environment .exr/.hdr)
  - manifest.json
- LOD naming: <meshName>_LOD0, <meshName>_LOD1, <meshName>_LOD2 (LOD0 = highest detail).

## Blender workflow

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

- Create manifest.json per collection with fields:
{
  "name": "the_shed",
  "displayName": "The Shed",
  "thumbnail": "thumbnails/the_shed.png",
  "lods":["export/high/the_shed_LOD0.glb","export/medium/the_shed_LOD1.glb"],
}