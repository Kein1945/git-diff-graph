import type { CodeGraph, LayoutResult } from '@core/contracts';
import { computeLayout, type LayoutEngine } from '@core/layout';
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';

/**
 * Lays out the graph with ELK running in its own Web Worker, so big layouts never freeze the UI.
 * Only the latest request wins: older results resolve to undefined.
 */
export class LayoutClient {
  private engine: LayoutEngine = new ELK({ workerUrl: elkWorkerUrl });
  private seq = 0;

  async layout(graph: CodeGraph, expanded: ReadonlySet<string>): Promise<LayoutResult | undefined> {
    const id = ++this.seq;
    const result = await computeLayout(graph, { expanded }, this.engine);
    return id === this.seq ? result : undefined;
  }
}
