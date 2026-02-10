# ThreeJsGraphicsTestbedFrontend

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.1.3.

## Graphics Testbed Overview

This Angular + Three.js testbed showcases configurable render pipelines (WebGL and WebGPU), post-processing, LOD asset loading, and benchmarking tools for repeatable performance capture.

### Key Features

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

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
