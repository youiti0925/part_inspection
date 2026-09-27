// ============================================================================
// 🎬 動画タブ（動画の棚） — Driveに入っている動画を1画面で全部見て、直す
// ----------------------------------------------------------------------------
// 清水さん(2026-08-16)
//   「動画タブ新しく作った方がいいと思う」
//   「録画とかドライブにいれたやつは一括でリストか何かで管理できるように、
//     そこで移動とか複製とか編集とかできるように」
//   「編集の文字が小さい」
//
// ここでやれる事:
//   ▶ 見る / 🎬 編集室でひらく / 📝 名前を変える / 📦 移す / ⧉ 複製 / 🗑 ゴミ箱へ(復元可)
//   ＋ 名前でしぼる / 並べ替え(新しい順・名前順・大きい順) / 合計の本数と合計の大きさ
//
// ⚠⚠ ここで守っている事（過去に痛い目をみた物）:
//   ① **開いたフォルダだけ読む**。全部いっぺんに読むと Drive への往復が数十回になる。
//   ② **黙って切らない**。中継(Worker)は1フォルダ 200件で打ち切る作りなので、
//      200件ちょうど返ってきたら「これ以上は出せていない」と画面に書く。
//      黙って切ると「Driveには在るのにアプリからは見えない」が再発する。
//   ③ **「削除」と書かない**。書くのは「🗑 ゴミ箱へ(復元可)」。Driveに30日残る。
//   ④ **失敗を黙って空にしない**。読み込み中／空／失敗 の3つを必ず出し分ける。
//   ⑤ **合計は「読み込んだフォルダの分だけ」と正直に書く**。開いていない棚の中身は数えない。
//   ⑥ 出す物の入れ物(メニュー)は **その場で下に開く**。浮かせて出すと親の枠に切られて
//      下半分が見えなくなる(2026-08-14 実機で起きた)。
//   ⑦ 文字は px 直書きしない。text-xs / text-sm / text-base を使う。
//      px 直書きだと文字サイズの設定が効かない。
//      ⚠2026-08-16 実測して直した: この画面の文字 39個のうち **11個が 12px 未満**だった。
//        決めた線 = **押す物(button・押せる物)と、読んで判断する数字(本数・容量・日付)は 12px 以上**。
//        ここで 12px を割っていたのは全部「読んで判断する物」だったので text-xs(12px) 以上へ上げた。
//          ・1本ごとの 容量・更新日時・ファイル名・🎬手本あり  … text-2xs(11px) → text-xs(12px)
//          ・棚のDriveパス                                     … text-3xs(10px) → text-xs(12px)
//          ・下の注意書き(ゴミ箱30日 など)                      … text-2xs(11px) → text-xs(12px)
//        ⚠上げたら **1行が2段に折り返していないか** を必ず実測する(一覧は1行1本が読みやすい)。
//          ここは 1本の行の高さが 57px のまま変わらない事を測って確かめてある。
//   ⑧ 現場はタブレット(指)。押す物は最低 44px。
//   ⑨ **これは「タブの1枚」である**(embedded=true が本来の姿)。
//      ⚠2026-08-16 修正: 以前は必ず `fixed inset-0` の**全画面の幕**として出ていた。
//        タブなのに幕なので、押すと **上のタブ列ごと隠れて他のタブへ行けなかった**。
//        embedded では幕をやめ、親(タブの中身の枠)の中にそのまま並ぶ。
//        ✕も出さない(タブは閉じる物ではない。閉じると行き先が無い)。
//        embedded でない時だけ、今までどおりの幕で出す(他所から窓として呼ぶ道を残す)。
//      ⚠縦スクロールは **この中の一覧ただ1つ**。外側は overflow-hidden のまま。
//        親と二重にすると現場で「下まで行けない」になる。
//
// ⚠この画面は **自分では Firestore を読みに行かない**。手本レシピ(recipes)は
//   もう読んである物を上からもらう。ここで読むと同じ物を二重に読む事になる。
// ============================================================================

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { X, Loader2, Search, RefreshCw } from 'lucide-react';

