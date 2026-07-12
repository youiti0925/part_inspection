// 分割測定アプリ(rotary_table)から送信された測定結果の閲覧パネル（読み取り専用）
// 連携: 分割測定アプリのセーブ時に
//   artifacts/product-inspection-v1/public/data/rotaryMeasurements/{機番_日時}
// へ結果が書き込まれる。ここはそれをリアルタイム購読して表示するだけ（書き込み一切なし）。
import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, orderBy, query, limit } from 'firebase/firestore';
import { Ruler, Search, Loader2, AlertTriangle, CheckCircle2, Thermometer, User, Calendar, FileImage } from 'lucide-react';

const APP_DATA_ID = 'product-inspection-v1';

// 判定バッジ (OK=緑 / NG=赤 / その他=グレー)
const JudgeBadge = ({ j }) => {
  const ng = j === 'NG';
  const ok = j === 'OK';
  return (
    <span className={`px-2 py-0.5 rounded-md text-xs font-bold text-white ${ng ? 'bg-rose-600' : ok ? 'bg-emerald-500' : 'bg-slate-400'}`}>
      {j || '—'}
    </span>
  );
};

export default function RotaryMeasurementsPanel({ db }) {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [zoom, setZoom] = useState(false); // グラフ画像の拡大

  // パネルを開いた時だけ購読 (常時購読しない=読み取りコスト/負荷を抑える)
  useEffect(() => {
    if (!db) return;
    setLoading(true);
    const q = query(
      collection(db, 'artifacts', APP_DATA_ID, 'public', 'data', 'rotaryMeasurements'),
      orderBy('savedAtEpoch', 'desc'),
      limit(100)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setItems(snap.docs.map((d) => ({ ...d.data(), id: d.id })));
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('rotaryMeasurements subscribe failed', err);
        setError(err?.message || '読み込みに失敗しました');
        setLoading(false);
      }
    );
    return () => unsub();
  }, [db]);

  // 検索 (型式・機番・測定者・モード)
  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((m) =>
      `${m.model || ''} ${m.machine || ''} ${m.operator || ''} ${m.mode || ''}`.toLowerCase().includes(kw)
    );
  }, [items, search]);

  const ngCount = useMemo(() => items.filter((m) => m.judgement === 'NG').length, [items]);

  // 選択が一覧から消えた/未選択なら先頭を選ぶ
  useEffect(() => {
    if (filtered.length === 0) { setSelected(null); return; }
    if (!selected || !filtered.some((m) => m.id === selected.id)) setSelected(filtered[0]);
  }, [filtered]); // eslint-disable-line react-hooks/exhaustive-deps

  const savedLabel = (m) => m.savedAt || (m.savedAtEpoch ? new Date(m.savedAtEpoch).toLocaleString('ja-JP') : '');

  return (
    <div className="space-y-3">
      {/* ヘッダー: 説明 + 件数 + 検索 */}
      <div className="bg-cyan-50 border border-cyan-200 rounded-xl p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 justify-between">
          <div className="flex items-center gap-2 text-sm text-cyan-900">
            <Ruler className="w-5 h-5 text-cyan-600 shrink-0" />
            <span>
              <b>分割測定アプリ</b>から送信された測定結果（精度・バックラッシ・判定・グラフ）。
              セーブと同時に自動で届きます。<span className="text-cyan-700">この画面は閲覧専用です。</span>
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xs text-slate-600">全 <b>{items.length}</b> 件（直近100件）</span>
            {ngCount > 0 && (
              <span className="text-xs font-bold text-rose-600 flex items-center gap-1">
                <AlertTriangle className="w-4 h-4" /> NG {ngCount} 件
              </span>
            )}
          </div>
        </div>
        <div className="mt-2 relative max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="型式・機番・測定者・モードで検索"
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-400"
          />
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 text-slate-500 py-16">
          <Loader2 className="w-5 h-5 animate-spin" /> 読み込み中…
        </div>
      )}
      {error && !loading && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-4 text-sm">
          読み込みエラー: {error}
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="text-center text-slate-400 py-16">
          <Ruler className="w-10 h-10 mx-auto mb-2 opacity-40" />
          測定データはまだありません。<br />
          <span className="text-xs">分割測定アプリ側で <code className="bg-slate-100 px-1 rounded">webapp_sync_enabled</code> を true にしてセーブすると、ここに届きます。</span>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="flex flex-col lg:flex-row gap-3">
          {/* 左: 一覧 */}
          <div className="lg:w-80 shrink-0 max-h-[72vh] overflow-auto space-y-1.5 pr-1">
            {filtered.map((m) => {
              const active = selected?.id === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => setSelected(m)}
                  className={`w-full text-left p-2.5 rounded-xl border transition ${active ? 'border-cyan-400 bg-cyan-50 ring-1 ring-cyan-300' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <b className="text-sm text-slate-800 truncate">{m.model || '型式?'} / {m.machine || '機番?'}</b>
                    <JudgeBadge j={m.judgement} />
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                    {[m.mode, m.operator, m.temperature != null ? `${m.temperature}°C` : null].filter(Boolean).join(' ／ ')}
                  </div>
                  <div className="text-[11px] text-slate-400">{savedLabel(m)}</div>
                </button>
              );
            })}
            {filtered.length === 0 && <div className="text-center text-slate-400 text-sm py-8">該当なし</div>}
          </div>

          {/* 右: 詳細 */}
          {selected && (
            <div className="flex-1 min-w-0 bg-white border border-slate-200 rounded-xl p-4 max-h-[72vh] overflow-auto">
              <div className="flex items-center flex-wrap gap-2 mb-1">
                <h3 className="text-lg font-bold text-slate-800">
                  {selected.model || '型式?'} ／ 機番 {selected.machine || '?'}
                </h3>
                <JudgeBadge j={selected.judgement} />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 mb-3">
                {selected.mode && <span>モード: {selected.mode}</span>}
                {selected.operator && <span className="flex items-center gap-1"><User className="w-3.5 h-3.5" />{selected.operator}</span>}
                {selected.temperature != null && <span className="flex items-center gap-1"><Thermometer className="w-3.5 h-3.5" />{selected.temperature}°C</span>}
                {savedLabel(selected) && <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{savedLabel(selected)}</span>}
              </div>

              {selected.comment && (
                <div className="text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3">
                  <span className="text-slate-400 text-xs">コメント</span><br />{selected.comment}
                </div>
              )}

              {selected.plotPng && (
                <div className="mb-3">
                  <img
                    src={`data:image/png;base64,${selected.plotPng}`}
                    alt="測定グラフ"
                    onClick={() => setZoom(true)}
                    className="max-w-full border border-slate-300 rounded-lg cursor-zoom-in"
                  />
                  <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5"><FileImage className="w-3.5 h-3.5" />クリックで拡大</div>
                </div>
              )}

              {Array.isArray(selected.results) && selected.results.length > 0 ? (
                <table className="w-full text-sm border-collapse">
                  <tbody>
                    {selected.results.map((r, i) => {
                      const isNg = String(r.value ?? '').startsWith('NG');
                      return (
                        <tr key={i} className={isNg ? 'bg-rose-50' : ''}>
                          <td className="border border-slate-200 px-2 py-1 text-slate-600 whitespace-nowrap">{r.item}</td>
                          <td className={`border border-slate-200 px-2 py-1 font-mono ${isNg ? 'text-rose-600 font-bold' : 'text-slate-800'}`}>
                            {isNg ? <span className="inline-flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{r.value}</span> : r.value}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="text-sm text-slate-400">結果データなし</div>
              )}

              {(selected.filePath || selected.savePath || selected.path) && (
                <div className="text-[11px] text-slate-400 mt-3 break-all">
                  保存先: {selected.filePath || selected.savePath || selected.path}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* グラフ拡大オーバーレイ */}
      {zoom && selected?.plotPng && (
        <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4" onClick={() => setZoom(false)}>
          <img src={`data:image/png;base64,${selected.plotPng}`} alt="測定グラフ(拡大)" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  );
}
