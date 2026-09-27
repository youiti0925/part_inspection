// =============================================================================
//  src/opsim/Toolbox.jsx — 🧰 道具箱。散らばっていた道具を1つの引き出しに集める
// -----------------------------------------------------------------------------
//  🚨 2026-09-18 清水さんの言葉
//    「いろんなところに機能が散らばりすぎてる、整理整頓しないとダメだと思う」
//    「処理が中途はんぱすぎるよ」
//    絵の元: scratchpad/design2/Toolbox.dc.html（案A 本命・Claude Design のキャンバス）。
//
//  🚨🚨 **1つも消していない**（決まり6・19「情報は移す・畳む・強さを変える。消さない」）。
//    ここは **入れ物だけ**。中身は今まで画面に居た部品を 呼ぶ側が children で渡す。
//    ＝ 同じ部品が2つに増える事は無い（コピーを作らない）。
//
//  🚨 引き出しは LotDrawer と同じ形（fixed・×／背景／Esc で閉じる・広い画面は右から）。
//    盤の場所を1pxも取らない。押しただけでは1回も計算しない。
//  🚨 hooks は必ずガード（`if (!open) return null`）より **上**（2026-08-27 の事故の形）。
//  🚨 px を1つも直書きしない（rem 段のクラスだけ。幅の上限も md:w-[min(35rem,96vw)] と rem で書く。
//    LotDrawer と同じ書き方に揃える＝既存の例外）。押す物は min-h-11、文字は text-2xs 以上。
//  🚨 製品検査と最終検査で **同じファイル**（md5 一致）。どちらのアプリの事情も import しない。
// =============================================================================
import React, { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * 道具箱の6つの箱。**この並びが画面の並び**（絵の Toolbox.dc.html と同じ順）。
 * 🚨 鍵を増やす・減らす時は、呼ぶ側と見張り(opsim/__tests__/toolbox.test.mjs)も一緒に直す事。
 */
const TOOLBOX_SECTIONS = Object.freeze([
  {
    key: 'clock',
    icon: '⏱',
    title: '時間を進める',
    sub: '盤の記録を選ぶだけ。押しても計算し直しません',
  },
  {
    key: 'keep',
    icon: '🧷',
    title: '決めた物を守る',
    sub: '答えが揺れない為の既定。手が付いたロットは実際の担当のまま',
  },
  {
    key: 'shared',
    icon: '👥',
    title: '両方の工場で働ける人',
    sub: '営業日の札で1日ずつ、どちらで働くかを決めます',
  },
  {
    key: 'remedy',
    icon: '🕒',
    title: '納期を守る手',
    sub: '残業・土曜・はしご・条件くらべ',
  },
  {
    key: 'gear',
    icon: '⚙',
    title: '設定と根拠',
    sub: '見る範囲・工数の見方・仮の入荷日・区画・設備・個人設定・数字の意味・読み書き',
  },
  {
    key: 'flow',
    icon: '▶',
    title: 'ロットの流れ（動く盤）',
    sub: '見せ方の1つ。1つの問いには答えないので ここへ移しました',
  },
]);

/** 1つの箱。中身が渡っていない時も 箱は出す（在るはずの道具が黙って消えない）。 */
function Section({ spec, body }) {
  return (
    <section
      data-opsim-toolbox-section={spec.key}
      className="flex flex-col gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-black text-slate-900">{`${spec.icon} ${spec.title}`}</span>
        <span className="text-2xs leading-snug text-slate-500">{spec.sub}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {body == null || body === false
          ? (
            <span className="text-2xs text-slate-500">
              この道具は、この画面にはまだ渡っていません（作りかけです。ここに出る予定の物は上の1行です）
            </span>
          )
          : body}
      </div>
    </section>
  );
}

/**
 * @param {boolean} props.open  開いているか（持つのは親。押しただけでは何も計算しない）
 * @param {Function} props.onClose 閉じる（🚨 閉じるだけ。ここから確定へ行く道は1本も無い）
 * @param {object|null} props.sections { clock, keep, shared, remedy, gear, flow } の中身
 * @param {string} props.note 見出しの横の1行（呼ぶ側が渡した文字をそのまま出す）
 */
export function Toolbox({ open = false, onClose = null, sections = null, note = '' }) {
  // 🚨 hooks はガードより上（ガードの後ろに足すと "Rendered fewer hooks" で画面が丸ごと落ちる）。
  useEffect(() => {
    if (!open) return undefined;
    if (typeof window === 'undefined') return undefined;
    const onKey = (e) => {
      if (!e) return;
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (typeof onClose === 'function') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const close = () => { if (typeof onClose === 'function') onClose(); };
  const body = (sections && typeof sections === 'object') ? sections : {};

  return (
    <>
      {/* 背景。押すと閉じるだけ（何も決まらない・何も送らない）。
          🚨 2026-08-21 の事故（背景タップが取り消せない確定を焼き付けた）と同じ形を作らない。 */}
      <div
        className="fixed inset-0 z-[300] bg-slate-900/25"
        onClick={close}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="道具箱"
        data-opsim-toolbox={String(TOOLBOX_SECTIONS.length)}
        className={[
          'fixed z-[301] flex flex-col bg-slate-50 shadow-2xl',
          'inset-x-0 bottom-0 max-h-[88vh] rounded-t-2xl border-t border-slate-300',
          'md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none',
          'md:w-[min(35rem,96vw)] md:rounded-t-none md:border-l md:border-t-0 md:border-slate-300',
        ].join(' ')}
      >
        <div className="flex shrink-0 items-start gap-2 border-b border-slate-200 bg-white px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-black leading-tight text-slate-900">🧰 道具箱</div>
            <div className="mt-0.5 text-2xs leading-snug text-slate-500">
              {note || '散らばっていた道具を全部ここへ集めました。開いただけでは1回も計算しません'}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="閉じる"
            title="道具箱を閉じます。閉じても、何かが決まったり送られたりする事はありません。"
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 hover:bg-slate-50"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
          {TOOLBOX_SECTIONS.map((spec) => (
            <Section key={spec.key} spec={spec} body={body[spec.key]} />
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * 🧰 道具箱 を開くボタン。札に状態を出す（開いているか・いくつ入っているか）。
 * 🚨 押しただけでは1回も計算しない（開け閉めだけ）。
 */
export function ToolboxButton({ open = false, onToggle = null, count = TOOLBOX_SECTIONS.length }) {
  return (
    <button
      type="button"
      data-opsim-toolbox-toggle={open ? 'open' : 'closed'}
      aria-expanded={open}
      onClick={() => { if (typeof onToggle === 'function') onToggle(); }}
      title={'時間を進める・決めた物を守る・両方の工場で働ける人・納期を守る手・設定と根拠・ロットの流れ'
        + ' の6つを、右から出る引き出しに集めてあります。開いただけでは1回も計算しません。'}
      className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-2.5 text-2xs font-black ${open
        ? 'border-slate-900 bg-slate-900 text-white'
        : 'border-slate-300 bg-white text-slate-700 hover:border-cyan-400 hover:text-cyan-700'}`}
    >
      {`🧰 道具箱（${Number(count) || 0}）${open ? ' ▴' : ' ▾'}`}
    </button>
  );
}

export default Toolbox;
