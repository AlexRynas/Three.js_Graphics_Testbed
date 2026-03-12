# Tooling

## Blender

- `tools/blender/prepare_testbed_collection.py` exports a collection package beside the saved `.blend` file under `collections/<collection-name>/` and emits a manifest that matches the Angular runtime contract.
- Use it from Blender 4.5 inside the Scripting workspace. Run the script once from the Text Editor so it registers export helpers for the Python Console.
- The script exposes explicit execution stages so you can isolate validation and analysis, automatic scene repair, bake setup, each GLB export, and final packaging into smaller console runs.

### Scripting tab workflow

- Open Blender's Scripting workspace, load `tools/blender/prepare_testbed_collection.py` in the Text Editor, and click Run Script.
- After that, use Blender's Python Interactive Console with `list_testbed_export_stages()` to print the available stages.
- Run a single stage with `run_testbed_export_stage('inspect')`.
- Run the automatic warning repair stage with `run_testbed_export_stage('repair')`.
- Run a smaller custom sequence with `run_testbed_export_stages('inspect', 'repair', 'export-high')`.
- The same helpers are also available under `testbed_export`, for example `testbed_export.run_stage('package')`.
- The helpers no longer echo the full result object back into the Python console. The last result is stored at `testbed_export.last_result` and can also be read with `get_last_testbed_export_result()`.
- Every run now writes a detailed log file. If you do not provide `log_path_override`, the script creates one automatically under the blend file folder in `export-logs/`.
- Pass `log_path_override='F:/tmp/testbed-inspect.log'` when you want to control exactly where the detailed log is saved.
- The console intentionally shows only stage-level summaries. Detailed warnings, info messages, index snippets, and tracebacks are written to the log file.
- The available stages are `inspect`, `repair`, `bake`, `export-high`, `export-medium`, `export-low`, and `package`.
- The `inspect` stage resolves the collection, validates scene prerequisites, creates the output layout, derives manifest camera metadata, and inspects materials, textures, LOD bundles, and Auto Bake 2 availability.
- The `inspect` stage also reports how many scene objects are eligible for processing versus excluded because they are hidden in the viewport, disabled for rendering, or both.
- The `repair` stage automatically fixes the warnings surfaced by `inspect` by making linked assets local when possible, applying scale, generating UV maps, assigning default materials, and enabling World nodes.
- The `bake` stage runs Auto Bake 2 when needed, enables Final Material, Remove Nodes, Final Object, and Reuse Elements, completes the session through Auto Bake 2's Confirm flow with Swap Object enabled, and then saves any dirty baked images to disk automatically.
- The three `export-*` stages each write a single GLB variant.
- The `package` stage renders the thumbnail, copies the HDR environment, writes `manifest.json`, writes the text report, and prints the `collections-index.json` snippet.
- The `repair`, `bake`, `export-*`, and `package` stages ignore any object that is hidden in the viewport, disabled for rendering, or both.
- Stages are isolated. Running `export-*`, `bake`, or `package` no longer emits separate `inspect` or `repair` stage headers automatically.
- When a stage needs scene context internally, it recomputes only the minimum state it needs without treating other stages as prerequisites.
- Optional keyword arguments can be passed from the Python Console, for example `run_testbed_export_stage('bake', bake_behavior='manual')` or `run_testbed_export_stages('inspect', 'repair', collection_name_override='MyCollection')`.
- Blender's Python console does not expose a reliable no-truncation setting for very large output. On Windows, the System Console buffer can be increased, but a log file is the more dependable path for full capture.

### Typical console usage

```python
run_testbed_export_stage('inspect')
run_testbed_export_stage('repair')
run_testbed_export_stage('bake')
run_testbed_export_stages('export-high', 'export-medium', 'export-low')
run_testbed_export_stage('package')
```

- After each command, the console prints the path to the detailed log file.
- After the `bake` stage finishes, the script saves newly baked dirty images immediately so later `export-*` stages can reuse them without requiring Blender's close-window image save prompt.
- If you need the structured result object, call `get_last_testbed_export_result()` or inspect `testbed_export.last_result`.
- If you explicitly want the helper to return the result object in the console, pass `echo_result=True`.
- If you want validation, material diagnostics, and automatic warning repair in the log, run `inspect` and `repair` explicitly before `bake`, `export-*`, or `package`.
- When `export-medium` or `export-low` has to generate a missing LOD, the script now skips DECIMATE when the seed mesh is already sparse or when the requested result would collapse below a safe polygon floor. Those decisions are written to the detailed log.
- Generated LODs also avoid cascading DECIMATE from authored `*_LOD1` or `*_LOD2` meshes. If you want exact medium and low results, keep authoring explicit `*_LOD0`, `*_LOD1`, and `*_LOD2` objects in Blender.
- During `export-*`, Blender may log temporary mesh datablock names such as `TESTBED_BackWall_Mesh.002` even if the scene object currently shows `.001` in the UI. This is expected: the exporter duplicates meshes into a temporary collection before writing the GLB, and Blender auto-increments datablock suffixes for those transient export copies.
- The remaining Blender glTF warning `More than one shader node tex image used for a texture` is also expected for the baked test scene. The baked materials use one packed Channel Packing texture that feeds both Roughness and Metallic through a `Separate Color` node, and Blender's exporter emits this warning while gathering those sockets for a single metallic-roughness texture. In this workflow, that warning is harmless and does not mean the wrong mesh or wrong textures were exported.
- Optional decimation safeguards can be tuned from the Python Console with `min_decimate_seed_polygons` and `min_decimate_target_polygons` in addition to `medium_decimate_ratio` and `low_decimate_ratio`.

### Compile check with Blender's Python

Use Blender's actual executable for compile checks so the script is validated against Blender's bundled Python runtime instead of the system Python.

```powershell
& "C:\Program Files\Blender Foundation\Blender 4.5\blender.exe" `
  --background `
  --factory-startup `
  --python-expr "import py_compile; py_compile.compile(r'D:\Projects\Three.js_Graphics_Testbed\tools\blender\prepare_testbed_collection.py', doraise=True); print('BLENDER_PY_COMPILE_OK')"
```

- Prefer `blender.exe` over `blender-launcher.exe` for scripted validation because the launcher may not surface stdout reliably.
- `--background` avoids opening the UI.
- `--factory-startup` reduces noise from user startup files or add-ons.
- `py_compile.compile(..., doraise=True)` fails on syntax and compile-time errors.

### Additional Resources

- [Blender Resources](blender/Blender_Resources.md)
