// ============================================================================
// 🛟 画面が真っ白になるのを止める受け皿
// ----------------------------------------------------------------------------
// なぜ要るか:
//   React は描画の途中で例外が出ると、**画面を丸ごと消す**(何も表示しない)。
//   受け皿(ErrorBoundary)が1つも無いと、原因が何であれ結果は必ず「真っ白」になる。
//   現場からは「開いたら白い」としか言えず、こちらは何も分からない。
//   2026-07-28 の申告(白画面・文字サイズを触ると白くなる)がまさにこれ。
//
// ここが引き受けること:
//   ① 白紙にしない。日本語で「何が起きたか」「次にどうするか」を出す。
//   ② 現場がそのまま押せる出口を置く(読み込み直す / 前の画面に戻る)。
//   ③ 原因を端末に残す。次に開いた時に「前回落ちた記録」として拾える。
//      ⚠残すのは **技術的な内容だけ**(どこで落ちたか)。検査データ・写真・氏名は残さない。
//
// 引き受けられないこと(正直に書いておく):
//   ・await の中で起きた失敗、setTimeout の中の失敗、購読の受け手の失敗は
//     React の描画ではないのでここには来ない。→ window の onerror 側で拾って記録する。
//   ・メモリ切れでタブごと落ちた場合は、JavaScript が動けないので何も出せない。
// ============================================================================
import { Component } from 'react';

export const CRASH_LOG_KEY = 'app.lastCrash.v1';

/** 技術的な内容だけを残す。⚠検査データ・写真・氏名を入れないこと。 */
export const recordCrash = (where, err) => {
  try {
    localStorage.setItem(CRASH_LOG_KEY, JSON.stringify({
      at: new Date().toISOString(),
      where,
      name: err?.name || '',
      message: String(err?.message || err || '').slice(0, 500),
      stack: String(err?.stack || '').slice(0, 2000),
      url: location.pathname + location.search,
      ua: navigator.userAgent.slice(0, 200),
    }));
  } catch { /* 残せなくても画面は出す */ }
};

/** 前回落ちた記録(無ければ null)。 */
export const readLastCrash = () => {
  try { return JSON.parse(localStorage.getItem(CRASH_LOG_KEY) || 'null'); } catch { return null; }
};
export const clearLastCrash = () => { try { localStorage.removeItem(CRASH_LOG_KEY); } catch { /* noop */ } };

/**
 * 描画の外で起きた失敗も記録する(await の中・タイマーの中)。
 * ⚠画面は止めない。**記録するだけ**。ここで画面を止めると、今まで動いていたものまで止まる。
 */
export const watchGlobalErrors = () => {
  if (typeof window === 'undefined' || window.__crashWatchOn) return;
  window.__crashWatchOn = true;
  window.addEventListener('error', (e) => recordCrash('window.error', e?.error || e?.message));
  window.addEventListener('unhandledrejection', (e) => recordCrash('unhandledrejection', e?.reason));
};

export class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }

  static getDerivedStateFromError(err) { return { err }; }

  componentDidCatch(err, info) {
    recordCrash(this.props.where || 'render', err);
    // ⚠console にも必ず出す。開発者ツールを開いてもらえば、そのまま原因が分かる。
    console.error('[画面の描画で例外]', this.props.where || '', err, info?.componentStack);
  }

  render() {
    const { err } = this.state;
    if (!err) return this.props.children;

    // ⚠一部分だけを囲んでいる場合(モーダルなど)は、小さく出して周りを生かす。
    if (this.props.compact) {
      return (
        <div className="m-3 p-4 rounded-xl border-2 border-rose-300 bg-rose-50 text-rose-800">
          <div className="font-black mb-1">この部分だけ表示できませんでした</div>
          <div className="text-sm mb-3">ほかの画面はそのまま使えます。閉じて開き直すと直ることがあります。</div>
          <button onClick={() => this.setState({ err: null })}
            className="bg-rose-600 text-white px-4 py-2 rounded-lg font-bold">もう一度開く</button>
          <details className="mt-3 text-xs opacity-70"><summary>技術的な内容</summary>
            <pre className="whitespace-pre-wrap break-all">{String(err?.message || err)}</pre></details>
        </div>
      );
    }

    const detail = `${err?.name || ''}: ${String(err?.message || err)}\n${String(err?.stack || '').slice(0, 1200)}`;
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: '#f8fafc', fontFamily: 'sans-serif' }}>
        <div style={{ maxWidth: 620, width: '100%', background: '#fff', border: '2px solid #fecdd3', borderRadius: 16, padding: 24, boxShadow: '0 10px 30px rgba(0,0,0,.08)' }}>
          <div style={{ fontSize: 40, lineHeight: 1 }}>🛟</div>
          <h1 style={{ fontSize: 22, fontWeight: 900, margin: '12px 0 4px', color: '#9f1239' }}>画面を表示できませんでした</h1>
          <p style={{ color: '#334155', margin: '0 0 4px' }}>
            <b>作業の記録は消えていません。</b>保存済みの内容はサーバに残っています。
          </p>
          <p style={{ color: '#334155', margin: '0 0 16px' }}>
            まず「読み込み直す」を押してください。それでも同じ画面が出る場合は、下の内容を控えて連絡してください。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => location.reload()}
              style={{ background: '#e11d48', color: '#fff', border: 0, borderRadius: 10, padding: '12px 20px', fontWeight: 800, fontSize: 16, cursor: 'pointer' }}>
              読み込み直す
            </button>
            <button onClick={() => { try { navigator.clipboard.writeText(detail); } catch { /* noop */ } }}
              style={{ background: '#e2e8f0', color: '#0f172a', border: 0, borderRadius: 10, padding: '12px 20px', fontWeight: 800, fontSize: 16, cursor: 'pointer' }}>
              内容をコピー
            </button>
          </div>
          <details style={{ marginTop: 16, color: '#64748b', fontSize: 12 }}>
            <summary style={{ cursor: 'pointer' }}>技術的な内容(連絡するときに使います)</summary>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 8 }}>{detail}</pre>
          </details>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
