import type { CodeGraph, DiffLine, GraphNode, NodeSize } from '../contracts/index.js';

/**
 * Node geometry shared by the layout engine and the viewer, so what ELK reserves is exactly
 * what the viewer draws.
 */
export const SIZES = {
  headerHeight: 40,
  padding: 14,
  codeLineHeight: 18,
  codeMaxLines: 40,
  codeWidth: 620,
  charWidth: 7.4,
} as const;

/** The diff lines that belong to a symbol (by its old and new ranges). */
export function symbolLines(graph: CodeGraph, node: GraphNode): DiffLine[] {
  const file = graph.files[node.path];
  if (!file) return [];
  if (node.kind === 'file') return file.lines;
  const { old, new: nu } = node.ranges;
  return file.lines.filter(
    (l) =>
      (nu && l.new !== undefined && l.new >= nu.start && l.new <= nu.end) ||
      (old && l.t === 'del' && l.old !== undefined && l.old >= old.start && l.old <= old.end) ||
      (!nu && old && l.old !== undefined && l.old >= old.start && l.old <= old.end),
  );
}

export function isCodeNode(node: GraphNode): boolean {
  return node.kind !== 'dir' && node.kind !== 'file';
}

/** Size of a node that shows no children (collapsed container, leaf, or code view). */
export function leafSize(graph: CodeGraph, node: GraphNode, showCode: boolean): NodeSize {
  if (showCode) {
    const lines = Math.min(symbolLines(graph, node).length, SIZES.codeMaxLines);
    return {
      width: SIZES.codeWidth,
      height: SIZES.headerHeight + Math.max(lines, 1) * SIZES.codeLineHeight + SIZES.padding,
    };
  }
  const kindLabel = node.kind === 'file' || node.kind === 'dir' ? 0 : 7;
  const stats = node.isContext ? 0 : `+${node.stats.add} -${node.stats.del}`.length + 1;
  const width = Math.round(Math.min(380, Math.max(170, (node.name.length + kindLabel + stats) * SIZES.charWidth + 76)));
  return { width, height: isCodeNode(node) ? 40 : 52 };
}
