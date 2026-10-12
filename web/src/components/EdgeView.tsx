import type { LayoutEdge } from '@core/contracts';
import { EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import { useView } from '../lib/context';

export type VcEdge = Edge<{ edge: LayoutEdge }, 'vc'>;

const COLOR: Record<LayoutEdge['status'], string> = {
  added: 'var(--color-added)',
  removed: 'var(--color-removed)',
  unchanged: '#94a3b8',
};

/** Orthogonal polyline with rounded corners. */
function roundedPath(points: readonly { x: number; y: number }[], radius = 10): string {
  if (points.length < 2) return '';
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1]!;
    const p = points[i]!;
    const p1 = points[i + 1]!;
    const r = Math.min(radius, Math.hypot(p.x - p0.x, p.y - p0.y) / 2, Math.hypot(p1.x - p.x, p1.y - p.y) / 2);
    const a = { x: p.x + Math.sign(p0.x - p.x) * r, y: p.y + Math.sign(p0.y - p.y) * r };
    const b = { x: p.x + Math.sign(p1.x - p.x) * r, y: p.y + Math.sign(p1.y - p.y) * r };
    d += ` L ${a.x} ${a.y} Q ${p.x} ${p.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

/** Middle of the longest segment: where a label is least likely to collide. */
function labelPoint(points: readonly { x: number; y: number }[]) {
  let best = { x: 0, y: 0, len: -1 };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best.len) best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, len };
  }
  return best;
}

function EdgeViewImpl({ id, data }: EdgeProps<VcEdge>) {
  const { focus } = useView();
  if (!data || data.edge.points.length < 2) return null;
  const { edge } = data;
  const color = COLOR[edge.status];
  const d = roundedPath(edge.points);
  const active = focus?.edges.has(id);
  const dimmed = focus && !active;
  const width = (edge.count > 1 ? 1.4 + Math.log2(edge.count) * 0.8 : 1.4) + (active ? 0.8 : 0);
  const baseOpacity = edge.status === 'unchanged' ? 0.22 : 0.95;
  const label = edge.count > 1 ? labelPoint(edge.points) : undefined;

  return (
    <>
      <path
        d={d}
        className="vc-edge"
        strokeWidth={width}
        strokeDasharray={edge.status === 'removed' ? '5 5' : undefined}
        markerEnd={`url(#vc-arrow-${edge.status})`}
        style={{ stroke: color, opacity: dimmed ? 0.07 : active ? 1 : baseOpacity }}
      />
      {edge.status === 'added' && !dimmed && <path d={d} className="vc-edge vc-edge-flow" stroke="#d1fae5" strokeWidth={width} style={{ opacity: 0.55 }} />}
      {/* wide invisible stroke: easier hover */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded-full border border-white/10 bg-panel/90 px-1.5 font-mono text-[10px] leading-4 text-ink-dim transition-opacity"
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`, opacity: dimmed ? 0.15 : 1 }}
          >
            ×{edge.count}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const EdgeView = memo(EdgeViewImpl);

/** Arrowhead markers, shared by all edges (rendered once). */
export function EdgeMarkers() {
  return (
    <svg className="pointer-events-none absolute size-0">
      <defs>
        {(Object.keys(COLOR) as LayoutEdge['status'][]).map((s) => (
          <marker key={s} id={`vc-arrow-${s}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" style={{ fill: COLOR[s] }} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
