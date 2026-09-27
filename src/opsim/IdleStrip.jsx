// =============================================================================
//  src/opsim/IdleStrip.jsx — 「誰が・どの日に・どれだけ手が空くか。なぜか」の帯
// -----------------------------------------------------------------------------
//  🚨 決まり14-3（2026-09-03 清水さん）「暇な理由が仕事が全くないのかスキルがないのかって話が
//     やっとでてくるよね(ここがかなり重要)」。納期一覧の **一番上** に置く（日の列は下の行と同じ）。
//
//  見せ方（文字を消しても分かる物）:
//    ・1人1行。営業日ごとに横棒: 灰＝働いている分、色＝手が空く分（色＝理由）。
//    ・右端に今日の空きを大きく（色＝理由）。数字は補助。
//    ・橙＝記録が無い工程が待っている（スキル側） / 灰＝仕事が無い（仕事側） / 水色＝まだ着いていない / 紫＝専門の作業のため。
//  🚨 数字は buildIdleByDay（domain/operationsSimulation/idleReason.js）の戻りを置くだけ。ここで数え直さない。
//  ⚠ px 直書きをしない（rem 段）。
// =============================================================================
import React from 'react';
import { toneOf } from './workerColors.js';
import { columnAt } from './dueAxis.js';
import { IDLE_KIND, IDLE_KIND_LABEL, fmtHours } from '../domain/operationsSimulation/idleReason.js';
import { KIND_TONE, toneOfKind, OFF_HATCH } from './idleTone.js';
// 🎨 絵の語彙(2026-09-15)。🚨 Avatar は色を決めない(呼ぶ側が workerColors の tone を渡す)。
import { Avatar, Signal, Bar } from './vizKit.jsx';
import { templatePrefText } from '../domain/operationsSimulation/templatePrefStats.js';
import { workerLoadText } from '../domain/operationsSimulation/workerLoad.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 1人×1日の小さな棒。灰＝働く分、色＝空き。 */
function DayCell({ col, cell }) {
  if (!cell) return null;
  const work = isNum(cell.workMin) ? cell.workMin : 0;
  // 🚨 2026-09-04: 働ける時間が0分の日は **ゲージを出さない**（休日と同じ）。
  //   灰1色の棒を出すと「まる1日ふさがっている」に読めるが、実際は
  //   「その日は計算の範囲に入っていない／勤務が無い」で意味が正反対。
  if (!(work > 0)) return null;
  const free = isNum(cell.freeMin) ? cell.freeMin : 0;
  const freePct = work > 0 ? Math.min(100, (free / work) * 100) : 0;
  const tone = cell.top ? toneOfKind(cell.top.kind) : toneOfKind(IDLE_KIND.NO_JOB);
  return (
    <div
      className="absolute inset-y-0"
      style={{ left: `${col.left}%`, width: `${col.width}%` }}
      data-idle-day={col.ms}
      data-idle-kind={cell.top ? cell.top.kind : ''}
      title={`${col.label}(${col.wd}) 働ける ${fmtHours(work)}・空き ${cell.freeMin == null ? '記録なし' : fmtHours(free)}${cell.top ? `・${IDLE_KIND_LABEL[cell.top.kind]}` : ''}`}
    >
      <div className="absolute inset-y-0 left-[0.0625rem] right-[0.0625rem] overflow-hidden rounded bg-slate-200">
        {/* 空きの分（右から色で塗る）。働いている分は灰のまま */}
        {freePct > 0 ? (
          <div className={`absolute inset-y-0 right-0 ${tone.bar}`} style={{ width: `${freePct}%` }} />
        ) : null}
      </div>
      {/* 文字は 30分以上の空きだけ（灰＝ふさがっている、は色で分かる。空きの記録が無い日は灰のまま）
          🚨 2026-09-04: 白文字をやめた。棒は右から freePct% しか塗らないので、
             真ん中に置いた文字の左半分が薄い灰(bg-slate-200)の上に来て、白だと明暗差1.2で消える
             （実測で「3.9h」の「3.」が読めなかった）。濃い字は 灰・橙・水色・紫・濃灰 のどの棒の上でも読める。 */}
      {free >= 30 ? (
        <span className="absolute inset-0 flex items-center justify-center text-2xs font-black leading-none text-slate-900">
          {fmtHours(free)}
        </span>
      ) : null}
    </div>
  );
}

