// =============================================================================
//  StarChartView.jsx — ⭐星取表（教育のための表）
// -----------------------------------------------------------------------------
//  行=人 × 列=工程。セルの印は語彙4つだけ:
//    無印 = まだ分かりません（＝やった記録が1件も無い・教育の候補）
//    🎓   = 教育中の実績（その人の記録が全部 task.trainee===true）
//    ○   = 一人でできる（完了/ngの記録が1件でもある。件数で足切りしない）
//    教   = 教えられる（人の指名。実績からの自動の印ではない）
//  期限失効なし・割当ロックなし・順位なし。人事評価には使わない（バナーに明記）。
//
//  ■ 依存（独立部品。src/mapviews/MapViewTable.jsx と同じ流儀）
//    react + lucide-react + Tailwind のみ。App固有のimportはしない。
//    計算は src/domain/starChart.js（土台係と共有する契約どおりに呼ぶ）。
//    文言は src/domain/soloDependency.js の soloDoerSentence / nobodyYetSentence を
//    そのまま使う（言い換えを増やさない）。
//
//  ■ props（購読・保存は親App.jsxがやる。ここは表示と組み立てだけ）
//    <StarChartView lots workers templates settings skillMarks canEdit currentUserName onSaveMark />
//    - skillMarks: 教えられるの印のドキュメント配列（購読は親）
//    - onSaveMark(doc): 追記。doc は buildTeachMarkDoc で組む
//      （nowMs/rand は画面側で Date.now()/Math.random() を渡す。domainは純関数のまま）
//    - canEdit: 管理者のみ true。教えられるの指名/取消は canEdit の時だけ
//
//  ■ teachingQueue.buildTeachingCards について（正直な省略）
//    「1時間教えると◯時間ぶん止まらなくなります」の効果の数字は
//    abilityResultByLot（whoCanDoの結果）と openRows（残り時間の見積り行）が要る。
//    どちらもこの部品は受け取っておらず、ここで作り直すと二重実装になるので出さない。
//    代わりに teachCostDetailOf（lots だけで素直に呼べる）で
//    「教える時間の見込み」だけを、実績がある時に限って出す。
//
//  ■ hooks安全（hooks-after-guard-crash-2026-08-27 の教訓）
//    hooksは全部コンポーネント先頭。ガードやearly returnより後ろにhooksを置かない。
//
//  ■ モーダル安全（backdrop-decline-burned-in-2026-08-21 の教訓）
//    背景タップは「閉じる（何も保存しない）」だけ。確定は明示のボタンのみ。
//    窓には max-h を付けて、下のボタンが画面外に出ないようにする。
// =============================================================================

import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Star, Users, Search, AlertTriangle, GraduationCap, X, ChevronRight,
} from 'lucide-react';
import { buildStarChart, buildTeachMarkDoc } from './domain/starChart.js';
import { soloDoerSentence, nobodyYetSentence } from './domain/soloDependency.js';
import { teachCostDetailOf } from './domain/teachingQueue.js';
import { Bar, StackBar, Dots, Signal } from './opsim/vizKit.jsx';

// -----------------------------------------------------------------------------
// 純粋ヘルパ（module scope）
// -----------------------------------------------------------------------------
const num = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('ja-JP') : '—');

