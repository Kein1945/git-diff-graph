import type { CodeGraph, GraphNode } from '@core/contracts';
import { createContext, useContext } from 'react';

export interface ViewContextValue {
  graph: CodeGraph;
  byId: ReadonlyMap<string, GraphNode>;
  hasChildren(id: string): boolean;
  selectedId: string | undefined;
  /** Nodes and edges related to the hovered node; undefined when nothing is hovered. */
  focus: { nodes: ReadonlySet<string>; edges: ReadonlySet<string> } | undefined;
  searchHits: ReadonlySet<string>;
  toggle(id: string): void;
  /** Stage / unstage are available (HEAD → working tree). */
  canStage: boolean;
  stageNode(id: string, action: 'stage' | 'unstage'): void;
  /** Nodes with a git action in flight. */
  busy: ReadonlySet<string>;
  select(id: string | undefined): void;
  hover(id: string | undefined): void;
}

export const ViewContext = createContext<ViewContextValue | null>(null);

export function useView(): ViewContextValue {
  const v = useContext(ViewContext);
  if (!v) throw new Error('ViewContext missing');
  return v;
}
