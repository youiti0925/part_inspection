// =============================================================================
//  driveClient.js — Google Drive 資料フォルダの共通部品(1か所だけ)
// -----------------------------------------------------------------------------
//  もとは App.jsx の中に直書きされていた。📚知識標準(講座)からも同じ物を使うので、
//  **二重実装しないため**にここへ出した。App.jsx は import して従来どおりの名前で使う
//  (呼び出し側のコードは1文字も変わっていない)。
//
//  接続先: .env の VITE_DRIVE_PROXY_URL (無ければ localStorage 'driveProxyUrl')。
//  ⚠どちらも無い＝空文字。その時は画面に「未設定です」と出すこと(押せるのに何も起きない、を作らない)。
//  ⚠アプリは Drive の**フォルダIDを一切持たない**。持っているのは資料ルートからの
//    「フォルダ名の道順」だけ。ルートIDは Worker の secret GDRIVE_ROOT_FOLDER_ID にある。
//    → 新しいフォルダを増やすのに、コード変更も secret 変更も要らない。
// =============================================================================

export const DRIVE_PROXY_URL = String(
  import.meta.env.VITE_DRIVE_PROXY_URL
  || (typeof localStorage !== 'undefined' && localStorage.getItem('driveProxyUrl'))
  || ''
).replace(/\/+$/, '');

/** ファイル本体のURL(Workerが中継する。Drive側のリンク共有ONは不要)。 */
export const driveFileUrl = (id) => `${DRIVE_PROXY_URL}/drive/file?id=${encodeURIComponent(id)}`;

export const driveFmtSize = (n) => {
  if (!n) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${Math.round(n / 1024)}KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`;
  return `${(n / 1073741824).toFixed(2)}GB`;
};

export const driveKindOf = (mime, name) => {
  const m = String(mime || '');
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (m.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  return 'other';
};

export const DRIVE_KIND_ICON = { video: '🎬', pdf: '📄', image: '🖼️', audio: '🔊', other: '📎' };

/**
 * フォルダの中身を読む。⚠**必ず結果を返す**(例外を投げない)。
 *   戻り: { ok, found, missing, files:[{id,name,mimeType,size,modifiedTime,webViewLink}], error }
 *   ・フォルダがまだ無い段は Worker がエラーにせず found:false + missing:'見つからなかった名前' を返す。
 *   ・⚠Worker 側に 60秒のキャッシュがある。「Driveに置いたのに出ない」の大半はこれ。
 *     画面には必ず「反映は最大1分後」と書くこと。
 */
export const driveListFolder = async (path) => {
  if (!DRIVE_PROXY_URL) return { ok: false, found: false, files: [], error: 'Drive連携が未設定です' };
  const p = (Array.isArray(path) ? path : [path]).filter(Boolean).join('/');
  try {
    const res = await fetch(`${DRIVE_PROXY_URL}/drive/list?path=${encodeURIComponent(p)}`);
    const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!j.ok) return { ok: false, found: false, files: [], error: j.error || `HTTP ${res.status}` };
    return { ok: true, found: !!j.found, missing: j.missing || '', files: j.files || [], error: '' };
  } catch (e) {
    return { ok: false, found: false, files: [], error: (e && e.message) || '通信エラー(プロキシに届きません)' };
  }
};

/** Driveのファイルをゴミ箱へ(30日復元可・完全削除はサービスアカウント制約で不可)。 */
export const driveTrashFile = async (id) => {
  if (!DRIVE_PROXY_URL || !id) return false;
  try {
    const res = await fetch(`${DRIVE_PROXY_URL}/drive/trash`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    const j = await res.json().catch(() => ({}));
    return !!j.ok;
  } catch {
    return false;
  }
};
