// =============================================================================
//  opsim/ScenarioCompare.jsx — 条件くらべの1表（「改善・教育」タブの上段）
// -----------------------------------------------------------------------------
//  出典: 清水さんの表（2026-08-30 画面4分割の指示）＋ CONTRACT.md §5（比較の掟）
//
//  ■ この部品が守っている事
//   🚨 材料は親(OperationsSimulationPanel)の scenarioStoreRef の保管庫だけ。
//      保管庫には「同じ土俵（入力の指紋・基準時刻・範囲・日数・見積りモードが同じ）」の
//      結果しか入らない（親が groundKey で守っている。条件を変えると丸ごと捨てられる）。
//      この表は計算をし直さない。追加の計算コストは0。
//   🚨 保管庫に無い行は **数字を1つも出さない**。「計算する」ボタンだけを出す。
//      押すと onPick(key) → 親がそのシナリオへ切り替えて計算が走り、結果が貯まると載る。
//   🚨 「通常との差」は、通常と対象の行が **両方** 保管庫に有る時だけ出す。
//      差が0なら「差なし」と言い切る。差0に良し悪しの言葉を書かない（CONTRACT.md §5）。
//   🚨 念のため行ごとに inputFingerprint / baseNow を照合し、万一違えば
//      その行の差は出さない（土俵が違う物と比べない）。
//   🚨 metrics の値をここで数え直さない。futureLateLotCount（この先で遅れるロット）・
//      unresolvedTotalLotCount（手が付けられないロット）・forecastBreachAt（この先で
//      最初に納期線を越える時刻）を **そのまま** 出す。3つとも単位はロット／実時刻。
//   ⚠ 文字は最小 text-2xs。px直書きは文字サイズ設定(applyFontSizes)で伸びないので使わない。
//   ⚠ この1ファイルで完結（react + lucide + Tailwind のみ）。domain を import しない。
// =============================================================================
import React from 'react';
import { Table2, Calculator } from 'lucide-react';
import { Signal, Dots } from './vizKit.jsx';

// -----------------------------------------------------------------------------
// 行の並び（清水さんの表のとおり）。key は親の scenarioKey と同じ文字列。
// ⚠ label は Header のシナリオピルと同じ言い方（押す物と表の行を同じ名前にする）。
//   保管庫に label が入っている行（残業の「(1日540分)」等）はそちらを優先して出す。
//   実際に計算した中身を言っている名前だから。
// -----------------------------------------------------------------------------
const ROWS = [
  { key: 'normal', label: '通常', hint: '今いる人・今の勤務時間のまま' },
  { key: 'overtime', label: '残業', hint: '1日に使える時間を増やした時' },
  { key: 'absence', label: '誰か休み', hint: '誰か1人が休んだ時' },
  { key: 'allSkills', label: '全員できる仮定', hint: '全員がどの工程も持てるとして数える（総量を見る）' },
  { key: 'ojt', label: '後継者が単独可になった後', hint: 'その人が1人でその工程をできる様になった後の姿' },
  { key: 'swap', label: '人の任せ替え', hint: '1人を休みにして、その人の工程を別の人に仮に持たせた時' },
];

// シナリオの入力がまだ揃っていない時の言い方。
// 🚨 揃うまでは「通常と同じ計算」なので保管庫に貯まらない（親の掟）。それをそのまま言う。
const EMPTY_HINT = {
  absence: '休む人を選ぶまでは通常と同じ計算なので、ここには貯まりません。',
  ojt: '後継者と工程を選ぶまでは通常と同じ計算なので、ここには貯まりません。',
  swap: '休みにする人と任せる人が揃うまでは通常と同じ計算なので、ここには貯まりません。',
};

/** 残業の量の言い方（親の OVERTIME_EXTRA_CHOICES と同じ字）。 */
const OVERTIME_NAME = { 30: '＋30分', 60: '＋60分', full: '満額(9時間)' };

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

// -----------------------------------------------------------------------------
// 数の出し方。🚨 丸めずに出すと 0.30000000000000004 が画面に出る。
// -----------------------------------------------------------------------------
const fmtInt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('ja-JP') : '—');

// 数として読める時だけ数にする。🚨 Number(null) は 0 になるので、null を先に外す。
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ⚠ マイナス記号は U+2212。ハイフンだと tabular-nums で高さが揃わない（Header と同じ流儀）。
const fmtDeltaCount = (n) => `${n > 0 ? '+' : '−'}${fmtInt(Math.abs(n))}件`;

/** 実時刻。年は title（マウスを載せた時）に出す。 */
const fmtWhen = (ms) => {
  const n = numOrNull(ms);
  if (n == null) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return {
    head: `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）${hm}`,
    year: `${d.getFullYear()}年`,
  };
};

