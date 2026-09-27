// ============================================================================
// 🏭 作業する区画(エリア)の「同時に何人まで」— 過去の実績から数える
// ----------------------------------------------------------------------------
// 清水さん(2026-09-06 夜):
//   「製品検査と部品検査は作業するエリアも意識しないとだめかな。
//     今シミュレーション見てたら作業している場所が被ってる人いたわ。
//     過去データからそこも意識するようにしてほしい」
//
// 🚨 いままでの割付は「手が空いている人の数」だけで同時本数を決めていた(simulate.js)。
//   場所は1バイトも見ていないので、**同じ区画に何人でも同時に立たせてしまう**。
//   盤面で「同じ場所に人が被っている」ように見えたのはこれ。
//
// 本番の写し(2026-09-06 11:45・製品検査 604ロット / 手が動いていた区間 5,821件)で実測:
//     中間分割1        区間2517 人2  最大同時 1人
//     完品分割縦2      区間703  人2  最大同時 1人
//     第一組立エリア_1 区間649  人3  最大同時 2人 (2人以上だったのは全時間の 0.1%)
//     三次元測定エリア 区間559  人4  最大同時 2人 (2人以上は 0.0%)
//     中間分割2 / 完品分割縦1 / 中間分割縦 / 第三組立 / 完品分割横 … すべて 最大同時 1人
//   → 現場の実態は「**1区画=同時1人**」。2人入った実績が在るのは2区画だけで、それもごく短時間。
//
// ⚠⚠ 決めるのは人。ここは「過去はこうだった」を出すだけで、上限を勝手に決めない。
//   ・設定(settings.zoneCapacity)に人が書いた数が在れば **それが勝つ**
//   ・書いていなければ **過去の実測の最大同時人数** を既定として使う
//   ・過去の実績が1件も無い区画は **null = 制限しない**(分からない物を1人と決めつけない)
// ⚠ 数えるのは「人」であって「ロット」ではない。清水さんが見たのは *人* の被り。
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

/** 時刻を ms に。⚠0 と負は「入っていない」として捨てる(1970年に化けさせない)。 */
export const msOfLoose = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'object' && typeof v.seconds === 'number') {
    const ms = v.seconds * 1000 + Math.round((v.nanoseconds || 0) / 1e6);
    return ms > 0 ? ms : null;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) && t > 0 ? t : null;
};

/** そのロットが置かれている区画。空文字 = 決まっていない。 */
export const zoneIdOfLot = (lot) => String(lot?.mapZoneId || '').trim();

/** 区画が決まっていない印。⚠この区画は数えないし、制限もしない。 */
export const UNASSIGNED_ZONE = 'zone_unassigned';

const MAX_SEGMENT_MS = 12 * 3600 * 1000;   // 12時間より長い区間は記録の壊れ(閉じ忘れ)として捨てる

/**
 * 過去の完了ロットから「その区画で 同時に何人が手を動かしていたか」を数える。
 * @param lots 生のロット(mapZoneId と tasks を持つ物)
 * @returns { [zoneId]: { zoneId, maxConcurrent, segments, workers, share2, firstMs, lastMs } }
 *   maxConcurrent … 同時に手を動かしていた **別人** の最大数
 *   share2        … 2人以上だった時間の割合(0〜1)。⚠「たまたま1回重なった」を上限にしない為の材料
 */
export const observedZoneConcurrency = (lots) => {
  const byZone = new Map();
  for (const lot of (lots || [])) {
    const zid = zoneIdOfLot(lot);
    if (!zid || zid === UNASSIGNED_ZONE) continue;
    const tasks = lot && lot.tasks;
    if (!tasks) continue;
    for (const t of Object.values(tasks)) {
      if (!t) continue;
      if (t.status !== 'completed' && t.status !== 'ng') continue;
      // ⚠ 抜取で飛ばした台・該当なしは「手を動かしていない」。場所も使っていない。
      if (t.samplingSkipped || t.autoNa || t.templateSkipped) continue;
      const segs = (Array.isArray(t.sessions) && t.sessions.length)
        ? t.sessions
        : [{ startTime: t.firstStartTime || t.startTime, endTime: t.endTime }];
      for (const sg of segs) {
        const a = msOfLoose(sg && (sg.startTime ?? sg.start));
        const b = msOfLoose(sg && (sg.endTime ?? sg.end));
        if (a == null || b == null || b <= a || (b - a) > MAX_SEGMENT_MS) continue;
        const who = String((sg && sg.workerName) || t.workerName || '').trim();
        if (!who) continue;   // 誰がやったか分からない区間は数えない(人数を数える話なので)
        let list = byZone.get(zid);
        if (!list) { list = []; byZone.set(zid, list); }
        list.push({ a, b, who });
      }
    }
  }

  const out = {};
  for (const [zid, list] of byZone) {
    // 端点で重ね合わせる。⚠同時刻は「終わり」を先に処理する(入れ替わりを2人と数えない)。
    const ev = [];
    for (const x of list) { ev.push([x.a, 1, x.who]); ev.push([x.b, -1, x.who]); }
    ev.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
    const held = new Map();
    let cur = 0, maxConcurrent = 0, last = null, total = 0, at2 = 0;
    for (const [t, d, who] of ev) {
      if (last != null && t > last) { total += t - last; if (cur >= 2) at2 += t - last; }
      const n = (held.get(who) || 0) + d;
      if (n <= 0) held.delete(who); else held.set(who, n);
      cur = held.size;
      if (cur > maxConcurrent) maxConcurrent = cur;
      last = t;
    }
    out[zid] = {
      zoneId: zid,
      maxConcurrent,
      segments: list.length,
      workers: new Set(list.map((x) => x.who)).size,
      share2: total > 0 ? at2 / total : 0,
      firstMs: Math.min(...list.map((x) => x.a)),
      lastMs: Math.max(...list.map((x) => x.b)),
    };
  }
  return out;
};

