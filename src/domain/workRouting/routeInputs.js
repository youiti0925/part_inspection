// =============================================================================
//  workRouting/routeInputs.js — 移動先の判断に使う「作業者の勤務時間・休み・技能の記録」を
//  共有棚の daily_load の1欄(routeInputs)に載せる形(2026-09-22)
// -----------------------------------------------------------------------------
//  第三者の指摘(2026-09-22)「計算入力を共有する App 側の接続も未実装なので、全部をデータ待ちとは言えない」。
//  sim_input(計算の入力を丸ごと・約1MB×枚数)を書く口を増やす代わりに、移動の判断に要る **小さい部分だけ** を
//  今ある daily_load の書類に相乗りさせる(書く口は増えない。指紋に鍵を混ぜるので変わった時だけ書く)。
//
//  🚨 この file は **切って繋ぐだけ**。数を作らない・時計を読まない・工程の対応を推測しない。
//  🚨 技能(eligible)は「記録か登録のある工程 → 名前」の表を **そのまま** 写す。鍵は各アプリの工程の身元のまま
//     (製品 step.id ／ 最終 カテゴリ__項目名)なので、相手の工程と結ぶには 工程の対応表(process_map)が要る。
// =============================================================================
import { shortHash } from '../planControl/planConditions.js';

/** 相乗りする欄の上限(バイト)。daily_load は 1MB の決まりの中に他の欄(dueList/placement)も居る。 */
export const ROUTE_INPUTS_MAX_BYTES = 200 * 1024;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));
const pad2 = (n) => String(n).padStart(2, '0');
/** normalizeInput の ymdOf と同じ形(端末の暦の YYYY-MM-DD)。 */
export const ymdOfMs = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const utf8Bytes = (s) => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };

/**
 * normalizeInput の workers(日ごとの働ける分数・休み)と、Worker が写した eligibleNamesByProcess(工程 → 名前)から
 * 相乗りする欄を作る。
 * @returns {{ ok:true, app, at, key, workers:[{name, days:[{date, minutes, reason, rosterStatus}]}], eligible:object|null, eligibleShared:boolean, bytes }
 *          | { ok:false, reason:'no-input'|'too-large', bytes? } }
 */
export function buildRouteInputs({ normalized = null, eligibleNamesByProcess = null, app = '', nowMs = null } = {}) {
  if (!isObj(normalized) || !Array.isArray(normalized.workers) || !Number.isFinite(nowMs)) return { ok: false, reason: 'no-input' };
  const workers = normalized.workers.filter(isObj).map((w) => ({
    name: str(w.name),
    days: (Array.isArray(w.availability) ? w.availability : []).filter(isObj).map((a) => ({
      date: str(a.date),
      minutes: Number.isFinite(a.availableDirectMinutes) ? a.availableDirectMinutes : 0,
      reason: str(a.reason),
      rosterStatus: a.rosterStatus == null ? null : str(a.rosterStatus),
    })),
  })).filter((w) => w.name);
  const eligible = isObj(eligibleNamesByProcess)
    ? Object.fromEntries(Object.entries(eligibleNamesByProcess).map(([k, v]) => [k, (Array.isArray(v) ? v : []).map(str).filter(Boolean)]))
    : null;
  const body = { workers, eligible };
  const bytes = utf8Bytes(JSON.stringify(body));
  if (bytes > ROUTE_INPUTS_MAX_BYTES) return { ok: false, reason: 'too-large', bytes };
  return { ok: true, app: str(app), at: nowMs, key: shortHash(JSON.stringify(body)), workers, eligible, eligibleShared: eligible != null, bytes };
}

/**
 * 移動先のある日の事実。数え直さない(欄の分数をそのまま出す)。
 * @param inputs buildRouteInputs の戻り(相手の daily_load.routeInputs)。無ければ null を返す
 * @returns {{ date, available:[{name, minutes}], absent:[{name, rosterStatus}], unknownDay:[name], eligibleShared, processKeys:number } | null}
 */
export function routeInputsFacts({ inputs = null, whenMs = null } = {}) {
  if (!isObj(inputs) || inputs.ok !== true || !Array.isArray(inputs.workers) || !Number.isFinite(whenMs)) return null;
  const date = ymdOfMs(whenMs);
  const available = [], absent = [], unknownDay = [];
  for (const w of inputs.workers) {
    const d = (w.days || []).find((x) => x.date === date);
    if (!d) { unknownDay.push(w.name); continue; }
    if (d.minutes > 0) available.push({ name: w.name, minutes: d.minutes });
    else absent.push({ name: w.name, rosterStatus: d.rosterStatus });
  }
  return { date, available, absent, unknownDay, eligibleShared: inputs.eligibleShared === true, processKeys: inputs.eligible ? Object.keys(inputs.eligible).length : 0 };
}

/** 画面の行(短く・推測しない)。 */
export function routeInputsLines(facts, areaLabel = '移動先') {
  if (!facts) return [];
  const out = [];
  out.push(`${areaLabel} ${facts.date} に働ける人: ${facts.available.length}人${facts.available.length ? '（' + facts.available.map((a) => `${a.name} ${a.minutes}分`).join('・') + '）' : ''}`);
  if (facts.absent.length) out.push(`${areaLabel} 休み・他の作業: ${facts.absent.map((a) => a.name + (a.rosterStatus ? `(${a.rosterStatus})` : '')).join('・')}`);
  if (facts.unknownDay.length) out.push(`${areaLabel} この日の予定が共有に無い: ${facts.unknownDay.join('・')}`);
  out.push(facts.eligibleShared
    ? `${areaLabel} の技能の記録(工程 ${facts.processKeys}件 → 名前)は共有されています。こちらの工程と結ぶ 工程の対応表 が無いので、誰がやれるかは出しません`
    : `${areaLabel} の技能の記録はまだ共有されていません(向こうの工場が計算を回すと載ります)`);
  return out;
}
