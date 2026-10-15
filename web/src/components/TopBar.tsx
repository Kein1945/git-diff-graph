import type { CodeGraph } from '@core/contracts';
import { Check, ChevronDown, GitCommitHorizontal, GitCompareArrows, Layers, LoaderCircle, Scan, Search, X } from 'lucide-react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { GRAPH_FILTERS, ZOOM_LEVELS, type GraphFilter, type ZoomLevel } from '../lib/view';

const btn =
  'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-ink-dim transition hover:bg-white/[0.07] hover:text-ink disabled:opacity-40';

/** `HEAD` (and `HEAD~n`, `HEAD^`) reads as the checked-out branch unless HEAD is detached. */
function shortRef(ref: string, branch: string | undefined) {
  if (ref === 'WORKTREE') return 'working tree';
  if (branch && /^HEAD(?=$|[~^])/.test(ref)) return branch + ref.slice(4);
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref;
}

export interface TopBarProps {
  graph: CodeGraph;
  live: boolean;
  query: string;
  hits: number;
  filter: GraphFilter;
  zoomLevel: ZoomLevel | undefined;
  onQuery(q: string): void;
  onSearchEnter(): void;
  onFilter(filter: GraphFilter): void;
  onZoomLevel(level: ZoomLevel): void;
  onCommit(message: string): Promise<void>;
  onFit(): void;
}

