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
  /** 挂在这个节点上的附件 id。内容存在单独的表里，见 Attachment 的说明 */
  attachmentIds?: string[];
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

/**
 * 消息里的一段内容。
 *
 * 只有带附件时才用得上数组形式 —— 没有附件的消息仍然发纯字符串，
 * 这样不支持多模态的服务端（以及本机 llama.cpp 的多数模型）行为完全不变。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/**
 * 挂在节点上的附件。
 *
 * 单独一张表存，节点只记 id。原因是这个应用每次改动都整份写画布、
 * 快照又要存全部画布的完整副本最多十份 —— 把几 MB 的图片放进节点里，
 * 打一个字就在排队写几兆，快照还会把它复制十遍。
 *
 * 二进制以原生 Blob 存 IndexedDB，不转 base64（省 33% 体积），
 * 只在发请求那一刻转成 data URI。
 */
export interface Attachment {
  id: string;
  graphId: string;
  nodeId: string;
  name: string;
  mime: string;
  /** 原始字节数 */
  size: number;
  kind: AttachmentKind;
  blob: Blob;
  /** 文本类文件解析出的正文，发送时展开成一段标注过的引文 */
  text?: string;
  /** 解析时的提醒，比如 epub 有几章没读出来 */
  warning?: string;
  createdAt: number;
}

export type AttachmentKind = 'image' | 'text';