// 動画とみなす物。中継が mimeType を返さない事があるので、拡張子でも見る。
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|qt|3gp|mkv|avi)$/i;
const isVideoFile = (f) => {
  const mime = String(f?.mimeType || '');
  if (mime.startsWith('video/')) return true;
  return VIDEO_EXT.test(String(f?.name || ''));
};

// ⚠ 中継(worker/src/index.js listChildren)は 200件ずつ続きを取りに行き、**1フォルダ2000件で打ち切る**。
//   打ち切った時は返事に truncated:true が付く。付いていたら必ず画面に書く
//   (黙って切ると「Driveには在るのにアプリからは見えない」が再発する)。
const LIST_CAP = 2000;

const fmtSize = (n) => {
  const v = Number(n) || 0;
  if (!v) return '—';
  if (v < 1024) return `${v}B`;
  if (v < 1048576) return `${Math.round(v / 1024)}KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)}MB`;
  return `${(v / 1073741824).toFixed(2)}GB`;
};

const fmtWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 「あああ.mp4」→「あああのコピー.mp4」
const copyNameOf = (name) => {
  const s = String(name || '動画');
  const i = s.lastIndexOf('.');
  return i > 0 ? `${s.slice(0, i)}のコピー${s.slice(i)}` : `${s}のコピー`;
};

const SORTS = [
  { key: 'new', label: '新しい順' },
  { key: 'name', label: '名前順' },
  { key: 'big', label: '大きい順' },
];

const folderKeyOf = (path) => (Array.isArray(path) ? path : []).join('/');

// 押す物の共通の大きさ。指で狙える 44px を割らない。
const BTN = 'min-h-[44px] px-3 rounded-lg font-bold text-sm flex items-center justify-center gap-1';

/**
 * 🎬 動画の棚
 *
 * @param folders      見に行くフォルダ [{ label, path:['最終','型式','ABC'] }]
 * @param moveTargets  移動/複製の行き先 [{ label, path:[...] }]。空なら folders(自分以外)を行き先にする
 * @param recipes      video_recipes 全件（もう読んである物を渡す。ここでは読みに行かない）
 * @param proxyUrl     Drive の中継URL
 * @param onOpenEditor (file) => void   🎬編集室でひらく。渡さないとボタンを出さない
 * @param onPlay       (file) => void   ▶ 手本を見る。渡さない時はこの画面の中で素の動画を出す
 * @param onDeleteRecipe (fileId) => void  ゴミ箱へ入れた時に手本レシピも外す
 * @param canEdit      false なら 移動/複製/名前/ゴミ箱 を出さない
 * @param embedded     true(本来の姿) = タブの中身として親の枠に収まる。幕にしない・✕を出さない。
 *                     false = 今までどおり画面いっぱいの幕(窓)として出す。
 * @param onClose      閉じる。⚠embedded では使わない(タブに閉じるは要らない)
 */
