# git-diff-graph

**See your git changes as a map, not a wall of text.**

`git-diff-graph` turns `git diff` into an interactive graph in your browser: folders → files → classes and functions → code. You see not only *what* changed, but *how it connects*: which imports were added or removed, and which files depend on the code you touched.

Built for reviewing what you or an AI agent (Cursor, Claude Code, Copilot…) just changed, before you commit it.

![Overview: changed folders and files with import arrows between them](https://raw.githubusercontent.com/Kein1945/git-diff-graph/master/docs/overview.png)

![Jump to a function and read its diff with syntax highlighting](https://raw.githubusercontent.com/Kein1945/git-diff-graph/master/docs/diff-panel.png)

## Quick start

Install it once, globally:

```bash
npm install -g git-diff-graph
```

Then run it from any git repository:

```bash
cd my-project
git-diff-graph
```

A browser tab opens with your uncommitted changes, and it updates live as you edit files. No install? Use `npx git-diff-graph`.

### What to compare

```bash
git-diff-graph                    # HEAD → working tree (incl. untracked files), live updates
git-diff-graph HEAD~3             # last 3 commits + uncommitted changes
git-diff-graph main feature       # between two branches, tags or commits
git-diff-graph --cwd ../other-repo --port 5000 --no-open
```

| Option | Meaning |
|---|---|
| `[base]` | Ref to compare from. Default: `HEAD` |
| `[target]` | Ref to compare to. Default: the working tree |
| `--port <port>` | Local server port. Default: `4173` (next free port is used if busy) |
| `--no-open` | Don't open the browser |
| `--no-watch` | Don't rebuild the graph when files change |
| `--cwd <dir>` | Repository folder. Default: current folder |

### What you get

- **Zoom from architecture to code.** Folders, files, classes and functions nest inside each other. Open a function to read its diff right in the graph. The **Zoom ▾** menu folds everything back to Modules, Files or Functions in one click.
- **Only what matters.** Changed files, the imports that were added or removed, and unchanged files that *depend* on your changes. Old imports to untouched files are hidden.
- **Readable layout.** Blocks never overlap and arrows cross as little as possible. Arrows point from a dependency to its dependent (`api → component`).
- **Stage and commit from the graph.** Hover a block and press **stage**: a folder, a file, or just the lines of one function go to the git index. Then **Commit** with a message.
- **Live.** Edit code, or let your agent edit it, and the graph updates by itself.

Requires Node.js 20+ and git. Functions and imports are understood for TypeScript and JavaScript (`.ts .tsx .js .jsx .mjs .cjs`). Other languages are shown at the file level with full diffs.

## How to use

| Action | What happens |
|---|---|
| click the name / chevron, or double-click | expand or collapse a folder, file or class; for a function, show its code |
| click a block | side panel: diff, imports, imported by |
| hover | highlights the block's connections and dims everything else |
| hover a block's header → **stage** / **unstage** | `git add` / `git restore --staged` for a folder or file; for a function, only its lines |
| **Zoom ▾** | collapse everything to one level: Modules (top folders) / Files / Functions |
| **Commit** | type a message, `Enter` commits the staged changes, `Esc` cancels |
| `/` or `Ctrl+K` | find a symbol or file, `Enter` flies to it |
| `F` | fit the graph to the screen |
| **Context** | show or hide unchanged neighbours |

Stage and Commit are available when comparing `HEAD → working tree` (running without arguments). Staged blocks get an indigo frame with a check mark; partly staged blocks get a faint frame.

Colors: green — added, amber — modified, red — removed, grey dashed — context (unchanged, but connected by imports). Animated green arrows are new imports, dashed red arrows are removed ones. Collapsed blocks merge their children's arrows (`×N`).

When you zoom far out, labels grow and code inside blocks is drawn as a silhouette of the diff (semantic zoom).

## Architecture

A pipeline of independent stages. Each stage is a module with its own `index.ts` that talks to the others **only through the contracts** in `src/contracts`.

```
git ──► ChangeSet ──► analysis ──► CodeGraph ──► layout(+ViewState) ──► LayoutResult ──► viewer
```

| Module | Input → output | Inside |
|---|---|---|
| `src/contracts` | — | zod schemas and types: `ChangeSet`, `CodeGraph`, `LayoutResult`, `SourceReader` |
| `src/git` | repository → `ChangeSet`; `GitActions` | unified diff parser, file reads via `git cat-file --batch`, index state, stage/unstage (including the lines of one function) and commit |
| `src/diff` | — | pure functions over diffs: full-file view, applying part of a change, line number mapping; shared by `git` and `analysis` |
| `src/analysis` | `ChangeSet` + `SourceReader` → `CodeGraph` | tree-sitter: symbols and their status from hunks, staged state, imports and their diff, affected dependents, folders |
| `src/layout` | `CodeGraph` + `ViewState` → `LayoutResult` | ELK (layered, nested nodes, orthogonal edges), merging edges of collapsed nodes |
| `src/pipeline.ts` | — | the only place where git and analysis meet |
| `src/server` | `getGraph()` + `actions` → HTTP | `/api/graph`, SSE `/api/events`, `POST /api/stage` and `/api/commit` (token protected), file watching, viewer assets |
| `web/` | `CodeGraph` → UI | React Flow + Tailwind + shiki; imports only `contracts` and `layout` |

Every stage can be inspected on its own:

```bash
git-diff-graph changeset HEAD~1 HEAD   # what git saw
git-diff-graph graph HEAD~1 HEAD       # what analysis built
git-diff-graph layout HEAD~1 HEAD      # coordinates (everything expanded)
```

### Languages

The file level and diffs work for any language. Symbols and imports are supported for TS/TSX/JS/JSX (`src/analysis/adapters/typescript.ts`). A new language is one adapter implementing `LanguageAdapter` (`src/analysis/adapters/types.ts`); the rest of the pipeline stays the same. tree-sitter wasm grammars live in `grammars/`.

## Development

```bash
npm install
npm run build       # viewer (vite → dist/web) + CLI (tsup → dist/cli.js)
npm link            # makes `git-diff-graph` available globally from this checkout
```

```bash
npm test            # vitest: every module in isolation (git tests use temporary repositories)
npm run typecheck   # node side and viewer
npm run dev:web     # viewer with HMR; proxies /api to a running `git-diff-graph --no-open`
```

## Roadmap

- call edges between functions (`parseCalls` in the adapter, resolved through imports);
- snapshots of agent iterations in `refs/git-diff-graph/*` with a history slider;
- C# adapter;
- layout stability between expand/collapse.
