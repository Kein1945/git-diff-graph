import type { LineRange, NodeKind } from '../../contracts/index.js';

/** A named code construct found by a language adapter. Children are nested scopes. */
export interface SymbolInfo {
  kind: Exclude<NodeKind, 'dir' | 'file'>;
  name: string;
  /** 1-based inclusive line range. */
  range: LineRange;
  children: SymbolInfo[];
}

export interface ImportResolveContext {
  /** Every path that may be an import target (repo-relative, forward slashes). */
  files: ReadonlySet<string>;
  /** Path aliases such as `@/*` → `src/*`, from tsconfig/jsconfig. */
  aliases: readonly PathAlias[];
}

export interface PathAlias {
  /** Pattern with at most one `*`, e.g. `@/*`. */
  pattern: string;
  /** Repo-relative replacement patterns, e.g. `src/*`. */
  targets: string[];
}

/**
 * Everything analysis needs to know about one language. Adding a language means writing one
 * adapter; the rest of the pipeline does not change.
 */
export interface LanguageAdapter {
  id: string;
  /** Lower-case extensions including the dot, e.g. `.ts`. */
  extensions: readonly string[];
  /** Loads parsers. Called once before any parse method. */
  init(): Promise<void>;
  parseSymbols(code: string, filePath: string): SymbolInfo[];
  /** Raw import specifiers as written in the source. */
  parseImports(code: string, filePath: string): string[];
  /** Maps a specifier to a repo file path, or undefined for external packages. */
  resolveImport(specifier: string, fromPath: string, ctx: ImportResolveContext): string | undefined;
}
