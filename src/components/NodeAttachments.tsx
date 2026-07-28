import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { toast } from '../lib/toast';
import { formatBytes } from '../lib/attachments';

/**
 * 节点上的附件条。
 *
 * 图片显示缩略图，文本文件显示一个带字数的芯片 —— 文本的正文不在这里铺开，
 * 它在发送时才拼进消息里。想确认到底发出去了什么，看「上下文预览」。
 */
export function NodeAttachments({ nodeId }: { nodeId: string }) {
  const attachments = useStore((s) => s.attachments);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const mine = attachments.filter((a) => a.nodeId === nodeId);

  // Blob 要转成 object URL 才能显示，而且用完必须 revoke，否则一直占着内存
  const [urls, setUrls] = useState<Record<string, string>>({});
  const imageKey = mine
    .filter((a) => a.kind === 'image')
    .map((a) => a.id)
    .join(',');

  useEffect(() => {
    const created: Record<string, string> = {};
    for (const att of mine) {
      if (att.kind === 'image') created[att.id] = URL.createObjectURL(att.blob);
    }
    setUrls(created);
    return () => {
      for (const url of Object.values(created)) URL.revokeObjectURL(url);
    };
    // mine 每次渲染都是新数组，用图片 id 列表当依赖才不会来回创建/销毁
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey]);

  if (mine.length === 0) return null;

  return (
    <div className="attach-strip nodrag">
      {mine.map((att) => (
        <div
          key={att.id}
          className={att.kind === 'image' ? 'attach-chip is-image' : 'attach-chip'}
          title={
            att.kind === 'image'
              ? `${att.name} · ${formatBytes(att.size)}`
              : `${att.name} · ${att.text?.length.toLocaleString('zh-CN') ?? 0} 字${att.warning ? `\n${att.warning}` : ''}`
          }
        >
          {att.kind === 'image' && urls[att.id] ? (
            <img src={urls[att.id]} alt={att.name} />
          ) : (
            <span className="attach-name">
              {att.name}
              <span className="attach-meta">
                {att.kind === 'text'
                  ? ` · ${(att.text?.length ?? 0).toLocaleString('zh-CN')} 字`
                  : ` · ${formatBytes(att.size)}`}
              </span>
            </span>
          )}
          <button
            className="attach-remove"
            title="移除这个附件（不可撤销）"
            onClick={() => void removeAttachment(att.id).then(() => toast(`已移除 ${att.name}`))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * 挂附件的按钮。
 *
 * onNeedNode 是给聚焦视图底部那个输入框用的：那里要挂附件的「下一问」
 * 还不存在，附件又必须挂在真实节点上，所以由调用方就地建一个再挂。
 * 节点已经存在时（画布上的节点）不传它即可。
 */
export function AttachButton({
  nodeId,
  onNeedNode,
}: {
  nodeId: string | null;
  onNeedNode?: () => string | null;
}) {
  const addAttachments = useStore((s) => s.addAttachments);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const take = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const target = nodeId ?? onNeedNode?.() ?? null;
    if (!target) return;
    setBusy(true);
    try {
      const { ok, failed } = await addAttachments(target, files);
      if (ok) toast(`已添加 ${ok} 个附件`);
      for (const f of failed) toast(`${f.name}：${f.error}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <>
      <button
        className="btn"
        disabled={busy}
        title="添加图片或文档。图片需要模型支持视觉，文档会在发送时展开成正文"
        onClick={() => inputRef.current?.click()}
      >
        {busy ? '…' : '附件'}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown,.docx,.epub,.csv,.json"
        hidden
        onChange={(e) => void take(e.target.files)}
      />
    </>
  );
}
