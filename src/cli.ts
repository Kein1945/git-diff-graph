import { cac } from 'cac';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { WORKTREE } from './contracts/index.js';
import { computeLayout } from './layout/index.js';
import { createGitActions } from './git/index.js';
import { createPipeline } from './pipeline.js';
import { startServer } from './server/index.js';

interface CommonFlags {
  cwd?: string;
}

const pipelineFor = (base: string | undefined, target: string | undefined, flags: CommonFlags) =>
  createPipeline({ cwd: path.resolve(flags.cwd ?? process.cwd()), base: base ?? 'HEAD', target: target ?? WORKTREE });

/** Prints JSON and exits once it is flushed (the git reader keeps a child process alive). */
const print = (data: unknown) =>
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`, () => process.exit(0));

const cli = cac('git-diff-graph');

cli
  .command('[base] [target]', 'Open the change graph in the browser (default: HEAD → working tree)')
  .option('--port <port>', 'Port for the local server', { default: 4173 })
  .option('--no-open', 'Do not open the browser')
  .option('--no-watch', 'Do not rebuild when files change')
  .option('--cwd <dir>', 'Repository folder (default: current folder)')
  .example('git-diff-graph                 # uncommitted changes')
  .example('git-diff-graph HEAD~3          # last 3 commits + uncommitted')
  .example('git-diff-graph main feature    # between two refs')
  .action(async (base: string | undefined, target: string | undefined, flags: CommonFlags & { port: number; open: boolean; watch: boolean }) => {
    const pipeline = pipelineFor(base, target, flags);
    const cs = await pipeline.changeSet(); // fail fast on a bad repo or ref
    const live = flags.watch && cs.target === WORKTREE;
    // Stage / commit only make sense against the index: HEAD → working tree.
    const staging = cs.base === 'HEAD' && cs.target === WORKTREE;
    const server = await startServer({
      getGraph: () => pipeline.graph(),
      webDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'web'),
      port: Number(flags.port),
      watchRoot: live ? cs.repoRoot : undefined,
      actions: staging ? createGitActions(cs.repoRoot) : undefined,
      log: (msg) => console.log(`  ${msg}`),
    });
    console.log(`\n  git-diff-graph  ${cs.base} → ${cs.target === WORKTREE ? 'working tree' : cs.target}`);
    console.log(`  ${cs.files.length} changed file(s) in ${cs.repoRoot}`);
    console.log(`  ${server.url}${live ? '  (live)' : ''}\n`);
    if (flags.open) {
      const { default: open } = await import('open');
      await open(server.url);
    }
    const stop = () => void server.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

// Stage dumps: each pipeline stage can be inspected on its own.
cli
  .command('changeset [base] [target]', 'Print the ChangeSet (git stage) as JSON')
  .option('--cwd <dir>', 'Repository folder')
  .action(async (base?: string, target?: string, flags: CommonFlags = {}) => {
    print(await pipelineFor(base, target, flags).changeSet());
  });

cli
  .command('graph [base] [target]', 'Print the CodeGraph (analysis stage) as JSON')
  .option('--cwd <dir>', 'Repository folder')
  .action(async (base?: string, target?: string, flags: CommonFlags = {}) => {
    print(await pipelineFor(base, target, flags).graph());
  });

cli
  .command('layout [base] [target]', 'Print the LayoutResult (layout stage, everything expanded) as JSON')
  .option('--cwd <dir>', 'Repository folder')
  .action(async (base?: string, target?: string, flags: CommonFlags = {}) => {
    const graph = await pipelineFor(base, target, flags).graph();
    const containers = new Set(graph.nodes.map((n) => n.parentId).filter((p): p is string => !!p));
    print(await computeLayout(graph, { expanded: containers }));
  });

cli.help();
cli.version(pkg.version);

try {
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
} catch (err) {
  console.error(`\n  error: ${(err as Error).message}\n`);
  process.exit(1);
}
