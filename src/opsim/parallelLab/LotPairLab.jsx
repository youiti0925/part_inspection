import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildDurationStats } from '../../domain/operationsSimulation/estimate.js';
import {
  stepTimesOf, inLotScheduleOf, zoneGuessOf, zoneHistoryOfTemplates, presenceOf, readTravelCfg, geoOf, travelOf,
} from '../../domain/parallelLab/lotPair.js';
import { FULL_PAIR_CONDITIONS, fullPairInputOf } from '../../domain/parallelLab/fullPairInput.js';
import { walkSecOf, minTripWorkSecOf } from '../../domain/juggleGuide.js';
import FullPairComparison from '../fullPair/FullPairComparison.jsx';
import WorkingHoursFields from '../fullPair/WorkingHoursFields.jsx';
import { partnerQueue, workingContext, defaultHours } from '../../domain/fullPair/fieldPlan.mjs';
import { ModelLabel } from '../ModelLabel.jsx';

/* 🧭 2026-09-24 並列作業シミュレーション(合体版)。清水さん「①(ChatGPT の見本)に②(区画の距離)を足せばいいだけ。本来合体してるもの」
     「品目コードテンプレ台数との組み合わせだけでシミュレーション」「この距離でこの二つのロットを移動する価値があるか」
     「地図の横幅は後からこっちで数字を入力できるように」
   🤝 2026-09-25 作り直し。清水さん「今のは使えない、何をしたくて作ったかわからん」「並列シュミレーション直した？ chatgptの資料見たよね」
     前は「自動運転の1回の空きに Bの手作業が何分入るか」だけで答えていた(全部が終わるまでを見ていない・自動時間は設定の写し)。
     → ChatGPT(Codex)の全台完了までの計算(domain/fullPair/scheduler.mjs・画面は opsim/fullPair/FullPairComparison.jsx)に置き換えた。
        組まずに片方ずつ(A→B / B→A の早い方)と、1人で行き来して掛け持ち を、2ロットの全台・全工程が終わるまで並べて比べる。
     入力は本番のロットから作る(domain/parallelLab/fullPairInput.js)。時間 = stepTimesOf(実績・テンプレの目標・設定の自動時間・出典つき)、
     片道 = 区画どうしの表 → 同じ区画の中の移動 → 地図の点×横幅。号機など記録の無い事は「前提」として画面で選び、結果の横に必ず並べる。
     現場の割付・指示には何も書かない(保存するのは地図の尺度・区画どうしの表・テンプレの既定の区画だけ)。 */

const fmt = (n) => Number((Number(n) || 0).toFixed(1));
const str = (v) => (v == null ? '' : String(v)).trim();
const control = 'min-h-11 max-w-full rounded-lg border border-slate-400 bg-white px-3 py-2 text-base text-slate-900';
const SRC = { lot: 'ロットに登録', template: 'テンプレの既定', history: '過去の記録', manual: 'ここで選んだ' };

/** 選ぶ欄(A/B)。再生中に 1000 個近い選択肢を描き直さないよう 別の部品にして memo する。group があれば optgroup で分ける */
const LotSelect = React.memo(function LotSelect({ value, options, onPick, label, dataKey }) {
  // 🔧 2026-09-24 見出しごとに1つへまとめる(並びは保つ)。前は続いている所だけで区切っていて、工場に在る／入荷前 が交互に並ぶと
  //   同じ見出しが何度も出ていた(React も「同じ key が2つ」と警告)。
  const groups = []; const byName = new Map();
  for (const o of options) { const g = o.group || ''; let grp = byName.get(g); if (!grp) { grp = { name: g, items: [] }; byName.set(g, grp); groups.push(grp); } grp.items.push(o); }
  return (
    <select className={`${control} w-full`} value={value} onChange={(e) => onPick(e.target.value)} aria-label={label} data-lot-pair-select={dataKey}>
      {groups.map((g) => (g.name
        ? <optgroup key={g.name} label={g.name}>{g.items.map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}</optgroup>
        : g.items.map((o) => <option key={o.value} value={o.value}>{o.text}</option>)))}
    </select>
  );
});

