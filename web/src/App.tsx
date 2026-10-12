import type { CodeGraph, LayoutResult } from '@core/contracts';
import { Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffPanel } from './components/DiffPanel';
import { EdgeMarkers, EdgeView, type VcEdge } from './components/EdgeView';
import { NodeView, type VcNode } from './components/NodeView';
import { Legend, TopBar } from './components/TopBar';
import { commit, fetchGraph, stage, subscribe, type GraphResponse } from './lib/api';
import { ViewContext, type ViewContextValue } from './lib/context';
import { LayoutClient } from './lib/layout-client';
import { ancestorsOf, expandedForLevel, initialExpanded, nodeColor, withoutContext, type ZoomLevel } from './lib/view';

const nodeTypes = { vc: NodeView };
const edgeTypes = { vc: EdgeView };

function absolutePositions(layout: LayoutResult): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const n of layout.nodes) {
    const p = n.parentId ? out.get(n.parentId) : undefined;
    out.set(n.id, { x: n.x + (p?.x ?? 0), y: n.y + (p?.y ?? 0) });
  }
  return out;
}

/** Padding for flying to a node: keep it clear of the diff panel on the right. */
function focusPadding() {
  const panel = Math.min(620, window.innerWidth * 0.46) + 48;
  return { top: '18%', bottom: '18%', left: '12%', right: `${Math.round(panel)}px` } as const;
}

function toFlow(layout: LayoutResult): { nodes: VcNode[]; edges: VcEdge[] } {
  const depth = new Map<string, number>();
  const nodes = layout.nodes.map((n): VcNode => {
    const d = n.parentId ? (depth.get(n.parentId) ?? 0) + 1 : 0;
    depth.set(n.id, d);
    return {
      id: n.id,
      type: 'vc',
      position: { x: n.x, y: n.y },
      parentId: n.parentId,
      data: { layout: n },
      style: { width: n.width, height: n.height },
      width: n.width,
      height: n.height,
      draggable: false,
      connectable: false,
      zIndex: d,
    };
  });
  const edges = layout.edges.map(
    (e): VcEdge => ({ id: e.id, source: e.source, target: e.target, type: 'vc', data: { edge: e }, zIndex: 1000 }),
  );
  return { nodes, edges };
}

