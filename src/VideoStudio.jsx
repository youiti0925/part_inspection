// 🎬 手本動画・編集室・録画・章の小窓(部品検査・2026-09-27 製品検査から移した)。
//   製品 src/App.jsx の 3614-5323 行(VideoProcessModal〜ChapterMiniPlayer)を中身そのままで写し、
//   部品の App.jsx から呼べるように export だけ付けた(import は製品の App.jsx の物を要る分だけ)。
//   ⚠ 置き場所の道(部品/テンプレ/…)は App.jsx の partsVideoFolder で作る。
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { recipeActionAt, recipeEventsOf, clampChapter, chaptersOf } from './domain/videoRecipe.js';
import { addPlayed, watchPatch, watchNote, watchers as watchersOf } from './domain/videoWatchLog.js';
import {
  TRAINING_WARN_SEC, TRAINING_DANGER_SEC,
  subscribeTrainingRecorder, trainingRecorderState, attachTrainingPreview,
  pauseTrainingRecording, resumeTrainingRecording,
} from './trainingRecorder.js';
import { probeSource, hasWebCodecs, fetchToFile } from './videoEngine.js';
import { exportProject, exportJoin, exportSegment, exportEdit } from './videoExport.js';
import { VideoEditor, VideoWordFinder } from './VideoEditor.jsx';
import { wordsFromMap, wordsFromRecipe, sliceWordsMap } from './domain/videoWords.js';
import { chapterSegments as vChapterSegments } from './domain/videoProject.js';
import { loadDraft as vLoadDraft, clearDraft as vClearDraft, matchSources as vMatchSources, savedAgo as vSavedAgo } from './videoDraft.js';
import { videoBox as vboxOf } from './domain/videoBox.js';
import { QUALITY as VQ, segmentsFromCuts, outName as vOutName, progressInfo as vProg, estimateBytes as vEstBytes, fmtBytes as vFmtBytes } from './domain/videoPlan.js';
import { X, Loader2 } from 'lucide-react';
import { RecipeMarks } from './RecipeMarks.jsx';
import { MarkCanvas, MarkList, ShapePicker } from './MarkCanvas.jsx';
import { useLiveOpen, useDriveSaved } from './LiveCamera.jsx';
import { DataUsageOpenButton } from './DataUsageTable.jsx';
import { DRIVE_PROXY_URL, driveFileUrl, driveFmtSize, driveKindOf, DRIVE_KIND_ICON } from './driveClient.js';
import { DriveFileViewer } from './DriveFileViewer.jsx';

const GEMINI_PROXY_URL = String(import.meta.env.VITE_GEMINI_PROXY_URL || '').replace(/\/+$/, '');


