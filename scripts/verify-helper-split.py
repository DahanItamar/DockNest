"""Prove that a built helper bundle is the same program as a reference helper.py (pure move, no logic change).

Usage: python3 scripts/verify-helper-split.py REFERENCE.py BUNDLE.py
Checks, exit 1 on any difference:
  1. the same top-level functions and classes, each with an identical AST (body, arguments, decorators);
  2. the same other top-level statements (imports, constants, state, entry points), compared as ASTs;
  3. the bundle's order is safe: a top-level statement only uses, while the module loads, names bound before it
     (function bodies run later and are not counted);
  4. the `if __name__ == '__main__'` entry points (restore-chain, then the stdin request) are still last.
"""
import ast, builtins, collections, sys


def bound(node):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return {node.name}
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return {(a.asname or a.name).split('.')[0] for a in node.names}
    names = set()
    for target in getattr(node, 'targets', [getattr(node, 'target', None)]):
        if target is not None:
            names |= {x.id for x in ast.walk(target) if isinstance(x, ast.Name)}
    return names


def load_time_names(node):
    """Names a top-level statement reads while the module is being executed."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        a = node.args
        parts = node.decorator_list + a.defaults + [d for d in a.kw_defaults if d] + \
            [x.annotation for x in a.args + a.kwonlyargs + a.posonlyargs if x.annotation] + ([node.returns] if node.returns else [])
    elif isinstance(node, ast.ClassDef):
        parts = node.decorator_list + node.bases + [k.value for k in node.keywords] + \
            [s for s in node.body if not isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef))]
    else:
        parts = [node]
    used = set()
    for part in parts:
        local = set()
        for x in ast.walk(part):
            if isinstance(x, (ast.Lambda, ast.FunctionDef)):
                local |= {arg.arg for arg in ast.walk(x) if isinstance(arg, ast.arg)}
            if isinstance(x, ast.comprehension):
                local |= {n.id for n in ast.walk(x.target) if isinstance(n, ast.Name)}
            if isinstance(x, ast.ExceptHandler) and x.name:
                local.add(x.name)
            if isinstance(x, ast.Name) and isinstance(x.ctx, ast.Store) and part is not node:
                local.add(x.id)  # bound inside the statement (loop, with, assignment in an entry point)
        used |= {x.id for x in ast.walk(part) if isinstance(x, ast.Name) and isinstance(x.ctx, ast.Load)} - local
    return used


def order_problems(tree):
    seen, problems = set(dir(builtins)) | {'__name__', '__file__', '__doc__'}, []
    for node in tree.body:
        missing = load_time_names(node) - seen
        if missing:
            problems.append('line %d uses %s before it is defined' % (node.lineno, ', '.join(sorted(missing))))
        seen |= bound(node)
    return problems


def split(tree):
    defs, rest, names = {}, collections.Counter(), set()
    for node in tree.body:
        # Every top-level name is bound once, so moving a statement can never swap two bindings of one name.
        twice = bound(node) & names
        if twice and not isinstance(node, (ast.Import, ast.ImportFrom)):
            raise SystemExit('bound twice at top level: ' + ', '.join(sorted(twice)))
        names |= bound(node)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if node.name in defs:
                raise SystemExit('defined twice: ' + node.name)
            defs[node.name] = ast.dump(node)
        else:
            rest[ast.dump(node)] += 1
    return defs, rest


def main(reference, bundle):
    old, new = (ast.parse(open(p, encoding='utf8').read(), p) for p in (reference, bundle))
    (old_defs, old_rest), (new_defs, new_rest) = split(old), split(new)
    errors = []
    if set(old_defs) != set(new_defs):
        errors.append('functions/classes differ: missing %s, extra %s' % (sorted(set(old_defs) - set(new_defs)), sorted(set(new_defs) - set(old_defs))))
    errors += ['body changed: ' + name for name in sorted(set(old_defs) & set(new_defs)) if old_defs[name] != new_defs[name]]
    if old_rest != new_rest:
        errors.append('other top-level statements differ: %d only in reference, %d only in bundle' % (sum((old_rest - new_rest).values()), sum((new_rest - old_rest).values())))
    errors += ['reference: ' + p for p in order_problems(old)] + ['bundle: ' + p for p in order_problems(new)]
    last = new.body[-1]
    if not (isinstance(last, ast.If) and '__name__' in ast.dump(last.test) and isinstance(last.orelse[0], ast.If)):
        errors.append('the __main__ entry points (restore-chain, then the stdin request) are not the last statement')
    print('functions+classes: %d reference, %d bundle; other statements: %d, %d'
          % (len(old_defs), len(new_defs), sum(old_rest.values()), sum(new_rest.values())))
    for e in errors:
        print('FAIL', e)
    print('OK: same program' if not errors else 'DIFFERENT')
    return 1 if errors else 0


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