function Viewer({ data, reload }: { data: GraphResponse; reload: () => Promise<void> }) {
  const rf = useReactFlow<VcNode, VcEdge>();
  const client = useMemo(() => new LayoutClient(), []);
  const [hideContext, setHideContext] = useState(false);
  const graph: CodeGraph = useMemo(() => (hideContext ? withoutContext(data.graph) : data.graph), [data.graph, hideContext]);

  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpanded(data.graph));
  const knownIds = useRef(new Set(data.graph.nodes.map((n) => n.id)));
  const [layout, setLayout] = useState<LayoutResult>();
  const [flow, setFlow] = useState<{ nodes: VcNode[]; edges: VcEdge[] }>({ nodes: [], edges: [] });
  const [selectedId, setSelectedId] = useState<string>();
  const [hoverId, setHoverId] = useState<string>();
  const [query, setQuery] = useState('');
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  const [animate, setAnimate] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // What the camera should do after the next layout.
  const pending = useRef<{ kind: 'fit' } | { kind: 'anchor'; id: string; at: { x: number; y: number } } | { kind: 'focus'; id: string } | undefined>({ kind: 'fit' });

  // Live update: keep the user's expansion, apply the default rule to nodes that just appeared.
  useEffect(() => {
    const fresh = data.graph.nodes.filter((n) => !knownIds.current.has(n.id));
    if (!fresh.length) return;
    const defaults = initialExpanded(data.graph);
    setExpanded((prev) => new Set([...prev, ...fresh.map((n) => n.id).filter((id) => defaults.has(id))]));
    for (const n of fresh) knownIds.current.add(n.id);
  }, [data.graph]);

  useEffect(() => {
    let alive = true;
    void client.layout(graph, expanded).then((result) => {
      if (!alive || !result) return;
      setLayout(result);
      setFlow(toFlow(result));
    });
    return () => {
      alive = false;
    };
  }, [client, graph, expanded]);

  // Camera follow-up once React Flow has the new nodes.
  useEffect(() => {
    if (!layout) return;
    const action = pending.current;
    pending.current = undefined;
    const raf = requestAnimationFrame(() => {
      if (action?.kind === 'fit') {
        void rf.fitView({ padding: 0.08, duration: 0, maxZoom: 1 });
        setTimeout(() => setAnimate(true), 50);
      } else if (action?.kind === 'anchor') {
        // Keep the toggled node under the cursor instead of letting the whole picture jump.
        const now = absolutePositions(layout).get(action.id);
        if (now) {
          const vp = rf.getViewport();
          void rf.setViewport({ x: vp.x - (now.x - action.at.x) * vp.zoom, y: vp.y - (now.y - action.at.y) * vp.zoom, zoom: vp.zoom });
        }
      } else if (action?.kind === 'focus') {
        void rf.fitView({ nodes: [{ id: action.id }], duration: 600, maxZoom: 1.1, padding: focusPadding() });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [layout, rf]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const parents = useMemo(() => new Set(graph.nodes.map((n) => n.parentId).filter(Boolean)), [graph]);

  const toggle = useCallback(
    (id: string) => {
      const at = layout && absolutePositions(layout).get(id);
      if (at) pending.current = { kind: 'anchor', id, at };
      setZoomLevel(undefined);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [layout],
  );

  /** Stages or unstages a block: whole files for folders and files, the symbol's lines otherwise. */
  const stageNode = useCallback(
    (id: string, action: 'stage' | 'unstage') => {
      const node = byId.get(id);
      if (!node) return;
      const filePaths = (paths: string[]) => paths.flatMap((p) => [p, ...(data.graph.files[p]?.oldPath ? [data.graph.files[p]!.oldPath!] : [])]);
      let request: Parameters<typeof stage>[0];
      if (node.kind === 'dir') {
        const files = data.graph.nodes.filter((n) => n.kind === 'file' && !n.isContext && n.path.startsWith(`${node.path}/`));
        request = { action, paths: filePaths(files.map((n) => n.path)) };
      } else if (node.kind === 'file') {
        request = { action, paths: filePaths([node.path]) };
      } else {
        const side = node.ranges.new ? 'new' : 'old';
        const range = node.ranges.new ?? node.ranges.old;
        if (!range) return;
        request = { action, paths: [], range: { path: node.path, start: range.start, end: range.end, side } };
      }
      setBusy((b) => new Set([...b, id]));
      stage(request)
        .then(reload)
        .catch((e: Error) => setNotice(e.message))
        .finally(() => setBusy((b) => new Set([...b].filter((x) => x !== id))));
    },
    [byId, data.graph, reload],
  );

  /** Expands everything above a node and flies the camera to it. */
  const reveal = useCallback(
    (id: string) => {
      if (!byId.has(id)) return;
      setSelectedId(id);
      pending.current = { kind: 'focus', id };
      setExpanded((prev) => {
        const missing = ancestorsOf(graph, id).filter((a) => !prev.has(a));
        if (!missing.length) {
          // No re-layout will happen: move the camera right away.
          pending.current = undefined;
          void rf.fitView({ nodes: [{ id }], duration: 600, maxZoom: 1.1, padding: focusPadding() });
          return prev;
        }
        return new Set([...prev, ...missing]);
      });
    },
    [byId, graph, rf],
  );

  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set<string>();
    return new Set(graph.nodes.filter((n) => n.name.toLowerCase().includes(q) || (n.kind === 'file' && n.path.toLowerCase().includes(q))).map((n) => n.id));
  }, [graph, query]);
  const visibleHits = useMemo(() => new Set(flow.nodes.filter((n) => searchHits.has(n.id)).map((n) => n.id)), [flow.nodes, searchHits]);

  const focus = useMemo(() => {
    if (!hoverId || !layout) return undefined;
    const parentOf = new Map(layout.nodes.map((n) => [n.id, n.parentId]));
    const chain = (id: string) => {
      const out: string[] = [];
      for (let p: string | undefined = id; p; p = parentOf.get(p)) out.push(p);
      return out;
    };
    const inside = new Set(layout.nodes.filter((n) => chain(n.id).includes(hoverId)).map((n) => n.id));
    const nodes = new Set([...inside, ...chain(hoverId)]);
    const edges = new Set<string>();
    for (const e of layout.edges) {
      if (inside.has(e.source) || inside.has(e.target)) {
        edges.add(e.id);
        chain(e.source).forEach((x) => nodes.add(x));
        chain(e.target).forEach((x) => nodes.add(x));
      }
    }
    return { nodes, edges };
  }, [hoverId, layout]);

  const ctx: ViewContextValue = useMemo(
    () => ({
      graph,
      byId,
      hasChildren: (id) => parents.has(id),
      selectedId,
      focus,
      searchHits: visibleHits,
      toggle,
      select: setSelectedId,
      hover: setHoverId,
      canStage: data.graph.meta.staging,
      stageNode,
      busy,
    }),
    [graph, byId, parents, selectedId, focus, visibleHits, toggle, data.graph.meta.staging, stageNode, busy],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === '/' || (e.key === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape') setSelectedId(undefined);
      else if (e.key === 'f') void rf.fitView({ padding: 0.08, duration: 500 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rf]);

  return (
    <ViewContext.Provider value={ctx}>
      <div className={`relative h-full w-full ${animate ? '' : 'vc-instant'}`}>
        <EdgeMarkers />
        <ReactFlow<VcNode, VcEdge>
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.04}
          maxZoom={2.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onNodeDoubleClick={(_, n) => n.data.layout.expandable && toggle(n.id)}
          onNodeMouseEnter={(_, n) => setHoverId(n.id)}
          onNodeMouseLeave={() => setHoverId(undefined)}
          onPaneClick={() => setSelectedId(undefined)}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="rgb(255 255 255 / 0.07)" />
          <MiniMap<VcNode>
            pannable
            zoomable
            position="bottom-right"
            nodeColor={(n) => {
              const g = byId.get(n.id);
              if (!g || g.kind === 'dir' || (n.data.layout.expanded && parents.has(n.id))) return 'rgb(255 255 255 / 0.04)';
              return nodeColor(g);
            }}
            nodeStrokeWidth={0}
            nodeBorderRadius={6}
            maskColor="rgb(9 11 16 / 0.72)"
            style={{ width: 180, height: 120, right: selectedId ? 'calc(min(620px, 46vw) + 12px)' : undefined }}
          />
        </ReactFlow>

        <TopBar
          ref={searchRef}
          graph={data.graph}
          live={data.live}
          query={query}
          hits={searchHits.size}
          hideContext={hideContext}
          onQuery={setQuery}
          onSearchEnter={() => {
            const first = [...searchHits].sort((a, b) => (byId.get(a)!.isContext ? 1 : 0) - (byId.get(b)!.isContext ? 1 : 0))[0];
            if (first) reveal(first);
          }}
          onToggleContext={() => {
            pending.current = { kind: 'fit' };
            setHideContext((v) => !v);
          }}
          zoomLevel={zoomLevel}
          onZoomLevel={(level) => {
            pending.current = { kind: 'fit' };
            setZoomLevel(level);
            setExpanded(expandedForLevel(graph, level));
          }}
          onCommit={async (message) => {
            await commit(message);
            await reload();
          }}
          onFit={() => void rf.fitView({ padding: 0.08, duration: 500 })}
        />
        <Legend staging={data.graph.meta.staging} />
        {notice && (
          <div className="absolute bottom-16 left-1/2 z-30 max-w-xl -translate-x-1/2 rounded-xl border border-removed/30 bg-[rgb(40_16_24/0.92)] px-4 py-2 text-[12.5px] text-removed shadow-lg backdrop-blur">
            {notice}
          </div>
        )}
        <DiffPanel onReveal={reveal} />
      </div>
    </ViewContext.Provider>
  );
}

export function App() {
  const [data, setData] = useState<GraphResponse>();
  const [error, setError] = useState<string>();

  const load = useCallback(
    () =>
      fetchGraph()
        .then((d) => {
          setData(d);
          setError(undefined);
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );

  useEffect(() => {
    void load();
    return subscribe(() => void load(), setError);
  }, [load]);

  if (!data) {
    return (
      <div className="grid h-full place-items-center">
        {error ? (
          <div className="max-w-lg rounded-2xl border border-removed/30 bg-removed/10 px-5 py-4 text-[13px] text-removed">{error}</div>
        ) : (
          <div className="flex items-center gap-3 text-[13px] text-ink-dim">
            <span className="size-2 animate-ping rounded-full bg-accent" />
            Building change graph…
          </div>
        )}
      </div>
    );
  }

  if (!data.graph.nodes.length) {
    return (
      <div className="grid h-full place-items-center">
        <div className="text-center">
          <div className="text-[15px] font-medium text-ink">No changes</div>
          <div className="mt-1 font-mono text-[12px] text-ink-faint">
            {data.graph.meta.base} → {data.graph.meta.target === 'WORKTREE' ? 'working tree' : data.graph.meta.target}
          </div>
          {data.live && <div className="mt-3 text-[12px] text-ink-dim">Watching for edits…</div>}
        </div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <Viewer data={data} reload={load} />
    </ReactFlowProvider>
  );
}