// ms → "M/D"（年が今年と違う時だけ "YYYY/M/D"。nowMs基準）
const fmtMD = (ms, nowMs) => {
  if (typeof ms !== 'number' || !isFinite(ms)) return null;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const now = new Date(nowMs);
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`;
};

// 鮮度。⚠ nowMs は呼び出し側が1回だけ取った値（セル毎に new Date() しない）
const monthsAgoText = (lastMs, nowMs) => {
  if (typeof lastMs !== 'number' || !isFinite(lastMs)) return '';
  const diff = nowMs - lastMs;
  if (diff < 0) return '記録の日付が今より後';
  const m = Math.floor(diff / (30.44 * 24 * 3600 * 1000));
  return m <= 0 ? '1か月未満' : `${m}か月前`;
};

const STATE_LABEL = {
  teach: '教えられる',
  can: '一人でできる',
  trainee: '🎓教育中の実績',
};

// セルの title（根拠）。「実績n件・最終: M/D(◯か月前)・記録にIDあり|名前の記録のみ・代表ロット: …」
const cellTitleOf = (cell, nowMs) => {
  if (!cell) return '';
  const parts = [];
  if ((cell.n || 0) > 0) {
    parts.push(`実績${num(cell.n)}件`);
    const md = fmtMD(cell.lastMs, nowMs);
    if (md) parts.push(`最終: ${md}(${monthsAgoText(cell.lastMs, nowMs)})`);
    else parts.push('日付が読めない記録');
    parts.push(cell.evidence === 'id' ? '記録にIDあり' : '名前の記録のみ');
    if (Array.isArray(cell.lotIds) && cell.lotIds.length > 0) {
      parts.push(`代表ロット: ${cell.lotIds.join('・')}`);
    }
  } else {
    parts.push('実績の記録なし（まだ分からない）');
  }
  if (cell.teach) {
    const md = fmtMD(cell.teach.atMs, nowMs);
    parts.push(`教えられるの指名: ${cell.teach.by || '(指名者名なし)'}${md ? `(${md})` : ''}`);
  }
  return parts.join('・');
};

/**
 * セルの印の見た目。教=青 / ○=緑 / 🎓=琥珀 / 無印=空。
 * 🚨 2026-09-15 清水さん「文字ばっかり」。文字を全部消した写真で この表は **完全に空の格子** だった
 *   (印が ○ 教 🎓 の字だけなので、字を消すと色が1つも残らない)。
 *   → 印を **色の付いた四角** にし、マスにも薄い色を敷く。字を消しても
 *     「どこが埋まっていて どこが空か」＝ 教育がどこに要るか が一目で読める。
 * 🚨 無印は「まだ分かりません」の意味。**やれない** という印ではないので 赤や × にしない(白のまま)。
 * 🚨 ここで数を作らない。cell.state をそのまま色に直すだけ。
 */
const MARK = Object.freeze({
  // rank = 点の数(語彙の段。順位ではない)。tone = vizKit の色の名前。
  teach: { box: 'border-blue-700 bg-blue-600 text-white', cell: 'bg-blue-50', glyph: '教', rank: 3, tone: 'plain' },
  can: { box: 'border-emerald-600 bg-emerald-500 text-white', cell: 'bg-emerald-50', glyph: '○', rank: 2, tone: 'ahead' },
  trainee: { box: 'border-amber-500 bg-amber-300 text-amber-900', cell: 'bg-amber-50', glyph: '🎓', rank: 1, tone: 'idle' },
});
/** マスの薄い色(印が無い＝色を付けない)。 */
const cellTone = (cell) => ((cell && MARK[cell.state]) ? MARK[cell.state].cell : '');
const CellMark = ({ cell }) => {
  const m = (cell && MARK[cell.state]) ? MARK[cell.state] : null;
  if (!m) return null;
  return (
    <span className="inline-flex items-center justify-center gap-1">
      {/* 🚨 色だけで見分けさせない(workerColors.js の決まり・白黒で刷っても読める)。
          印の段を **点の数** で出す: 🎓教育中=1 / ○一人でできる=2 / 教=教えられる=3。
          🚨 字も消さない(2026-08-30)。点の横に元の印の字をそのまま残す。
          🚨 無印は「まだ分かりません」。**やれない** の印ではないので
             赤にも × にもしない。マスは白のまま＝空いている所が一目で分かる、が この表の答え。 */}
      <Dots count={m.rank} cap={3} tone={m.tone} size="w-1.5 h-1.5" title={STATE_LABEL[cell.state] || ''} />
      <span className={`fi-tap-text inline-flex h-5 w-5 items-center justify-center rounded border-2 font-black leading-none ${m.box}`}>
        {m.glyph}
      </span>
    </span>
  );
};

// 「○以上」= 一人でできる か 教えられる（語彙の並びで ○ 以上の印）
const isCanOrAbove = (cell) => !!cell && (cell.state === 'can' || cell.state === 'teach');

// -----------------------------------------------------------------------------
// 本体
// -----------------------------------------------------------------------------
export default function StarChartView(props) {
  const {
    lots = [],
    workers = [],
    templates = [],
    settings: _settings = null, // ← 契約上受けるが未使用（文字サイズ等は将来ここから）
    skillMarks = [],
    canEdit = false,
    currentUserName = '',
    onSaveMark = null,
  } = props || {};

  // ---- hooks（全部ここ。この下に early return を置かない）----
  // ⚠ 鮮度計算のための「今」。マウント時に1回だけ取る（セル毎に new Date() しない）
  const [nowMs] = useState(() => Date.now());
  const [tplFilter, setTplFilter] = useState('');       // '' = 全部
  const [q, setQ] = useState('');                        // 人名の部分一致
  const [markedOnly, setMarkedOnly] = useState(false);   // 印のある列だけ
  const [selectedKey, setSelectedKey] = useState(null);  // 詳細パネルを開く列
  const [dialog, setDialog] = useState(null);            // {rowName, col, cell, hasTeach}
  const [dialogNote, setDialogNote] = useState('');
  const [dialogError, setDialogError] = useState('');
  const detailRef = useRef(null);

  // 星取表の組み立て（domainの純関数）。転んでも画面全体を巻き込まない。
  const chart = useMemo(() => {
    try {
      return { data: buildStarChart({ lots, workers, templates, markDocs: skillMarks }) };
    } catch (e) {
      return { data: null, error: String((e && e.message) || e) };
    }
  }, [lots, workers, templates, skillMarks]);

  const rows = useMemo(() => chart.data?.rows || [], [chart]);
  const columns = useMemo(() => chart.data?.columns || [], [chart]);
  const ambiguousSet = useMemo(() => new Set(chart.data?.ambiguousNames || []), [chart]);

  // テンプレの選択肢（columns の並び＝templateName順 を保つ）
  const tplOptions = useMemo(() => {
    const seen = new Map();
    columns.forEach((c) => {
      if (!seen.has(c.templateId)) seen.set(c.templateId, c.templateName || '(テンプレ名なし)');
    });
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [columns]);

  // 行の絞り込み（人名の部分一致。並びはdomainの名前昇順のまま＝順位を作らない）
  const visibleRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => (r.name || '').toLowerCase().includes(needle));
  }, [rows, q]);

  // 列の絞り込み（テンプレ選択＋「印のある列だけ」。印は表示中の人で判定）
  const visibleColumns = useMemo(() => {
    let list = columns;
    if (tplFilter) list = list.filter((c) => c.templateId === tplFilter);
    if (markedOnly) {
      list = list.filter((c) => visibleRows.some((r) => r.cells?.get?.(c.processKey)));
    }
    return list;
  }, [columns, tplFilter, markedOnly, visibleRows]);

  // ヘッダ2段用: 隣り合う同じテンプレの列をまとめる（列はtemplateName→stepTitle順で来る）
  const groups = useMemo(() => {
    const out = [];
    visibleColumns.forEach((c) => {
      const last = out[out.length - 1];
      if (last && last.templateId === c.templateId) last.cols.push(c);
      else out.push({ templateId: c.templateId, templateName: c.templateName || '(テンプレ名なし)', cols: [c] });
    });
    return out;
  }, [visibleColumns]);

  // 詳細パネルの対象列
  const selected = useMemo(
    () => columns.find((c) => c.processKey === selectedKey) || null,
    [columns, selectedKey],
  );

  // 詳細: 印のある人（行の並びのまま＝名前昇順。件数で並べ替えない）と、印の無い人（=教育の候補）
  const detail = useMemo(() => {
    if (!selected) return null;
    const key = selected.processKey;
    const holders = [];
    const candidates = [];
    rows.forEach((r) => {
      const cell = r.cells?.get?.(key) || null;
      if (cell) holders.push({ row: r, cell });
      else candidates.push(r);
    });
    return { holders, candidates };
  }, [selected, rows]);

  // 教える時間の見込み（teachingQueue.teachCostDetailOf。lotsだけで素直に呼べる範囲）
  const teachCost = useMemo(
    () => (selected ? teachCostDetailOf(selected.templateId, lots) : null),
    [selected, lots],
  );

  // 列を選んだら詳細パネルへスクロール
  useEffect(() => {
    if (selectedKey && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedKey]);

  // ---- ここから描画用の小物（hooksではない）----
  const toggleSelect = (key) => setSelectedKey((prev) => (prev === key ? null : key));

  // セルを押す（canEditの時だけ）→ 指名/取消の確認ポップ
  const openDialog = (row, col) => {
    if (!canEdit || !onSaveMark) return;
    const cell = row.cells?.get?.(col.processKey) || null;
    const hasTeach = !!(cell && (cell.state === 'teach' || cell.teach));
    setDialog({ rowName: row.name, col, cell, hasTeach });
    setDialogNote('');
    setDialogError('');
  };

  const closeDialog = () => {
    setDialog(null);
    setDialogNote('');
    setDialogError('');
  };

  // 確定は明示ボタンのみ（背景タップでは何も保存しない）
  const saveMark = (kind) => {
    if (!dialog || !onSaveMark) return;
    try {
      const doc = buildTeachMarkDoc({
        kind,
        worker: dialog.rowName,
        processKey: dialog.col.processKey,
        by: (currentUserName || '').trim(),
        nowMs: Date.now(),
        rand: Math.random(),
        note: dialogNote.trim(),
      });
      onSaveMark(doc);
      closeDialog();
    } catch (e) {
      setDialogError(String((e && e.message) || e));
    }
  };

  // 下部の正直な数字（0件の行は出さない）
  const pseudoNames = chart.data?.pseudoNames || [];
  const operationalNames = chart.data?.operationalNames || [];
  const operationalCount = operationalNames.reduce((s, x) => s + (Number(x.count) || 0), 0);
  const ambiguousNames = chart.data?.ambiguousNames || [];
  const unattributedCount = chart.data?.unattributedCount || 0;
  const honestLines = [];
  if (unattributedCount > 0) honestLines.push(`誰がやったか分からない記録 ${num(unattributedCount)}件（この表では数えられていません）`);
  if (pseudoNames.length > 0) honestLines.push(`人でない名前 ${num(pseudoNames.length)}種（疑似名・別掲）: ${pseudoNames.map((p) => `${p.name}(${num(p.count)}件)`).join('・')}`);
  if (operationalCount > 0) honestLines.push(`フリー/管理者の記録 ${num(operationalCount)}件（人に紐づけられません）: ${operationalNames.map((p) => `${p.name}(${num(p.count)}件)`).join('・')}`);
  if (ambiguousNames.length > 0) honestLines.push(`同姓同名 ${num(ambiguousNames.length)}組（寄せていません）: ${ambiguousNames.join('・')}`);

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden h-full">

      {/* ===== 見出し ===== */}
      <div className="shrink-0 bg-gradient-to-r from-sky-600 to-indigo-500 text-white px-5 py-3 flex items-center gap-3">
        <Star className="w-6 h-6" />
        <div className="flex-1 min-w-0">
          <div className="font-black text-lg leading-tight">星取表（教育のための表）</div>
          <div className="fi-tap-text text-sky-100">
            印は4つだけ: 無印=まだ分かりません（やった記録が1件も無い）／🎓教育中／○一人でできる／教=教えられる。
            <b>力量の認定ではありません。</b>
          </div>
        </div>
        {!canEdit && (
          <span className="fi-tap-text font-bold bg-white/15 rounded px-2 py-1 whitespace-nowrap">教えられるの指名は管理者のみ</span>
        )}
      </div>

      {/* ===== 本体（縦スクロール） ===== */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50">
        <div className="p-4 space-y-4">

          {/* 1. 明文バナー（必ず一番上）
              🚨 2026-09-15 実測: この箱は縦135pxを字4行で使い、表(217px)より縦を食っていた。
                 notext の写真では **ただの水色の空箱**。
              🚨 決まり(2026-08-30)は「移す・畳む・強さを変える。消さない」。字は1つも消さず、
                 3つの約束の文(見張り verify-promises.mjs 611-613 が留めている)は畳んでも1行目に残す。
                 言い換えと ○の定義だけを閉じる。既定は閉じた形＝表に90px返す。 */}
          <details className="rounded-xl border-2 border-sky-400 bg-sky-50 px-3 py-2">
            <summary className="flex items-start gap-2 cursor-pointer list-none">
              <AlertTriangle className="w-5 h-5 text-sky-700 shrink-0 mt-0.5" />
              <span className="fi-tap-text font-black text-sky-900 leading-snug">
                この表は教育のためだけに使います。人事評価には使いません。順位は出しません。印が無い人への割当も止めません(ロックしません)。
                <span className="ml-1 font-bold text-sky-700 underline">くわしく ▾</span>
              </span>
            </summary>
            <div className="mt-2 pl-7 text-sky-900 leading-relaxed">
              <div className="fi-tap-text font-black">無印は『まだ分からない』です。できない、という意味ではありません。</div>
              <div className="fi-tap-text text-sky-800 mt-1">
                ○は「完了かNG判定の記録が1件でもある」印です（件数で足切りしません。実績1件=やった記録があります）。
                教は人の指名の記録で、実績からの自動の印ではありません。
              </div>
            </div>
          </details>

          {/* 組み立てに失敗した時（画面全体を巻き込まない） */}
          {chart.error && (
            <div className="rounded-xl border-2 border-rose-400 bg-white p-4 text-rose-700 text-sm font-bold">
              星取表の組み立てに失敗しました: {chart.error}
            </div>
          )}

          {/* 7. 絞り込み（状態はこの部品の中だけ。localStorageには書かない） */}
          {!chart.error && (
            <div className="rounded-xl border border-slate-200 bg-white p-3 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                テンプレ
                <select
                  value={tplFilter}
                  onChange={(e) => setTplFilter(e.target.value)}
                  className="border border-slate-300 rounded px-2 py-1 text-xs max-w-[16rem]"
                >
                  <option value="">全部（{num(tplOptions.length)}件）</option>
                  {tplOptions.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="人名でしぼる（部分一致）"
                  className="border border-slate-300 rounded pl-7 pr-2 py-1 text-xs w-48"
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs font-bold text-slate-700 cursor-pointer select-none"
                title="表示中の人に印（🎓/○/教）が1つもない列を隠します">
                <input type="checkbox" checked={markedOnly} onChange={(e) => setMarkedOnly(e.target.checked)} />
                印のある列だけ
              </label>
              {/* 🚨 2026-09-15: 287列を横に流して1列ずつ読むしか無く、
                  「1人だけしか印の無い工程が何列あるか」が どこにも出ていなかった。
                  表に入る前に 1本の帯で先に答える: 橙=1人だけ / 緑=2人以上 / 灰=まだ誰も。
                  🚨 橙は「空き(スキル待ち)」の色(idleTone.js)。1人だけ＝その人が居ないと止まる
                     ＝スキル待ちなので 決まりに合う。赤(遅れ専用)は使わない。
                  🚨 これは **画面で数えている**。buildStarChart は列ごとの旗しか返さない。
                     既に在る canPlus(下の行の集計)と同じ流儀だが、本筋は
                     domain/starChart.js に列の内訳を足す事。risks 参照。 */}
              <div className="ml-auto min-w-[14rem] max-w-sm">
                <StackBar height="h-2" total={visibleColumns.length}
                  segments={[
                    { key: 'solo', value: visibleColumns.filter((c) => !c.nobodyYet && c.headcount === 1).length, tone: 'idle', title: '1人だけできる（その人が居ないと止まる）' },
                    { key: 'multi', value: visibleColumns.filter((c) => !c.nobodyYet && c.headcount >= 2).length, tone: 'ahead', title: '2人以上できる' },
                  ]} />
                <div className="fi-tap-text text-slate-500 mt-0.5">
                  表示中: {num(visibleRows.length)}人 × {num(visibleColumns.length)}列
                  <span className="ml-2 font-black text-amber-800">1人だけ {num(visibleColumns.filter((c) => !c.nobodyYet && c.headcount === 1).length)}列</span>
                  <span className="ml-2 text-slate-400">まだ誰も {num(visibleColumns.filter((c) => c.nobodyYet).length)}列</span>
                </div>
              </div>
            </div>
          )}

          {/* 2〜3. 星取表本体（overflow-autoの入れ物・1列目sticky） */}
          {!chart.error && (
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="overflow-auto max-h-[65vh]">
                <table className="border-collapse text-xs">
                  <thead>
                    {/* ヘッダ1段目: テンプレ名グループ */}
                    <tr>
                      <th rowSpan={2} className="sticky left-0 top-0 z-30 bg-slate-100 border-b border-r border-slate-300 px-3 py-1.5 text-left font-black text-slate-700 whitespace-nowrap min-w-[10rem]">
                        <Users className="w-4 h-4 inline mr-1" />作業者
                      </th>
                      {groups.map((g) => (
                        <th
                          key={g.templateId + ':' + g.cols[0].processKey}
                          colSpan={g.cols.length}
                          className="sticky top-0 z-20 h-8 bg-slate-100 border-b border-l border-slate-300 px-2 py-0 font-black text-slate-600 fi-tap-text whitespace-nowrap max-w-[14rem] overflow-hidden text-ellipsis"
                          title={g.templateName}
                        >
                          {g.templateName}
                        </th>
                      ))}
                      <th rowSpan={2} className="sticky top-0 z-20 bg-slate-100 border-b border-l border-slate-300 px-2 py-1 font-black text-slate-600 fi-tap-text whitespace-nowrap"
                        title="○(一人でできる)か教(教えられる)の印がある工程の数。表示中の列のうちで数えます">
                        ○以上の<br />工程数
                      </th>
                    </tr>
                    {/* ヘッダ2段目: 工程名 + ○以上の人数（列を押すと下に詳細） */}
                    <tr>
                      {visibleColumns.map((c) => {
                        const isSel = c.processKey === selectedKey;
                        return (
                          <th
                            key={c.processKey}
                            className={`sticky top-8 z-20 border-b border-l border-slate-200 px-1 py-1 font-bold text-slate-700 align-bottom min-w-[64px] cursor-pointer ${isSel ? 'bg-blue-100' : 'bg-slate-50 hover:bg-blue-50'}`}
                            onClick={() => toggleSelect(c.processKey)}
                            title={`${c.stepTitle || '(工程名なし)'}\n押すと下に詳細（実績のある人・教育の候補）を出します`}
                          >
                            <div className="max-w-[7rem] truncate fi-tap-text mx-auto">{c.stepTitle || '(工程名なし)'}</div>
                            {/* 🚨 2026-09-15 実測: この4種の札は notext の写真で
                                「琥珀の小さな箱」と「灰の小さな箱」にしか見えず、しかも大きさ・位置が同じで
                                危ない列とふつうの列の区別が付かなかった(287列で色が残ったのは4個だけ)。
                                形(Signal) + 長さ(Dots) + 位置(縦に揃える) で答え、字の札はそのまま下に残す。
                                🚨 色だけで見分けさせない(workerColors.js の決まり)。Signal は形も変える:
                                   三角=1人だけ / 塗った丸=2人以上 / 点線の輪=まだ分からない。白黒で刷っても読める。
                                🚨 赤(rose)は遅れ専用。ここでは使わない。
                                🚨 数は作らない。c.nobodyYet / c.headcount をそのまま形と点の数に直すだけ。 */}
                            <div className="mt-0.5 flex flex-col items-center gap-0.5 font-normal">
                              {c.nobodyYet ? (
                                <Signal level="unknown" size="w-4 h-4" title={nobodyYetSentence()} />
                              ) : c.headcount === 1 ? (
                                <Signal level="warn" size="w-4 h-4" title={soloDoerSentence(c.soloName)} />
                              ) : c.headcount === 0 ? (
                                <Signal level="unknown" size="w-4 h-4" title="やった記録はあるが、誰がやったか分からない記録だけです（名前なし・疑似名・フリー/管理者）" />
                              ) : (
                                <Signal level="ok" size="w-4 h-4" title="この工程をやった記録のある人数（🎓教育中の実績の人も数えます。教えられるの印だけで記録の無い人は数えません）" />
                              )}
                              <Dots count={c.nobodyYet ? 0 : c.headcount} cap={4} size="w-1.5 h-1.5"
                                tone={c.headcount === 1 ? 'idle' : c.headcount >= 2 ? 'ahead' : 'quiet'}
                                title={c.nobodyYet ? 'まだ誰もやっていない' : `やった記録のある人 ${num(c.headcount)}人`} />
                              {c.nobodyYet ? (
                                <span className="fi-tap-text text-slate-600" title={nobodyYetSentence()}>0人</span>
                              ) : c.headcount === 1 ? (
                                <span className="fi-tap-text font-black text-amber-800" title={soloDoerSentence(c.soloName)}>1人だけ</span>
                              ) : c.headcount === 0 ? (
                                // 記録はあるが、名前なし・疑似名・フリー/管理者だけで人に紐づかない列
                                <span className="fi-tap-text text-slate-600"
                                  title="やった記録はあるが、誰がやったか分からない記録だけです（名前なし・疑似名・フリー/管理者）">分かる人0人</span>
                              ) : (
                                // ⚠「○以上」ではない: この人数は「やった記録のある人」(🎓教育中の実績の人も入る)
                                <span className="fi-tap-text text-slate-500"
                                  title="この工程をやった記録のある人数（🎓教育中の実績の人も数えます。教えられるの印だけで記録の無い人は数えません）">やった事あり {num(c.headcount)}人</span>
                              )}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r) => {
                      const canPlus = visibleColumns.reduce(
                        (s, c) => s + (isCanOrAbove(r.cells?.get?.(c.processKey)) ? 1 : 0), 0,
                      );
                      return (
                        <tr key={r.name} className="border-b border-slate-100 hover:bg-amber-50/30">
                          <td className="sticky left-0 z-10 bg-white border-r border-slate-200 px-3 py-1 font-bold text-slate-800 whitespace-nowrap">
                            {r.isTrainee && (
                              <span className="mr-1" title="🎓教育中の人">🎓</span>
                            )}
                            {r.name}
                            {!r.isRegistered && (
                              <span className="ml-1 fi-tap-text font-normal text-slate-400" title="登録作業者に無い名前です。誰にも寄せていません">登録に無い名前</span>
                            )}
                            {ambiguousSet.has(r.name) && (
                              <span className="ml-1 fi-tap-text font-black text-rose-600" title="同姓同名の登録があります。寄せていません">同姓同名</span>
                            )}
                          </td>
                          {visibleColumns.map((c) => {
                            const cell = r.cells?.get?.(c.processKey) || null;
                            const isSel = c.processKey === selectedKey;
                            const title = cell ? cellTitleOf(cell, nowMs) : (canEdit ? '無印=まだ分からない。押すと「教えられる」を指名できます' : '無印=まだ分からない');
                            return canEdit && onSaveMark ? (
                              <td key={c.processKey} className={`border-l border-slate-100 p-0 text-center ${isSel ? 'bg-blue-50' : cellTone(cell)}`}>
                                <button
                                  type="button"
                                  onClick={() => openDialog(r, c)}
                                  className="w-full min-h-[2rem] px-1 py-0.5 hover:bg-blue-100/60"
                                  title={title}
                                >
                                  <CellMark cell={cell} />
                                </button>
                              </td>
                            ) : (
                              <td key={c.processKey} className={`border-l border-slate-100 px-1 py-0.5 text-center min-h-[2rem] ${isSel ? 'bg-blue-50' : cellTone(cell)}`} title={title}>
                                <CellMark cell={cell} />
                              </td>
                            );
                          })}
                          <td className="border-l border-slate-200 px-2 py-1 text-center bg-slate-50/60 min-w-[5rem]"
                            title="○(一人でできる)か教(教えられる)の工程数（表示中の列のうち）">
                            {/* 🚨 2026-09-15: ここは数字だけで、4人を見比べるのに目で引き算していた。
                                同じ max(表示中の列数)で並べた **長さ** に直す。数字は札として下に残す。
                                🚨 これは順位ではない(明文バナーの約束)。だから色は「ただの量」の青。
                                   赤・橙は使わない。多い方を上に並べ替えもしない(並びは名前昇順のまま)。
                                🚨 数は作らない。canPlus は既にこの行の上で数えている。 */}
                            <Bar value={canPlus} max={visibleColumns.length} tone="plain" height="h-1.5"
                              title={`${num(canPlus)} / ${num(visibleColumns.length)} 工程`} />
                            <div className="fi-tap-text font-black text-slate-700 mt-0.5">{num(canPlus)}</div>
                          </td>
                        </tr>
                      );
                    })}
                    {visibleRows.length === 0 && (
                      <tr>
                        <td colSpan={visibleColumns.length + 2} className="px-3 py-8 text-center text-slate-400">
                          表示する人がいません{q.trim() ? '（人名の絞り込みを消してみてください）' : ''}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {/* 凡例 */}
              <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 fi-tap-text text-slate-600 leading-relaxed">
                <span className="inline-block rounded bg-blue-100 text-blue-700 border border-blue-300 font-black px-1 mr-1">教</span>教えられる（人の指名）
                <span className="text-emerald-600 font-black mx-1">○</span>一人でできる（記録1件以上）
                <span className="mx-1">🎓</span>教育中の実績
                <span className="mx-1">／</span>無印=まだ分かりません（やった記録が1件も無い・教育の候補）。
                セルにマウスを乗せると根拠（件数・最終日・代表ロット）が出ます。
                {canEdit && onSaveMark
                  ? ' セルを押すと「教えられる」の指名/取消ができます。'
                  : ' 教えられるの指名は管理者のみ。'}
              </div>
            </div>
          )}

          {/* 4. 列の詳細パネル */}
          <div ref={detailRef}>
            {selected && detail && (
              <div className="rounded-xl border-2 border-blue-300 bg-white overflow-hidden">
                <div className="px-4 py-2.5 bg-blue-50 border-b border-blue-200 flex items-center gap-2">
                  <ChevronRight className="w-4 h-4 text-blue-600" />
                  <div className="min-w-0">
                    <div className="font-black text-slate-800 text-sm truncate">{selected.stepTitle || '(工程名なし)'}</div>
                    <div className="fi-tap-text text-slate-500 truncate">{selected.templateName || '(テンプレ名なし)'}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(null)}
                    className="ml-auto text-slate-400 hover:text-slate-700 p-1"
                    title="詳細を閉じる"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-4 space-y-3">

                  {/* 単独頼み/0人の文（言い換えはdomainの文だけを使う） */}
                  {selected.nobodyYet && (
                    <div className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">
                      {nobodyYetSentence()}
                    </div>
                  )}
                  {!selected.nobodyYet && selected.headcount === 1 && (
                    <div className="rounded-lg border-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs font-black text-amber-900">
                      {soloDoerSentence(selected.soloName)}
                    </div>
                  )}
                  {!selected.nobodyYet && selected.headcount === 0 && (
                    <div className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">
                      やった記録はあるが、誰がやったか分からない記録だけです（名前なし・疑似名・フリー/管理者。下の「正直な数字」も見てください）
                    </div>
                  )}

                  {/* 実績・印のある人（名前昇順のまま。件数で並べ替えない） */}
                  <div>
                    <div className="text-xs font-black text-slate-700 mb-1">この工程に印のある人</div>
                    {detail.holders.length === 0 ? (
                      <div className="fi-tap-text text-slate-400">印のある人はいません</div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {detail.holders.map(({ row, cell }) => {
                          const md = fmtMD(cell.lastMs, nowMs);
                          return (
                            <span key={row.name} className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-slate-50 px-2 py-1 fi-tap-text">
                              <CellMark cell={cell} />
                              <b className="text-slate-800">{row.isTrainee ? '🎓' : ''}{row.name}</b>
                              <span className="text-slate-500">{STATE_LABEL[cell.state] || ''}</span>
                              {(cell.n || 0) > 0 ? (
                                <span className="text-slate-500">
                                  {num(cell.n)}件{md ? `・最終 ${md}(${monthsAgoText(cell.lastMs, nowMs)})` : ''}
                                </span>
                              ) : (
                                <span className="text-slate-400">実績の記録なし</span>
                              )}
                              {/* ⚠ 記録が0件のセル(教の印だけ)は evidence=null。無い証拠の札を出さない */}
                              {(cell.n || 0) > 0 && (
                                <span className={`fi-tap-text font-black px-1 rounded ${cell.evidence === 'id' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}
                                  title={cell.evidence === 'id' ? 'IDで証明できた記録があります' : '名前だけの記録です（IDでは証明できていません）'}>
                                  {cell.evidence === 'id' ? 'ID証明' : '名前だけ'}
                                </span>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* 教える時間の見込み（実績がある時だけ。効果の倍率はこの画面では出さない） */}
                  {teachCost && teachCost.basis === 'actual' && teachCost.hours > 0 && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 fi-tap-text text-slate-600 leading-relaxed">
                      <GraduationCap className="w-3.5 h-3.5 inline mr-1 text-slate-500" />
                      このテンプレを1人に教える時間の見込み: <b className="text-slate-800">約{teachCost.hours.toFixed(1)}時間</b>
                      （完了ロット{num(teachCost.n)}件の実績の中央値 × 2人ぶん）。
                      ※「1時間教えると◯時間ぶん止まらなくなります」の数字は、残り仕事の見積りを
                      この画面が持っていないため出しません。
                    </div>
                  )}

                  {/* 印の無い人 = 教育の候補 */}
                  <div>
                    <div className="text-xs font-black text-slate-700 mb-1">
                      この列に印の無い人 = 教育の候補
                      <span className="font-normal fi-tap-text text-slate-500 ml-1">（やった記録が1件も無い、という意味です）</span>
                    </div>
                    {detail.candidates.length === 0 ? (
                      <div className="fi-tap-text text-slate-400">全員に何かの印があります</div>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {detail.candidates.map((r) => (
                          <span key={r.name} className="inline-flex items-center gap-1 rounded border border-dashed border-slate-300 bg-white px-2 py-0.5 fi-tap-text text-slate-600">
                            {r.isTrainee ? '🎓' : ''}{r.name}
                            {!r.isRegistered && <span className="text-slate-400">（登録に無い名前）</span>}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 6. 下部の正直な数字（0件の行は出さない） */}
          {!chart.error && honestLines.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
              <div className="text-xs font-black text-amber-900 mb-1 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                この表に入っていない記録（正直な数字）
              </div>
              <ul className="fi-tap-text text-amber-900 leading-relaxed list-disc pl-5 space-y-0.5">
                {honestLines.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* 5. 教えられるの指名/取消の確認ポップ */}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* 背景タップ=閉じるだけ（何も保存しない）。確定は下の明示ボタンのみ */}
          <div className="absolute inset-0 bg-black/40" onClick={closeDialog} />
          <div className="relative bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md max-h-[80vh] overflow-y-auto p-4">
            <div className="flex items-start gap-2">
              <GraduationCap className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="font-black text-slate-800 text-sm">
                  {dialog.hasTeach ? '「教えられる」の印を取り消しますか？' : '「教えられる」に指名しますか？'}
                </div>
                <div className="text-xs text-slate-600 mt-1">
                  <b>{dialog.rowName}</b> さん ×「{dialog.col.stepTitle || '(工程名なし)'}」
                  <span className="text-slate-400">（{dialog.col.templateName || '(テンプレ名なし)'}）</span>
                </div>
              </div>
              <button type="button" onClick={closeDialog} className="text-slate-400 hover:text-slate-700 p-1" title="閉じる（何もしません）">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* いまの根拠を見せる（指名は人の判断。実績からの自動の印ではない） */}
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 fi-tap-text text-slate-600 leading-relaxed">
              {dialog.cell ? cellTitleOf(dialog.cell, nowMs) : '実績の記録なし（まだ分からない）'}
            </div>
            <div className="mt-2 fi-tap-text text-slate-500 leading-relaxed">
              「教えられる」は人の判断の記録です（実績からの自動の印ではありません）。
              {dialog.hasTeach
                ? ' 取り消しても履歴は消えず、印だけが外れます。'
                : ' 取り消しはいつでもできます（履歴は残ります）。'}
            </div>
            {!(currentUserName || '').trim() && (
              <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 fi-tap-text text-amber-800 font-bold">
                指名者の名前が入っていません。保存時に弾かれる場合があります。
              </div>
            )}

            <label className="block mt-3 fi-tap-text font-bold text-slate-600">
              メモ（任意）
              <input
                value={dialogNote}
                onChange={(e) => setDialogNote(e.target.value)}
                placeholder="例) 一緒に3ロットやって、手順を人に説明できた"
                className="mt-1 w-full border border-slate-300 rounded px-2 py-1.5 text-xs font-normal"
              />
            </label>

            {dialogError && (
              <div className="mt-2 rounded border border-rose-300 bg-rose-50 px-2 py-1.5 fi-tap-text text-rose-700 font-bold">
                保存できませんでした: {dialogError}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeDialog}
                className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs font-bold hover:bg-slate-50"
              >
                やめる
              </button>
              {dialog.hasTeach ? (
                <button
                  type="button"
                  onClick={() => saveMark('retract')}
                  className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-black"
                >
                  印を取り消す（履歴は残る）
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => saveMark('teach')}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-black"
                >
                  教えられるに指名する
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
