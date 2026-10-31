"""Source of the DockNest remote helper. Not importable on its own.

The modules here are joined into ONE file, helper.py, by src/helper-bundle.js (one namespace, exactly like the
original single file). Run `npm run build:helper` to write it to dist/remote/helper.py. See docs/remote-helper.md.
"""
raise ImportError('remote/helper is the helper source package; import the built dist/remote/helper.py '
                  '(npm run build:helper) instead')
