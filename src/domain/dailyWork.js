// 日次集計「その日に働いた時間」を正しく出すための純関数。
//
// ⚠ここが要 (2026-07-23 実測で判明した根本原因):
//   作業を完了/停止/NGにすると、設計として task.startTime は必ず null に戻される。
//   本当の時刻は firstStartTime (最初に始めた時刻) と endTime (終わった時刻) に入る。
//   ところが日次集計は startTime を日付の根拠に使い、null なので
//   lot.workStartTime / lot.createdAt (= ロットを始めた日) に落としていた。
//   → 完了した作業が全部「そのロットを始めた日」に付け替えられ、
//     日をまたいだ作業 (= ロットが未完了のとき必ず起きる) が翌日以降の集計から消えていた。
//   実測: 最終検査 2861件/44.83h、製品検査 681件/70.98h が別の日に飛んでいた。
//
// 日付の根拠は endTime → firstStartTime+duration → startTime+duration の順。
// どれも無い古い記録だけ、最後の手段としてロットの日付を使い precise:false を返す
// (画面では「日付おおよそ」と明示し、事実として断定しない)。

/** タスクが「いつ終わったか」。{ ms, precise, from } */
export const taskWorkedAt = (task, lot) => {
  const t = task || {};
  const l = lot || {};
  const dur = Number(t.duration) || 0;
  const durMs = dur > 0 ? dur * 1000 : 0;
  const end = Number(t.endTime) || 0;
  if (end > 0) return { ms: end, precise: true, from: 'endTime' };
  const first = Number(t.firstStartTime) || 0;
  if (first > 0) return { ms: first + durMs, precise: true, from: 'firstStartTime' };
  const st = Number(t.startTime) || 0;
  if (st > 0) return { ms: st + durMs, precise: true, from: 'startTime' };
  const lotMs = Number(l.workStartTime) || Number(l.firstWorkStartTime) || Number(l.createdAt) || 0;
  if (lotMs > 0) return { ms: lotMs + durMs, precise: false, from: 'lot' };
  return { ms: 0, precise: false, from: '' };
};

/** タスクが「いつ始まったか」(表示用)。無ければ 0 */
export const taskStartedAt = (task) => {
  const t = task || {};
  return Number(t.firstStartTime) || Number(t.startTime) || 0;
};

/**
 * いま計測中のタスクが、指定期間の中で何秒動いているか。
 * 完了していない作業も「その日働いた時間」に入れるための関数。
 * 期間でクランプするので、前日から回りっぱなしでも当日分だけを返す。
 */
export const runningSecondsInRange = (task, now, fromMs, toMs) => {
  const t = task || {};
  if (t.status !== 'processing') return 0;
  const st = Number(t.startTime) || 0;
  if (!(st > 0)) return 0;
  const end = Math.min(Number(now) || 0, Number(toMs) || 0);
  const start = Math.max(st, Number(fromMs) || 0);
  if (!(end > start)) return 0;
  return Math.floor((end - start) / 1000);
};

/**
 * やり直し(修正/リワーク)の時間。
 * ⚠これは task.duration には入らない。修正完了時のコードは reworks[last].duration にだけ足し、
 *   duration は触らない (App.firebase.jsx の修正完了処理で確認済み)。
 *   そのため日次集計が task.duration だけを見ていると、やり直しに費やした時間が丸ごと消える。
 *   実測(2026-07-24 本番): 製品検査で 209件 / 32.13h が集計から漏れていた。
 * 日付は endTime → startTime+duration。二重計上にはならない。
 */
export const reworkEntries = (task) => {
  const list = task && Array.isArray(task.reworks) ? task.reworks : [];
  const out = [];
  list.forEach((r) => {
    const d = Number(r && r.duration) || 0;
    if (!(d > 0)) return;
    const end = Number(r.endTime) || 0;
    const st = Number(r.startTime) || 0;
    const ms = end > 0 ? end : (st > 0 ? st + d * 1000 : 0);
    out.push({ duration: d, ms, round: Number(r.round) || 0, reason: String(r.reason || '') });
  });
  return out;
};

export const reworkSecondsInRange = (task, fromMs, toMs) => reworkEntries(task)
  .filter((e) => inRangeMs(e.ms, fromMs, toMs))
  .reduce((a, e) => a + e.duration, 0);

/**
 * 中断(手待ち・不良対応で止まった時間)。作業ではないので直工には足さないが、
 * 「その日どれだけ止まっていたか」は見えないと困るので別枠で返す。
 */