export const VideoLibrary = ({
  folders = [],
  moveTargets = [],
  recipes = [],
  proxyUrl = '',
  onOpenEditor = null,
  onPlay = null,
  onDeleteRecipe = null,
  canEdit = true,
  embedded = false,
  onClose = null,
}) => {
  // 同じフォルダを二重に並べない(親が同じ棚を2回渡してくる事がある)。
  const shelves = useMemo(() => {
    const seen = new Set();
    const out = [];
    (folders || []).forEach((f) => {
      const key = folderKeyOf(f?.path);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ key, label: f.label || key, path: f.path });
    });
    return out;
  }, [folders]);

  // 行き先。moveTargets があればそれ、無ければ棚そのもの。
  const destinations = useMemo(() => {
    const src = (moveTargets && moveTargets.length) ? moveTargets : shelves;
    const seen = new Set();
    const out = [];
    (src || []).forEach((t) => {
      const key = folderKeyOf(t?.path);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ key, label: t.label || key, path: t.path });
    });
    return out;
  }, [moveTargets, shelves]);

  const [open, setOpen] = useState({});      // key -> true(開いている)
  const [shelf, setShelf] = useState({});    // key -> { loading, error, found, missing, files, allCount, capped }
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('new');
  const [busy, setBusy] = useState('');      // 操作中の説明文。空なら暇
  const [note, setNote] = useState(null);    // { ok:true/false, text }
  const [expand, setExpand] = useState('');  // 「⚙ そのほか」を開いている行の fileId
  const [dest, setDest] = useState({});      // fileId -> 行き先の key
  const [player, setPlayer] = useState(null);// この画面の中で出す素の動画 { id, name, err }

  // 読み直しが行き違うと、古い結果が新しい結果を上書きする。番号で新しい方だけ採る。
  const seq = useRef({});

  const recipeOf = useCallback(
    (fileId) => (recipes || []).find((r) => r && r.fileId === fileId) || null,
    [recipes],
  );

  const loadOne = useCallback(async (key, path) => {
    if (!proxyUrl) {
      setShelf((p) => ({ ...p, [key]: { loading: false, error: 'Drive連携が未設定です', files: [], found: false } }));
      return;
    }
    const my = (seq.current[key] || 0) + 1;
    seq.current[key] = my;
    setShelf((p) => ({ ...p, [key]: { ...(p[key] || {}), loading: true, error: '' } }));
    try {
      const res = await fetch(`${proxyUrl}/drive/list?path=${encodeURIComponent((path || []).join('/'))}`);
      const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (seq.current[key] !== my) return;
      if (!j.ok) {
        setShelf((p) => ({ ...p, [key]: { loading: false, error: j.error || `HTTP ${res.status}`, files: [], found: false } }));
        return;
      }
      const all = j.files || [];
      setShelf((p) => ({
        ...p,
        [key]: {
          loading: false,
          error: '',
          found: !!j.found,
          missing: j.missing || '',
          files: all.filter(isVideoFile),
          allCount: all.length,
          // 中継が「途中で切った」と言ってきた時が本命。件数はその裏取り。
          capped: j.truncated === true || all.length >= LIST_CAP,
        },
      }));
    } catch (e) {
      if (seq.current[key] !== my) return;
      setShelf((p) => ({
        ...p,
        [key]: { loading: false, error: (e && e.message) || '通信に失敗しました(中継に届きません)', files: [], found: false },
      }));
    }
  }, [proxyUrl]);

  // 開いた事のある棚だけ読み直す。⚠まだ開いていない棚まで読むと往復が跳ね上がる。
  const reloadLoaded = useCallback(() => {
    shelves.forEach((s) => { if (open[s.key] || shelf[s.key]) loadOne(s.key, s.path); });
  }, [shelves, open, shelf, loadOne]);

  // ⚠ 読みに行くのは setOpen の中に書かない。二重に走って往復が2倍になる。
  const toggleShelf = (s) => {
    const willOpen = !open[s.key];
    setOpen((p) => ({ ...p, [s.key]: willOpen }));
    if (willOpen && !shelf[s.key]) loadOne(s.key, s.path);
  };

  const openAll = () => {
    const next = {};
    shelves.forEach((s) => { next[s.key] = true; if (!shelf[s.key]) loadOne(s.key, s.path); });
    setOpen(next);
  };

  // 棚が1つしか無い時は、開かせる手間をかけない。
  // ⚠⚠ 呼ぶ側が folders={[...]} と**その場で書いた配列**を渡すと、描き直すたびに
  //   中身が同じでも別物と見なされ、ここが何度も走って Drive を叩き続ける。
  //   「もう自動で開いた棚の並び」を覚えておいて、同じ並びなら何もしない。
  const autoOpened = useRef('');
  useEffect(() => {
    const sig = shelves.map((s) => s.key).join('|');
    if (shelves.length !== 1 || autoOpened.current === sig) return;
    autoOpened.current = sig;
    setOpen({ [shelves[0].key]: true });
    loadOne(shelves[0].key, shelves[0].path);
  }, [shelves, loadOne]);

  // Drive を触る(移す/複製/名前/ゴミ箱)。終わったら必ず読み直す。
  const driveAct = async (apiPath, body, doing) => {
    if (busy) return false;
    if (!proxyUrl) { setNote({ ok: false, text: 'Drive連携が未設定です。管理者にご連絡ください。' }); return false; }
    setBusy(doing);
    setNote(null);
    try {
      const res = await fetch(`${proxyUrl}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        // ⧉複製は中継が新しくないと入っていない。何が起きたのか分かる言葉で出す。
        const notReady = res.status === 404 || res.status === 405;
        setNote({
          ok: false,
          text: notReady
            ? `${doing}に失敗しました。この中継はまだ「${apiPath}」に対応していません(管理者が中継を更新すると使えます)。`
            : `${doing}に失敗しました: ${j.error || `HTTP ${res.status}`}`,
        });
        setBusy('');
        return false;
      }
      setBusy('');
      setNote({ ok: true, text: `${doing}が終わりました。` });
      reloadLoaded();
      return true;
    } catch (e) {
      setNote({ ok: false, text: `${doing}に失敗しました(通信): ${(e && e.message) || e}` });
      setBusy('');
      return false;
    }
  };

  const doRename = async (f) => {
    const nn = window.prompt('新しい名前', f.name);
    if (!nn || !nn.trim() || nn === f.name) return;
    await driveAct('/drive/rename', { id: f.id, name: nn.trim() }, '名前の変更');
  };

  const doMove = async (f) => {
    const t = destinations.find((d) => d.key === dest[f.id]);
    if (!t) { setNote({ ok: false, text: '先に「どこへ」を選んでください。' }); return; }
    await driveAct('/drive/move', { id: f.id, toPath: t.path }, `「${t.label}」へ移す`);
  };

  const doCopy = async (f) => {
    const t = destinations.find((d) => d.key === dest[f.id]);
    if (!t) { setNote({ ok: false, text: '先に「どこへ」を選んでください。' }); return; }
    const nn = window.prompt('複製の名前', copyNameOf(f.name));
    if (!nn || !nn.trim()) return;
    await driveAct('/drive/copy', { id: f.id, toPath: t.path, name: nn.trim() }, `「${t.label}」へ複製`);
  };

  const doTrash = async (f) => {
    const rc = recipeOf(f.id);
    const extra = rc ? '\n(この動画に付けた手本レシピも外れます)' : '';
    if (!window.confirm(`「${f.name}」をDriveのゴミ箱へ移しますか？\n30日間はDriveのゴミ箱から戻せます。${extra}`)) return;
    const ok = await driveAct('/drive/trash', { id: f.id }, 'ゴミ箱へ移す');
    if (ok && rc && onDeleteRecipe) {
      try { await onDeleteRecipe(f.id); } catch { /* レシピが消せなくても動画は既にゴミ箱。ここで止めない */ }
    }
  };

  // しぼり込み＋並べ替え。名前だけでなく手本の題名でも当たるようにする。
  const kw = q.trim().toLowerCase();
  const viewOf = useCallback((files) => {
    const hit = (files || []).filter((f) => {
      if (!kw) return true;
      const rc = recipeOf(f.id);
      return `${f.name || ''} ${rc?.title || ''}`.toLowerCase().includes(kw);
    });
    const sorted = [...hit];
    if (sort === 'name') sorted.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ja'));
    else if (sort === 'big') sorted.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
    else sorted.sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
    return sorted;
  }, [kw, sort, recipeOf]);

  // 合計。⚠**読み込んだ棚の分だけ**。開いていない棚は数に入れない(数えたふりをしない)。
  const totals = useMemo(() => {
    let loadedShelves = 0; let count = 0; let bytes = 0; let capped = 0;
    shelves.forEach((s) => {
      const st = shelf[s.key];
      if (!st || st.loading || st.error) return;
      loadedShelves += 1;
      (st.files || []).forEach((f) => { count += 1; bytes += Number(f.size) || 0; });
      if (st.capped) capped += 1;
    });
    return { loadedShelves, count, bytes, capped };
  }, [shelves, shelf]);

  const allLoaded = totals.loadedShelves >= shelves.length && shelves.length > 0;

  // 本体。⚠embedded では **親の高さいっぱい**(h-full)に収まり、外へはみ出さない。
  //   幕の時だけ画面に対する大きさ(max-w-5xl / h-[94vh])を持つ。
  //   どちらも `flex flex-col overflow-hidden` = 縦スクロールは下の一覧ただ1つ。
  const shell = (
    <div
      className={embedded
        ? 'h-full w-full flex flex-col overflow-hidden bg-white rounded-xl border border-slate-200 shadow-sm'
        : 'bg-white rounded-2xl shadow-2xl w-full max-w-5xl h-[94vh] flex flex-col overflow-hidden'}
      onClick={embedded ? undefined : ((e) => e.stopPropagation())}
    >

        <div className="px-3 py-3 bg-slate-800 text-white flex items-center justify-between gap-2 shrink-0">
          <h2 className="font-bold text-base flex items-center gap-2 min-w-0">
            <span className="text-xl">🎬</span>
            <span className="truncate">動画の棚</span>
          </h2>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={openAll}
              className={`${BTN} bg-white/15 hover:bg-white/25`}
              title="ぜんぶの棚を開いて読み込みます(棚の数だけDriveへ問い合わせます)"
            >📂 ぜんぶ開く</button>
            <button
              type="button"
              onClick={reloadLoaded}
              className={`${BTN} bg-white/15 hover:bg-white/25`}
              title="Driveの最新の中身を読み直します(中継は1分ほど前の一覧を覚えています)"
            ><RefreshCw className="w-4 h-4" /> 更新</button>
            {/* ⚠タブとして出ている時(embedded)は ✕ を出さない。タブに「閉じる」は無い */}
            {!embedded && onClose && (
              <button type="button" onClick={onClose} className="min-h-[44px] min-w-[44px] rounded-lg hover:bg-white/20 flex items-center justify-center" title="閉じる">
                <X className="w-6 h-6" />
              </button>
            )}
          </div>
        </div>

        <div className="px-3 py-2 bg-slate-100 border-b border-slate-200 shrink-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="名前でしぼる"
                className="w-full min-h-[44px] pl-9 pr-3 rounded-lg border border-slate-300 text-sm bg-white"
              />
            </div>
            <div className="flex items-center gap-1">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSort(s.key)}
                  className={`min-h-[44px] px-3 rounded-lg text-sm font-bold border ${sort === s.key ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-300'}`}
                >{s.label}</button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
            <span className="font-bold text-sm text-slate-800">
              合計 {totals.count}本・{fmtSize(totals.bytes)}
            </span>
            {shelves.length > 0 && (
              <span className={allLoaded ? 'text-slate-500' : 'text-amber-700 font-bold'}>
                {allLoaded
                  ? `(${shelves.length}つの棚ぜんぶを読み込んだ数です)`
                  : `(いま読み込めている ${totals.loadedShelves}／${shelves.length} の棚の分だけの数です。「📂 ぜんぶ開く」で全部数えます)`}
              </span>
            )}
            {kw && <span className="text-sky-700 font-bold">「{q.trim()}」でしぼり込み中</span>}
          </div>

          {totals.capped > 0 && (
            <div className="bg-rose-50 border border-rose-300 rounded-lg px-3 py-2 text-xs text-rose-700 font-bold">
              ⚠ {totals.capped}つの棚で、Driveの中身を{LIST_CAP}件で打ち切って受け取っています。
              <span className="font-normal"> つまり <b>Driveには在るのにここに出ていない動画があります</b>。フォルダを分けるか、管理者に中継の件数の上限を上げてもらってください。</span>
            </div>
          )}

          {note && (
            <div className={`rounded-lg px-3 py-2 text-sm font-bold flex items-start justify-between gap-2 ${note.ok ? 'bg-emerald-50 border border-emerald-300 text-emerald-700' : 'bg-rose-50 border border-rose-300 text-rose-700'}`}>
              <span className="min-w-0">{note.ok ? '✅ ' : '⚠ '}{note.text}</span>
              <button type="button" onClick={() => setNote(null)} className="shrink-0 min-h-[44px] min-w-[44px] px-2 rounded hover:bg-black/5 text-xs">閉じる</button>
            </div>
          )}

          {busy && (
            <div className="bg-sky-50 border border-sky-300 rounded-lg px-3 py-2 text-sm text-sky-700 font-bold flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> {busy}…（終わるまで他の操作はできません）
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 space-y-3 bg-slate-50">
          {!proxyUrl && (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800 space-y-1">
              <div className="font-bold">Drive連携が未設定です</div>
              <div>管理者が中継(Worker)のURLを設定して配り直すと、ここにDriveの動画が並びます。</div>
            </div>
          )}

          {proxyUrl && shelves.length === 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm text-slate-500">
              見に行くフォルダが1つも渡されていません（呼び出し側の設定待ちです）。
            </div>
          )}

          {proxyUrl && shelves.map((s) => {
            const st = shelf[s.key];
            const isOpen = !!open[s.key];
            const view = st && !st.loading && !st.error ? viewOf(st.files) : [];
            const allVideos = st?.files?.length || 0;
            return (
              <div key={s.key} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleShelf(s)}
                  className="w-full min-h-[52px] px-3 py-2 bg-slate-100 hover:bg-slate-200 flex items-center justify-between gap-2 text-left"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-base shrink-0">{isOpen ? '📂' : '📁'}</span>
                    <span className="text-sm font-bold text-slate-800 truncate">{s.label}</span>
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    {st && !st.loading && !st.error && (
                      <span className="text-xs text-slate-500 font-bold">
                        動画 {allVideos}本{kw ? `（うち ${view.length}本を表示）` : ''}
                      </span>
                    )}
                    {st?.loading && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                    <span className="text-xs text-slate-500 font-bold">{isOpen ? '▲ 閉じる' : '▼ 開く'}</span>
                  </span>
                </button>

                {isOpen && (
                  <div className="p-2">
                    {/* ⚠truncate 付き = 幅が足りなくても折り返さず「…」で切る。12px にしても行は増えない */}
                    <div className="text-xs text-slate-400 font-mono truncate px-1 pb-1" title={`Driveのフォルダ: 資料ルート/${s.key}`}>{s.key}</div>

                    {(!st || st.loading) && (
                      <div className="text-sm text-slate-400 flex items-center gap-2 p-3"><Loader2 className="w-4 h-4 animate-spin" /> 読み込み中…</div>
                    )}

                    {st && !st.loading && st.error && (
                      <div className="bg-rose-50 border border-rose-300 rounded-lg p-3 text-sm text-rose-700 space-y-2">
                        <div className="font-bold">⚠ 読み込みに失敗しました</div>
                        <div className="text-xs break-all">{st.error}</div>
                        <button type="button" onClick={() => loadOne(s.key, s.path)} className={`${BTN} bg-rose-600 text-white hover:bg-rose-500 w-fit`}>↻ もう一度読む</button>
                      </div>
                    )}

                    {st && !st.loading && !st.error && !st.found && (
                      <div className="text-sm text-slate-500 p-3">
                        Driveにこのフォルダがまだありません（「<b>{st.missing}</b>」が見つかりません）。
                        Driveの資料フォルダに「<b>{s.key}</b>」を作って動画を入れると、ここに出ます。
                      </div>
                    )}

                    {st && !st.loading && !st.error && st.found && allVideos === 0 && (
                      <div className="text-sm text-slate-500 p-3">
                        フォルダはありますが、動画はまだ入っていません
                        {st.allCount > 0 ? `（動画以外のファイルが ${st.allCount}件あります）` : ''}。
                      </div>
                    )}

                    {st && !st.loading && !st.error && allVideos > 0 && view.length === 0 && (
                      <div className="text-sm text-slate-500 p-3">「{q.trim()}」に当てはまる動画はありません（この棚には {allVideos}本あります）。</div>
                    )}

                    {st?.capped && (
                      <div className="mx-1 mb-2 bg-rose-50 border border-rose-300 rounded-lg px-2 py-1.5 text-xs text-rose-700 font-bold">
                        ⚠ この棚は{LIST_CAP}件で打ち切られています。ここに出ていない物がDriveに在ります。
                      </div>
                    )}

                    {view.map((f) => {
                      const rc = recipeOf(f.id);
                      const isX = expand === f.id;
                      return (
                        <div key={f.id} className="border-b border-slate-100 last:border-b-0 py-1.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xl shrink-0">🎬</span>
                            <div className="flex-1 min-w-[140px]">
                              <div className="text-sm font-bold text-slate-800 break-all">{rc?.title || f.name}</div>
                              {/* ⚠ここは「読んで判断する数字」(容量・更新日時)。11px では現場のタブレットで読めない → 12px */}
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                                {rc?.title && <span className="break-all">{f.name}</span>}
                                <span>{fmtSize(f.size)}</span>
                                {fmtWhen(f.modifiedTime) && <span>{fmtWhen(f.modifiedTime)}</span>}
                                {rc && <span className="bg-amber-100 text-amber-700 border border-amber-300 rounded px-1 font-bold" title="止めて見せる所・倍速つきの手本あり">🎬手本あり</span>}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => (onPlay ? onPlay(f) : setPlayer({ id: f.id, name: f.name, err: false }))}
                                className={`${BTN} bg-sky-600 text-white hover:bg-sky-500`}
                                title="この動画を見る"
                              >▶ 見る</button>
                              {onOpenEditor && (
                                <button
                                  type="button"
                                  onClick={() => onOpenEditor(f)}
                                  className={`${BTN} bg-amber-500 text-white hover:bg-amber-400`}
                                  title="編集室でひらいて、切る・止める所を作る・字幕を入れる"
                                >🎬 編集室でひらく</button>
                              )}
                              {canEdit && (
                                <button
                                  type="button"
                                  onClick={() => setExpand(isX ? '' : f.id)}
                                  className={`${BTN} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}
                                  title="名前を変える・移す・複製する・ゴミ箱へ"
                                >{isX ? '▲ とじる' : '⚙ そのほか'}</button>
                              )}
                            </div>
                          </div>

                          {canEdit && isX && (
                            <div className="mt-2 mb-1 mx-1 p-2 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <button type="button" disabled={!!busy} onClick={() => doRename(f)} className={`${BTN} bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-40`}>📝 名前を変える</button>
                                <button type="button" disabled={!!busy} onClick={() => doTrash(f)} className={`${BTN} bg-white border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-40`} title="Driveのゴミ箱へ移します。30日間は戻せます">🗑 ゴミ箱へ(復元可)</button>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-bold text-slate-500">どこへ:</span>
                                <select
                                  value={dest[f.id] || ''}
                                  onChange={(e) => setDest((p) => ({ ...p, [f.id]: e.target.value }))}
                                  className="min-h-[44px] px-2 rounded-lg border border-slate-300 text-sm bg-white max-w-[220px]"
                                >
                                  <option value="">— 行き先をえらぶ —</option>
                                  {destinations.filter((d) => d.key !== s.key).map((d) => (
                                    <option key={d.key} value={d.key}>{d.label}</option>
                                  ))}
                                </select>
                                <button type="button" disabled={!!busy || !dest[f.id]} onClick={() => doMove(f)} className={`${BTN} bg-sky-100 border border-sky-300 text-sky-700 hover:bg-sky-200 disabled:opacity-40`}>📦 移す</button>
                                <button type="button" disabled={!!busy || !dest[f.id]} onClick={() => doCopy(f)} className={`${BTN} bg-violet-100 border border-violet-300 text-violet-700 hover:bg-violet-200 disabled:opacity-40`} title="元はそのまま残して、選んだ場所へもう1本作ります">⧉ 複製</button>
                              </div>
                              {destinations.filter((d) => d.key !== s.key).length === 0 && (
                                <div className="text-xs text-slate-500">移す先・複製先の棚がまだありません（棚が1つだけの時は行き先を選べません）。</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* 📐PU5 2026-09-07: この説明3行は本番で 56px の横帯を専有し、中身は幅の36%しか無かった。
                🚨 1文字も消さずに `？` へ畳む(details)。押すと今までどおり3行が全部出る。
                ⚠ summary は幅いっぱい(w-full)にする。幅を余らせると「無駄な帯」に逆戻りする。
                ⚠ 押す物なので min-h-11(44px)・文字は12px(text-xs)を下回らない。 */}
          <details className="px-1 group" data-pu5="drive-note">
            <summary className="min-h-11 w-full flex items-center justify-between gap-2 cursor-pointer select-none text-xs font-bold text-slate-500">
              <span>？ この棚の使い方（3つ）</span>
              <span className="text-slate-400">
                <span className="group-open:hidden">ひらく</span>
                <span className="hidden group-open:inline">とじる</span>
              </span>
            </summary>
            <div className="text-xs text-slate-500 leading-relaxed pb-1">
              ・Driveのフォルダに動画を置くだけで、ここに出ます。<b>入れたばかりの物が出ない時は「↻ 更新」</b>を押してください（中継が1分ほど前の一覧を覚えています）。<br />
              ・動画の本体はDriveにあります。このアプリの容量は使いません。<br />
              ・「🗑 ゴミ箱へ」はDriveのゴミ箱に移すだけです。<b>30日間は戻せます</b>（完全に消す事はこのアプリからはできません）。
            </div>
          </details>
        </div>
    </div>
  );

  // ▶ 素の動画を出す窓。⚠これは本物の「窓」なので embedded でも幕のままでよい
  //   (見終わったら「閉じる」で必ず元の画面に戻れる)。
  const playerNode = player && (
        <div className="fixed inset-0 z-[660] bg-black/90 flex flex-col" onClick={() => setPlayer(null)}>
          <div className="px-3 py-2 flex items-center justify-between gap-2 text-white shrink-0" onClick={(e) => e.stopPropagation()}>
            <span className="text-sm font-bold truncate min-w-0">{player.name}</span>
            <button type="button" onClick={() => setPlayer(null)} className={`${BTN} bg-white/15 hover:bg-white/25 text-white shrink-0`}>閉じる</button>
          </div>
          <div className="flex-1 min-h-0 p-2" onClick={(e) => e.stopPropagation()}>
            <video
              src={`${proxyUrl}/drive/file?id=${encodeURIComponent(player.id)}`}
              controls
              autoPlay
              playsInline
              preload="metadata"
              onError={() => setPlayer((p) => (p ? { ...p, err: true } : p))}
              className="w-full h-full object-contain bg-black rounded-lg"
            />
          </div>
          {player.err && (
            <div className="mx-2 mb-2 bg-rose-50 border border-rose-300 rounded-lg p-3 text-sm text-rose-700 shrink-0" onClick={(e) => e.stopPropagation()}>
              <div className="font-bold">この端末ではこの動画を再生できませんでした。</div>
              <div className="text-xs mt-1">
                スマホで撮った動画は、この端末が読めない形で入っている事があります（同じ .mov / .mp4 でも中身が違います）。
                「🎬 編集室でひらく」から書き出し直すと、どの端末でも見られる形になります。
              </div>
            </div>
          )}
        </div>
  );

  // ⚠⚠ タブの中身として出す時は **幕を作らない**。
  //   親の入れ物(タブの中身の枠)にそのまま並ぶ。上のタブ列が隠れない＝他のタブへ行ける。
  if (embedded) {
    return (
      <>
        {shell}
        {playerNode}
      </>
    );
  }

  // 幕として出す時(窓で呼ばれた時)。今までどおり。
  return (
    <div className="fixed inset-0 z-[600] bg-black/60 flex items-center justify-center p-2 sm:p-3" onClick={onClose}>
      {shell}
      {playerNode}
    </div>
  );
};

export default VideoLibrary;
