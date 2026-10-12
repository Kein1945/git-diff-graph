import type { DiffLine } from '@core/contracts';
import { useEffect, useMemo, useState } from 'react';
import type { ThemedToken } from 'shiki/core';
import { highlightLines } from '../lib/highlight';

const ROW_BG = {
  add: 'bg-[rgb(52_211_153/0.10)]',
  del: 'bg-[rgb(251_113_133/0.10)]',
  ctx: '',
} as const;
const SIGN_COLOR = { add: 'text-added', del: 'text-removed', ctx: 'text-ink-faint' } as const;
const SIGN = { add: '+', del: '−', ctx: ' ' } as const;

type Row = { kind: 'line'; line: DiffLine; index: number } | { kind: 'gap'; from: number; to: number };

/** Collapses long runs of unchanged lines, keeping `context` lines around each change. */
function compact(lines: readonly DiffLine[], context: number, open: ReadonlySet<number>): Row[] {
  const near = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t === 'ctx') return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) near[j] = true;
  });
  const rows: Row[] = [];
  for (let i = 0; i < lines.length; ) {
    if (near[i] || open.has(i)) {
      rows.push({ kind: 'line', line: lines[i]!, index: i });
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !near[j] && !open.has(j)) j++;
    if (j - i <= 2) for (let k = i; k < j; k++) rows.push({ kind: 'line', line: lines[k]!, index: k });
    else rows.push({ kind: 'gap', from: i, to: j });
    i = j;
  }
  return rows;
}

export function CodeBlock({
  lines,
  lang,
  context,
  numbers = true,
  maxLines,
}: {
  lines: readonly DiffLine[];
  lang: string | undefined;
  /** Collapse unchanged lines further than this from a change (undefined: show all). */
  context?: number;
  numbers?: boolean;
  maxLines?: number;
}) {
  const [tokens, setTokens] = useState<ThemedToken[][]>();
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    let alive = true;
    setTokens(undefined);
    void highlightLines(
      lines.map((l) => l.text),
      lang,
    ).then((t) => alive && setTokens(t));
    return () => {
      alive = false;
    };
  }, [lines, lang]);

  const rows = useMemo(() => {
    const all = context === undefined ? lines.map((line, index): Row => ({ kind: 'line', line, index })) : compact(lines, context, open);
    return maxLines ? all.slice(0, maxLines) : all;
  }, [lines, context, open, maxLines]);

  const width = String(Math.max(...lines.map((l) => l.new ?? l.old ?? 0), 1)).length;

  return (
    <div className="font-mono text-[12px] leading-[18px]">
      {rows.map((row) =>
        row.kind === 'gap' ? (
          <button
            key={`gap-${row.from}`}
            type="button"
            onClick={() => setOpen((s) => new Set([...s, ...Array.from({ length: row.to - row.from }, (_, k) => row.from + k)]))}
            className="my-1 flex w-full items-center gap-3 rounded-md bg-white/[0.03] px-3 py-1 text-left text-[11px] text-ink-faint transition hover:bg-white/[0.06] hover:text-ink-dim"
          >
            <span className="h-px flex-1 bg-line" />
            {row.to - row.from} unchanged lines
            <span className="h-px flex-1 bg-line" />
          </button>
        ) : (
          <div key={row.index} className={`flex whitespace-pre ${ROW_BG[row.line.t]}`}>
            {numbers && (
              <>
                <span className="w-[calc(var(--w)*1ch+12px)] shrink-0 select-none pr-2 text-right text-ink-faint/70" style={{ '--w': width } as React.CSSProperties}>
                  {row.line.old ?? ''}
                </span>
                <span className="w-[calc(var(--w)*1ch+12px)] shrink-0 select-none pr-2 text-right text-ink-faint/70" style={{ '--w': width } as React.CSSProperties}>
                  {row.line.new ?? ''}
                </span>
              </>
            )}
            <span className={`w-5 shrink-0 select-none text-center ${SIGN_COLOR[row.line.t]}`}>{SIGN[row.line.t]}</span>
            <span className={`pr-4 ${row.line.t === 'del' ? 'opacity-70' : ''}`}>
              {tokens?.[row.index]
                ? tokens[row.index]!.map((t, k) => (
                    <span key={k} style={{ color: t.color }}>
                      {t.content}
                    </span>
                  ))
                : <span className="text-ink-dim">{row.line.text}</span>}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
