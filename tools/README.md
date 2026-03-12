# Tooling

## Blender

- `tools/blender/prepare_testbed_collection.py` exports a collection package beside the saved `.blend` file under `collections/<collection-name>/` and emits a manifest that matches the Angular runtime contract.
- Use it from Blender 4.5 inside the Scripting workspace. Run the script once from the Text Editor so it registers export helpers for the Python Console.
- The script exposes explicit execution stages so you can isolate validation, analysis, bake setup, each GLB export, and final packaging into smaller console runs.

### Scripting tab workflow

- Open Blender's Scripting workspace, load `tools/blender/prepare_testbed_collection.py` in the Text Editor, and click Run Script.
- After that, use Blender's Python Interactive Console with `list_testbed_export_stages()` to print the available stages.
- Run a single stage with `run_testbed_export_stage('inspect')`.
- Run a smaller custom sequence with `run_testbed_export_stages('inspect', 'analyze', 'export-high')`.
- The same helpers are also available under `testbed_export`, for example `testbed_export.run_stage('package')`.
- The helpers no longer echo the full result object back into the Python console. The last result is stored at `testbed_export.last_result` and can also be read with `get_last_testbed_export_result()`.
- Every run now writes a detailed log file. If you do not provide `log_path_override`, the script creates one automatically under the blend file folder in `export-logs/`.
- Pass `log_path_override='F:/tmp/testbed-inspect.log'` when you want to control exactly where the detailed log is saved.
- The console intentionally shows only stage-level summaries. Detailed warnings, info messages, index snippets, and tracebacks are written to the log file.
- The available stages are `inspect`, `analyze`, `bake`, `export-high`, `export-medium`, `export-low`, and `package`.
- The `inspect` stage resolves the collection, validates scene prerequisites, creates the output layout, and derives manifest camera metadata.
- The `analyze` stage inspects materials, textures, LOD bundles, and Auto Bake 2 availability without exporting assets.
- The `bake` stage runs Auto Bake 2 when needed, enables Final Material, Remove Nodes, Final Object, and Reuse Elements, then completes the session through Auto Bake 2's Confirm flow with Swap Object enabled.
- The three `export-*` stages each write a single GLB variant.
- The `package` stage renders the thumbnail, copies the HDR environment, writes `manifest.json`, writes the text report, and prints the `collections-index.json` snippet.
- Later stages still recompute the in-memory scene context they depend on, but they avoid running unrelated export steps and print a per-stage warning/error summary.
- Optional keyword arguments can be passed from the Python Console, for example `run_testbed_export_stage('bake', bake_behavior='manual')` or `run_testbed_export_stages('inspect', 'analyze', collection_name_override='MyCollection')`.
- Blender's Python console does not expose a reliable no-truncation setting for very large output. On Windows, the System Console buffer can be increased, but a log file is the more dependable path for full capture.

### Typical console usage

```python
run_testbed_export_stage('inspect')
run_testbed_export_stage('analyze')
run_testbed_export_stage('bake')
run_testbed_export_stages('export-high', 'export-medium', 'export-low')
run_testbed_export_stage('package')
```

- After each command, the console prints the path to the detailed log file.
- If you need the structured result object, call `get_last_testbed_export_result()` or inspect `testbed_export.last_result`.
- If you explicitly want the helper to return the result object in the console, pass `echo_result=True`.

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
