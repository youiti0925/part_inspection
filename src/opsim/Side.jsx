// =============================================================================
//  src/opsim/Side.jsx — 操業シミュレーション画面の「右側」2枚
// -----------------------------------------------------------------------------
//  WorkerList … 作業者を **全員** 常に出す（指示書 6.4 / PANEL_SPEC 5章）
//  LotDetail  … 選んだロットの「選んだ理由・候補・外れた理由・計算の元」（指示書 6.5）
//
//  🚨 この画面の決まり（守らないと人に実害が出る）
//   ・実績が無い＝「分かりません」。やれません、という意味では**ない**。
//     記録が1件しか無い事を「当てにならない」と書かない。1件＝やった記録がある。
//   ・理由の書いていない「待機」を1行も出さない（指示書6.4）。
//     理由が取れていない時は、それ自体を欠陥として赤で出す（黙って「待機」と書かない）。
//   ・数字は必ず丸める。式に数を直書きしない（定時・間接係数・人数は
//     normalized.calendarSpec と normalized.effectiveWorkerCount から作る）。
//   ・画面に出す言い回しは src/domain/dispatchWords.js の WORDS から引く。
//     ⚠ あちらは他の画面も読んでいる。**足すだけ**で、既存の鍵は書き換えていない。
//
//  計算は一切しない（src/domain/operationsSimulation/* が完成済み）。ここは表示だけ。
// =============================================================================
import React, { useMemo } from 'react';
import { Users, Clock, AlertTriangle, CheckCircle2, HelpCircle, Calculator, Info } from 'lucide-react';
import { WORDS } from '../domain/dispatchWords.js';
import { WORKER_STATE, IDLE_REASON, UNRESOLVED_REASON } from '../domain/operationsSimulation/simulate.js';
// 👤 人ごとの勤務の窓の1行(「村 09:30〜16:00 ／ 片山 直工 70%」)。文はcalendar.jsが作る。ここで数字を作らない。
import { describeWorkerProfiles } from '../domain/operationsSimulation/calendar.js';
// 🚨「次の仕事」の規則は nextJob.js ただ1本（盤の作業者の帯からも同じ物を読む）。
//    ここに2本目を書くと片方だけ直して食い違う（2026-08-21『片方だけ直すな』）。
import { nextJobOf } from './nextJob.js';
// 決まり12（2026-09-02）: 品目コードにテンプレ名を添える。名前の引き方は workerPlan.js の1本。
import { tplNameOf } from '../domain/workerPlan.js';
// 🚨🚨 2026-09-05 清水さん(根拠の札の写真)「いまは −33% の位置です」。
//   盤の横位置の言い方は Board.jsx の positionSentence **ただ1本**。
//   ここで2本目を書いていたので、盤は clamp して「0%」、右はそのまま「−33%」と、
//   同じ1つの位置について別の事を言っていた(2026-08-21『片方だけ直すな』)。
// 🚨🚨 さらに 2026-09-05(検証): 言い方だけ1本にして **数字は2本のまま** だった。
//   盤は つまみの時刻で出し直し、ここは記録(snapshot)の値をそのまま使っていたので、
//   同じ引き出しの中で「45% の所です」「41% の所です」と数字だけ食い違った。
//   生の値も posRatioAt ただ1本から取る(決まり「同じ数字を2つの計算から出さない」)。
import { positionSentence, posRatioAt } from './Board.jsx';

// ── 単位 ─────────────────────────────────────────────────────────────────────
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 🚨 0.30000000000000004 を画面に出さないための丸め。小数第1位まで。 */
const round1 = (n) => (isNum(n) ? Math.round(n * 10) / 10 : null);

/** ミリ秒 → 「42分」「1時間20分」。1分未満は「1分未満」。 */
const fmtShort = (ms) => {
  if (!isNum(ms)) return '—';
  const a = Math.max(0, ms);
  const m = Math.round(a / MIN);
  if (m <= 0) return '1分未満';
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}時間${r}分` : `${h}時間`;
};

/** ミリ秒 → 「2日と3時間」。長い物だけ日で言う。 */
const fmtSpan = (ms) => {
  if (!isNum(ms)) return '—';
  const a = Math.abs(ms);
  if (a < DAY) return fmtShort(a);
  // 🚨 2026-09-05 清水さん(根拠の札がバグ): 端数を四捨五入すると 23.6時間 → 24時間 になり「4日と24時間」と出ていた。24時間は次の日へ繰り上げる。
  let d = Math.floor(a / DAY);
  let h = Math.round((a % DAY) / HOUR);
  if (h >= 24) { d += 1; h = 0; }
  return h ? `${d}日と${h}時間` : `${d}日`;
};

/** ミリ秒 → 「12.5時間」 */
const fmtHours = (ms) => (isNum(ms) ? `${round1(Math.max(0, ms) / HOUR)}時間` : '—');

/** 時間(小数) → 「7時間20分」。定時の 7.3333… をそのまま出さないため。 */
const fmtHM = (hours) => {
  if (!isNum(hours)) return '—';
  const m = Math.round(hours * 60);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}分`;
  return r ? `${h}時間${r}分` : `${h}時間`;
};

const pad2 = (n) => String(n).padStart(2, '0');

