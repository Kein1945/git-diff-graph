import { X } from 'lucide-react';

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: 'View',
    keys: [
      [['Shift', '1'], 'Fit everything on screen'],
      [['1'], 'Show changes with context'],
      [['2'], 'Show changes'],
      [['3'], 'Show only unstaged changes'],
      [['/'], 'Find symbol or file'],
    ],
  },
  {
    title: 'Blocks',
    keys: [
      [['Q'], 'Collapse the selected block (or the one it sits in)'],
      [['E'], 'Expand the selected block'],
      [['Esc'], 'Close the diff panel'],
    ],
  },
  {
    title: 'Git',
    keys: [[['S'], 'Stage / unstage the selected block']],
  },
];

function Key({ k }: { k: string }) {
  return <kbd className="min-w-6 rounded-md border border-white/[0.12] bg-white/[0.05] px-1.5 py-0.5 text-center font-mono text-[11px] text-ink">{k}</kbd>;
}

export function HotkeysHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/50 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="w-[min(460px,calc(100vw-32px))] rounded-2xl border border-white/[0.08] bg-panel/95 p-4 shadow-[0_20px_60px_rgb(0_0_0/0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-ink">Keyboard shortcuts</h2>
          <button type="button" onClick={onClose} className="grid size-7 place-items-center rounded-lg text-ink-faint transition hover:bg-white/10 hover:text-ink" title="Close (Esc)">
            <X className="size-4" />
          </button>
        </div>
        <p className="-mt-1 mb-3 text-[11.5px] text-ink-faint">Letters are physical keys: they work with any keyboard layout.</p>
        <div className="space-y-4">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-faint">{g.title}</h3>
              <ul className="space-y-1">
                {g.keys.map(([keys, label]) => (
                  <li key={label} className="flex items-center justify-between gap-4 text-[12.5px] text-ink-dim">
                    <span>{label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {keys.map((k) => (
                        <Key key={k} k={k} />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
