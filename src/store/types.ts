import type {
  Attachment,
  ChatNode,
  Graph,
  GraphMeta,
  KnowledgeFile,
  NodeRole,
  Profile,
  Settings,
} from '../types';
import type { ResolvedAttachment } from '../lib/attachments';
import type { RetrievedChunk } from '../lib/knowledge';
import type { SnapshotMeta, SnapshotReason } from '../lib/snapshots';
import type { FullBackup, SettingsBackup } from '../lib/backup';
import type { ArchiveCounts, ArchiveManifest, ParsedArchive } from '../lib/archive';
import type { ViewMode } from '../lib/view';

/**
 * store 按职责分成四片，这里是它们各自的对外形状。
 *
 * 原来是一个 1467 行的文件、一个巨大的闭包，四类完全不相干的事情
 * （画布结构、流式生成、持久化、知识库）挤在一起，改任何一处都要在
 * 整个文件里翻。切开之后每片两三百行，而且哪件事归谁一目了然。
 *
 * 切片之间仍然共用一份状态和一套内部件（见 core.ts）—— 拆的是代码，
 * 不是运行时。
 */

/** 画布与节点结构：增删改、连断线、撤销重做、布局、视图偏好 */
export interface GraphSlice {
  graph: Graph | null;
  graphs: GraphMeta[];
  selectedId: string | null;
  ready: boolean;
  /** 只暴露能否撤销/重做，历史本身放在闭包里，避免每次快照都触发全局重渲染 */
  canUndo: boolean;
  canRedo: boolean;

  /** 返回被撤销/重做的操作名，供 toast 提示；没得撤了返回 null */
  undo: () => string | null;
  redo: () => string | null;

  init: () => Promise<void>;
  refreshGraphList: () => Promise<void>;
  newGraph: () => Promise<void>;
  openGraph: (id: string) => Promise<void>;
  removeGraph: (id: string) => Promise<void>;
  renameGraph: (title: string) => void;
  importGraph: (graph: Graph) => Promise<void>;

  /** 画布视图模式。纯视图偏好，存 localStorage，不进画布数据 */
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  select: (id: string | null) => void;
  /** 正在对比的节点。放 store 而非 node.data，否则会破坏 Canvas 的节点对象缓存 */
  compareNodeId: string | null;
  setCompare: (id: string | null) => void;
  updateNode: (id: string, patch: Partial<ChatNode>) => void;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  /** 返回实际删掉的节点数，调用方用它提示「删了 N 个，⌘Z 可撤销」 */
  removeNode: (id: string, cascade: boolean) => number;
  addChild: (parentId: string, role: NodeRole) => string | null;
  addSibling: (nodeId: string) => string | null;
  addRootNode: (role: NodeRole, position: { x: number; y: number }) => string | null;
  linkNodes: (from: string, to: string) => string | null;
  unlinkNodes: (from: string, to: string) => void;
  /** 一键整理布局。传入实测节点尺寸，返回是否真的动了 */
  applyLayout: (dimensions?: Map<string, { width: number; height: number }>) => boolean;
}

/** 落在浏览器之外的那些事：快照、备份导入导出、附件二进制 */
export interface StorageSlice {
  snapshots: SnapshotMeta[];
  /** 打一个快照。返回是否真的存了（自动快照在内容没变时会跳过） */
  takeSnapshot: (reason?: SnapshotReason) => Promise<boolean>;
  refreshSnapshots: () => Promise<void>;
  /** 整份回滚到某个快照。回滚本身也会先打一个「恢复前」的点 */
  restoreSnapshot: (snapshotId: string) => Promise<boolean>;
  /** 只从快照里捞回一个画布，不动其他数据 */
  restoreGraphFromSnapshot: (snapshotId: string, graphId: string) => Promise<boolean>;
  removeSnapshot: (snapshotId: string) => Promise<void>;

  /** 打包全部数据用于导出。includeKeys 默认关，导出文件常被到处传 */
  exportSettings: (includeKeys: boolean) => SettingsBackup;
  exportEverything: (includeKeys: boolean) => Promise<FullBackup>;
  /** 完整备份包（.nexus.zip）：画布、设置、附件原件、知识库与向量 */
  exportArchive: (includeKeys: boolean) => Promise<{ blob: Blob; manifest: ArchiveManifest }>;
  /** 恢复完整备份包。整份替换，之前会自动打一个快照 */
  restoreArchive: (parsed: ParsedArchive) => Promise<ArchiveCounts>;
  /** 只合并模型配置，不碰本地已有的。返回加了几条、跳过几条 */
  importSettings: (backup: SettingsBackup) => { added: number; skipped: number };
  /** 整份恢复：替换所有画布和设置，恢复前自动打快照 */
  restoreBackup: (backup: FullBackup) => Promise<{ graphs: number }>;

  /** 当前画布的附件。二进制存在单独的表里，这里拿的是完整记录（含 Blob） */
  attachments: Attachment[];
  refreshAttachments: () => Promise<void>;
  /** 给某个节点挂附件。返回成功数和失败明细 —— 一个坏文件不该拖累其余的 */
  addAttachments: (
    nodeId: string,
    files: File[],
  ) => Promise<{ ok: number; failed: { name: string; error: string }[] }>;
  removeAttachment: (attachmentId: string) => Promise<void>;
  /** 把这些节点的附件解析成可发送的形式。预览面板和 run() 共用 */
  resolveAttachments: (
    nodeIds: Set<string>,
  ) => Promise<Map<string, ResolvedAttachment[]> | undefined>;
}

/** 公用知识库：建索引与检索 */
export interface KnowledgeSlice {
  /** 当前画布的知识库。知识库归属画布，切画布就是另一套资料 */
  knowledgeFiles: KnowledgeFile[];
  /** 正在建索引的文件，null 表示空闲 */
  indexing: { name: string; phase: 'parse' | 'embed'; done: number; total: number } | null;
  refreshKnowledge: () => Promise<void>;
  /** 逐个建索引。返回成功数和失败明细 —— 一个文件坏了不该拖累其余的 */
  addKnowledgeFiles: (
    files: File[],
  ) => Promise<{ ok: number; failed: { name: string; error: string }[] }>;
  setKnowledgeEnabled: (fileId: string, enabled: boolean) => Promise<void>;
  removeKnowledgeFile: (fileId: string) => Promise<void>;
  /** 检索。失败会抛出，由调用方决定是报错还是忽略 */
  retrieveKnowledge: (query: string) => Promise<RetrievedChunk[]>;
}

/** 流式生成，以及它依赖的模型配置 */
export interface GenerationSlice {
  settings: Settings;

  send: (userNodeId: string) => Promise<void>;
  regenerate: (assistantId: string) => Promise<void>;
  branchRegenerate: (assistantId: string) => Promise<void>;
  stop: (nodeId: string) => void;

  updateSettings: (patch: Partial<Settings>) => void;
  upsertProfile: (profile: Profile) => void;
  removeProfile: (id: string) => void;
  activeProfile: () => Profile;
}

export type State = GraphSlice & StorageSlice & KnowledgeSlice & GenerationSlice;
