// =============================================================================
//  src/opsim/TodayOrders.jsx — 「今日の指示」。人ごとに1枚、いま → 次 を1行で言う
// -----------------------------------------------------------------------------
//  🚨 2026-09-18 清水さんの言葉「いろんなところに機能が散らばりすぎてる、整理整頓しないとダメ」
//    「答えを出す道具ではなく見せる道具で止まっている」への答え。
//    絵の元: scratchpad/design2/Main.dc.html の ②（案A 本命・Claude Design のキャンバス）。
//
//  この画面が答える1つの問い(決まり21):
//    **「今日、この人はいま何をしていて、それが終わったら次は何か」**
//
//  🚨 ここは数を1つも作らない。
//    ・割付(assignments)・ロット(lots)・暦(calendar)は 渡された物をそのまま読む。
//    ・遅れの判定も 納期も ここでは比べ直さない(納期一覧がやる)。
//    ・Date.now() を読まない(基準時刻は baseNowMs だけ)。
//  🚨 製品検査と最終検査で **同じファイル**(md5 一致)。
//    そのために どちらのアプリの事情も import しない(props で全部受ける)。
//    読むのは 対になっている物だけ: opsim/vizKit.jsx / opsim/workerColors.js / opsim/idleTone.js。
//  🚨 px を1つも直書きしない(rem 段のクラスと % だけ)。押す物は min-h-11、文字は text-2xs 以上。
//  🚨 JSX の子の位置に裸の /* */ を書かない（必ず {/* */}）。
// =============================================================================
import React from 'react';
import { Avatar } from './vizKit.jsx';
import { buildWorkerColors, toneOf } from './workerColors.js';
import { OFF_HATCH } from './idleTone.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const MS_MIN = 60000;

/** 検査表の名前。渡された表をそのまま引くだけ(名前を作らない)。 */
function tplNameOfMap(templatesById, id) {
  if (!id || !templatesById) return '';
  const t = templatesById instanceof Map ? templatesById.get(id) : templatesById[id];
  if (typeof t === 'string') return t;
  return (t && typeof t.name === 'string') ? t.name : '';
}

