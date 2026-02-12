# Graphics Testbed Overview

This Angular + Three.js testbed showcases configurable render pipelines (WebGL and WebGPU), post-processing, LOD asset loading, and benchmarking tools for repeatable performance capture.

## Key Features

- Dual renderer modes: WebGL and WebGPU (runtime switch with scene reload)
- lil-gui control panel for renderer, post, and scene settings
- Progressive LOD loading for GLB collections
- Capability detection (WebGPU, MSAA, compressed texture formats)
- Stats overlay plus JSON benchmark export

## Local Asset Layout

Provide your own assets in `src/assets/collections` and a manifest index at `src/assets/collections-index.json` (not created by this repo):

```json
[
	{
		"id": "the_shed",
		"displayName": "The Shed",
		"manifestUrl": "/assets/collections/the_shed/manifest.json"
	}
]
```

Example manifest structure:

```json
{
	"name": "the_shed",
	"displayName": "The Shed",
	"thumbnail": "thumbnails/the_shed.png",
	"lods": [
		"export/high/the_shed_LOD0.glb",
		"export/medium/the_shed_LOD1.glb",
		"export/low/the_shed_LOD2.glb"
	],
	"environment": "hdr/the_shed.hdr"
}
```

If no collections index is available, the app falls back to a procedural demo scene.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## WebGPU Enablement

WebGPU requires an enabled browser flag. In Chromium-based browsers, visit `chrome://flags` and enable:

- `Unsafe WebGPU`

Restart the browser to apply changes.

## Benchmark Output

Use the "Run benchmark" button to replay the camera path. The "Export metrics" action saves a JSON report with:

- Average FPS
- Minimum FPS
- Max frame time
- Draw calls and triangles
- Memory usage
