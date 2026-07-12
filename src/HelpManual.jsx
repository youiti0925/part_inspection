// =============================================================================
//  HelpManual.jsx  —  部品検査アプリ「❓使い方」全画面マニュアル
// -----------------------------------------------------------------------------
//  ・誰でもわかるように、全機能の操作手順を画像つきで説明する。
//  ・スクショは管理者が各「写真枠」にアップロード/差し替え/削除できる。
//    画像は Firestore の help_images コレクションに保存され、全端末で共有される。
//  ・このファイルは「汎用コンポーネント + 内容データ(PRODUCT_HELP_SECTIONS)」で構成。
//    コンポーネントは sections プロップだけで動くので、最終検査アプリにも流用可能。
// =============================================================================
import React, { useState, useRef, useMemo } from 'react';
import {
  X, BookOpen, Search, Camera, Upload, Trash2, ChevronRight, Loader2,
  Info, Lightbulb, AlertTriangle, CheckCircle2,
  Rocket, UserCheck, LayoutGrid, PackagePlus, MapIcon, ClipboardCheck,
  Bug, ListChecks, History, BarChart3, FileStack, Ruler, Settings,
  Coffee, HelpCircle, Image as ImageIcon,
} from 'lucide-react';

// -----------------------------------------------------------------------------
//  スクショ枠 (ShotSlot)
//   - 画像があれば表示。なければ「写真枠」プレースホルダ。
//   - canEdit(管理者) のときだけ 追加/差し替え/削除 ボタンを表示。
// -----------------------------------------------------------------------------
function ShotSlot({ slotKey, cap, images, canEdit, onUpload, onDelete }) {
  const img = images?.[slotKey];
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(false);

  const pick = () => fileRef.current?.click();
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true);
    try { await onUpload?.(slotKey, f); } finally { setBusy(false); }
  };

  return (
    <figure className="my-4 not-prose">
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
      {img ? (
        <div className="relative group">
          <img
            src={img}
            alt={cap || '画面写真'}
            onClick={() => setZoom(true)}
            className="w-full max-h-[460px] object-contain rounded-xl border-2 border-slate-200 bg-slate-50 cursor-zoom-in shadow-sm"
          />
          {canEdit && (
            <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={pick} disabled={busy} className="bg-slate-900/80 hover:bg-slate-900 text-white text-xs font-bold px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} 差し替え
              </button>
              <button onClick={() => onDelete?.(slotKey)} disabled={busy} className="bg-rose-600/90 hover:bg-rose-700 text-white text-xs font-bold px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow">
                <Trash2 className="w-3.5 h-3.5" /> 削除
              </button>
            </div>
          )}
        </div>
      ) : (
        <div
          onClick={canEdit ? pick : undefined}
          className={`w-full rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 py-10 text-center ${canEdit ? 'border-blue-300 bg-blue-50/60 hover:bg-blue-50 cursor-pointer' : 'border-slate-200 bg-slate-50'}`}
        >
          {busy ? <Loader2 className="w-8 h-8 text-blue-400 animate-spin" /> : <Camera className="w-8 h-8 text-slate-300" />}
          <div className="text-sm font-bold text-slate-500">{cap || '画面写真'}</div>
          {canEdit
            ? <div className="text-xs text-blue-600 font-bold flex items-center gap-1"><Upload className="w-3.5 h-3.5" /> タップして写真を追加</div>
            : <div className="text-[11px] text-slate-400">写真は準備中です</div>}
        </div>
      )}
      {cap && <figcaption className="text-center text-xs text-slate-500 mt-1.5">{img ? '▲ ' : ''}{cap}</figcaption>}

      {zoom && img && (
        <div className="fixed inset-0 z-[120] bg-black/90 flex items-center justify-center p-4" onClick={() => setZoom(false)}>
          <img src={img} alt={cap || ''} className="max-w-full max-h-full object-contain" />
          <button className="absolute top-4 right-4 bg-white/15 hover:bg-white/30 text-white rounded-full p-2"><X className="w-6 h-6" /></button>
        </div>
      )}
    </figure>
  );
}

