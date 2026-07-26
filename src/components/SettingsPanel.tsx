import { useEffect, useState } from 'react';
import { newProfile, useStore } from '../store/useStore';
import { LlmError, PRESETS, listModels, streamChat } from '../lib/llm';
import { backupFilename } from '../lib/backup';
import { downloadJson } from '../lib/download';
import { toast } from '../lib/toast';
import type { Profile } from '../types';

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const upsertProfile = useStore((s) => s.upsertProfile);
  const removeProfile = useStore((s) => s.removeProfile);
  const exportSettings = useStore((s) => s.exportSettings);
  const exportEverything = useStore((s) => s.exportEverything);

  const [editingId, setEditingId] = useState(settings.activeProfileId);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<'models' | 'test' | null>(null);
  // 默认不含 Key：导出文件最常见的用途是分享配置模板和换设备，带明文 Key 太容易泄漏
  const [includeKeys, setIncludeKeys] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

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

        <div className="drawer-body">
          <section>
            <h3>模型配置</h3>
            <p className="hint">
              可以存多套配置，在不同分支上用不同模型，方便横向对比。
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

            <label>
              服务商预设
              <select
                className="select"
                value=""
                onChange={(e) => {
                  const preset = PRESETS.find((p) => p.name === e.target.value);
                  if (preset) {
                    patch({ name: preset.name, baseUrl: preset.baseUrl, model: preset.model });
                    setModels([]);
                  }
                }}
              >
                <option value="">选一个快速填充…</option>
                {PRESETS.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
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
            <p className="hint">大多数服务需要以 /v1 结尾，程序会自动接上 /chat/completions。</p>

            <label>
              API Key
              <span className="input-wrap">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={profile.apiKey}
                  placeholder="sk-…"
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

            <label>
              最大输出 token（留空则用服务端默认）
              <input
                type="number"
                min={1}
                value={profile.maxTokens ?? ''}
                onChange={(e) =>
                  patch({ maxTokens: e.target.value ? Number(e.target.value) : undefined })
                }
              />
            </label>

            <button className="btn primary block" disabled={busy !== null} onClick={testConnection}>
              {busy === 'test' ? '测试中…' : '测试连接'}
            </button>
            {result && (
              <div className={result.ok ? 'result ok' : 'result bad'}>{result.text}</div>
            )}
          </section>

          <section>
            <h3>全局</h3>
            <label>
              System 提示词
              <textarea
                rows={4}
                value={settings.systemPrompt}
                placeholder="会注入到每一次请求最前面；画布上的「系统」节点会追加在它后面。"
                onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
              />
            </label>
            <label>
              上下文条数上限 <span className="value">{settings.contextLimit || '不限'}</span>
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
              超出上限时丢弃最早的消息。0 表示把整条祖先链都发出去。
            </p>
          </section>

          <section>
            <h3>备份与迁移</h3>
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
                onClick={async () => {
                  const backup = await exportEverything(includeKeys);
                  downloadJson(backup, backupFilename('nexus-backup'));
                  toast(`已导出 ${backup.graphs.length} 个画布和设置`);
                }}
              >
                导出全部
              </button>
            </div>
            <p className="hint">
              导入走顶栏的 ↑ 按钮，它认得三种文件：单个画布、设置、完整备份。
              <br />
              导入设置<b>只会并入没有的模型配置</b>，不覆盖你已有的；要整体替换请用完整备份，
              那条路径会先自动存一份快照。
            </p>
          </section>

          <section>
            <h3>数据与隐私</h3>
            <p className="hint">
              API Key、画布内容全部只存在这台电脑的浏览器 IndexedDB 里，不经过任何第三方服务器 ——
              请求是浏览器直连模型厂商的。清浏览器数据会一起清掉，重要画布记得用「导出」备份。
            </p>
          </section>

          <section>
            <h3>快捷操作</h3>
            <ul className="hint list">
              <li>双击画布空白处 → 新建游离节点</li>
              <li>⌘/Ctrl + Enter → 在提问节点里直接发送</li>
              <li>拖节点底部圆点到另一个节点顶部 → 加一条上下文来源（可多父）</li>
              <li>选中节点 → 高亮显示的就是它会带上的全部上下文</li>
              <li>Shift + 点 ✕ → 连同所有下游节点一起删</li>
            </ul>
          </section>
        </div>
      </aside>
    </>
  );
}
