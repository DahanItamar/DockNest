"""The helper source package and the built one-file helper keep the rules that make the split safe.

- Mutable runtime state (anything rebound with `global` or changed in place) is defined only in common.py.
- The built helper loads in a safe order: no top-level statement uses a name defined after it.
- The built helper starts like the original: shebang, the same docstring, VERSION=1 (also the backup formatVersion).
"""
import ast, importlib.util, pathlib, unittest
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('verify_split', ROOT.parent / 'scripts' / 'verify-helper-split.py')
verify = importlib.util.module_from_spec(spec); spec.loader.exec_module(verify)
MODULES = {p.stem: ast.parse(p.read_text(encoding='utf8')) for p in (ROOT / 'helper').glob('*.py') if p.stem != '__init__'}


def top_assigned(tree):
    return {n for node in tree.body if isinstance(node, (ast.Assign, ast.AnnAssign)) for n in verify.bound(node)}


class Bundle(unittest.TestCase):
    def test_mutable_state_lives_only_in_common(self):
        defined = set().union(*map(top_assigned, MODULES.values()))
        state = set()
        for tree in MODULES.values():
            for x in ast.walk(tree):
                if isinstance(x, ast.Global):
                    state |= set(x.names)
                if isinstance(x, ast.Call) and isinstance(x.func, ast.Attribute) and isinstance(x.func.value, ast.Name) \
                        and x.func.value.id in defined and x.func.attr in {'append', 'add', 'update', 'clear', 'pop', 'setdefault', 'extend', 'remove', 'discard', 'insert'}:
                    state.add(x.func.value.id)
                if isinstance(x, ast.Subscript) and isinstance(x.ctx, (ast.Store, ast.Del)) and isinstance(x.value, ast.Name) and x.value.id in defined:
                    state.add(x.value.id)
        self.assertIn('EVENT_STREAM', state)
        self.assertLessEqual(state, top_assigned(MODULES['common']), 'state must be defined in common.py')
        for name, tree in MODULES.items():
            if name != 'common':
                self.assertFalse(top_assigned(tree) & state, name + '.py must not define shared state')

    def test_built_helper_loads_in_a_safe_order(self):
        source = pathlib.Path(helper.__file__).read_text(encoding='utf8')
        self.assertEqual(verify.order_problems(ast.parse(source)), [])
        self.assertTrue(source.startswith('#!/usr/bin/env python3\n'))
        self.assertEqual(ast.get_docstring(ast.parse(source)), 'Versioned Linux helper. No request values are interpolated into shell commands.')
        self.assertEqual(helper.VERSION, 1)
        self.assertNotIn('<build:header>', source)


if __name__ == '__main__':
    unittest.main()