export const interruptionEntries = (lot, fromMs, toMs) => {
  const list = lot && Array.isArray(lot.interruptions) ? lot.interruptions : [];
  const out = [];
  list.forEach((x) => {
    const d = Number(x && x.duration) || 0;
    if (!(d > 0)) return;
    const ms = Number(x.timestamp) || Number(x.startTime) || 0;
    if (!inRangeMs(ms, fromMs, toMs)) return;
    out.push({ duration: d, ms, label: String(x.label || x.type || ''), worker: String(x.workerName || '') });
  });
  return out;
};

/** 最終検査のタッチアップ工程か (成績表の判定 App.firebase.jsx:7035 と同じ規則) */
export const isTouchupStep = (step) => {
  const s = step || {};
  if (String(s.category || '').includes('タッチアップ')) return true;
  return String(s.title || '').includes('タッチアップ');
};

/** タッチアップエリアに置かれているか (id 直判定 + 名前でも見る) */
export const isTouchupZone = (lot, zoneName) => {
  if (String(zoneName || '').includes('タッチアップ')) return true;
  const id = String((lot && (lot.location || lot.mapZoneId)) || '');
  return id === 'zone_touchup';
};

/**
 * ロットの状態。
 * ⚠`lot.status` だけで判断してはいけない。'paused' は「タッチアップエリアへ動かした」
 *   ときにも書かれる (App.firebase.jsx の移動処理)。検査の項目は全部終わっているのに
 *   「未完了・一時停止」と出て現場の実感と食い違う。実測: paused の4ロットは全て残り0件だった。
 *   'processing' のまま残り0件のロットもある (製品の実例A)。
 * → 残りの項目数を最優先で見て、状態名はその補足として付ける。
 */
export const lotWorkState = (lot, opts = {}) => {
  const s = String((lot && lot.status) || '');
  const p = lotProgress(lot);
  const touchup = isTouchupZone(lot, opts.zoneName);
  if (s === 'completed') return { key: 'completed', label: '完了', done: true, itemsDone: true, remain: 0 };
  if (p.remain === 0 && p.done > 0) {
    // 検査の項目は全部済んでいる。ロットとしての完了(確定)がまだなだけ
    return { key: 'itemsDone', label: touchup ? '検査済・タッチアップへ' : '検査済・完了待ち', done: false, itemsDone: true, remain: 0 };
  }
  if (s === 'processing') return { key: 'processing', label: '作業中', done: false, itemsDone: false, remain: p.remain };
  if (s === 'paused') return { key: 'paused', label: touchup ? 'タッチアップ中' : '中断中', done: false, itemsDone: false, remain: p.remain };
  return { key: 'waiting', label: '未着手', done: false, itemsDone: false, remain: p.remain };
};

/** ロットの進み具合。skipped(該当なし)は分母から外す */
export const lotProgress = (lot) => {
  const tasks = (lot && lot.tasks) || {};
  let done = 0;
  let skipped = 0;
  let total = 0;
  Object.values(tasks).forEach((t) => {
    if (!t || typeof t !== 'object') return;
    total += 1;
    if (t.status === 'completed') done += 1;
    else if (t.status === 'skipped') skipped += 1;
  });
  const denom = total - skipped;
  return { done, skipped, total, remain: Math.max(0, denom - done), pct: denom > 0 ? Math.round((done / denom) * 100) : 0 };
};

/** 期間(ms)に入っているか */
export const inRangeMs = (ms, fromMs, toMs) => {
  const v = Number(ms) || 0;
  if (!(v > 0)) return false;
  return v >= (Number(fromMs) || 0) && v <= (Number(toMs) || 0);
};

/** 直工明細を 通常 / タッチアップ / やり直し / 計測中 に分けて合計する */
export const splitWorkTotals = (details) => {
  const out = { normalSec: 0, touchupSec: 0, reworkSec: 0, runningSec: 0, estimatedSec: 0, total: 0 };
  (details || []).forEach((d) => {
    const sec = Number(d && d.duration) || 0;
    if (d && d.running) out.runningSec += sec;
    else if (d && d.rework) out.reworkSec += sec;
    else if (d && d.touchup) out.touchupSec += sec;
    else out.normalSec += sec;
    if (d && d.precise === false) out.estimatedSec += sec;
    out.total += sec;
  });
  return out;
};
