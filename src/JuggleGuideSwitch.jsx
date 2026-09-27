// 🚶 掛け持ち案内(作業画面に出る「自動測定の待ちの間に別のロットへ行って戻る」案内)の ON/OFF。
//   2026-09-27 清水さん「並列シミュレーションがいきなり現場の作業画面で出てきたらびっくりするから ON/OFF つけて OFF にしておいて」。
//   置き場所: settings.juggleGuide.enabled。**書いていない(undefined)は OFF**。ON にした時だけ作業画面に出る。
//   OFF の時は、作業画面の「移る」の案内と「↩ 戻る」を出さない(前からある「別エリアの自動測定」の小窓はそのまま)。
import { useState } from 'react';
import { juggleGuideOn } from './domain/juggleGuideSwitch.js';

export function JuggleGuideSwitch({ settings, saveSettings }) {
  const on = juggleGuideOn(settings);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const toggle = async () => {
    if (busy || !saveSettings) return;
    setBusy(true); setErr('');
    try {
      await saveSettings({ juggleGuide: { ...((settings && settings.juggleGuide) || {}), enabled: !on } });
    } catch {
      setErr('保存できませんでした。もう一度押してください。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-3" data-juggle-switch>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-bold text-base text-slate-800">🚶 掛け持ち案内(作業画面)</h3>
          <p className="text-xs text-slate-500 mt-1">
            自動測定の待ちの間に「別のロットへ行って戻る」案内と「↩ 戻る」を作業画面に出します。
            OFF の間は作業画面に出ません(計算も走りません)。
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={busy || !saveSettings}
          aria-pressed={on}
          data-juggle-switch-button
          className={`min-h-11 px-4 rounded-lg text-sm font-black border ${on ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-slate-100 text-slate-600 border-slate-300'} ${busy ? 'opacity-60' : ''}`}
        >
          {on ? 'ON(出す)' : 'OFF(出さない)'}
        </button>
      </div>
      {err && <p className="text-xs text-rose-600 mt-2">{err}</p>}
    </div>
  );
}

export default JuggleGuideSwitch;
