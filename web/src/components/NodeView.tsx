import type { GraphNode, LayoutNode } from '@core/contracts';
import { SIZES, symbolLines } from '@core/layout/sizes';
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react';
import { Box, Braces, Check, ChevronRight, Contrast, File, FileCode, Folder, FolderOpen, LoaderCircle, Minus, Parentheses, Plus, SquareFunction } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useView } from '../lib/context';
import { languageOf, nodeColor } from '../lib/view';
import { CodeBlock } from './CodeBlock';

export type VcNode = Node<{ layout: LayoutNode }, 'vc'>;

const KIND_LABEL: Partial<Record<GraphNode['kind'], string>> = {
  class: 'class',
  type: 'type',
  function: 'fn',
  method: 'method',
};

function KindIcon({ node, open }: { node: GraphNode; open: boolean }) {
  const cls = 'size-[15px] shrink-0';
  switch (node.kind) {
    case 'dir':
      return open ? <FolderOpen className={cls} /> : <Folder className={cls} />;
    case 'file':
      return node.language ? <FileCode className={cls} /> : <File className={cls} />;
    case 'class':
      return <Box className={cls} />;
    case 'type':
      return <Braces className={cls} />;
    case 'method':
      return <Parentheses className={cls} />;
    default:
      return <SquareFunction className={cls} />;
  }
}

function Stats({ node }: { node: GraphNode }) {
  if (node.isContext || (node.stats.add === 0 && node.stats.del === 0)) return null;
  return (
    <span className="flex shrink-0 gap-1.5 pl-2 font-mono text-[11px] tabular-nums">
      {node.stats.add > 0 && <span className="text-added">+{node.stats.add}</span>}
      {node.stats.del > 0 && <span className="text-removed">−{node.stats.del}</span>}
    </span>
  );
}

const zoomSelector = (s: { transform: [number, number, number] }) => s.transform[2];

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

function StageButton({ node }: { node: GraphNode }) {
  const { stageNode, busy } = useView();
  const unstage = node.staged === 'full';
  const pending = busy.has(node.id);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!pending) stageNode(node.id, unstage ? 'unstage' : 'stage');
      }}
      onDoubleClick={stop}
      className={`nodrag ml-auto hidden h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[11px] transition group-hover/header:flex ${
        unstage
          ? 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/25'
          : 'border-added/40 bg-added/10 text-added hover:bg-added/20'
      }`}
      title={unstage ? 'Unstage (git restore --staged)' : 'Stage (git add)'}
    >
      {pending ? <LoaderCircle className="size-3 animate-spin" /> : unstage ? <Minus className="size-3" /> : <Plus className="size-3" />}
      {unstage ? 'unstage' : 'stage'}
    </button>
  );
}

function StagedMark({ staged }: { staged: GraphNode['staged'] }) {
  if (staged === 'full') return <Check className="size-3.5 shrink-0 text-accent" aria-label="staged" />;
  if (staged === 'partial') return <Contrast className="size-3.5 shrink-0 text-accent/70" aria-label="partly staged" />;
  return null;
}

function Header({ node, layout, onToggle }: { node: GraphNode; layout: LayoutNode; onToggle: () => void }) {
  const { canStage } = useView();
  const zoom = useStore(zoomSelector);
  // Semantic zoom: when zoomed far out, labels grow so the structure stays readable.
  const scale = zoom < 0.6 ? Math.min(3, 0.6 / zoom) : 1;
  const color = nodeColor(node);
  const stageable = canStage && !node.isContext && node.staged !== undefined && scale === 1;
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (layout.expandable) onToggle();
  };
  return (
    <div className="group/header flex h-10 min-w-0 items-center gap-2 px-3" style={{ fontSize: 13 * scale }}>
      {/* Chevron, icon, kind and name form one toggle target: no need to aim at the chevron. */}
      <button
        type="button"
        onClick={toggle}
        onDoubleClick={stop}
        className={`nodrag -ml-1.5 flex min-w-0 items-center gap-2 rounded-md py-1 pl-1 pr-2 text-left transition ${
          layout.expandable ? 'cursor-pointer hover:bg-white/[0.07]' : 'cursor-default'
        }`}
        title={layout.expandable ? `${layout.expanded ? 'Collapse' : 'Expand'} · ${node.path}` : node.path}
      >
        {layout.expandable && (
          <ChevronRight className={`size-3.5 shrink-0 text-ink-faint transition-transform duration-300 ${layout.expanded ? 'rotate-90' : ''}`} />
        )}
        <span style={{ color }} className="flex shrink-0">
          <KindIcon node={node} open={layout.expanded} />
        </span>
        {KIND_LABEL[node.kind] && scale === 1 && (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-ink-faint">{KIND_LABEL[node.kind]}</span>
        )}
        <span
          className={`min-w-0 truncate font-medium ${node.kind === 'dir' ? 'text-ink-dim' : 'text-ink'} ${node.status === 'removed' ? 'line-through decoration-removed/60' : ''} ${node.isContext ? 'text-ink-dim' : ''}`}
        >
          {node.name}
        </span>
      </button>
      {scale === 1 && <StagedMark staged={node.staged} />}
      {scale === 1 && (
        <span className={`ml-auto flex shrink-0 ${stageable ? 'group-hover/header:hidden' : ''}`}>
          <Stats node={node} />
        </span>
      )}
      {stageable && <StageButton node={node} />}
    </div>
  );
}