/** 区画どうしの片道(分)の表。🧭 清水さん「初期データとして各エリアからエリアへの距離と時間データを登録するだけ」 */
function PairTable({ zones, cfg, geo, canEdit, onSave }) {
  const [draft, setDraft] = useState({});
  const [err, setErr] = useState('');
  const pairs = useMemo(() => {
    const zs = zones.filter((z) => z && z.id && str(z.id) !== 'zone_unassigned');
    const out = [];
    for (let i = 0; i < zs.length; i += 1) for (let j = i + 1; j < zs.length; j += 1) out.push([zs[i], zs[j]]);
    return out;
  }, [zones]);
  const keyOf = (a, b) => [str(a.id), str(b.id)].sort().join('|');
  // 🚶 2026-09-26 欄は「秒」(清水さん: 区画の片道は10秒・30秒)。保存する形は今までどおり「分」(片道の表を読む所を変えない)
  const secToMin = (v) => Math.round((Number(v) / 60) * 10000) / 10000;
  const save = () => {
    const bad = Object.entries(draft).filter(([, v]) => v !== '' && v != null && !(Number.isFinite(Number(v)) && Number(v) >= 0));
    if (bad.length) { setErr(`数字(0以上)でない欄が ${bad.length}つあります。直してから保存してください`); return; }
    setErr('');
    const asMin = {}; for (const [k, v] of Object.entries(draft)) asMin[k] = (v === '' || v == null) ? '' : String(secToMin(v));
    onSave(asMin).then((ok) => { if (ok) setDraft({}); });
  };
  // 名前の目安(清水さんの実感)を、空いている組に全部入れる(押しただけでは保存しない。「表を保存」で書く)
  const fillByName = () => {
    const d = { ...draft };
    for (const [a, b] of pairs) { const k = keyOf(a, b); const cur = cfg.override && cfg.override[k]; if (cur != null && cur !== '') continue; const g = walkSecOf({ a: a.id, b: b.id, zones, travel: { override: {} } }); if (g.source === 'name' && d[k] === undefined) d[k] = String(g.sec); }
    setDraft(d);
  };
  return (
    <details className="rounded-lg border border-violet-200 bg-white p-2" data-lot-pair-table="1">
      <summary className="min-h-11 cursor-pointer text-sm font-bold text-violet-900">区画どうしの片道(秒)の表を見る・入れる({pairs.length}組)</summary>
      <p className="mt-1 text-xs text-slate-600">入れた秒が地図より先に使われます(シミュレーションと作業画面の掛け持ち案内の両方)。空欄はシミュレーションでは地図の点×横幅、掛け持ち案内では「名前の目安」(清水さん 2026-09-26 の実感: 中間・完品どうし10秒、三次元・第一組立とは30秒)を使います。入れた数を消して保存すると元に戻ります。</p>
      <div className="mt-2 max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-600"><th className="py-1 pr-2">区画</th><th className="py-1 pr-2">区画</th><th className="py-1 pr-2">地図から</th><th className="py-1 pr-2">名前の目安</th><th className="py-1">入れた片道(秒)</th></tr></thead>
          <tbody>
            {pairs.map(([a, b]) => {
              const k = keyOf(a, b); const cur = cfg.override && cfg.override[k];
              const fromMap = travelOf({ cfg: { ...cfg, override: {} }, geo, a: a.id, b: b.id });
              const guess = walkSecOf({ a: a.id, b: b.id, zones, travel: { override: {} } });
              return (
                <tr key={k} className="border-t border-slate-100">
                  <td className="py-1 pr-2">{str(a.name) || a.id}</td><td className="py-1 pr-2">{str(b.name) || b.id}</td>
                  <td className="py-1 pr-2 tabular-nums text-slate-700">{Number.isFinite(fromMap.min) ? `${fromMap.min}分(${fromMap.meters}m)` : '—'}</td>
                  <td className="py-1 pr-2 tabular-nums text-slate-700">{guess.source === 'name' ? `${guess.sec}秒` : '—'}</td>
                  <td className="py-1"><input type="number" min="0" step="1" inputMode="numeric" aria-label={`${str(a.name)}と${str(b.name)}の片道(秒)`} className={`${control} w-24`} disabled={!canEdit}
                    value={draft[k] !== undefined ? draft[k] : (cur != null && cur !== '' ? String(Math.round(Number(cur) * 60)) : '')} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {err ? <div className="mt-1 text-sm font-bold text-rose-700" role="alert">{err}</div> : null}
      {canEdit ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="min-h-11 rounded-lg bg-violet-700 px-4 font-bold text-white" onClick={save} data-lot-pair-save-table="1">表を保存</button>
          <button type="button" className="min-h-11 rounded-lg border border-violet-400 bg-white px-3 text-sm font-bold text-violet-900" onClick={fillByName} data-lot-pair-fill-name="1">空いている組に 名前の目安を入れる</button>
          <button type="button" className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-sm font-bold" onClick={() => { setDraft({}); setErr(''); }}>入れかけを捨てる</button>
        </div>
      ) : <div className="mt-1 text-xs text-slate-600">入力は管理者だけ</div>}
    </details>
  );
}

export default function LotPairLab({ lots = [], templatesById = new Map(), settings = {}, canEdit = false, isAdmin = false, saveOpsim = null, estimateMode = 'P75', readOverviewMap = null }) {
  const [open, setOpen] = useState(false);
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  const [zoneAPick, setZoneAPick] = useState('');
  const [zoneBPick, setZoneBPick] = useState('');
  const [trialTravel, setTrialTravel] = useState(null); // 選んだ1組だけの試算値(分)。共有設定には書かない
  // 🔧 2026-09-26 反証役の指摘: 秒の試算値が A/B を替えても残っていた → 組を替えたら捨てる
  useEffect(() => { setTrialTravel(null); }, [aId, bId]);
  const [cond, setCond] = useState({ ...FULL_PAIR_CONDITIONS });
  const [candidateLimit, setCandidateLimit] = useState(1);
  const [hours, setHoursRaw] = useState(() => defaultHours(settings?.workSchedule));
  // 🔧 2026-09-26 反証役: 勤務表を開いた時に1回しか読まなかった → 設定が後から届いたら、手で触るまでは読み直す
  const hoursTouchedRef = useRef(false);
  const setHours = (v) => { hoursTouchedRef.current = true; setHoursRaw(v); };
  const wsKey = JSON.stringify(settings?.workSchedule || null);
  useEffect(() => { if (!hoursTouchedRef.current) setHoursRaw(defaultHours(settings?.workSchedule)); }, [wsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [stepResources, setStepResources] = useState({});
  const [arrivalMode, setArrivalMode] = useState(false), [arrivalOffsets, setArrivalOffsets] = useState({});
  const context = useMemo(() => hours.enabled ? workingContext(hours) : null, [hours]);
  const [groupSame, setGroupSame] = useState(true); // 同じ品目コードテンプレ×台数×残りは1つにまとめる
  const [scaleDraft, setScaleDraft] = useState({ w: '', h: '', walk: '', same: '' });
  const [saveMsg, setSaveMsg] = useState('');
  const [overview, setOverview] = useState({ state: 'idle', map: null, error: '' });
  // 🔐 地図の尺度・区画の表・テンプレの既定の区画は 全員の計算に効く共有の設定。入れるのは管理者だけ(他の管理画面と同じ決め方)。
  const canWrite = !!(isAdmin && canEdit && saveOpsim);
  const cfg = useMemo(() => ({ ...readTravelCfg(settings), minTripWorkMin: settings && settings.opsim && settings.opsim.zoneTravel ? settings.opsim.zoneTravel.minTripWorkMin : undefined }), [settings]);
  const zones = useMemo(() => (Array.isArray(settings && settings.mapZones) ? settings.mapZones.filter((z) => z && z.id) : []), [settings]);
  const zoneName = (id) => { const z = zones.find((x) => str(x.id) === str(id)); return z ? str(z.name) || str(id) : (id ? str(id) : '未定'); };
  const tplName = (id) => { const t = templatesById && templatesById.get ? templatesById.get(str(id)) : null; return (t && t.name) || 'テンプレ名なし'; };
  const modeText = estimateMode || 'P75';

  // 🗺 司令塔の工場の図(点の座標と図の縦横比)。開いた時に1回だけ読む(背景の図は縦横比を知るためだけに使う)
  // ⚠ 2026-09-24 写しで「読んでいます…」のまま止まった: 読み始めに state を変えると effect が掃除されて 返事を捨てていた。→ 1回だけ(ref)
  const ovStartedRef = useRef(false);
  const aliveRef = useRef(true);
  // ⚠ 開発の二度付け(StrictMode)では 付け→外し→付け が起きる。付け直しで true に戻さないと 返事を捨てたままになる(写しで実測)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => {
    if (!open || ovStartedRef.current || typeof readOverviewMap !== 'function') return;
    ovStartedRef.current = true;
    const alive = () => aliveRef.current;
    setOverview({ state: 'loading', map: null, error: '' });
    Promise.resolve(readOverviewMap()).then((doc) => {
      if (!alive()) return;
      const areas = doc && doc.areas && typeof doc.areas === 'object' ? doc.areas : null;
      if (!areas) { setOverview({ state: 'none', map: null, error: '' }); return; }
      const src = doc && typeof doc.bgData === 'string' && doc.bgData.startsWith('data:image') ? doc.bgData : (doc && doc.bgUrl) || '';
      if (!src || typeof Image === 'undefined') { setOverview({ state: 'ok', map: { areas, aspect: null }, error: '' }); return; }
      const img = new Image();
      img.onload = () => { if (alive()) setOverview({ state: 'ok', map: { areas, aspect: img.naturalWidth ? img.naturalHeight / img.naturalWidth : null }, error: '' }); };
      img.onerror = () => { if (alive()) setOverview({ state: 'ok', map: { areas, aspect: null }, error: '' }); };
      img.src = src;
    }).catch((e) => { if (alive()) setOverview({ state: 'error', map: null, error: String((e && e.message) || e) }); });
  }, [open, readOverviewMap]);
  const geo = useMemo(() => geoOf({ settings, overviewMap: overview.map, cfg }), [settings, overview.map, cfg]);
  const geoLoading = overview.state === 'loading' || (overview.state === 'idle' && typeof readOverviewMap === 'function');

  // 🧮 本番のロット(未完了)ごとの 時間(出典つき)・ロットの中だけで並べた時の空き・居場所・工場に在るか。
  //   開いた時だけ。ロットの購読が来るたびに全部数え直さないよう、計算に効く中身が変わった時だけ(指紋)
  // Include duration/name/log changes too. Calculation itself is explicit, so a
  // fresh subscription invalidates stale results without launching heavy work.
  const stableLots = lots;
  const index = useMemo(() => {
    if (!open) return null;
    const stats = buildDurationStats({ lots: stableLots });
    const history = zoneHistoryOfTemplates(stableLots);
    const rows = [];
    for (const l of stableLots) {
      if (!l || l.status === 'completed' || !Array.isArray(l.steps) || !l.steps.length) continue;
      const times = stepTimesOf({ lot: l, stats, customTargetTimes: settings && settings.customTargetTimes, modelGroups: settings && settings.modelGroups, mode: modeText });
      const sched = inLotScheduleOf({ lot: l, times });
      rows.push({ id: str(l.id), lot: l, times, sched, zone: zoneGuessOf({ lot: l, cfg, history }), presence: presenceOf(l) });
    }
    return { rows, byId: new Map(rows.map((r) => [r.id, r])) };
  }, [open, stableLots, settings, cfg, modeText]);

  // A = 自動運転があるロット(自動の間に 人が他へ行ける形のもの)。工場に在る物を先に、ロットの中だけで並べた時の空きが大きい順
  const aListAll = useMemo(() => {
    if (!index) return [];
    return index.rows.filter((r) => r.sched.hasAuto || !r.sched.ok)
      .sort((x, y) => (Number(y.presence.present) - Number(x.presence.present)) || (y.sched.idleMin - x.sched.idleMin));
  }, [index]);
  // 🧭 清水さん「品目コードテンプレ台数との組み合わせ」: 同じ 品目コード×テンプレ×台数×残り の未着手ロットは 1つにまとめて見せる(件数を添える)
  const aList = useMemo(() => {
    if (!groupSame) return aListAll.map((r) => ({ r, same: 1 }));
    const seen = new Map(); const out = [];
    for (const r of aListAll) {
      const l = r.lot; const sig = [r.presence.present ? 'P' : 'F', str(l.model), str(l.templateId), str(l.quantity), r.zone.zoneId, r.sched.totalMin, r.sched.idleMin].join('|');
      const hit = seen.get(sig);
      if (hit && !r.presence.present) { hit.same += 1; continue; }
      const row = { r, same: 1 }; seen.set(sig, row); out.push(row);
    }
    return out;
  }, [aListAll, groupSame]);
  const presentN = useMemo(() => aListAll.filter((r) => r.presence.present).length, [aListAll]);

  const A = index && (index.byId.get(aId) || (aList[0] && aList[0].r)) || null;
  const zoneA = zoneAPick || (A && A.zone.zoneId) || '';
  // B の候補 = 残りの工程があるロット(A以外)。工場に在る物を先に、Aからの片道が短い順
  const bList = useMemo(() => {
    if (!index || !A) return [];
    // 🔍 2026-09-25 穴探し: 工程が全部済んだロット(ロットの状態は完了でない)が 一番近いと既定の B になり「残りの工程がありません」だけ出ていた → 外す
    return index.rows.filter((r) => r.id !== A.id && !(r.sched.ok && !(r.sched.totalMin > 0)))
      .map((r) => ({ r, travel: travelOf({ cfg, geo, a: zoneA, b: r.zone.zoneId }) }))
      .sort((x, y) => (Number(y.r.presence.present) - Number(x.r.presence.present))
        || ((Number.isFinite(x.travel.min) ? x.travel.min : 1e9) - (Number.isFinite(y.travel.min) ? y.travel.min : 1e9)));
  }, [index, A, cfg, geo, zoneA]);
  const B = index && (bId && bId !== (A && A.id) && index.byId.get(bId) ? index.byId.get(bId) : (bList[0] && bList[0].r)) || null;
  const zoneB = zoneBPick || (B && B.zone.zoneId) || '';
  const pairTravel = travelOf({ cfg, geo, a: zoneA, b: zoneB });
  const trialDefault = 5;
  const travelMinNow = trialTravel ?? (Number.isFinite(pairTravel.min) ? pairTravel.min : trialDefault);
  const travelNoteNow = trialTravel != null ? '選んだ組だけの試算値（共有設定への保存なし）' : Number.isFinite(pairTravel.min)
    ? (pairTravel.source === 'override' ? '区画どうしの表' : pairTravel.source === 'same' ? '同じ区画の中の移動' : `地図で ${pairTravel.meters}m`)
    : '試しの値';

  const dueShort = (v) => { const m = str(v).match(/^\d{4}-(\d{2})-(\d{2})/); return m ? `納期${Number(m[1])}/${Number(m[2])}` : ''; };
  const mdOf = (ms) => { if (!Number.isFinite(ms)) return ''; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const presText = (p) => (p.present ? '工場に在る' : `入荷予定${p.entryMs ? ` ${mdOf(p.entryMs)}` : ''}`);
  const orderOf = (l) => str(l && (l.orderNo || l.orderNumber));
  const lotLine = (r) => [`${str(r.lot.model)}｜${tplName(r.lot.templateId)} ×${r.lot.quantity || 1}台`, orderOf(r.lot) ? `指図${orderOf(r.lot)}` : '', dueShort(r.lot.dueDate)].filter(Boolean).join(' ');
  const shortLabel = (r) => `${str(r.lot.model)} ×${r.lot.quantity || 1}台${orderOf(r.lot) ? ` 指図${orderOf(r.lot)}` : ''}`;

  // 🤝 計算に渡す組(選んだ A・B ＋ 同じ A と組む相手の候補 あと2つ)。どれも 2ロットの全台・全工程が終わるまで計算して比べる(ChatGPT の計算)
  const pairInputOf = (bRow, travelMin, travelNote) => {
    const zb = bRow === B ? zoneB : bRow.zone.zoneId;
    const timesOf = row => row.times.map(t => ({ ...t, machine: t.auto || (stepResources[row.id + ':' + t.id] ?? t.machine),
      machineConfirmed: t.auto || t.machineBy === 'resource' || Object.prototype.hasOwnProperty.call(stepResources, row.id + ':' + t.id) }));
    return fullPairInputOf({
      A: { id: A.id, lot: A.lot, times: timesOf(A), zoneId: zoneA, zoneName: zoneName(zoneA), label: shortLabel(A) },
      B: { id: bRow.id, lot: bRow.lot, times: timesOf(bRow), zoneId: zb, zoneName: zoneName(zb), label: shortLabel(bRow) },
      travelMin, sameZone: !!zoneA && str(zoneA) === str(zb), travelNote, conditions: cond, context,
      availability: arrivalMode ? Object.fromEntries([['A', A], ['B', bRow]].map(([key, row]) => [key,
        arrivalOffsets[row.id] != null && arrivalOffsets[row.id] !== '' ? Number(arrivalOffsets[row.id]) : row.presence.present ? 0 : null])) : null,
    });
  };
  const chosen = useMemo(() => (A && B ? pairInputOf(B, travelMinNow, travelNoteNow) : null), [A, B, zoneA, zoneB, travelMinNow, travelNoteNow, cond, context, stepResources, arrivalMode, arrivalOffsets]); // eslint-disable-line react-hooks/exhaustive-deps -- all pair input fields listed
  // 🔍 2026-09-25 穴探し: 選んだ組が計算に入れられなくても、ほかの候補は計算する。候補ごとに 前提(notes)と探索の幅(options)を持たせる
  const candidates = useMemo(() => {
    if (!A || !B) return [];
    const out = chosen ? [{ key: B.id, label: `B ${shortLabel(B)}（選んだ組）`, input: chosen.input, errors: chosen.errors, notes: chosen.assumptions, options: chosen.options }] : [];
    for (const x of partnerQueue(A, bList)) {
      if (out.length >= candidateLimit) break;
      if (x.r.id === B.id) continue;
      const p = pairInputOf(x.r, x.travel.min, x.travel.source === 'override' ? '区画どうしの表' : x.travel.source === 'same' ? '同じ区画の中の移動' : `地図で ${x.travel.meters}m`);
      out.push({ key: x.r.id, label: `B ${shortLabel(x.r)}（${zoneName(x.r.zone.zoneId)}・片道${x.travel.min ?? '未登録'}分）`, input: p.input, errors: p.errors, notes: p.assumptions, options: p.options });
    }
    return out;
  }, [chosen, bList, candidateLimit]); // eslint-disable-line react-hooks/exhaustive-deps -- chosen changes with all shared input fields

  // 💾 共有の設定へ書く。saveOpsim は失敗を false で返す(前は失敗しても「保存しました」と出ていた)
  const writeTravel = async (patch, okMsg, { anyone = false } = {}) => {
    if (!canWrite && !(anyone && canEdit && saveOpsim)) { setSaveMsg('入力は管理者だけです'); return false; }
    const cur = (settings && settings.opsim && settings.opsim.zoneTravel) || {};
    let ok = false;
    try { ok = (await saveOpsim({ zoneTravel: { ...cur, ...patch } })) !== false; } catch (e) { setSaveMsg(`保存できませんでした: ${(e && e.message) || e}`); return false; }
    if (ok === false) { setSaveMsg('保存できませんでした(通信か権限の理由。もう一度押すか、時間を置いてください)'); return false; }
    setSaveMsg(okMsg); return true;
  };
  const numOrNull = (v) => { if (v === '' || v == null) return undefined; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : NaN; };
  const widthKey = geo.basis === 'overview' ? 'overviewWidthM' : 'mapWidthM';
  const heightKey = geo.basis === 'overview' ? 'overviewHeightM' : 'mapHeightM';
  const saveScale = () => {
    const p = {}; const bad = [];
    const put = (raw, key, positive) => { const n = numOrNull(raw); if (n === undefined) return; if (Number.isNaN(n) || (positive && !(n > 0))) { bad.push(key); return; } p[key] = n; };
    put(scaleDraft.w, widthKey, true); put(scaleDraft.h, heightKey, true); put(scaleDraft.walk, 'walkMPerMin', true); put(scaleDraft.same, 'sameZoneMin', false);
    if (bad.length) { setSaveMsg('数字でない欄があります(横幅・縦幅・速さは 0 より大きい数)'); return; }
    if (!Object.keys(p).length) { setSaveMsg('入れた数がありません'); return; }
    writeTravel(p, '保存しました').then((ok) => { if (ok) setScaleDraft({ w: '', h: '', walk: '', same: '' }); });
  };
  const clearScale = (key) => { writeTravel({ [key]: null }, '消しました'); };
  // 🚶 2分の決まり(MIN_TRIP_WORK_MIN)。清水さん 2026-09-26「そのままでいいけど、すぐ変更できる状態に。誰でもすぐに」→ 管理者に限らない
  const [minTripDraft, setMinTripDraft] = useState('');
  const minTripNow = minTripWorkSecOf(cfg) / 60;
  const saveMinTrip = () => {
    const n = Number(minTripDraft);
    if (minTripDraft === '' || !Number.isFinite(n) || n < 0) { setSaveMsg('「行く価値がある最低の手作業」は 0以上の数(分)で入れてください'); return; }
    writeTravel({ minTripWorkMin: n }, `「行く価値がある最低の手作業」を ${n}分 にしました(作業画面の掛け持ち案内に すぐ効きます)`, { anyone: true }).then((ok) => { if (ok) setMinTripDraft(''); });
  };
  const saveTable = (draft) => {
    // 🚨 消した欄は null を書く(保存は合体(merge)なので、鍵を消しただけでは 前の分数が残る)。null は 読む時に「無い」と同じ
    const next = { ...(cfg.override || {}) };
    for (const [k, v] of Object.entries(draft)) { if (v === '' || v == null) next[k] = null; else next[k] = Number(v); }
    return writeTravel({ override: next }, '区画どうしの表を保存しました');
  };
  const saveTplZone = (lot, zoneId) => {
    const cur = (settings && settings.opsim && settings.opsim.zoneTravel) || {};
    writeTravel({ zoneOfTemplate: { ...(cur.zoneOfTemplate || {}), [str(lot.templateId)]: zoneId } }, `「${tplName(lot.templateId)}」の既定の区画を ${zoneName(zoneId)} にしました`);
  };
  const aOptions = useMemo(() => aList.map(({ r, same }) => ({ value: r.id, group: r.presence.present ? '工場に在るロット' : '入荷前(そろったらの試算)', text: `${lotLine(r)}${same > 1 ? `(同じ品目コードテンプレ×台数 ${same}件)` : ''}${r.sched.ok ? `｜ロットの中だけで並べた空き ${r.sched.idleMin}分` : '｜時間が分からない工程あり'}${r.presence.present ? '' : `｜${presText(r.presence)}`}` })), [aList]); // eslint-disable-line react-hooks/exhaustive-deps
  const bOptions = useMemo(() => bList.map(({ r, travel: tr }) => ({ value: r.id, group: r.presence.present ? '工場に在るロット' : '入荷前(そろったらの試算)', text: `${lotLine(r)}｜${zoneName(r.zone.zoneId)}${tr.source === 'same' ? ' 同じ区画' : Number.isFinite(tr.min) ? ` 片道${tr.min}分` : ' 片道が分からない'}` })), [bList]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickA = React.useCallback((v) => { setAId(v); setZoneAPick(''); setBId(''); setTrialTravel(null); }, []);
  const pickB = React.useCallback((v) => { setBId(v); setZoneBPick(''); setTrialTravel(null); }, []);
  const zoneSelect = ({ value, onChange, guess, dataKey, who }) => (
    <label className="flex flex-wrap items-center gap-2 text-sm text-slate-700">場所
      <select className={control} value={value || ''} onChange={(e) => { onChange(e.target.value); setTrialTravel(null); }} data-lot-pair-zone={dataKey} aria-label={`${who}の場所`}>
        <option value="">未定</option>
        {zones.filter((z) => str(z.id) !== 'zone_unassigned').map((z) => <option key={z.id} value={z.id}>{str(z.name) || z.id}</option>)}
      </select>
      <span className="text-xs text-slate-600">{guess && guess.source ? `${SRC[guess.source]}${guess.source === 'history' ? `(同じテンプレの過去 ${guess.count}件の ${guess.share}%)` : ''}` : '居場所の記録なし'}</span>
    </label>
  );
  const aspectText = geo.aspectFrom === 'input' ? `縦幅は入れた値(縦横比 ${geo.aspect.toFixed(2)})` : geo.aspectFrom === 'image' ? `縦幅が未入力なので 図の縦横比 ${geo.aspect.toFixed(2)} と仮定(司令塔の枠は見る画面で縦横比が変わるので、縦幅を入れると正確)` : '縦幅が未入力なので 縦も横と同じ尺度と仮定';
  const condBox = (k, label) => (
    <label key={k} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={!!cond[k]} onChange={(e) => setCond((c) => ({ ...c, [k]: e.target.checked }))} data-full-pair-cond={k} />{label}</label>
  );

  return (
    <details className="rounded-xl border-2 border-slate-300 bg-white p-2" data-lot-pair-lab="1" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 font-bold text-slate-900">
        🚶 1人で2つのロットを掛け持ちしたら、2つとも全部終わるのが 何分早くなるか
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-bold text-slate-700">本番のロット2つ・全台が終わるまで計算・現場の指示は変えない</span>
        {index ? <span className="text-xs font-normal text-slate-600">自動運転があるロット {aListAll.length}件(工場に在る {presentN}件)</span> : <span className="text-xs font-normal text-slate-600">開いて条件を確認してから計算します</span>}
      </summary>
      {open && index ? (
        <div className="mt-2 flex min-w-0 flex-col gap-3" data-lot-pair-body="1">
          <header className="flex flex-col gap-1">
            <div className="text-xs font-bold tracking-widest text-sky-800">PARALLEL WORK · 全台完了までの前後比較</div>
            <p className="text-sm text-slate-700">A と B の2ロットを、<b>組まずに片方ずつ</b>(A→B と B→A の早い方)終わらせた時と、<b>1人で行き来して掛け持ち</b>した時を、両方とも <b>全台・全工程が終わるまで</b>並べて比べます。移動の時間・機械の取り合い・自動運転の間に離れられるか も入れて数えます。時間は本番の実績({modeText})・テンプレの目標・設定の自動時間から。計算は ChatGPT(Codex)の全台完了までの計算です。</p>
          </header>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 [&>*]:min-w-0">
            <section className="flex flex-col gap-2 rounded-xl border border-sky-200 bg-sky-50/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-black text-sky-900">A 自動運転があるロット({aListAll.length}件・工場に在る {presentN}件)</div>
                <label className="flex min-h-11 items-center gap-2 text-xs text-slate-700"><input type="checkbox" className="h-5 w-5" checked={groupSame} onChange={(e) => setGroupSame(e.target.checked)} />同じ品目コードテンプレ×台数は1つにまとめる</label>
              </div>
              <LotSelect value={A ? A.id : ''} options={aOptions} onPick={pickA} label="ロットA" dataKey="a" />
              {A ? (
                <div className="flex flex-col gap-1">
                  <ModelLabel model={A.lot.model} sub={tplName(A.lot.templateId)} modelClass="text-lg font-black text-slate-900" subClass="text-sm font-bold text-sky-900" />
                  <div className="text-sm text-slate-700">{A.lot.quantity || 1}台・{presText(A.presence)}{A.lot.dueDate ? `・納期 ${str(A.lot.dueDate)}` : ''}{orderOf(A.lot) ? `・指図 ${orderOf(A.lot)}` : ''}</div>
                  {zoneSelect({ value: zoneA, onChange: setZoneAPick, guess: zoneAPick ? { source: 'manual' } : A.zone, dataKey: 'a', who: 'ロットA' })}
                  {canWrite && zoneAPick && zoneAPick !== A.zone.zoneId ? <button type="button" className="min-h-11 self-start rounded-lg border border-sky-400 bg-white px-3 text-sm font-bold text-sky-900" onClick={() => saveTplZone(A.lot, zoneAPick)}>この区画を「{tplName(A.lot.templateId)}」の既定にする</button> : null}
                </div>
              ) : null}
            </section>
            <section className="flex flex-col gap-2 rounded-xl border border-teal-200 bg-teal-50/40 p-3">
              <div className="text-sm font-black text-teal-900">B 掛け持ちする相手のロット(工場に在る物・近い順)</div>
              {bOptions.length ? <LotSelect value={B ? B.id : ''} options={bOptions} onPick={pickB} label="ロットB" dataKey="b" /> : null}
              {B ? (
                <div className="flex flex-col gap-1">
                  <ModelLabel model={B.lot.model} sub={tplName(B.lot.templateId)} modelClass="text-lg font-black text-slate-900" subClass="text-sm font-bold text-teal-900" />
                  <div className="text-sm text-slate-700">{B.lot.quantity || 1}台・{presText(B.presence)}{orderOf(B.lot) ? `・指図 ${orderOf(B.lot)}` : ''}{B.lot.dueDate ? `・納期 ${str(B.lot.dueDate)}` : ''}</div>
                  {zoneSelect({ value: zoneB, onChange: setZoneBPick, guess: zoneBPick ? { source: 'manual' } : B.zone, dataKey: 'b', who: 'ロットB' })}
                  {canWrite && zoneBPick && zoneBPick !== B.zone.zoneId ? <button type="button" className="min-h-11 self-start rounded-lg border border-teal-400 bg-white px-3 text-sm font-bold text-teal-900" onClick={() => saveTplZone(B.lot, zoneBPick)}>この区画を「{tplName(B.lot.templateId)}」の既定にする</button> : null}
                </div>
              ) : <div className="text-sm text-slate-600">残りの工程があるロットがありません</div>}
            </section>
          </div>

          <section className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-violet-50/40 p-3" data-lot-pair-scale="1">
            <div className="text-sm font-black text-violet-900">区画どうしの距離</div>
            <div className="text-xs text-slate-700" data-lot-pair-geo={geoLoading ? 'loading' : (geo.basis || 'none')}>
              {geoLoading ? '座標: 司令塔の工場の図を読んでいます…(読み終わるまで 横幅・縦幅は入れられません)'
                : geo.basis === 'overview' ? `座標: 司令塔の工場の図に置いた点(${Object.keys(geo.points).length}区画)。${aspectText}`
                  : geo.basis === 'schematic' ? `座標: 製品の区画の図(${overview.state === 'error' ? `司令塔の図が読めませんでした: ${overview.error}` : '司令塔の図に点が無い'})。${aspectText}`
                    : '座標がありません(区画どうしの表に分数を入れてください)'}
            </div>
            <div className="text-sm text-slate-800" data-lot-pair-travel={Number.isFinite(pairTravel.min) ? (pairTravel.source || 'map') : 'trial'}>
              {zoneName(zoneA)} ↔ {zoneName(zoneB)}:{' '}
              {Number.isFinite(pairTravel.min)
                ? <>片道 <b>{pairTravel.min}分</b>{pairTravel.source === 'override' ? '(区画どうしの表)' : pairTravel.source === 'same' ? '(同じ区画の中の移動)' : `(地図で ${pairTravel.meters}m・歩く速さ ${cfg.walkMPerMin}m/分)`}</>
                : pairTravel.why === 'same' ? <>同じ区画です。「同じ区画の中の移動(片道)」が未入力なので、片道は下の棒で試せます。</>
                  : pairTravel.why === 'place' ? <>場所が未定です。上で場所を選ぶと地図から出します。</>
                    : pairTravel.why === 'coords' ? <>この区画は地図に点がありません。区画どうしの表に分数を入れてください。</>
                      : <>地図の横幅(m)がまだ入っていません。入るまでは 下の「片道の移動を試す」の値で計算します。</>}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col text-sm text-slate-700">{geo.basis === 'overview' ? '司令塔の地図の横幅(m)' : '区画の図の横幅(m)'}<input type="number" min="1" inputMode="decimal" className={`${control} w-32`} placeholder={cfg[widthKey] ? String(cfg[widthKey]) : '未入力'} value={scaleDraft.w} onChange={(e) => setScaleDraft((d) => ({ ...d, w: e.target.value }))} disabled={!canWrite || geoLoading} data-lot-pair-width="1" /></label>
              <label className="flex flex-col text-sm text-slate-700">縦幅(m・分かれば)<input type="number" min="1" inputMode="decimal" className={`${control} w-28`} placeholder={cfg[heightKey] ? String(cfg[heightKey]) : '未入力'} value={scaleDraft.h} onChange={(e) => setScaleDraft((d) => ({ ...d, h: e.target.value }))} disabled={!canWrite || geoLoading} data-lot-pair-height="1" /></label>
              <label className="flex flex-col text-sm text-slate-700">歩く速さ(m/分)<input type="number" min="1" inputMode="decimal" className={`${control} w-28`} placeholder={String(cfg.walkMPerMin)} value={scaleDraft.walk} onChange={(e) => setScaleDraft((d) => ({ ...d, walk: e.target.value }))} disabled={!canWrite} /></label>
              <label className="flex flex-col text-sm text-slate-700">同じ区画の中の移動(片道・分)<input type="number" min="0" step="0.5" inputMode="decimal" className={`${control} w-28`} placeholder={Number.isFinite(cfg.sameZoneMin) ? String(cfg.sameZoneMin) : '未入力'} value={scaleDraft.same} onChange={(e) => setScaleDraft((d) => ({ ...d, same: e.target.value }))} disabled={!canWrite} data-lot-pair-same="1" /></label>
              {canWrite ? <button type="button" className="min-h-11 rounded-lg bg-violet-700 px-4 font-bold text-white disabled:opacity-50" onClick={saveScale} disabled={geoLoading} data-lot-pair-save-scale="1">保存</button> : <span className="text-xs text-slate-600">入力は管理者だけ</span>}
              {canWrite && cfg[widthKey] ? <button type="button" className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-sm font-bold" onClick={() => clearScale(widthKey)}>横幅を消す</button> : null}
              {canWrite && cfg[heightKey] ? <button type="button" className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-sm font-bold" onClick={() => clearScale(heightKey)}>縦幅を消す</button> : null}
              {canWrite && Number.isFinite(cfg.sameZoneMin) ? <button type="button" className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-sm font-bold" onClick={() => clearScale('sameZoneMin')}>同じ区画の分数を消す</button> : null}
              {saveMsg ? <span className="text-sm font-bold text-violet-900" role="status">{saveMsg}</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
              <label>選んだ組の片道を試す（秒）
                <input type="number" min="0" max="1800" step="1" value={Number((travelMinNow * 60).toFixed(1))} onChange={(e) => { const seconds = Number(e.target.value); if (e.target.value === '') setTrialTravel(null); else if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 1800) setTrialTravel(seconds / 60); }} className={`${control} w-28`} data-lot-pair-trial="1" aria-label="片道の移動を試す(秒)" />
              </label>
                {[10, 30].map(seconds => <button type="button" key={seconds} className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-sm font-bold" onClick={() => setTrialTravel(seconds / 60)}>{seconds}秒で試す</button>)}
                {trialTravel != null ? <button type="button" className="min-h-11 rounded-lg border border-slate-400 bg-white px-3 text-sm font-bold" onClick={() => setTrialTravel(null)}>試すのをやめる</button>
                  : null}
                <span className="text-xs text-slate-600">{travelNoteNow}。この欄は選んだ1組だけに適用します。ほかの候補や共有の距離表は変わりません。</span>
            </div>
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-teal-200 bg-teal-50/40 p-2" data-lot-pair-mintrip="1">
              <label className="flex flex-col text-sm text-slate-700">行く価値がある最低の手作業(分)・掛け持ち案内の決まり
                <input type="number" min="0" step="0.5" inputMode="decimal" className={`${control} w-28`} placeholder={String(minTripNow)} value={minTripDraft} onChange={(e) => setMinTripDraft(e.target.value)} disabled={!canEdit} data-lot-pair-mintrip-input="1" /></label>
              <button type="button" className="min-h-11 rounded-lg bg-teal-700 px-4 font-bold text-white disabled:opacity-50" onClick={saveMinTrip} disabled={!canEdit} data-lot-pair-mintrip-save="1">この値にする</button>
              <span className="text-xs text-slate-600">いま {minTripNow}分。往復の歩きを引いて これより短くしか働けない往復は「行く」にしません(誰でも変えられます・全員に効きます)。</span>
            </div>
            <PairTable zones={zones} cfg={cfg} geo={geo} canEdit={canWrite} onSave={saveTable} />
          </section>

          <section className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50/40 p-3" data-full-pair-conditions="1">
            <div className="text-sm font-black text-amber-900">計算の前提(記録が無い所。変えると すぐ計算し直します)</div>
            <div className="grid gap-x-4 sm:grid-cols-2">
              {condBox('sameMachine', 'AとBで同じ機械を使う(取り合う)')}
              {condBox('mayLeave', '自動運転の間は 人が離れてよい')}
              {condBox('holdToNext', '機械を使う工程が続く時は 次の工程まで機械を押さえる（通常はON）')}
              <label className="flex min-h-11 items-center gap-2 text-sm">Aの完了が 組まない時より遅れてよい分
                <input type="number" min="0" step="5" inputMode="numeric" className={`${control} w-24`} value={cond.maxDelayA} onChange={(e) => setCond((c) => ({ ...c, maxDelayA: Math.max(0, Number(e.target.value) || 0) }))} aria-label="Aの完了が遅れてよい分" data-full-pair-delay="a" />分
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">Bの完了が 組まない時より遅れてよい分
                <input type="number" min="0" step="5" inputMode="numeric" className={`${control} w-24`} value={cond.maxDelayB} onChange={(e) => setCond((c) => ({ ...c, maxDelayB: Math.max(0, Number(e.target.value) || 0) }))} aria-label="Bの完了が遅れてよい分" data-full-pair-delay="b" />分
              </label>
            </div>
            <p className="text-xs text-slate-600">この組の前提は 下の結果の上に並べます(候補ごとに片道などが違うため、結果と同じ所に出す)。</p>
            <details><summary className="min-h-11 cursor-pointer font-bold">準備・取外しの機械使用を確認する（この比較だけ）</summary>
              <p className="text-sm">1台しか載せられない設備では、載せる・自動測定・取り外す工程を同じ機械使用にしてください。工程名からの推定は現場確認が必要です。実際に使う複数の号機の個別割付は未対応です。</p>
              {[A, B].filter(Boolean).map(row => <fieldset key={row.id} className="my-2 rounded border border-slate-300 p-2"><legend className="font-bold">{shortLabel(row)}</legend>
                {row.times.map(t => <label key={t.id} className="flex min-h-11 flex-wrap items-center gap-2 text-sm">{t.title}（{t.sec == null ? '時間未登録' : fmt(t.sec / 60) + '分'}）
                  {t.auto ? <b>自動・機械使用</b> : <select className={control} aria-label={shortLabel(row) + ' ' + t.title + 'の機械使用'} value={stepResources[row.id + ':' + t.id] == null ? 'source' : stepResources[row.id + ':' + t.id] ? 'machine' : 'bench'} onChange={e => setStepResources(v => { const next = { ...v }; if (e.target.value === 'source') delete next[row.id + ':' + t.id]; else next[row.id + ':' + t.id] = e.target.value === 'machine'; return next; })}>
                    <option value="source">登録・推定のまま（{t.machine ? '機械を使う' : '機械を使わない'}）</option><option value="machine">確認済み：機械を使う</option><option value="bench">確認済み：機械を使わない</option>
                  </select>}
                </label>)}
              </fieldset>)}
            </details>
          </section>

          <section className="fp-app fp-embed"><WorkingHoursFields value={hours} onChange={setHours} registeredSchedule={settings?.workSchedule} /></section>
          <section className="rounded-xl border border-orange-200 bg-orange-50 p-3">
            <label className="flex min-h-11 items-center gap-2 font-bold"><input type="checkbox" className="h-5 w-5" checked={arrivalMode} onChange={e => setArrivalMode(e.target.checked)} />到着する時刻の差も入れて比較する</label>
            <p className="text-sm">OFFは「両方そろっていたら」の試算。ONは基準時点から何分後に着手できるかを入れます。予定時刻になっても自動で到着済みにはしません。</p>
            {arrivalMode && <div className="flex flex-wrap gap-3">{[A, B].filter(Boolean).map(row => <label key={row.id} className="flex min-h-11 flex-wrap items-center gap-2 text-sm">{shortLabel(row)}：到着まで<input type="number" min="0" step="1" className={`${control} w-28`} aria-label={shortLabel(row) + 'の到着までの分'} placeholder={row.presence.present ? '到着済み 0' : '時刻未定'} value={arrivalOffsets[row.id] ?? (row.presence.present ? '0' : '')} onChange={e => setArrivalOffsets(v => ({ ...v, [row.id]: e.target.value }))} />分</label>)}</div>}
            {arrivalMode && <p className="text-sm">候補を広げた時も、到着時刻不明の相手は0分にせず「未計算」と表示します。未到着なら届いているロットを進め、実到着後は残作業から再計算する運用です。</p>}
          </section>
          <section className="rounded-xl border border-sky-200 bg-sky-50 p-3">
            <label className="flex min-h-11 flex-wrap items-center gap-2 font-bold">比較する相手の範囲<select className={control} value={candidateLimit} onChange={e => setCandidateLimit(Number(e.target.value))} aria-label="候補の比較範囲">
              <option value={1}>選んだ1組</option><option value={12}>時間の相性・距離から12組</option><option value={24}>範囲を広げて24組</option><option value={Math.max(25, bList.length)}>相手の候補をすべて（{bList.length}件）</option>
            </select></label>
            <p className="text-sm">Aは固定し、Bの候補{bList.length}件のうち最大{Math.min(candidateLimit, bList.length)}組を比較します。近さだけでなく、自動と手作業の時間も使って候補を選びます。順位は全台計算後の結果で決めます。全件は時間がかかるため途中で中止できます。</p>
          </section>

          {chosen && !chosen.ok ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status" data-full-pair-errors="1">
              <b>選んだ組は、次の条件を確認してください</b>
              <ul className="mt-1 list-disc pl-5">{chosen.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          ) : null}
          {candidates.length ? (
            <section className="fp-app fp-embed" data-full-pair="1">
              <FullPairComparison candidates={candidates} preferredKey={B ? B.id : null} />
            </section>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
