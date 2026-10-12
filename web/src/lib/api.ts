import { CodeGraphSchema, type CodeGraph, type StageRequest } from '@core/contracts';

export interface GraphResponse {
  version: number;
  live: boolean;
  graph: CodeGraph;
}

/** Token for git actions; the server hands it out with the graph. */
let token: string | undefined;

export async function fetchGraph(): Promise<GraphResponse> {
  const res = await fetch('./api/graph', { cache: 'no-store' });
  const body = (await res.json()) as { error?: string; version: number; live: boolean; token?: string; graph: unknown };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  token = body.token;
  // The contract is validated at the boundary: a server/viewer mismatch fails loudly here.
  return { version: body.version, live: body.live, graph: CodeGraphSchema.parse(body.graph) };
}

/** Calls `onChange` whenever the server reports a new graph version. Returns an unsubscribe function. */
export function subscribe(onChange: () => void, onError: (message: string) => void): () => void {
  const source = new EventSource('./api/events');
  let known: number | undefined;
  const check = (e: MessageEvent<string>) => {
    const { version } = JSON.parse(e.data) as { version: number };
    if (known !== undefined && version !== known) onChange();
    known = version;
  };
  source.addEventListener('hello', check);
  source.addEventListener('graph', check);
  source.addEventListener('error', (e) => {
    if (e instanceof MessageEvent) onError((JSON.parse(e.data as string) as { message: string }).message);
  });
  return () => source.close();
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vc-token': token ?? '' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { error?: string; result?: T };
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.result as T;
}

export const stage = (request: StageRequest) => post<void>('./api/stage', request);
export const commit = (message: string) => post<{ hash: string }>('./api/commit', { message });
