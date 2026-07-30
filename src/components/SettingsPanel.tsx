import { useEffect, useState } from 'react';
import { newProfile, useStore } from '../store/useStore';
import { LlmError, PRESETS, listModels, streamChat } from '../lib/llm';
import { DEFAULT_EMBEDDING, EmbeddingError, embedOne } from '../lib/embeddings';
import { isLocalUrl, usesLoopbackIp } from '../lib/endpoint';
import { backupFilename } from '../lib/backup';
import { downloadBlob, downloadJson } from '../lib/download';
import { archiveFilename } from '../lib/archive';
import { toast } from '../lib/toast';
import type { EmbeddingSettings, Profile } from '../types';

const FALLBACK_EMBEDDING: EmbeddingSettings = { ...DEFAULT_EMBEDDING, topK: 5 };

/**
 * 设置分四个标签页。
 *
 * 原来是六个平铺的段落，在 400px 宽的抽屉里要滚十几屏才走完，而且
 *「模型配置」和「知识库向量服务」两块字段几乎一样却隔着老远，看着像不相干的东西。
 * 分页之后打开就落在最常用的「模型」上，其余一点即达。
 */
const TABS = [
  { id: 'model', label: '模型' },
  { id: 'knowledge', label: '知识库' },
  { id: 'general', label: '通用' },
  { id: 'data', label: '数据' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** 本地服务的启动引导。地址是本机时才出现 —— 别的时候它只是噪音 */
function LocalHint({ baseUrl, command }: { baseUrl: string; command?: string }) {
  if (!isLocalUrl(baseUrl)) return null;
  return (
    <div className="local-hint">
      <div className="local-hint-head">本机服务</div>
      {command && <code className="local-cmd">{command}</code>}
      <ul className="hint list">
        <li>
          地址必须写 <b>localhost</b>，不能写 127.0.0.1 —— 浏览器会拦截 https 页面对
          http://127.0.0.1 的请求，而 localhost 属于可信来源不受此限
        </li>
        <li>没设 --api-key 就把 API Key 留空，程序不会发 Authorization 头</li>
        <li>模型名拿不准就点「拉列表」，它会把服务端实际加载的名字填进来</li>
      </ul>
    </div>
  );
}

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const upsertProfile = useStore((s) => s.upsertProfile);
  const removeProfile = useStore((s) => s.removeProfile);
  const exportSettings = useStore((s) => s.exportSettings);
  const exportEverything = useStore((s) => s.exportEverything);
  const exportArchive = useStore((s) => s.exportArchive);

  const [tab, setTab] = useState<TabId>('model');
  const [editingId, setEditingId] = useState(settings.activeProfileId);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<'models' | 'test' | null>(null);
  // 默认不含 Key：导出文件最常见的用途是分享配置模板和换设备，带明文 Key 太容易泄漏
  const [includeKeys, setIncludeKeys] = useState(false);
  // 打包大备份可能要几秒（附件要逐个读成字节），按钮得有个在忙的样子
  const [packing, setPacking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testingEmbed, setTestingEmbed] = useState(false);
  const [embedResult, setEmbedResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (open) setEditingId(settings.activeProfileId);
  }, [open, settings.activeProfileId]);

  useEffect(() => {
    setModels([]);
    setResult(null);
  }, [editingId]);

  if (!open) return null;

  const profile = settings.profiles.find((p) => p.id === editingId) ?? settings.profiles[0]!;
  const patch = (changes: Partial<Profile>) => upsertProfile({ ...profile, ...changes });
  const matchedPreset = PRESETS.find((p) => p.baseUrl === profile.baseUrl.trim());

  const embedding = settings.embedding ?? FALLBACK_EMBEDDING;
  const patchEmbedding = (changes: Partial<EmbeddingSettings>) =>
    updateSettings({ embedding: { ...embedding, ...changes } });

  const describe = (err: unknown) =>
    err instanceof LlmError
      ? err.hint
        ? `${err.message} —— ${err.hint}`
        : err.message
      : ((err as Error)?.message ?? String(err));

  const fetchModels = async () => {
    setBusy('models');
    setResult(null);
    try {
      const list = await listModels(profile);
      setModels(list);
      // 本地服务通常只加载一个模型，直接填上省得手打
      if (list.length === 1 && list[0]) patch({ model: list[0] });
      setResult({ ok: true, text: `拿到 ${list.length} 个模型` });
    } catch (err) {
      setResult({ ok: false, text: describe(err) });
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    setBusy('test');
    setResult(null);
    try {
      let reply = '';
      for await (const chunk of streamChat(profile, [{ role: 'user', content: '说"ok"' }])) {
        reply += chunk.delta ?? '';
        if (reply.length > 20) break;
      }
      setResult({ ok: true, text: `连通了，模型回了：${reply.trim().slice(0, 40) || '（空）'}` });
    } catch (err) {
      setResult({ ok: false, text: describe(err) });
    } finally {
      setBusy(null);
    }
  };

  const testEmbedding = async () => {
    setTestingEmbed(true);
    setEmbedResult(null);
    try {
      const vector = await embedOne(embedding, '连接测试');
      setEmbedResult({ ok: true, text: `连通了，返回 ${vector.length} 维向量` });
    } catch (err) {
      setEmbedResult({
        ok: false,
        text:
          err instanceof EmbeddingError
            ? err.hint
              ? `${err.message} —— ${err.hint}`
              : err.message
            : ((err as Error)?.message ?? String(err)),
      });
    } finally {
      setTestingEmbed(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer right">
        <header className="drawer-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'tab is-active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="drawer-body">
          {tab === 'model' && (
            <>
              <section>
                <h3>配置</h3>
                <p className="hint">
                  可以存多套，在不同分支上用不同模型横向对比。顶栏那个下拉决定新节点用哪一套。
                </p>
                <div className="row">
                  <select
                    className="select grow"
                    value={editingId}
                    onChange={(e) => setEditingId(e.target.value)}
                  >
                    {settings.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn solid"
                    title="新增一套配置"
                    onClick={() => {
                      const created = newProfile();
                      upsertProfile(created);
                      setEditingId(created.id);
                    }}
                  >
                    +
                  </button>
                  <button
                    className="btn danger"
                    disabled={settings.profiles.length <= 1}
                    onClick={() => {
                      removeProfile(profile.id);
                      setEditingId(settings.profiles.find((p) => p.id !== profile.id)!.id);
                    }}
                  >
                    删除
                  </button>
                </div>

                <label>
                  名称
                  <input value={profile.name} onChange={(e) => patch({ name: e.target.value })} />
                </label>
              </section>

              <section>
                <h3>连接</h3>
                <label>
                  服务商预设
                  <select
                    className="select"
                    value=""
                    onChange={(e) => {
                      const preset = PRESETS.find((p) => p.name === e.target.value);
                      if (!preset) return;
                      patch({ name: preset.name, baseUrl: preset.baseUrl, model: preset.model });
                      setModels([]);
                      setResult(null);
                    }}
                  >
                    <option value="">选一个快速填充…</option>
                    <optgroup label="云端服务">
                      {PRESETS.filter((p) => !p.local).map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="本机服务（不需要 API Key）">
                      {PRESETS.filter((p) => p.local).map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>

                <label>
                  Base URL
                  <input
                    value={profile.baseUrl}
                    placeholder="https://api.deepseek.com/v1"
                    onChange={(e) => patch({ baseUrl: e.target.value })}
                  />
                </label>
                {usesLoopbackIp(profile.baseUrl) ? (
                  <p className="hint warn">
                    请把地址里的 IP 改成 <b>localhost</b>。浏览器会拦截 https 页面对
                    http://127.0.0.1 的请求，而 localhost 被当作可信来源不受此限。
                  </p>
                ) : (
                  <p className="hint">大多数服务需要以 /v1 结尾，程序会自动接上 /chat/completions。</p>
                )}

                <label>
                  API Key
                  {isLocalUrl(profile.baseUrl) && (
                    <span className="label-note">本机服务通常留空</span>
                  )}
                  <span className="input-wrap">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={profile.apiKey}
                      placeholder={isLocalUrl(profile.baseUrl) ? '留空表示不发 Authorization 头' : 'sk-…'}
                      autoComplete="off"
                      onChange={(e) => patch({ apiKey: e.target.value })}
                    />
                    <button className="icon-btn inline" onClick={() => setShowKey((v) => !v)}>
                      {showKey ? '隐藏' : '显示'}
                    </button>
                  </span>
                </label>

                <label>
                  模型
                  <span className="input-wrap">
                    <input
                      value={profile.model}
                      list="model-options"
                      placeholder="点右边「拉列表」自动获取"
                      onChange={(e) => patch({ model: e.target.value })}
                    />
                    <button className="icon-btn inline" disabled={busy !== null} onClick={fetchModels}>
                      {busy === 'models' ? '…' : '拉列表'}
                    </button>
                  </span>
                  <datalist id="model-options">
                    {models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>

                <LocalHint baseUrl={profile.baseUrl} command={matchedPreset?.command} />

                <button
                  className="btn primary block"
                  disabled={busy !== null}
                  onClick={testConnection}
                >
                  {busy === 'test' ? '测试中…' : '测试连接'}
                </button>
                {result && <div className={result.ok ? 'result ok' : 'result bad'}>{result.text}</div>}
              </section>

              <section>
                <h3>生成参数</h3>
                <label>
                  温度 <span className="value">{profile.temperature.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={profile.temperature}
                    onChange={(e) => patch({ temperature: Number(e.target.value) })}
                  />
                </label>
                <p className="hint">越低越稳定，越高越发散。多数模型 0.7 左右是个稳妥的起点。</p>

                <label>
                  最大输出 token
                  <input
                    type="number"
                    min={1}
                    value={profile.maxTokens ?? ''}
                    placeholder="留空则用服务端默认"
                    onChange={(e) =>
                      patch({ maxTokens: e.target.value ? Number(e.target.value) : undefined })
                    }
                  />
                </label>
              </section>
            </>
          )}

          {tab === 'knowledge' && (
            <>
              <section>
                <h3>向量服务</h3>
                <p className="hint">
                  知识库靠它把文字变成向量来做语义检索，<b>和聊天用的模型是两回事</b>，
                  要单独起一个服务。默认指向本机 llama.cpp 跑的 bge-m3。
                </p>
                <label>
                  Base URL
                  <input
                    value={embedding.baseUrl}
                    placeholder="http://localhost:8081/v1"
                    onChange={(e) => patchEmbedding({ baseUrl: e.target.value })}
                  />
                </label>
                {usesLoopbackIp(embedding.baseUrl) && (
                  <p className="hint warn">
                    请把地址里的 IP 改成 <b>localhost</b>。浏览器会拦截 https 页面对
                    http://127.0.0.1 的请求，而 localhost 被当作可信来源不受此限。
                  </p>
                )}
                <label>
                  模型名
                  <input
                    value={embedding.model}
                    placeholder="text-embedding-bge-m3"
                    onChange={(e) => patchEmbedding({ model: e.target.value })}
                  />
                </label>
                <label>
                  API Key
                  {isLocalUrl(embedding.baseUrl) && (
                    <span className="label-note">本机服务通常留空</span>
                  )}
                  <input
                    type="password"
                    value={embedding.apiKey}
                    placeholder="留空表示不发 Authorization 头"
                    onChange={(e) => patchEmbedding({ apiKey: e.target.value })}
                  />
                </label>

                {isLocalUrl(embedding.baseUrl) && (
                  <div className="local-hint">
                    <div className="local-hint-head">本机服务</div>
                    <code className="local-cmd">
                      llama-server -m bge-m3.gguf --embedding --embd-normalize 2 --port 8081
                    </code>
                    <ul className="hint list">
                      <li>
                        <b>--embd-normalize 2</b> 不能少。检索用点积代替余弦相似度，
                        向量没归一化排序就会失真 —— 建库时会校验，不对会直接报错而不是给出错的结果
                      </li>
                      <li>模型文件放在外置硬盘上的话，记得先把盘挂上</li>
                    </ul>
                  </div>
                )}

                <button
                  className="btn primary block"
                  disabled={testingEmbed}
                  onClick={() => void testEmbedding()}
                >
                  {testingEmbed ? '连接中…' : '测试连接'}
                </button>
                {embedResult && (
                  <div className={embedResult.ok ? 'result ok' : 'result bad'}>{embedResult.text}</div>
                )}
              </section>

              <section>
                <h3>检索</h3>
                <label>
                  每次提问取前 <span className="value">{embedding.topK} 块</span>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    step={1}
                    value={embedding.topK}
                    onChange={(e) => patchEmbedding({ topK: Number(e.target.value) })}
                  />
                </label>
                <p className="hint">
                  取多了会挤占上下文、也更容易带进不相关的段落；取少了可能漏掉关键资料。
                  具体命中了哪几段，在「上下文预览」里能逐条看到分数。
                </p>
                <p className="hint">
                  资料和向量存在本地 IndexedDB 里，<b>不进导出的备份文件</b>。
                  文件本身在顶栏的「知识库」面板里管理。
                </p>
              </section>
            </>
          )}

          {tab === 'general' && (
            <>
              <section>
                <h3>上下文</h3>
                <label>
                  System 提示词
                  <textarea
                    rows={5}
                    value={settings.systemPrompt}
                    placeholder="会注入到每一次请求最前面；画布上的「系统」节点会追加在它后面。"
                    onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
                  />
                </label>
                <label>
                  条数上限 <span className="value">{settings.contextLimit || '不限'}</span>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={2}
                    value={settings.contextLimit}
                    onChange={(e) => updateSettings({ contextLimit: Number(e.target.value) })}
                  />
                </label>
                <p className="hint">
                  超出上限时丢弃最早的消息，0 表示把整条祖先链都发出去。
                  本机模型受 llama-server 的 <code>-c</code> 限制，上下文太长会直接报错，
                  这时候把上限调下来比较省事。
                </p>
              </section>

              <section>
                <h3>快捷操作</h3>
                <ul className="hint list">
                  <li>双击画布空白处 → 新建游离节点</li>
                  <li>右键空白处 → 新建系统提示 / 批注</li>
                  <li>⌘/Ctrl + Enter → 在提问节点里直接发送</li>
                  <li>⌘/Ctrl + K → 搜索节点内容</li>
                  <li>⌘/Ctrl + Z → 撤销，加 Shift 重做</li>
                  <li>拖节点底部圆点到另一个节点顶部 → 加一条上下文来源（可多父）</li>
                  <li>选中节点 → 高亮显示的就是它会带上的全部上下文</li>
                  <li>Shift + 点 ✕ → 连同所有下游节点一起删</li>
                </ul>
              </section>
            </>
          )}

          {tab === 'data' && (
            <>
              <section>
                <h3>导出</h3>
                <p className="hint">
                  快照存在浏览器同一个数据库里，防的是误删误改；<b>清浏览器数据会连它一起清掉</b>。
                  导出成文件才是真正落在浏览器外面的备份。
                </p>

                <label className="checkbox backup-key-toggle">
                  <input
                    type="checkbox"
                    checked={includeKeys}
                    onChange={(e) => setIncludeKeys(e.target.checked)}
                  />
                  导出时包含 API Key
                </label>
                <p className="hint">
                  {includeKeys
                    ? '文件里会有明文 Key —— 只在自己换设备时用，别发给别人或传到网盘。'
                    : '默认不含 Key，可以安全地当配置模板分享；换设备时对方自己填 Key。'}
                </p>

                <div className="row">
                  <button
                    className="btn solid grow"
                    onClick={() => {
                      downloadJson(exportSettings(includeKeys), backupFilename('nexus-settings'));
                      toast('设置已导出');
                    }}
                  >
                    导出设置
                  </button>
                  <button
                    className="btn solid grow"
                    disabled={packing}
                    onClick={async () => {
                      setPacking(true);
                      try {
                        const { blob, manifest } = await exportArchive(includeKeys);
                        downloadBlob(blob, archiveFilename());
                        const c = manifest.counts;
                        toast(
                          `已打包 ${c.graphs} 个画布 · ${c.attachments} 个附件 · ${c.knowledgeFiles} 份资料`,
                        );
                      } catch (err) {
                        toast(`打包失败：${(err as Error).message}`);
                      } finally {
                        setPacking(false);
                      }
                    }}
                  >
                    {packing ? '打包中…' : '导出全部'}
                  </button>
                </div>
                <p className="hint">
                  「导出全部」打的是 <code>.nexus.zip</code>：画布、设置、
                  <b>附件原件、知识库资料与向量</b> 都在里面，换台电脑导入就是完整的一套。
                  <br />
                  旧版导出的 <code>.json</code> 只有画布和设置 —— 附件和知识库不在其中，
                  用它恢复的话，节点上的图片会指向不存在的文件。那种文件仍然能导入。
                </p>
                <details className="hint-fold">
                  <summary>只要画布和设置的 JSON</summary>
                  <button
                    className="btn"
                    onClick={async () => {
                      const backup = await exportEverything(includeKeys);
                      downloadJson(backup, backupFilename('nexus-backup'));
                      toast(`已导出 ${backup.graphs.length} 个画布和设置（不含附件与知识库）`);
                    }}
                  >
                    导出画布与设置（JSON）
                  </button>
                </details>
              </section>

              <section>
                <h3>导入</h3>
                <p className="hint">
                  走顶栏的 ↑ 按钮，它认得四种文件：完整备份包 <code>.nexus.zip</code>、单个画布、
                  设置、旧版完整备份 JSON。
                  <br />
                  导入设置<b>只会并入没有的模型配置</b>，不覆盖你已有的；要整体替换请用完整备份，
                  那条路径会先自动存一份快照，并且会先报出包里到底有多少东西。
                </p>
              </section>

              <section>
                <h3>数据与隐私</h3>
                <p className="hint">
                  API Key、画布内容、知识库全部只存在这台电脑的浏览器 IndexedDB 里，
                  不经过任何第三方服务器 —— 请求是浏览器直连模型厂商的，用本机模型时连网都不出。
                  清浏览器数据会一起清掉，重要的东西记得用上面的「导出全部」打成{' '}
                  <code>.nexus.zip</code> 放在浏览器外面。
                </p>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
