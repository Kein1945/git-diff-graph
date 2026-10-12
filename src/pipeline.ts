import { createAnalyzer, type Analyzer } from './analysis/index.js';
import type { ChangeSet, CodeGraph } from './contracts/index.js';
import { createSourceReader, getChangeSet, type ChangeSetOptions } from './git/index.js';

/**
 * The only place where stages meet: git → analysis. The analyzer instance is kept so its
 * caches survive between rebuilds in watch mode.
 */
export interface Pipeline {
  changeSet(): Promise<ChangeSet>;
  graph(): Promise<CodeGraph>;
}

export function createPipeline(options: ChangeSetOptions, analyzer: Analyzer = createAnalyzer()): Pipeline {
  const changeSet = () => getChangeSet(options);
  return {
    changeSet,
    async graph() {
      const cs = await changeSet();
      return analyzer.analyze(cs, createSourceReader(cs.repoRoot, cs.target));
    },
  };
}
