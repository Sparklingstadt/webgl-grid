// --- ファイルとしてダウンロードさせる ---
export function downloadUrl(href: string, name: string) {
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}
export function download(bytes: Uint8Array, name: string, type = '') {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  downloadUrl(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