// 時間の長さ。実時間のミリ秒なので「日・時間」で出す（稼働時間ではない）。
const fmtSpan = (ms) => {
  const v = Math.abs(Number(ms) || 0);
  if (v < 60000) return '1分未満';
  const total = Math.floor(v / 60000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}日 ${hours}時間` : `${days}日`;
  if (hours > 0) return mins > 0 ? `${hours}時間 ${mins}分` : `${hours}時間`;
  return `${mins}分`;
};

/** 保管庫。親は { key, byId: Map } を渡す。読めない形なら空として扱う（落とさない）。 */
const readStoreMap = (store) => {
  const byId = store && store.byId;
  return byId instanceof Map ? byId : new Map();
};

// -----------------------------------------------------------------------------
// 通常との差。🚨 この表の3列（遅れ・手が付けられない・最初の突破）についてだけ出す。
//   戻り: { kind: 'blocked' } 土俵が違う（本来起きない。起きたら比べない）
//        { kind: 'same' }    3列とも差0
//        { kind: 'diff', chips: [{ key, text, good }] }
// -----------------------------------------------------------------------------
function buildDiff(baseM, rowM) {
  if (!baseM || !rowM) return null;
  // 🚨 念のための土俵照合（CONTRACT.md §5: 完全一致の時だけ比べる）。
  //   保管庫は同じ土俵の物しか持たない作りだが、万一混ざっていたら数字を出さない。
  if (baseM.inputFingerprint !== rowM.inputFingerprint || baseM.baseNow !== rowM.baseNow) {
    return { kind: 'blocked' };
  }
  const chips = [];
  const push = (key, label, rowV, baseV) => {
    const a = numOrNull(rowV);
    const b = numOrNull(baseV);
    if (a == null || b == null) return;   // 読めない値から差を作らない（0で埋めない）
    const d = a - b;
    if (d === 0) return;                  // 差0は行を作らない。まとめて「差なし」と言う
    chips.push({ key, text: `${label} ${fmtDeltaCount(d)}`, good: d < 0 });
  };
  push('late', '遅れ', rowM.futureLateLotCount, baseM.futureLateLotCount);
  push('unresolved', '手が付けられない', rowM.unresolvedTotalLotCount, baseM.unresolvedTotalLotCount);

  // 最初の突破。null＝「この期間では越えない」。null ↔ 時刻 の変化は言葉で出す
  // （引き算の数字を作らない。作り話の数字を出さないため）。
  const b = numOrNull(baseM.forecastBreachAt);
  const o = numOrNull(rowM.forecastBreachAt);
  if (b == null && o != null) {
    chips.push({ key: 'breach', text: '突破が新しく出ます', good: false });
  } else if (b != null && o == null) {
    chips.push({ key: 'breach', text: '突破が出なくなります', good: true });
  } else if (b != null && o != null && o !== b) {
    // 時刻は「後ろへ動く＝良い」（Header の betterWhenUp と同じ向き）。
    chips.push({ key: 'breach', text: `突破 ${o > b ? '後ろへ' : '前へ'} ${fmtSpan(o - b)}`, good: o > b });
  }
  return chips.length ? { kind: 'diff', chips } : { kind: 'same' };
}

// -----------------------------------------------------------------------------
// 小さい部品。⚠ 全部この位置（モジュールの一番上）に置く。描画関数の中で定義しない。
// -----------------------------------------------------------------------------

/** 件数のマス。0 は slate（危険ではない）、1件以上は rose。読めない時は「—」。 */
function CountCell({ value }) {
  const n = numOrNull(value);
  if (n == null) return <span className="text-2xs text-slate-400">—</span>;
  /* 🚨 2026-09-15: 件数が **文字だけ** だった(notext の写しで右半分が真っ白)。
     1件＝1点で並べると、行を跨いだ 33 と 0 が読まずに分かる。
     🚨 ここで数えない。渡された値をそのまま点にするだけ。数字は右に札として残す。
     🚨 赤は「遅れ」専用(lateTone.js)。0件は赤にしない — 灰の点線の輪1つになる。 */
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Dots count={n} cap={12} tone={n > 0 ? 'late' : 'quiet'} size="w-2 h-2" title="ロットの件数" />
      <span className={`text-sm font-black tabular-nums ${n > 0 ? 'text-rose-600' : 'text-slate-700'}`}>
        {fmtInt(n)}<span className="ml-0.5 text-2xs font-bold text-slate-500">件</span>
      </span>
    </span>
  );
}

/** 最初の突破のマス。null は「越えません」と言い切る（無言のマスを作らない）。 */
function BreachCell({ value }) {
  const when = fmtWhen(value);
  if (!when) {
    return (
      <span className="inline-flex items-center gap-1" title="この期間の中では、この先で新しく納期線を越えるロットは出ていません">
        <Signal level="ok" size="w-4 h-4" />
        <span className="text-2xs font-bold text-emerald-700">越えません</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1" title={`${when.year}。ここで最初の1件が納期線を越えます`}>
      <Signal level="danger" size="w-4 h-4" />
      <span className="text-xs font-black tabular-nums text-rose-600">{when.head}</span>
    </span>
  );
}

/** 通常との差のマス。 */
function DiffCell({ isNormal, stored, hasBase, diff }) {
  if (isNormal) {
    return <span className="inline-flex rounded-md bg-slate-100 px-1.5 py-0.5 text-2xs font-black text-slate-600">基準</span>;
  }
  /* 🚨 まだ押していない行の「—」は notext で完全な空白。点線の輪＝『読めていません』を出す。
     0 と 読めていません を同じ絵にしない(vizKit の決まり)。 */
  if (!stored) return <span className="inline-flex items-center gap-1"><Signal level="unknown" size="w-4 h-4" /><span className="text-2xs text-slate-400">—</span></span>;
  if (!hasBase) {
    return <span className="text-2xs text-slate-500 leading-snug">「通常」を計算すると差が出ます</span>;
  }
  if (!diff || diff.kind === 'blocked') {
    return <span className="text-2xs font-bold text-amber-700 leading-snug">土俵が違うので比べません</span>;
  }
  if (diff.kind === 'same') {
    return <span className="inline-flex rounded-md bg-slate-100 px-1.5 py-0.5 text-2xs font-bold text-slate-600">差なし</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {diff.chips.map((c) => (
        <span
          key={c.key}
          className={`inline-flex items-center gap-1 rounded-md border bg-white px-1.5 py-0.5 text-2xs font-bold tabular-nums ${
            c.good ? 'border-emerald-200 text-emerald-700' : 'border-rose-200 text-rose-700'
          }`}
        >
          <Signal level={c.good ? 'ok' : 'danger'} size="w-3 h-3" />
          {c.text}
        </span>
      ))}
    </span>
  );
}

// -----------------------------------------------------------------------------
// 本体
// -----------------------------------------------------------------------------
/**
 * 条件比較の1表。
 * @param {object} props
 * @param {{key:string|null, byId:Map<string,{label:string, metrics:object}>}|null} props.store
 *   親の scenarioStoreRef.current（押して計算した結果の保管庫。同じ土俵の物だけ）。
 * @param {string} props.currentKey いま選ばれているシナリオ（'normal'|'overtime'|…）
 * @param {(key:string)=>void} props.onPick 行や「計算する」を押した時（親がシナリオを切り替える）
 * @param {'30'|'60'|'full'} props.overtimeStep いま選ばれている残業の量（押した時に使われる量の予告）
 * @param {boolean} props.swapReady 任せ替えの支度（休みにする人・任せる人）が揃っているか
 */
export function ScenarioCompare({
  store = null,
  currentKey = 'normal',
  onPick = null,
  overtimeStep = 'full',
  swapReady = false,
}) {
  const byId = readStoreMap(store);
  const baseEntry = byId.get('normal') || null;
  const baseMetrics = (baseEntry && baseEntry.metrics) || null;

  // 保管庫に居るのに ROWS に無い行も捨てない（貯めた物は全部出す）。
  const extras = [];
  byId.forEach((v, k) => {
    if (!ROWS.some((r) => r.key === k)) extras.push({ key: k, label: (v && v.label) || k, hint: '' });
  });
  const rows = [...ROWS, ...extras];

  const pick = (key) => { if (typeof onPick === 'function') onPick(key); };

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 pt-2.5">
        <span className="inline-flex items-center gap-1.5">
          <Table2 className="w-3.5 h-3.5 shrink-0 text-cyan-700" />
          <span className="text-xs font-black text-slate-800">条件くらべ</span>
        </span>
        <span className="text-2xs text-slate-500 leading-snug">
          押して計算した結果だけを、同じ土俵で並べます。行を押すとそのシナリオに切り替わります。
        </span>
      </div>

      {/* 8行に増えても崩れない様に、表は自分の中で横に流す（画面ごと横スクロールさせない） */}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse">
          <thead>
            <tr className="border-y border-slate-200 bg-slate-50 text-left">
              <th scope="col" className="px-3 py-1.5 text-2xs font-bold text-slate-500">条件</th>
              <th scope="col" className="px-2 py-1.5 text-2xs font-bold text-slate-500" title="この先で遅れるロット（すでに予定日を過ぎている物は入れていません）">
                遅れ<span className="ml-1 font-normal text-slate-400">この先・ロット</span>
              </th>
              <th scope="col" className="px-2 py-1.5 text-2xs font-bold text-slate-500" title="手が付けられないロット（納期線の有無を問わない）">
                手が付けられない<span className="ml-1 font-normal text-slate-400">ロット</span>
              </th>
              <th scope="col" className="px-2 py-1.5 text-2xs font-bold text-slate-500" title="この先で最初に納期線を越える時刻">
                最初の突破
              </th>
              <th scope="col" className="px-2 py-1.5 text-2xs font-bold text-slate-500" title="通常も対象の行も計算済みの時だけ出ます。差0は「差なし」">
                通常との差
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const entry = byId.get(row.key) || null;
              const m = (entry && entry.metrics) || null;
              const isCurrent = row.key === currentKey;
              const isNormal = row.key === 'normal';
              const swapNotReady = row.key === 'swap' && !swapReady;
              const label = (entry && entry.label) || row.label;
              return (
                <tr
                  key={row.key}
                  onClick={() => pick(row.key)}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`border-b border-slate-100 align-middle cursor-pointer transition-colors ${
                    isCurrent ? 'bg-cyan-50/70' : 'hover:bg-slate-50'
                  }`}
                >
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      title={row.hint || ''}
                      aria-pressed={isCurrent}
                      onClick={(e) => { e.stopPropagation(); pick(row.key); }}
                      className={`min-h-11 flex w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-bold transition-colors ${
                        isCurrent ? 'text-cyan-800' : 'text-slate-700 hover:text-cyan-700'
                      }`}
                    >
                      {/* 行の総合。計算済み＝中身の色／未計算＝点線の輪。条件の名前より先に目に入る */}
                      <Signal level={!m ? 'unknown' : (numOrNull(m.futureLateLotCount) > 0 ? 'danger' : 'ok')} size="w-4 h-4" />
                      {label}
                      {isCurrent ? (
                        <span className="ml-1.5 inline-flex rounded-md bg-cyan-500 px-1.5 py-0.5 text-2xs font-black text-white align-middle">
                          いま見ている
                        </span>
                      ) : null}
                    </button>
                  </td>

                  {m ? (
                    <>
                      <td className="px-2 py-2"><CountCell value={m.futureLateLotCount} /></td>
                      <td className="px-2 py-2"><CountCell value={m.unresolvedTotalLotCount} /></td>
                      <td className="px-2 py-2"><BreachCell value={m.forecastBreachAt} /></td>
                    </>
                  ) : (
                    <td colSpan={3} className="px-2 py-2">
                      {isCurrent ? (
                        <span className="text-2xs text-slate-500 leading-snug">
                          いま選ばれています。計算が終わると、この土俵の数字がここに載ります。
                          {EMPTY_HINT[row.key] ? ` ${EMPTY_HINT[row.key]}` : ''}
                        </span>
                      ) : swapNotReady ? (
                        <span className="text-2xs text-slate-500 leading-snug">
                          任せ替えの支度がまだです。行を押して切り替え、⚙ 設定 で
                          休みにする人と任せる人を選ぶと計算が走ります。
                        </span>
                      ) : (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); pick(row.key); }}
                            title={`「${row.label}」に切り替えて計算します。結果はこの表に貯まります`}
                            className="inline-flex items-center gap-1.5 min-h-11 rounded-lg border border-cyan-500 bg-cyan-500 px-2.5 text-2xs font-bold text-white transition-colors hover:bg-cyan-600"
                          >
                            <Calculator className="w-3.5 h-3.5 shrink-0" />
                            計算する
                          </button>
                          {row.key === 'overtime' && OVERTIME_NAME[overtimeStep] ? (
                            <span className="text-2xs text-slate-500">いまの選択: {OVERTIME_NAME[overtimeStep]}</span>
                          ) : null}
                        </span>
                      )}
                    </td>
                  )}

                  <td className="px-2 py-2">
                    <DiffCell
                      isNormal={isNormal}
                      stored={!!m}
                      hasBase={!!baseMetrics}
                      diff={isNormal || !m ? null : buildDiff(baseMetrics, m)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 🚨 2026-09-15 畳む: 下の注記3行が、表の下にずっと居座って
          「手ごとの効き目」を画面の外へ押し出していた。文字は1つも消さず畳みの中へ。 */}
      <details className="border-t border-slate-100">
      <summary className="flex min-h-11 cursor-pointer select-none items-center px-3 text-2xs font-bold text-slate-500">この表の数え方・差の出し方</summary>
      <div className="px-3 py-1.5 text-2xs text-slate-500 leading-snug">
        件数は全部ロットの数です。差はこの表の3列（遅れ・手が付けられない・最初の突破）について出しています。
        まだ押していない行に数字は出しません。条件（範囲・日数・工数の見積り）を変えると
        貯めた物は捨てられ、表は育て直しです（別の土俵の数字を混ぜないため）。
      </div>
      </details>
    </section>
  );
}

export default ScenarioCompare;
