// ============================================================================
// ❓ 数字の「？」と ⚙ の引き出し — 製品検査 操業シミュレーション
// ----------------------------------------------------------------------------
// 清水さん(2026-09-04 昼・原文):「条件根拠も全くわからん何のためにあるの？何を伝えたいの？」
// 決まり19C: 条件・根拠は画面としては無くす。**中身は1つも消さずに**
//   ①各数字の「？」 ②⚙ の引き出し へ移す。
//
// 🚨 この画面の一番大事な決まり:
//   「？」は **押した数字1つの根拠だけ** を出します。
//   全部の設定を並べたら、条件・根拠タブが小さくなって戻って来るだけ＝元の木阿弥です。
//   だから ⚙（設定）と「？」（根拠）は **中身が1つも重なりません**。
//   見張り(scripts/opsim-basis-move-guard.mjs)がそれを数えています。
//
// 🚨 「？」の中の順番は、清水さんに説明する順番そのままにします:
//   大きい数 → どこから来たか（関数名を書かない・現場の言葉で）→ 内訳 →
//   分かっていない事 → 次にやる事。
//
// 🚨 px を1つも直書きしません（全部 rem 段のクラス）。zoom / transform:scale も使いません。
// 🚨 この部品はデータを1バイトも書きません（書く道具を import すらしていません）。
// ============================================================================
import React from 'react';
import { HelpCircle, X, Settings, ChevronDown } from 'lucide-react';
import { WHY_TOPICS, BASIS_ITEMS, UNDECIDED_NOTES, tallyMoves, itemsForWhy } from './basisRegistry.js';

// ⚠ 2026-09-05: 使う所(部品の中)より上に置く(eslint no-use-before-define。TDZ で盤が落ちた日の後始末)。
const MOVE_LABEL = Object.freeze({
  gear: '⚙ 設定',
  gearTech: '⚙ 技術',
  strip: '上の帯',
  board: '盤面に常設',
  undecided: '決まりません',
  'why:idleMinutes': '？手が空く',
  'why:capacity': '？働ける時間',
  'why:estimate': '？工数',
  'why:arrivalAssumed': '？仮の入荷日',
  'why:stale': '？対象外',
  'why:finish': '？終わる見込み',
  'why:worker': '？担当と力量',
});

/** 引き出しの外枠。中身は開いた時だけ作ります（閉じている間は1文字も描きません）。 */
function Sheet({ open, title, onClose, children, tone = 'cyan' }) {
  if (!open) return null;
  const head = tone === 'slate' ? 'bg-slate-700' : 'bg-cyan-700';
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 p-2"
      // 🚨 背景タップで取り消せない確定はしません（2026-08-21）。ここは「閉じる」だけなので背景で閉じてよい。
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] overflow-auto rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={`sticky top-0 flex items-center gap-2 ${head} px-3 py-2 text-white`}>
          <span className="text-sm font-black leading-tight">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex items-center gap-1 min-h-11 px-3 rounded-lg bg-white/15 text-2xs font-bold hover:bg-white/25"
          >
            <X className="w-3.5 h-3.5" />
            閉じる
          </button>
        </div>
        <div className="p-3 flex flex-col gap-3">{children}</div>
      </div>
    </div>
  );
}

/** 畳み。技術の話を一番下に置く為の物。既定は閉じています。 */
function Fold({ summary, children }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 min-h-11 px-3 text-left text-2xs font-bold text-slate-500"
      >
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        {summary}
      </button>
      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}

/**
 * 数字の横に付く小さい「？」。
 *
 * 使い方: <Why topic="capacity" value="7.0h" />
 *   topic … WHY_TOPICS の鍵。無い鍵を書いたら **何も描かず**、見張りが赤にします。
 *   value … いま画面に出ている数字そのもの（引き出しの一番上に大きく出す物）。
 *           🚨 ここで数え直しません。画面に出ている物をそのまま貰います。
 *   detail… その場面だけの追記（内訳の実数など）。無ければ出しません。
 */
