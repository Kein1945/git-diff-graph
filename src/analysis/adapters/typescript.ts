import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, Query, type Node } from 'web-tree-sitter';
import type { ImportResolveContext, LanguageAdapter, SymbolInfo } from './types.js';

type Grammar = 'typescript' | 'tsx' | 'javascript';

const GRAMMAR_BY_EXT: Record<string, Grammar> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

/** Finds the vendored grammar folder both from `src/…` (tests, dev) and from bundled `dist/cli.js`. */
function findGrammarDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'grammars');
    if (existsSync(path.join(candidate, 'tree-sitter-typescript.wasm'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('tree-sitter grammars not found');
    dir = parent;
  }
}

function name(node: Node | null | undefined): string | undefined {
  return node?.text || undefined;
}

function lines(node: Node) {
  return { start: node.startPosition.row + 1, end: node.endPosition.row + 1 };
}

/** `export function f` / `export default class` — widen the range to the export statement. */
function withExport(node: Node): Node {
  return node.parent?.type === 'export_statement' ? node.parent : node;
}

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

/** `const X = () => …`, `const X = function …`, `const X = memo(() => …)` */
function isFunctionValue(value: Node | null): boolean {
  if (!value) return false;
  if (FUNCTION_VALUES.has(value.type)) return true;
  if (value.type === 'call_expression') {
    const first = value.childForFieldName('arguments')?.namedChildren[0];
    return !!first && FUNCTION_VALUES.has(first.type);
  }
  return false;
}

/** `export function f` / `export const f` (the declarator's statement is exported). */
function isExported(node: Node): boolean {
  const owner = node.type === 'variable_declarator' ? node.parent : node;
  return owner?.parent?.type === 'export_statement';
}

/** `private x()`, `protected x()` and `#x()` are internal; other members inherit nothing. */
function memberVisibility(node: Node): { exported?: boolean } {
  const hidden =
    node.childForFieldName('name')?.type === 'private_property_identifier' ||
    node.namedChildren.some((c) => c.type === 'accessibility_modifier' && c.text !== 'public');
  return hidden ? { exported: false } : {};
}

function symbolFor(node: Node, insideClass: boolean): Omit<SymbolInfo, 'children'> | undefined {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const n = name(node.childForFieldName('name'));
      return n ? { kind: 'function', name: n, range: lines(withExport(node)), exported: isExported(node) } : undefined;
    }
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class': {
      const n = name(node.childForFieldName('name')) ?? (node.parent?.type === 'export_statement' ? 'default' : undefined);
      return n ? { kind: 'class', name: n, range: lines(withExport(node)), exported: isExported(node) } : undefined;
    }
    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration': {
      const n = name(node.childForFieldName('name'));
      return n ? { kind: 'type', name: n, range: lines(withExport(node)), exported: isExported(node) } : undefined;
    }
    case 'method_definition':
    case 'abstract_method_signature': {
      const n = name(node.childForFieldName('name'));
      return n && insideClass ? { kind: 'method', name: n, range: lines(node), ...memberVisibility(node) } : undefined;
    }
    case 'public_field_definition':
    case 'field_definition': {
      const n = name(node.childForFieldName('name') ?? node.childForFieldName('property'));
      return n && isFunctionValue(node.childForFieldName('value'))
        ? { kind: 'method', name: n, range: lines(node), ...memberVisibility(node) }
        : undefined;
    }
    case 'variable_declarator': {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.type !== 'identifier' || !isFunctionValue(node.childForFieldName('value'))) return undefined;
      // Single declarator: cover `export const` so the whole statement belongs to the symbol.
      const decl = node.parent;
      const outer = decl && decl.namedChildren.filter((c) => c.type === 'variable_declarator').length === 1 ? withExport(decl) : node;
      return { kind: 'function', name: nameNode.text, range: lines(outer), exported: isExported(node) };
    }
  }
  return undefined;
}

/** Local names exported later in the file: `export { a, b as c }` and `export default a`. */
function exportedNames(root: Node): Set<string> {
  const out = new Set<string>();
  for (const stmt of root.namedChildren) {
    if (stmt.type !== 'export_statement' || stmt.childForFieldName('source')) continue;
    for (const c of stmt.namedChildren) {
      if (c.type === 'export_clause') {
        for (const spec of c.namedChildren) {
          const local = name(spec.childForFieldName('name'));
          if (local) out.add(local);
        }
      } else if (c.type === 'identifier') out.add(c.text);
    }
  }
  return out;
}

