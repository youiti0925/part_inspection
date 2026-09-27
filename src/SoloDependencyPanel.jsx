// =============================================================================
//  SoloDependencyPanel.jsx — 「実績から見た工程（疑似）」タブ
// -----------------------------------------------------------------------------
//  🚨 これは力量の認定ではない。実際の作業記録から「やった記録が在るか」を数えただけ。
//     スキル設定 (template.requiredSkills / settings.workerSkills) は1件も存在しないので
//     設定からは何も出せない。だから作業記録だけから出している。
//
//  ⚠ 計算は **ボタンを押した時だけ** 走らせる（開いただけで固まらないように）。
//  ⚠ 個人の順位は作らない。「誰が優秀か」の画面にしない（byWorker / ifAbsent は出さない）。
//  ⚠ 数字の出どころ（何ロット・何タスク・どの期間）と
//     「誰がやったか分からない ◯件（◯%）」を **必ず同じ画面に** 出す。
//     これを出さないと、少なく出た数字を「代替が居る」と誤読される。
//
//  計算の中身は src/domain/soloDependency.js（純関数・試験49件）と
//  src/domain/processTimes.js（「いつ」だけ）。ここは表示だけ。
// =============================================================================
import React, { useState, useMemo, useCallback } from 'react';
import { AlertTriangle, Calculator, Loader2, Search, ChevronDown, ChevronRight, Users, HelpCircle } from 'lucide-react';
import {
  computeSoloDependency,
  BUCKET,
  BUCKET_LABEL,
  COUNT_UNIT,
  COUNT_UNIT_LABEL,
} from './domain/soloDependency.js';
import { computeProcessTimes } from './domain/processTimes.js';

const fmtDate = (ms) => {
  if (typeof ms !== 'number' || !isFinite(ms)) return null;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '—');
const num = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('ja-JP') : '—');

// 区分の見た目。並びは依頼どおり「まだ誰もやっていない / 1人だけ / 2人以上」＋「分からない」。
const BUCKET_ORDER = [BUCKET.NOBODY_YET, BUCKET.ONE_PERSON_ONLY, BUCKET.TWO_OR_MORE, BUCKET.UNCLEAR];
const BUCKET_STYLE = {
  [BUCKET.NOBODY_YET]: { chip: 'bg-slate-100 text-slate-600 border-slate-300', bar: 'bg-slate-400', head: 'bg-slate-50 text-slate-700' },
  [BUCKET.ONE_PERSON_ONLY]: { chip: 'bg-amber-100 text-amber-800 border-amber-300', bar: 'bg-amber-500', head: 'bg-amber-50 text-amber-800' },
  [BUCKET.TWO_OR_MORE]: { chip: 'bg-emerald-100 text-emerald-800 border-emerald-300', bar: 'bg-emerald-500', head: 'bg-emerald-50 text-emerald-800' },
  [BUCKET.UNCLEAR]: { chip: 'bg-rose-100 text-rose-800 border-rose-300', bar: 'bg-rose-500', head: 'bg-rose-50 text-rose-800' },
};
const BUCKET_SUB = {
  [BUCKET.NOBODY_YET]: 'やった記録が1件も無い（できないという意味ではない）',
  [BUCKET.ONE_PERSON_ONLY]: 'やった記録が在るのは1人だけ（その人しかできない、ではない）',
  [BUCKET.TWO_OR_MORE]: 'やった記録が在る人が2人以上',
  [BUCKET.UNCLEAR]: '🚨 誰かがやった記録は在るが、名前が残っていない',
};

// 工程1件の「記録」欄。🚨 単位が混ざっている工程は足さずに別々に出す。
const recordText = (p) => {
  // ⚠「記録なし」と書くと、飛ばした(skipped)記録まで無かった事になる。数えたのは「やった記録」だけ。
  if (p.counts.tasksEvaluated === 0) return 'やった記録なし';
  if (p.countUnit === COUNT_UNIT.MIXED) return `🚨 ${num(p.executionTaskCount)}回 と ${num(p.unitTaskCount)}台 が混在`;
  if (p.countUnit === COUNT_UNIT.EXECUTIONS) return `${num(p.counts.tasksEvaluated)}回`;
  if (p.countUnit === COUNT_UNIT.UNITS) return `${num(p.counts.tasksEvaluated)}台`;
  return `${num(p.counts.tasksEvaluated)}件`;
};

