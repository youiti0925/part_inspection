// 🧭 2026-09-23 清水さん「各エリアからエリアへの距離と時間を初期データとして登録するだけでいい。司令塔の地図の座標を応用。
//   あとは型式テンプレ×台数の組み合わせだけでシミュレーションできる。そのロットの中で並列作業できるなら他の作業へ行く必要は無い」
//
//   問い(ロットごと): 「自動運転の間、人は手が空くか。空くならロットの中で埋まるか。埋まらないなら どのロットへ行く価値があるか」
//   材料: テンプレの工程(autoEndSec=自動の時間・targetTime=人の目標時間・executionMode・lotOnce)・台数・区画の座標(settings.mapZones)・
//         区画×区画の分数(settings.opsim.zoneTravel)・ロットの居場所(lot.mapZoneId → 無ければ テンプレの既定の区画)。
//   ⚠ 数字は全部この1本から。画面は計算しない。式は画面に出す(数字には必ず式)。

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const MIN = 60000;

export const ZONE_TRAVEL_DEFAULTS = Object.freeze({
  mapWidthM: null,       // 地図の横幅(m)。無いと座標から分数を出せない(推測しない)
  mapHeightM: null,      // 地図の縦幅(m)。未入力なら 横幅と同じ尺度と仮定する(画面にその旨を出す)
  walkMPerMin: 60,       // 歩く速さ(m/分)。工場内の既定 60m/分(時速3.6km)
  override: {},          // 「区画A|区画B」→ 片道の分(手で直した値。地図より優先)
  zoneOfTemplate: {},    // テンプレid → 区画id(型式テンプレの既定の居場所)
});

export const travelKeyOf = (a, b) => [str(a), str(b)].sort().join('|');

export const readZoneTravel = (settings) => {
  const raw = settings && settings.opsim && settings.opsim.zoneTravel;
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    mapWidthM: Number.isFinite(Number(o.mapWidthM)) && Number(o.mapWidthM) > 0 ? Number(o.mapWidthM) : null,
    mapHeightM: Number.isFinite(Number(o.mapHeightM)) && Number(o.mapHeightM) > 0 ? Number(o.mapHeightM) : null,
    walkMPerMin: Number.isFinite(Number(o.walkMPerMin)) && Number(o.walkMPerMin) > 0 ? Number(o.walkMPerMin) : ZONE_TRAVEL_DEFAULTS.walkMPerMin,
    override: o.override && typeof o.override === 'object' ? o.override : {},
    zoneOfTemplate: o.zoneOfTemplate && typeof o.zoneOfTemplate === 'object' ? o.zoneOfTemplate : {},
  };
};

/** 区画の中心(地図の % 座標)。座標の無い区画は null */
export const zoneCenterOf = (zone) => {
  if (!zone || typeof zone.x !== 'number' || typeof zone.y !== 'number') return null;
  const w = typeof zone.w === 'number' ? zone.w : 0;
  const h = typeof zone.h === 'number' ? zone.h : 0;
  return { x: zone.x + w / 2, y: zone.y + h / 2 };
};

/**
 * 区画A→B の片道(分)。手で直した値 → 地図の座標(横幅 m が登録されている時だけ) → null(分からない)。
 * @returns {{ min:number|null, source:'override'|'map'|null, meters:number|null }}
 */
