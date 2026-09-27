// =============================================================================
//  DriveFileViewer.jsx — Driveのファイルを画面いっぱいで見せる共通ビューア
// -----------------------------------------------------------------------------
//  もとは App.jsx の DriveDocsModal の中に直書きされていた。📚知識標準(講座)の受講画面も
//  **同じ物**を使う(二重実装しない)。動画/PDF/画像/音声の出し方は、ここ1か所だけにある。
//
//  足したのは3つだけ。既存の呼び出し(DriveDocsModal)は今までと1ミリも変わらない。
//   ① page   … PDFの「Nページ目」。#page=N を付ける。
//      ⚠フラグメントだけ変えても**読み込み済みのiframeは動かない** → key で作り直す。
//      ⚠Firefox や一部Androidの内蔵ビューアは #page= を無視する。効いたら嬉しい程度の物なので、
//        **必ず「Nページ目を見てください」の文字も画面に出す**(効かない端末の人が迷子にならないように)。
//   ② startSec / noSeekForward … 動画の頭出しと「初回だけ早送り禁止」。
//      ⚠duration が Infinity になる端末がある。currentTime=1e7 を1回入れて実長を確定させる
//        (VideoRecipeStudio と同じ小細工。自分で書くと必ずここで踏む)。
//      ⚠⚠この小細工をするのは **startSec>0 か noSeekForward の時だけ**。既定でも掛けると、
//        アプリが上げた webm(MediaRecorder = duration が Infinity)を 📄資料 から開いた時に
//        autoPlay 中の頭が末尾へ飛ぶ。切り出す前(DriveDocsModal)はこれが無かった。
//   ③ 失敗をかならず画面に出す。黙って黒いまま、を作らない。
// =============================================================================
import React, { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { DRIVE_PROXY_URL, driveFileUrl, DRIVE_KIND_ICON } from './driveClient.js';

const fmtT = (s) => {
  if (!Number.isFinite(s)) return '--:--';
  const n = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

/**
 * file: { id, name, mimeType, webViewLink }
 * kind: 'video'|'pdf'|'image'|'audio'|'other'
 * page: PDFのページ番号(1〜)。0/未指定なら先頭。
 * startSec / endSec: 動画の見せたい区間(秒)。endSec で自動停止する。
 * noSeekForward: true の間は「まだ見ていない先」へ飛べない(巻き戻しは自由)。
 * onWatched(sec, dur): 再生位置が動くたび(最大到達点と長さ)。受講画面が「見た」の判定に使う。
 * extra: ヘッダー右側に足したい物(受講画面の「テストへ進む」など)。
 */
export const DriveFileViewer = ({
  file, kind, onClose,
  page = 0, startSec = 0, endSec = 0,
  noSeekForward = false, onWatched = null,
  extra = null, note = '',
}) => {
  const videoRef = useRef(null);
  const maxSeenRef = useRef(0);          // ここまでは実際に見た(早送り禁止の上限)
  const fixingRef = useRef(false);       // duration=Infinity の補正中
  const [err, setErr] = useState('');    // 画面に必ず出す失敗の理由
  const [dur, setDur] = useState(0);
  const [seekMsg, setSeekMsg] = useState('');

  // ⚠別のファイルを開いた時は作り直す(呼ぶ側で key={file.id} を付けること)。
  //   effect の中で setState して作り直すと、開くたびに二度描画する。
  if (!file) return null;
  const src = driveFileUrl(file.id);
  // ⚠PDFは #page=N を付けたURLで**作り直す**。同じ要素のまま src を変えても内蔵ビューアは動かない。
  const pdfSrc = page > 0 ? `${src}#page=${page}` : src;

  const clampForward = (v) => {
    if (!noSeekForward) return;
    const limit = maxSeenRef.current + 1.5; // 1.5秒の遊び(端末のバッファで前後する分)
    if (v.currentTime > limit) {
      v.currentTime = maxSeenRef.current;
      setSeekMsg('はじめの1回は早送りできません（巻き戻しは自由です）');
      window.setTimeout(() => setSeekMsg(''), 2500);
    }
  };

  const onTime = (e) => {
    const v = e.currentTarget;
    if (fixingRef.current) return;
    if (v.currentTime > maxSeenRef.current) maxSeenRef.current = v.currentTime;
    else clampForward(v);
    if (endSec > 0 && v.currentTime >= endSec) { try { v.pause(); } catch { /* noop */ } }
    if (onWatched) onWatched(maxSeenRef.current, Number.isFinite(v.duration) ? v.duration : dur);
  };

  // 頭出し。⚠duration が Infinity の端末では 1e7 を一度入れて実長を確定させてから飛ぶ。
  const onMeta = (e) => {
    const v = e.currentTarget;
    const at = startSec > 0 ? startSec : 0;
    if (Number.isFinite(v.duration) && v.duration > 0) {
      setDur(v.duration);
      if (at > 0) { try { v.currentTime = Math.min(at, v.duration); } catch { /* noop */ } }
      maxSeenRef.current = v.currentTime || 0;
      return;
    }
    // ⚠⚠ここから下(1e7 へのシーク)は**副作用が大きい**。autoPlay 中に末尾へ飛ぶので、
    //   頭が飛ぶ・ended で止まる・プロキシ越しに全体を読みに行って開くのが遅くなる、が起きる。
    //   アプリが自分で上げる教材動画は MediaRecorder の webm = duration が Infinity なので、
    //   **既定(頭出しも早送り禁止も無い)の呼び出しでは必ず踏む**。
    //   実長が要るのは「頭出し(startSec>0)」と「早送り禁止(noSeekForward)」の時だけ。
    //   それ以外(📄資料モーダルからの再生など)は、切り出す前と同じく**何もしない**。
    if (!(at > 0 || noSeekForward)) return;
    fixingRef.current = true;
    const fix = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        v.removeEventListener('timeupdate', fix);
        setDur(v.duration);
        try { v.currentTime = at > 0 ? Math.min(at, v.duration) : 0; } catch { /* noop */ }
        maxSeenRef.current = v.currentTime || 0;
        fixingRef.current = false;
      }
    };
    v.addEventListener('timeupdate', fix);
    try { v.currentTime = 1e7; } catch { fixingRef.current = false; }
  };

  const failText = (what) => `${what}を開けませんでした。`
    + (DRIVE_PROXY_URL ? '通信が届かないか、Drive側でファイルが移動・削除された可能性があります。' : 'Drive連携が未設定です(管理者へ)。')
    + ' 下の「Driveで開く」から直接見ることもできます。';

  return (
    <div className="fixed inset-0 z-[540] bg-black/85 flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between px-4 py-2 text-white shrink-0 gap-2" onClick={e => e.stopPropagation()}>
        <span className="text-sm font-bold truncate min-w-0">{DRIVE_KIND_ICON[kind]} {file.name}</span>
        <div className="flex items-center gap-2 shrink-0">
          {extra}
          {file.webViewLink && <a href={file.webViewLink} target="_blank" rel="noopener noreferrer" className="text-xs bg-white/15 hover:bg-white/25 rounded px-2 py-2 font-bold" onClick={e => e.stopPropagation()}>Driveで開く ↗</a>}
          <button onClick={onClose} className="p-2 rounded hover:bg-white/20" title="閉じる"><X className="w-5 h-5" /></button>
        </div>
      </div>
      {/* 📄 ページ指定・区間指定は**文字でも必ず出す**。内蔵ビューアが #page= を無視する端末があるため。 */}
      {(page > 0 || startSec > 0 || note) && (
        <div className="shrink-0 mx-2 mb-1 rounded-lg bg-amber-100 border border-amber-300 text-amber-900 px-3 py-2 text-sm font-bold flex flex-wrap items-center gap-x-3 gap-y-1" onClick={e => e.stopPropagation()}>
          {page > 0 && <span>📄 <b className="text-base">{page}</b> ページ目を見てください</span>}
          {startSec > 0 && <span>⏱ <b className="text-base">{fmtT(startSec)}</b>{endSec > 0 ? ` 〜 ${fmtT(endSec)}` : ''} のところです</span>}
          {note && <span className="font-normal">{note}</span>}
        </div>
      )}
      {err && (
        <div className="shrink-0 mx-2 mb-1 rounded-lg bg-rose-50 border border-rose-300 text-rose-800 px-3 py-2 text-sm font-bold" onClick={e => e.stopPropagation()}>
          ⚠ {err}
        </div>
      )}
      {seekMsg && (
        <div className="shrink-0 mx-2 mb-1 rounded-lg bg-sky-50 border border-sky-300 text-sky-800 px-3 py-2 text-sm font-bold" onClick={e => e.stopPropagation()}>
          ⏩ {seekMsg}
        </div>
      )}
      <div className="flex-1 min-h-0 flex items-center justify-center p-2" onClick={e => e.stopPropagation()}>
        {kind === 'video' && (
          <video ref={videoRef} controls autoPlay playsInline className="max-w-full max-h-full rounded-lg bg-black" src={src}
            onTimeUpdate={onTime} onLoadedMetadata={onMeta} onSeeking={(e) => clampForward(e.currentTarget)}
            onError={() => setErr(failText('動画'))} />
        )}
        {kind === 'audio' && <audio controls autoPlay src={src} onError={() => setErr(failText('音声'))} />}
        {kind === 'image' && <img alt={file.name} className="max-w-full max-h-full object-contain rounded-lg" src={src} onError={() => setErr(failText('画像'))} />}
        {/* ⚠key に #page を入れて作り直す。src の書き換えだけでは既に読み込んだPDFは動かない。 */}
        {kind === 'pdf' && <iframe key={`${file.id}#${page || 0}`} title={file.name} className="w-full h-full bg-white rounded-lg" src={pdfSrc} onError={() => setErr(failText('PDF'))} />}
        {kind === 'other' && (
          <div className="bg-white rounded-xl p-6 text-center space-y-3 max-w-sm">
            <div className="text-3xl">📎</div>
            <div className="text-sm text-slate-600">この形式はアプリの中では表示できません。下のボタンからDriveで開いてください。</div>
            <div className="flex gap-2 justify-center flex-wrap">
              <a href={src} download={file.name} className="px-3 py-2 bg-sky-600 text-white rounded-lg text-sm font-bold">ダウンロード</a>
              {file.webViewLink && <a href={file.webViewLink} target="_blank" rel="noopener noreferrer" className="px-3 py-2 bg-slate-600 text-white rounded-lg text-sm font-bold">Driveで開く</a>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DriveFileViewer;
