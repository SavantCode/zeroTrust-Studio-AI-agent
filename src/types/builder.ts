import type { ChildProcess } from "child_process";

export type ChatMode = "build" | "talk";

export type OpStatus =
  | "pending"
  | "approved"
  | "ran"
  | "denied"
  | "undone"
  | "superseded";

export interface OperationChip {
  id: string;
  kind: "write" | "delete" | "cmd";
  relPath?: string;
  command?: string;
  status: OpStatus;
  isCritical?: boolean;
}

export interface FileProposal {
  id: string;
  kind: "write" | "delete";
  relPath: string;
  content?: string;
  contentHash?: string | null;
  turn: number;
  oldContent: string | null;
  oldContentHash?: string | null;
  baseHash: string | null;
  action: "OVERWRITE EXISTING FILE" | "CREATE NEW FILE" | "DELETE FILE";
  needsNewFolder?: boolean;
  folderToCreate?: string | null;
  isCritical?: boolean;
  criticalReason?: string | null;
}

export interface CommandProposal {
  id: string;
  command: string;
  turn: number;
}

export interface AttachmentPayload {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "video" | "audio" | "pdf" | "text" | "binary";
  data?: string;
  textContent?: string;
  url?: string;
}

export interface AttachmentMeta {
  id?: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "video" | "audio" | "pdf" | "text" | "binary";
  url?: string;
}

export interface DisplayMessage {
  role: "user" | "model";
  text: string;
  ts: number;
  mode?: ChatMode;
  duration?: string;
  images?: number;
  attachments?: AttachmentMeta[];
  ops?: OperationChip[];
  next?: string[];
}

export interface SnapshotData {
  text: string;
  textHash?: string;
  count: number;
  omitted: string[];
}

export interface TokenUsage {
  prompt: number;
  output: number;
  cached: number;
  last: {
    prompt: number;
    output: number;
    cached: number;
  } | null;
}

export interface ContextInfo {
  loaded: boolean;
  denied: boolean;
  files: number;
  tokens: number;
  omitted: number;
}

export interface UndoItem {
  rel: string;
  prev: string | null;
  prevHash?: string | null;
  turn?: number;
  propId?: string;
}

export interface WorkspaceCheckpoint {
  id: string;
  name: string;
  ts: number;
  fileCount: number;
  /** Map of relPath -> content (or hydrated from blobHashes on demand) */
  files: Map<string, string>;
  /** Content-addressable map of relPath -> sha1 blob hash */
  blobHashes?: Record<string, string>;
}

export interface CheckpointSummary {
  id: string;
  name: string;
  ts: number;
  fileCount: number;
}

export interface CheckpointDiffFile {
  relPath: string;
  status: "restore-create" | "restore-modify" | "restore-delete";
  currentContent: string | null;
  checkpointContent: string | null;
}

export interface StorageStats {
  totalBytes: number;
  blobCount: number;
  blobBytes: number;
  sessionCount: number;
  sessionBytes: number;
  rootDir: string;
}

export interface GcResult {
  purgedSessions: number;
  removedBlobs: number;
  freedBytes: number;
  storage: StorageStats;
}

export interface StoredSessionSummary {
  id: string;
  root: string | null;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  turns: number;
  messageCount: number;
  pendingProposals: number;
  checkpoints: number;
  title: string;
}

export interface BrowserConsoleEntry {
  id: string;
  level: "log" | "warn" | "error";
  text: string;
  ts: number;
}

export interface SearchMatch {
  relPath: string;
  line: number;
  snippet: string;
}

export interface HistoryTurn {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

export interface BuilderSession {
  id: string;
  title?: string;
  root: string | null;
  createdAt: number;
  expiresAt: number;
  history: HistoryTurn[];
  display: DisplayMessage[];
  snapshot: SnapshotData | null;
  seen: Map<string, string>;
  readDenied: boolean;
  events: string[];
  pendingChanges: Record<string, FileProposal>;
  pendingCommands: Record<string, CommandProposal>;
  undoStack: UndoItem[];
  checkpoints: WorkspaceCheckpoint[];
  proc: ChildProcess | null;
  procs?: Set<ChildProcess>;
  activeCmds: number;
  logs: string;
  previewUrl: string | null;
  busy: boolean;
  abort: AbortController | null;
  usage: TokenUsage;
  lastSeen: number;
  closeAt: number | null;
}

export interface DiffOp {
  t: " " | "+" | "-";
  s: string;
  o: number | null;
  n: number | null;
  hl?: [number, number];
}