/** 今日の空き（右端の大きな数字）。空きの記録が無い勤務日は 0（simulate S02: 空ける時は必ず idleLog に書く）。 */
function todayText(today) {
  if (!today) return null;
  if (today.freeMin != null) return fmtHours(today.freeMin);
  return today.workMin > 0 ? '0分' : '—';
}

/**
 * @param {object} p
 * @param {Array} p.cols        dueAxis.buildDayColumns の戻り
 * @param {object} p.idleByDay  buildIdleByDay の戻り
 * @param {string[]} p.workerNames
 * @param {object} p.workerColors buildWorkerColors の戻り
 * @param {number} p.nowMs
 * @param {boolean} [p.compact] 人・日順の見出しで使う時は帯だけ
 */
export function IdleStrip({ cols = [], idleByDay = null, workerNames = [], workerColors = null, nowMs = null, prefStats = null, loadByWorker = null }) {
  if (!idleByDay || !Array.isArray(cols) || !cols.length) return null;
  // 🚨 2026-09-04: 数えられなかった時に **黙って消さない**。
  //   帯が無いと「空きが無い」のか「計算できなかった」のか読む人に分からない。
  if (idleByDay.error) {
    return (
      <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-2xs font-bold text-amber-900" data-idle-strip="error">
        手が空く時間を数えられませんでした（{String(idleByDay.error)}）。この帯だけ出せていません。他の数字は出ています。
      </div>
    );
  }
  const names = (Array.isArray(workerNames) ? workerNames : []).filter((n) => idleByDay.byWorker && idleByDay.byWorker[n]);
  if (!names.length) return null;
  const todayCol = columnAt(cols, nowMs);
  const todayMs = todayCol ? todayCol.ms : null;
  const unresolved = idleByDay.unresolved || null;
  const skillRow = unresolved && unresolved.rows ? unresolved.rows.find((r) => r.kind === 'skill') : null;

  return (
    <div className="mb-2 rounded-lg border border-slate-200 bg-slate-50/60 p-1.5" data-idle-strip={names.length}>
      {/* 🎨 案A(2026-09-16): 見出し1文＋色の凡例は点＋短い語で1行。言葉は IDLE_KIND_LABEL ただ1本(ここで作らない)。 */}
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="text-sm font-black text-slate-900">手が空く時間と、その理由</span>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-2xs font-bold text-slate-500" data-idle-legend="1">
          <span className="inline-flex items-center gap-1 whitespace-nowrap"><span className="inline-block h-3 w-3 rounded-sm bg-slate-200" />働いている</span>
          <span className="inline-flex items-center gap-1 whitespace-nowrap"><span className={`inline-block h-3 w-3 rounded-sm ${KIND_TONE.skill.bar}`} />{IDLE_KIND_LABEL.skill}</span>
          <span className="inline-flex items-center gap-1 whitespace-nowrap"><span className={`inline-block h-3 w-3 rounded-sm ${KIND_TONE.nojob.bar}`} />{IDLE_KIND_LABEL.nojob}</span>
          <span className="inline-flex items-center gap-1 whitespace-nowrap"><span className={`inline-block h-3 w-3 rounded-sm ${KIND_TONE.arrival.bar}`} />{IDLE_KIND_LABEL.arrival}</span>
          <span className="inline-flex items-center gap-1 whitespace-nowrap"><span className={`inline-block h-3 w-3 rounded-sm ${KIND_TONE.reserved.bar}`} />{IDLE_KIND_LABEL.reserved}</span>
          {/* 🏭 2026-09-10: 作業する場所が満杯。色だけ出て札が無いと、その色が何なのか読めない。 */}
          <span className="inline-flex items-center gap-1 whitespace-nowrap"><span className={`inline-block h-3 w-3 rounded-sm ${KIND_TONE.zone.bar}`} />{IDLE_KIND_LABEL.zone}</span>
        </span>
      </div>

      {names.map((name) => {
        const rowCells = idleByDay.byWorker[name] || {};
        const today = todayMs != null ? rowCells[todayMs] : null;
        const tone = today && today.top ? toneOfKind(today.top.kind) : null;
        const lack = idleByDay.lackingByWorker ? idleByDay.lackingByWorker[name] : null;
        const wtone = toneOf(workerColors, name);
        // 👤📊 2026-09-17 優先がどれだけ効いたか／この期間の負荷(数は純関数の物をそのまま)
        const ps = prefStats && prefStats.byWorker ? (prefStats.byWorker[name] || null) : null;
        const ld = loadByWorker && loadByWorker.byWorker ? (loadByWorker.byWorker[name] || null) : null;
        // 🎨 案A: 1人1行 = 丸＋名前＋理由の短い札 ｜ 日の軸 ｜ 右に「今日 空き ◯分」(数は today.freeMin そのまま)。
        return (
          <div key={name} className="grid grid-cols-[15rem_1fr_15rem] items-center gap-2 border-t border-slate-100 py-0.5" data-idle-worker={name}>
            <div className="flex min-w-0 items-center gap-2">
              {/* 🚨 2026-09-15 実測(notext): この行は **薄い灰色の板** だけになり、
                  読み込み中の抜け殻と見分けが付かなかった。空きが0分の人は色が1つも出ないので、
                  「計算が終わって空きが無い」と「まだ描かれていない」が同じ絵になっていた。
                  ⇒ 人の丸(Avatar)と 今日の状態の信号(Signal)を先頭に置く。
                  🚨 Signal は色と **形** を両方変えるので、白黒でも・色が見えない人にも読める。
                  🚨 新しい数を作らない。今日の空き(today.freeMin)＝右端に出ている数そのまま。
                     記録が無い(null)時は 0 にせず『分かりません』(点線の輪)にする。 */}
              <Avatar name={name} tone={wtone} size="w-8 h-8" showName={false} className="shrink-0" />
              <span className="shrink-0 whitespace-nowrap text-base font-black leading-tight text-slate-900">{name}</span>
              <Signal
                level={!today || today.freeMin == null ? 'unknown' : (today.freeMin > 0 ? 'warn' : 'ok')}
                size="w-3 h-3"
                className="shrink-0"
                title={!today || today.freeMin == null
                  ? '今日の空きの記録がありません'
                  : (today.freeMin > 0 ? `今日 空き ${fmtHours(today.freeMin)}` : '今日は空きがありません')}
              />
              {lack && lack.lacking.length ? (
                <span className="min-w-0 truncate text-2xs font-bold text-amber-700" title={lack.lacking.map((p) => `${p.title || p.processKey} ${p.lotCount}件`).join('・')}>
                  記録が無い工程 → {lack.lacking[0].title || lack.lacking[0].processKey} {lack.lacking[0].lotCount}件{lack.lacking.length > 1 ? ` ほか${lack.lacking.length - 1}工程` : ''}
                </span>
              ) : (lack ? <span className="min-w-0 truncate text-2xs text-slate-400">この期間の工程は全部に記録あり</span> : null)}
              {ps ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1 text-2xs font-bold text-amber-800" data-idle-pref={`${ps.mine}/${ps.total}`} title={templatePrefText(ps)}>
                  優先テンプレ {ps.total ? `${ps.mine}/${ps.total}件` : '0件'}
                  {ps.total ? <Bar value={ps.mine} max={ps.total} tone="idle" height="h-1.5" className="w-8" /> : null}
                </span>
              ) : null}
            </div>
            <div className="relative h-4">
              {cols.map((c) => (
                c.off
                  ? <div key={c.ms} className="absolute top-0 bottom-0 rounded" style={{ left: `${c.left}%`, width: `${c.width}%`, ...OFF_HATCH }} />
                  : <DayCell key={c.ms} col={c} cell={rowCells[c.ms]} />
              ))}
            </div>
            {/* 📐 2026-09-18 夜: 右側が3段(今日 空き／理由／負荷)で 1人 約65px。横1行にする。理由の字は左の札と title に在る。 */}
            <div className={`flex min-w-0 flex-row flex-wrap items-center justify-end gap-x-2 gap-y-0 whitespace-nowrap leading-none ${tone ? tone.text : 'text-slate-500'}`} data-idle-today={today && today.top ? today.top.kind : ''}>
              {today ? (
                <>
                  <span className="inline-flex items-baseline gap-1">
                    <span className="text-2xs font-bold">今日 空き</span>
                    <span className="text-sm font-black tabular-nums">{todayText(today)}</span>
                    {/* 🚨 いま この行に在る2つの数(空き freeMin / 働ける workMin)を長さに直すだけ。
                        文字を消しても「1日のうちどれだけ空いているか」が残る。数字は左の札のまま残す。
                        🚨 freeMin が 0 なら色0幅の棒(＝空き無し)、null なら点線の枠(＝記録が無い)。
                          0 と「読めていません」を同じ絵にしない。 */}
                    <Bar
                      value={today.freeMin == null && today.inferredZero ? 0 : today.freeMin}
                      max={today.workMin}
                      tone="idle"
                      height="h-1.5"
                      className="w-10 shrink-0 self-center"
                      title={`働ける ${fmtHours(today.workMin)} のうち 空き ${today.freeMin == null ? '記録なし' : fmtHours(today.freeMin)}`}
                    />
                  </span>
                  {/* 今日の理由の短い札(言葉は IDLE_KIND_LABEL そのまま)。記録が無い時の文は消さず短い札＋title へ。 */}
                  {today.top ? (
                    <span className="sr-only" title={IDLE_KIND_LABEL[today.top.kind]}>{IDLE_KIND_LABEL[today.top.kind]}</span>
                  ) : (today.inferredZero ? (
                    <span className="sr-only" title="ふさがっている（空きの記録なし）">ふさがっている（空きの記録なし）</span>
                  ) : null)}
                </>
              ) : <span className="text-2xs">今日は範囲の外</span>}
              {/* 📊 この期間の負荷(要る直接作業 ÷ 働ける直接作業)。数は workerLoadInWindow そのまま。100% を越えたら赤。 */}
              {ld ? (
                <span className="inline-flex items-baseline gap-1" data-idle-load={ld.ratio == null ? '' : Math.round(ld.ratio * 100)} title={workerLoadText(ld)}>
                  <span className="text-2xs font-bold" title="この期間 負荷"><span className="sr-only">この期間 </span>負荷</span>
                  <span className={`text-sm font-black tabular-nums ${ld.ratio != null && ld.ratio > 1 ? 'text-rose-600' : 'text-slate-800'}`}>{ld.ratio == null ? '—' : `${Math.round(ld.ratio * 100)}%`}</span>
                  <Bar value={ld.assignedMin} max={Math.max(ld.availableMin, ld.assignedMin, 1)} tone={ld.ratio != null && ld.ratio > 1 ? 'late' : 'plain'} height="h-1.5" className="w-10 shrink-0 self-center" />
                </span>
              ) : null}
            </div>
          </div>
        );
      })}

      {unresolved && unresolved.jobCount > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-slate-100 pt-1 text-2xs text-slate-600" data-idle-unresolved={unresolved.jobCount}>
          <span className="font-black text-slate-700">手が付かない仕事 {unresolved.lotCount.toLocaleString('ja-JP')}ロット（{unresolved.jobCount.toLocaleString('ja-JP')}工程）</span>
          {unresolved.rows.slice(0, 3).map((r) => (
            <span key={r.reason} className={`rounded border px-1 py-0.5 ${r.kind === 'skill' ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-300 bg-white'}`}>
              {r.reason} {r.lotCount}ロット
              {r.kind === 'skill' && r.processes.length ? `：${r.processes.slice(0, 2).map((p) => `${p.title || p.processKey} ${p.lotCount}`).join('・')}${r.processes.length > 2 ? ' …' : ''}` : ''}
            </span>
          ))}
          {skillRow ? <span className="text-amber-800">＝ 誰にも記録が無い工程（分かりません。やった記録が付けば消えます）</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export default IdleStrip;