export const travelBetween = (cfg, zones, a, b) => {
  const A = str(a); const B = str(b);
  if (!A || !B) return { min: null, source: null, meters: null };
  if (A === B) return { min: 0, source: 'same', meters: 0 };
  const key = travelKeyOf(A, B);
  const ov = cfg && cfg.override ? cfg.override[key] : undefined;
  if (ov !== undefined && ov !== null && ov !== '' && Number.isFinite(Number(ov)) && Number(ov) >= 0) return { min: Number(ov), source: 'override', meters: null };
  if (!cfg || !cfg.mapWidthM) return { min: null, source: null, meters: null };
  const za = (zones || []).find((z) => z && str(z.id) === A); const zb = (zones || []).find((z) => z && str(z.id) === B);
  const ca = zoneCenterOf(za); const cb = zoneCenterOf(zb);
  if (!ca || !cb) return { min: null, source: null, meters: null };
  const wM = cfg.mapWidthM; const hM = cfg.mapHeightM || cfg.mapWidthM;
  const dx = ((ca.x - cb.x) / 100) * wM; const dy = ((ca.y - cb.y) / 100) * hM;
  const meters = Math.sqrt(dx * dx + dy * dy);
  return { min: Math.round((meters / cfg.walkMPerMin) * 10) / 10, source: 'map', meters: Math.round(meters) };
};

/** ロットの居場所: ロットに登録 → テンプレの既定 → null */
export const zoneOfLot = (lot, cfg) => {
  const own = str(lot && lot.mapZoneId);
  if (own && own !== 'zone_unassigned') return { zoneId: own, source: 'lot' };
  const tpl = cfg && cfg.zoneOfTemplate ? str(cfg.zoneOfTemplate[str(lot && lot.templateId)]) : '';
  if (tpl) return { zoneId: tpl, source: 'template' };
  return { zoneId: null, source: null };
};

/** 台のうち まだ終わっていない数(tasks の completed を台ごとに数える。記録が無ければ全部残り) */
export const remainingUnitsOf = (lot) => {
  const units = Math.max(1, Math.floor(num(lot && lot.quantity) || 1));
  const steps = Array.isArray(lot && lot.steps) ? lot.steps : [];
  const tasks = lot && lot.tasks && typeof lot.tasks === 'object' ? lot.tasks : {};
  if (!steps.length) return { units, remaining: units };
  let done = 0;
  for (let u = 0; u < units; u += 1) {
    const all = steps.filter((s) => s && !s.lotOnce).every((s) => { const t = tasks[`${s.id}-${u}`]; return t && t.status === 'completed'; });
    if (all && steps.some((s) => s && !s.lotOnce)) done += 1;
  }
  return { units, remaining: Math.max(0, units - done) };
};

// 🚨 2026-09-24 外した: lotAutoProfileOf / lotParallelOf / VERDICT。「まとめて開始(batch)」を1ロット1回の自動と数え、
//   ロットの中で埋まる分を0にしていた(実測は1台ずつ機械に載る・machineRuns 646回すべて1台)。清水さん「本来合体してるものだよね」。
//   → ロットの中の並べ方と往復の価値は lotPair.js(inLotScheduleOf / tripValueOf / pairAnswerOf)へ。ここは区画と距離だけ。

/** 区画×区画の表(片道の分)。画面の表の材料。 */
export const zonePairTable = (settings, zones = null) => {
  const cfg = readZoneTravel(settings);
  const zs = (Array.isArray(zones) ? zones : (settings && Array.isArray(settings.mapZones) ? settings.mapZones : [])).filter((z) => z && !z.isPersonal && str(z.id) !== 'zone_unassigned');
  const pairs = [];
  for (let i = 0; i < zs.length; i += 1) for (let j = i + 1; j < zs.length; j += 1) {
    const a = zs[i]; const b = zs[j];
    pairs.push({ key: travelKeyOf(a.id, b.id), aId: str(a.id), bId: str(b.id), aName: str(a.name), bName: str(b.name), ...travelBetween(cfg, zs, a.id, b.id) });
  }
  return { zones: zs, pairs, cfg };
};

/** テンプレごとの「過去のロットが居た区画」の集計(既定の区画の候補) */
export const zoneHistoryOfTemplates = (lots) => {
  const out = {};
  for (const l of Array.isArray(lots) ? lots : []) {
    const t = str(l && l.templateId); const z = str(l && l.mapZoneId);
    if (!t || !z || z === 'zone_unassigned' || z === 'buffer') continue;
    out[t] = out[t] || {}; out[t][z] = (out[t][z] || 0) + 1;
  }
  return out;
};