function ZoomMenu({ level, onPick }: { level: ZoomLevel | undefined; onPick: (l: ZoomLevel) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const current = ZOOM_LEVELS.find((z) => z.id === level);
  return (
    <div ref={ref} className="relative">
      <button type="button" className={btn} onClick={() => setOpen((o) => !o)} title="Collapse or expand everything to one level">
        <Layers className="size-3.5" />
        {current ? current.label : 'Zoom'}
        <ChevronDown className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-30 w-72 overflow-hidden rounded-xl border border-white/[0.08] bg-panel/95 p-1 shadow-[0_16px_40px_rgb(0_0_0/0.5)] backdrop-blur-xl">
          {ZOOM_LEVELS.map((z) => (
            <button
              key={z.id}
              type="button"
              onClick={() => {
                onPick(z.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-white/[0.07] ${level === z.id ? 'text-ink' : 'text-ink-dim'}`}
            >
              <span className="w-3.5">{level === z.id && <Check className="size-3.5 text-accent" />}</span>
              <span className="text-[12.5px]">{z.label}</span>
              <span className="ml-auto whitespace-nowrap text-[11px] text-ink-faint">{z.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CommitControl({ stagedFiles, onCommit }: { stagedFiles: number; onCommit: (message: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const cancel = () => {
    setEditing(false);
    setMessage('');
    setError(undefined);
  };
  const submit = async () => {
    if (!message.trim() || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onCommit(message.trim());
      cancel();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className={btn}
        onClick={() => setEditing(true)}
        title={stagedFiles ? `Commit ${stagedFiles} staged file(s)` : 'Nothing staged yet: hover a block and press “stage”'}
      >
        <GitCommitHorizontal className="size-3.5" />
        Commit
        {stagedFiles > 0 && <span className="rounded-full bg-accent/20 px-1.5 font-mono text-[10.5px] text-accent">{stagedFiles}</span>}
      </button>
    );
  }

  return (
    <div className="relative">
      <div className="flex h-8 items-center gap-1 rounded-lg bg-white/[0.05] pl-2.5 pr-1 ring-1 ring-accent/40">
        <GitCommitHorizontal className="size-3.5 shrink-0 text-ink-faint" />
        <input
          ref={input}
          value={message}
          disabled={pending}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') cancel();
          }}
          // An empty input disappears on blur; a typed message stays until committed or cancelled.
          onBlur={() => !message.trim() && !pending && cancel()}
          placeholder="Commit message"
          className="w-64 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
        />
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={cancel} className="grid size-6 place-items-center rounded-md text-ink-faint transition hover:bg-white/10 hover:text-ink" title="Cancel (Esc)">
          <X className="size-3.5" />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void submit()}
          disabled={!message.trim() || pending}
          className="grid size-6 place-items-center rounded-md text-added transition hover:bg-added/15 disabled:opacity-40"
          title="Commit (Enter)"
        >
          {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        </button>
      </div>
      {error && <div className="absolute left-0 top-10 w-max max-w-sm rounded-lg border border-removed/30 bg-[rgb(40_16_24/0.95)] px-2.5 py-1.5 text-[11.5px] text-removed">{error}</div>}
    </div>
  );
}

export const TopBar = forwardRef<HTMLInputElement, TopBarProps>(function TopBar(p, searchRef) {
  const changedFiles = p.graph.nodes.filter((n) => n.kind === 'file' && !n.isContext);
  const add = changedFiles.reduce((s, n) => s + n.stats.add, 0);
  const del = changedFiles.reduce((s, n) => s + n.stats.del, 0);
  const stagedFiles = changedFiles.filter((n) => n.staged === 'full' || n.staged === 'partial').length;
  const repo = p.graph.meta.repoRoot.split(/[\\/]/).pop();

  return (
    <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-start justify-between gap-3">
      <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-panel/80 py-2 pl-3.5 pr-2 shadow-[0_10px_40px_rgb(0_0_0/0.4)] backdrop-blur-xl">
        <div className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-accent/30 to-added/20 text-ink">
          <GitCompareArrows className="size-4" />
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold text-ink">{repo}</div>
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
            <span>{shortRef(p.graph.meta.base, p.graph.meta.branch)}</span>
            <span>→</span>
            <span>{shortRef(p.graph.meta.target, p.graph.meta.branch)}</span>
          </div>
        </div>
        <div className="mx-1 h-7 w-px bg-line" />
        <div className="flex items-center gap-3 font-mono text-[12px] tabular-nums">
          <span className="text-ink-dim">
            {changedFiles.length} <span className="text-ink-faint">files</span>
          </span>
          <span className="text-added">+{add}</span>
          <span className="text-removed">−{del}</span>
        </div>
        {p.live && (
          <span className="flex items-center gap-1.5 rounded-full bg-added/10 px-2 py-0.5 text-[11px] font-medium text-added" title="Rebuilds on every file change">
            <span className="vc-live-dot size-1.5 rounded-full bg-added" />
            live
          </span>
        )}
        <div className="h-7 w-px bg-line" />
        <ZoomMenu level={p.zoomLevel} onPick={p.onZoomLevel} />
        {p.graph.meta.staging && <CommitControl stagedFiles={stagedFiles} onCommit={p.onCommit} />}
      </div>

      <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-white/[0.08] bg-panel/80 p-1 shadow-[0_10px_40px_rgb(0_0_0/0.4)] backdrop-blur-xl">
        <label className="flex h-8 items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 focus-within:bg-white/[0.07] focus-within:ring-1 focus-within:ring-accent/50">
          <Search className="size-3.5 text-ink-faint" />
          <input
            ref={searchRef}
            value={p.query}
            onChange={(e) => p.onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') p.onSearchEnter();
              if (e.key === 'Escape') {
                p.onQuery('');
                e.currentTarget.blur();
              }
            }}
            placeholder="Find symbol or file…"
            className="w-44 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
          />
          {p.query ? (
            <span className="font-mono text-[11px] tabular-nums text-ink-faint">{p.hits}</span>
          ) : (
            <kbd className="rounded border border-line px-1 font-mono text-[10px] text-ink-faint">/</kbd>
          )}
        </label>
        <div className="mx-0.5 h-5 w-px bg-line" />
        <div role="radiogroup" aria-label="What to show" className="flex h-8 items-center gap-0.5 rounded-lg bg-white/[0.04] p-0.5">
          {GRAPH_FILTERS.filter((f) => f.id !== 'unstaged' || p.graph.meta.staging).map((f) => {
            const on = p.filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={f.label}
                onClick={() => p.onFilter(f.id)}
                title={f.hint}
                className={`h-7 rounded-md px-2.5 text-[12.5px] transition ${on ? 'bg-white/[0.10] text-ink shadow-sm' : 'text-ink-dim hover:bg-white/[0.06] hover:text-ink'}`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <button type="button" className={btn} onClick={p.onFit} title="Fit to screen (Shift+1)">
          <Scan className="size-3.5" />
        </button>
      </div>
    </div>
  );
});

export function Legend({ staging }: { staging: boolean }) {
  const dot = (color: string, label: string) => (
    <span className="flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
  const line = (color: string, label: string, dashed = false) => (
    <span className="flex items-center gap-1.5">
      <svg width="18" height="6" className="overflow-visible">
        <line x1="0" y1="3" x2="18" y2="3" style={{ stroke: color }} strokeWidth="1.6" strokeDasharray={dashed ? '4 3' : undefined} />
      </svg>
      {label}
    </span>
  );
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/[0.08] bg-panel/75 px-3 py-2 text-[11px] text-ink-dim backdrop-blur-xl">
      {dot('var(--color-added)', 'added')}
      {dot('var(--color-modified)', 'modified')}
      {dot('var(--color-removed)', 'removed')}
      {dot('var(--color-context)', 'context')}
      {staging && (
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] border border-accent/80" />
          staged
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 border-t border-dashed border-white/25" />
        <span className="font-mono text-[10px] uppercase text-accent">fn</span>
        exported
      </span>
      <span className="flex items-center gap-1.5"><span className="font-mono text-[10px] uppercase text-ink-faint">fn</span>internal</span>
      <span className="h-3 w-px bg-line" />
      {line('var(--color-added)', 'new import')}
      {line('var(--color-removed)', 'removed import', true)}
      {line('#94a3b8', 'import')}
      <span className="text-ink-faint">→ points to the dependent</span>
      <span className="h-3 w-px bg-line" />
      <span className="text-ink-faint">click icon to expand · click name for diff</span>
      <span className="flex items-center gap-1 text-ink-faint">
        <kbd className="rounded border border-line px-1 font-mono text-[10px]">?</kbd>
        shortcuts
      </span>
    </div>
  );
}
