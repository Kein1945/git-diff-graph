import type { ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk-api.js';
import type {
  CodeGraph,
  GraphEdge,
  GraphNode,
  LayoutEdge,
  LayoutNode,
  LayoutResult,
  ViewState,
} from '../contracts/index.js';
import { SIZES, isCodeNode, leafSize } from './sizes.js';

export { SIZES, isCodeNode, leafSize, symbolLines } from './sizes.js';

/** Anything that can run an ELK layout: elkjs in-process (Node) or elkjs in a Web Worker (browser). */
export interface LayoutEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}

let defaultEngine: Promise<LayoutEngine> | undefined;

/** In-process elkjs, loaded lazily so browser bundles that inject their own engine never include it. */
function getDefaultEngine(): Promise<LayoutEngine> {
  defaultEngine ??= import('elkjs/lib/elk.bundled.js').then((m) => {
    // elkjs is CommonJS: depending on the loader the class is `default` or `default.default`.
    type ElkClass = new () => LayoutEngine;
    const mod = m as unknown as { default?: ElkClass | { default?: ElkClass } };
    const ELK = (typeof mod.default === 'function' ? mod.default : mod.default?.default) as ElkClass;
    return new ELK();
  });
  return defaultEngine;
}

const ROOT = '__root__';

const ROOT_OPTIONS: LayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '70',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.spacing.nodeNode': '28',
  'elk.spacing.edgeEdge': '14',
  'elk.spacing.edgeNode': '20',
  'elk.spacing.componentComponent': '48',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.mergeEdges': 'false',
  'elk.aspectRatio': '1.6',
  'elk.json.edgeCoords': 'ROOT',
  'elk.json.shapeCoords': 'PARENT',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
};

const containerPadding = (left: number) => `[top=${SIZES.headerHeight + 8},left=${left},bottom=${SIZES.padding},right=${SIZES.padding}]`;

/** Blocks of one layer share their left edge instead of being centred on each other. */
const NODE_OPTIONS: LayoutOptions = { 'elk.alignment': 'LEFT' };

/** Resolves graph structure for a view state: who is visible, who is expanded, who stands in for whom. */
export function resolveView(graph: CodeGraph, view: ViewState) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : ROOT;
    children.set(key, [...(children.get(key) ?? []), n]);
  }
  for (const list of children.values()) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const hasChildren = (id: string) => (children.get(id)?.length ?? 0) > 0;
  const isExpanded = (id: string) => view.expanded.has(id) && hasChildren(id);
  /** A symbol without nested scopes "expands" into its code. Files and dirs never do. */
  const showsCode = (id: string) => view.expanded.has(id) && !hasChildren(id) && isCodeNode(byId.get(id)!);
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    for (let p = byId.get(id)?.parentId; p && byId.has(p); p = byId.get(p)?.parentId) out.unshift(p);
    return out;
  };
  /** The visible node that represents `id`: its top-most collapsed ancestor, or itself. */
  const representative = (id: string): string => ancestors(id).find((a) => !isExpanded(a)) ?? id;

  return { byId, children, hasChildren, isExpanded, showsCode, ancestors, representative };
}

/** Maps graph edges onto visible nodes, merging edges that collapse onto the same pair. */
export function aggregateEdges(graph: CodeGraph, view: ViewState): Omit<LayoutEdge, 'points'>[] {
  const { representative, ancestors } = resolveView(graph, view);
  const merged = new Map<string, { edges: GraphEdge[]; source: string; target: string; kind: GraphEdge['kind'] }>();
  for (const e of graph.edges) {
    // Arrows go from a dependency to its dependent: "api → component" reads as "api feeds component".
    const [from, to] = e.kind === 'import' ? [e.target, e.source] : [e.source, e.target];
    const source = representative(from);
    const target = representative(to);
    if (source === target || ancestors(target).includes(source) || ancestors(source).includes(target)) continue;
    const key = `${e.kind}:${source}->${target}`;
    const entry = merged.get(key) ?? { edges: [], source, target, kind: e.kind };
    entry.edges.push(e);
    merged.set(key, entry);
  }
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, m]) => {
      const statuses = new Set(m.edges.map((e) => e.status));
      return {
        id,
        source: m.source,
        target: m.target,
        kind: m.kind,
        status: statuses.size === 1 ? [...statuses][0]! : 'unchanged',
        count: m.edges.length,
      };
    });
}

/**
 * Lays out the visible part of the graph. Pure with respect to its inputs: the same graph and
 * view state always produce the same coordinates.
 */
export async function computeLayout(graph: CodeGraph, view: ViewState, engine?: LayoutEngine): Promise<LayoutResult> {
  const r = resolveView(graph, view);
  const visibleEdges = aggregateEdges(graph, view);

  const toElk = (node: GraphNode): ElkNode => {
    const expanded = r.isExpanded(node.id);
    const showCode = r.showsCode(node.id);
    if (!expanded) return { id: node.id, layoutOptions: NODE_OPTIONS, ...leafSize(graph, node, showCode) };
    const min = leafSize(graph, node, false);
    return {
      id: node.id,
      layoutOptions: {
        ...NODE_OPTIONS,
        'elk.padding': containerPadding(node.kind === 'dir' ? SIZES.padding : SIZES.symbolGutter),
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${min.width}, ${SIZES.headerHeight + 40})`,
      },
      children: (r.children.get(node.id) ?? []).map(toElk),
      edges: [],
    };
  };

  const root: ElkNode = {
    id: ROOT,
    layoutOptions: ROOT_OPTIONS,
    children: (r.children.get(ROOT) ?? []).map(toElk),
    edges: [],
  };

  // Each edge lives in the deepest container holding both ends, as ELK expects.
  const containers = new Map<string, ElkNode>();
  const index = (n: ElkNode) => {
    containers.set(n.id, n);
    n.children?.forEach(index);
  };
  index(root);
  for (const e of visibleEdges) {
    const a = r.ancestors(e.source);
    const b = r.ancestors(e.target);
    let lca = ROOT;
    for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) lca = a[i]!;
    // ELK places sources left of targets. Import arrows point dependency → importer, but the
    // importer must stay on the left, so ELK gets the edge reversed and the route is flipped back.
    const [from, to] = e.kind === 'import' ? [e.target, e.source] : [e.source, e.target];
    const edge: ElkExtendedEdge = { id: e.id, sources: [from], targets: [to] };
    containers.get(lca)!.edges!.push(edge);
  }

  const out = await (engine ?? (await getDefaultEngine())).layout(root);

  const nodes: LayoutNode[] = [];
  const points = new Map<string, { x: number; y: number }[]>();
  const walk = (n: ElkNode, parentId: string | undefined) => {
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) {
      const s = e.sections?.[0];
      if (s) points.set(e.id, [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(({ x, y }) => ({ x, y })));
    }
    for (const c of n.children ?? []) {
      nodes.push({
        id: c.id,
        x: c.x ?? 0,
        y: c.y ?? 0,
        width: c.width ?? 0,
        height: c.height ?? 0,
        parentId,
        expanded: r.isExpanded(c.id) || r.showsCode(c.id),
        expandable: r.hasChildren(c.id) || isCodeNode(r.byId.get(c.id)!),
      });
      walk(c, c.id);
    }
  };
  walk(out, undefined);

  return {
    nodes,
    edges: visibleEdges.map((e) => {
      const route = points.get(e.id) ?? [];
      return { ...e, points: e.kind === 'import' ? route.reverse() : route };
    }),
    width: out.width ?? 0,
    height: out.height ?? 0,
  };
}
