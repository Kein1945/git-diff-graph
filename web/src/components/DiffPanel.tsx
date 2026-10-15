import type { DiffLine, GraphEdge, GraphNode } from '@core/contracts';
import { symbolLines } from '@core/layout/sizes';
import { ArrowRight, Check, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { useView } from '../lib/context';
import { languageOf, nodeColor, PANEL_WIDTH, STATUS_LABEL } from '../lib/view';
import { CodeBlock } from './CodeBlock';
import { StageButton } from './NodeView';

const EDGE_TEXT: Record<GraphEdge['status'], string> = {
  added: 'text-added',
  removed: 'text-removed line-through decoration-removed/50',
  unchanged: 'text-ink-dim',
};

function Badge({ node }: { node: GraphNode }) {
  const color = nodeColor(node);
  return (
    <span
      className="rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 35%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      {node.isContext ? 'context' : STATUS_LABEL[node.status]}
    </span>
  );
}

function Relations({ title, edges, pick, onOpen }: { title: string; edges: GraphEdge[]; pick: (e: GraphEdge) => string; onOpen: (id: string) => void }) {
  const { byId } = useView();
  if (!edges.length) return null;
  return (
    <section>
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-faint">{title}</h3>
      <ul className="space-y-0.5">
        {edges.map((e) => {
          const other = byId.get(pick(e));
          return (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => onOpen(pick(e))}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[12px] transition hover:bg-white/5 ${EDGE_TEXT[e.status]}`}
              >
                <ArrowRight className="size-3 shrink-0 opacity-60" />
                <span className="truncate">{other?.path ?? pick(e)}</span>
                {e.status !== 'unchanged' && <span className="ml-auto shrink-0 text-[10px] uppercase opacity-80">{e.status}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function DiffPanel({ onReveal }: { onReveal: (id: string) => void }) {
  const { graph, byId, selectedId, select, canStage } = useView();
  const node = selectedId ? byId.get(selectedId) : undefined;

  const lines = useMemo(() => (node && node.kind !== 'dir' ? symbolLines(graph, node) : []), [graph, node]);
  const fileId = node?.kind === 'file' ? node.id : node && node.kind !== 'dir' ? `file:${node.path}` : undefined;
  const outgoing = useMemo(() => graph.edges.filter((e) => e.source === fileId), [graph, fileId]);
  const incoming = useMemo(() => graph.edges.filter((e) => e.target === fileId), [graph, fileId]);
  const children = useMemo(
    () => (node?.kind === 'dir' ? graph.nodes.filter((n) => n.kind === 'file' && n.path.startsWith(`${node.path}/`) && !n.isContext) : []),
    [graph, node],
  );

  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(undefined), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = (text: string) =>
    copyText(text)
      .then(() => setCopied(`Copied ${text}`))
      .catch(() => setCopied('Could not copy'));

  if (!node) return null;
  const file = graph.files[node.path];
  /** `path:line`: the new line, or the old one (in the old path) for a removed line. */
  const lineRef = (l: DiffLine) => (l.new !== undefined ? `${node.path}:${l.new}` : `${file?.oldPath ?? node.path}:${l.old}`);
  const qualified = node.id.startsWith('sym:') ? node.id.slice(node.id.indexOf('#') + 1) : undefined;

  return (
    <aside style={{ width: PANEL_WIDTH }} className="absolute inset-y-3 right-3 z-20 flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-panel/90 shadow-[0_20px_60px_rgb(0_0_0/0.5)] backdrop-blur-xl">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-ink">{qualified ?? node.name}</h2>
            <Badge node={node} />
            {node.exported !== undefined && (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] ${node.exported ? 'bg-accent/15 text-accent' : 'bg-white/[0.05] text-ink-faint'}`}
                title={node.exported ? 'Part of the module API: callers elsewhere may depend on it' : 'Internal to the file: changes stay local'}
              >
                {node.exported ? 'exported' : 'internal'}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void copy(node.path)}
            className="mt-0.5 block max-w-full cursor-pointer truncate rounded text-left font-mono text-[11.5px] text-ink-faint underline decoration-ink-faint/50 decoration-dashed underline-offset-[3px] transition hover:text-ink hover:decoration-ink/60"
            title={`Copy path · ${node.path}`}
          >
            {file?.oldPath ? `${file.oldPath} → ` : ''}
            {node.path}
          </button>
        </div>
        {(node.stats.add > 0 || node.stats.del > 0) && (
          <div className="flex shrink-0 gap-2 pt-0.5 font-mono text-[12px] tabular-nums">
            <span className="text-added">+{node.stats.add}</span>
            <span className="text-removed">−{node.stats.del}</span>
          </div>
        )}
        {canStage && !node.isContext && node.staged !== undefined && <StageButton node={node} always />}
        <button type="button" onClick={() => select(undefined)} className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-faint transition hover:bg-white/10 hover:text-ink" title="Close (Esc)">
          <X className="size-4" />
        </button>
      </header>

      <div className="vc-scroll flex-1 space-y-5 overflow-auto px-3 py-3">
        {node.kind === 'dir' && (
          <section>
            <h3 className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">Changed files</h3>
            <ul className="space-y-0.5">
              {children.map((f) => (
                <li key={f.id}>
                  <button type="button" onClick={() => onReveal(f.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[12px] text-ink-dim transition hover:bg-white/5">
                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: nodeColor(f) }} />
                    <span className="truncate">{f.path.slice(node.path.length + 1)}</span>
                    <span className="ml-auto flex shrink-0 gap-1.5 tabular-nums">
                      <span className="text-added">+{f.stats.add}</span>
                      <span className="text-removed">−{f.stats.del}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {node.isContext && node.kind === 'file' && (
          <p className="px-1 text-[12.5px] leading-relaxed text-ink-dim">
            Not changed. Shown because it is connected by imports to changed files.
          </p>
        )}

        {file?.binary && <p className="px-1 text-[12.5px] text-ink-dim">Binary file.</p>}
        {file?.truncated && <p className="px-1 text-[12.5px] text-modified">Large file: only changed hunks are shown.</p>}

        {lines.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-line bg-black/20 py-2">
            <CodeBlock
              lines={lines}
              lang={languageOf(node.path)}
              context={node.kind === 'file' || lines.length > 160 ? 3 : undefined}
              onLineClick={(l) => void copy(lineRef(l))}
            />
          </div>
        )}

        <div className="space-y-4 px-1">
          <Relations title="Imports" edges={outgoing} pick={(e) => e.target} onOpen={onReveal} />
          <Relations title="Imported by" edges={incoming} pick={(e) => e.source} onOpen={onReveal} />
        </div>
      </div>
      {copied && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 flex max-w-[90%] -translate-x-1/2 items-center gap-1.5 truncate rounded-lg border border-white/[0.08] bg-panel/95 px-2.5 py-1.5 font-mono text-[11.5px] text-ink-dim shadow-lg">
          <Check className="size-3.5 shrink-0 text-added" />
          <span className="truncate">{copied}</span>
        </div>
      )}
    </aside>
  );
}
