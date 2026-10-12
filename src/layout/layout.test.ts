import { describe, expect, it } from 'vitest';
import type { CodeGraph, GraphEdge, GraphNode, LayoutNode } from '../contracts/index.js';
import { aggregateEdges, computeLayout } from './index.js';

function node(id: string, kind: GraphNode['kind'], parentId?: string): GraphNode {
  return {
    id,
    kind,
    name: id.split(/[:/#.]/).pop()!,
    parentId,
    path: id,
    status: 'modified',
    isContext: false,
    ranges: kind === 'function' ? { new: { start: 1, end: 3 } } : {},
    stats: { add: 1, del: 0 },
  };
}

function edge(source: string, target: string, status: GraphEdge['status'] = 'unchanged'): GraphEdge {
  return { id: `${source}->${target}`, source, target, kind: 'import', status, confidence: 'exact' };
}

const graph: CodeGraph = {
  meta: { repoRoot: '/r', base: 'HEAD', target: 'WORKTREE', generatedAt: '', staging: false },
  nodes: [
    node('dir:src', 'dir'),
    node('file:a', 'file', 'dir:src'),
    node('file:b', 'file', 'dir:src'),
    node('file:c', 'file'),
    node('sym:a#f', 'function', 'file:a'),
    node('sym:a#g', 'function', 'file:a'),
  ],
  edges: [edge('file:a', 'file:b', 'added'), edge('file:a', 'file:c'), edge('file:b', 'file:c'), edge('file:c', 'file:b')],
  files: {},
};

function overlaps(a: LayoutNode, b: LayoutNode) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('aggregateEdges', () => {
  it('merges edges of collapsed nodes and drops internal ones', () => {
    const collapsed = aggregateEdges(graph, { expanded: new Set() });
    // arrows point from the imported file to the importer
    expect(collapsed.map((e) => [e.source, e.target, e.count, e.status])).toEqual([
      ['dir:src', 'file:c', 1, 'unchanged'],
      ['file:c', 'dir:src', 2, 'unchanged'],
    ]);
    const open = aggregateEdges(graph, { expanded: new Set(['dir:src']) });
    expect(open.map((e) => [e.source, e.target, e.status])).toEqual([
      ['file:b', 'file:a', 'added'],
      ['file:b', 'file:c', 'unchanged'],
      ['file:c', 'file:a', 'unchanged'],
      ['file:c', 'file:b', 'unchanged'],
    ]);
  });
});

describe('computeLayout', () => {
  const view = { expanded: new Set(['dir:src', 'file:a']) };

  it('places siblings without overlaps and children inside parents', async () => {
    const layout = await computeLayout(graph, view);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(graph.nodes.map((n) => n.id).sort());

    const byParent = Map.groupBy(layout.nodes, (n) => n.parentId ?? '');
    for (const siblings of byParent.values()) {
      for (let i = 0; i < siblings.length; i++)
        for (let j = i + 1; j < siblings.length; j++) expect(overlaps(siblings[i]!, siblings[j]!)).toBe(false);
    }
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const n of layout.nodes) {
      if (!n.parentId) continue;
      const p = byId.get(n.parentId)!;
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(p.width);
      expect(n.y + n.height).toBeLessThanOrEqual(p.height);
    }
    for (const e of layout.edges) expect(e.points.length).toBeGreaterThanOrEqual(2);
  });

  it('is deterministic', async () => {
    const a = await computeLayout(graph, view);
    const b = await computeLayout(structuredClone(graph), { expanded: new Set(view.expanded) });
    expect(b).toEqual(a);
  });

  it('never gives a file without children a code box, even if marked expanded', async () => {
    const layout = await computeLayout(graph, { expanded: new Set(['dir:src', 'file:b']) });
    const b = layout.nodes.find((n) => n.id === 'file:b')!;
    expect(b.expanded).toBe(false);
    expect(b.expandable).toBe(false);
    expect(b.height).toBeLessThan(60);
  });

  it('gives leaf symbols a code-sized box when expanded', async () => {
    const withCode = await computeLayout(graph, { expanded: new Set(['dir:src', 'file:a', 'sym:a#f']) });
    const f = withCode.nodes.find((n) => n.id === 'sym:a#f')!;
    const g = withCode.nodes.find((n) => n.id === 'sym:a#g')!;
    expect(f.expanded).toBe(true);
    expect(f.width).toBeGreaterThan(g.width);
  });
});