function CodePreview({ node, height }: { node: GraphNode; height: number }) {
  const { graph } = useView();
  const zoom = useStore(zoomSelector);
  const lines = useMemo(() => symbolLines(graph, node), [graph, node]);
  if (zoom < 0.5) {
    // Too small to read: draw the shape of the diff instead of text.
    return (
      <div className="space-y-[6px] px-3 pt-1" style={{ height: height - SIZES.headerHeight }}>
        {lines.slice(0, SIZES.codeMaxLines).map((l, i) => (
          <div
            key={i}
            className={`h-[12px] rounded-sm ${l.t === 'add' ? 'bg-added/40' : l.t === 'del' ? 'bg-removed/40' : 'bg-white/[0.07]'}`}
            style={{ width: `${Math.min(100, 12 + l.text.trimEnd().length * 1.2)}%`, marginLeft: `${Math.min(40, (l.text.length - l.text.trimStart().length) * 1.2)}%` }}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="nowheel vc-scroll overflow-hidden px-1" style={{ height: height - SIZES.headerHeight - 6 }}>
      <CodeBlock lines={lines} lang={languageOf(node.path)} numbers={false} maxLines={SIZES.codeMaxLines} />
    </div>
  );
}

function NodeViewImpl({ id, data }: NodeProps<VcNode>) {
  // Click, double-click and hover are wired through React Flow (see App), which keeps nodes interactive.
  const { byId, hasChildren, toggle, selectedId, focus, searchHits } = useView();
  const node = byId.get(id);
  if (!node) return null;
  const { layout } = data;
  const color = nodeColor(node);
  const isContainer = layout.expanded && hasChildren(id);
  const showCode = layout.expanded && !isContainer;
  const dimmed = focus && !focus.nodes.has(id);
  const selected = selectedId === id;
  const hit = searchHits.has(id);

  const shell = [
    'group relative h-full w-full overflow-hidden transition-[opacity,box-shadow,border-color] duration-200',
    dimmed ? 'opacity-30' : 'opacity-100',
    selected ? 'ring-2 ring-accent/80' : hit ? 'ring-2 ring-modified/80' : '',
  ];
  // Staged blocks get an indigo frame: solid when everything is staged, faint when part is.
  const stagedFrame =
    node.staged === 'full' ? '!border-accent/70 !border-solid' : node.staged === 'partial' ? '!border-accent/35' : '';

  if (isContainer) {
    const style =
      node.kind === 'dir'
        ? 'rounded-2xl border border-dashed border-white/[0.09] bg-white/[0.012]'
        : 'rounded-xl border border-white/[0.08] bg-[rgb(17_20_28/0.72)] shadow-[0_8px_30px_rgb(0_0_0/0.35)] backdrop-blur-sm';
    return (
      <div
        className={[...shell, style, stagedFrame].join(' ')}
      >
        {node.kind !== 'dir' && <div className="absolute inset-x-0 top-0 h-[2px]" style={{ background: color, opacity: node.isContext ? 0.3 : 0.85 }} />}
        <Header node={node} layout={layout} onToggle={() => toggle(id)} />
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  return (
    <div
      className={[
        ...shell,
        'rounded-xl border bg-[rgb(20_24_33/0.92)] shadow-[0_4px_18px_rgb(0_0_0/0.35)] backdrop-blur',
        node.isContext ? 'border-dashed border-white/[0.10] bg-[rgb(20_24_33/0.55)]' : 'border-white/[0.09] hover:border-white/20',
        stagedFrame,
        node.staged === 'full' ? 'bg-[rgb(28_30_52/0.92)]' : '',
      ].join(' ')}
    >
      <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color, opacity: node.isContext ? 0.35 : 1 }} />
      <Header node={node} layout={layout} onToggle={() => toggle(id)} />
      {showCode && <CodePreview node={node} height={layout.height} />}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}


export const NodeView = memo(NodeViewImpl);
