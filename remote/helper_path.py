"""Tests import the BUILT helper (one file, as servers run it), never the source package remote/helper/.

Import this module before `import helper`. It puts the folder holding the built helper.py first on sys.path:
$DOCKNEST_HELPER_DIR, else build/remote in the repository (written by `npm run build:helper` and by
tests/remote-helper.test.js), else a bundle/ folder next to these tests (integration hosts). In the repository, a
built helper older than its source is refused, so a hand-run test never checks yesterday's code.
"""
import os, pathlib, sys

here = pathlib.Path(__file__).resolve().parent
choices = [os.environ.get('DOCKNEST_HELPER_DIR'), here.parent / 'build' / 'remote', here / 'bundle']
folder = next((pathlib.Path(c) for c in choices if c and (pathlib.Path(c) / 'helper.py').is_file()), None)
if folder is None:
    raise SystemExit('Built helper not found. Run `npm run build:helper` first (writes build/remote/helper.py).')
sources = list((here / 'helper').glob('*.py')) if folder == here.parent / 'build' / 'remote' else []
if sources and max(p.stat().st_mtime for p in sources) > (folder / 'helper.py').stat().st_mtime:
    raise SystemExit('The built helper is older than remote/helper/. Run `npm run build:helper` again.')
sys.path.insert(0, str(folder))