// -----------------------------------------------------------------------------
//  各ブロックの描画
// -----------------------------------------------------------------------------
const CALLOUT = {
  tip:  { cls: 'bg-emerald-50 border-emerald-300 text-emerald-900', Icon: Lightbulb,      label: 'ヒント' },
  warn: { cls: 'bg-rose-50 border-rose-300 text-rose-900',         Icon: AlertTriangle,  label: '注意' },
  note: { cls: 'bg-blue-50 border-blue-300 text-blue-900',         Icon: Info,           label: 'メモ' },
  good: { cls: 'bg-amber-50 border-amber-300 text-amber-900',      Icon: CheckCircle2,   label: 'ポイント' },
};

function Block({ block, slotProps }) {
  switch (block.t) {
    case 'h':
      return <h4 className="text-base font-black text-slate-800 mt-5 mb-1.5 flex items-center gap-2"><span className="w-1.5 h-4 bg-blue-500 rounded-full inline-block" />{block.c}</h4>;
    case 'p':
      return <p className="text-[15px] leading-relaxed text-slate-700 my-2">{block.c}</p>;
    case 'ul':
      return (
        <ul className="my-2 space-y-1.5">
          {block.items.map((it, i) => (
            <li key={i} className="flex gap-2 text-[15px] leading-relaxed text-slate-700">
              <ChevronRight className="w-4 h-4 mt-1 text-blue-400 shrink-0" /><span>{it}</span>
            </li>
          ))}
        </ul>
      );
    case 'steps':
      return (
        <ol className="my-3 space-y-2">
          {block.items.map((it, i) => (
            <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-slate-700">
              <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-sm font-black flex items-center justify-center">{i + 1}</span>
              <span className="pt-0.5">{it}</span>
            </li>
          ))}
        </ol>
      );
    case 'tip': case 'warn': case 'note': case 'good': {
      const { cls, Icon, label } = CALLOUT[block.t];
      return (
        <div className={`my-3 border-l-4 rounded-r-lg px-3.5 py-2.5 ${cls}`}>
          <div className="flex items-center gap-1.5 font-black text-sm mb-0.5"><Icon className="w-4 h-4" /> {block.label || label}</div>
          <div className="text-[14px] leading-relaxed">{block.c}</div>
        </div>
      );
    }
    case 'table':
      return (
        <div className="my-3 overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>{block.head.map((h, i) => <th key={i} className="border border-slate-300 bg-slate-100 px-2.5 py-1.5 text-left font-black text-slate-700">{h}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci} className="border border-slate-200 px-2.5 py-1.5 text-slate-700 align-top">{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'shot':
      return <ShotSlot slotKey={block.key} cap={block.cap} {...slotProps} />;
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
//  本体: HelpManualModal
// -----------------------------------------------------------------------------
export function HelpManualModal({ appLabel = 'アプリ', sections, images = {}, canEdit = false, onUpload, onDelete, onClose }) {
  const [activeId, setActiveId] = useState(sections[0]?.id);
  const [q, setQ] = useState('');
  const bodyRef = useRef(null);
  const slotProps = { images, canEdit, onUpload, onDelete };

  // 検索: タイトル + 本文テキストにヒットする章だけ目次に残す
  const filtered = useMemo(() => {
    const kw = q.trim();
    if (!kw) return sections;
    const hit = (s) => {
      if (s.title.includes(kw) || (s.summary || '').includes(kw)) return true;
      return (s.blocks || []).some(b => {
        if (b.c && String(b.c).includes(kw)) return true;
        if (b.items) return b.items.some(it => String(it).includes(kw));
        return false;
      });
    };
    return sections.filter(hit);
  }, [q, sections]);

  const active = sections.find(s => s.id === activeId) || sections[0];

  const go = (id) => {
    setActiveId(id);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  return (
    <div className="fixed inset-0 z-[110] bg-slate-900/70 flex items-stretch justify-center md:p-4">
      <div className="bg-white w-full md:max-w-6xl md:rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* ヘッダー */}
        <div className="shrink-0 bg-gradient-to-r from-blue-700 to-indigo-700 text-white px-5 py-3 flex items-center gap-3">
          <BookOpen className="w-6 h-6" />
          <div className="flex-1 min-w-0">
            <div className="font-black text-lg leading-tight">{appLabel} 使い方ガイド</div>
            <div className="text-[11px] text-blue-100">画面の写真つきで操作を説明します。わからない言葉は上の検索からも探せます。</div>
          </div>
          {canEdit && <span className="hidden sm:inline text-[11px] bg-white/15 px-2 py-1 rounded-full font-bold">管理者: 写真を追加・差し替えできます</span>}
          <button onClick={onClose} className="bg-white/15 hover:bg-white/30 rounded-full p-2"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* 左: 目次 */}
          <aside className="hidden md:flex w-64 shrink-0 border-r border-slate-200 bg-slate-50 flex-col">
            <div className="p-2.5 border-b border-slate-200">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="キーワードで探す" className="w-full pl-8 pr-2 py-1.5 text-sm rounded-lg border border-slate-300 outline-none focus:border-blue-500" />
              </div>
            </div>
            <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {filtered.map((s, i) => {
                const Icon = s.icon || HelpCircle;
                const on = s.id === activeId;
                return (
                  <button key={s.id} onClick={() => go(s.id)} className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center gap-2.5 text-sm font-bold transition-colors ${on ? 'bg-blue-600 text-white shadow' : 'text-slate-600 hover:bg-slate-200'}`}>
                    <Icon className={`w-4 h-4 shrink-0 ${on ? 'text-white' : 'text-blue-500'}`} />
                    <span className="leading-tight">{s.title}</span>
                  </button>
                );
              })}
              {filtered.length === 0 && <div className="text-xs text-slate-400 text-center py-6">該当する項目がありません</div>}
            </nav>
            <div className="p-2.5 border-t border-slate-200 text-[10px] text-slate-400 text-center">全 {sections.length} 章</div>
          </aside>

          {/* 右: 本文 */}
          <main ref={bodyRef} className="flex-1 min-w-0 overflow-y-auto">
            {/* モバイル用 章セレクト */}
            <div className="md:hidden sticky top-0 z-10 bg-white border-b border-slate-200 p-2 flex gap-2">
              <select value={activeId} onChange={e => go(e.target.value)} className="flex-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-bold text-slate-700">
                {sections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </div>

            <article className="p-5 md:p-7 max-w-3xl">
              <div className="flex items-center gap-2.5 mb-1">
                {active.icon && React.createElement(active.icon, { className: 'w-7 h-7 text-blue-600' })}
                <h3 className="text-2xl font-black text-slate-900">{active.title}</h3>
              </div>
              {active.summary && <p className="text-slate-500 text-sm mb-4 border-b border-slate-100 pb-3">{active.summary}</p>}

              {(active.blocks || []).map((b, i) => <Block key={i} block={b} slotProps={slotProps} />)}

              {/* 章送り */}
              <div className="mt-8 pt-4 border-t border-slate-100 flex justify-between gap-2">
                {(() => {
                  const idx = sections.findIndex(s => s.id === activeId);
                  const prev = sections[idx - 1], next = sections[idx + 1];
                  return (
                    <>
                      {prev ? <button onClick={() => go(prev.id)} className="text-sm font-bold text-slate-600 hover:text-blue-600 flex items-center gap-1">← {prev.title}</button> : <span />}
                      {next ? <button onClick={() => go(next.id)} className="text-sm font-bold text-blue-600 hover:text-blue-700 flex items-center gap-1 text-right">{next.title} →</button> : <span />}
                    </>
                  );
                })()}
              </div>
            </article>
          </main>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
//  内容データ: 部品検査アプリ
//   t: 'h'(見出し) 'p'(段落) 'ul'(箇条書き) 'steps'(手順) 'table'
//      'tip'(ヒント) 'warn'(注意) 'note'(メモ) 'good'(ポイント) 'shot'(写真枠)
// =============================================================================
export const PRODUCT_HELP_SECTIONS = [
  {
    id: 'intro', title: 'はじめに', icon: Rocket,
    summary: 'このアプリが何をするものか、最初に押さえておくこと。',
    blocks: [
      { t: 'p', c: '「部品検査アプリ」は、部品の検査作業を“見える化”するためのアプリです。誰が・どの部品を・どの工程に・どれくらい時間をかけて検査したかを自動で記録し、ムダや遅れを見つけて改善につなげます。' },
      { t: 'h', c: 'このアプリでできること' },
      { t: 'ul', items: [
        '検査する部品（ロット）を登録して、現場のどこにあるかをマップで管理する',
        '検査の開始〜完了の時間を、ボタン操作だけで自動で記録する',
        '不良（NG）や気づきを写真つきで記録し、全員でリアルタイムに共有する',
        'たまったデータから「この工程は時間がかかりすぎ」などを分析し、目標時間を提案する',
      ] },
      { t: 'good', c: 'まずは「使用者の選択」→「検査の進め方」の2つの章を読めば、現場で作業を始められます。管理者の方は後半の設定章もどうぞ。' },
      { t: 'note', c: 'データはクラウド（インターネット上）に保存され、すべての端末（iPad・PC）で自動的に同じ内容に揃います。1台で登録すれば、他の端末にもすぐ反映されます。' },
      { t: 'shot', key: 'intro_1', cap: 'アプリを開いた最初の画面（現場マップ）の全体' },
    ],
  },

  {
    id: 'login', title: '最初にやること（使用者の選択）', icon: UserCheck,
    summary: '作業を始める前に、必ず「自分が誰か」を選びます。',
    blocks: [
      { t: 'p', c: '画面いちばん上（ヘッダー）の左に、使用者を選ぶ場所があります。赤く点滅している「⚠ 使用者選択」を押して、自分の名前を選んでください。' },
      { t: 'steps', items: [
        '画面左上の「⚠ 使用者選択」をタップする。',
        '一覧から自分の名前を選ぶ（名前がない場合は管理者に追加してもらう）。',
        '選ぶと、名前が緑色で表示されます。これで準備完了です。',
      ] },
      { t: 'note', c: '「フリー」は名前を出さずに使うとき、「管理者」は設定変更や分析の管理者メニューを使うときに選びます。普段の検査では自分の名前を選んでください。' },
      { t: 'warn', c: '使用者を選ばないまま検査を始めると、「誰が作業したか」が記録されません。作業の最初に必ず選びましょう。名前の右の「×」で切り替えできます。' },
      { t: 'good', c: '複数人で同じ端末を使うときは、担当が代わるたびに名前を切り替えてください。切り替えてから次の人が作業すると、一台ずつ正しく担当者が記録されます。' },
      { t: 'shot', key: 'login_1', cap: '使用者を選ぶ画面（名前の一覧が開いた状態）' },
    ],
  },

  {
    id: 'layout', title: '画面の全体構成（タブの説明）', icon: LayoutGrid,
    summary: '上のタブとボタンが、それぞれ何の画面に行くのかを一覧します。',
    blocks: [
      { t: 'p', c: '画面上部のタブを押すと、画面が切り替わります。それぞれの役割は次のとおりです。' },
      { t: 'table', head: ['タブ', '役割'], rows: [
        ['現場マップ', '検査エリアを上から見た図。どの部品がどこにあるか、ドラッグで動かして管理する。検査の入口。'],
        ['全体進捗', 'いま全体でどれだけ検査が進んでいるかを一目で確認。'],
        ['検査リスト', '検査対象を一覧で表示。ここからも検査を開始できる。'],
        ['分析', 'たまったデータをグラフや表で分析。工程改善・不具合・作業者評価・改善ヒント。'],
        ['完了履歴', '検査が終わったロットの一覧。作業時間の修正もここで行う。'],
        ['工程テンプレート', '部品ごとの検査工程の“ひな形”を作る（管理者）。'],
        ['測定設定', '測定の条件や組み合わせを設定する（管理者）。'],
        ['マスタ設定', '作業者・エリア・画質など、アプリ全体の設定（管理者）。'],
      ] },
      { t: 'h', c: 'ヘッダー右側のボタン' },
      { t: 'ul', items: [
        '作業標準… 登録済みの作業手順書（PDF）を見る',
        '間接作業… 検査以外の作業（運搬・休憩・打合せなど）の時間を記録する',
        '日次集計… その日の作業時間のまとめを見る',
        'ノート… 自分用のメモを残す',
        'お知らせ… 全員への連絡を見る／投稿する',
        '通知… この端末に不良発生の通知を届ける（ON/OFF切替）',
        '入荷登録… 検査する部品（ロット）を新しく登録する',
      ] },
      { t: 'shot', key: 'layout_1', cap: '画面上部のタブとボタンの並び（ヘッダー全体）' },
    ],
  },

  {
    id: 'arrival', title: '入荷登録（検査対象の登録）', icon: PackagePlus,
    summary: '検査する部品をアプリに登録します。1件ずつでも、ExcelでまとめてでもOK。',
    blocks: [
      { t: 'p', c: '検査を始めるには、まず「何を検査するか」を登録します。画面右上の青い「＋ 入荷登録」ボタンから行います。' },
      { t: 'steps', items: [
        '右上の「＋ 入荷登録」を押す。',
        '品目コード（部品の種類）を選ぶと、その部品用の検査工程が自動でセットされます。',
        '台数（数量）・指図番号・納期などを入力する。',
        '「登録」を押すと、現場マップの「入荷待ち」エリアに部品カードが現れます。',
      ] },
      { t: 'tip', c: 'たくさんの部品をまとめて登録したいときは、Excel取込が便利です。指定の形式で入力したファイルを読み込むと、一度に何件でも登録できます。' },
      { t: 'note', c: '品目コードに対応する検査工程は「工程テンプレート」で事前に作っておきます（管理者の章を参照）。テンプレートがあると、登録するだけで検査項目がそろいます。' },
      { t: 'shot', key: 'arrival_1', cap: '入荷登録の入力画面' },
    ],
  },

  {
    id: 'map', title: '現場マップの使い方', icon: MapIcon,
    summary: '部品カードをドラッグして、検査の進み具合をエリアで管理します。',
    blocks: [
      { t: 'p', c: '現場マップは、検査エリアを上から見た図です。部品はカードで表され、指でドラッグして別のエリアに動かせます。「いま何がどこにあるか」が一目でわかります。' },
      { t: 'h', c: '基本の流れ' },
      { t: 'steps', items: [
        '「入荷待ち」エリアにある部品カードを、検査する場所（エリア）へドラッグして移動する。',
        'カードをタップすると検査画面が開く（次の章へ）。',
        '検査が終わると、自動的に完了の扱いになり、完了履歴に移る。',
      ] },
      { t: 'ul', items: [
        'カードの色や表示は「マスタ設定」で調整できます（納期が近いと赤くなる等）。',
        'エリアの配置・名前は管理者がレイアウト編集で自由に変えられます。',
        '画面の表示モード（ダッシュボード／入荷予定／計画実行／マップのみ）を切り替えると、見せ方を変えられます。',
      ] },
      { t: 'warn', c: 'カードが思った場所に動かないときは、ドラッグの指を離す位置がエリアの枠内になっているか確認してください。エリアの境界の外で離すと元に戻ります。' },
      { t: 'shot', key: 'map_1', cap: '現場マップ全体（部品カードがエリアに並んだ状態）' },
      { t: 'shot', key: 'map_2', cap: '部品カードを拡大したところ（品目コード・台数・納期が見える状態）' },
    ],
  },

  {
    id: 'inspect', title: '検査の進め方（いちばん大事）', icon: ClipboardCheck,
    summary: '検査画面でのボタン操作と時間記録のしかた。ここを覚えれば現場で作業できます。',
    blocks: [
      { t: 'p', c: '部品カードをタップすると「検査実行画面」が開きます。ここで工程ごと・1台ごとに検査を進め、時間が自動で記録されます。' },
      { t: 'h', c: '時間記録の基本（開始→完了）' },
      { t: 'steps', items: [
        '検査する工程の台のボタンを押すと、時間の記録が始まります（計測開始）。',
        '検査が終わったら、もう一度押して「完了」にします。これで1台ぶんの時間が記録されます。',
        '次の台、次の工程も同じようにボタンで進めます。',
      ] },
      { t: 'good', c: 'ボタンの色で状態がわかります。未着手／作業中（計測中）／完了 が色分けされています。いま何をすべきかは「次」のしるしが付いた台が目印です。' },
      { t: 'shot', key: 'inspect_1', cap: '検査実行画面の全体（工程と台のボタンが並んだ状態）' },

      { t: 'h', c: '不良（NG）が出たとき' },
      { t: 'steps', items: [
        '不良が見つかったら、その台を「NG（不良）」にします。',
        '不良の内容（どの工程で・どんな不良か）と、必要なら写真を登録します。',
        '登録すると、不良通知をONにしている端末にお知らせが届き、全員で共有されます。',
      ] },
      { t: 'note', c: '不良の記録は、後で「不具合分析」で集計され、「どの部品・工程で不良が多いか」が見えるようになります。面倒でも正しく残すほど、改善に役立ちます。' },
      { t: 'shot', key: 'inspect_ng', cap: '不良（NG）を登録する画面' },

      { t: 'h', c: '修正（手直し・リワーク）したとき' },
      { t: 'p', c: '一度不良になったものを直して再検査したときは「修正」として記録します。修正は何回でも記録でき、各回の時間も別々に残ります。カード表示では「修正◯回」と各回の時間が確認できます。' },

      { t: 'h', c: '自動分割測定（時間が決まっている工程）' },
      { t: 'p', c: 'あらかじめ標準時間がわかっている工程は「自動分割測定」を使えます。開始すると決めた秒数が経過したときに自動で計測を終了するので、ボタンの押し忘れを防げます。' },
      { t: 'steps', items: [
        '工程の設定で「自動測定」をONにし、1台あたりの秒数を登録しておく。',
        '検査画面で自動測定を開始すると、画面にカウントが出る。',
        '設定した時間が経つと、自動で完了になり次へ進める。',
      ] },
      { t: 'tip', c: '自動測定中は、空いた時間に別の台の作業を並行して進められます。画面が「いま並行できる作業」を案内します。' },

      { t: 'h', c: '該当なし・抜取（検査しない台/項目）' },
      { t: 'ul', items: [
        '「該当なし」… その部品にその工程が無い場合に使います。記録上は“対象外”として残ります。',
        '「抜取」… 全数ではなく一部だけ検査する運用のとき、検査を省いた台に「抜取」ラベルが付きます。',
      ] },
      { t: 'note', c: '抜取・該当なしの基準は管理者が設定します。省いた理由（根拠）も一緒に記録されるので、後から確認できます。' },

      { t: 'h', c: '厳密モード（順番を守らせる）' },
      { t: 'p', c: '「厳密モード」をONにすると、工程を決められた順番どおりにしか進められなくなります。順番が大事な部品で使います。品目コード（部品の種類）ごとにON/OFFでき、作業中でも切り替えられます。' },
      { t: 'warn', c: '厳密モードは“順番ミスを防ぐ”ための機能です。柔軟に進めたい部品ではOFFのままで構いません。データがたまった部品は、管理者に「厳密化推奨」のお知らせが出ます。' },

      { t: 'h', c: '写真の登録（作業標準・不良・荷姿）' },
      { t: 'ul', items: [
        '作業標準… 検査のやり方を示す手本写真／PDF。',
        '不良写真… 不良の状態を撮って記録。',
        '荷姿写真… 梱包・出荷時の状態を記録。',
      ] },
      { t: 'tip', c: '写真は自動で軽く圧縮して保存されます。「基本は低画質で軽く、見づらいときだけ少し画質を上げる」のがおすすめ。画質は設定でも、写真ごとでも調整できます。' },

      { t: 'h', c: '文字が小さくて見えないとき' },
      { t: 'p', c: '検査画面の「A−」「A＋」ボタンで、文字の大きさをその場で変えられます。手元の端末に合わせて読みやすい大きさにしてください。' },
      { t: 'shot', key: 'inspect_font', cap: '文字サイズ変更（A− / A＋）ボタンのある場所' },
    ],
  },

  {
    id: 'defect', title: '不良・気づきの登録と共有', icon: Bug,
    summary: '不良や「気づいたこと」を写真つきで残し、全員でリアルタイム共有します。',
    blocks: [
      { t: 'p', c: '検査中に気づいた不良・違和感は、その場で登録できます。登録内容は全端末で共有され、不良通知をONにしている端末にはお知らせが届きます。' },
      { t: 'ul', items: [
        '不良（NG）… 規格外・キズなど、合否に関わるもの。',
        '気づき… 「ここが作りにくそう」「次回注意」など、合否ではないが共有したいこと。',
      ] },
      { t: 'steps', items: [
        '検査画面から不良／気づきの登録を開く。',
        '工程・内容を選び、必要なら写真を撮って添付する。',
        '登録すると、同じ品目コードを検査する人の画面に「直近の不良・気づき」として表示される。',
      ] },
      { t: 'good', c: '「直近の不良・気づきパネル」は、同じ部品を検査する人に自動で出ます。過去の失敗を次の人がくり返さないための仕組みです。' },
      { t: 'shot', key: 'defect_1', cap: '不良・気づきの登録画面（写真添付つき）' },
    ],
  },

  {
    id: 'lists', title: '検査リスト・全体進捗の見方', icon: ListChecks,
    summary: '一覧と進捗で、全体の状況をすばやく把握します。',
    blocks: [
      { t: 'h', c: '検査リスト' },
      { t: 'p', c: '検査対象を表形式で一覧します。品目コード・台数・状態などで絞り込めます。ここからも部品をタップして検査を開始できます。' },
      { t: 'h', c: '全体進捗' },
      { t: 'p', c: 'いま全体でどれだけ進んでいるか（残り何台か、どの工程で止まっているか）をまとめて確認できます。朝礼や進捗確認に便利です。' },
      { t: 'shot', key: 'lists_1', cap: '検査リストの画面' },
      { t: 'shot', key: 'progress_1', cap: '全体進捗の画面' },
    ],
  },

  {
    id: 'history', title: '完了履歴と時間の修正', icon: History,
    summary: '終わった検査の確認と、記録した時間の手直しができます。',
    blocks: [
      { t: 'p', c: '検査が終わったロットは「完了履歴」に並びます。ここで結果を確認したり、記録した作業時間を後から直したりできます。' },
      { t: 'h', c: '作業時間の修正' },
      { t: 'steps', items: [
        '完了履歴から対象のロットを開く。',
        '「工程 × 台数」の表で、各マスの時間を確認・修正する。',
        '保存すると、分析にも修正後の時間が反映される。',
      ] },
      { t: 'warn', c: '時間の修正は分析結果（目標時間の提案など）に影響します。明らかな打ち間違い・押し忘れを直す目的で使ってください。' },
      { t: 'shot', key: 'history_1', cap: '完了履歴の一覧と、時間修正の表' },
    ],
  },

  {
    id: 'analysis', title: '分析（4つの画面）', icon: BarChart3,
    summary: 'たまったデータから改善のヒントを引き出す画面です。',
    blocks: [
      { t: 'p', c: '「分析」タブには4つの画面があります（作業者評価は管理者のみ）。' },
      { t: 'table', head: ['画面', '何がわかるか'], rows: [
        ['工程改善分析', 'どの工程が時間どおりか／かかりすぎか。実績から最適な目標時間を提案。'],
        ['不具合分析', 'どの部品・工程で不良が多いか。月別の推移もグラフで確認。'],
        ['作業者評価（管理者）', '作業者ごとの実績をエビデンス（根拠データ）で比較。'],
        ['改善ヒント', 'AIがデータを深掘りして、改善の着眼点を提案。'],
      ] },
      { t: 'h', c: '工程改善分析の使い方' },
      { t: 'steps', items: [
        '上で「品目コード」または「外観図」を選び、集計期間を決める。',
        '画面上の「乖離アラート」（目標と実績が大きくズレた工程）を確認。「開く」を押すと、その工程のカードまで自動で移動する。',
        '各工程に「標準バランス型／効率追求型／余裕確保型」の3つの推奨目標が出るので、採用したい値の「この目標を採用する」を押す。',
      ] },
      { t: 'note', c: '推奨は「実際のデータ」に基づきます。データ件数が少ない／バラつきが小さいときは3つの値が近くなり、その理由も画面に表示されます。判断に迷うときはデータがたまるのを待つのも手です。' },
      { t: 'tip', c: '分析結果は Excel に書き出せます。会議資料づくりに使ってください。' },
      { t: 'shot', key: 'analysis_1', cap: '工程改善分析の画面（乖離アラートと推奨目標）' },
      { t: 'shot', key: 'analysis_2', cap: '不具合分析の画面（グラフ）' },
    ],
  },

  {
    id: 'template', title: '工程テンプレートの作り方（管理者）', icon: FileStack,
    summary: '部品ごとの検査工程の“ひな形”。これが入荷登録の土台になります。',
    blocks: [
      { t: 'p', c: '品目コード（部品の種類）ごとに、検査する工程の並びを「テンプレート」として作っておきます。入荷登録で品目コードを選ぶと、この工程が自動でセットされます。' },
      { t: 'steps', items: [
        '「工程テンプレート」タブを開く。',
        '品目コードを選び、工程（項目）を上から順に追加する。',
        '各工程に、目標時間・自動測定の要否・並行できるか（並行可/機械占有）などを設定する。',
        '保存すると、その品目コードの入荷登録で使われるようになる。',
      ] },
      { t: 'good', c: '工程の順番がそのまま検査の順番になります。「並行可／機械占有」を正しく設定しておくと、検査画面が“いま並行できる作業”を正しく案内できます。' },
      { t: 'warn', c: 'すでに検査中・完了したロットの工程は、テンプレートを後から変えても自動では変わりません。テンプレートは新しく登録するロットに適用されます。' },
      { t: 'shot', key: 'template_1', cap: '工程テンプレートの編集画面' },
    ],
  },

  {
    id: 'measure', title: '測定設定（管理者）', icon: Ruler,
    summary: '測定の条件や、よく使う組み合わせ（プリセット）を設定します。',
    blocks: [
      { t: 'p', c: '測定の条件や、繰り返し使う設定の組み合わせ（プリセット）を登録しておく画面です。現場で毎回同じ設定を選ぶ手間を減らせます。' },
      { t: 'shot', key: 'measure_1', cap: '測定設定の画面' },
    ],
  },

  {
    id: 'master', title: 'マスタ設定・画質設定（管理者）', icon: Settings,
    summary: '作業者・エリア・カード表示・画像の画質など、全体の設定。',
    blocks: [
      { t: 'h', c: '主な設定項目' },
      { t: 'ul', items: [
        '作業者… 使用者選択に出る名前を追加・編集する。',
        'エリア（マップ）… 現場マップのエリア配置・名前・色を編集する。',
        'カード表示… 部品カードの見た目（納期が近いと赤くする等）を調整する。',
        '厳密モードのしきい値… 何ロットたまったら「厳密化推奨」を出すかを決める。',
        '画像の容量・画質… 写真の種類ごとに、保存サイズと画質を決める。',
      ] },
      { t: 'h', c: '画像の画質について' },
      { t: 'p', c: '写真は「作業標準・不良写真・荷姿写真・機番のAI認識」など種類ごとに、最大サイズと画質を別々に決められます。基本は軽め（低画質）にしておき、見づらいものだけ画質を上げるのがおすすめです。' },
      { t: 'tip', c: '画質を上げると見やすくなりますが、保存容量と通信量が増えます。まずは低めで運用し、必要な写真だけ上げると、全体が軽く保てます。' },
      { t: 'shot', key: 'master_1', cap: 'マスタ設定の画面（画像の容量・画質の設定）' },
    ],
  },

  {
    id: 'tools', title: '便利機能（間接作業・日次集計・ノート・お知らせ）', icon: Coffee,
    summary: '検査以外の作業時間の記録や、連絡・メモの機能です。',
    blocks: [
      { t: 'h', c: '間接作業' },
      { t: 'p', c: '検査以外の作業（運搬・段取り・打合せ・休憩など）の時間を記録します。検査時間と分けて集計できるので、「実際の検査にどれだけ使えたか」が正確にわかります。' },
      { t: 'h', c: '日次集計' },
      { t: 'p', c: 'その日の作業時間のまとめを表示します。誰が・何にどれだけ時間を使ったかを日単位で確認できます。' },
      { t: 'h', c: 'ノート / お知らせ' },
      { t: 'ul', items: [
        'ノート… 自分用のメモ。個人的な覚え書きに。',
        'お知らせ… 全員への連絡。確認が必要なお知らせは、未読の人数がバッジで出ます。',
      ] },
      { t: 'shot', key: 'tools_1', cap: '日次集計または間接作業の画面' },
    ],
  },

  {
    id: 'faq', title: '困ったとき（FAQ）', icon: HelpCircle,
    summary: 'よくあるトラブルと、その対処法。',
    blocks: [
      { t: 'h', c: '画面が真っ白／反応しない' },
      { t: 'ul', items: [
        'まずページを再読み込み（リロード）してください。多くの場合これで直ります。',
        '古いiPad（Safari）で真っ白になる場合は、端末やブラウザが古い可能性があります。管理者に相談してください。',
      ] },
      { t: 'h', c: '時間が記録されていない／担当者が違う' },
      { t: 'ul', items: [
        '作業の前に「使用者の選択」をしたか確認してください。選ばないと担当者が残りません。',
        '複数人で1台を使うときは、担当が代わるたびに名前を切り替えてから作業してください。',
        '押し忘れ・打ち間違いは「完了履歴」から時間を修正できます。',
      ] },
      { t: 'h', c: '登録した内容が他の端末に出ない' },
      { t: 'ul', items: [
        'インターネットに繋がっているか確認してください。',
        '少し待つと自動で同期されます。出ないときはリロードしてください。',
      ] },
      { t: 'h', c: '写真が重い／アップに時間がかかる' },
      { t: 'ul', items: [
        'マスタ設定で画質を少し下げると軽くなります。',
        '電波の弱い場所では時間がかかることがあります。電波の良い場所でお試しください。',
      ] },
      { t: 'note', c: 'それでも解決しないときは、画面の写真を撮って管理者に共有すると、原因の特定が早くなります。' },
    ],
  },
];
