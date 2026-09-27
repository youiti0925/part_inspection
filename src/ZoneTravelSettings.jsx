// 🚶 区画どうしの片道(分)と「行く価値がある最低の手作業(分)」を誰でも変えられる口(部品検査・2026-09-27)
// -----------------------------------------------------------------------------
//  製品検査では操業シミュの画面(LotPairLab)の中に入力欄がある。部品には操業シミュが無いので、
//  マスタ設定の「作業エリア設定」の下に同じ置き場(settings.opsim.zoneTravel)へ書く欄を置く。
//  作業画面の掛け持ち案内(domain/juggleGuide.js)は この置き場をそのまま travelCfg として読む。
//  ・override: { 'A|B'(区画idを並べた鍵): 分 } — 入れた物が区画の名前の目安より優先
//  ・minTripWorkMin: 分 — 既定は 2分(MIN_TRIP_WORK_MIN)。清水さん「そのままでいいが誰でもすぐ変えられるように」
//  ⚠消した欄は null を書く(保存は合体(merge)なので、鍵を消しただけでは前の分数が残る)。null は読む時に「無い」と同じ。
// -----------------------------------------------------------------------------
import React, { useMemo, useState } from 'react';
import { walkSecOf, minTripWorkSecOf, MIN_TRIP_WORK_MIN } from './domain/juggleGuide.js';

const str = (v) => (v == null ? '' : String(v));

export default function ZoneTravelSettings({ settings, saveSettings, zones = [] }) {
  const cfg = (settings && settings.opsim && settings.opsim.zoneTravel) || {};
  const realZones = useMemo(() => (zones || []).filter((z) => z && z.id && str(z.id) !== 'zone_unassigned'), [zones]);
  const pairs = useMemo(() => {
    const out = [];
    for (let i = 0; i < realZones.length; i++) for (let j = i + 1; j < realZones.length; j++) {
      const a = realZones[i]; const b = realZones[j];
      out.push({ key: [str(a.id), str(b.id)].sort().join('|'), a, b });
    }
    return out;
  }, [realZones]);
  const [draft, setDraft] = useState({});
  const [minDraft, setMinDraft] = useState('');
  const [msg, setMsg] = useState('');

  const write = async (patch, okMsg) => {
    if (!saveSettings) { setMsg('保存できません(設定を書く口がありません)'); return false; }
    try {
      const r = await saveSettings({ opsim: { zoneTravel: { ...cfg, ...patch } } });
      if (r === false) { setMsg('保存できませんでした(通信か権限の理由。もう一度押してください)'); return false; }
    } catch (e) { setMsg(`保存できませんでした: ${(e && e.message) || e}`); return false; }
    setMsg(okMsg); return true;
  };
  const saveMin = () => {
    const n = Number(minDraft);
    if (minDraft === '' || !Number.isFinite(n) || n < 0) { setMsg('「行く価値がある最低の手作業」は 0以上の数(分)で入れてください'); return; }
    write({ minTripWorkMin: n }, `「行く価値がある最低の手作業」を ${n}分 にしました(作業画面の掛け持ち案内にすぐ効きます)`).then((ok) => { if (ok) setMinDraft(''); });
  };
  const saveTable = () => {
    const next = { ...(cfg.override || {}) };
    const bad = [];
    for (const [k, v] of Object.entries(draft)) {
      if (v === '' || v == null) { next[k] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) { bad.push(k); continue; }
      next[k] = n;
    }
    if (bad.length) { setMsg('0以上の数(分)でない欄があります'); return; }
    if (!Object.keys(draft).length) { setMsg('変えた欄がありません'); return; }
    write({ override: next }, '区画どうしの片道を保存しました').then((ok) => { if (ok) setDraft({}); });
  };
  const minNow = minTripWorkSecOf(cfg) / 60;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-3" data-zone-travel-settings>
      <h3 className="text-xl font-bold text-slate-800 mb-1">🚶 区画どうしの片道・掛け持ちの決まり</h3>
      <p className="text-xs text-slate-600 mb-3">作業画面の掛け持ち案内(自動運転の待ちに 他のロットの手作業を出す)が使います。すぐ保存され、誰でも変えられます。</p>
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <span className="font-bold text-slate-700">行く価値がある最低の手作業</span>
        <span className="text-slate-600">いま {minNow}分{cfg.minTripWorkMin == null ? `(既定 ${MIN_TRIP_WORK_MIN}分)` : ''}</span>
        <input type="number" min="0" step="0.5" inputMode="decimal" value={minDraft} onChange={(e) => setMinDraft(e.target.value)} placeholder="分" className="w-20 border rounded px-2 py-1 min-h-11" aria-label="行く価値がある最低の手作業(分)" />
        <button type="button" onClick={saveMin} className="min-h-11 px-3 rounded-lg bg-blue-600 text-white font-bold text-sm hover:bg-blue-700">変える</button>
      </div>
      {pairs.length === 0 ? (
        <div className="text-sm text-slate-500">区画が2つ以上ありません(上の作業エリア設定で足すと ここに組が出ます)。</div>
      ) : (
        <>
          <div className="text-xs text-slate-600 mb-1">片道(分)。空欄は「区画の名前の目安」(中間・完品 10秒 など)を使い、目安も無ければ「不明」と出します。</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 max-h-80 overflow-auto">
            {pairs.map(({ key, a, b }) => {
              const saved = cfg.override && cfg.override[key];
              const guess = walkSecOf({ a: a.id, b: b.id, zones: realZones, travel: null });
              const val = key in draft ? draft[key] : (saved == null ? '' : String(saved));
              return (
                <label key={key} className="flex items-center gap-2 text-sm bg-slate-50 rounded px-2 py-1">
                  <span className="flex-1 min-w-0 truncate" title={`${str(a.name) || a.id} ⇄ ${str(b.name) || b.id}`}>{str(a.name) || a.id} ⇄ {str(b.name) || b.id}</span>
                  <input type="number" min="0" step="0.1" inputMode="decimal" value={val} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} placeholder={guess.sec != null ? `目安 ${Math.round(guess.sec / 6) / 10}` : '不明'} className="w-20 border rounded px-2 py-1 min-h-11" aria-label={`${str(a.name) || a.id} と ${str(b.name) || b.id} の片道(分)`} />
                  <span className="text-xs text-slate-500">分</span>
                </label>
              );
            })}
          </div>
          <button type="button" onClick={saveTable} className="mt-2 min-h-11 px-3 rounded-lg bg-emerald-600 text-white font-bold text-sm hover:bg-emerald-700">片道を保存する</button>
        </>
      )}
      {msg && <div className="mt-2 text-sm font-bold text-slate-700" role="status">{msg}</div>}
    </div>
  );
}
