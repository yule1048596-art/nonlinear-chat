/**
 * 触发浏览器下载。多处要用，抽出来免得各写一遍。
 *
 * 两处看着多余、其实都不能省：
 *
 * - **要挂进文档再点。** 游离的 <a> 在 Chrome 里碰巧能用，但不是所有
 *   浏览器都认。
 * - **revoke 要等一拍。** 点完立刻 revoke 会和浏览器真正去读这个 URL
 *   抢时间 —— 备份包有几十 MB 时尤其明显，表现是「点了没反应」。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

export function downloadJson(data: unknown, filename: string): void {
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
}