function collectSymbols(root: Node): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const visit = (node: Node, into: SymbolInfo[], insideClass: boolean) => {
    for (const child of node.namedChildren) {
      const sym = symbolFor(child, insideClass);
      if (sym) {
        const info: SymbolInfo = { ...sym, children: [] };
        into.push(info);
        visit(child, info.children, sym.kind === 'class');
      } else {
        // Functions nested in a function are not class members any more.
        const nestedClass = insideClass && (child.type === 'class_body' || child.type === 'decorator');
        visit(child, into, nestedClass);
      }
    }
  };
  visit(root, out, false);
  const later = exportedNames(root);
  for (const s of out) if (later.has(s.name)) s.exported = true;
  return out;
}

/**
 * Import sources, matched natively by tree-sitter (much faster than walking the tree from JS):
 * static imports, re-exports, dynamic `import()` and `require()`.
 */
const IMPORT_QUERY = `
(import_statement source: (string (string_fragment) @src))
(export_statement source: (string (string_fragment) @src))
(call_expression function: (import) arguments: (arguments . (string (string_fragment) @src)))
((call_expression function: (identifier) @fn arguments: (arguments . (string (string_fragment) @src)))
 (#eq? @fn "require"))
`;

function collectImports(query: Query, root: Node): string[] {
  const out = new Set<string>();
  for (const c of query.captures(root)) if (c.name === 'src') out.add(c.node.text);
  return [...out];
}

function resolveFile(candidate: string, files: ReadonlySet<string>): string | undefined {
  const base = path.posix.normalize(candidate).replace(/^\.\//, '');
  if (base.startsWith('../')) return undefined;
  if (files.has(base) && GRAMMAR_BY_EXT[path.posix.extname(base)]) return base;
  // NodeNext style: `./x.js` written in source, `x.ts` on disk.
  const stripped = base.replace(/\.(m|c)?jsx?$/, '');
  for (const stem of stripped === base ? [base] : [stripped, base]) {
    for (const ext of RESOLVE_EXTENSIONS) if (files.has(stem + ext)) return stem + ext;
    for (const ext of RESOLVE_EXTENSIONS) if (files.has(`${stem}/index${ext}`)) return `${stem}/index${ext}`;
  }
  if (files.has(base)) return base; // e.g. a .json or .css import
  return undefined;
}

export function createTypeScriptAdapter(): LanguageAdapter {
  const parsers = new Map<Grammar, { parser: Parser; imports: Query }>();

  const parse = <T>(code: string, filePath: string, fn: (root: Node, imports: Query) => T, fallback: T): T => {
    const grammar = GRAMMAR_BY_EXT[path.posix.extname(filePath).toLowerCase()];
    const entry = grammar && parsers.get(grammar);
    if (!entry) return fallback;
    const tree = entry.parser.parse(code);
    if (!tree) return fallback;
    try {
      return fn(tree.rootNode, entry.imports);
    } finally {
      tree.delete();
    }
  };

  return {
    id: 'typescript',
    extensions: Object.keys(GRAMMAR_BY_EXT),

    async init() {
      if (parsers.size) return;
      await Parser.init();
      const dir = findGrammarDir();
      for (const grammar of ['typescript', 'tsx', 'javascript'] as const) {
        const wasm = await readFile(path.join(dir, `tree-sitter-${grammar}.wasm`));
        const language = await Language.load(new Uint8Array(wasm));
        const parser = new Parser();
        parser.setLanguage(language);
        parsers.set(grammar, { parser, imports: new Query(language, IMPORT_QUERY) });
      }
    },

    parseSymbols: (code, filePath) => parse(code, filePath, (root) => collectSymbols(root), []),
    parseImports: (code, filePath) => parse(code, filePath, (root, imports) => collectImports(imports, root), []),

    resolveImport(specifier: string, fromPath: string, ctx: ImportResolveContext) {
      if (specifier.startsWith('.')) {
        return resolveFile(path.posix.join(path.posix.dirname(fromPath), specifier), ctx.files);
      }
      for (const alias of ctx.aliases) {
        const star = alias.pattern.indexOf('*');
        let rest: string | undefined;
        if (star < 0) rest = specifier === alias.pattern ? '' : undefined;
        else {
          const pre = alias.pattern.slice(0, star);
          const post = alias.pattern.slice(star + 1);
          if (specifier.startsWith(pre) && specifier.endsWith(post) && specifier.length >= pre.length + post.length) {
            rest = specifier.slice(pre.length, specifier.length - post.length);
          }
        }
        if (rest === undefined) continue;
        for (const target of alias.targets) {
          const hit = resolveFile(target.replace('*', rest), ctx.files);
          if (hit) return hit;
        }
      }
      return undefined;
    },
  };
}
