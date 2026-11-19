"""Small source checks for the two VM harnesses and browser selector lists in Ticket H."""
import ast
import re
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HARNESSES = ('test_terms_consistency.cjs', 'test_official_article_url.cjs')
SELECTOR_LISTS = {
    'test_list_actions_ui.py': 'BANNED_SELECTORS',
    'test_weekly_ui.py': 'BANNED_GENERATION_SELECTORS',
}
IDENT = r'[A-Za-z_$][\w$]*'
CONTEXT = re.compile(r'^const (\w+) = vm\.createContext\(\{(?:\n(.*?)^)?\}\);', re.M | re.S)
LOAD = re.compile(r'^vm\.runInContext\((.*?),\s*(\w+)\s*\);$', re.M | re.S)
BINDING = rf'\b(?:const|let|var|function)\s+({IDENT})'


def stub_names(block):
    # The inspected tables indent top-level keys by two spaces. Only a shorthand
    # line can contain multiple keys; object/arrow bodies stay out of the scan.
    for line in block.splitlines():
        prop = re.match(rf'^  ({IDENT}): ', line)
        shorthand = re.fullmatch(rf'  ({IDENT}(?:, {IDENT})*),?', line)
        if prop:
            yield prop[1]
        elif shorthand:
            yield from shorthand[1].split(', ')


def stub_problems(root, filenames=HARNESSES):
    app = (root / 'app.js').read_text(encoding='utf-8')
    app_bindings = set(re.findall(rf'^  (?:async )?{BINDING}', app, re.M))
    problems = []
    for filename in filenames:
        harness = (root / 'scripts' / filename).read_text(encoding='utf-8')
        contexts = CONTEXT.findall(harness)
        if not contexts:
            problems.append(f'{filename}: cannot find VM context tables')
        for context, block in contexts:
            label = f'{filename}:{context}'
            loaders = [code for code, target in LOAD.findall(harness) if target == context]
            names = []
            for code in loaders:
                names.extend(re.findall(rf"\bfn\('({IDENT})'\)", code))
                for group in re.findall(r"\[([\s'\w,]+)\]\.map\(fn\)", code):
                    names.extend(re.findall(rf"'({IDENT})'", group))
            stubs = set(stub_names(block))
            if stubs and not names:
                problems.append(f'{label}: cannot find loaded app.js functions')
                continue
            bodies = []
            for name in names:
                function = re.search(rf'^  (?:async )?function {name}\([^\n]*\)[\s\S]*?\n  }}', app, re.M)
                if function:
                    bodies.append(function[0])
                else:
                    problems.append(f'{label}: cannot find function {name} in app.js')
            code = re.sub(r'^\s*//[^\n]*|\s+//[^\n]*$', '', '\n'.join(bodies), flags=re.M)
            # Local reference forms in these harnesses: bare calls, access,
            # assignment, conditions, and the shortlist's callback object.
            refs = set(re.findall(rf'(?<![\w$.])({IDENT})\s*(?=\(|\[|\?\.|\.|&&|\|\||[=!]==|=(?!=))', code))
            refs.update(re.findall(rf':\s+({IDENT})\s*(?=[,}}])', code))
            optional = set(re.findall(rf'\btypeof\s+({IDENT})(?![\w$.])', code))
            refs |= optional
            declared = set(re.findall(BINDING, code + '\n' + '\n'.join(loaders).replace(r'\n', '\n')))
            declared.update(re.findall(rf'\b({IDENT})\s*=>', code))
            for params in re.findall(r'\bfunction\s+\w+\(([^\n()]*)\)', code):
                declared.update(part.strip().split(' ', 1)[0] for part in params.split(','))
            refs -= declared
            problems.extend(f'{label}: unused stub {name}' for name in sorted(stubs - refs))
            problems.extend(f'{label}: unstubbed reference {name}'
                            for name in sorted(((refs & app_bindings) | (optional - declared)) - stubs))
    return problems