// 動画を加工: 圧縮(再エンコードで容量削減)/合体(複数動画を1本に)。canvas.captureStream+MediaRecorderで再録画(ffmpeg不要・実時間)。
// ⚠切り出した動画は Drive に入るだけで、**工程には自動でひも付かない**。
//   今までは資料棚へ戻って1本ずつ「＋この工程に使う」を押す必要があり、本数分の手間だった
//   (清水さん 2026-08-10)。→ 切り出した直後にその場で工程を選べるようにする。
// ⚠⚠ preloadRecipe / autoEditor は 2026-08-16 に足した(清水さん「編集室に統一しろって言ったよね？」)。
//   見せ方(止める・とばす・倍速・頭出し)を付ける場所は **編集室ただ1つ**になったので、
//   preload の動画に付いている見せ方も一緒に持ってきて編集室へ渡す。
//   autoEditor=true なら、この画面を素通りして **すぐ編集室**をひらく。
const VideoProcessModal = ({ sections = [], driveVideos = [], steps = [], model = '', preload = null, preloadRecipe = null, autoEditor = false, onSaveRecipe = null, onSaveWorkStandard = null, userName = '', onDone = null, onClose }) => {
  const [mode, setMode] = useState(autoEditor ? 'studio' : 'compress'); // 'compress' | 'split' | 'concat' | 'studio'
  // ⚠「🎬 編集室でひらく」から来た時は、その動画を **最初から入れておく**。
  //   選び直させると、同じ名前の動画が並んでいる時に必ず取り違える。
  const [files, setFiles] = useState(() => (preload ? [{ name: preload.name || '', size: preload.size || 0, __driveId: preload.id }] : []));
  const [quality, setQuality] = useState('mid');
  const [phase, setPhase] = useState('pick'); // pick|working|done|uploading|error
  const [prog, setProg] = useState(0);
  const [upProg, setUpProg] = useState(0);
  const [err, setErr] = useState('');
  const [outBlob, setOutBlob] = useState(null);
  const [outUrl, setOutUrl] = useState(null);
  const [name, setName] = useState('');
  const [dest, setDest] = useState(0);
  const [splitPoints, setSplitPoints] = useState([]); // 分割の区切り位置(秒)
  const [outSegs, setOutSegs] = useState([]); // 分割結果 [{blob,url,name,dest,saved}]
  // 🔎 書き出した1本に付ける「言葉で探す」索引。⚠⚠ **鍵つきの入れ物(map)** で持つ。
  //   配列にすると、多端末で同じ動画を触った時に後から保存した端末が相手の分を丸ごと消す。
  //   ⚠索引の置き場所は video_recipes の doc しかない。ここで持ち歩かないと、
  //     編集室で書いた急所・作業手順が **保存した瞬間に黙って消える**。
  const [outWords, setOutWords] = useState({});
  const [busyIdx, setBusyIdx] = useState(-1);
  const [previewUrl, setPreviewUrl] = useState('');
  const [eta, setEta] = useState('');            // あと何分(実際の進み方から出す)
  // ✂ いらない区間を消す [{start,end}]。⚠始まりだけ押した状態を cutFrom で持つ
  const [removes, setRemoves] = useState([]);
  const [cutFrom, setCutFrom] = useState(null);
  // 🖼 挟む画像 [{id, at, durationSec, image(File), url, marks, caption}]
  const [inserts, setInserts] = useState([]);
  const [insEdit, setInsEdit] = useState(null);   // いま印を描いている画像の id
  const [insShape, setInsShape] = useState('ellipse');
  const insImgRef = useRef(null);
  const [mute, setMute] = useState(false);       // 音を消して書き出す
  // ✨ 編集室(本格編集)。⚠元動画は先に手元へ落としてから開く(帯の絵・波形・音に要る)
  const [editorOn, setEditorOn] = useState(false);
  const [srcMeta, setSrcMeta] = useState([]);    // [{id,name,size,file,url,durationSec,width,height,driveId}]
  const [editorInit, setEditorInit] = useState(null);   // 作りかけから戻す時の中身
  const [loadingMsg, setLoadingMsg] = useState('');
  const [draft, setDraft] = useState(null);      // 覚えていた作りかけ
  const [outInfo, setOutInfo] = useState(null);  // 出来上がりの中身(長さ・枚数・読み方)
  // 🔍 画面いっぱいで見る動画のURL。
  // ⚠⚠ 出来上がりを **確かめる** 場面で絵が小さいと、倒れている・音が無い・途中で
  //   止まっている、が全部見逃される(2026-08-15 清水さん「小さくて見えないよ」)。
  //   選ぶ画面は幅512pxで良いが、確かめる画面は画面の大きさに合わせる。
  const [bigUrl, setBigUrl] = useState('');
  // 🔄 回転。0/90/180/270。⚠既定0＝今までと同じ。
  //   ⚠⚠ 前は exportSegment/exportEdit/exportJoin が rotate:0 固定の
  //   emptyProject() を作っていたので、**編集室を開かない限り絶対に回せなかった**。
  const [rotate, setRotate] = useState(0);
  const abortRef = useRef(null);                 // 途中でやめる
  const [curT, setCurT] = useState(0);
  const [srcDur, setSrcDur] = useState(0);
  const canvasRef = useRef(null);
  const previewRef = useRef(null);
  const QMAP = { high: { w: 1280, vbr: 2500000, label: '高画質(大きめ)' }, mid: { w: 854, vbr: 1200000, label: '標準(おすすめ)' }, low: { w: 640, vbr: 650000, label: '軽量(小さい)' } };
  const singleMode = mode === 'compress' || mode === 'split' || mode === 'cut' || mode === 'image';
  const addFiles = (e) => { const fs = [...(e.target.files || [])]; if (fs.length) setFiles(prev => singleMode ? fs.slice(0, 1) : [...prev, ...fs]); e.target.value = ''; };
  const addDrive = (v) => { const item = { name: v.name, size: v.size || 0, __driveId: v.id }; setFiles(prev => singleMode ? [item] : [...prev, item]); };
  const moveFile = (i, dir) => setFiles(prev => { const j = i + dir; if (j < 0 || j >= prev.length) return prev; const n = [...prev]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const rmFile = (i) => setFiles(prev => prev.filter((_, j) => j !== i));
  const pickMime = () => { const c = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']; return (window.MediaRecorder && c.find(m => MediaRecorder.isTypeSupported(m))) || ''; };
  const loadVideo = (item) => new Promise((res, rej) => { const v = document.createElement('video'); v.preload = 'auto'; v.muted = true; v.playsInline = true; if (item.__driveId) { v.crossOrigin = 'anonymous'; v.src = driveFileUrl(item.__driveId); } else { v.src = URL.createObjectURL(item); } v.onloadedmetadata = () => res(v); v.onerror = () => rej(new Error('動画を読み込めません: ' + (item.name || '') + (item.__driveId ? '（Drive動画の読込に失敗。端末の動画で試してください）' : ''))); });
  // 🎬 圧縮 / 合体。⚠中身を WebCodecs + MP4 に入れ替えた(2026-08-13)。
  //   前は canvas.captureStream + MediaRecorder で **実時間** 録り直していた。
  //   出来上がりの WebM は長さが Infinity で、「◯分と出るのに途中で止まる」の元だった。
  const run = async () => {
    if (!files.length) { setErr('動画を選んでください'); return; }
    if (mode === 'concat' && files.length < 2) { setErr('合体には2本以上選んでください'); return; }
    if (!hasWebCodecs()) { setErr('このブラウザでは動画を加工できません（Chrome か Edge の新しい版でお試しください）'); return; }
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase('working'); setProg(0); setErr(''); setEta('');
    setOutWords({});   // ⚠編集室を通していない道。前回の索引を別の動画に付けない
    const t0 = Date.now();
    const onProgress = (r) => { setProg(r); const pi = vProg(r, 1, Date.now() - t0); setEta(pi.etaText); };
    try {
      let out;
      if (mode === 'concat') {
        out = await exportJoin(files.map(f => ({ source: f.__driveId ? driveFileUrl(f.__driveId) : f })),
          { quality, mute, rotate, signal: ac.signal, onProgress });
      } else {
        const src = files[0].__driveId ? driveFileUrl(files[0].__driveId) : files[0];
        const pr = await probeSource(src);
        if (!pr.durationSec) throw new Error(pr.error || 'この動画の長さを取り出せません');
        out = await exportSegment({ source: src, start: 0, end: pr.durationSec, quality, mute, rotate, signal: ac.signal, onProgress });
      }
      setOutBlob(out.blob); setOutUrl(URL.createObjectURL(out.blob)); setOutInfo(out);
      setProg(1); setEta(''); setPhase('done');
      if (!name.trim()) setName(mode === 'concat' ? '合体動画' : '圧縮動画');
    } catch (e) {
      if (e && e.name === 'AbortError') { setPhase('pick'); setErr(''); return; }
      setErr(String(e?.message || e)); setPhase('error');
    } finally { abortRef.current = null; }
  };
  const fmtT = (s) => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
  const updateSeg = (i, patch) => setOutSegs(prev => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addCut = () => { const t = Math.round(((previewRef.current?.currentTime) || 0) * 100) / 100; if (t <= 0.15) return; setSplitPoints(prev => (prev.some(p => Math.abs(p - t) < 0.3) ? prev : [...prev, t])); };
  const rmCut = (t) => setSplitPoints(prev => prev.filter(p => p !== t));
  const segList = () => { const dur = srcDur || 0; const pts = [...new Set(splitPoints)].filter(t => t > 0.15 && (!dur || t < dur - 0.15)).sort((a, b) => a - b); const b = [0, ...pts, ...(dur ? [dur] : [])]; const out = []; for (let i = 0; i < b.length - 1; i++) out.push([b[i], b[i + 1]]); return out; };
  const onPreviewMeta = (e) => { const v = e.target; setSrcDur(isFinite(v.duration) && v.duration > 0 ? v.duration : 0); };
  useEffect(() => {
    if (!['split', 'cut', 'image'].includes(mode) || !files[0]) { setPreviewUrl(''); setCurT(0); setSrcDur(0); return; }
    const f = files[0];
    if (f.__driveId) { setPreviewUrl(driveFileUrl(f.__driveId)); return; }
    const u = URL.createObjectURL(f); setPreviewUrl(u);
    return () => { try { URL.revokeObjectURL(u); } catch (e) { /* noop */ } };
  }, [files, mode]);
  // 💾 作りかけがあれば知らせる(市場調査でいちばん効く機能。現場の端末は必ず落ちる)
  useEffect(() => { (async () => { const d = await vLoadDraft(); if (d) setDraft(d); })(); }, []);

  /** 選んだ動画を手元に落として下調べ → 編集室をひらく。 */
  const openEditor = async (initial = null, presetFiles = null) => {
    const list = presetFiles || files;
    if (!list.length) { setErr('動画を選んでください'); return; }
    if (!hasWebCodecs()) { setErr('このブラウザでは動画を加工できません（Chrome か Edge の新しい版でお試しください）'); return; }
    setErr(''); setLoadingMsg('動画を読み込んでいます…');
    try {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        // ⚠⚠ **落とす大きさを必ず出す。** Driveの動画は先に手元へ全部落とすので、
        //   大きい動画だと1分以上ここで待つ。何MB待たされるのか出さないと
        //   「押したのに何も起きない」に見える(清水さん 2026-08-15)。
        setLoadingMsg(`動画を読み込んでいます… (${i + 1}/${list.length})${f.size ? ` ${vFmtBytes(f.size)}` : ''}`);
        // ⚠Driveの動画はURLのままだと音が消え、帯の絵も波形も作れない。先に手元へ。
        const file = f.__driveId ? await fetchToFile(driveFileUrl(f.__driveId), f.name || 'video.mp4') : f;
        const pr = await probeSource(file);
        if (!pr.durationSec) throw new Error(`「${f.name || '動画'}」の長さを取り出せません`);
        out.push({
          id: f.__srcId || `s${i + 1}`, name: f.name || `動画${i + 1}`, size: file.size || 0, file,
          url: URL.createObjectURL(file), durationSec: pr.durationSec, width: pr.width, height: pr.height,
          driveId: f.__driveId || '',
        });
      }
      setSrcMeta(out);
      setEditorInit(initial);
      setEditorOn(true);
    } catch (e) { setErr(String(e?.message || e)); }
    finally { setLoadingMsg(''); }
  };

  // 🎬 「編集室でひらく」から来た時は、この加工画面を素通りして **そのまま編集室**へ。
  // ⚠⚠ 1回だけ。旗(autoRef)で押さえないと、読み込みの途中で描き直されるたびに
  //   同じ動画をDriveから何度も落としに行く。
  const autoRef = useRef(false);
  useEffect(() => {
    if (!autoEditor || autoRef.current) return;
    if (!preload || !preload.id) return;
    autoRef.current = true;
    openEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditor, preload]);

  /**
   * 👁 見せ方(止める・とばす・倍速・頭出し)の保存口。編集室(共通ファイル)へ渡す。
   * ⚠⚠ **model を書くかどうかは、アプリごとに違う。だから ここ(呼ぶ側)で付ける。**
   *   最終検査(golden)は書かない … 書くと全型式共通の手本が型式専用に化けて🎬が消える。
   *   製品検査(product)は書く   … ただし **いま付いている値をそのまま書き戻す**。
   *   `model` の prop(いま開いている型式)を書くと、共通の手本が黙って型式専用になる。
   * ⚠chapters と stepKeys を必ずセットで書くのは編集室(VideoEditor.saveShow)の仕事。
   */
  const saveRecipeDoc = (onSaveRecipe && preload && preload.id)
    ? (async (d) => { await onSaveRecipe(d.fileId, { ...d, model: (preloadRecipe && preloadRecipe.model) || '' }); })
    : null;

  /** 💾 作りかけから戻す。Driveの動画は自動で取り直し、端末の動画は選び直してもらう。 */
  const resumeDraft = async (pickedFiles = null) => {
    if (!draft) return;
    const saved = draft.sources || [];
    const fromDrive = saved.filter(x => x.driveId).map(x => ({ name: x.name, size: x.size, __driveId: x.driveId, __srcId: x.id }));
    const needLocal = saved.filter(x => !x.driveId);
    if (needLocal.length && !pickedFiles) { setErr(''); setDraft({ ...draft, needPick: needLocal }); return; }
    const m = pickedFiles ? vMatchSources(needLocal, pickedFiles) : { ready: [], missing: needLocal };
    if (m.missing.length) { setErr(`同じ動画が見つかりません: ${m.missing.map(x => x.name).join(' / ')}`); return; }
    const local = m.ready.map(r => { const f = r.file; f.__srcId = r.id; return f; });
    // ⚠覚えていた順に戻す(順番が変わると部品の並びが入れ替わる)
    const byId = {};
    [...fromDrive, ...local].forEach(f => { byId[f.__srcId] = f; });
    const ordered = saved.map(x => byId[x.id]).filter(Boolean);
    if (ordered.length !== saved.length) { setErr('元の動画がそろいませんでした'); return; }
    setDraft(null);
    await openEditor({ project: draft.project, images: draft.images || {}, chapters: draft.chapters || [] }, ordered);
  };

  /**
   * ▶ 編集室からの書き出し。章があれば工程ごとに分けて出す。
   * ⚠⚠ words(🔎言葉で探す索引)を **必ず受け取る**。受け取らないと、編集室で書いた
   *   急所・作業手順・章の名前が書き出した瞬間に消える(作りかけも一緒に消えるため)。
   */
  const runProject = async ({ project, images, chapters, words }) => {
    const wordsIn = words && typeof words === 'object' && !Array.isArray(words) ? words : {};
    const ac = new AbortController();
    abortRef.current = ac;
    setEditorOn(false);
    setPhase('working'); setProg(0); setErr(''); setEta('');
    const t0 = Date.now();
    const sourcesMap = {};
    srcMeta.forEach(x => { sourcesMap[x.id] = x.file; });
    try {
      const segs = (chapters || []).length ? vChapterSegments(project, chapters) : [];
      if (segs.length > 1) {
        const total = segs.reduce((a, x) => a + (x.to - x.from), 0);
        const results = []; let done = 0;
        for (const sg of segs) {
          const out = await exportProject(project, {
            sources: sourcesMap, images, quality, signal: ac.signal, range: { from: sg.from, to: sg.to },
            onProgress: (r) => { const p2 = (done + r * (sg.to - sg.from)) / total; setProg(p2); setEta(vProg(p2, 1, Date.now() - t0).etaText); },
          });
          done += (sg.to - sg.from);
          results.push({
            blob: out.blob, url: URL.createObjectURL(out.blob),
            name: sg.name || `区間${results.length + 1}`, dest: 0, stepKey: '', saved: false,
            durationSec: out.durationSec, bytes: out.blob.size, span: sg,
            // ⚠⚠ 索引の秒は「合体後の通し秒」。区間ごとの別ファイルでは 0秒から数え直しなので、
            //   sg.from を引いて作り直す。引かないと押した先が **全然違う場面** になる
            //   (しかも黙ってズレるので、押した人には気づけない)。
            words: sliceWordsMap(wordsIn, sg.from, sg.to),
          });
        }
        setOutSegs(results); setOutWords({}); setProg(1); setEta(''); setPhase('done');
        vClearDraft();
        return;
      }
      const out = await exportProject(project, {
        sources: sourcesMap, images, quality, signal: ac.signal,
        onProgress: (r) => { setProg(r); setEta(vProg(r, 1, Date.now() - t0).etaText); },
      });
      setOutBlob(out.blob); setOutUrl(URL.createObjectURL(out.blob)); setOutInfo(out);
      setOutWords(wordsIn);          // 🔎 Driveへ保存する時に video_recipes へ一緒に書く
      setProg(1); setEta(''); setPhase('done');
      if (!name.trim()) setName((srcMeta[0]?.name || '編集した動画').replace(/\.[^.]+$/, '') + '_編集');
      vClearDraft();
    } catch (e) {
      if (e && e.name === 'AbortError') { setPhase('pick'); setErr(''); setEditorOn(true); return; }
      setErr(String(e?.message || e)); setPhase('error');
    } finally { abortRef.current = null; }
  };

  // ✂🖼 いらない区間を消す / 画像を挟む。engine の exportEdit(音も残す)を通す。
  //   ⚠出来上がりは1本。工程へのひも付けは既存の「切り出した直後に工程を選ぶ」と同じ流れに乗せる。
  const runEdit = async () => {
    if (!files.length) { setErr('動画を選んでください'); return; }
    if (!hasWebCodecs()) { setErr('このブラウザでは動画を加工できません（Chrome か Edge の新しい版でお試しください）'); return; }
    if (mode === 'cut' && !removes.length) { setErr('消す区間を1つ以上入れてください'); return; }
    if (mode === 'image' && !inserts.length) { setErr('挟む画像を1つ以上入れてください'); return; }
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase('working'); setProg(0); setErr(''); setEta('');
    setOutWords({});   // ⚠編集室を通していない道。前回の索引を別の動画に付けない
    const t0 = Date.now();
    try {
      const src = files[0].__driveId ? driveFileUrl(files[0].__driveId) : files[0];
      const out = await exportEdit({
        source: src,
        removes: mode === 'image' ? [] : removes,
        inserts: mode === 'cut' ? [] : inserts.map(x => ({ at: x.at, durationSec: x.durationSec, image: x.image, marks: x.marks, caption: x.caption })),
        quality, mute, rotate, signal: ac.signal,
        onProgress: (r) => { setProg(r); setEta(vProg(r, 1, Date.now() - t0).etaText); },
      });
      setOutBlob(out.blob); setOutUrl(URL.createObjectURL(out.blob)); setOutInfo(out);
      setProg(1); setEta(''); setPhase('done');
      if (!name.trim()) setName(mode === 'cut' ? '編集した動画' : '説明を入れた動画');
    } catch (e) {
      if (e && e.name === 'AbortError') { setPhase('pick'); setErr(''); return; }
      setErr(String(e?.message || e)); setPhase('error');
    } finally { abortRef.current = null; }
  };

  // ✂ 分割。⚠1区間ずつ独立して書き出す(前は1本のMediaStreamを使い回して2本目が壊れていた)。
  const runSplit = async () => {
    if (!files.length) { setErr('動画を選んでください'); return; }
    if (!hasWebCodecs()) { setErr('このブラウザでは動画を加工できません（Chrome か Edge の新しい版でお試しください）'); return; }
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase('working'); setProg(0); setErr(''); setEta('');
    const t0 = Date.now();
    try {
      const src = files[0].__driveId ? driveFileUrl(files[0].__driveId) : files[0];
      setOutWords({});   // ⚠編集室を通していない道。前回の索引を別の動画に付けない
      const pr = await probeSource(src);
      if (!pr.durationSec) throw new Error(pr.error || 'この動画の長さを取り出せません（別の動画でお試しください）');
      const segs = segmentsFromCuts(pr.durationSec, splitPoints);
      if (segs.length < 2) throw new Error('区切り位置を1つ以上、動画の途中に入れてください');
      const baseName = (name.trim() || (files[0].name || '動画').replace(/\.[^.]+$/, '') || '分割');
      const total = segs.reduce((a, x) => a + x.duration, 0);
      const results = []; let done = 0;
      for (const sg of segs) {
        const out = await exportSegment({
          source: src, start: sg.start, end: sg.end, quality, mute, rotate, signal: ac.signal,
          onProgress: (r) => { const p2 = (done + r * sg.duration) / total; setProg(p2); setEta(vProg(p2, 1, Date.now() - t0).etaText); },
        });
        done += sg.duration;
        results.push({
          blob: out.blob, url: URL.createObjectURL(out.blob),
          name: vOutName(baseName, sg.index, segs.length).replace(/\.mp4$/, ''),
          dest: 0, stepKey: '', saved: false,
          durationSec: out.durationSec, bytes: out.blob.size, span: sg,
        });
      }
      setOutSegs(results); setProg(1); setEta(''); setPhase('done');
    } catch (e) {
      if (e && e.name === 'AbortError') { setPhase('pick'); setErr(''); return; }
      setErr(String(e?.message || e)); setPhase('error');
    } finally { abortRef.current = null; }
  };
  const doUploadSeg = async (i) => {
    const sg = outSegs[i]; if (!sg || !sections[sg.dest]) return;
    setBusyIdx(i); setErr('');
    try {
      const ext = 'mp4';   // 🎬出力はMP4に統一(どの端末でも再生できる)
      const b = (sg.name.trim() || '分割動画').replace(/[\\/:*?"<>|]/g, '_');
      const d = new Date();
      const fname = `${b}_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.${ext}`;
      const up = await driveUploadFile(new File([sg.blob], fname, { type: 'video/mp4' }), sections[sg.dest].path, () => {});
      // 🎬工程にひも付ける。⚠Driveのidが返ってこない時は黙って諦めず、保存はできた旨と
      //   「資料棚から手でひも付けてください」を出す(ひも付いたつもりで🎬が出ないのが一番困る)。
      // 🔎 ⚠⚠ 索引(words)の置き場所は video_recipes の doc しかない。だから
      //   **工程を選んでいなくても、索引があるならレシピを作る**。作らないと、編集室で
      //   書いた急所が保存した瞬間に消える。秒は sliceWordsMap でこの1本の頭から数え直し済み。
      const segWords = sg.words && Object.keys(sg.words).length ? sg.words : null;
      if ((sg.stepKey || segWords) && onSaveRecipe) {
        const fid = up && (up.id || up.fileId);
        if (fid) {
          const label = (steps.find(x => x.key === sg.stepKey) || {}).label || '';
          await onSaveRecipe(fid, {
            fileId: fid, fileName: fname, title: sg.name.trim() || label, model: model || '',
            stepKeys: sg.stepKey ? [sg.stepKey] : [], events: [],
            ...(segWords ? { words: segWords } : {}),
          });
        } else {
          setErr(sg.stepKey
            ? 'Driveへは保存できましたが、工程へのひも付けができませんでした。資料棚から「＋この工程に使う」で付けてください。'
            : 'Driveへは保存できましたが、🔎言葉で探すの索引を残せませんでした（Driveのidが返りませんでした）。');
        }
      }
      updateSeg(i, { saved: true });
    } catch (e) { setErr('保存失敗: ' + (e?.message || e)); }
    finally { setBusyIdx(-1); }
  };
  const resetSplit = () => { outSegs.forEach(s => { try { URL.revokeObjectURL(s.url); } catch (e) { /* noop */ } }); setOutSegs([]); setSplitPoints([]); setPhase('pick'); };
  const finishSplit = () => { outSegs.forEach(s => { try { URL.revokeObjectURL(s.url); } catch (e) { /* noop */ } }); (onDone ? onDone() : onClose()); };
  const doUpload = async () => {
    if (!outBlob || !sections[dest]) return;
    const ext = 'mp4';   // 🎬出力はMP4に統一
    const b = (name.trim() || '加工動画').replace(/[\\/:*?"<>|]/g, '_');
    const d = new Date();
    const fname = `${b}_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.${ext}`;
    setPhase('uploading'); setUpProg(0);
    try {
      const up = await driveUploadFile(new File([outBlob], fname, { type: 'video/mp4' }), sections[dest].path, setUpProg);
      // 🔎 ⚠⚠ 1本もの(章なし)でも、索引があるなら **ここでレシピを作る**。
      //   索引の置き場所は video_recipes の doc しかない。作らないと、編集室で書いた
      //   急所・作業手順が保存した瞬間に消える(作りかけも書き出しで消えるため)。
      //   ⚠工程へのひも付けは今までどおり後から資料棚の「＋この工程に使う」で行う。
      const fid = up && (up.id || up.fileId);
      if (fid && onSaveRecipe && Object.keys(outWords).length) {
        try {
          await onSaveRecipe(fid, { fileId: fid, fileName: fname, title: name.trim() || '', model: model || '', stepKeys: [], events: [], words: outWords });
        } catch (e2) {
          // ⚠黙らない。動画は入っているのに🔎だけ効かない状態は、押した人には区別が付かない。
          alert('Driveへは保存できましたが、🔎「言葉で探す」の索引を残せませんでした: ' + (e2?.message || e2));
        }
      }
      onDone && onDone(up);
    }
    catch (e) { setErr('アップロード失敗: ' + (e?.message || e)); setPhase('error'); }
  };
  return (
    <div className="fixed inset-0 z-[570] bg-black/90 flex flex-col items-center justify-center p-3" onClick={(e) => e.stopPropagation()}>
      {/* ⚠⚠ 出来上がりを確かめている間は **枠を広げる**。
          幅512pxのままだと、縦向き(9:16)の動画は高さで頭打ちして
          絵の幅が 243px まで痩せる(実測)。「小さくて見えない」の正体はこれ。 */}
      <div className={`w-full ${phase === 'done' || ['image', 'split', 'cut'].includes(mode) ? 'max-w-5xl' : 'max-w-lg'} bg-white rounded-xl p-3 space-y-2 max-h-[92vh] overflow-y-auto`}>
        <div className="flex items-center justify-between">
          <span className="font-bold text-sm text-slate-800">🛠 動画を編集・加工</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        {/* ⚠5つに増えたので2段。現場の言葉で書く(「トリム」「クロップ」等の横文字を使わない) */}
        {/* ✨ 本格編集を主役に。⚠今までの1手モードも残す(すぐ終わる用があるため) */}
        <button onClick={() => { setMode('studio'); setSplitPoints([]); setRemoves([]); setCutFrom(null); setInserts([]); setErr(''); }}
          className={`w-full py-2.5 rounded-xl font-bold text-sm ${mode === 'studio' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'}`}>
          ✨ 編集室でしっかり編集
          <span className="block fi-tap-text font-normal opacity-80">切る・消す・並べ替え・速さ・〇や文字・目隠し・画像はさみ を1画面で</span>
        </button>
        <div className="grid grid-cols-3 gap-1.5">
          {[
            ['cut', '✂ いらない所を消す', '雑談・待ち時間を抜く', 'bg-rose-600'],
            ['image', '🖼 画像を挟む', 'PC画面の説明を入れる', 'bg-violet-600'],
            ['split', '✁ 分ける', '1本→工程ごとに', 'bg-indigo-600'],
            ['compress', '📉 軽くする', '容量を小さく', 'bg-sky-600'],
            ['concat', '🔗 つなげる', '複数→1本に', 'bg-sky-600'],
          ].map(([m, label, sub, color]) => (
            <button key={m}
              onClick={() => { setMode(m); setFiles([]); setSplitPoints([]); setRemoves([]); setCutFrom(null); setInserts([]); setErr(''); }}
              className={`py-2 rounded-lg font-bold fi-tap-text leading-tight ${mode === m ? `${color} text-white` : 'bg-slate-100 text-slate-600'}`}>
              {label}<span className="block fi-tap-text font-normal opacity-80">{sub}</span>
            </button>
          ))}
        </div>
        {phase === 'pick' && (<>
          <label className="block w-full text-center py-3 border-2 border-dashed border-slate-300 rounded-lg text-sm font-bold text-slate-500 cursor-pointer hover:bg-slate-50">
            {mode === 'concat' ? '📁 端末の動画から選ぶ（複数可・上から順に繋がります）' : (mode === 'split' ? '📁 分割したい動画を選ぶ（1本）' : '📁 端末の動画から選ぶ')}
            <input type="file" accept="video/*" multiple={mode === 'concat'} className="hidden" onChange={addFiles} />
          </label>
          {driveVideos.length > 0 && (
            <div>
              <div className="fi-tap-text font-bold text-slate-500 mb-1">☁ Driveの動画から選ぶ（{mode === 'concat' ? '複数タップで追加' : '1本'}）</div>
              <div className="max-h-32 overflow-y-auto space-y-1 border border-slate-200 rounded p-1">
                {driveVideos.map(v => (
                  <button key={v.id} onClick={() => addDrive(v)} className="w-full text-left px-2 py-1.5 rounded bg-sky-50 hover:bg-sky-100 border border-sky-200 text-xs font-bold text-sky-700 truncate">🎬 {v.name} <span className="text-slate-400 font-normal">({driveFmtSize(v.size)})</span></button>
                ))}
              </div>
            </div>
          )}
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-2 text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1.5">
              <span className="font-bold text-slate-400">{i + 1}</span>
              <span className="flex-1 min-w-0 truncate">{f.name} <span className="text-slate-400">({driveFmtSize(f.size)})</span></span>
              {mode === 'concat' && <><button onClick={() => moveFile(i, -1)} className="text-slate-400 px-1">↑</button><button onClick={() => moveFile(i, 1)} className="text-slate-400 px-1">↓</button></>}
              <button onClick={() => rmFile(i)} className="text-rose-500 px-1">✕</button>
            </div>
          ))}
          {['split', 'cut', 'image'].includes(mode) && files.length > 0 && previewUrl && (
            <div className="space-y-1.5 border border-indigo-200 bg-indigo-50/60 rounded-lg p-2">
              {/* ⚠ここで区切り位置を決める。高さを持たせて object-contain にしないと、
                  縦向きの動画が痩せて **どこで切るかが見えない** */}
              <video ref={previewRef} src={previewUrl} crossOrigin="anonymous" controls playsInline onLoadedMetadata={onPreviewMeta} onTimeUpdate={(e) => setCurT(e.target.currentTime || 0)} className="w-full h-[42vh] object-contain rounded bg-black" />
              {mode === 'split' && (
                <button onClick={addCut} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg py-2 font-bold text-sm">✁ 今の位置で分ける（{fmtT(curT)}{srcDur > 0 ? ` / ${fmtT(srcDur)}` : ''}）</button>
              )}
              {/* ✂ いらない区間を消す: 始まり → 終わり の2回押し。⚠1回押しでは区間にならない */}
              {mode === 'cut' && (
                cutFrom == null ? (
                  <button onClick={() => setCutFrom(Math.round((previewRef.current?.currentTime || 0) * 100) / 100)}
                    className="w-full bg-rose-600 hover:bg-rose-500 text-white rounded-lg py-2.5 font-bold text-sm">
                    ✂ ここから消す（{fmtT(curT)}）
                  </button>
                ) : (
                  <div className="flex gap-1.5">
                    <button onClick={() => {
                      const to = Math.round((previewRef.current?.currentTime || 0) * 100) / 100;
                      if (to <= cutFrom + 0.2) { setErr('終わりは始まりより後にしてください（少し再生を進めてから押す）'); return; }
                      setRemoves(prev => [...prev, { start: cutFrom, end: to }]); setCutFrom(null); setErr('');
                    }} className="flex-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg py-2.5 font-bold text-sm">
                      ✂ ここまで消す（{fmtT(cutFrom)} 〜 {fmtT(curT)}）
                    </button>
                    <button onClick={() => setCutFrom(null)} className="px-3 rounded-lg border border-slate-300 text-slate-600 font-bold text-xs">やめる</button>
                  </div>
                )
              )}
              {/* 🖼 画像を挟む */}
              {mode === 'image' && (
                <label className="block w-full bg-violet-600 hover:bg-violet-500 text-white rounded-lg py-2.5 font-bold text-sm text-center cursor-pointer">
                  🖼 いまの位置（{fmtT(curT)}）に画像を挟む
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                    const f = (e.target.files || [])[0]; e.target.value = '';
                    if (!f) return;
                    const id = `ins_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    const at = Math.round((previewRef.current?.currentTime || 0) * 100) / 100;
                    setInserts(prev => [...prev, { id, at, durationSec: 5, image: f, url: URL.createObjectURL(f), marks: [], caption: '' }]);
                    setInsEdit(id);
                  }} />
                </label>
              )}
              {mode === 'split' && ([...new Set(splitPoints)].length > 0 ? (
                <div className="space-y-1">
                  <div className="fi-tap-text font-bold text-indigo-700">区切り {[...new Set(splitPoints)].length}個 → {[...new Set(splitPoints)].length + 1}本に分割</div>
                  <div className="flex flex-wrap gap-1">
                    {[...new Set(splitPoints)].sort((a, b) => a - b).map((t, i) => (
                      <span key={i} className="inline-flex items-center gap-1 bg-white border border-indigo-300 rounded-full pl-2 pr-1 py-0.5 fi-tap-text font-bold text-indigo-700">✂ {fmtT(t)}<button onClick={() => rmCut(t)} className="text-rose-500 px-0.5">✕</button></span>
                    ))}
                  </div>
                  {srcDur > 0 && (<div className="fi-tap-text text-slate-500 space-y-0.5 pt-0.5">{segList().map((s, i) => (<div key={i}>区間{i + 1}: {fmtT(s[0])} 〜 {fmtT(s[1])}（{fmtT(s[1] - s[0])}）</div>))}</div>)}
                </div>
              ) : (<div className="fi-tap-text text-slate-500">▶ 動画を再生し、分けたい所で「✁ 今の位置で分ける」を押します。区切りの数だけ別々の動画に分かれます。</div>))}

              {/* ✂ 消す区間の一覧 + 帯 */}
              {mode === 'cut' && (
                <div className="space-y-1">
                  {srcDur > 0 && (
                    <div className="relative h-4 rounded bg-slate-200 overflow-hidden">
                      {removes.map((r, i) => (
                        <span key={i} className="absolute inset-y-0 bg-rose-500/80" style={{ left: `${(r.start / srcDur) * 100}%`, width: `${Math.max(1, ((r.end - r.start) / srcDur) * 100)}%` }} />
                      ))}
                      {cutFrom != null && <span className="absolute inset-y-0 w-0.5 bg-rose-700" style={{ left: `${(cutFrom / srcDur) * 100}%` }} />}
                      <span className="absolute inset-y-0 w-0.5 bg-slate-800" style={{ left: `${(curT / Math.max(0.001, srcDur)) * 100}%` }} />
                    </div>
                  )}
                  {removes.length === 0
                    ? <div className="fi-tap-text text-slate-500">▶ 再生して、いらない所の<b>始まり</b>で「ここから消す」、<b>終わり</b>で「ここまで消す」を押します。赤い所が消えます。</div>
                    : (<>
                      <div className="fi-tap-text font-bold text-rose-700">
                        消す {removes.length}か所 ／ 残る長さ {fmtT(Math.max(0, srcDur - removes.reduce((a, r) => a + (r.end - r.start), 0)))}
                        <button onClick={() => { setRemoves(prev => prev.slice(0, -1)); setErr(''); }} className="ml-2 text-slate-500 underline font-normal">↩ 直前を取り消す</button>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {removes.map((r, i) => (
                          <span key={i} className="inline-flex items-center gap-1 bg-white border border-rose-300 rounded-full pl-2 pr-1 py-0.5 fi-tap-text font-bold text-rose-700">
                            ✂ {fmtT(r.start)}〜{fmtT(r.end)}
                            <button onClick={() => setRemoves(prev => prev.filter((_, j) => j !== i))} className="text-rose-500 px-0.5">✕</button>
                          </span>
                        ))}
                      </div>
                    </>)}
                </div>
              )}

              {/* 🖼 挟んだ画像の一覧。印はここで描く */}
              {mode === 'image' && (
                <div className="space-y-1.5">
                  {inserts.length === 0
                    ? <div className="fi-tap-text text-slate-500">▶ 再生して、説明を入れたい所で「画像を挟む」を押します。<b>挟んだ画像に〇や矢印、ひとことを付けられます</b>（PC画面の操作の説明にどうぞ）。</div>
                    : inserts.sort((a, b) => a.at - b.at).map((ins) => (
                      <div key={ins.id} className={`rounded-lg border-2 p-2 space-y-1.5 ${insEdit === ins.id ? 'border-violet-500 bg-violet-50' : 'border-slate-200 bg-white'}`}>
                        <div className="flex items-center gap-1.5 fi-tap-text">
                          <span className="font-bold text-violet-700 shrink-0">🖼 {fmtT(ins.at)} に</span>
                          <select value={ins.durationSec} onChange={(e) => setInserts(prev => prev.map(x => (x.id === ins.id ? { ...x, durationSec: Number(e.target.value) } : x)))}
                            className="border border-slate-300 rounded px-1 py-0.5">
                            {[2, 3, 4, 5, 6, 8, 10, 15].map(n => <option key={n} value={n}>{n}秒</option>)}
                          </select>
                          <button onClick={() => setInsEdit(insEdit === ins.id ? null : ins.id)}
                            className={`ml-auto px-2 py-1 rounded font-bold ${insEdit === ins.id ? 'bg-violet-600 text-white' : 'bg-violet-100 text-violet-700'}`}>
                            {insEdit === ins.id ? '✓ 描き終わり' : '✍ 印を描く'}
                          </button>
                          <button onClick={() => { try { URL.revokeObjectURL(ins.url); } catch { /* noop */ } setInserts(prev => prev.filter(x => x.id !== ins.id)); }}
                            className="px-2 py-1 bg-rose-100 text-rose-600 rounded font-bold">✕</button>
                        </div>
                        <div className="relative bg-black rounded overflow-hidden">
                          {/* ⚠⚠ ここは **指で〇や矢印を描く** 所。30vh だとタブレットで絵が
                              157px幅にしかならず、指の接地(約40〜50px)が絵の1/3を占めて描けない。
                              ⚠印の位置は「この箱の中の割合」で持っているので、`w-full` は外さない
                              (箱と絵がズレると印が黒帯の上に乗る。2026-08-10 に直した所)。高さだけ上げる。 */}
                          <img ref={insEdit === ins.id ? insImgRef : null} src={ins.url} alt="" className="w-full max-h-[72vh] object-contain" />
                          {insEdit === ins.id
                            ? <MarkCanvas targetRef={insImgRef} marks={ins.marks} shape={insShape} max={8}
                                onChange={(next) => setInserts(prev => prev.map(x => (x.id === ins.id ? { ...x, marks: next } : x)))} />
                            : <RecipeMarks marks={ins.marks} />}
                        </div>
                        {insEdit === ins.id && (
                          <>
                            <ShapePicker shape={insShape} onChange={setInsShape} />
                            <MarkList marks={ins.marks} onChange={(next) => setInserts(prev => prev.map(x => (x.id === ins.id ? { ...x, marks: next } : x)))} />
                          </>
                        )}
                        <input value={ins.caption} onChange={(e) => setInserts(prev => prev.map(x => (x.id === ins.id ? { ...x, caption: e.target.value.slice(0, 60) } : x)))}
                          placeholder="画面の下に出る説明(任意・例: PCの測定ソフトで「測定開始」を押します)"
                          className="w-full border border-slate-200 rounded px-1.5 py-1 text-[12px]" />
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
          {/* 💾 作りかけから続ける */}
          {draft && !editorOn && (
            <div className="rounded-lg border-2 border-emerald-400 bg-emerald-50 p-2 space-y-1.5">
              <div className="text-xs font-bold text-emerald-800">💾 作りかけが残っています（{vSavedAgo(draft.savedAt)}{draft.label ? `・${draft.label}` : ''}）</div>
              {draft.needPick ? (
                <label className="block w-full text-center py-2 rounded-lg bg-emerald-600 text-white font-bold text-xs cursor-pointer">
                  同じ動画をもう一度選ぶ（{draft.needPick.map(x => x.name).join(' / ')}）
                  <input type="file" accept="video/*" multiple className="hidden" onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) resumeDraft(fs); }} />
                </label>
              ) : (
                <button onClick={() => resumeDraft()} className="w-full py-2 rounded-lg bg-emerald-600 text-white font-bold text-xs">▶ 続きから編集する</button>
              )}
              <button onClick={() => { vClearDraft(); setDraft(null); }} className="w-full py-1.5 rounded fi-tap-text font-bold text-slate-500">捨てる</button>
            </div>
          )}
          {mode === 'studio' && files.length > 0 && (
            <button onClick={() => openEditor()} disabled={!!loadingMsg}
              className="w-full py-3 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:bg-slate-300 text-white font-bold text-sm">
              {loadingMsg || '✨ 編集室をひらく'}
            </button>
          )}
          {mode !== 'concat' && mode !== 'studio' && (
            <div className="flex items-center gap-2 text-xs">
              <span className="font-bold text-slate-500 shrink-0">画質</span>
              <select value={quality} onChange={(e) => setQuality(e.target.value)} className="flex-1 border border-slate-300 rounded px-2 py-1.5">
                {Object.entries(QMAP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            {/* 🔄 向きを直す。⚠⚠ この口が無い間、圧縮・分割・つなげるでは
                **編集室を開かない限り絶対に回せなかった**。言葉と操作は
                📱スマホ中継の「🔄 回す（{deg}°）」「元に戻す」と揃える。 */}
            <div className="flex items-center gap-1.5 mt-1.5">
              <span className="fi-tap-text font-bold text-slate-600 shrink-0">向き</span>
              <button onClick={() => setRotate(r => (r + 90) % 360)} title="押す度に90度ずつ回ります（0→90→180→270→0）"
                className="px-3 py-1.5 min-h-[40px] rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-bold fi-tap-text">🔄 回す（{(rotate + 90) % 360}°）</button>
              <button onClick={() => setRotate(0)} disabled={!rotate}
                className="px-3 py-1.5 min-h-[40px] rounded-lg bg-slate-100 disabled:opacity-40 text-slate-600 font-bold fi-tap-text">元に戻す</button>
              {!!rotate && <span className="fi-tap-text text-amber-800 bg-amber-50 rounded px-1.5 py-1">いま <b>{rotate}°</b> 。書き出す動画に焼き込まれます</span>}
            </div>
            {/* 🔇音を消して書き出す。市場の道具にはある(現場の会話が入った動画をそのまま配れない時に要る)。 */}
            <label className="flex items-center gap-1.5 fi-tap-text font-bold text-slate-600 mt-1.5 cursor-pointer">
              <input type="checkbox" checked={mute} onChange={e => setMute(e.target.checked)} className="w-4 h-4 accent-sky-600" />
              音を消して書き出す
            </label>
            </div>
          )}
          {err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded p-2">{err}</div>}
          {mode !== 'studio' && (
            <button
              onClick={() => (mode === 'split' ? runSplit() : (mode === 'cut' || mode === 'image') ? runEdit() : run())}
              disabled={!files.length || (mode === 'cut' && !removes.length) || (mode === 'image' && !inserts.length)}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-200 text-white rounded-lg font-bold text-sm">
              {mode === 'split' ? '✁ 分けて書き出す' : mode === 'cut' ? '✂ 消して書き出す' : mode === 'image' ? '🖼 画像を挟んで書き出す' : '▶ 書き出す'}
            </button>
          )}
          {/* ⚠出来上がりの見当を先に出す(市場の書き出しダイアログは必ず出す) */}
          {srcDur > 0 && (mode === 'cut' || mode === 'image') && (() => {
            const cutSec = removes.reduce((a, r) => a + (r.end - r.start), 0);
            const insSec = inserts.reduce((a, x) => a + (Number(x.durationSec) || 0), 0);
            const outSec = Math.max(0, srcDur - cutSec + insSec);
            return <div className="fi-tap-text text-slate-600">出来上がり: <b>{fmtT(outSec)}</b>（もと {fmtT(srcDur)}{cutSec > 0 ? ` − 消す ${fmtT(cutSec)}` : ''}{insSec > 0 ? ` ＋ 画像 ${fmtT(insSec)}` : ''}）／ 目安 <b>{vFmtBytes(vEstBytes(outSec, quality))}</b></div>;
          })()}
          <div className="fi-tap-text text-slate-400">※ MP4で書き出します。元がMP4なら<b>実時間より速く</b>終わります（実測 6〜9倍速）。途中でやめられます。</div>
        </>)}
        {phase === 'working' && (
          <div className="py-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-bold text-slate-700">書き出し中… {Math.round(prog * 100)}%{eta ? <span className="ml-2 font-normal text-slate-500">{eta}</span> : null}</div>
              {/* ⏹ 途中でやめられる。市場の道具には必ずある。 */}
              <button onClick={() => { try { abortRef.current && abortRef.current.abort(); } catch (e) { /* noop */ } }}
                className="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-300 text-slate-600 hover:bg-slate-50">やめる</button>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${prog * 100}%` }} /></div>
            <div className="fi-tap-text text-slate-400">MP4で書き出しています。長さもシークも正しく入ります。この画面は閉じないでください。</div>
          </div>
        )}
        {phase === 'done' && outSegs.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-bold text-emerald-700">✂ {outSegs.length}本に分割しました。各動画に名前と保存先をつけてDriveへ保存できます。</div>
            <div className="space-y-2 max-h-[52vh] overflow-y-auto pr-0.5">
              {outSegs.map((sg, i) => (
                <div key={i} className="border border-slate-200 rounded-lg p-2 space-y-1.5 bg-slate-50">
                  <div className="flex gap-2">
                    {/* ⚠一覧なので枠は決め打ちだが、縦向きの動画が潰れないよう **縦を確保** する。
                        128×80 のままだと縦動画の絵が45px幅になって何も分からない。
                        本当に確かめる時は 🔍 で画面いっぱいにする。 */}
                    <div className="shrink-0 space-y-1">
                      <video src={sg.url} controls playsInline className="w-48 h-40 rounded bg-black object-contain" />
                      <button onClick={() => setBigUrl(sg.url)} className="w-full py-1 rounded bg-slate-800 hover:bg-slate-700 text-white fi-tap-text font-bold">🔍 画面いっぱいで見る</button>
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <input value={sg.name} onChange={(e) => updateSeg(i, { name: e.target.value })} placeholder={`分割${i + 1}`} className="w-full border border-slate-300 rounded px-2 py-1 text-xs font-bold" />
                      <div className="fi-tap-text text-slate-500">{driveFmtSize(sg.blob.size)}</div>
                      {sections.length > 0 && <select value={sg.dest} onChange={(e) => updateSeg(i, { dest: Number(e.target.value) })} className="w-full border border-slate-300 rounded px-1 py-1 fi-tap-text">{sections.map((s, si) => <option key={si} value={si}>保存先: {s.label}</option>)}</select>}
                      {/* 🎬 その場で工程へ。⚠選ばなくても保存はできる(後から資料棚でも付けられる)。 */}
                      {steps.length > 0 && (
                        <select value={sg.stepKey} onChange={(e) => updateSeg(i, { stepKey: e.target.value })}
                          className={`w-full border rounded px-1 py-1 fi-tap-text ${sg.stepKey ? 'border-sky-400 bg-sky-50 font-bold text-sky-800' : 'border-slate-300'}`}>
                          <option value="">🎬 出す工程: 選ばない(あとで)</option>
                          {steps.map(s => <option key={s.key} value={s.key}>🎬 {s.label}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <a href={sg.url} download={`${(sg.name || '分割').replace(/[\\/:*?"<>|]/g, '_')}.mp4`} className="flex-1 text-center bg-slate-200 hover:bg-slate-300 text-slate-600 rounded py-1.5 font-bold fi-tap-text">⬇ 端末に保存</a>
                    <button onClick={() => doUploadSeg(i)} disabled={!sections.length || sg.saved || busyIdx === i} className="flex-[2] bg-sky-600 hover:bg-sky-500 disabled:bg-slate-200 text-white rounded py-1.5 font-bold fi-tap-text">{sg.saved ? '✓ Drive保存済み' : (busyIdx === i ? '保存中…' : '⬆ Driveへ保存')}</button>
                  </div>
                </div>
              ))}
            </div>
            {err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded p-2">{err}</div>}
            <div className="flex gap-2">
              <button onClick={resetSplit} className="flex-1 bg-slate-200 text-slate-600 rounded-lg py-2 font-bold text-sm">やり直す</button>
              <button onClick={finishSplit} className="flex-[2] bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg py-2 font-bold text-sm">完了して閉じる</button>
            </div>
            <div className="fi-tap-text text-slate-400">工程への紐づけは、保存後に📁資料一覧で各動画の「＋この工程に使う」から行えます。</div>
          </div>
        )}
        {phase === 'done' && !outSegs.length && outUrl && (
          <div className="space-y-2">
            {/* ⚠⚠ 大きさの決め方は **「広い箱 + object-contain」** の一択。
                ・`w-full max-h-[40vh]`(前) … 縦向きだと高さで頭打ちして絵の幅が243pxまで痩せる
                ・`max-w-full`(幅を指定しない) … 軽くした640pxの動画が640pxのままで、
                  画面が空いていても大きくならない(「圧縮したから小さい」の正体はこっち)
                箱を画面いっぱいに取って object-contain にすると、縦でも横でも、
                元が何pxでも **入る限りいちばん大きく** 映る。 */}
            <video src={outUrl} controls playsInline className="w-full h-[62vh] object-contain rounded-lg bg-black" />
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-slate-500">
                できあがり: {driveFmtSize(outBlob.size)}
                {outInfo?.width > 0 && <span className="ml-2 text-slate-400">{outInfo.width}×{outInfo.height}</span>}
              </div>
              <button onClick={() => setBigUrl(outUrl)} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold shrink-0">🔍 画面いっぱいで見る</button>
            </div>
            {/* ⚠⚠ 音が入らなかったことを **必ず画面に出す**。
                いままで戻り値の audio:false を誰も見ておらず、
                音が消えていても「完了」しか出ていなかった(A7と同じ形)。 */}
            {outInfo && outInfo.audio === false && !mute && (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-300 rounded p-2">
                🔇 <b>音が入りませんでした。</b>元の動画に音が無いか、この端末で音を取り出せませんでした。
                音が必要な動画なら、保存せずにやり直してください。
              </div>
            )}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="動画名" className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
            {sections.length > 0 && <select value={dest} onChange={(e) => setDest(Number(e.target.value))} className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm">{sections.map((s, i) => <option key={i} value={i}>保存先: {s.label}</option>)}</select>}
            {/* ⚠⚠ 絵を大きくした分、タブレット(縦700px)では「⬆Driveへ保存」が
                折り返しの下に落ちる。**必ず見える所に貼り付ける**。
                前科あり: 縦積み+overflow-hidden で一番下のボタンが消えた(2026-08-05)。 */}
            <div className="sticky bottom-0 -mx-3 px-3 pt-2 pb-1 bg-white flex gap-2">
              <button onClick={() => { setPhase('pick'); setOutBlob(null); if (outUrl) URL.revokeObjectURL(outUrl); setOutUrl(null); }} className="flex-1 bg-slate-200 text-slate-600 rounded-lg py-2 font-bold text-sm">やり直す</button>
              <button onClick={doUpload} disabled={!sections.length} className="flex-[2] bg-sky-600 hover:bg-sky-500 disabled:bg-slate-200 text-white rounded-lg py-2 font-bold text-sm">⬆ Driveへ保存</button>
            </div>
          </div>
        )}
        {phase === 'uploading' && (
          <div className="py-4 space-y-2"><div className="text-sm font-bold text-slate-700">アップロード中… {Math.round(upProg * 100)}%</div><div className="h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-sky-500 transition-all" style={{ width: `${upProg * 100}%` }} /></div></div>
        )}
        {phase === 'error' && (
          <div className="space-y-2"><div className="text-sm text-rose-700 bg-rose-50 border border-rose-300 rounded p-2">{err}</div><button onClick={() => setPhase('pick')} className="w-full bg-slate-200 text-slate-600 rounded-lg py-2 font-bold text-sm">戻る</button></div>
        )}
        <canvas ref={canvasRef} className="hidden" />
      </div>
      {/* ✨ 編集室。⚠「🎬編集室でひらく」で来た時(autoEditor)は、編集室を閉じたら
          **まとめて閉じる**。加工の選ぶ画面に戻すと「閉じたのにまだ何か出ている」になり、
          ✕を2回押させることになる。 */}
      {editorOn && (
        <VideoEditor sources={srcMeta} initial={editorInit} busy={phase === 'working'}
          proxyUrl={GEMINI_PROXY_URL} hint={[model, ...(steps || []).slice(0, 6).map(s2 => s2.label)].filter(Boolean).join(' / ')}
          onSaveWorkStandard={onSaveWorkStandard} userName={userName}
          recipe={preloadRecipe} onSaveRecipe={saveRecipeDoc} steps={steps}
          recipeFileId={(preload && preload.id) || ''} recipeFileName={(preload && preload.name) || ''}
          onRun={runProject}
          onClose={() => { if (autoEditor && onClose) onClose(); else setEditorOn(false); }} />
      )}
      {/* ⏳ Driveの動画を手元へ落としている間。
          ⚠⚠ 編集室は **動画を全部落としてからでないと開けない**(音・帯の絵・波形に要る)。
             ここで何も出さないと「🎬編集室でひらくを押したのに何も起きない」に見える。 */}
      {loadingMsg && !editorOn && (
        <div className="fixed inset-0 z-[620] bg-black/70 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl px-5 py-4 max-w-sm w-full text-center space-y-1.5 shadow-2xl">
            <div className="text-sm font-bold text-slate-800 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-slate-500" />{loadingMsg}
            </div>
            <div className="text-xs text-slate-500 leading-snug">
              編集室は、動画を<b>この端末へ落としてから</b>ひらきます(音と帯の絵を作るため)。<br />
              大きい動画ほど時間がかかります。画面はこのままにしてお待ちください。
            </div>
          </div>
        </div>
      )}
      {/* 🔍 画面いっぱいで確かめる。⚠ここでしか「倒れていないか」「途中で止まっていないか」は分からない */}
      {bigUrl && (
        <div className="fixed inset-0 z-[600] bg-black flex flex-col" onClick={(e) => { e.stopPropagation(); setBigUrl(''); }}>
          <div className="shrink-0 flex justify-end p-2">
            <button onClick={(e) => { e.stopPropagation(); setBigUrl(''); }}
              className="px-4 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white text-sm font-bold">✕ 閉じる</button>
          </div>
          {/* ⚠max-w/max-h だけだと、軽くした640pxの動画は640pxのまま。
              箱いっぱい + object-contain にして、画面の大きさまで引き伸ばす。 */}
          <div className="flex-1 min-h-0 p-2">
            <video src={bigUrl} controls autoPlay playsInline onClick={(e) => e.stopPropagation()}
              className="w-full h-full object-contain rounded-lg bg-black" />
          </div>
        </div>
      )}
    </div>
  );
};

const DriveDocsModal = ({ title, sections, onClose, steps = [], model = '', recipes = [], onSaveRecipe = null, onDeleteRecipe = null, onSaveWorkStandard = null, userName = '', linkToKey = '', linkToLabel = '' }) => {
  const [rows, setRows] = useState(() => sections.map(s => ({ ...s, loading: true, error: '', found: false, missing: '', files: [] })));
  const [viewer, setViewer] = useState(null); // { file, kind }
  const [studio, setStudio] = useState(null); // { file, recipe, mode } エース動画スタジオ
  const [recOpen, setRecOpen] = useState(false); // 撮影モーダル
  const [procOpen, setProcOpen] = useState(false); // 動画を加工(圧縮/合体)
  // 🎬「編集室でひらく」で来た時に、最初から入れておく動画 { id, name, size, recipe }
  const [procPreload, setProcPreload] = useState(null);
  // ⚠⚠ 画面は **アプリの一番上** に1つだけ。ここ(全面の黒幕の中)に置くと、小さくしても
  //   黒幕が出るだけで検査画面に戻れない(清水さん 2026-08-14「最小化もいる」)。
  const liveOpenReq = useLiveOpen();
  // 📁 撮った物がDriveへ入ったら、押さなくても一覧を読み直す。
  const driveSavedAt = useDriveSaved();
  const [busy, setBusy] = useState(false);
  const recipeFor = (fid) => (recipes || []).find(r => r.fileId === fid) || null;
  // Drive操作(移動/ゴミ箱/名前変更)。失敗はalert、成功は一覧を読み直す。
  const driveAct = async (path, body) => {
    if (busy) return false;
    setBusy(true);
    try {
      const res = await fetch(`${DRIVE_PROXY_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) { alert(j.error || '操作に失敗しました'); setBusy(false); return false; }
      setBusy(false); load(); return true;
    } catch (e) { alert('通信エラー: ' + (e?.message || e)); setBusy(false); return false; }
  };
  const load = () => {
    setRows(sections.map(s => ({ ...s, loading: true, error: '', found: false, missing: '', files: [] })));
    sections.forEach(async (s, i) => {
      try {
        const res = await fetch(`${DRIVE_PROXY_URL}/drive/list?path=${encodeURIComponent(s.path.join('/'))}`);
        const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        setRows(prev => prev.map((x, xi) => xi === i ? { ...x, loading: false, error: j.ok ? '' : (j.error || `HTTP ${res.status}`), found: !!j.found, missing: j.missing || '', files: j.files || [] } : x));
      } catch (e) {
        setRows(prev => prev.map((x, xi) => xi === i ? { ...x, loading: false, error: (e && e.message) || '通信エラー(プロキシに届きません)' } : x));
      }
    });
  };
  // 📁 撮った物がDriveへ入ったら、押さなくても読み直す。⚠初回(0)では走らせない。
  useEffect(() => { if (driveSavedAt > 0) load(); }, [driveSavedAt]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (DRIVE_PROXY_URL) load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const total = rows.reduce((a, r) => a + r.files.length, 0);
  return (
    <div className="fixed inset-0 z-[520] bg-black/60 flex items-center justify-center p-3" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 bg-sky-700 text-white flex items-center justify-between shrink-0">
          <h2 className="font-bold text-sm flex items-center gap-2">📁 {title} <span className="fi-tap-text font-normal opacity-80">(Google Drive資料 {total}件)</span></h2>
          <div className="flex items-center gap-1.5">
            {DRIVE_PROXY_URL && sections.length > 0 && <button onClick={() => setRecOpen(true)} className="px-2 py-1 rounded bg-rose-500 hover:bg-rose-400 text-xs font-bold" title="この場で手本動画を撮影してDriveへアップロード">🎥 撮影して追加</button>}
            {liveOpenReq && <button onClick={() => liveOpenReq()} className="px-2 py-1 rounded bg-violet-500 hover:bg-violet-400 text-xs font-bold" title="スマホのカメラをこの画面に映しながら撮る（QRを読ませるだけ。録画はスマホ側なので画質は落ちません）">📱 スマホで撮る</button>}
            {DRIVE_PROXY_URL && sections.length > 0 && <button onClick={() => setProcOpen(true)} className="px-2 py-1 rounded bg-indigo-500 hover:bg-indigo-400 text-xs font-bold" title="動画を圧縮(容量削減)・分割(1本を工程ごとに複数へ)・合体(複数を1本に)してDriveへ保存">🛠 加工</button>}
            {/* 📊 撮る前に「10分撮ったらどれだけ要るのか」を見られるようにする。⚠選ぶ瞬間に見えないと意味がない */}
            <DataUsageOpenButton
              label="📊 目安"
              title="10分・20分…と撮ったら、通信がどれだけ要るか／容量がどれだけ残るかの表を開きます"
              className="px-3 py-2 min-h-[44px] rounded bg-white/15 hover:bg-white/25 text-xs font-bold"
            />
            <button onClick={load} className="px-2 py-1 rounded bg-white/15 hover:bg-white/25 text-xs font-bold" title="Driveの最新内容を読み直す(一覧は最大1分キャッシュ)">↻ 更新</button>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-white/20"><X className="w-5 h-5" /></button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 bg-slate-50">
          {!DRIVE_PROXY_URL && (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800 space-y-1">
              <div className="font-bold">Drive連携が未設定です</div>
              <div>管理者が worker/README_セットアップ手順.md の「Google Drive 資料フォルダ」の手順(サービスアカウント作成→フォルダ共有→wrangler secret→deploy)を行い、.env の <code className="bg-white px-1 rounded">VITE_DRIVE_PROXY_URL</code> にWorkerのURLを設定して再デプロイしてください。</div>
            </div>
          )}
          {DRIVE_PROXY_URL && rows.map((r, i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-3 py-2 bg-slate-100 flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-slate-700">{r.label}</span>
                <span className="fi-tap-text text-slate-400 font-mono truncate" title={`Driveフォルダ: 資料ルート/${r.path.join('/')}`}>{r.path.join('/')}</span>
              </div>
              <div className="p-2">
                {r.loading && <div className="text-sm text-slate-400 flex items-center gap-2 p-2"><Loader2 className="w-4 h-4 animate-spin" /> 読み込み中…</div>}
                {!r.loading && r.error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded p-2">{r.error}</div>}
                {!r.loading && !r.error && !r.found && (
                  <div className="text-xs text-slate-400 p-2">フォルダ未作成: Driveの資料フォルダに「<b>{r.path.join('/')}</b>」({r.missing} が見つかりません)を作って動画やPDFを入れると、ここに自動で出ます。</div>
                )}
                {!r.loading && !r.error && r.found && r.files.length === 0 && <div className="text-xs text-slate-400 p-2">フォルダはありますが、ファイルがまだ入っていません。</div>}
                {!r.loading && r.files.map(f => {
                  const kind = driveKindOf(f.mimeType, f.name);
                  const rc = kind === 'video' ? recipeFor(f.id) : null;
                  return (
                    <div key={f.id} className="w-full flex items-center gap-1 px-1 rounded-lg hover:bg-sky-50 border-b border-slate-100 last:border-b-0">
                      <button onClick={() => (rc ? setStudio({ file: f, recipe: rc }) : setViewer({ file: f, kind }))}
                        className="flex-1 min-w-0 flex items-center gap-2 px-1 py-2 text-left">
                        <span className="text-lg shrink-0">{DRIVE_KIND_ICON[kind]}</span>
                        <span className="text-sm font-bold text-slate-700 truncate flex-1">{rc?.title || f.name}</span>
                        {rc && <span className="fi-tap-text bg-amber-100 text-amber-700 border border-amber-300 rounded px-1 font-bold shrink-0" title="停止ポイント・倍速つきの手本レシピあり">🎬手本</span>}
                        <span className="fi-tap-text text-slate-400 shrink-0">{driveFmtSize(f.size)}</span>
                        <span className="fi-tap-text text-sky-600 font-bold shrink-0">{rc ? '手本再生 ▶' : (kind === 'other' ? '開く' : '表示 ▶')}</span>
                      </button>
                      {linkToKey && kind === 'video' && onSaveRecipe && (
                        (rc && (rc.stepKeys || []).includes(linkToKey))
                          ? <span className="fi-tap-text bg-emerald-100 text-emerald-700 rounded px-1.5 py-1 font-bold shrink-0" title="この工程に紐づけ済み">✓ 紐づけ済</span>
                          : <button onClick={async (e) => { e.stopPropagation(); const base = rc || { fileId: f.id, fileName: f.name, title: '', model: '', stepKeys: [], events: [] }; await onSaveRecipe(f.id, { ...base, fileId: f.id, fileName: base.fileName || f.name, stepKeys: [...new Set([...(base.stepKeys || []), linkToKey])] }); load(); }} className="fi-tap-text bg-sky-600 hover:bg-sky-700 text-white rounded px-2 py-1 font-bold shrink-0" title={linkToLabel ? `「${linkToLabel}」に紐づける` : 'この工程に紐づける'}>＋この工程に使う</button>
                      )}
                      <details className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
                        <summary className="list-none cursor-pointer px-2 py-2 text-slate-400 hover:text-slate-700 font-bold">⋮</summary>
                        <div className="fixed bg-white rounded-lg shadow-2xl border border-slate-200 w-60 z-[560] overflow-y-auto max-h-[60vh] p-1.5 space-y-1 text-left"
                                                    ref={(el) => {
                                                        // ⚠⚠ 親の枠は overflow-hidden。absolute のままだと、下の方のファイルで開いた時に
                                                        //   メニューが **枠の外へ出て切り取られ、下半分が見えない**
                                                        //   (清水さん 2026-08-14 実機「上の方は見えるけど下の方は見えなかった」)。
                                                        //   画面に対して置き(fixed)、下に入らない時は **上向きに開く**。
                                                        if (!el) return;
                                                        const btn = el.parentElement?.querySelector("summary");
                                                        if (!btn) return;
                                                        const r = btn.getBoundingClientRect();
                                                        const h = Math.min(el.scrollHeight || 260, window.innerHeight * 0.6);
                                                        const below = window.innerHeight - r.bottom;
                                                        el.style.left = Math.max(8, Math.min(r.right - 240, window.innerWidth - 248)) + "px";
                                                        el.style.top = (below >= h + 12 ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + "px";
                                                    }}>
                          {/* 🎬 直す所は **編集室ただ1つ**(清水さん 2026-08-16「編集室に統一しろって言ったよね？」)。
                              ここから開くと、この動画を手元へ落として編集室が開く。
                              止める・とばす・倍速・頭出しは編集室の「👁 見せ方」タブに入っている。 */}
                          {kind === 'video' && (
                            <button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); setStudio(null); setProcPreload({ id: f.id, name: f.name, size: f.size || 0, recipe: rc || null }); setProcOpen(true); }} className="w-full text-left px-2 py-1.5 rounded hover:bg-amber-50 text-amber-700 text-xs font-bold">🎬 編集室でひらく(切る・印・見せ方)</button>
                          )}
                          {rc && <button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); setViewer({ file: f, kind }); }} className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-50 text-slate-600 text-xs font-bold">▶ 元の動画をそのまま再生</button>}
                          <button onClick={async (e) => { e.currentTarget.closest('details')?.removeAttribute('open'); const nn = window.prompt('新しい名前', f.name); if (nn && nn.trim() && nn !== f.name) await driveAct('/drive/rename', { id: f.id, name: nn.trim() }); }} className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-50 text-slate-600 text-xs font-bold">📝 名前を変更</button>
                          {rows.filter((x, xi) => xi !== i).map((x, xi2) => (
                            <button key={xi2} onClick={async (e) => { e.currentTarget.closest('details')?.removeAttribute('open'); await driveAct('/drive/move', { id: f.id, toPath: x.path }); }} className="w-full text-left px-2 py-1.5 rounded hover:bg-sky-50 text-sky-700 text-xs font-bold truncate">📦 「{x.label}」へ移動</button>
                          ))}
                          <button onClick={async (e) => { e.currentTarget.closest('details')?.removeAttribute('open'); if (!window.confirm(`「${f.name}」をDriveのゴミ箱へ移動しますか？(30日間はDriveのゴミ箱から復元できます)`)) return; const ok = await driveAct('/drive/trash', { id: f.id }); if (ok && rc && onDeleteRecipe) { try { await onDeleteRecipe(f.id); } catch (e2) { /* noop */ } } }} className="w-full text-left px-2 py-1.5 rounded hover:bg-rose-50 text-rose-600 text-xs font-bold">🗑 ゴミ箱へ(復元可)</button>
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="fi-tap-text text-slate-400 px-1">Driveの該当フォルダにファイルを置くだけで自動で反映されます(反映は最大1分後・「↻ 更新」で即時)。ファイル本体はDriveにあり、このアプリの容量は使いません。</div>
        </div>
      </div>
      {studio && (
        <RecipePlayer file={studio.file} recipe={studio.recipe}
          onOpenEditor={(f) => { setStudio(null); setProcPreload({ id: f.id, name: f.name, size: f.size || 0, recipe: studio.recipe || null }); setProcOpen(true); }}
          onClose={() => setStudio(null)} />
      )}
      {recOpen && (
        <VideoRecordModal open sections={sections} defaultName={model ? `${model}_手本` : '手本'} onDone={() => { setRecOpen(false); load(); }} onClose={() => setRecOpen(false)} />
      )}
      {/* ⚠autoEditor: 動画を指定して来た時だけ「すぐ編集室」。上の「🛠 動画を加工」から来た時は
          まだ動画を選んでいないので、いつもどおり選ぶ画面から始める。 */}
      {procOpen && (
        <VideoProcessModal sections={sections}
          driveVideos={rows.flatMap(r => (r.files || []).filter(f => driveKindOf(f.mimeType, f.name) === 'video').map(f => ({ id: f.id, name: f.name, size: f.size })))}
          steps={steps} model={model} onSaveRecipe={onSaveRecipe} preload={procPreload}
          preloadRecipe={(procPreload && procPreload.recipe) || null} autoEditor={!!procPreload}
          onSaveWorkStandard={onSaveWorkStandard} userName={userName}
          onDone={() => { setProcOpen(false); setProcPreload(null); load(); }} onClose={() => { setProcOpen(false); setProcPreload(null); load(); }} />
      )}
      {/* 📄🎬 ファイルの表示は共通ビューア(src/DriveFileViewer.jsx)へ。
          知識標準の受講画面も同じ物を使う = PDF/動画の出し方が2つに割れない。 */}
      {viewer && (
        <DriveFileViewer key={viewer.file.id} file={viewer.file} kind={viewer.kind} onClose={() => setViewer(null)} />
      )}
    </div>
  );
};

// ===== エース動画 (再生レシピ = 元動画無傷のメタデータ再生) =====
// 動画ファイルは一切加工しない。区間倍速/スキップ/自動一時停止(○印+コメント)を「レシピ」(小さなJSON)として
// Firestore(video_recipes, docId=DriveのfileId)に保存し、再生時にプレイヤーが解釈する(SponsorBlock/Edpuzzle方式)。
// → 保存は一瞬・何度でも直せる・○やコメントは後から修正可・Firebase容量も食わない。
// 市場調査の反映: 1動画=1工程(工程タグ)/○×は普遍記号/スキップ直後に「戻す」(誤爆の安全弁)/停止ポイントはシークバーにドット表示。
const vrFmtT = (s) => { if (!Number.isFinite(s)) return '--:--'; s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// ⚠新しい見せ方の id を作る所は編集室(src/VideoEditor.jsx)へ移した。ここでは作らない。

// Driveアップロード: Workerでresumableセッション開始→ブラウザから直接PUT(進捗つき)。
// 直接PUTがCORSで失敗する環境ではWorker中継(/drive/upload-chunk, 64MBずつ)に自動フォールバック。
const drivePutDirect = (sessionUrl, file, onProgress) => new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', sessionUrl);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
  xhr.onload = () => { if (xhr.status === 200 || xhr.status === 201) { let f = null; try { f = JSON.parse(xhr.responseText || '{}'); } catch (e2) { f = null; } resolve(f || {}); } else reject(new Error('HTTP ' + xhr.status)); };
  xhr.onerror = () => reject(new Error('direct-put-failed'));
  xhr.send(file);
});
// 戻り値: アップロードされたDriveファイル情報 {id, name, ...}(工程への自動紐づけに使う)
const driveUploadFile = async (file, path, onProgress) => {
  const initRes = await fetch(`${DRIVE_PROXY_URL}/drive/upload-init`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, path }) });
  const init = await initRes.json().catch(() => ({}));
  if (!init.ok || !init.sessionUrl) throw new Error(init.error || 'アップロード開始に失敗しました');
  try { return await drivePutDirect(init.sessionUrl, file, onProgress); } catch (e) { /* 直接PUT不可 → Worker中継へ */ }
  const CH = 64 * 1024 * 1024; // 256KiBの倍数(Google要件) かつ Workers無料枠(100MB/リクエスト)未満
  let uploaded = null;
  for (let off = 0; off < file.size; off += CH) {
    const end = Math.min(off + CH, file.size);
    const res = await fetch(`${DRIVE_PROXY_URL}/drive/upload-chunk?session=${encodeURIComponent(init.sessionUrl)}`, {
      method: 'POST',
      headers: { 'Content-Range': `bytes ${off}-${end - 1}/${file.size}`, 'Content-Type': 'application/octet-stream' },
      body: file.slice(off, end),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.error || 'アップロードに失敗しました');
    if (j.file) uploaded = j.file;
    if (onProgress) onProgress(end / file.size);
  }
  return uploaded || {};
};

// ============================================================================
// 🎬 手本プレイヤー（見る専用）
// ----------------------------------------------------------------------------
// 🚨🚨 清水さん(2026-08-16)
//   「何で編集室とレシピ編集ってまだ2種類あるの？編集室に統一しろって言ったよね？」
//
// → **直す所は「🎬 編集室」ただ1つ**にした。ここは もう直せない。
//   ここに残っているのは 見る為の物だけ:
//     ・見せ方(⏸止まる／⏭とばす／⚡倍速)のとおりに再生する
//     ・⏸で止まった時の 〇印 と ひと言 を出す
//     ・🔎 言葉で探して、その場面へ飛ぶ
//     ・👀 見た記録を1回だけ書く
//   打刻・○を描く・章を直す・保存 は **編集室(👁 見せ方 タブ)**へ移した。
//   ⚠ここに「直す」を作り直さない事。2つに割れると、片方だけ直して必ず事故る。
//
// events: [{id, type:'pause'|'speed'|'skip', start, end?, speed?, text?, marks?:[{x,y}](0-1)}]
// startAt: 開いた瞬間に飛ばす位置(秒)。工程開始の小窓から⤢で開いた時に、その章の頭から見せるために使う。
// onOpenEditor: (file) => void  「🎬 編集室でひらく」。渡さない画面ではボタンを出さない
//               (作業中の作業者に編集の入口を出さない為)。
// ============================================================================
// ⚠工程の一覧(steps)は受け取らない。見るだけの画面では使い道が無く、
//   持たせておくと「ここでも工程を選べる」という誤解のもとになる(工程を選ぶのは編集室)。
const RecipePlayer = ({ file, recipe = null, startAt = 0,
  onClose, watcherName = '', onWatched = null, onOpenEditor = null }) => {
  // 👀 **再生が実際に進んだ秒**を数える。⚠開いていた時間ではない。
  //   ⚠飛ばし・早送りは足さない(10秒送りを2回押しただけで既読になってしまう)。
  const playedRef = useRef(0);
  const wroteRef = useRef(false);
  const videoRef = useRef(null);
  const boxRef = useRef(null);
  const lastTRef = useRef(0);
  const undoneSkipRef = useRef(new Set());
  const firedPauseRef = useRef(new Set());
  const fixingRef = useRef(false); // 総時間を測るため末尾へ飛ばしている最中は、停止/スキップ判定を止める(先に消費されるのを防ぐ)
  const [dur, setDur] = useState(0);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [userSpeed, setUserSpeed] = useState(1);
  const [overlay, setOverlay] = useState(null);
  const [skipToast, setSkipToast] = useState(null);
  // 🚨 清水さん(2026-08-16)「結局スマホで撮った映像アプリ上だとみれなかった」。
  //   **黙って真っ黒にしない。** 再生できなかった時は理由と次の一手を必ず出す。
  const [playErr, setPlayErr] = useState('');
  // ⚠絵の範囲(黒帯を除いた所)。描画中に ref を読むと、動画の大きさが分かった時に
  //   描き直されず印がズレたままになる。状態で持ち、読み込み時・大きさ変更時に測り直す。
  const [studioBox, setStudioBox] = useState({ left: 0, top: 0, width: 1, height: 1 });
  const src = driveFileUrl(file.id);
  // ⚠見るだけなので、見せ方は **レシピからそのまま読む**(直さないので状態に持たない)。
  const title = (recipe && recipe.title) || '';
  const events = useMemo(() => ((recipe && recipe.events) || []).map(e => ({ ...e })), [recipe]);
  const chapters = useMemo(() => chaptersOf(recipe).map(c => ({ ...c })), [recipe]);
  const evSorted = useMemo(() => [...events].sort((a, b) => (a.start || 0) - (b.start || 0)), [events]);

  // 🔎 動画の中を「言葉で探す」。材料は2つ:
  //   ①書き出しの時に作った索引(recipe.words) … 編集室で書いた 急所・作業手順・章の名前
  //   ②いまレシピが持っている ⏸要点の名前/説明 と 📍頭出しの名前
  // ⚠⚠ ②が無いと **編集室を通していない既存の手本動画は一生0件** になる。
  //   本番のレシピは要点の名前という文字をもう持っているのに、0件だと現場には
  //   「壊れている」に見える。狙いは「いま在る文字だけで成立させる」こと。
  // ⚠同じ物が二重に出ないよう、id がぶつからない形にしてある(domain/videoWords.js)。
  const [findOn, setFindOn] = useState(true);
  const findWords = useMemo(() => {
    const saved = wordsFromMap(recipe && recipe.words);
    const seen = new Set(saved.map(w => w.id));
    const live = wordsFromRecipe({ events, chapters }).filter(w => !seen.has(w.id));
    return [...saved, ...live].sort((a, b) => a.atOut - b.atOut);
  }, [recipe, events, chapters]);

  useEffect(() => { const t = skipToast ? setTimeout(() => setSkipToast(null), 4500) : null; return () => t && clearTimeout(t); }, [skipToast]);
  // 停止ポイントに hold 秒が設定されていれば自動で再開(tebiki/Teachmeの定番。手袋・両手がふさがる検査現場向け)
  useEffect(() => {
    if (!overlay || !(overlay.hold > 0)) return;
    const t = setTimeout(() => { setOverlay(null); const v = videoRef.current; if (v) v.play().catch(() => {}); }, overlay.hold * 1000);
    return () => clearTimeout(t);
  }, [overlay]);

  const onTime = () => {
    const v = videoRef.current; if (!v) return;
    if (fixingRef.current) return; // 総時間測定中は無視
    const t = v.currentTime; setCur(t);
    const prev = lastTRef.current;
    // 👀 見た記録。⚠**1本につき1回だけ**書く(見るたびに書くと通信を無駄に使う)。
    //   ⚠名前が無い時・見たと言えない時は watchPatch が null を返すので書かない。
    if (onWatched && !wroteRef.current) {
      playedRef.current = addPlayed(playedRef.current, prev, t);
      const patch = watchPatch(recipe && recipe.watch, watcherName, { playedSec: playedRef.current, durationSec: dur, nowMs: Date.now() });
      if (patch) { wroteRef.current = true; try { onWatched(patch); } catch (err) { console.warn('見た記録を書けませんでした', err); } }
    }
    if (t < prev - 0.5) firedPauseRef.current = new Set(); // 巻き戻したら停止ポイントは再発火してよい
    // ⚠区間の解釈は src/domain/videoRecipe.js が唯一の正。工程開始で出る小窓プレイヤーも同じ関数を通す。
    //   停止のお知らせが出ている間だけ素の再生 = applyJumps:false(倍速は従来どおり常に効く)。
    const act = recipeActionAt({ events, t, prev, undoneSkipIds: undoneSkipRef.current, firedPauseIds: firedPauseRef.current, applyJumps: !overlay, userSpeed });
    if (act.skip) {
      const sk = act.skip;
      // ⚠飛び先を実尺で丸める。超えると末尾に張り付いて ended になり、
      //   「最初から再生したのに途中で終わった」に見える(小窓側は丸めてあったのにここだけ抜けていた)。
      const lim = (Number.isFinite(v.duration) && v.duration > 0) ? v.duration : null;
      const to = (sk.end || sk.start) + 0.01;
      v.currentTime = lim == null ? to : Math.min(to, Math.max(0, lim - 0.05));
      lastTRef.current = v.currentTime; setSkipToast(sk); return;
    }
    if (act.pause) { firedPauseRef.current.add(act.pause.id); v.pause(); setOverlay(act.pause); }
    if (Math.abs(v.playbackRate - act.rate) > 0.01) v.playbackRate = act.rate;
    lastTRef.current = t;
  };
  const seekTo = (t) => {
    const v = videoRef.current; if (!v) return;
    // ⚠⚠ dur は最初 0。`Math.min(dur || 0, t)` にすると **長さが分かるまで全部 0 秒に吸い込まれる**。
    //   元が MediaRecorder の webm(長さ Infinity)だと、長さが確定するまで
    //   ±5秒・コマ送り・シークバー・▶試す・頭出しが「押しても先頭に戻るだけ」になっていた。
    //   → 長さが分かっている時だけ丸める。分からない時は素直にそこへ飛ぶ。
    const lim = (Number.isFinite(dur) && dur > 0) ? dur : (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    v.currentTime = lim == null ? Math.max(0, t) : Math.max(0, Math.min(lim, t));
    lastTRef.current = v.currentTime; setCur(v.currentTime); setOverlay(null);
  };
  const togglePlay = () => { const v = videoRef.current; if (!v) return; if (v.paused) { setOverlay(null); v.play(); } else v.pause(); };
  // シークバー: タップだけでなく指でなぞって(ドラッグ)シークできる(タッチの定番)。setPointerCaptureでバー外に指が出ても追従
  const scrubRef = useRef(false);
  const barSeek = (e) => { const r = e.currentTarget.getBoundingClientRect(); if (!r.width || !dur) return; seekTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur); };
  const barDown = (e) => { scrubRef.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ } barSeek(e); };
  const barMove = (e) => { if (scrubRef.current) barSeek(e); };
  const barUp = () => { scrubRef.current = false; };
  // 次の停止ポイント(要点)へスキップ。重要ポイントだけ拾い見できる。無ければ末尾へ
  const goNextPoint = () => { const np = evSorted.find(x => x.type === 'pause' && x.start > cur + 0.3); if (np) { seekTo(np.start); firedPauseRef.current.add(np.id); videoRef.current?.pause(); setOverlay(np); } else { seekTo(dur || cur); } };
  // ⚠ここはもう「再生/停止」だけ。印を描くのは編集室(👁 見せ方)の仕事。
  const videoClick = () => { togglePlay(); };
  const EVT_META = { pause: { icon: '⏸', label: '止まる+ひと言', c: '#f59e0b' }, skip: { icon: '⏭', label: 'とばす', c: '#64748b' }, speed: { icon: '⚡', label: '倍速', c: '#0284c7' } };

  return (
    <div className="fixed inset-0 z-[560] bg-black/90 flex flex-col" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between px-3 py-2 text-white shrink-0 gap-2">
        <span className="text-sm font-bold truncate">🎬 {title || file.name}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* 👀 見た人。⚠⚠**見ていない人を名指ししない**(追い立てになり、機能ごと死ぬ)。
                 出すのは「見た人」と件数だけ。査定にも力量マップにも自動で反映しない。 */}
          {onWatched && watchersOf(recipe && recipe.watch).length > 0 && (
            <span className="fi-tap-text bg-white/15 rounded px-2 py-1 font-bold max-w-[46vw] truncate"
              title={watchersOf(recipe && recipe.watch).map(w => `${w.name}（${w.times}回）`).join(' / ')}>
              👀 {watchNote(recipe && recipe.watch)}
            </span>
          )}
          {/* 🎬 直すのは編集室ただ1つ。
              ⚠⚠ **ここで直す道をもう1本作らない。** 切る/画像を挟む/分ける/つなげる/画質/
                 止める・とばす・倍速・頭出し は、ぜんぶ編集室に在る。実装が2本あると
                 片方だけ直して事故る(2026-08-13「軽量画質で音が消える」の原因がこれ)。
              ⚠⚠ **動画を作り直すと見せ方の秒がズレる。** 消したり挟んだりすると長さが変わるので、
                 いまの ⏸止まる・⏭とばす・⚡倍速 は別の場面を指すことになる。必ず先に言う。 */}
          {onOpenEditor && (
            <button onClick={() => {
              const n = evSorted.length;
              const msg = n > 0
                ? '編集室でひらきます（切る・いらない所を消す・画像を挟む・印を描く・見せ方を直す）。\n\n'
                  + `⚠ 動画そのものを作り直すと長さが変わるので、いま付いている ${n}件 の見せ方は\n`
                  + '　 別の場面を指すようになります。作り直したあとで付け直してください。\n'
                  + '　（見せ方を直すだけなら長さは変わらないので、ズレません）\n\n'
                  + '進みますか？'
                : '編集室でひらきます（切る・いらない所を消す・画像を挟む・印を描く・見せ方を直す）。進みますか？';
              if (confirm(msg)) onOpenEditor(file);
            }} className="text-xs bg-amber-500 hover:bg-amber-400 text-black rounded px-2 py-1 font-bold"
              title="切る・消す・画像を挟む・印を描く・見せ方(止まる/とばす/倍速/頭出し)を直す">🎬 編集室でひらく</button>
          )}
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/20"><X className="w-5 h-5" /></button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-2 px-2 pb-2 overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center relative">
          <div ref={boxRef} className="relative max-h-full max-w-full" style={{ cursor: 'pointer' }}>
            <video ref={videoRef} src={src} className="max-h-[62vh] md:max-h-[78vh] max-w-full rounded-lg bg-black" playsInline
              onTimeUpdate={onTime}
              onLoadedMetadata={(e) => { const v = e.currentTarget; const at = startAt > 0 ? startAt : 0; if (Number.isFinite(v.duration) && v.duration > 0) { setDur(v.duration); if (at > 0) { try { v.currentTime = Math.min(at, v.duration); } catch { /* noop */ } lastTRef.current = v.currentTime; } } else { fixingRef.current = true; const fix = () => { if (Number.isFinite(v.duration) && v.duration > 0) { v.removeEventListener('timeupdate', fix); setDur(v.duration); try { v.currentTime = at > 0 ? Math.min(at, v.duration) : 0; } catch { /* noop */ } lastTRef.current = v.currentTime; firedPauseRef.current = new Set(); fixingRef.current = false; } }; v.addEventListener('timeupdate', fix); try { v.currentTime = 1e7; } catch { /* noop */ } } }}
              onDurationChange={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDur(d); }}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onClick={videoClick}
              onLoadedData={(e) => { setPlayErr(''); setStudioBox(vboxOf(e.currentTarget)); }}
              onError={() => setPlayErr('この端末ではこの動画を再生できませんでした。')}
              onResize={(e) => setStudioBox(vboxOf(e.currentTarget))} />
            {/* 🚨 黙って真っ黒にしない。何が起きたか・次に何をすればよいかを出す。 */}
            {playErr && (
              <div className="absolute inset-0 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
                <div className="bg-white rounded-xl p-3 max-w-sm text-center space-y-1.5 shadow-2xl">
                  <div className="text-sm font-bold text-rose-700">{playErr}</div>
                  <div className="text-xs text-slate-600 leading-snug">
                    スマホで撮った形のまま(webmなど)だと、端末によっては映りません。<br />
                    <b>🎬 編集室でひらいて書き出し直す</b>と、どの端末でも見られる形になります。<br />
                    それでも映らない時は、右上の「⋯ その他 → この端末の状態」を見せてください。
                  </div>
                </div>
              </div>
            )}
            {/* ⭕印: いま止まっている所に付いている印を重ねる。
                ⚠描画は RecipeMarks 1つに集約(この画面・小窓・最終検査アプリで同じ物)。
                ⚠印を **描く** のは編集室(👁 見せ方)。ここは出すだけ。 */}
            <RecipeMarks marks={overlay?.marks || []} box={studioBox} />
            {overlay && (
              <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 to-transparent rounded-b-lg" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-stretch gap-2">
                  <div className="flex flex-col gap-1.5 shrink-0 w-32 sm:w-40">
                    {overlay.hold > 0 && <div className="fi-tap-text text-amber-200 font-bold text-center leading-tight">⏱ {overlay.hold}秒後に自動</div>}
                    <button onClick={() => { seekTo(Math.max(0, overlay.start - 5)); videoRef.current?.play(); }} className="bg-white/20 hover:bg-white/30 text-white rounded-lg py-2 text-xs font-bold">⏪ 5秒戻る</button>
                    <button onClick={() => { setOverlay(null); videoRef.current?.play(); }} className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg py-2 text-sm font-bold">▶ 続きを見る</button>
                  </div>
                  <div className="flex-1 min-w-0 bg-amber-400/95 text-black rounded-lg px-3 py-2 flex flex-col justify-center">
                    <div className="fi-tap-text font-bold text-amber-800 leading-none mb-0.5">⏸ ここで一旦停止中（続きは▶）</div>
                    <div className="text-base font-black leading-tight break-words">{overlay.label || overlay.text || '重要ポイント'}</div>
                    {overlay.label && overlay.text && <div className="text-xs font-bold mt-1 leading-snug break-words">{overlay.text}</div>}
                  </div>
                </div>
              </div>
            )}
            {skipToast && !overlay && (
              <button onClick={() => { undoneSkipRef.current.add(skipToast.id); seekTo(skipToast.start); videoRef.current?.play(); setSkipToast(null); }}
                className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-slate-800/90 text-white text-xs font-bold rounded-full px-3 py-1.5 hover:bg-slate-700">
                ⏭ {vrFmtT(skipToast.start)}〜{vrFmtT(skipToast.end)} を飛ばしました — タップで戻って見る
              </button>
            )}
          </div>
          {/* シークバー(イベント可視化: スキップ=灰帯 / 倍速=青帯 / 停止=黄ドット) */}
          <div className="w-full max-w-3xl mt-2 px-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            <div className="relative h-5 bg-white/15 rounded-full cursor-pointer" style={{ touchAction: 'none' }}
              onPointerDown={barDown} onPointerMove={barMove} onPointerUp={barUp} onPointerCancel={barUp}>
              {dur > 0 && evSorted.filter(e => e.type !== 'pause' && e.end).map(e => (
                <span key={e.id} className="absolute top-0 h-full rounded-full opacity-70 pointer-events-none" style={{ left: `${(e.start / dur) * 100}%`, width: `${Math.max(0.5, ((e.end - e.start) / dur) * 100)}%`, background: EVT_META[e.type].c }} />
              ))}
              {dur > 0 && evSorted.filter(e => e.type === 'pause').map(e => (
                <span key={e.id} className="absolute w-3.5 h-3.5 bg-amber-400 border-2 border-white rounded-full top-0.5 pointer-events-none" style={{ left: `calc(${(e.start / dur) * 100}% - 7px)` }} />
              ))}
              {dur > 0 && <span className="absolute w-1.5 h-7 -top-1 bg-white rounded pointer-events-none" style={{ left: `${(cur / (dur || 1)) * 100}%` }} />}
            </div>
            <div className="flex items-center gap-1.5 mt-1.5 text-white flex-wrap">
              <button onClick={togglePlay} className="bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 text-sm font-bold">{playing ? '⏸ 一時停止' : '▶ 再生'}</button>
              {evSorted.some(e => e.type === 'pause') && <button onClick={goNextPoint} className="bg-amber-500/80 hover:bg-amber-500 text-black rounded-lg px-3 py-1.5 text-sm font-bold" title="次の停止ポイント(要点)へ飛ぶ">⏭ 次の要点</button>}
              <span className="flex gap-1">
                <button onClick={() => seekTo(cur - 5)} className="bg-white/10 hover:bg-white/20 rounded px-2 py-1.5 text-xs font-bold">−5秒</button>
                <button onClick={() => seekTo(cur - 1)} className="bg-white/10 hover:bg-white/20 rounded px-2 py-1.5 text-xs font-bold">−1</button>
                <button onClick={() => seekTo(cur - 0.1)} className="bg-white/10 hover:bg-white/20 rounded px-2 py-1.5 text-xs font-bold" title="コマ送り(0.1秒)">−0.1</button>
                <button onClick={() => seekTo(cur + 0.1)} className="bg-white/10 hover:bg-white/20 rounded px-2 py-1.5 text-xs font-bold" title="コマ送り(0.1秒)">+0.1</button>
                <button onClick={() => seekTo(cur + 1)} className="bg-white/10 hover:bg-white/20 rounded px-2 py-1.5 text-xs font-bold">+1</button>
                <button onClick={() => seekTo(cur + 5)} className="bg-white/10 hover:bg-white/20 rounded px-2 py-1.5 text-xs font-bold">+5秒</button>
              </span>
              <span className="text-xs font-mono whitespace-nowrap tabular-nums shrink-0">{vrFmtT(cur)} / {vrFmtT(dur)}</span>
              <label className="ml-auto fi-tap-text flex items-center gap-1">自分の速度
                <select value={userSpeed} onChange={(e) => setUserSpeed(Number(e.target.value))} className="bg-white/15 rounded px-1 py-0.5 text-xs">
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => <option key={s} value={s} className="text-slate-800">{s}×</option>)}
                </select>
              </label>
            </div>
          </div>
        </div>
        {/* 🔎 「言葉で探す」。手本を見に来た人が一番使う所。
               ⚠縦積み(スマホ・タブレット縦)の時に下端が切れないよう、
                 高さの上限(max-h)と はみ出しの逃がし(overflow-y-auto)を必ず付ける。 */}
        {findOn && findWords.length > 0 && (
          <div className="w-full md:w-80 shrink-0 max-h-[40vh] md:max-h-none bg-white rounded-xl p-2.5 overflow-y-auto space-y-2 text-sm" onClick={(e) => e.stopPropagation()} data-find-panel="1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-700">🔎 言葉で探す</span>
              <button onClick={() => setFindOn(false)} className="ml-auto fi-tap-text font-bold text-slate-500 hover:text-slate-800 px-2 py-1 rounded hover:bg-slate-100">閉じる</button>
            </div>
            <VideoWordFinder words={findWords} compact
              onJump={(at) => { seekTo(at); const v = videoRef.current; if (v) v.play().catch(() => { /* 端末が自動再生を止めた時は止まったまま */ }); }} />
          </div>
        )}
      </div>
    </div>
  );
};

// アプリ内で動画撮影(映像+音声)→Driveへアップロード。目安1〜3分(超えたら警告色)。
// aceTarget/withPhotoTool(統合フロー「動画で資料を作る」用): プレビューで「この動画で作る物」をチェックで選ぶ。
//   aceTarget=工程名 → 「手本として登録」チェックを出す / withPhotoTool → 「写真・説明を作る」チェックを出す。
//   手本のチェックを外すと動画はDriveに保存されない(写真づくりにだけ使う)。両方未指定なら従来どおりの撮影→アップロードのみ。
const VideoRecordModal = ({ open, sections = [], defaultName = '', onDone = null, onClose, aceTarget = null, withPhotoTool = false }) => {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const [phase, setPhase] = useState('live'); // live|rec|preview|uploading|error
  const [err, setErr] = useState('');
  const [blob, setBlob] = useState(null);
  const [name, setName] = useState(defaultName);
  const [dest, setDest] = useState(0);
  const [prog, setProg] = useState(0);
  const [sec, setSec] = useState(0);
  const [makeAce, setMakeAce] = useState(!!aceTarget);                       // 🎬 手本として登録(Drive保存+工程紐づけ)
  const [makePhotos, setMakePhotos] = useState(!aceTarget && withPhotoTool); // 📸 写真切り出し+説明文(工程未保存の時は写真づくりが既定)
  useEffect(() => {
    if (!open || blob) return;
    let on = true;
    (async () => {
      try {
        const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
        if (!on) { st.getTracks().forEach(tr => tr.stop()); return; }
        streamRef.current = st;
        if (videoRef.current) { videoRef.current.srcObject = st; videoRef.current.muted = true; videoRef.current.play().catch(() => {}); }
      } catch (e) { setErr('カメラ/マイクを起動できません: ' + (e?.message || e)); setPhase('error'); }
    })();
    return () => { on = false; try { streamRef.current?.getTracks().forEach(tr => tr.stop()); } catch (e) { /* noop */ } streamRef.current = null; };
  }, [open, blob]);
  useEffect(() => { if (phase !== 'rec') return; const t = setInterval(() => setSec(s => s + 1), 1000); return () => clearInterval(t); }, [phase]);
  if (!open) return null;
  const startRec = () => {
    const st = streamRef.current; if (!st) return;
    const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    const mt = (window.MediaRecorder && cands.find(c => MediaRecorder.isTypeSupported(c))) || '';
    let mr;
    try { mr = new MediaRecorder(st, mt ? { mimeType: mt, videoBitsPerSecond: 5000000 } : undefined); }
    catch (e) { setErr('この端末は動画録画に対応していません: ' + (e?.message || e)); setPhase('error'); return; }
    chunksRef.current = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    mr.onstop = () => { setBlob(new Blob(chunksRef.current, { type: mr.mimeType || 'video/webm' })); setPhase('preview'); try { streamRef.current?.getTracks().forEach(tr => tr.stop()); } catch (e2) { /* noop */ } };
    mr.start(1000); recRef.current = mr; setSec(0); setPhase('rec');
  };
  const stopRec = () => { try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); } catch (e) { /* noop */ } };
  const doUpload = async () => {
    if (!blob || !sections[dest]) return;
    const ext = (() => { const t = blob.type || ''; if (t.includes('mp4')) return 'mp4'; if (t.includes('quicktime')) return 'mov'; if (t.includes('webm')) return 'webm'; const m = String(blob.name || '').match(/\.([A-Za-z0-9]+)$/); return m ? m[1].toLowerCase() : 'webm'; })();
    const base = (name.trim() || defaultName || '作業動画').replace(/[\\/:*?"<>|]/g, '_');
    const d = new Date();
    const fname = `${base}_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.${ext}`;
    setPhase('uploading'); setProg(0);
    try {
      const uploaded = await driveUploadFile(new File([blob], fname, { type: blob.type || 'video/webm' }), sections[dest].path, setProg);
      onDone && onDone(uploaded, blob, { makePhotos }); // uploaded={id,name}(工程への自動紐づけ用) / blob=元動画 / makePhotos=続けて写真・説明づくりへ
    } catch (e) { setErr('アップロード失敗: ' + (e?.message || e)); setPhase('error'); }
  };
  return (
    <div className="fixed inset-0 z-[560] bg-black/90 flex flex-col items-center justify-center p-3" onClick={(e) => e.stopPropagation()}>
      {/* ⚠撮った物を「確認して問題なければアップロード」と言う画面。枠が狭いと確認にならない */}
      <div className="w-full max-w-4xl space-y-2">
        <div className="flex items-center justify-between text-white">
          <span className="font-bold text-sm">{withPhotoTool ? '🎥 動画で資料を作る' : '🎥 手本動画を撮影'}{phase === 'rec' && <span className={`ml-2 font-mono ${sec > 180 ? 'text-rose-400' : 'text-emerald-300'}`}>● {vrFmtT(sec)}{sec > 180 ? '(目安1〜3分を超えています)' : ''}</span>}</span>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/20"><X className="w-5 h-5" /></button>
        </div>
        {phase === 'error' ? (
          <div className="bg-rose-50 border border-rose-300 rounded-lg p-3 text-sm text-rose-700">{err}</div>
        ) : blob ? (
          // ⚠`w-full max-h-*` は縦向きの動画を痩せさせる(縦持ちスマホで撮ると絵が217px幅になる)。
          //   高さを持った箱 + object-contain にして、縦でも横でも入る限り大きく映す。
          <video src={URL.createObjectURL(blob)} controls playsInline className="w-full h-[62vh] object-contain rounded-lg bg-black" />
        ) : (
          <video ref={videoRef} playsInline muted className="w-full h-[62vh] object-contain rounded-lg bg-black" />
        )}
        {phase === 'live' && (
          <div className="space-y-2">
            <button onClick={startRec} className="w-full bg-rose-600 hover:bg-rose-500 text-white rounded-lg py-3 font-bold">● 録画開始(音声も入ります)</button>
            <label className="w-full block bg-white/10 hover:bg-white/20 text-white rounded-lg py-2.5 font-bold text-center text-sm cursor-pointer">
              📁 端末にある動画を選ぶ(撮影済みの動画をそのまま使う)
              <input type="file" accept="video/*" className="hidden" onChange={(e) => { const f = e.target.files && e.target.files[0]; if (!f) return; setBlob(f); if (!name.trim() && f.name) setName(f.name.replace(/\.[^.]+$/, '')); setPhase('preview'); try { streamRef.current?.getTracks().forEach(tr => tr.stop()); } catch (e2) { /* noop */ } e.target.value = ''; }} />
            </label>
          </div>
        )}
        {phase === 'rec' && <button onClick={stopRec} className="w-full bg-slate-100 hover:bg-white text-slate-900 rounded-lg py-3 font-bold">■ 録画終了</button>}
        {phase === 'preview' && blob && (
          <div className="bg-white rounded-xl p-3 space-y-2">
            <div className="text-xs text-slate-500">サイズ: {driveFmtSize(blob.size)} / 確認して問題なければ次へ</div>
            {(aceTarget || withPhotoTool) && (
              <div className="border border-slate-200 bg-slate-50 rounded-lg p-2 space-y-1.5">
                <div className="fi-tap-text font-bold text-slate-500">この動画で作る物(チェックした物だけ)</div>
                {aceTarget && (
                  <label className="flex items-start gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={makeAce} onChange={(e) => setMakeAce(e.target.checked)} className="mt-0.5" />
                    <span>🎬 工程「{aceTarget}」の手本として登録<span className="block font-normal fi-tap-text text-slate-500">Driveに保存され、作業画面のこの工程の場所に自動で出ます</span></span>
                  </label>
                )}
                {withPhotoTool && (
                  <label className="flex items-start gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={makePhotos} onChange={(e) => setMakePhotos(e.target.checked)} className="mt-0.5" />
                    <span>📸 写真を切り出して説明文を作る<span className="block font-normal fi-tap-text text-slate-500">コマ取り+AI下書き(この後の画面で作ります)</span></span>
                  </label>
                )}
                {aceTarget && !makeAce && <div className="fi-tap-text text-amber-600 font-bold">⚠ 手本登録しないため、動画はDriveに保存されません(写真づくりに使うだけ)</div>}
              </div>
            )}
            {((aceTarget || withPhotoTool) ? makeAce : true) && (<>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="動画名(例: 面板取付_エース手本)" className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
              <select value={dest} onChange={(e) => setDest(Number(e.target.value))} className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm">
                {sections.map((s, i) => <option key={i} value={i}>保存先: {s.label}</option>)}
              </select>
            </>)}
            <div className="flex gap-2">
              <button onClick={() => { setBlob(null); setPhase('live'); }} className="flex-1 bg-slate-200 text-slate-600 rounded-lg py-2 font-bold text-sm">撮り直す</button>
              {(aceTarget || withPhotoTool) && !makeAce ? (
                <button disabled={!makePhotos} onClick={() => onDone && onDone(null, blob, { makePhotos: true })} className={`flex-[2] rounded-lg py-2 font-bold text-sm ${makePhotos ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-slate-100 text-slate-300'}`}>📸 写真づくりへ進む(動画は保存しない)</button>
              ) : (
                <button onClick={doUpload} className="flex-[2] bg-sky-600 hover:bg-sky-500 text-white rounded-lg py-2 font-bold text-sm">⬆ Driveへアップロード{makePhotos ? '→写真づくりへ' : ''}</button>
              )}
            </div>
          </div>
        )}
        {phase === 'uploading' && (
          <div className="bg-white rounded-xl p-4 space-y-2">
            <div className="text-sm font-bold text-slate-700">アップロード中… {Math.round(prog * 100)}%</div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-sky-500 rounded-full transition-all" style={{ width: `${prog * 100}%` }} /></div>
          </div>
        )}
      </div>
    </div>
  );
};

// ===== 🎥 教材の録画バー (仕様書 §4-2) =====
// 作業しながら録るための小さなバー。実体(カメラ/MediaRecorder/打刻)は
// src/trainingRecorder.js に module-level で置いてあり、ここは「見るだけ+押すだけ」。
//
// ⚠位置(2026-08-09 是正・あら探し#1 critical): **画面に浮かせない**。
//   旧: `fixed top-16 right-3 w-64 z-[210]`。作業画面ヘッダー右端の【測定時間表/全作業完了/✕】と
//   物理的に重なり(1280x800 の custom で 204px)、撮影中〜アップロード中はそれらが押せなくなっていた。
//   しかも押したタップはバーの <video> に吸われて「無反応」に見える。
//   新: 作業画面の `flex flex-col` の中に、ヘッダー直下の **shrink-0 な帯** として差し込む。
//   同じ列で場所を分け合うので、重なりは**原理的に**起きない(端末幅・文字サイズに依存しない)。
//   ⚠帯は shrink-0 だが、下の本文は `flex-1` なので本文が縮むだけ。下端が消える形にはしない。
// ⚠拡大画面(z-[300] の測定/チェック/注意事項)にも同じ帯を置く。z を上げて浮かせると今度は
//   拡大画面のヘッダーを覆うので、そちらも「帯」で解決する(あら探し#17)。
// ⚠作業画面を閉じた後もアップロード中は進捗と再送が要る。その時だけ variant='floating' で App 直下に出す。
//   置き場所は左下: 右下は「別エリア自動測定」ウィジェットと🎬手本の小窓が使う(あら探し#5)。
const TrainingRecorderBar = ({ onStop = null, onCancel = null, onRetry, onDiscard, variant = 'band', showPreview = true }) => {
  const [, force] = useState(0);
  const [mini, setMini] = useState(false);
  useEffect(() => subscribeTrainingRecorder(() => force(v => v + 1)), []);
  // 録画中だけ毎秒描き直す(止まっている時に無駄な再描画をしない)
  useEffect(() => {
    const iv = setInterval(() => { if (trainingRecorderState().active) force(v => v + 1); }, 1000);
    return () => clearInterval(iv);
  }, []);
  const st = trainingRecorderState();
  if (!st.busy) return null;
  const danger = st.elapsedSec >= TRAINING_DANGER_SEC;
  const warn = !danger && st.elapsedSec >= TRAINING_WARN_SEC;
  const tone = danger ? 'border-rose-400 bg-rose-900' : warn ? 'border-amber-400 bg-amber-900' : 'border-slate-500 bg-slate-800';
  const floating = variant === 'floating';
  // ⚠手袋の手でも押せるよう、どのボタンも高さ36px以上を確保する。
  const btn = 'rounded px-3 min-h-[36px] fi-tap-text font-black flex items-center justify-center';
  return (
    <div className={floating
      ? `fixed bottom-4 left-4 z-[210] w-72 max-w-[calc(100vw-2rem)] rounded-2xl shadow-2xl border-2 text-white overflow-hidden ${tone}`
      : `shrink-0 w-full border-b-2 text-white ${tone}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
        <span className="text-sm font-black flex items-center gap-1 shrink-0">
          <span className={st.phase === 'recording' ? 'animate-pulse' : 'opacity-50'}>🔴</span>
          <span className="font-mono tabular-nums">{vrFmtT(st.elapsedSec)}</span>
        </span>
        <span className="fi-tap-text font-bold opacity-80 shrink-0">教材を撮影中</span>
        {showPreview && !mini && st.active && <video ref={attachTrainingPreview} muted playsInline className="w-16 h-9 object-cover rounded bg-black shrink-0" />}
        {!mini && (
          <span className="fi-tap-text leading-tight opacity-90 shrink-0">
            章 {st.stepCount}件{st.breakCount > 0 ? ` / 休憩 ${st.breakCount}` : ''} ・{driveFmtSize(st.bytes) || '0B'}{st.meta?.withAudio ? ' / 音声あり' : ' / 音声なし'}
          </span>
        )}
        {(danger || warn) && <span className={`fi-tap-text font-black shrink-0 ${danger ? 'text-rose-200' : 'text-amber-200'}`}>{danger ? '⚠ 30分超。そろそろ終了を' : '⚠ 15分超'}</span>}
        <button onClick={() => setMini(v => !v)} className="ml-auto shrink-0 bg-white/15 hover:bg-white/25 rounded px-3 min-h-[36px] fi-tap-text font-bold flex items-center justify-center" title={mini ? '詳しく出す' : '細くたたむ'}>{mini ? '▾' : '▴'}</button>
        {(st.phase === 'recording' || st.phase === 'paused') && (
          <span className="flex items-center gap-1 shrink-0">
            {st.phase === 'recording'
              ? <button onClick={() => { if (!pauseTrainingRecording()) alert('この端末では録画の一時停止に対応していません。'); }} className={`bg-white/15 hover:bg-white/25 ${btn}`}>⏸ 一時停止</button>
              : <button onClick={() => resumeTrainingRecording()} className={`bg-emerald-600 hover:bg-emerald-500 animate-pulse ${btn}`}>▶ 再開</button>}
            {onStop && <button onClick={onStop} className={`bg-rose-600 hover:bg-rose-500 ${btn}`}>⏹ 終了して教材にする</button>}
            {onCancel && <button onClick={onCancel} className={`bg-white/10 hover:bg-white/20 ${btn}`} title="撮影をやめる(保存しない)">✕</button>}
          </span>
        )}
      </div>
      {st.phase === 'uploading' && (
        <div className="px-2.5 pb-2 space-y-1">
          <div className="fi-tap-text font-bold">保存中… {Math.round((st.progress || 0) * 100)}%（この画面を閉じても保存は続きます。閉じないでください）</div>
          <div className="h-1.5 bg-white/20 rounded-full overflow-hidden"><div className="h-full bg-sky-400 rounded-full transition-all" style={{ width: `${(st.progress || 0) * 100}%` }} /></div>
        </div>
      )}
      {st.phase === 'finishing' && <div className="px-2.5 pb-2 fi-tap-text font-bold">動画をまとめています…</div>}
      {st.phase === 'failed' && (
        <div className="px-2.5 pb-2 space-y-1">
          <div className="fi-tap-text font-bold text-rose-200 leading-tight">{st.error || '保存に失敗しました'}</div>
          <div className="fi-tap-text opacity-80 leading-tight">動画はこの端末に残っています。もう一度送れます。</div>
          <div className="flex flex-wrap gap-1">
            <button onClick={onRetry} className={`bg-sky-600 hover:bg-sky-500 ${btn}`}>↻ もう一度送る</button>
            <button onClick={onDiscard} className={`bg-white/15 hover:bg-white/25 ${btn}`}>捨てる</button>
          </div>
        </div>
      )}
    </div>
  );
};

// ===== 🎬 工程開始で出る小窓プレイヤー (仕様書 §5) =====
// チャプターがあれば **その区間だけ** 再生する。無い動画(従来の工程ひも付けだけ)は頭から。
// ⚠区間の解釈(とばす/止まる/倍速)は RecipePlayer と同じ src/domain/videoRecipe.js を通す。
// ⚠自動再生は必ず消音で始める(ブラウザが音つき自動再生を止めるため。黙って再生されないのを防ぐ)。
// ⚠小窓そのものだけが押せる実体。背後に透明な壁は作らない。
// ⚠⚠2026-08-09 方針転換: **既定は「たたんだ🎬チップ」**。工程を開始しても勝手に開かない。
//   開く/たたむは親が持つ(open / onOpenChange)。親が持たないと「開いている間だけ余白を足す」等の
//   判断ができず、たたんでいるのに余白だけ残る = 別の崩れになる。
//   根拠: 手本を出しっぱなしにすると熟練者はむしろ遅くなる(熟達逆転効果 Kalyuga 2003 /
//   組立現場の実測 Funk 2017)。分節化が効くのは「学習者がペースを握る」時だけ(Mayer)。
//   → 自動で開かず、本人が押した時だけ開く形が、押せないボタンを無くすと同時に学習効果でも正しい。
const ChapterMiniPlayer = ({ recipe, chapter = null, stepLabel = '', onExpand = null, onClose, raise = false, side = 'right', execFontScale = 100, dock = false, open = false, onOpenChange = null, attention = false }) => {
  const videoRef = useRef(null);
  const lastTRef = useRef(0);
  const firedPauseRef = useRef(new Set());
  const fixingRef = useRef(false);
  const [dur, setDur] = useState(0);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [muted, setMuted] = useState(true);
  // ⚠開閉は親の持ち物(制御コンポーネント)。ここに useState を戻すと親の余白判断とズレる。
  const collapsed = !open;
  const setCollapsed = (v) => { if (typeof onOpenChange === 'function') onOpenChange(!v); };
  // ⚠読み込み失敗を黙って黒画面にしない。撮影(保存)の失敗は明示メッセージを出しているのに
  //   再生側だけ黙るのは非対称で、新人は「壊れている」のか「まだ出ていない」のか判別できない。
  const [loadErr, setLoadErr] = useState(false);
  const [tip, setTip] = useState(null); // 要点ポイントの言葉(小窓では止めずに字幕で出す)
  // ⭕印も止めずに数秒だけ出す。⚠出しっぱなしにすると次の場面で違う所を指してしまう。
  const [marks, setMarks] = useState([]);
  const [vbox, setVbox] = useState({ left: 0, top: 0, width: 1, height: 1 });
  // ⚠映像の枠の縦横比。⚠初期値 '16 / 9' を絶対に外さない('auto' にすると浮き窓で高さが 0 になり、
  //   小窓そのものが消える(実測 159.75px→0)。動画のメタ情報が届くまでの間を必ず 16:9 で埋める)。
  //   これを入れる前は video 側に aspect-video + max-h-full を付けていたが、浮き窓では max-h-full が
  //   解決できず映像が枠から溢れ(文字160%で +59.5px)、⏸/⏮/🔁/🔇/速度 の上に <video> が乗って
  //   「押すと再生が止まるだけ」になっていた。枠の側で比を持てば映像は絶対に枠を超えない。
  const [vAR, setVAR] = useState('16 / 9');
  const vwrapRef = useRef(null);
  const markTimerRef = useRef(null);
  useEffect(() => () => { if (markTimerRef.current) clearTimeout(markTimerRef.current); }, []);
  useEffect(() => { if (!tip) return; const t = setTimeout(() => setTip(null), 5000); return () => clearTimeout(t); }, [tip]);
  // ⚠⚠枠の大きさが変わったら⭕印(RecipeMarks)の座標を取り直す。**これが無いと印がズレる**。
  //   実測: 箱の形だけを変えても <video> の resize / loadeddata は **0回**しか飛ばない。
  //   いままで印が合っていたのは「枠が常に 16:9 で、box が寸法に依らず一定」という偶然によるもの。
  //   比を動的(vAR)にした瞬間にその偶然は消える(実測 {0,0.0008,1,0.9984} → {0.2058,0,0.5884,1})。
  useEffect(() => {
    const el = vwrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { const v = videoRef.current; if (v) setVbox(vboxOf(v)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed]);
  // ⚠拡大画面(z-[300])が開いたら一旦たたむ。z を上げて出しっぱなしにすると拡大画面の中身を覆う。
  //   たたんだ🎬チップは拡大画面より前に出す(見たくなったら押せる)。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (raise) setCollapsed(true); }, [raise]);
  const zCls = raise ? 'z-[320]' : 'z-[150]';
  const span = chapter ? clampChapter(chapter, dur) : null;
  const start = span ? span.start : 0;
  const end = span ? span.end : (dur || 0);
  const seekStart = () => { const v = videoRef.current; if (!v) return; try { v.currentTime = start; } catch { /* noop */ } lastTRef.current = start; firedPauseRef.current = new Set(); };
  const onTime = () => {
    const v = videoRef.current; if (!v) return;
    if (fixingRef.current) return;
    const t = v.currentTime; setCur(t);
    const prev = lastTRef.current;
    if (t < prev - 0.5) firedPauseRef.current = new Set();
    // 区間の終わり: ループなら頭へ・でなければ止める(章の外へはみ出して別工程を見せない)
    if (end > 0 && t >= end - 0.03) {
      if (loop) { seekStart(); v.play().catch(() => {}); return; }
      v.pause();
      lastTRef.current = t;
      return;
    }
    const act = recipeActionAt({ events: recipeEventsOf(recipe), t, prev, firedPauseIds: firedPauseRef.current, userSpeed: speed });
    if (act.skip) { // 休憩などの飛ばし。章の外へ出ないように end で止める
      const to = Math.min((act.skip.end || act.skip.start) + 0.01, end > 0 ? end : Infinity);
      // ⚠飛ばし先が章の終わりを超えている(=章の残りが丸ごと休憩)場合、ここでループさせると
      //   「頭へ戻る→また飛ばす」を往復して映像が1ミリも進まない(あら探し#4の症状)。必ず止めて理由を出す。
      if (end > 0 && to >= end - 0.03) {
        v.pause();
        lastTRef.current = t;
        setTip('この先は休憩でした（この章はここまでです）');
        return;
      }
      try { v.currentTime = to; } catch { /* noop */ }
      lastTRef.current = to;
      return;
    }
    // ⚠小窓では停止しない。手がふさがっている作業中に「タップしないと進まない」は成立しないため、
    //   要点の言葉だけを字幕として出す(止めて見たい時は⤢拡大でスタジオを開く)。
    // ⚠⚠ 印(〇/→)も **止めずに** 数秒だけ出す(2026-08-13 是正)。
    //   いままで小窓には印が1つも出ておらず、「ここを見る」の赤丸が作業画面で消えていた。
    //   赤丸こそ手本の中身なので、字幕だけでは伝わらない。
    if (act.pause) {
      firedPauseRef.current.add(act.pause.id);
      setTip(act.pause.label || act.pause.text || '');
      const mk = Array.isArray(act.pause.marks) ? act.pause.marks : [];
      if (mk.length) {
        setMarks(mk);
        if (markTimerRef.current) clearTimeout(markTimerRef.current);
        // 出しっぱなしにしない(次の場面に古い印が残ると、間違った所を指してしまう)
        markTimerRef.current = setTimeout(() => setMarks([]), 5000);
      }
    }
    if (Math.abs(v.playbackRate - act.rate) > 0.01) v.playbackRate = act.rate;
    lastTRef.current = t;
  };
  const togglePlay = () => { const v = videoRef.current; if (!v) return; if (v.paused) { if (end > 0 && v.currentTime >= end - 0.05) seekStart(); v.play().catch(() => {}); } else v.pause(); };
  const pct = end > start ? Math.max(0, Math.min(100, ((cur - start) / (end - start)) * 100)) : 0;
  // ⚠置き場所(2026-08-09 是正・あら探し#12): 逐次モードは右パネル(w-80)に
  //   【不具合報告 / 軽微不良 / 気づき・改善 / 中断】が縦に並んでいて、右下に出すとその8割を覆う。
  //   とくに「中断」は休憩のたびに押すボタン。逐次では左下へ寄せる(左下の✋サイン小窓はカスタム専用)。
  const sideCls = side === 'left' ? 'left-4' : 'right-4';
  // ⚠手袋の手でも押せるよう、ヘッダーの3ボタンは 36x36px 以上。以前は約24x18pxで、
  //   ✕を狙って隣の⤢(全画面が開く)を誤爆していた。いちばん不慣れな人がこれを引かされる。
  const hBtn = 'text-xs font-bold bg-white/20 hover:bg-white/30 rounded min-w-[36px] min-h-[36px] shrink-0 flex items-center justify-center';
  // ⚠⚠作業画面は `[data-fs="execution"] { zoom: X; width: 100/X vw; height: 100/X vh }`(applyFontSizes)で
  //   拡大される。**中身の寸法は割り戻して補正してあるのに、fixed のこの小窓だけが補正の外**にいるため、
  //   文字を大きくするほど小窓が画面に占める割合だけが増え、ヘッダーの【全作業完了】【測定時間表】や
  //   工程詳細の【編集】を物理的に覆って押せなくする(= commit 75a25e2 で激怒された「押せないボタン」と
  //   まったく同じ構造の再発)。しかもこの小窓が自動で出るのは教育中の人だけ＝いちばん不慣れな人が引く。
  //   → 逆倍率(zoom: 100/X)を当てて、文字サイズに関係なく**画面上の大きさを一定**にする。
  //   ⚠ここで px 直書きの寸法(w-64 / bottom-20 / max-h)は拡大に追従しなくなるが、それが狙い。
  //     小窓の中の文字は元々 fi-tap-text 等の固定サイズで、拡大対象は作業の中身の方。
  // ⚠⚠逆倍率(unzoom)は撤去した(2026-08-14)。
  //   これは `[data-fs="execution"] { zoom: X; width: 100/X vw }` が、fixed の小窓の
  //   `right-4`/`bottom-20` を k 倍して画面上の位置と大きさを狂わせていたことへの打ち消しだった。
  //   applyFontSizes が zoom をやめた今、小窓は素のビューポート座標に戻る。
  //   実測(1024x768・70/100/130/160%): 右端 1008 / 下端 688 で**全倍率とも不動**
  //   (zoom 時は右端 1013→998・下端 712→640 と動いていた)。打ち消す相手がもう居ない。
  //   ⚠小窓の**大きさ**は自分の px-4 / text-xs が伸びるので 60→138px になる。これは意図どおり
  //     (この小窓が自動で出るのは教育中の人＝文字を大きくしたい当人)。
  //     もしハーネスがボタンを覆うのを検出したら、zoom を戻さず .fs-fixed で変数だけ既定に戻すこと。
  // ⚠⚠置き場所の根治(2026-08-09 是正・出荷停止#1): **カスタムでは浮かせない**。
  //   浮いた小窓(fixed bottom-20 right-4)は、カスタムの右パネル(w-96 = 工程詳細)と幅がまるごと重なり、
  //   画面を開いた初期位置(scrollTop=0)で【内容・注意点 編集】が 100% 覆われて 9点中0点しか押せなかった。
  //   しかもこの小窓が自動で出るのは**教育中の人だけ**＝いちばん不慣れな人が「押しても無反応」を引く。
  //   ⚠別の場所へ「動かす」だけの直しは採らない。録画バー(§3816)→この小窓 と、浮かせるたびに
  //     次の被害者が出ている。録画バーで効いた解(=**同じ列に場所を分け合う**)をここでも採る:
  //     カスタムでは右パネルの流れの中(dock)に置き、重なりを**原理的に**起こさない。
  //     端末幅・文字サイズ・スクロール位置のどれにも依存しない。
  //   ⚠逐次(sequential)は左下の浮きのまま(前回の検証で押せなくなるボタン0件。既存を壊さない)。
  //     ただし 140%/180% では詳細ペインの**末尾**の操作が小窓の帯に入りうる(自作ハーネスの実測)。
  //     ここは今回の指示の対象外なので手を入れていない = 未解決として残っている。
  //   ⚠拡大画面(raise)は従来どおり浮いた🎬チップに戻す。拡大画面は右パネルを覆うので、
  //     dock のままだとチップごと隠れて「見たくなっても出せない」になる。
  //   ⚠⚠2026-08-09 追記(dock を残した判断): 「開いたら浮かせる(floating に統一)」も検討したが、
  //     浮きは custom の右パネル(x 486〜1024 / 1024×768・140%)と丸ごと重なり、
  //     【内容・注意点 編集】が **開いている間ずっと押せない**(事故#3 と同じ形)。
  //     dock は押し出すだけで**覆わない**ので、パネルの overflow-y-auto でスクロールすれば必ず届く。
  //     「覆う(=無反応)」と「押し出す(=スクロールで届く)」は別物。前者だけを原理的に殺す。
  //     押し出す量が問題だった事故#4 は、**既定でたたむ**(open=false)ことで根を断った。
  const docked = dock && !raise;
  const shellStyle = undefined; // ⚠逆倍率(unzoom)撤去に伴い dock/浮きとも素の座標系。
  if (collapsed) {
    // 🎬チップ(既定の姿)。⚠**これは何も覆わない/押し出さない**のが存在理由。
    //   custom は右パネルの流れの中(44px)、sequential は左下の小さな丸(逆倍率で大きさ一定)。
    //   attention = 工程が変わって新しい手本がある合図。色と枠を変えるだけ(位置も大きさも変えない)。
    return (
      <button onClick={() => setCollapsed(false)}
        title={attention ? `この工程の手本があります: ${stepLabel || ''}（押すと小窓が開きます）` : '手本動画の小窓を開く'}
        style={shellStyle}
        className={`${docked
          ? 'w-full mb-3 shrink-0 rounded-xl shadow border-2 px-4 min-h-[44px] text-xs font-black flex items-center justify-center gap-1.5'
          : `fixed bottom-20 ${sideCls} ${zCls} rounded-full shadow-2xl border-2 px-4 min-h-[44px] text-xs font-black flex items-center gap-1.5`
        } ${attention
          ? 'bg-amber-500 hover:bg-amber-400 text-white border-amber-200 ring-4 ring-amber-300/60'
          : 'bg-sky-600 hover:bg-sky-500 text-white border-sky-300'}`}>
        🎬 手本{attention ? <span className="bg-white/25 rounded px-1 py-0.5 leading-none">この工程の手本あり</span> : null}
      </button>
    );
  }
  return (
    // ⚠縦積み: 縮む側は**映像**、ボタン列(ヘッダー/操作)は shrink-0。全部 shrink-0 にすると
    //   max-h に当たった時に一番下の操作列が消える(過去の前科)。逆に映像だけを縮ませれば操作は必ず残る。
    // ⚠dock 時の max-h-[75%]: 文字180%だと小窓の高さが右パネルの見えている高さを丸ごと食い、
    //   下に続く【表示中の機番 #1/#2】がスクロールしないと出てこなくなる(実測 1280×800/180% で 0/9)。
    //   75% は 100/120/140% では**1pxも効かない**(実測: 小窓の高さが cap 無しと同一)。180% だけを救う値。
    <div style={shellStyle} className={docked
      ? 'w-full mb-3 shrink-0 max-h-[75%] flex flex-col bg-slate-900/95 text-white rounded-2xl shadow-lg border-2 border-sky-400 overflow-hidden'
      : `fixed bottom-20 ${sideCls} ${zCls} w-64 sm:w-72 max-w-[calc(100vw-2rem)] max-h-[320px] flex flex-col bg-slate-900/95 text-white rounded-2xl shadow-2xl border-2 border-sky-400 overflow-hidden`}>
      <div className="flex items-center gap-1 px-2 py-1 bg-sky-700 shrink-0">
        <span className="fi-tap-text font-black truncate flex-1 min-w-0" title={stepLabel}>🎬 {stepLabel || '手本'}</span>
        {onExpand && <button onClick={onExpand} className={hBtn} title="大きい画面で見る(要点で自動停止)">⤢</button>}
        <button onClick={() => setCollapsed(true)} className={hBtn} title="たたむ">▾</button>
        <button onClick={onClose} className={hBtn} title="閉じる">✕</button>
      </div>
      {/* ⚠縦横比は**枠**が持つ(video ではない)。video を absolute inset-0 で枠に貼り付ければ、
          文字サイズをいくつにしても映像が枠からはみ出す事は原理的に起こらない。
          ⚠min-h-0 は残す事(縦積み flex で縮む側でいられなくなり、下の操作列が消える)。 */}
      <div ref={vwrapRef} className="relative bg-black flex-1 min-h-0" style={{ aspectRatio: vAR }}>
        <video ref={videoRef} src={driveFileUrl(recipe.fileId)} className="absolute inset-0 w-full h-full object-contain bg-black" playsInline muted={muted} autoPlay
          onError={() => setLoadErr(true)}
          onLoadStart={() => setLoadErr(false)}
          onTimeUpdate={onTime}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onClick={togglePlay}
          onEnded={() => { if (loop) { seekStart(); videoRef.current?.play().catch(() => {}); } }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            // ⚠videoWidth が 0 の時は触らない(0 を入れると枠の高さが消える)。縦撮りの手本もここで正しい比になる。
            if (v.videoWidth && v.videoHeight) setVAR(`${v.videoWidth} / ${v.videoHeight}`);
            const go = () => { seekStart(); v.play().catch(() => {}); };
            if (Number.isFinite(v.duration) && v.duration > 0) { setDur(v.duration); go(); return; }
            // MediaRecorder の webm は duration が Infinity で来る。末尾へ飛ばすと確定する(スタジオと同じ手)
            fixingRef.current = true;
            const fix = () => { if (Number.isFinite(v.duration) && v.duration > 0) { v.removeEventListener('timeupdate', fix); setDur(v.duration); fixingRef.current = false; go(); } };
            v.addEventListener('timeupdate', fix);
            try { v.currentTime = 1e7; } catch { /* noop */ }
          }}
          onDurationChange={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDur(d); }}
          onResize={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setVAR(`${v.videoWidth} / ${v.videoHeight}`);
            setVbox(vboxOf(v));
          }}
          onLoadedData={(e) => setVbox(vboxOf(e.currentTarget))} />
        {/* 読み込めなかった時は黒いまま黙らない(Drive の権限切れ・通信断がいちばん多い) */}
        {loadErr && (
          <div className="absolute inset-0 bg-slate-900/95 flex items-center justify-center px-2 text-center">
            <div className="text-rose-300 fi-tap-text font-black leading-snug">⚠ 動画を読み込めませんでした<br/>（通信／権限をご確認ください）</div>
          </div>
        )}
        {/* ⭕印。⚠黒帯(レターボックス)を除いた「絵の範囲」に重ねる。
            枠は動画の実比(vAR)に合わせるので帯はほぼ出ないが、メタ情報が届く前や
            max-h に当たった時は帯が出るので、box は必ず実測値(vboxOf)を使う。 */}
        <RecipeMarks marks={marks} box={vbox} />
        {tip && <div className="absolute inset-x-0 bottom-0 bg-amber-400/95 text-black fi-tap-text font-black px-2 py-1 leading-tight">⏸ {tip}</div>}
      </div>
      <div className="h-1 bg-white/15 shrink-0"><div className="h-full bg-sky-400" style={{ width: `${pct}%` }} /></div>
      <div className="flex items-center gap-1 px-2 py-1.5 shrink-0">
        <button onClick={togglePlay} className="bg-white/15 hover:bg-white/25 rounded px-2 py-1 fi-tap-text font-bold shrink-0">{playing ? '⏸' : '▶'}</button>
        <button onClick={() => { seekStart(); videoRef.current?.play().catch(() => {}); }} className="bg-white/15 hover:bg-white/25 rounded px-2 py-1 fi-tap-text font-bold shrink-0" title="この章の頭から">⏮</button>
        <button onClick={() => setLoop(v => !v)} className={`rounded px-2 py-1 fi-tap-text font-bold shrink-0 ${loop ? 'bg-sky-500' : 'bg-white/15 hover:bg-white/25'}`} title="この章をくり返す">🔁</button>
        <button onClick={() => setMuted(m => !m)} className="bg-white/15 hover:bg-white/25 rounded px-2 py-1 fi-tap-text font-bold shrink-0" title={muted ? '音を出す(コツを喋っている教材なら聞ける)' : '消音にする'}>{muted ? '🔇' : '🔊'}</button>
        <select value={speed} onChange={(e) => { const s = Number(e.target.value); setSpeed(s); const v = videoRef.current; if (v) v.playbackRate = s; }} className="ml-auto bg-white/15 rounded px-1 py-1 fi-tap-text font-bold shrink-0" title="再生速度">
          {[0.5, 0.75, 1].map(s => <option key={s} value={s} className="text-slate-800">{s}×</option>)}
        </select>
      </div>
      <div className="px-2 pb-1.5 fi-tap-text leading-tight text-slate-300 shrink-0">
        {span ? `この工程の場面だけ (${vrFmtT(start)}〜${vrFmtT(end)}) を出しています` : 'この動画には工程の区間が無いので、頭から出しています'}
      </div>
    </div>
  );
};

// 埋め込みモード(?embed=map): ③司令塔の「工場別」が、このアプリの現場マップ画面【そのもの】をiframeで表示するために使う。
// ヘッダーを隠すだけ(初期タブは元々 main=現場マップ)。画面の中身・見た目・動きは通常と完全に同一で、
// 通常アクセス(パラメータ無し)には一切影響しない。

export { VideoProcessModal, DriveDocsModal as VideoDriveDocsModal, RecipePlayer, VideoRecordModal, TrainingRecorderBar, ChapterMiniPlayer, driveUploadFile };
