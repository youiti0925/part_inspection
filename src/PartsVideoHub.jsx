// 🎬 部品検査の「動画」タブ一式(部品検査・2026-09-27 製品検査から移した E42 / E43 / P165)。
//   製品では App.jsx の中に散らばっていた次の物を、部品では App.jsx を太らせないよう この1枚にまとめた:
//     ・動画の棚(VideoLibrary)… 製品 App.jsx 50591-50606
//     ・編集室(VideoProcessModal autoEditor)/ 手本を見る(RecipePlayer)… 製品 50878-50894
//     ・棚のフォルダを中継に聞く(videoShelves / driveFolders)… 製品 47117-47160
//     ・📱 スマホのカメラ(LiveViewer と 部屋の窓口 LiveRoomContext)… 製品 47071-47110・50051-50075
//     ・スマホ側の撮影ページ(LiveCameraPage + Drive へ入れる)… 製品 47148-47188・49759-49775
//   ⚠ 置き場所の一番上は「部品」(製品は「製品」)。入れる側と読む側は必ず partsVideoFolder() を通す。
//   ⚠ 手本の見せ方(video_recipes)は部品の名前空間(parts-inspection-v1)に入る。製品とは混ざらない。
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { VideoLibrary } from './VideoLibrary.jsx';
import { VideoProcessModal, RecipePlayer, driveUploadFile } from './VideoStudio.jsx';
import { LiveViewer, LiveCameraPage, LiveRoomContext } from './LiveCamera.jsx';
import { DataUsageOpenButton } from './DataUsageTable.jsx';
import { DRIVE_PROXY_URL } from './driveClient.js';
import { WHOLE as WHOLE_TARGET, videoFileName, recordFolderPath } from './domain/liveRecording.js';
import { partsVideoFolder } from './domain/partsVideoFolder.js';

/**
 * 📱 スマホ側(?live=合言葉)の撮影ページ。検査アプリ本体は描かない。
 * ⚠ スマホ側はロットもテンプレも読まないので、置き場所は PC が部屋へ書いた道順(take.folderPath)を使う。
 */
export const PartsLiveCameraPage = ({ roomApi, code, onClose }) => {
  const onUpload = useCallback(async (b, take = null) => {
    if (!DRIVE_PROXY_URL) throw new Error('Driveの設定がされていません（管理者に連絡してください）');
    const target = (take && take.target) || WHOLE_TARGET;
    const path = recordFolderPath({ folderPath: take && take.folderPath, base: partsVideoFolder('') });
    const name = videoFileName({ target, model: '', atMs: Date.now(), ext: /mp4/.test(b.type) ? 'mp4' : 'webm' });
    const f = b instanceof File ? b : new File([b], name, { type: b.type || 'video/webm' });
    const up = await driveUploadFile(f, path, null);
    return { ...up, folder: path.join('/') };
  }, []);
  return <LiveCameraPage roomApi={roomApi} code={code} onUpload={onUpload} onClose={onClose} />;
};

/**
 * 動画タブの中身 + 編集室 + 手本を見る + 📱スマホのカメラ。
 * ⚠ active=false の間も描いておく(📱の画面を小さくして検査画面へ戻れるように。製品と同じ)。
 *   その間は棚を描かず、中継にも聞きに行かない。
 */