const fmtDateTime = (ms) => {
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const fmtDate = (ms) => {
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

const fmtPct = (ratio) => (isNum(ratio) ? `${Math.round(ratio * 100)}%` : '—');

// ── 確かさの段（並べ替えにだけ使う。下の段の人を消さない） ────────────────────
const EVIDENCE_ORDER = { certified: 0, provisional_id: 1, provisional_name: 2, unknown: 3 };
const evidenceWord = (ev) => WORDS.OPSIM_EVIDENCE[ev] || WORDS.OPSIM_EVIDENCE.unknown;
const evidenceTone = (ev) => (
  ev === 'certified'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : ev === 'provisional_id'
      ? 'bg-cyan-50 text-cyan-700 border-cyan-200'
      : ev === 'provisional_name'
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-slate-100 text-slate-600 border-slate-300'
);

// ── 小さな部品（🚨 描画関数の中で定義しない。ここ＝モジュールの一番外に置く） ──
function Chip({ children, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600 border-slate-300',
    cyan: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  return (
    <span className={`inline-block rounded-md border px-1.5 py-0.5 fi-tap-text font-bold leading-tight ${tones[tone] || tones.slate}`}>
      {children}
    </span>
  );
}

function PanelHead({ icon, title, sub }) {
  return (
    <div className="flex items-start gap-2 border-b border-slate-200 px-3 py-2">
      <div className="mt-0.5 text-cyan-600">{icon}</div>
      <div className="min-w-0">
        <div className="text-sm font-black leading-tight text-slate-800">{title}</div>
        {sub ? <div className="mt-0.5 fi-tap-text leading-tight text-slate-500">{sub}</div> : null}
      </div>
    </div>
  );
}

function SectionTitle({ children, tone = 'slate' }) {
  const tones = { slate: 'text-slate-500', rose: 'text-rose-600', cyan: 'text-cyan-700' };
  return (
    <div className={`mt-3 mb-1 fi-tap-text font-black tracking-wide ${tones[tone] || tones.slate}`}>
      {children}
    </div>
  );
}

/** 「項目 : 値」の1行。値は折り返す（端で切れると根拠が読めない）。 */
function KV({ k, children }) {
  return (
    <div className="grid grid-cols-[6.5rem,1fr] gap-x-2 gap-y-0.5 border-b border-slate-100 py-1.5 last:border-b-0">
      <div className="fi-tap-text leading-snug text-slate-500">{k}</div>
      <div className="min-w-0 break-words fi-tap-text font-bold leading-snug text-slate-700">{children}</div>
    </div>
  );
}

// =============================================================================
//  1. WorkerList — 全作業者を常に出す
// =============================================================================

/**
 * 待機の理由を、画面の言い方へ直す。
 * 🚨 ここで空を返さない。理由が無いまま「待機」と出すのを防ぐのがこの関数の仕事。
 */
function waitingText(reason) {
  const r = (reason || '').trim();
  if (!r) return { text: WORDS.OPSIM_REASON_MISSING, broken: true };
  if (r === IDLE_REASON.NO_SKILL_MATCH) {
    return { text: `${WORDS.OPSIM_NO_JOB}（${WORDS.OPSIM_NO_RECORD_HERE}）`, broken: false };
  }
  return { text: `${WORDS.OPSIM_NO_JOB}（${r}）`, broken: false };
}

/** 休み・他の作業・勤務時間外は「働ける時間ではない」＝灰色にする側。 */
const isAwayLike = (w) => (
  w.state === WORKER_STATE.AWAY
  || w.reason === IDLE_REASON.OFF
  || w.reason === IDLE_REASON.OUT_OF_HOURS
  || w.reason === IDLE_REASON.OTHER_WORK
  || w.reason === IDLE_REASON.ROSTER_UNKNOWN
  || w.reason === IDLE_REASON.SUPPORT_PRODUCT   // 👥 応援(2026-09-16)
  || w.reason === IDLE_REASON.SUPPORT_FINAL
);

function WorkerRow({ w, assignments = null, tplName = '' }) {
  const working = w.state === WORKER_STATE.WORKING;
  const away = !working && isAwayLike(w);
  const wait = !working && !away ? waitingText(w.reason) : null;

  const box = working
    ? 'border-cyan-200 bg-white'
    : away
      ? 'border-slate-200 bg-slate-50 opacity-60'
      : wait && wait.broken
        ? 'border-rose-300 bg-rose-50'
        : 'border-amber-200 bg-amber-50/60';

  const dot = working ? 'bg-cyan-500' : away ? 'bg-slate-300' : 'bg-amber-400';

  const unit = isNum(w.unitIndex) ? ` #${w.unitIndex + 1}` : '';

  return (
    <div className={`rounded-xl border px-2.5 py-2 ${box}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className={`shrink-0 text-xs font-black ${away ? 'text-slate-500' : 'text-slate-800'}`}>{w.name}</span>
        {working ? (
          <span className="ml-auto shrink-0 fi-tap-text font-black text-cyan-700">
            あと{fmtShort(w.remainingMs)}
          </span>
        ) : null}
      </div>

      {working ? (
        <div className="mt-1 fi-tap-text leading-snug text-slate-600">
          <span className="font-bold text-slate-700">{w.model || '品目コードの記録がありません'}{unit}</span>
          {/* 決まり12: 品目コード｜テンプレ。テンプレで作業内容が変わる。 */}
          <span className="font-bold text-slate-500">｜{tplName || 'テンプレ名なし'}</span>
          {' '}
          <span>{w.stepTitle || '工程名の記録がありません'}</span>
          <span> を作業中</span>
          {w.withWorker ? <span className="text-cyan-700">（{w.withWorker}さんと2人で）</span> : null}
        </div>
      ) : null}

      {working && isNum(w.endMs) ? (
        <div className="mt-0.5 fi-tap-text leading-snug text-slate-400">終わる見込み {fmtDateTime(w.endMs)}</div>
      ) : null}

      {/* 🚨 T024 即時再割当: 「終わった時刻」と「次に始める時刻」の差を **そのまま** 出す。
          差が0分でない時は、その分だけ手が空いている（＝すぐ次へ渡せていない）という事実。
          assignments が無い時は何も出さない（0分と書くと測っていないのに測ったように見える）。 */}
      {(() => {
        if (!working || !isNum(w.endMs)) return null;
        const nx = nextJobOf(assignments, w.name, w.endMs);
        if (!nx) {
          return Array.isArray(assignments) ? (
            <div className="mt-0.5 fi-tap-text leading-snug text-slate-400">この後の予定はまだありません</div>
          ) : null;
        }
        const gap = Math.max(0, Number(nx.gapMs) || 0);
        return (
          <div className="mt-0.5 fi-tap-text leading-snug text-slate-500">
            次は <b className="text-slate-700">{fmtDateTime(nx.startMs)}</b> から
            <span className={gap === 0 ? 'text-emerald-700 font-bold' : 'text-amber-700 font-bold'}>
              {gap === 0 ? '（間を空けずにすぐ）' : `（${fmtShort(gap)} 空きます）`}
            </span>
          </div>
        );
      })()}

      {!working && away ? (
        <div className="mt-1 fi-tap-text leading-snug text-slate-500">{w.reason || IDLE_REASON.OFF}</div>
      ) : null}

      {!working && !away && wait ? (
        <div className={`mt-1 fi-tap-text leading-snug ${wait.broken ? 'font-bold text-rose-700' : 'text-amber-800'}`}>
          {wait.text}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 作業者の一覧（全員・常時）。
 *
 * @param {object}  props
 * @param {{atMs:number, lots:Array, workers:Array}} props.snapshot 盤面1枚（simulate の snapshots[i]）
 * @param {object}  props.calendarSpec   normalized.calendarSpec（定時・間接係数・休憩）
 * @param {number}  props.effectiveWorkerCount normalized.effectiveWorkerCount（この期間に実際に居る人数）
 */
export function WorkerList({ snapshot, calendarSpec, effectiveWorkerCount, assignments = null, templatesById = null }) {
  // ⚠ ここで `?? []` を毎回作ると useMemo の依存が毎描画で変わる（react-hooks が出す警告）。
  //   配列を作り直すのは useMemo の中だけにして、依存は snapshot ただ1つにする。
  const workers = useMemo(() => (Array.isArray(snapshot?.workers) ? snapshot.workers : []), [snapshot]);
  // 決まり12: 人の札にも 品目コード｜テンプレ。snapshot.workers は lotId しか持たないので snapshot.lots(templateId あり)から引く。
  const tplByLotId = useMemo(() => {
    const m = new Map();
    (Array.isArray(snapshot?.lots) ? snapshot.lots : []).forEach((l) => {
      if (l && l.lotId) m.set(String(l.lotId), tplNameOf(templatesById, l.templateId));
    });
    return m;
  }, [snapshot, templatesById]);

  const tally = useMemo(() => {
    const lots = Array.isArray(snapshot?.lots) ? snapshot.lots : [];
    let working = 0;
    let away = 0;
    let waiting = 0;
    workers.forEach((w) => {
      if (w.state === WORKER_STATE.WORKING) working += 1;
      else if (isAwayLike(w)) away += 1;
      else waiting += 1;
    });
    // 🚨 「誰も手を付けていない仕事」＝ この時刻に人が1人も当たっていない、残りのある仕事。
    //   （工程ごとの担当可否は eligibility が持っている。ここは盤面から見える事だけを言う）
    let unheld = 0;
    let unheldMs = 0;
    lots.forEach((l) => {
      const rem = isNum(l.remainingMs) ? l.remainingMs : 0;
      if (rem <= 0) return;
      if (Array.isArray(l.workers) && l.workers.length > 0) return;
      unheld += 1;
      unheldMs += rem;
    });
    return { working, away, waiting, unheld, unheldMs };
  }, [snapshot, workers]);

  // 1日に使える時間。🚨 数を直書きしない。設定と人数から作る。
  const capacity = useMemo(() => {
    const daily = Number(calendarSpec?.dailyHours);
    const factor = Number(calendarSpec?.indirectFactor);
    const people = Number(effectiveWorkerCount);
    if (!Number.isFinite(daily) || !Number.isFinite(people)) return null;
    const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
    return {
      perDay: round1((daily / f) * people),
      hm: fmtHM(daily),
      factor: round1(f),
      people,
    };
  }, [calendarSpec, effectiveWorkerCount]);

  // 👤 個人設定(時短・直工比率)が効いている人の1行。登録が無ければ出さない(今までと同じ画面)。
  //   🚨 数字は calendarSpec.workerProfiles(normalizeInput が名簿の分だけ写した物)の写しだけ。ここで計算しない。
  const profileNote = useMemo(() => describeWorkerProfiles(calendarSpec?.workerProfiles), [calendarSpec]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <PanelHead
        icon={<Users size={16} />}
        title="作業者（全員）"
        sub={snapshot ? `${fmtDateTime(snapshot.atMs)} 時点` : '盤面がまだありません'}
      />

      <div className="px-3 py-2">
        <div className="mb-2 flex flex-wrap gap-1.5">
          <Chip tone="cyan">作業中 {tally.working}人</Chip>
          <Chip tone="amber">手が空いています {tally.waiting}人</Chip>
          <Chip tone="slate">休み・時間外 {tally.away}人</Chip>
        </div>

        {workers.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-3 fi-tap-text text-slate-500">
            作業者の記録がまだありません。計算を1回走らせてください。
          </div>
        ) : (
          <div className="space-y-1.5">
            {workers.map((w) => (
              <WorkerRow assignments={assignments} key={w.name} w={w} tplName={w.lotId ? (tplByLotId.get(String(w.lotId)) || '') : ''} />
            ))}
          </div>
        )}

        {tally.unheld > 0 ? (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 fi-tap-text leading-snug text-amber-800">
            {WORDS.OPSIM_UNHELD(tally.unheld, round1(tally.unheldMs / HOUR))}
            {tally.waiting > 0 ? <span className="block mt-1">{WORDS.OPSIM_IDLE_WITH_WORK}</span> : null}
          </div>
        ) : null}

        {capacity ? (
          <div className="mt-2 flex items-start gap-1.5 border-t border-slate-100 pt-2 fi-tap-text leading-snug text-slate-500">
            <Calculator size={13} className="mt-0.5 shrink-0 text-slate-400" />
            <span>{WORDS.OPSIM_CAPACITY(capacity.perDay, capacity.hm, capacity.factor, capacity.people)}</span>
          </div>
        ) : null}

        {profileNote ? (
          <div
            className="mt-1 flex items-start gap-1.5 fi-tap-text leading-snug text-slate-500"
            data-opsim-worker-profiles={profileNote}
            title="マスタ設定 → 作業者マスタ の「個人ごとの勤務」で登録した物です。時短の人は本人の窓、直工比率の人は窓の終わりを縮めて数えています。"
          >
            <Clock size={13} className="mt-0.5 shrink-0 text-slate-400" />
            <span>個人設定: {profileNote}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// =============================================================================
//  2. LotDetail — 選んだロットの根拠
// =============================================================================

/** そのロットの見立て。🚨 「判定できません」を「間に合わない」に混ぜない。 */
function verdictOf(lotResult, snapshotLot) {
  if (!lotResult) {
    return { tone: 'slate', head: 'この仕事の計算結果がまだありません', lines: ['計算を走らせると、ここに理由が出ます。'] };
  }
  if (lotResult.judgeable === false) {
    return {
      tone: 'amber',
      head: '間に合うかどうか、判定できません',
      lines: [
        lotResult.unknownReason || '判定に要る記録が足りません。',
        '🚨 これは「間に合わない」ではありません。入力が足りないので、まだ言えないという意味です。',
      ],
    };
  }
  if (lotResult.blocked) {
    return {
      tone: 'rose',
      head: '手が付けられないまま残ります',
      lines: [
        lotResult.blocked,
        lotResult.alreadyPastDue ? '納期の日は、もう過ぎています。' : '',
      ].filter(Boolean),
    };
  }
  if (lotResult.late) {
    const over = isNum(lotResult.lateMs) ? `納期線を ${fmtSpan(lotResult.lateMs)} 越えます。` : '納期線を越えます。';
    return {
      tone: 'rose',
      head: lotResult.alreadyPastDue ? '予定日はもう過ぎていて、この期間でも終わりません' : '納期線を越えます',
      lines: [
        // 🚨 すでに予定日を過ぎている物に、その事を書かないと
        //   「これから遅れる」と読めてしまう。今日の事実と見込みは分けて書く。
        lotResult.alreadyPastDue ? '予定日は、もう過ぎています（今日の事実）。' : '',
        over,
        isNum(lotResult.finishMs)
          ? `終わる見込みは ${fmtDateTime(lotResult.finishMs)}、納期線は ${fmtDateTime(lotResult.dueLineMs)} です。`
          : 'この期間の中では終わりませんでした。',
      ].filter(Boolean),
    };
  }
  if (lotResult.alreadyPastDue) {
    return {
      tone: 'amber',
      head: '納期の日は過ぎていますが、この期間の中で終わります',
      lines: [isNum(lotResult.finishMs) ? `終わる見込みは ${fmtDateTime(lotResult.finishMs)} です。` : ''],
    };
  }
  const rem = isNum(snapshotLot?.remainingMs) ? `残り ${fmtHours(snapshotLot.remainingMs)}。` : '';
  return {
    tone: 'emerald',
    head: '納期線までに終わる見込みです',
    lines: [
      `${rem}${isNum(lotResult.finishMs) ? `終わる見込みは ${fmtDateTime(lotResult.finishMs)} です。` : 'この期間の中で終わります。'}`,
    ].filter(Boolean),
  };
}

const VERDICT_BOX = {
  rose: 'border-rose-300 bg-rose-50',
  amber: 'border-amber-300 bg-amber-50',
  emerald: 'border-emerald-300 bg-emerald-50',
  slate: 'border-slate-200 bg-slate-50',
};
const VERDICT_HEAD = {
  rose: 'text-rose-700',
  amber: 'text-amber-800',
  emerald: 'text-emerald-800',
  slate: 'text-slate-700',
};

function CandidateRow({ c, totalSteps }) {
  return (
    <div className="flex items-start gap-2 border-b border-slate-100 py-1 last:border-b-0">
      <span className="w-16 shrink-0 fi-tap-text font-black text-slate-800">{c.name}</span>
      <span className="shrink-0 fi-tap-text text-slate-500">{c.steps}/{totalSteps}工程</span>
      <span className={`ml-auto rounded-md border px-1.5 py-0.5 fi-tap-text font-bold leading-tight ${evidenceTone(c.evidence)}`}>
        {evidenceWord(c.evidence)}{c.assumed ? '（仮の設定）' : ''}
      </span>
    </div>
  );
}

function CountRow({ label, count, unit, tone = 'slate' }) {
  const tones = { slate: 'text-slate-600', rose: 'text-rose-700', amber: 'text-amber-800' };
  return (
    <div className="flex items-start gap-2 border-b border-slate-100 py-1 fi-tap-text leading-snug last:border-b-0">
      <span className={`min-w-0 flex-1 break-words ${tones[tone] || tones.slate}`}>{label}</span>
      <span className="shrink-0 font-bold text-slate-500">{count}{unit}</span>
    </div>
  );
}

/* ===========================================================================
 * 「なぜ遅れるか」1行 ただ1本（🚨 純関数。画面の中に書かない）
 * ---------------------------------------------------------------------------
 * 🚨 2026-09-05 清水さん(根拠の札の写真)「残作業 0.6時間・進み 0% なのに 5日遅れ」。
 *   **なぜ** かが1行も無かった。判定の箱のすぐ下に1行だけ出す。
 * 🚨 2026-09-05(検証で出た穴・3つ):
 *   ① 判定の箱(verdictOf)が既に lotResult.blocked を出しているのに、その下でもう一度
 *      同じ文を繰り返していた。手つかずのロットを開くと同じ文が上下に2回並んだ。
 *      → 箱が既に言っている文は **落とす**(boxLines と突き合わせる)。
 *   ② blocked が「やった記録も、スキルの登録も見当たりません」系の時、
 *      その下に「頼める記録が、まだ1人も見当たりません。」を足すと同じ意味が2回。
 *      → 技能・候補まわりの理由の時は、頼める人の1行を足さない。
 *      ⚠ 文字を直書きで比べない。simulate.js の定数(UNRESOLVED_REASON/IDLE_REASON)と比べる。
 *   ③ 見張りが この中身を **一度も走らせていなかった**(字を見ているだけだった)。
 *      → 部品の外の純関数にして、見張りが本物を呼べるようにした。
 * 🚨 材料は **計算が既に返している物だけ**。ここで新しい集計(足し算・数え直し)を書かない
 *   (決まり「同じ数字を2つの計算から出さない」)。
 * ⚠ 「その人の前に N件（合計 N時間）」は、いま lotResults にも snapshot にも入っていない
 *   (lotResults が返すのは lotId / finishMs / dueLineMs / lateMs / late / alreadyPastDue /
 *    judgeable / unknownReason / blocked の9つだけ。実コードで確認)。**無い数は書かない**。
 * ⚠ causeTiers は **この期間ぜんたいの主な原因** であって、このロット1件の理由ではない。
 *   だから断言せず、必ず範囲(「この期間ぜんたいの」)を書き添えて最後の手として出す。
 *
 * @param {object} input { lotResult, boxLines, people, equipment, stuck, causeTiers }
 * @returns {string|null} 画面にそのまま出す1行。遅れてもいない時は null
 */
// eslint-disable-next-line react-refresh/only-export-components -- 部品ではなく文を作る純関数。見張りがこれを直に走らせる(字だけ見る形へ戻さない)
export function lateWhySentence(input) {
  const o = input || {};
  const lotResult = o.lotResult || null;
  if (!lotResult) return null;
  // 🚨🚨 2026-09-05(検証で出た穴): blocked は「判定できません」の時も truthy のまま
  //   返ってくる(simulate.js 1423行。DURATION_UNKNOWN / ARRIVAL_UNKNOWN / 納期が無い時)。
  //   その時 judgeable=false・late=false で、判定の箱は琥珀の
  //   「間に合うかどうか、判定できません」「これは『間に合わない』ではありません」を出す。
  //   ここで isLate を blocked だけで見ていたので、そのすぐ下に赤枠で
  //   「理由: … 頼める記録が ◯◯さん だけです。」が出て、**入力が足りないだけのロットを
  //   能力不足で遅れる物として見せていた**(2026-08-22『「判定できない」を混ぜるな』)。
  //   → 判定できない物には1行も出さない。
  const isLate = lotResult.judgeable !== false && (lotResult.late === true || !!lotResult.blocked);
  if (!isLate) return null;

  const people = Array.isArray(o.people) ? o.people : [];
  const equipment = Array.isArray(o.equipment) ? o.equipment : [];
  const stuck = Array.isArray(o.stuck) ? o.stuck : [];
  // 判定の箱が既に言っている文（同じ事を2回言わない）。句点の有無は無視して比べる。
  const trim = (t) => String(t == null ? '' : t).trim().replace(/。+$/, '');
  const said = (Array.isArray(o.boxLines) ? o.boxLines : []).map(trim).filter(Boolean);
  const alreadySaid = (t) => said.some((s) => s === trim(t));

  // 技能・候補まわりの理由。ここに当たる時は「頼める人」の1行を足さない（同じ意味の重複）。
  const skillReasons = [
    UNRESOLVED_REASON.NO_CANDIDATE,
    UNRESOLVED_REASON.ALL_CANDIDATES_AWAY,
    UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_PRODUCT,
    UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_FINAL,
    IDLE_REASON.NO_SKILL_MATCH,
  ].map(trim);
  const blockedIsSkill = !!lotResult.blocked && skillReasons.includes(trim(lotResult.blocked));

  const parts = [];
  // 🚨 lotResult.blocked は判定の箱が出している。ここで push すると2回言う事になる。
  if (!blockedIsSkill) {
    // 🚨🚨 2026-09-05(検証で出た穴): people は skills.people ＝
    //   **このロットの工程を通した候補の合併** で、「この工程」1つぶんではない。
    //   「この工程を頼める記録が ◯◯さん だけです」と書くと、元データが言っていない事
    //   (工程1つの話)を言う事になる(2026-07-10『元データに無い値を推測で埋めるな』)。
    //   0人の枝と1人の枝で範囲の言い方もそろえる。
    if (people.length === 0) {
      parts.push('このロットの工程を通して、頼める記録が まだ1人も見当たりません。');
    } else if (people.length === 1) {
      parts.push(`このロットの工程を通して、頼める記録が ${people[0].name}さん だけです。`);
    }
  }
  const eq = equipment[0];
  if (eq) parts.push(`設備の順番待ちが ${eq.n}件あります（${eq.reason}）。`);
  const st = stuck[0];
  if (st) parts.push(`手が付かなかった作業が ${st.n}件あります（${st.reason}）。`);
  if (!parts.length && lotResult.unknownReason) parts.push(`${String(lotResult.unknownReason)}。`);

  const kept = parts.filter((p) => !alreadySaid(p));
  if (kept.length) return `理由: ${kept.join(' ')}`;

  // 最後の手。このロット1件の理由は返ってきていないので、範囲を必ず書く。
  const primary = (o.causeTiers && o.causeTiers.primary) ? o.causeTiers.primary : null;
  if (primary && primary.label) {
    const detail = primary.detail ? `（${String(primary.detail)}）` : '';
    return `このロット1件の理由は計算から返ってきていません。この期間ぜんたいの主な原因は ${String(primary.label)}${detail} です。`;
  }
  return '理由は計算から返ってきていません';
}

/**
 * 選んだロットの根拠。
 *
 * @param {object} props
 * @param {object} props.lot         normalized.lots の1件（steps / quantity / 納期 / 到着）
 * @param {object} props.lotResult   sim.lotResults の1件（late / judgeable / blocked …）
 * @param {object} props.snapshotLot 今の盤面のそのロット（残り時間・進み具合・横位置）
 * @param {object} props.eligibility buildEligibility の戻り値（eligibleFor を使う）
 * @param {Array}  props.audit       sim.audit（このロットぶんに絞って読む）
 * @param {Array}  props.unresolved  sim.unresolved（このロットぶんに絞って読む）
 * @param {object} props.normalized  normalizeInput の戻り値（calendarSpec / fieldMap / diagnostics）
 * @param {number} props.nowMs       つまみの時刻(targetMs)。横位置を盤と同じ式で出し直す。
 *   🚨 渡さないと、盤は つまみの時刻・ここは記録の時刻 で、同じ文なのに数字だけ食い違う。
 *   ⚠ 合流の後に Panel の <LotDetail> へ nowMs={targetMs} を1行足す(区画Eは Panel を触らない)。
 * @param {object} props.causeTiers  result.causeTiers（**この期間ぜんたい**の主な原因）。
 *   ⚠ ロット1件の理由ではないので、出す時は必ず範囲を書き添える。同じく Panel 側で1行渡す。
 */
export function LotDetail({
  lot, lotResult, snapshotLot, eligibility, audit, unresolved, normalized,
  templatesById = null, nowMs = null, causeTiers = null,
}) {
  const lotId = lot?.lotId || '';

  // ── 工程ごとの「頼める人」──────────────────────────────────────────────
  const skills = useMemo(() => {
    const steps = Array.isArray(lot?.steps) ? lot.steps : [];
    const byName = new Map();
    const noRecord = [];
    let known = 0;
    let unknown = 0;
    steps.forEach((s) => {
      if (isNum(s.targetSec) && s.targetSec > 0) known += 1; else unknown += 1;
      const list = (eligibility && typeof eligibility.eligibleFor === 'function')
        ? eligibility.eligibleFor(s.processKey)
        : [];
      if (!list.length) {
        noRecord.push(s.title || '(工程名なし)');
        return;
      }
      list.forEach((c) => {
        const cur = byName.get(c.name);
        if (!cur) {
          byName.set(c.name, { name: c.name, steps: 1, evidence: c.evidence, assumed: !!c.assumed });
          return;
        }
        cur.steps += 1;
        if ((EVIDENCE_ORDER[c.evidence] ?? 9) < (EVIDENCE_ORDER[cur.evidence] ?? 9)) cur.evidence = c.evidence;
        if (c.assumed) cur.assumed = true;
      });
    });
    const people = [...byName.values()].sort((a, b) => (
      ((EVIDENCE_ORDER[a.evidence] ?? 9) - (EVIDENCE_ORDER[b.evidence] ?? 9))
      || (b.steps - a.steps)
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    ));
    // 同じ工程名が何度も出るので、名前でまとめて件数にする
    const noRecordCount = new Map();
    noRecord.forEach((t) => noRecordCount.set(t, (noRecordCount.get(t) || 0) + 1));
    return {
      people,
      stepCount: steps.length,
      known,
      unknown,
      noRecord: [...noRecordCount.entries()]
        .map(([title, n]) => ({ title, n }))
        .sort((a, b) => (b.n - a.n) || (a.title < b.title ? -1 : 1)),
    };
  }, [lot, eligibility]);

  // ── 配置の記録（このロットぶん）──────────────────────────────────────────
  const picked = useMemo(() => {
    const rows = (Array.isArray(audit) ? audit : []).filter((a) => a && a.lotId === lotId);
    const chosen = new Map();     // 「誰が・なぜ選ばれたか」
    const dropped = new Map();    // 「誰が・なぜ外れたか」
    const equipment = new Map();  // 設備の順番待ち
    rows.forEach((a) => {
      if (a.kind === 'wait-equipment') {
        const key = a.reason || IDLE_REASON.EQUIPMENT;
        equipment.set(key, (equipment.get(key) || 0) + 1);
        return;
      }
      if (a.kind !== 'assign') return;
      if (a.worker) {
        const key = `${a.worker}|${a.reason || ''}`;
        const cur = chosen.get(key) || { name: a.worker, reason: a.reason || '', evidence: a.evidence, n: 0 };
        cur.n += 1;
        chosen.set(key, cur);
      }
      (Array.isArray(a.candidates) ? a.candidates : []).forEach((c) => {
        if (!c || !c.name) return;
        if (c.name === a.worker || c.name === a.partner) return;
        const key = `${c.name}|${c.note || ''}`;
        const cur = dropped.get(key) || { name: c.name, note: c.note || '', evidence: c.evidence, n: 0 };
        cur.n += 1;
        dropped.set(key, cur);
      });
    });
    const bySize = (a, b) => (b.n - a.n) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return {
      assignCount: rows.filter((a) => a.kind === 'assign').length,
      chosen: [...chosen.values()].sort(bySize),
      dropped: [...dropped.values()].sort(bySize),
      equipment: [...equipment.entries()].map(([reason, n]) => ({ reason, n })),
    };
  }, [audit, lotId]);

  // ── 手が付かなかった作業（このロットぶん）────────────────────────────────
  const stuck = useMemo(() => {
    const head = `${lotId}#`;
    const m = new Map();
    (Array.isArray(unresolved) ? unresolved : []).forEach((u) => {
      if (!u || typeof u.jobId !== 'string') return;
      if (lotId && !u.jobId.startsWith(head)) return;
      const r = u.reason || '理由が記録されていません';
      m.set(r, (m.get(r) || 0) + 1);
    });
    return [...m.entries()]
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => (b.n - a.n) || (a.reason < b.reason ? -1 : 1));
  }, [unresolved, lotId]);

  // ── 計算の元（🚨 数を直書きしない。設定から作る）────────────────────────
  const trace = useMemo(() => {
    const spec = normalized?.calendarSpec || {};
    const daily = Number(spec.dailyHours);
    const factorRaw = Number(spec.indirectFactor);
    const factor = Number.isFinite(factorRaw) && factorRaw > 0 ? factorRaw : 1;
    const people = Number(normalized?.effectiveWorkerCount);
    const perDay = (Number.isFinite(daily) && Number.isFinite(people)) ? round1((daily / factor) * people) : null;
    const breaks = Array.isArray(spec.breaks) ? spec.breaks : [];
    return {
      perDay,
      hm: Number.isFinite(daily) ? fmtHM(daily) : '—',
      factor: round1(factor),
      people: Number.isFinite(people) ? people : null,
      dayStart: spec.dayStartHHMM || '—',
      breakText: breaks.length ? breaks.map((b) => `${b.start}〜${b.end}`).join('・') : '休憩の設定がありません',
      workdays: Array.isArray(spec.workdays) ? spec.workdays.map((d) => '日月火水木金土'[d] || '?').join('') : '—',
      dueField: normalized?.fieldMap?.due || '—',
      arrivalField: normalized?.fieldMap?.arrival || '—',
      reads: Number(normalized?.diagnostics?.reads) || 0,
      writes: Number(normalized?.diagnostics?.writes) || 0,
    };
  }, [normalized]);

  // ── 「なぜ遅れるか」1行 ────────────────────────────────────────────────
  // 🚨 中身は lateWhySentence(この上の純関数)ただ1本。ここは材料を渡すだけ。
  //   判定の箱(verdictOf)が既に言っている文は、あちらの中で落とす(2回言わない)。
  // 🚨 hooks はガード(下の return)より上。
  const lateWhy = useMemo(() => lateWhySentence({
    lotResult,
    boxLines: verdictOf(lotResult, snapshotLot).lines,
    people: skills.people,
    equipment: picked.equipment,
    stuck,
    causeTiers,
  }), [lotResult, snapshotLot, skills, picked, stuck, causeTiers]);

  if (!lot) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <PanelHead icon={<Info size={16} />} title="選んだ仕事の根拠" sub="盤面のカードを押してください" />
        <div className="px-3 py-6 fi-tap-text leading-relaxed text-slate-500">
          カードを押すと、ここに<b className="text-slate-700">なぜこの状態か・頼める人・外れた理由・計算の元</b>が出ます。
        </div>
      </div>
    );
  }

  const v = verdictOf(lotResult, snapshotLot);
  const dueLineMs = isNum(lot.dueLineMs) ? lot.dueLineMs : (isNum(lotResult?.dueLineMs) ? lotResult.dueLineMs : null);
  const atMs = isNum(snapshotLot?.atMs) ? snapshotLot.atMs : Number(normalized?.now);
  const toDue = (isNum(dueLineMs) && isNum(atMs)) ? dueLineMs - atMs : null;
  const spanMs = (isNum(dueLineMs) && isNum(lot.arrivalMs)) ? dueLineMs - lot.arrivalMs : null;
  // 🚨 横位置の生の値は posRatioAt(Board.jsx)ただ1本。盤と同じ式・同じ時刻で出す。
  //   つまみの時刻(nowMs)が渡っていない時だけ、記録(snapshot)の値をそのまま使う。
  const posRaw = posRatioAt({
    arrivalMs: lot.arrivalMs,
    dueLineMs,
    snapRatio: snapshotLot?.duePosRatio,
    nowMs,
  });
  const qty = Math.max(1, Math.trunc(Number(lot.quantity)) || 1);

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <PanelHead
        icon={<HelpCircle size={16} />}
        title={`${lot.model || '品目コードの記録がありません'}｜${tplNameOf(templatesById, lot.templateId) || 'テンプレ名なし'} の根拠`}
        sub={`${qty}台 ／ 注番 ${lot.orderNo || '—'} ／ 工程 ${skills.stepCount}件`}
      />

      <div className="px-3 py-2">
        <div className={`rounded-xl border px-2.5 py-2 ${VERDICT_BOX[v.tone]}`}>
          <div className={`flex items-center gap-1.5 text-xs font-black leading-tight ${VERDICT_HEAD[v.tone]}`}>
            {v.tone === 'emerald' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            <span>{v.head}</span>
          </div>
          {v.lines.map((t) => (
            <div key={t} className="mt-1 fi-tap-text leading-snug text-slate-600">{t}</div>
          ))}
        </div>
        {/* 🚨 遅れの色は赤の濃淡(決まり27・橙は空き専用)。 */}
        {lateWhy ? (
          <div
            data-side-late-why="1"
            className="mt-1.5 rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 fi-tap-text leading-snug text-slate-700"
          >
            {lateWhy}
          </div>
        ) : null}

        <SectionTitle>いまの状態</SectionTitle>
        <div>
          <KV k="納期まで">
            {isNum(dueLineMs)
              ? <>{fmtDateTime(dueLineMs)}<span className="ml-1 font-normal text-slate-500">
                {isNum(toDue) ? (toDue >= 0 ? `（あと ${fmtSpan(toDue)}）` : `（${fmtSpan(toDue)} 過ぎています）`) : ''}
              </span></>
              : <span className="text-amber-800">納期の記録がありません</span>}
          </KV>
          <KV k="到着">
            {/* 🚨🚨 2026-09-04 清水さん「納期の2日前に着くって話なのに 添付で見たら全然違う」。
                「仮」には2通りある。1つの文にまとめると、この1件についても嘘になる。
                判定は normalizeInput の arrivalAssumedKind そのまま（画面で日付から数え直さない）。 */}
            {lot.arrivalKind === 'assumed' ? (
              <span
                data-testid="side-assumed-chip"
                data-assumed-kind={lot.arrivalAssumedKind || 'unknown'}
                className={`mr-1 inline-block rounded border px-1 py-0.5 text-2xs font-bold leading-none ${
                  lot.arrivalAssumedKind === 'clampedToNow'
                    ? 'border-red-500 bg-red-50 text-red-800'
                    : 'border-amber-400 bg-amber-50 text-amber-800'}`}
              >
                {lot.arrivalAssumedKind === 'clampedToNow'
                  ? '仮（過ぎ→基準時刻）'
                  : (lot.arrivalAssumedKind === 'beforeDue' ? '仮（納期の前）' : '仮')}
              </span>
            ) : null}
            {fmtDateTime(lot.arrivalMs)}
            <span className="ml-1 font-normal text-slate-500">
              （{lot.arrivalKind === 'assumed'
                ? (lot.arrivalAssumedKind === 'clampedToNow'
                  ? `入荷日が無いので納期より前に置こうとしましたが、その日（${fmtDateTime(lot.arrivalAssumedWantMs)}）はもう過ぎているので、計算の基準時刻に置いた日。納期が来ているのに入荷の登録がありません`
                  : (lot.arrivalAssumedKind === 'beforeDue'
                    ? `入荷日が無いので、納期より前（${fmtDateTime(lot.arrivalAssumedWantMs)}）に仮に置いた日。本当の入荷日を入力すると、そちらで計算し直します`
                    : '入荷日が無いので仮に置いた日（どちらの置き方かは計算から返ってきていません）'))
                : lot.arrivalKind === 'derived' ? '注文の記録から出した日' : '記録された日'}）
            </span>
          </KV>
          <KV k="残作業">
            {isNum(snapshotLot?.remainingMs)
              ? <>
                <span>残り {fmtHours(snapshotLot.remainingMs)}</span>
                <span className="ml-1 font-normal text-slate-500">
                  ／ 全体 {fmtHours(snapshotLot.totalMs)}（{fmtPct(snapshotLot.doneRatio)} 済み）
                </span>
              </>
              : <span className="text-slate-500">残りの記録がありません</span>}
            {snapshotLot && snapshotLot.remainingKnown === false ? (
              <div className="mt-0.5 font-normal text-amber-800">
                目標時間が入っていない工程が混ざっています。この残り時間は、その分だけ短く出ています。
              </div>
            ) : null}
          </KV>
          <KV k="いま担当">
            {Array.isArray(snapshotLot?.workers) && snapshotLot.workers.length
              ? snapshotLot.workers.join('・')
              : <span className="text-slate-500">{WORDS.OPSIM_PICK_NONE}</span>}
          </KV>
        </div>

        <SectionTitle tone="cyan">頼める人（この仕事の工程ぜんぶを見て）</SectionTitle>
        {skills.people.length ? (
          <div>
            {skills.people.map((c) => <CandidateRow key={c.name} c={c} totalSteps={skills.stepCount} />)}
          </div>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 fi-tap-text leading-snug text-slate-600">
            {WORDS.OPSIM_EVIDENCE.unknown}
          </div>
        )}
        {skills.noRecord.length ? (
          <div className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5">
            <div className="fi-tap-text font-bold leading-snug text-amber-800">
              まだ記録が見当たらない工程が {skills.noRecord.length}種あります
            </div>
            {skills.noRecord.slice(0, 6).map((s) => (
              <div key={s.title} className="fi-tap-text leading-snug text-amber-800">・{s.title}</div>
            ))}
            {skills.noRecord.length > 6 ? (
              <div className="fi-tap-text leading-snug text-amber-700">ほか {skills.noRecord.length - 6}種</div>
            ) : null}
            <div className="mt-1 fi-tap-text leading-snug text-slate-600">{WORDS.OPSIM_NO_RECORD_NOTE}</div>
          </div>
        ) : null}

        <SectionTitle>選ばれた理由</SectionTitle>
        {picked.chosen.length ? (
          <div>
            {picked.chosen.map((c) => (
              <CountRow key={`${c.name}|${c.reason}`} label={`${c.name}さん … ${c.reason || '理由の記録がありません'}`} count={c.n} unit="回" />
            ))}
          </div>
        ) : (
          <div className="fi-tap-text leading-snug text-slate-500">{WORDS.OPSIM_PICK_NONE}</div>
        )}

        <SectionTitle tone="rose">外れた理由</SectionTitle>
        {picked.dropped.length || stuck.length || picked.equipment.length ? (
          <div>
            {picked.dropped.map((c) => (
              <CountRow key={`${c.name}|${c.note}`} label={`${c.name}さん … ${c.note || '理由の記録がありません'}`} count={c.n} unit="回" />
            ))}
            {picked.equipment.map((e) => (
              <CountRow key={`eq|${e.reason}`} label={e.reason} count={e.n} unit="件" tone="amber" />
            ))}
            {stuck.map((s) => (
              <CountRow key={`un|${s.reason}`} label={s.reason} count={s.n} unit="件の作業" tone="rose" />
            ))}
          </div>
        ) : (
          <div className="fi-tap-text leading-snug text-slate-500">{WORDS.OPSIM_NO_EXCLUSION}</div>
        )}

        <SectionTitle>計算の元</SectionTitle>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 fi-tap-text leading-relaxed text-slate-600">
          <div className="flex items-start gap-1.5">
            <Clock size={13} className="mt-0.5 shrink-0 text-slate-400" />
            <div>
              <div>{WORDS.OPSIM_TRACE_POSITION}</div>
              {isNum(spanMs) && spanMs > 0 ? (
                <div className="mt-0.5" data-side-position="1">
                  {/* 🚨 2026-09-05: ここは clamp していない生の値を fmtPct へ渡していたので
                      「いまは −33% の位置です」と出ていた。位置の1文は
                      Board.jsx の positionSentence ただ1本から出す。
                      前半の「◯ 到着 → ◯ 納期（N時間ぶん）」は **消さずに残す**。
                      納期線の右側にいる時の赤字(WORDS.OPSIM_TRACE_OVER)は
                      positionSentence が同じ文を返すので、色だけここで付ける。
                      🚨🚨 2026-09-05(検証で出た穴): 一度ここへ直書きした結果、
                      同じ言い回しが dispatchWords.js と この画面の2か所に在る形になっていた
                      (2026-08-21『片方だけ直すな』)。前半の口は
                      WORDS.OPSIM_TRACE_POSITION_SPAN ただ1本へ戻す。 */}
                  {WORDS.OPSIM_TRACE_POSITION_SPAN(fmtDate(lot.arrivalMs), fmtDate(dueLineMs), round1(spanMs / HOUR))}
                  {/* 🚨🚨 2026-09-05(検証で出た穴): ここは「到着も納期も分かっている」枝の中なのに、
                      位置が出せない時に positionSentence の既定の文
                      「到着日か納期が入っていないので…」が出ていた。すぐ左に日付を書いて
                      おきながら「入っていない」と言う、自分で自分を否定する1行だった。
                      ここで位置が出せないのは、このロットが **その時刻の写しに入っていない**
                      (片付いて盤から降りている)時なので、その事だけを言う。
                      🚨 言い方の口は positionSentence 1本のまま。理由を決め打ちしない。 */}
                  <span className={isNum(posRaw) && posRaw > 1 ? 'text-rose-600' : undefined}>
                    {positionSentence(
                      { raw: posRaw, arrivalMs: lot.arrivalMs },
                      { unknownText: 'いまの横の位置は、この時刻の写しに入っていません（このロットは、この時刻には盤に出ていません）。' },
                    )}
                  </span>
                </div>
              ) : (
                <div className="mt-0.5">到着か納期のどちらかが分からないので、横の位置は出していません。</div>
              )}
            </div>
          </div>

          <div className="mt-2 flex items-start gap-1.5">
            <Calculator size={13} className="mt-0.5 shrink-0 text-slate-400" />
            <div>
              {trace.perDay != null ? (
                <div>{WORDS.OPSIM_CAPACITY(trace.perDay, trace.hm, trace.factor, trace.people)}</div>
              ) : (
                <div>1日に使える時間は、定時と人数の設定がそろっていないので出していません。</div>
              )}
              <div className="mt-0.5">
                働く日 {trace.workdays}／始業 {trace.dayStart}／休憩 {trace.breakText}
              </div>
            </div>
          </div>

          <div className="mt-2 flex items-start gap-1.5">
            <Info size={13} className="mt-0.5 shrink-0 text-slate-400" />
            <div>
              <div>{WORDS.OPSIM_ESTIMATE_SOURCE(skills.known, skills.unknown)}</div>
              <div className="mt-0.5">{WORDS.OPSIM_ESTIMATE_NOTE}</div>
              <div className="mt-0.5">
                納期の元 {trace.dueField}／到着の元 {trace.arrivalField}
              </div>
              <div className="mt-0.5">{WORDS.OPSIM_READS(trace.reads, trace.writes)}</div>
            </div>
          </div>
        </div>

        <div className="mt-2 fi-tap-text leading-snug text-slate-500">{WORDS.OPSIM_ASSIGN_NOTE}</div>
      </div>
    </div>
  );
}

// 🚨 既定の書き出し(default export)は置かない。部品以外を default にすると
//   Vite の入れ替え(Fast Refresh)が効かなくなる。呼ぶ側は名前付きで取る:
//     import { WorkerList, LotDetail } from './opsim/Side.jsx';