export function Why({ topic, value = null, detail = null, label = null }) {
  const [open, setOpen] = React.useState(false);
  const t = WHY_TOPICS[topic];
  if (!t) return null;
  const moved = itemsForWhy(topic);
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={`${t.title}：この数字がどこから来たか`}
        aria-label={`${t.title}の根拠をひらく`}
        data-opsim-why={topic}
        className="inline-flex items-center justify-center min-h-11 min-w-11 rounded-lg text-slate-400 hover:text-cyan-700 hover:bg-cyan-50"
      >
        <HelpCircle className="w-4 h-4" />
      </button>

      <Sheet open={open} title={`❓ ${label || t.title}`} onClose={() => setOpen(false)}>
        {/* ① 大きい数 ＝ 押した数字そのもの */}
        <div className="rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-2.5">
          <div className="text-2xs font-bold text-cyan-800">{t.lead}</div>
          {value == null ? null : (
            <div className="mt-1 text-2xl font-black tabular-nums leading-none text-cyan-900">{value}</div>
          )}
        </div>

        {/* ② どこから来たか（関数名を書かない） */}
        <div>
          <div className="text-2xs font-black text-slate-500">どこから来た数ですか</div>
          <div className="mt-0.5 text-xs leading-snug text-slate-700">{t.from}</div>
        </div>

        {/* ③ 内訳 */}
        <div>
          <div className="text-2xs font-black text-slate-500">この数を作っている物</div>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {t.parts.map((p) => (
              <li key={p} className="flex items-start gap-1.5 text-xs leading-snug text-slate-700">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          {detail ? <div className="mt-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs leading-snug text-slate-700">{detail}</div> : null}
        </div>

        {/* ④ 分かっていない事 — 黙って0にしない */}
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <div className="text-2xs font-black text-amber-800">分かっていない事</div>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {t.unknown.map((u) => (
              <li key={u} className="text-xs leading-snug text-amber-900">{u}</li>
            ))}
          </ul>
        </div>

        {/* ⑤ 次にやる事 */}
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-snug text-slate-700">
          <b className="text-2xs text-slate-500">次にやる事</b>
          <div className="mt-0.5">{t.next}</div>
        </div>

        {/* 引っ越しの証拠。元の「条件・根拠」の何行がここへ入ったか。 */}
        {moved.length ? (
          <div className="text-3xs leading-snug text-slate-400">
            もとの「条件・根拠」から、この「？」へ {moved.length}行 移しました：
            {moved.map((m) => m.label).join(' ／ ')}
          </div>
        ) : null}
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
//  ⚙ の引き出し — **設定だけ**。数字は1つも出しません。
// ---------------------------------------------------------------------------
/**
 * 🚨 ここに数字（結果）を置かないでください。置いた瞬間に条件・根拠タブが戻って来ます。
 *   数字は「？」の側です。見張りが「設定が？に混ざっていない／数字が⚙に出ていない」を数えます。
 *
 * 中身は親から `slots` で受け取ります（設定の部品そのものは、いま在る物をそのまま入れる）。
 *   slots.controls   … 見る範囲・何日先まで・工数の見方・仮の入荷日（BasisControls）
 *   slots.assumption … 仮定を置いて比べる（AssumptionCard）
 *   slots.evidence   … 根拠・データ監査（EvidenceCard）
 *   slots.tech       … かかった時間・段ごとのms（🚨 一番下に畳む）
 */
export function GearDrawer({ open, onClose, slots = {} }) {
  const tally = tallyMoves();
  const total = BASIS_ITEMS.length;
  return (
    <Sheet open={open} title="⚙ 設定（この見立ての条件）" onClose={onClose} tone="slate">
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-2xs leading-snug text-slate-600">
        ここは<b>設定だけ</b>です。押すと結果が変わります。
        <b>数字の意味</b>は、画面の数字の横にある <span className="font-black text-cyan-700">？</span> を押すと出ます。
      </div>

      {slots.controls ? <div>{slots.controls}</div> : null}
      {slots.assumption ? <div>{slots.assumption}</div> : null}
      {slots.evidence ? <div>{slots.evidence}</div> : null}

      {/* 🚨 決まりません（1行で言えなかった物）。消さずに、聞く形で残します。 */}
      <UndecidedNotice />

      {/* 引っ越しの証拠（移した数 == 元の数） */}
      <Fold summary={`もとの「条件・根拠」${total}行の行き先（1行も消していません）`}>
        <div className="flex flex-col gap-0.5">
          {BASIS_ITEMS.map((it) => (
            <div key={it.id} className="flex items-start gap-1.5 text-3xs leading-snug">
              <span className="w-24 shrink-0 font-bold text-slate-400">{MOVE_LABEL[it.to] || it.to}</span>
              <span className="text-slate-600">{it.label}</span>
              {it.shown ? null : <span className="shrink-0 text-slate-400">（いま0件）</span>}
            </div>
          ))}
          <div className="mt-1 border-t border-dashed border-slate-200 pt-1 text-3xs text-slate-500">
            {Object.entries(tally).sort().map(([k, v]) => `${MOVE_LABEL[k] || k} ${v}行`).join(' ／ ')}
            {' '}＝ 合計 <b className="tabular-nums">{Object.values(tally).reduce((a, b) => a + b, 0)}行</b>
            （もとの {total}行と同じ数です）
          </div>
        </div>
      </Fold>

      {/* ── 技術の物。一番下・一番地味に畳む（清水さんの判断材料ではない）── */}
      {slots.tech ? (
        <Fold summary="技術の物（かかった時間・段ごとの時間・読み書きの数）">{slots.tech}</Fold>
      ) : null}
    </Sheet>
  );
}


/**
 * 🚨 1行で「何のために在るか」が書けなかった物を、**消さずに** 画面に出して聞きます。
 *   勝手に消すと、清水さんが次に見た時に「どこへ行った」になります。
 */
export function UndecidedNotice() {
  const keys = Object.keys(UNDECIDED_NOTES);
  if (keys.length === 0) return null;
  return (
    <div data-opsim-undecided={keys.length} className="rounded-xl border-2 border-amber-400 bg-amber-50 px-3 py-2.5">
      <div className="text-2xs font-black text-amber-900">
        🙏 この{keys.length}つは、意味が決まっていません（消さずに残しています）
      </div>
      <div className="mt-1 flex flex-col gap-2">
        {keys.map((k) => {
          const n = UNDECIDED_NOTES[k];
          return (
            <div key={k} className="rounded-lg border border-amber-200 bg-white px-2.5 py-2">
              <div className="text-2xs font-black text-slate-800">{n.label}</div>
              <div className="mt-0.5 text-xs leading-snug text-slate-600">{n.problem}</div>
              <div className="mt-1 text-xs font-bold leading-snug text-amber-800">▶ {n.ask}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 盤面の上に置く ⚙ ボタン。🚨 拡大の操作帯と同じ行に置いても、帯の中身は1つも消しません。 */
export function GearButton({ onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="この見立ての設定（見る範囲・工数の見方・仮の入荷日・仮定・根拠のデータ）"
      data-opsim-gear="1"
      className="inline-flex items-center gap-1 min-h-11 px-2.5 rounded-lg border border-slate-300 bg-white text-2xs font-bold text-slate-600 hover:border-cyan-400 hover:text-cyan-700"
    >
      <Settings className="w-3.5 h-3.5" />
      設定
    </button>
  );
}

export default Why;