export const PartsVideoHub = ({
  active = false,
  roomApi = null,
  recipes = [],
  templates = [],
  lots = [],
  executionLotId = null,
  saveData,
  deleteData,
  onSaveWorkStandard = null,
  currentUserName = '',
}) => {
  const [videoWorkshop, setVideoWorkshop] = useState(null);
  const [videoPlay, setVideoPlay] = useState(null);
  const [driveFolders, setDriveFolders] = useState(null);
  const [driveFoldersWhy, setDriveFoldersWhy] = useState('');
  const [liveOpen, setLiveOpen] = useState(false);
  // 📁 Driveへ入れ終わった合図は、入れた端末(スマホ)でしか立たない。PC側は ↻更新 で読み直す(製品と同じ)。
  const driveSavedAt = 0;

  const saveRecipe = async (id, data) => { await saveData('video_recipes', id, data); };

  const videoShelves = useMemo(() => {
    const seen = new Set();
    const out = [];
    const add = (label, path) => { const k = path.join('/'); if (!k || seen.has(k)) return; seen.add(k); out.push({ label, path }); };
    add('📱 スマホで撮った動画（テンプレが決まっていない分）', partsVideoFolder(''));
    const names = (driveFolders && driveFolders.length)
      ? driveFolders
      : (templates || []).map(t => t && t.name).filter(Boolean);
    names.forEach(n => add(`テンプレ「${n}」`, partsVideoFolder(n)));
    return out;
  }, [driveFolders, templates]);

  useEffect(() => {
    if (!active || !DRIVE_PROXY_URL) return;
    let alive = true;
    (async () => {
      const fallback = (why) => { if (alive) { setDriveFolders([]); setDriveFoldersWhy(why); } };
      try {
        const res = await fetch(`${DRIVE_PROXY_URL}/drive/folders?path=${encodeURIComponent('部品/テンプレ')}`);
        const j = await res.json().catch(() => ({}));
        if (!alive) return;
        if (j && j.ok && Array.isArray(j.folders)) {
          const names = j.folders.map(f => f && f.name).filter(Boolean);
          if (j.found === false) { fallback('Driveにまだ「部品/テンプレ」が在りません。この端末のテンプレの名前から棚を作って出しています。'); return; }
          setDriveFolders(names);
          setDriveFoldersWhy(`Driveの「部品/テンプレ」に実際に在るフォルダ ${names.length}個 を出しています。`);
          return;
        }
        fallback(`Driveのフォルダ一覧を聞けませんでした（${(j && j.error) || `HTTP ${res.status}`}）。この端末のテンプレの名前から棚を作って出しています。`);
      } catch (e) {
        fallback(`Driveのフォルダ一覧を聞けませんでした（${(e && e.message) || e}）。この端末のテンプレの名前から棚を作って出しています。`);
      }
    })();
    return () => { alive = false; };
  }, [active]);

  // 🎥 録画の保存先に出す工程(部品の工程の身元は step.id)。ロットを開いていない時は「全体用」だけ。
  const liveSteps = useMemo(() => {
    const lot = (lots || []).find(l => l && l.id === executionLotId);
    const seen = new Set();
    return (lot && Array.isArray(lot.steps) ? lot.steps : [])
      .filter(s => s && s.id && (s.title || s.name))
      .map(s => ({ id: String(s.id), name: String(s.title || s.name || s.id) }))
      .filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  }, [lots, executionLotId]);
  const liveFolderPath = useMemo(() => {
    const lot = (lots || []).find(l => l && l.id === executionLotId) || null;
    const tplName = ((templates || []).find(t => t && t.id === lot?.templateId)?.name) || '';
    return partsVideoFolder(tplName);
  }, [lots, executionLotId, templates]);

  const liveCtx = useMemo(() => ({
    api: roomApi,
    open: roomApi ? (() => setLiveOpen(true)) : null,
    savedAt: driveSavedAt,
  }), [roomApi, driveSavedAt]);

  return (
    <LiveRoomContext.Provider value={liveCtx}>
      {active && (
        <div className="h-full flex flex-col gap-2">
          <div className="shrink-0 flex items-center gap-2 flex-wrap">
            {roomApi && (
              <button onClick={() => setLiveOpen(true)}
                className="px-3 min-h-[44px] rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-bold"
                title="スマホのカメラをこの画面に映しながら撮る（QRを読ませるだけ。録画はスマホ側なので画質は落ちません）">📱 スマホで撮る</button>
            )}
            <DataUsageOpenButton label="📊 目安" title="10分・20分…と撮ったら、通信がどれだけ要るか／容量がどれだけ残るかの表を開きます"
              className="px-3 min-h-[44px] rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 text-sm font-bold" />
            {driveFoldersWhy && <span className="text-xs text-slate-500">📁 {driveFoldersWhy}</span>}
          </div>
          <div className="flex-1 min-h-0">
            <VideoLibrary
              embedded
              folders={videoShelves}
              moveTargets={videoShelves}
              recipes={recipes}
              proxyUrl={DRIVE_PROXY_URL}
              onOpenEditor={(f) => setVideoWorkshop({ id: f.id, name: f.name || '', size: f.size || 0, recipe: (recipes || []).find(r => r && r.fileId === f.id) || null })}
              onPlay={(f) => { const rc = (recipes || []).find(r => r && r.fileId === f.id) || null; setVideoPlay({ file: { id: f.id, name: f.name || '' }, recipe: rc }); }}
              onDeleteRecipe={(fid) => deleteData('video_recipes', fid)}
              canEdit={!!currentUserName}
            />
          </div>
        </div>
      )}
      {videoWorkshop && (
        <VideoProcessModal
          sections={videoShelves.map(s => ({ label: s.label, path: s.path }))}
          steps={[]} model=""
          preload={{ id: videoWorkshop.id, name: videoWorkshop.name, size: videoWorkshop.size || 0 }}
          preloadRecipe={videoWorkshop.recipe || null} autoEditor
          onSaveRecipe={saveRecipe}
          onSaveWorkStandard={onSaveWorkStandard} userName={currentUserName}
          onDone={() => setVideoWorkshop(null)} onClose={() => setVideoWorkshop(null)} />
      )}
      {videoPlay && (
        <RecipePlayer file={videoPlay.file} recipe={videoPlay.recipe}
          onOpenEditor={(f) => { const rc = videoPlay.recipe; setVideoPlay(null); setVideoWorkshop({ id: f.id, name: f.name || '', size: 0, recipe: rc }); }}
          onClose={() => setVideoPlay(null)} />
      )}
      {liveOpen && roomApi && (
        <LiveViewer roomApi={roomApi} onClose={() => setLiveOpen(false)} steps={liveSteps}
          folderPath={liveFolderPath}
          onDone={({ chapters }) => {
            if (!chapters || !chapters.length) return;
            const NL = String.fromCharCode(10);
            alert(`🚩 立てた要点 ${chapters.length}件` + NL + NL
              + chapters.map(c => `${Math.floor(c.atOut / 60)}:${String(Math.floor(c.atOut % 60)).padStart(2, '0')}  ${c.name}`).join(NL)
              + NL + NL + `動画は Drive の「${liveFolderPath.join(' / ')}」に入っています。`
              + NL + 'アプリの「🎬 動画」タブから見られます。');
          }} />
      )}
    </LiveRoomContext.Provider>
  );
};
