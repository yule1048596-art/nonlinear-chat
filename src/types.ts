export type NodeRole = 'system' | 'user' | 'assistant' | 'note';

export type ContextMode = 'auto' | 'include' | 'exclude';

export type NodeStatus = 'idle' | 'streaming' | 'error';

export interface ChatNode {
  id: string;
  role: NodeRole;
  content: string;
  /** 推理模型（DeepSeek-R1 等）的思维链，单独存放不进入下轮上下文 */
  reasoning?: string;
  /**
   * DAG 的核心：一个节点可以有多个父节点。
   * 上下文 = 所有祖先按拓扑序展开，因此多父就等于「把几条分支的结论合并起来继续问」。
   */
  parentIds: string[];
  position: { x: number; y: number };
  createdAt: number;
  updatedAt: number;
  /** 折叠后节点只显示首行摘要，长回答不会把画布撑爆 */
  collapsed?: boolean;
  /** 折叠整棵下游子树。与 collapsed 是两回事：那个只收起本节点的正文 */
  subtreeCollapsed?: boolean;
  /**
   * 这个节点进不进上下文。
   * - `auto`（默认）按角色决定：批注不进，其余都进
   * - `include` 强制进（让某条批注参与对话）
   * - `exclude` 静音（回答错了想留着看，但别带进下一轮）
   */
  contextMode?: ContextMode;
  /** @deprecated 已被 contextMode 取代，加载时会迁移。仅为兼容旧数据保留 */
  includeInContext?: boolean;
  /** 生成这条消息用的配置档，便于在不同分支上对比模型 */
  profileId?: string;
  model?: string;
  status?: NodeStatus;
  error?: string;
  usage?: { prompt?: number; completion?: number };
}

export interface Graph {
  id: string;
  title: string;
  nodes: Record<string, ChatNode>;
  createdAt: number;
  updatedAt: number;
  viewport?: { x: number; y: number; zoom: number };
}

export interface GraphMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface Profile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens?: number;
}

export interface Settings {
  profiles: Profile[];
  activeProfileId: string;
  systemPrompt: string;
  /** 发送前把上下文里超过这个数量的最早消息丢掉，0 表示不限制 */
  contextLimit: number;
  /** 知识库用的向量服务。默认指向本地 llama.cpp */
  embedding?: EmbeddingSettings;
}

export interface EmbeddingSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 每次提问检索前几块塞进上下文 */
  topK: number;
}

/**
 * 知识库里的一个文件。
 * 归属于画布 —— 知识库是「当前画布内所有对话共享」的，换个画布就是另一套资料。
 */
export interface KnowledgeFile {
  id: string;
  graphId: string;
  name: string;
  kind: 'text' | 'markdown' | 'docx' | 'epub';
  /** 原始文件字节数 */
  size: number;
  /** 解析出的正文字数 */
  charCount: number;
  chunkCount: number;
  /** 用户可以逐个文件开关，不必删了重建 */
  enabled: boolean;
  createdAt: number;
  status: 'indexing' | 'ready' | 'error';
  /** 索引失败的原因，失败的文件保留在列表里以便重试 */
  error?: string;
  /** 解析成功但有部分内容没读出来（比如 epub 的某几章） */
  warning?: string;
  /** 建库时用的向量模型。换模型后旧向量不可比，要能看出来 */
  embeddingModel?: string;
}

/** 切块 + 向量。和 knowledge.ts 的 StoredChunk 结构兼容，多带一个 graphId 便于按画布清理 */
export interface KnowledgeChunk {
  id: string;
  graphId: string;
  fileId: string;
  index: number;
  text: string;
  embedding: Float32Array;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