function Tile({ label, value, sub, tone = 'slate' }) {
  const tones = {
    slate: 'border-slate-200 bg-white',
    rose: 'border-rose-300 bg-rose-50',
    amber: 'border-amber-300 bg-amber-50',
  };
  return (
    <div className={`rounded-lg border px-3 py-2 ${tones[tone] || tones.slate}`}>
      <div className="fi-tap-text font-bold text-slate-500 leading-tight">{label}</div>
      <div className={`font-black leading-tight ${tone === 'rose' ? 'text-rose-700 text-xl' : 'text-slate-800 text-lg'}`}>{value}</div>
      {sub && <div className="fi-tap-text text-slate-500 leading-tight mt-0.5">{sub}</div>}
    </div>
  );
}

export function SoloDependencyPanel({ lots = [], templates = [], workers = [] }) {
  const [state, setState] = useState(null);   // { result, times, at }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openBucket, setOpenBucket] = useState({}); // key: bucket -> bool
  const [q, setQ] = useState('');
  const [showLimits, setShowLimits] = useState(true);
  const [showHypo, setShowHypo] = useState(false);

  // ⚠ 開いただけで走らせない。押した時だけ。
  const run = useCallback(() => {
    setBusy(true);
    setError('');
    setTimeout(() => {
      try {
        const result = computeSoloDependency({ lots, templates, workers });
        const times = computeProcessTimes(lots);
        setState({ result, times, at: Date.now() });
        setOpenBucket({
          [BUCKET.NOBODY_YET]: true,
          [BUCKET.ONE_PERSON_ONLY]: true,
          [BUCKET.TWO_OR_MORE]: true,
          [BUCKET.UNCLEAR]: true,
        });
      } catch (e) {
        setState(null);
        setError(String((e && e.message) || e));
      } finally {
        setBusy(false);
      }
    }, 0);
  }, [lots, templates, workers]);

  const result = state?.result || null;
  const times = state?.times || null;

  const rows = useMemo(() => {
    if (!result) return [];
    const needle = q.trim().toLowerCase();
    const list = result.processes.filter((p) => {
      if (!needle) return true;
      return `${p.stepTitle || ''} ${p.templateName || ''}`.toLowerCase().includes(needle);
    });
    // ⚠ total は「しぼる前」の件数。しぼった件数だけを出すと、上の集計と食い違う数字が
    //    見出しに並んで「1人だけ 3件」のように読めてしまう。両方出す。
    const groups = BUCKET_ORDER.map((b) => ({
      bucket: b,
      items: list.filter((p) => p.bucket === b),
      total: result.processes.filter((p) => p.bucket === b).length,
    }));
    return groups;
  }, [result, q]);

  const c = result?.confidence || null;
  const bc = result?.bucketCounts || null;

  // 🚨「1人だけ」のうち、判別できない記録が混ざっている工程の数。
  //    この工程は、名前が分かれば「2人以上」へ動きうる＝「1人だけ◯件」が減る側の幅。
  //    （増える側の幅は「分からない」の件数そのもの）
  const oneCouldDrop = useMemo(
    () => (result ? result.processes.filter((p) => p.bucket === BUCKET.ONE_PERSON_ONLY && p.mayBeMorePeople).length : 0),
    [result],
  );

  // 🚨「1人だけ」のうち、根拠がロット1件しか無い工程の数。
  //    実測で 88件中 37件(42%)。ロットが1件しか流れていない工程は、
  //    「その人しかやっていない」のではなく「1回しか出番が無かった」だけの可能性が高い。
  //    区分の見出しに 88 とだけ出すと、この42%が「属人化」として読まれる。
  const thinSolo = useMemo(
    () => (result ? result.processes.filter((p) => p.bucket === BUCKET.ONE_PERSON_ONLY && p.counts.lotCount <= 1).length : 0),
    [result],
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50">
      <div className="p-4 space-y-4">

        {/* 🚨 一番上。押す前から必ず見えている。 */}
        <div className="rounded-xl border-2 border-rose-400 bg-rose-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-8 h-8 text-rose-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-rose-800 font-black text-xl leading-snug">
                これは<span className="underline decoration-4 decoration-rose-400">実際の作業記録から推測した疑似の表</span>です。
              </div>
              <div className="text-rose-800 font-black text-xl leading-snug mt-1">
                力量の認定ではありません。配置や人事評価には使えません。
              </div>
              <div className="text-[12px] text-rose-700 mt-2 leading-relaxed">
                スキル設定（テンプレの必要スキル／作業者のレベル）は<b>1件も登録されていません</b>。
                そのため設定からは何も出せず、<b>「実際にやった記録が在るか」だけ</b>を数えています。<br />
                「やった記録が無い」＝「できない」ではありません。「1人だけ」＝「その人しかできない」でもありません。
              </div>
              {/* 🚨 上の但し書きは「工程」しか守っていない。「人」を守る文が1つも無かったので足した。 */}
              {/*    実測: 表に名前が出る行数は 8行 / 74行 / 75行 / 95行 と桁違いに開く。 */}
              {/*    この差を「働きの量」と読まれると、名前の出にくい人が一番傷つく。 */}
              <div className="mt-3 rounded-lg border-2 border-rose-500 bg-white px-3 py-2">
                <div className="text-rose-800 font-black text-base leading-snug">
                  人と人を見比べる表ではありません。
                </div>
                <div className="text-[12px] text-slate-700 mt-1 leading-relaxed">
                  この表に<b>名前が出てくる行の数も、名前の横の「◯件」も、その人の働きの量ではありません</b>。
                  名前が残っていない記録が多くあり、記録の残り方は工程・時期・持ち場によって違います。
                  <b>名前があまり出てこない人が「やっていない人」だという意味には、まったくなりません。</b>
                  人どうしを並べて見る目的では使わないでください。
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 計算ボタン（⚠押した時だけ走る） */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap items-center gap-3">
          <button
            onClick={run}
            disabled={busy}
            className="px-5 py-2.5 rounded-lg bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white font-black text-sm flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calculator className="w-4 h-4" />}
            {busy ? '数えています…' : (state ? 'もう一度数える' : '作業記録から数える')}
          </button>
          <div className="fi-tap-text text-slate-500 leading-tight">
            重い計算なので<b>押した時だけ</b>走ります（自動では走りません）。<br />
            ロット {num((lots || []).length)}件 ／ テンプレ {num((templates || []).length)}件 ／ 登録作業者 {num((workers || []).length)}名 を読みます。
          </div>
          {state && <div className="fi-tap-text text-slate-400 ml-auto">数えた時刻: {new Date(state.at).toLocaleString('ja-JP')}</div>}
        </div>

        {error && (
          <div className="rounded-xl border-2 border-rose-400 bg-white p-4 text-rose-700 text-sm font-bold">
            計算に失敗しました: {error}
          </div>
        )}

        {!state && !error && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-400 text-sm">
            上の「作業記録から数える」を押すと、工程を<b>まだ誰もやっていない／1人だけ／2人以上</b>に分けて並べます。
          </div>
        )}

        {state && c && bc && (
          <>
            {/* 🚨 数字の出どころ */}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="font-black text-slate-800 text-sm mb-2 flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-slate-400" />
                この数字はどこから数えたか
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
                <Tile label="読んだロット" value={`${num((lots || []).length)} 件`} sub="この端末が今読んでいる全ロット" />
                <Tile label="タスク（作業の記録）" value={`${num(c.tasksTotal)} 件`} sub={`うち数えた ${num(c.tasksEvaluated)}件`} />
                <Tile
                  label="日付が読めた期間"
                  value={times?.overall.firstMs ? `${fmtDate(times.overall.firstMs)} 〜 ${fmtDate(times.overall.lastMs)}` : '—'}
                  sub={times ? `日付が読めなかった記録 ${num(times.overall.undatedTaskCount)}件` : ''}
                />
                <Tile label="工程" value={`${num(bc.total)} 件`} sub="テンプレ台帳 ∪ ロットに焼かれた工程" />
                <Tile label="登録作業者" value={`${num(c.workersRegistered)} 名`} sub={c.duplicateWorkerNames?.length ? `🚨同姓同名 ${c.duplicateWorkerNames.length}件` : '同姓同名なし'} />
                <Tile
                  label="数えなかった記録"
                  value={`${num(Object.values(c.excludedByStatus || {}).reduce((s, n) => s + n, 0) + c.processUnresolvedTasks)} 件`}
                  sub={`${Object.entries(c.excludedByStatus || {}).map(([k, v]) => `${k} ${v}`).join(' / ') || '—'} ／ 工程が決められない ${num(c.processUnresolvedTasks)}`}
                />
              </div>
              <div className="mt-2 fi-tap-text text-slate-500 leading-relaxed">
                工程の身元は <b>テンプレID + step.id</b>（{result.processKeyBasis}）。
                期間は「作業記録に日付が読めた範囲」で、ロットの登録日ではありません。
                {c.sumMatchesEvaluated
                  ? <span className="ml-1 text-emerald-700 font-bold">内訳の合計＝数えたタスク数（検算OK）</span>
                  : <span className="ml-1 text-rose-700 font-black">🚨内訳の合計が合いません。この結果を使わないでください。</span>}
              </div>
            </div>

            {/* 🚨 誰がやったか分からない — これを出さないと数字が誤読される */}
            <div className="rounded-xl border-2 border-rose-400 bg-white p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="shrink-0">
                  <div className="fi-tap-text font-black text-rose-700">🚨 誰がやったか分からない記録</div>
                  <div className="text-4xl font-black text-rose-700 leading-none mt-1">
                    {num(c.unattributedTasks)}<span className="text-lg ml-1">件</span>
                    <span className="text-2xl ml-2">（{pct(c.unattributedTasks, c.tasksEvaluated)}）</span>
                  </div>
                  <div className="fi-tap-text text-slate-500 mt-1">数えたタスク {num(c.tasksEvaluated)}件のうち</div>
                </div>
                <div className="flex-1 min-w-[260px] text-[12px] text-rose-800 leading-relaxed font-bold">
                  {result.sensitivity?.direction}
                  <div className="font-normal text-slate-600 mt-1">
                    {/* 🚨「1人だけ◯件は必ず少なく出ている」と書いてはいけない。名前が分からない記録は上にも下にも効く。
                        ・1人だけの工程に別の人の記録が混ざっていれば → 2人以上へ移り、◯件は減る
                        ・分からない工程の名前が分かれば → 1人だけへ移り、◯件は増える
                        どちらが起きるかは記録が無いので分からない。だから向きでなく幅で書く。 */}
                    つまり下の「1人だけ {num(bc.onePersonOnly)}件」は<b>この通りの数ではありません</b>。
                    判別できない記録が混ざっている工程が<b>{num(oneCouldDrop)}件</b>あり、名前が分かればその分は「2人以上」へ動いて<b>減り</b>ます。
                    逆に「分からない {num(bc.unclear)}件」の名前が分かれば「1人だけ」へ動いて<b>増え</b>ます。
                    <b className="text-rose-700">増える向きにも減る向きにもずれます。</b>
                    この数字だけを見て「代替が居る／居ない」を決めないでください。
                  </div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 fi-tap-text">
                <div className="rounded border border-slate-200 px-2 py-1.5">
                  <div className="text-slate-500 font-bold">IDで証明できた</div>
                  <div className="font-black text-emerald-700">{num(c.provenByWorkerId)}件（{pct(c.provenByWorkerId, c.tasksEvaluated)}）</div>
                </div>
                <div className="rounded border border-slate-200 px-2 py-1.5">
                  <div className="text-slate-500 font-bold">名前だけ</div>
                  <div className="font-black text-slate-700">{num(c.byNameOnly)}件（{pct(c.byNameOnly, c.tasksEvaluated)}）</div>
                </div>
                <div className="rounded border border-slate-200 px-2 py-1.5">
                  <div className="text-slate-500 font-bold">同姓同名で決められない</div>
                  <div className="font-black text-slate-700">{num(c.ambiguousNameTasks)}件</div>
                </div>
                <div className="rounded border border-slate-200 px-2 py-1.5">
                  <div className="text-slate-500 font-bold">登録に無い自由入力の名前</div>
                  <div className="font-black text-slate-700">
                    {num(c.unregisteredNameTasks)}件
                    {c.unknownDoers?.length > 0 && <span className="font-normal text-slate-500 ml-1">（{c.unknownDoers.map((u) => `${u.name} ${u.taskCount}`).join('・')}／誰にも寄せていません）</span>}
                  </div>
                </div>
              </div>
            </div>

            {/* 区分の内訳 */}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="font-black text-slate-800 text-sm mb-2">工程 {num(bc.total)}件の内訳</div>
              <div className="flex h-5 rounded overflow-hidden border border-slate-200">
                {BUCKET_ORDER.map((b) => {
                  const n = b === BUCKET.NOBODY_YET ? bc.nobodyYet : b === BUCKET.ONE_PERSON_ONLY ? bc.onePersonOnly : b === BUCKET.TWO_OR_MORE ? bc.twoOrMore : bc.unclear;
                  if (!n) return null;
                  return <div key={b} className={BUCKET_STYLE[b].bar} style={{ width: `${(100 * n) / (bc.total || 1)}%` }} title={`${BUCKET_LABEL[b]}: ${n}件`} />;
                })}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
                {BUCKET_ORDER.map((b) => {
                  const n = b === BUCKET.NOBODY_YET ? bc.nobodyYet : b === BUCKET.ONE_PERSON_ONLY ? bc.onePersonOnly : b === BUCKET.TWO_OR_MORE ? bc.twoOrMore : bc.unclear;
                  return (
                    <div key={b} className={`rounded-lg border px-3 py-2 ${BUCKET_STYLE[b].chip}`}>
                      <div className="font-black text-lg leading-none">{num(n)}<span className="text-xs ml-1">件</span></div>
                      <div className="fi-tap-text font-bold mt-1 leading-tight">{BUCKET_LABEL[b]}</div>
                      <div className="fi-tap-text mt-0.5 leading-tight opacity-80">{BUCKET_SUB[b]}</div>
                      {/* 🚨 「1人だけ ◯件」を裸で出さない。根拠がロット1件だけの分を必ず横に置く。 */}
                      {b === BUCKET.ONE_PERSON_ONLY && thinSolo > 0 && (
                        <div className="fi-tap-text mt-1 leading-tight font-black">
                          うち{num(thinSolo)}件は<b>ロット1件でしか流れていない</b>工程です（1回しか出番が無かっただけの可能性）
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 工程の一覧 */}
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center gap-3">
                <div className="font-black text-slate-800 text-sm">工程の一覧（根拠つき）</div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="工程名・テンプレ名でしぼる"
                    className="border border-slate-300 rounded pl-7 pr-2 py-1 text-xs w-56"
                  />
                </div>
                <div className="fi-tap-text text-slate-500 ml-auto leading-tight">
                  人ごとの数字は「件（タスク数）」。台か回かは<b>記録</b>欄を見てください。<br />
                  {/* 🚨 同じ行に「尾田 32件 / 片山 1件」と並ぶので、放っておくと成績比べに読まれる。 */}
                  <b className="text-rose-700">この数字で人どうしを見比べないでください</b>（記録の残り方が人ごとに違います）。
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="bg-slate-100">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-black border-b border-slate-300 min-w-[220px]">工程</th>
                      <th className="px-3 py-2 font-black border-b border-slate-300 min-w-[240px]"><Users className="w-3.5 h-3.5 inline mr-1" />実際にやった記録が在る人</th>
                      <th className="px-3 py-2 font-black border-b border-slate-300 whitespace-nowrap">記録</th>
                      <th className="px-3 py-2 font-black border-b border-slate-300 whitespace-nowrap">いつ</th>
                      <th className="px-3 py-2 font-black border-b border-slate-300 min-w-[180px]">印</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((g) => {
                      const st = BUCKET_STYLE[g.bucket];
                      const open = !!openBucket[g.bucket];
                      return (
                        <React.Fragment key={g.bucket}>
                          <tr>
                            <td colSpan={5} className={`px-3 py-1.5 border-y border-slate-200 ${st.head}`}>
                              <button
                                onClick={() => setOpenBucket((s) => ({ ...s, [g.bucket]: !s[g.bucket] }))}
                                className="flex items-center gap-2 font-black text-[13px] w-full text-left"
                              >
                                {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                {BUCKET_LABEL[g.bucket]}
                                <span className="font-black">{num(g.items.length)}件</span>
                                {q.trim() && (
                                  <span className="font-black fi-tap-text text-rose-700 bg-rose-100 rounded px-1.5 py-0.5">
                                    🔎しぼり込み中（全{num(g.total)}件のうち）
                                  </span>
                                )}
                                <span className="font-normal fi-tap-text opacity-80">{BUCKET_SUB[g.bucket]}</span>
                              </button>
                            </td>
                          </tr>
                          {open && g.items.map((p) => {
                            const t = times?.byKey.get(p.key) || null;
                            const last = t ? fmtDate(t.lastMs) : null;
                            const first = t ? fmtDate(t.firstMs) : null;
                            return (
                              <tr key={p.key} className="border-b border-slate-100 hover:bg-amber-50/40 align-top">
                                <td className="px-3 py-1.5">
                                  <div className="font-bold text-slate-800">{p.stepTitle || '(工程名なし)'}</div>
                                  <div className="fi-tap-text text-slate-400">
                                    {p.templateMissing ? '🚨テンプレが見つかりません' : (p.templateName || '(テンプレ名なし)')}
                                  </div>
                                </td>
                                <td className="px-3 py-1.5">
                                  {p.people.length === 0 ? (
                                    <span className="text-slate-400">—</span>
                                  ) : (
                                    <div className="flex flex-wrap gap-1">
                                      {p.people.map((w) => (
                                        <span key={w.workerId} className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5">
                                          <b className="text-slate-800">{w.workerName || '(名前なし)'}</b>
                                          <span className="text-slate-500">{num(w.taskCount)}件</span>
                                          <span
                                            className={`fi-tap-text font-black px-1 rounded ${w.evidence === 'workerId' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}
                                            title={w.evidence === 'workerId' ? `IDで証明できた記録が ${w.byWorkerIdTaskCount}件（名前だけ ${w.byNameOnlyTaskCount}件）` : '名前だけの記録（IDでは証明できていない）'}
                                          >
                                            {w.evidence === 'workerId' ? 'ID証明' : '名前だけ'}
                                          </span>
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  {p.unregisteredNames.length > 0 && (
                                    <div className="fi-tap-text text-slate-500 mt-1">
                                      登録に無い名前: {p.unregisteredNames.map((u) => `${u.name}(${u.taskCount}件)`).join('・')}／誰にも寄せていません
                                    </div>
                                  )}
                                  {p.ambiguousNames.length > 0 && (
                                    <div className="fi-tap-text text-rose-600 mt-1">
                                      🚨同姓同名で決められない: {p.ambiguousNames.map((u) => `${u.name}(${u.taskCount}件)`).join('・')}
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-1.5 whitespace-nowrap" title={COUNT_UNIT_LABEL[p.countUnit]}>
                                  <div className={`font-bold ${p.countUnit === COUNT_UNIT.MIXED ? 'text-rose-700' : p.counts.tasksEvaluated === 0 ? 'text-slate-400' : 'text-slate-700'}`}>{recordText(p)}</div>
                                  {p.counts.tasksEvaluated > 0 && <div className="fi-tap-text text-slate-400">ロット {num(p.counts.lotCount)}件</div>}
                                </td>
                                <td className="px-3 py-1.5 whitespace-nowrap">
                                  {p.counts.tasksEvaluated === 0 ? (
                                    <span className="text-slate-400">—</span>
                                  ) : last ? (
                                    <>
                                      <div className="text-slate-700">最後 {last}</div>
                                      <div className="fi-tap-text text-slate-400">初回 {first}</div>
                                    </>
                                  ) : (
                                    <span className="text-slate-400">日付なし</span>
                                  )}
                                  {t && t.undatedTaskCount > 0 && (
                                    <div className="fi-tap-text text-slate-400">日付が読めない {num(t.undatedTaskCount)}件</div>
                                  )}
                                </td>
                                <td className="px-3 py-1.5">
                                  <div className="flex flex-wrap gap-1 fi-tap-text">
                                    {/* 🚨 ロット1件しか流れていない工程で「◯◯さんだけ」と書くと、
                                        たまたま1回だけ出番が有った人が「属人化の原因」に見えてしまう。 */}
                                    {p.bucket === BUCKET.ONE_PERSON_ONLY && p.counts.lotCount <= 1 && (
                                      <span className="rounded bg-amber-200 text-amber-900 font-black px-1.5 py-0.5" title="この工程はロット1件でしか流れていません。「1人だけ」なのは、その人しかできないからではなく、1回しか出番が無かっただけかもしれません。">
                                        🚨根拠はロット1件だけ
                                      </span>
                                    )}
                                    {p.mayBeMorePeople && (
                                      <span className="rounded bg-rose-100 text-rose-800 font-black px-1.5 py-0.5" title={p.note}>
                                        🚨判別できない記録 {num(p.counts.unattributed + p.counts.ambiguousName + p.counts.unregisteredName)}件
                                      </span>
                                    )}
                                    {p.countUnit === COUNT_UNIT.MIXED && (
                                      <span className="rounded bg-rose-100 text-rose-800 font-black px-1.5 py-0.5" title="台と回が混ざっています。1つの数に足さないでください。">🚨単位が混在</span>
                                    )}
                                    {!p.seenInLots && (
                                      <span className="rounded bg-slate-100 text-slate-600 px-1.5 py-0.5" title="テンプレ台帳にはあるが、ロットに一度も流れていない工程です。">台帳のみ（未実施）</span>
                                    )}
                                    {!p.definedInMaster && (
                                      <span className="rounded bg-slate-100 text-slate-600 px-1.5 py-0.5" title="ロットには焼かれているが、今のテンプレ台帳には無い工程です。">台帳に無い</span>
                                    )}
                                    {p.titleRenamed && (
                                      <span className="rounded bg-slate-100 text-slate-600 px-1.5 py-0.5" title={`題名の履歴: ${p.titleHistory.map((h) => h.title).join(' → ')}`}>題名が変わった</span>
                                    )}
                                    {p.lotOnceConflict && (
                                      <span className="rounded bg-slate-100 text-slate-600 px-1.5 py-0.5" title="step.lotOnce が true と false の両方で記録されています。">lotOnce が食い違う</span>
                                    )}
                                  </div>
                                  {p.bucket !== BUCKET.NOBODY_YET && <div className="fi-tap-text text-slate-500 mt-1 leading-tight">{p.note}</div>}
                                </td>
                              </tr>
                            );
                          })}
                          {open && g.items.length === 0 && (
                            <tr><td colSpan={5} className="px-3 py-3 text-center text-slate-400">該当なし</td></tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 🚨 測れなかった事。飛ばして読ませない。 */}
            <div className="rounded-xl border-2 border-amber-400 bg-amber-50 overflow-hidden">
              <button onClick={() => setShowLimits((s) => !s)} className="w-full px-4 py-2.5 flex items-center gap-2 text-left">
                {showLimits ? <ChevronDown className="w-4 h-4 text-amber-700" /> : <ChevronRight className="w-4 h-4 text-amber-700" />}
                <AlertTriangle className="w-4 h-4 text-amber-700" />
                <span className="font-black text-amber-900 text-sm">この表で測れていない事（{result.limitations.length}件）— 必ず読んでください</span>
              </button>
              {showLimits && (
                <ul className="px-5 pb-4 space-y-1.5 text-[12px] text-amber-900 leading-relaxed list-disc">
                  {result.limitations.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              )}
            </div>

            {/* 🚨 仮定の試算。事実として出さない。警告を必ず一緒に出す。 */}
            {result.sensitivity?.hypothesis && (
              <div className="rounded-xl border border-slate-300 bg-white overflow-hidden">
                <button onClick={() => setShowHypo((s) => !s)} className="w-full px-4 py-2.5 flex items-center gap-2 text-left">
                  {showHypo ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                  <span className="font-black text-slate-700 text-sm">🚨 仮定の試算（事実ではありません）</span>
                  <span className="fi-tap-text text-rose-700 font-bold">{result.sensitivity.hypothesis.warning}</span>
                </button>
                {showHypo && (
                  <div className="px-5 pb-4 text-[12px] text-slate-700 leading-relaxed">
                    <div className="rounded border-2 border-rose-300 bg-rose-50 p-2 text-rose-800 font-bold mb-2">
                      {result.sensitivity.hypothesis.warning}
                    </div>
                    <div>やり方: {result.sensitivity.hypothesis.method}</div>
                    <ul className="list-disc pl-5 mt-1 space-y-0.5">
                      <li>当てはめられる名無しの記録 {num(result.sensitivity.hypothesis.applicableTasks)}件／当てはめられない {num(result.sensitivity.hypothesis.notApplicableTasks)}件</li>
                      <li>「1人だけ」が「2人以上」に変わりうる工程 {num(result.sensitivity.hypothesis.onePersonOnlyCouldBecomeTwoOrMore)}件</li>
                      <li>「分からない」が特定できうる工程 {num(result.sensitivity.hypothesis.unclearCouldBecomeIdentified)}件</li>
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="fi-tap-text text-slate-400 pb-2 leading-relaxed">
              工程の身元の決め方: {result.processKeyReason}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default SoloDependencyPanel;
