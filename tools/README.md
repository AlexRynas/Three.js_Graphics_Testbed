# Tooling

## Blender

- `tools/blender/prepare_testbed_collection.py` exports a collection package beside the saved `.blend` file under `collections/<collection-name>/` and emits a manifest that matches the Angular runtime contract.
- Run it from Blender 4.5 with `blender --python tools/blender/prepare_testbed_collection.py -- [options]` or from Blender's text editor.

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