/** HH:MM。🚨 時刻が読めない時は '—'（0:00 と書かない）。 */
function hhmm(ms) {
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 休みの表の記号 → 人が読む言葉。
 * 🚨 言葉は 割付の計算(domain/operationsSimulation/simulate.js の AWAY_STATUS_LABEL)と
 *   **同じ言い方** にそろえてある(清水さん 2026-09-16「休みじゃなくて、他のグループ応援してるが
 *   正しいよね、ちゃんとどのグループ応援してるか記載して」)。
 * 🚨 知らない記号は そのまま出す(推測で「休み」に丸めない)。
 */
const AWAY_LABEL = Object.freeze({
  off: '休み',
  other: '他の作業',
  'support:product': '製品検査の応援',
  'support:final': '最終検査の応援',
});
const awayTextOf = (status) => {
  const s = str(status);
  if (!s) return '';
  return AWAY_LABEL[s] || s;
};

/**
 * 今日の1人ぶんの材料。🚨 純粋な組み替えだけ(数を作らない)。
 * @param {Array} assignments simulate の result.base.assignments
 * @param {string} name 作業者名
 * @param {number} winStartMs その日のその人の窓の始まり
 * @param {number} winEndMs   その日のその人の窓の終わり
 * @param {number} baseNowMs  基準時刻
 */
function todayOrderOf({ assignments, name, winStartMs, winEndMs, baseNowMs }) {
  const nm = str(name);
  const mine = arr(assignments)
    .filter((a) => a && (str(a.worker) === nm || str(a.partner) === nm))
    .map((a) => ({ ...a, startMs: Number(a.startMs), endMs: Number(a.endMs) }))
    .filter((a) => isNum(a.startMs) && isNum(a.endMs) && a.endMs > a.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  // その日の窓と重なる分だけ(窓の外の仕事は今日の指示ではない)
  const inDay = (isNum(winStartMs) && isNum(winEndMs))
    ? mine.filter((a) => a.endMs > winStartMs && a.startMs < winEndMs)
    : [];
  // 「いま」= 基準時刻を含む割付。無ければ 基準時刻以降の最初の割付。
  let now = null;
  if (isNum(baseNowMs)) {
    now = inDay.find((a) => a.startMs <= baseNowMs && baseNowMs < a.endMs)
      || inDay.find((a) => a.startMs >= baseNowMs)
      || null;
  } else {
    now = inDay[0] || null;
  }
  // 「次」= 「いま」より後の、**別のロット** の最初の割付。
  let next = null;
  if (now) {
    const nowLot = String(now.lotId);
    next = inDay.find((a) => a.startMs >= now.endMs && String(a.lotId) !== nowLot) || null;
  }
  const lotIds = [...new Set(inDay.map((a) => String(a.lotId)))];
  /* 🤝 2026-09-18 確かめ役の実測(最終): 同じロットを台ごとに2人で分担している時、納期一覧は主担当1人しか
       出さないので「次」が食い違って見えた。嘘ではないが黙っていると分からないので、その日の窓の中で
       同じロットに手を付ける **ほかの人の名前** を添える(数は作らない・割付をそのまま読むだけ)。 */
  const withOf = (item) => {
    if (!item) return [];
    const id = String(item.lotId);
    const others = arr(assignments)
      .filter((a) => a && String(a.lotId) === id && Number(a.endMs) > winStartMs && Number(a.startMs) < winEndMs)
      .flatMap((a) => [str(a.worker), str(a.partner)])
      .filter((w) => w && w !== nm);
    return [...new Set(others)];
  };
  /* 🚨 2026-09-18 写しの実測で出た穴: 夜をまたぐ割付が1本入ると
       いちばん遅い終わりが **翌日の 8:36** になり、札が「11:14〜8:36」と
       時間が戻って見えていた。窓の外へは出さない(窓で切る)。 */
  const firstMs = inDay.length ? Math.max(winStartMs, inDay[0].startMs) : null;
  const lastMs = inDay.length ? Math.min(winEndMs, Math.max(...inDay.map((a) => a.endMs))) : null;
  return { items: inDay, now, next, lotIds, firstMs, lastMs, nowWith: withOf(now), nextWith: withOf(next) };
}

/** 窓の中の棒(%)。🚨 px を使わない。窓が読めない時は空の並び。 */
function barSegmentsOf({ items, winStartMs, winEndMs }) {
  if (!isNum(winStartMs) || !isNum(winEndMs) || winEndMs <= winStartMs) return [];
  const span = winEndMs - winStartMs;
  return arr(items).map((a) => {
    const s = Math.max(winStartMs, Number(a.startMs));
    const e = Math.min(winEndMs, Number(a.endMs));
    if (!(e > s)) return null;
    return {
      key: `${a.lotId}-${a.startMs}`,
      lotId: String(a.lotId),
      left: ((s - winStartMs) / span) * 100,
      width: ((e - s) / span) * 100,
    };
  }).filter(Boolean);
}

/** 1つの仕事の呼び名(品目コード｜テンプレ)。 */
function jobLabel(lot, templatesById) {
  if (!lot) return '';
  const model = str(lot.model) || '(品目コードなし)';
  const tpl = tplNameOfMap(templatesById, lot.templateId);
  return tpl ? `${model}｜${tpl}` : model;
}

// -----------------------------------------------------------------------------
//  1人ぶんの **1行**(畳んだ形・既定)。📐 2026-09-18 夜: 大きな札3枚で 241px 取り、主役(納期一覧)を画面の外へ押し出していた。
//    いま → 次 を1行に。押す所は 44px のまま。くわしい札(時刻・指図・その日の帯)は「開く」でそのまま出る。
// -----------------------------------------------------------------------------
/** 札を押した時に何が起きるか の言葉(既定＝製品検査: 右の引き出し)。最終検査は引き出しが無いので 自分の言葉を渡す(2026-09-19)。 */
export const SELECT_TITLE_NOW = 'この仕事の詳しい話(根拠・担当の理由)を右の引き出しで開きます。何も確定しません。';
export const SELECT_TITLE_NEXT = '次の仕事の詳しい話を右の引き出しで開きます。何も確定しません。';

function OrderChip({ name, tone, order, awayText, lotById, templatesById, onSelectLot, selectTitleNow = SELECT_TITLE_NOW, selectTitleNext = SELECT_TITLE_NEXT }) {
  const nowLot = order.now ? lotById.get(String(order.now.lotId)) : null;
  const nextLot = order.next ? lotById.get(String(order.next.lotId)) : null;
  const pick = (lotId) => { if (typeof onSelectLot === 'function' && lotId) onSelectLot(String(lotId)); };
  return (
    <div
      data-today-order-worker={name}
      data-today-order-state={order.now ? 'working' : (awayText ? 'away' : 'idle')}
      data-today-order-compact="1"
      className="flex min-w-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2"
    >
      <Avatar name={name} tone={tone} size="w-6 h-6" showName={false} />
      <b className="shrink-0 text-xs font-black text-slate-900">{name}</b>
      {order.now ? (
        <button type="button" data-today-order-now={String(order.now.lotId)} onClick={() => pick(order.now.lotId)}
          title={selectTitleNow}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded text-left text-xs leading-snug hover:bg-cyan-50">
          <b className="shrink-0 font-black text-slate-900">いま</b>
          <span className="min-w-0 truncate font-bold text-cyan-800 underline decoration-cyan-300">{jobLabel(nowLot, templatesById) || '(この仕事のロットが読めていません)'}</span>
          <span className="shrink-0 tabular-nums text-slate-500">{hhmm(order.now.startMs)}〜</span>
          {arr(order.nowWith).length ? <span className="shrink-0 font-bold text-slate-500">{`＋${arr(order.nowWith).join('・')}`}</span> : null}
        </button>
      ) : (
        <span className={`flex min-h-11 min-w-0 flex-1 items-center truncate text-xs ${awayText ? 'font-black text-violet-700' : 'text-slate-500'}`}>{awayText || 'この先、今日の割付はありません'}</span>
      )}
      {order.next ? (
        <button type="button" data-today-order-next={String(order.next.lotId)} onClick={() => pick(order.next.lotId)}
          title={selectTitleNext}
          className="flex min-h-11 min-w-0 max-w-[45%] items-center gap-1 rounded text-left text-xs leading-snug text-slate-600 hover:bg-slate-50">
          <b className="shrink-0 font-black text-slate-700">→ 次</b>
          <span className="min-w-0 truncate font-bold">{jobLabel(nextLot, templatesById) || '(ロットが読めていません)'}</span>
          <span className="shrink-0 tabular-nums text-slate-400">{hhmm(order.next.startMs)}〜</span>
        </button>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
//  1人ぶんの札
// -----------------------------------------------------------------------------
function OrderCard({
  name, tone, order, winStartMs, winEndMs, awayText, lotById, templatesById, onSelectLot, pinnedTo,
  selectTitleNow = SELECT_TITLE_NOW, selectTitleNext = SELECT_TITLE_NEXT,
}) {
  const segs = barSegmentsOf({ items: order.items, winStartMs, winEndMs });
  const nowLot = order.now ? lotById.get(String(order.now.lotId)) : null;
  const nextLot = order.next ? lotById.get(String(order.next.lotId)) : null;
  const pick = (lotId) => { if (typeof onSelectLot === 'function' && lotId) onSelectLot(String(lotId)); };
  return (
    <div
      data-today-order-worker={name}
      data-today-order-state={order.now ? 'working' : (awayText ? 'away' : 'idle')}
      className="flex min-w-0 items-start gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-2"
    >
      <Avatar name={name} tone={tone} size="w-8 h-8" showName={false} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <b className="truncate text-sm font-black text-slate-900">{name}</b>
          {awayText ? (
            <span className="text-2xs font-black text-violet-700">{awayText}</span>
          ) : (
            <span className="text-2xs font-bold tabular-nums text-slate-500">
              {order.items.length
                ? `${hhmm(order.firstMs)}〜${hhmm(order.lastMs)}・${order.lotIds.length}ロット`
                : 'この先、今日の割付はありません'}
            </span>
          )}
          {pinnedTo ? (
            <span className="rounded border border-amber-400 px-1 text-2xs font-black text-amber-700" title={`このロットは ${pinnedTo} に固定されています`}>📌固定</span>
          ) : null}
        </div>

        {/* 🚨 2026-09-18 写しの実測: 品目コードの所だけを押す物にしていたので、押す所の高さが 20px しか
            無かった(現場は手袋で触る)。**1行ぜんぶを1つの押す物** にして 44px 以上にする。 */}
        {order.now ? (
          <button
            type="button"
            data-today-order-now={String(order.now.lotId)}
            onClick={() => pick(order.now.lotId)}
            title={selectTitleNow}
            className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-1.5 rounded-lg border border-transparent px-1 text-left text-xs leading-snug hover:border-cyan-300 hover:bg-cyan-50"
          >
            <b className="font-black text-slate-900">いま</b>
            <span className="min-w-0 max-w-full truncate font-bold text-cyan-800 underline decoration-cyan-300">
              {jobLabel(nowLot, templatesById) || '(この仕事のロットが読めていません)'}
            </span>
            <span className="tabular-nums text-slate-500">{hhmm(order.now.startMs)}〜{hhmm(order.now.endMs)}</span>
            {nowLot && str(nowLot.orderNo) ? <span className="tabular-nums text-slate-400">指図 {str(nowLot.orderNo)}</span> : null}
            {arr(order.nowWith).length ? <span data-today-order-with={arr(order.nowWith).join('・')} className="rounded border border-slate-300 px-1 font-bold text-slate-600">{`＋${arr(order.nowWith).join('・')}と分担`}</span> : null}
          </button>
        ) : (
          <div className="text-xs leading-snug text-slate-500">
            {awayText
              ? 'この日はこちらの割付がありません（上の言葉が理由です）'
              : '基準時刻から先に、この人の割付がありません（手が空く理由は下の帯に出ます）'}
          </div>
        )}

        {order.next ? (
          <button
            type="button"
            data-today-order-next={String(order.next.lotId)}
            onClick={() => pick(order.next.lotId)}
            title={selectTitleNext}
            className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-1.5 rounded-lg border border-transparent px-1 text-left text-xs leading-snug hover:border-slate-300 hover:bg-slate-50"
          >
            <b className="font-black text-slate-700">次</b>
            <span className="min-w-0 max-w-full truncate font-bold text-slate-700 underline decoration-slate-300">
              {jobLabel(nextLot, templatesById) || '(この仕事のロットが読めていません)'}
            </span>
            <span className="tabular-nums text-slate-500">{hhmm(order.next.startMs)}〜</span>
            {arr(order.nextWith).length ? <span data-today-order-next-with={arr(order.nextWith).join('・')} className="rounded border border-slate-300 px-1 font-bold text-slate-600">{`＋${arr(order.nextWith).join('・')}と分担`}</span> : null}
          </button>
        ) : null}

        {/* その日の帯。🚨 色の意味は IdleStrip と同じ(働いている＝色の棒／網掛け＝その日は居ない)。 */}
        <div
          className="mt-0.5 h-2 w-full overflow-hidden rounded-full bg-slate-200"
          style={awayText ? OFF_HATCH : undefined}
          title={awayText
            ? `${name} は ${awayText}（この工場の勤務の窓には棒を描きません）`
            : `${hhmm(winStartMs)}〜${hhmm(winEndMs)} の勤務の窓に、割り当たっている仕事を置いた帯です`}
        >
          <div className="relative h-full w-full">
            {segs.map((s) => (
              <i
                key={s.key}
                data-today-order-bar={s.lotId}
                className="absolute top-0 h-full rounded-full bg-cyan-400"
                style={{ left: `${s.left}%`, width: `${Math.max(s.width, 0.8)}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
//  本体
// -----------------------------------------------------------------------------
/**
 * @param {object} p
 * @param {Array}  p.assignments   simulate の result.base.assignments（渡されなければ1人も描かない）
 * @param {Array}  p.lots          normalized.lots（lotId / model / templateId / orderNo / quantity）
 * @param {Map|object|null} p.templatesById 検査表の表
 * @param {object|null} p.calendar makeCalendar の戻り（workerWindowOf でその日の窓を引く）
 * @param {number|null} p.baseNowMs 基準時刻（「いま」を決める唯一の時刻）
 * @param {string[]} p.workerNames 名簿の並び（画面の並び順）
 * @param {object|null} p.absencesToday { 名前: 'support:final' } 今日の休み・応援の記号
 * @param {object|null} p.pinsByLot { lotId: 名前 } いま固定されている担当（札の 📌 に出す）
 * @param {string} p.actualPinsNote 「手が付いた N件はその人のまま」の1文（**数は呼ぶ側が作る**）
 * @param {boolean} p.keepDecided 固定が既定か（印に出すだけ。ここでは何も変えない）
 * @param {Function|null} p.onPinAll 納期一覧と **同じ口**。[{lotId, worker}] を渡す
 * @param {Function|null} p.onSelectLot ロットを選ぶ
 * @param {string} p.dateText 「9/18（金）」など。**呼ぶ側が作った文字をそのまま出す**
 * @param {number|null} p.todayMs 端末の今(基準時刻を進める前の実時刻)。基準日と違う日なら見出しを「次の勤務日の指示」にする
 */
export function TodayOrders({
  assignments = null,
  lots = [],
  templatesById = null,
  calendar = null,
  baseNowMs = null,
  workerNames = null,
  absencesToday = null,
  pinsByLot = null,
  actualPinsNote = '',
  keepDecided = true,
  onPinAll = null,
  onSelectLot = null,
  selectTitleNow = SELECT_TITLE_NOW,
  selectTitleNext = SELECT_TITLE_NEXT,
  dateText = '',
  todayMs = null,
  /** 📐 既定は畳んだ形(1人1行)。true で最初から大きな札。 */
  defaultOpen = false,
}) {
  // 🚨 hooks はガード(return null)より上に置く(2026-08-27 の事故)。開閉は端末の中の見た目だけ。
  const [open, setOpen] = React.useState(!!defaultOpen);
  const names = React.useMemo(
    () => [...new Set(arr(workerNames).map(str).filter(Boolean))],
    [workerNames],
  );
  const colors = React.useMemo(() => buildWorkerColors(names), [names]);
  const lotById = React.useMemo(() => {
    const m = new Map();
    arr(lots).forEach((l) => {
      const id = l && (l.lotId != null ? l.lotId : l.id);
      if (id != null) m.set(String(id), l);
    });
    return m;
  }, [lots]);

  /**
   * その日の **1つの窓**(全員で同じ)。
   * 🚨🚨 2026-09-18 写しの実測で出た穴: 暦の workerWindowOf は
   *   **個人設定が登録されている人にしか窓を返さない**(登録が無ければ null)。
   *   人ごとの窓で切っていたので、登録の無い人は割付が在るのに
   *   「この日の割付はありません」と嘘を出していた(実測 3人のうち2人)。
   *   だから **登録が読めた人の窓を寄せて1つの窓** にし、1人も読めなければ
   *   その日ぜんぶ(0:00〜24:00)を窓にする。
   * 🚨 1つの窓にする理由はもう1つある: 人ごとに幅が違うと、隣の人の棒と見比べられない。
   * 🚨 ここで勤務時間を作らない(暦が返した物を寄せるだけ・読めなければ日で切るだけ)。
   */
  const dayWindow = React.useMemo(() => {
    if (!isNum(baseNowMs)) return { startMs: null, endMs: null, known: 0 };
    const day = new Date(baseNowMs); day.setHours(0, 0, 0, 0);
    const dayMs = day.getTime();
    let lo = null;
    let hi = null;
    let known = 0;
    if (calendar && typeof calendar.workerWindowOf === 'function') {
      for (const name of names) {
        let w = null;
        try { w = calendar.workerWindowOf(dayMs, name); } catch { w = null; }
        if (!w) continue;
        const a = Number(w.startMs);
        const b = isNum(Number(w.effectiveEndMs)) ? Number(w.effectiveEndMs) : Number(w.endMs);
        if (!isNum(a) || !isNum(b) || b <= a) continue;
        known += 1;
        lo = lo == null ? a : Math.min(lo, a);
        hi = hi == null ? b : Math.max(hi, b);
      }
    }
    if (lo == null || hi == null) return { startMs: dayMs, endMs: dayMs + 1440 * MS_MIN, known: 0 };
    return { startMs: lo, endMs: Math.max(lo + MS_MIN, hi), known };
  }, [calendar, baseNowMs, names]);

  /**
   * 📅 2026-09-23 ChatGPT の本番観察: 工場の暦が休みの日(9/23)に、基準時刻が次の勤務(9/24)へ進んでいて
   *   翌日の仕事を「今日の指示」と言っていた。基準日 ≠ 端末の今日 なら見出しを変え、今日が休業なら
   *   「本日 M/D は休業 → 次の勤務 M/D」を出す。暦に窓が在る人(個別に出勤)は名前で出す。
   * 🚨 ここで勤務時間を作らない(暦の isWorkday / workerWindowOf を読むだけ)。
   */
  const dayNote = React.useMemo(() => {
    if (!isNum(todayMs) || !isNum(baseNowMs)) return null;
    const ymdOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
    const d = new Date(todayMs);
    const todayText = `${d.getMonth() + 1}/${d.getDate()}（${['日', '月', '火', '水', '木', '金', '土'][d.getDay()]}）`;
    let todayOff = false;
    try { todayOff = !!(calendar && typeof calendar.isWorkday === 'function' && !calendar.isWorkday(todayMs)); } catch { todayOff = false; }
    // 基準日＝今日: 今日が休みの時だけ札を出す(見出しは「今日の指示」のまま)
    if (ymdOf(todayMs) === ymdOf(baseNowMs)) return todayOff ? { todayOff, todayText, individual: [], sameDay: true } : null;
    const day0 = new Date(todayMs); day0.setHours(0, 0, 0, 0);
    const individual = [];
    if (todayOff && calendar && typeof calendar.workerWindowOf === 'function') {
      for (const name of names) {
        let w = null;
        try { w = calendar.workerWindowOf(day0.getTime(), name); } catch { w = null; }
        if (w && Number(w.endMs) > Number(w.startMs)) individual.push(name);
      }
    }
    return { todayOff, todayText, individual };
  }, [todayMs, baseNowMs, calendar, names]);

  const rows = React.useMemo(() => names.map((name) => {
    const order = todayOrderOf({
      assignments, name, winStartMs: dayWindow.startMs, winEndMs: dayWindow.endMs, baseNowMs,
    });
    const awayText = awayTextOf(absencesToday && absencesToday[name]);
    return { name, win: dayWindow, order, awayText };
  }), [names, dayWindow, assignments, baseNowMs, absencesToday]);

  /** 📌 この指示で全部固定。🚨 納期一覧と同じ口へ **同じ形** で渡す(別の書き手を作らない)。 */
  const pinList = React.useMemo(() => {
    const byLot = new Map();
    for (const r of rows) {
      for (const a of r.order.items) {
        const id = String(a.lotId);
        if (str(a.worker) !== r.name) continue;
        const dur = Number(a.endMs) - Number(a.startMs);
        const cur = byLot.get(id);
        if (!cur || dur > cur.ms) byLot.set(id, { lotId: id, worker: r.name, ms: dur });
      }
    }
    return [...byLot.values()].map((x) => ({ lotId: x.lotId, worker: x.worker }));
  }, [rows]);

  if (!rows.length) return null;

  return (
    <section
      data-today-orders={String(rows.length)}
      className="flex flex-col gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-black text-slate-900" title="いまの答えで、この人がいま何をしていて、終わったら次は何か。押すと その仕事の根拠が出ます">{dayNote && !dayNote.sameDay ? '次の勤務日の指示' : '今日の指示'}</span>
        {dateText ? <span className="text-2xs font-bold tabular-nums text-slate-600">{dateText}</span> : null}
        {dayNote ? (
          <span data-today-orders-day-note={dayNote.sameDay ? 'holiday-today' : dayNote.todayOff ? 'holiday' : 'moved'} className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-2xs font-black text-amber-800">
            {dayNote.sameDay
              ? `本日 ${dayNote.todayText} は休業（工場の暦）。次の勤務日の指示は 基準時刻「次の勤務開始から」`
              : dayNote.todayOff
              ? `本日 ${dayNote.todayText} は休業 → 次の勤務 ${dateText || '—'}${dayNote.individual.length ? `（個別に出勤: ${dayNote.individual.join('・')}）` : ''}`
              : `基準時刻を ${dateText || '—'} へ進めています（本日 ${dayNote.todayText}）`}
          </span>
        ) : null}
        {open ? <span className="text-2xs text-slate-500">いまの答えで、この人がいま何をしていて、終わったら次は何か。押すと その仕事の根拠が出ます</span> : null}
        <button type="button" data-today-orders-toggle={open ? 'open' : 'compact'} aria-expanded={open} onClick={() => setOpen((v) => !v)}
          title="1人1行の形と、時刻・指図・その日の帯まで出す大きな札を切り替えます。何も確定しません。"
          className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-2 text-2xs font-black text-slate-700 hover:bg-slate-50">
          {open ? '▴ 1行に畳む' : '▾ くわしく'}
        </button>
        <span
          data-today-orders-keep={keepDecided ? 'on' : 'off'}
          className={`ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-black ${keepDecided
            ? 'border-cyan-300 bg-cyan-50 text-cyan-800'
            : 'border-slate-300 bg-slate-50 text-slate-600'}`}
          title="🧰 道具箱 の「🧷 決めた物を守る」で切り替えます。ONの時は、現場で手が付いたロットを実際の担当のまま出します。"
        >
          {keepDecided ? '決めた担当は固定（既定）' : '決めた担当の固定は OFF'}
          {actualPinsNote ? `・${actualPinsNote}` : ''}
        </span>
        {typeof onPinAll === 'function' && pinList.length ? (
          <button
            type="button"
            data-today-orders-pin-all={String(pinList.length)}
            onClick={() => onPinAll(pinList)}
            title="いま出ている指示の担当を、そのまま設定へ書いて固定します（納期一覧の「いまの担当で全部固定」と同じ口です）。外すのは 🧰 道具箱 の「固定を全部外す」です。"
            className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-amber-400 bg-amber-50 px-2.5 text-2xs font-black text-amber-800 hover:bg-amber-100"
          >
            {`📌 この指示で全部固定（${pinList.length.toLocaleString('ja-JP')}件）`}
          </button>
        ) : null}
      </div>
      {!open ? (
        <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2 xl:grid-cols-3" data-today-orders-compact="1">
          {rows.map((r) => (
            <OrderChip key={r.name} name={r.name} tone={toneOf(colors, r.name)} order={r.order} awayText={r.awayText}
              lotById={lotById} templatesById={templatesById} onSelectLot={onSelectLot}
              selectTitleNow={selectTitleNow} selectTitleNext={selectTitleNext} />
          ))}
        </div>
      ) : (
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <OrderCard
            key={r.name}
            name={r.name}
            tone={toneOf(colors, r.name)}
            order={r.order}
            winStartMs={r.win.startMs}
            winEndMs={r.win.endMs}
            awayText={r.awayText}
            lotById={lotById}
            templatesById={templatesById}
            onSelectLot={onSelectLot}
            selectTitleNow={selectTitleNow} selectTitleNext={selectTitleNext}
            pinnedTo={r.order.now && pinsByLot ? str(pinsByLot[String(r.order.now.lotId)]) : ''}
          />
        ))}
      </div>
      )}
    </section>
  );
}

export default TodayOrders;
