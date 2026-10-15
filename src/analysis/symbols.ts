import type { ChangeStatus, LineRange } from '../contracts/index.js';
import type { SymbolInfo } from './adapters/types.js';
import { countInRange, type ChangedLines } from '../diff/index.js';

export interface SymbolChange {
  /** Dotted path from the file's top scope, e.g. `UserService.save.validate`. */
  qualifiedName: string;
  parentQualifiedName?: string;
  kind: SymbolInfo['kind'];
  name: string;
  status: ChangeStatus;
  ranges: { old?: LineRange; new?: LineRange };
  stats: { add: number; del: number };
  exported?: boolean;
}

interface Flat {
  info: SymbolInfo;
  qualifiedName: string;
  parent?: string;
}

/** Flattens a symbol tree into qualified names; duplicate names get a `#2`, `#3` suffix. */
function flatten(symbols: readonly SymbolInfo[], parent?: string, out = new Map<string, Flat>()): Map<string, Flat> {
  const seen = new Map<string, number>();
  for (const info of symbols) {
    const base = parent ? `${parent}.${info.name}` : info.name;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const qualifiedName = n === 1 ? base : `${base}#${n}`;
    out.set(qualifiedName, { info, qualifiedName, parent });
    flatten(info.children, qualifiedName, out);
  }
  return out;
}

/**
 * Matches symbols of the old and new versions by qualified name and decides what happened to each
 * one using the changed lines. Unchanged symbols are kept only when they contain a changed one,
 * so the result is the minimal tree that explains the change.
 */
export function diffSymbols(
  oldSymbols: readonly SymbolInfo[],
  newSymbols: readonly SymbolInfo[],
  changed: ChangedLines,
): SymbolChange[] {
  const before = flatten(oldSymbols);
  const after = flatten(newSymbols);
  const names = [...new Set([...after.keys(), ...before.keys()])];

  const result = new Map<string, SymbolChange>();
  for (const qn of names) {
    const o = before.get(qn);
    const n = after.get(qn);
    const ref = (n ?? o)!;
    const ranges = { old: o?.info.range, new: n?.info.range };
    const stats = { add: countInRange(changed.added, ranges.new), del: countInRange(changed.removed, ranges.old) };
    const status: ChangeStatus = !o ? 'added' : !n ? 'removed' : stats.add + stats.del > 0 ? 'modified' : 'unchanged';
    result.set(qn, {
      qualifiedName: qn,
      parentQualifiedName: ref.parent,
      kind: ref.info.kind,
      name: ref.info.name,
      status,
      ranges,
      stats,
      ...(ref.info.exported !== undefined && { exported: ref.info.exported }),
    });
  }

  // Keep changed symbols and the scopes that contain them.
  const keep = new Set<string>();
  for (const s of result.values()) {
    if (s.status === 'unchanged') continue;
    for (let q: string | undefined = s.qualifiedName; q && !keep.has(q); q = result.get(q)?.parentQualifiedName) {
      keep.add(q);
    }
  }
  return [...result.values()].filter((s) => keep.has(s.qualifiedName));
}
