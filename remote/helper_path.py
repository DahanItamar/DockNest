"""Tests import the BUILT helper (one file, as servers run it), never the source package remote/helper/.

Import this module before `import helper`. It puts the folder holding the built helper.py first on sys.path:
$DOCKNEST_HELPER_DIR, else a bundle/ folder next to these tests (integration hosts), else dist/remote in the
repository (written by `npm run build:helper` and by tests/remote-helper.test.js).
"""
import os, pathlib, sys

here = pathlib.Path(__file__).resolve().parent
choices = [os.environ.get('DOCKNEST_HELPER_DIR'), here / 'bundle', here.parent / 'dist' / 'remote']
folder = next((pathlib.Path(c) for c in choices if c and (pathlib.Path(c) / 'helper.py').is_file()), None)
if folder is None:
    raise SystemExit('Built helper not found. Run `npm run build:helper` first (writes dist/remote/helper.py).')
sys.path.insert(0, str(folder))
