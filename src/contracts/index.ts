/**
 * Contracts between pipeline stages.
 *
 *   git ──► ChangeSet ──► analysis ──► CodeGraph ──► layout(+ViewState) ──► LayoutResult ──► viewer
 *
 * Every stage consumes and produces only these shapes. Each schema can validate data at a
 * boundary (server response, viewer input, JSON dumps), and the types are inferred from them.
 */
import { z } from 'zod';

// ───────────────────────────── ChangeSet (git → analysis) ─────────────────────────────

export const HunkLineSchema = z.object({
  type: z.enum(['add', 'del', 'ctx']),
  text: z.string(),
});

export const HunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(HunkLineSchema),
});

export const FileChangeStatusSchema = z.enum(['added', 'deleted', 'modified', 'renamed']);

export const FileChangeSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: FileChangeStatusSchema,
  binary: z.boolean(),
  hunks: z.array(HunkSchema),
  /** Full content before the change (absent for added or binary files). */
  oldContent: z.string().optional(),
  /** Full content after the change (absent for deleted or binary files). */
  newContent: z.string().optional(),
  /**
   * Index state, present only for HEAD → working tree: `staged` = HEAD → index hunks,
   * `unstaged` = index → working tree hunks.
   */
  staging: z
    .object({
      indexContent: z.string().optional(),
      staged: z.array(HunkSchema),
      unstaged: z.array(HunkSchema),
      /**
       * The file shows up in HEAD → index / index → working tree at all. Differs from "has hunks"
       * for changes without line edits: a pure rename, a mode change, an empty file.
       */
      hasStaged: z.boolean().optional(),
      hasUnstaged: z.boolean().optional(),
    })
    .optional(),
});

export const ChangeSetSchema = z.object({
  repoRoot: z.string(),
  base: z.string(),
  /** A git ref, or `WORKTREE` for uncommitted changes including untracked files. */
  target: z.string(),
  /** Branch checked out at HEAD (absent when HEAD is detached). Viewers show it instead of `HEAD`. */
  branch: z.string().optional(),
  files: z.array(FileChangeSchema),
  /** All files tracked at `target` (used to find context neighbours). */
  repoFiles: z.array(z.string()),
});

export const WORKTREE = 'WORKTREE';

/**
 * Reads file contents at the `target` side of a ChangeSet. Analysis uses it to parse
 * unchanged context neighbours without knowing about git or the filesystem.
 */
export interface SourceReader {
  readTarget(path: string): Promise<string | undefined>;
}

export type HunkLine = z.infer<typeof HunkLineSchema>;
export type Hunk = z.infer<typeof HunkSchema>;
export type FileChangeStatus = z.infer<typeof FileChangeStatusSchema>;
export type FileChange = z.infer<typeof FileChangeSchema>;
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

// ───────────────────────────── CodeGraph (analysis → layout / viewer) ─────────────────────────────

export const ChangeStatusSchema = z.enum(['added', 'removed', 'modified', 'unchanged']);
/** `type` covers interfaces, type aliases and enums. */
export const NodeKindSchema = z.enum(['dir', 'file', 'class', 'type', 'function', 'method']);

export const StagedSchema = z.enum(['none', 'partial', 'full']);

export const LineRangeSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
});

export const GraphNodeSchema = z.object({
  /** `dir:<path>`, `file:<path>` or `sym:<path>#<qualified.name>` */
  id: z.string(),
  kind: NodeKindSchema,
  name: z.string(),
  parentId: z.string().optional(),
  path: z.string(),
  status: ChangeStatusSchema,
  /** Unchanged neighbour shown only to give context to the change. */
  isContext: z.boolean(),
  ranges: z.object({ old: LineRangeSchema.optional(), new: LineRangeSchema.optional() }),
  stats: z.object({ add: z.number().int().nonnegative(), del: z.number().int().nonnegative() }),
  language: z.string().optional(),
  /** How much of this node's change is in the git index (only when staging is available). */
  staged: StagedSchema.optional(),
  /**
   * Symbols only: `true` when the symbol is part of the module's public surface (exported),
   * `false` when it is internal (not exported, private members). Absent when unknown.
   */
  exported: z.boolean().optional(),
});

export const EdgeKindSchema = z.enum(['import', 'call']);

export const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: EdgeKindSchema,
  status: z.enum(['added', 'removed', 'unchanged']),
  confidence: z.enum(['exact', 'heuristic']),
});

/** One line of a full-file unified view: the new file with removed lines interleaved. */
export const DiffLineSchema = z.object({
  t: z.enum(['add', 'del', 'ctx']),
  text: z.string(),
  old: z.number().int().positive().optional(),
  new: z.number().int().positive().optional(),
});

export const FileDiffSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: FileChangeStatusSchema,
  binary: z.boolean(),
  language: z.string().optional(),
  lines: z.array(DiffLineSchema),
  /** True when `lines` holds only the hunks, not the whole file (file too large). */
  truncated: z.boolean(),
});

export const CodeGraphSchema = z.object({
  meta: z.object({
    repoRoot: z.string(),
    base: z.string(),
    target: z.string(),
    /** Branch checked out at HEAD (absent when detached). */
    branch: z.string().optional(),
    generatedAt: z.string(),
    /** Stage / unstage / commit are possible (HEAD → working tree). */
    staging: z.boolean(),
  }),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  /** Diffs of changed files, keyed by file path. */
  files: z.record(z.string(), FileDiffSchema),
});

export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;
export type Staged = z.infer<typeof StagedSchema>;
export type NodeKind = z.infer<typeof NodeKindSchema>;
export type LineRange = z.infer<typeof LineRangeSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type DiffLine = z.infer<typeof DiffLineSchema>;
export type FileDiff = z.infer<typeof FileDiffSchema>;
export type CodeGraph = z.infer<typeof CodeGraphSchema>;

// ───────────────────────────── Git actions (viewer → server → git)

export const StageRequestSchema = z.object({
  action: z.enum(['stage', 'unstage']),
  /** Whole files (a directory sends all its changed files). */
  paths: z.array(z.string()).default([]),
  /** Part of one file: a symbol's lines in the working tree. */
  range: z
    .object({
      path: z.string(),
      start: z.number().int().positive(),
      end: z.number().int().positive(),
      /** `new`: working-tree lines (default); `old`: HEAD lines of a removed symbol. */
      side: z.enum(['new', 'old']).default('new'),
    })
    .optional(),
});

export const CommitRequestSchema = z.object({ message: z.string().trim().min(1) });

export type StageRequest = z.infer<typeof StageRequestSchema>;
export type CommitRequest = z.infer<typeof CommitRequestSchema>;

// ───────────────────────────── View state & layout (layout → viewer) ─────────────────────────────

export interface ViewState {
  /** Ids of container nodes (dirs, files, classes) whose children are visible. */
  expanded: ReadonlySet<string>;
}

export interface NodeSize {
  width: number;
  height: number;
}

export interface LayoutNode {
  id: string;
  /** Position relative to the parent container (or to the canvas for top-level nodes). */
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
  expanded: boolean;
  /** Nodes the user can expand (have children in the graph). */
  expandable: boolean;
}

export interface LayoutEdge {
  id: string;
  /**
   * `source → target` is the arrow direction. For imports it points from the dependency to its
   * dependent (the opposite of the GraphEdge, where the importer is the source).
   */
  source: string;
  target: string;
  kind: EdgeKind;
  status: GraphEdge['status'];
  /** How many graph edges this visible edge aggregates (children of collapsed nodes). */
  count: number;
  /** Absolute route points from ELK, start → bends → end. */
  points: { x: number; y: number }[];
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}