def has_literal_producer(source, selector):
    cls = re.fullmatch(r'\.([\w-]+)(?::not\(#([\w-]+)\))?', selector)
    action = re.fullmatch(r'\[data-action="([\w-]+)"\]', selector)
    if action:
        return re.search(rf"""\bdata-action=['"]{re.escape(action[1])}['"]""", source) is not None
    if cls:
        name, excluded_id = cls.groups()
        for tag in re.findall(r'<[A-Za-z][^<>]*>', source):
            attr = re.search(r"""\sclass=(['"])(.*?)\1""", tag)
            if attr and name in attr[2].split():
                if not excluded_id or not re.search(rf"""\sid=['"]{re.escape(excluded_id)}['"]""", tag):
                    return True
        return not excluded_id and re.search(
            rf"""\.classList\.(?:add|toggle)\(['"]{re.escape(name)}['"]""", source) is not None
    return False


def selector_problems(root, lists=SELECTOR_LISTS):
    sources = [root / 'index.html', *sorted((root / 'src/app').glob('*.js'))]
    product = '\n'.join(path.read_text(encoding='utf-8') for path in sources)
    problems = []
    for filename, list_name in lists.items():
        text = (root / 'scripts' / filename).read_text(encoding='utf-8')
        entries = next((node.value for node in ast.parse(text).body
                        if isinstance(node, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == list_name for t in node.targets)), None)
        if not isinstance(entries, (ast.List, ast.Tuple)) or not entries.elts:
            problems.append(f'{filename}: cannot find {list_name} entries')
            continue
        lines = text.splitlines()
        for entry in entries.elts:
            label = f'{filename}:{entry.lineno}'
            if not isinstance(entry, ast.Constant) or not isinstance(entry.value, str):
                problems.append(f'{label}: expected a literal selector in {list_name}')
            elif not has_literal_producer(product, entry.value):
                trailing = lines[entry.end_lineno - 1].encode()[entry.end_col_offset:].decode()
                if not re.match(r',?\s*#\s*positive control\s*:\s*\S', trailing):
                    problems.append(f'{label}: {entry.value} has no literal producer or positive control marker')
    return problems


class HarnessHygieneTests(unittest.TestCase):
    def test_vm_harnesses(self):
        self.assertEqual(stub_problems(ROOT), [])

    def test_banned_selector_lists(self):
        self.assertEqual(selector_problems(ROOT), [])

    def test_stub_probe_rejects_dead_and_silently_missing_bindings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'app.js').write_text(
                "  function latent() {\n    return '';\n  }\n"
                "  function render() {\n"
                "    // retired() is a comment, not a reference.\n"
                "    if (false) latent();\n"
                "    return typeof active === 'function' ? active() : '';\n  }\n",
                encoding='utf-8')
            harness = root / 'scripts/mock.cjs'
            for stubs, expected in [
                ('  active: () => "",\n  latent: () => "",\n', []),
                ('  active: () => "",\n  latent: () => "",\n  retired: () => "",\n',
                 ['mock.cjs:ctx: unused stub retired']),
                ('', ['mock.cjs:ctx: unstubbed reference active', 'mock.cjs:ctx: unstubbed reference latent']),
            ]:
                with self.subTest(stubs=stubs):
                    harness.write_text('const ctx = vm.createContext({\n' + stubs
                                       + "});\nvm.runInContext(fn('render'), ctx);\n", encoding='utf-8')
                    self.assertEqual(stub_problems(root, (harness.name,)), expected)

    def test_selector_probe_needs_a_producer_or_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'index.html').write_text('<span class="old" id="allowed"></span>', encoding='utf-8')
            fixture = root / 'scripts/mock.py'
            lists = {fixture.name: 'BANNED'}
            case = "BANNED = [\n    '.old:not(#allowed)',{}\n    '.old',\n]\n"
            fixture.write_text(case.format(''), encoding='utf-8')
            self.assertEqual(selector_problems(root, lists),
                             ['mock.py:2: .old:not(#allowed) has no literal producer or positive control marker'])
            fixture.write_text(case.format('  # positive control: scratch probe'), encoding='utf-8')
            self.assertEqual(selector_problems(root, lists), [])


if __name__ == '__main__':
    unittest.main()