/** 人が書いた上限の読み方。⚠1以上の整数だけ。0・小数・文字は「書いていない」として捨てる(黙って丸めない)。 */
export const manualCapOf = (v) => {
  // 🚨 true は Number(true)===1 になる。数でも数の文字でもない物は先に外す
  //   (「はい」を定員1人と読み替えない)。
  const n = (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/**
 * その区画の上限を決める。人の設定 → 過去の実測 → 制限しない、の順。
 * @returns { cap:number|null, source:'manual'|'observed'|'none', observed:number|null }
 */
export const resolveZoneCap = (zoneId, { manual = null, observed = null } = {}) => {
  const m = manualCapOf(manual && manual[zoneId]);
  if (m != null) return { cap: m, source: 'manual', observed: observed && observed[zoneId] ? observed[zoneId].maxConcurrent : null };
  const o = observed && observed[zoneId];
  if (o && o.maxConcurrent >= 1) return { cap: o.maxConcurrent, source: 'observed', observed: o.maxConcurrent };
  return { cap: null, source: 'none', observed: null };
};

/**
 * 割付へ渡す形({zoneId: 上限}) を作る。⚠上限が無い区画は **鍵ごと出さない**(素通りさせる)。
 * @param zones settings.mapZones (区画の親。名前を付けるためだけに使う)
 */
export const zoneCapacityMap = ({ zones = [], manual = null, observed = null } = {}) => {
  const ids = new Set();
  for (const z of (zones || [])) { const id = String(z && z.id || '').trim(); if (id) ids.add(id); }
  for (const k of Object.keys(manual || {})) ids.add(String(k));
  for (const k of Object.keys(observed || {})) ids.add(String(k));
  const map = {};
  for (const id of ids) {
    if (!id || id === UNASSIGNED_ZONE) continue;
    const { cap } = resolveZoneCap(id, { manual, observed });
    if (cap != null) map[id] = cap;
  }
  return map;
};

/** 画面に出す1行(区画ごと)。⚠数字は全部ここまでで数えた物から作る(手書きしない)。 */
export const zoneCapacityRows = ({ zones = [], manual = null, observed = null } = {}) => {
  const byId = new Map();
  for (const z of (zones || [])) { const id = String(z && z.id || '').trim(); if (id) byId.set(id, String(z.name || id)); }
  const ids = new Set([...byId.keys(), ...Object.keys(observed || {}), ...Object.keys(manual || {})]);
  const rows = [];
  for (const id of ids) {
    if (!id || id === UNASSIGNED_ZONE) continue;
    const o = (observed || {})[id] || null;
    const r = resolveZoneCap(id, { manual, observed });
    rows.push({
      zoneId: id,
      name: byId.get(id) || id,
      cap: r.cap,
      source: r.source,
      observedMax: o ? o.maxConcurrent : null,
      segments: o ? o.segments : 0,
      workers: o ? o.workers : 0,
      share2: o ? o.share2 : 0,
      note: o
        ? `過去 ${o.segments}回の作業・${o.workers}人。同時に居たのは最大 ${o.maxConcurrent}人（2人以上だった時間 ${(o.share2 * 100).toFixed(1)}%）`
        : '過去の作業の記録がありません（この区画は上限をかけません）',
    });
  }
  return rows.sort((a, b) => (b.segments - a.segments) || a.name.localeCompare(b.name, 'ja'));
};
