// =============================================================================
//  boardDims.js — 操業シミュレーションの盤の「大きさ」（2026-09-01）
// -----------------------------------------------------------------------------
//  【なぜ在るか】
//  2026-09-01 清水さん「そういえば **拡大ボタンがなくなってた** のが意味わからない」。
//  私が 2026-08-30 のコミット 01730b9 で「詰めて表示」「大画面」の2ボタンを撤去した。
//  撤去の理由としてコードに「(清水さんの指示)」と書いたが、記録に残っている清水さんの言葉は
//    「『詰めて表示中』『大画面』は **意味が分からない**」＝ **名前が分かりにくい**
//  であって、「拡大をやめろ」ではない。私が読み違えて機能ごと捨てた。
//
//  【この紙が守る事】
//  🚨🚨 CSS の zoom / transform: scale で拡大しない。
//     2026-08-08 に「見た目だけ拡大して、押した所（当たり判定）がズレる」根因として
//     廃止した方式そのもの。ここは **寸法の値を倍率 k で作り直す** ので、
//     段組み・重なり判定・札の置き場の計算がそのまま k 倍で走り、
//     画面に見えている長方形と、押した時に当たる長方形が必ず同じ物になる。
//  🚨 文字は px 直書きにしない。倍率で切り替えるのは **rem の段**（text-2xs/xs/sm/base/lg）だけ。
//     px で書くと、このアプリの文字サイズ設定（applyFontSizes）で1pxも拡大しない。
//
//  ⚠ ここは **見せ方だけ**。計算（src/domain/operationsSimulation/）には1ミリも触らない。
//    同じ入力なら、倍率をどこへ動かしても答え（遅れる件数・最初に越える日時・主因）は1つ。
// =============================================================================

/** 標準（k=1.0）の寸法。🚨 ここを触ると4段すべてが動く。 */
export const BASE_DIMS = Object.freeze({
  // 🚨 2026-09-15: ピル3組のうち2組(大きさ・並べ方)を1つの畳んだ札へまとめたので1段ぶん低い。
  //   ⚠ Board.jsx の畳みを戻す時は、この数も一緒に 66 へ戻す事(片方だけ直すと札が帯からはみ出す)。
  TOP_STRIP: 46,     // 上の帯（入口/出口の見出し ＋ 件数の1行 ＋ 切替のピル）
  BOTTOM_PAD: 12,
  // ⚠ カードは3行（型式 ＋ 残り時間/納期 ＋ 担当）。標準では 38px ＋ 余白 ＝ 64px。
  CARD_H: 64,
  GAP_Y: 12,         // 段と段のすき間
  GAP_X: 12,         // 同じ段でカードとカードの間に必ず空ける幅
  LANE_FOOTER: 16,   // レーンの一番下。出し切れなかった件数を書く場所（必ず空ける）
  BADGE_H: 24,       // 担当者の札の高さ。⚠ 可変にすると上下の段のカードにかぶる
  RAIL_H: 48,        // 盤の一番上の「作業者の帯」。⚠ 人が0人の時は1pxも取らない
  LANE_GUTTER: 32,   // 左の柱（レーン名）
  GATE_W: 52,        // 右の納期ゲート
  GATE_R: 8,
  STRIP_W: 132,      // 盤の外（左＝これから届く / 右＝予定日を過ぎた）の細い帯
  CARD_W_MIN: 152,
  CARD_W_MAX: 190,
  BADGE_W_MIN: 64,   // 担当者の札の幅（名前の字数で決まる）
  BADGE_W_MAX: 112,
  BADGE_W_BASE: 30,
  BADGE_W_PER_CHAR: 12,
  BADGE_NEED_GAP: 16,   // 札＋線を出すのに要る、カードのとなりの空き
  UNKNOWN_LABEL_W: 88,  // 「位置が出せません」の説明の柱（文字が収まる分だけ）
  UNKNOWN_GAP: 14,
});

/**
 * 大きさの4段。
 *
 * 🚨 名前は「押すと何が起きるか」で書く。旧「詰めて表示」「大画面」は
 *   清水さん「意味が分からない」＝ **名前が分かりにくい** という指摘だった。
 *
 * ⚠ この4つの数は実測で決めた（1920×1080・本番の写し 633ロット・レーン14本）:
 *   ・0.8 が下限。カードの高さが 64→51px になる。中の3行は
 *     text-xs(12) ＋ text-2xs(11) ＋ text-2xs(11) ＝ 34px に上下の余白12px で 46px。
 *     51px にちょうど収まる。これより下げると3行目（担当）が箱からはみ出す＝読めない。
 *   ・1.6 が上限。カードの幅が 190→304px になり、道（盤の左端〜納期線 ≒ 600px）の
 *     半分をカード1枚が占める。これ以上広げると「カードが右へ動いた」が見えなくなり、
 *     盤の意味（時間が進むと札が動く）そのものが消える。
 *   ・1.0 と 1.3 はその間。1.3 でカードの型式が 14→16px、札の高さが 24→31px。
 */
export const BOARD_ZOOM_STEPS = Object.freeze([
  { key: 's', k: 0.8, label: '小さく', hint: '札を小さくして、一度に見えるレーン（型式の行）を増やします' },
  { key: 'm', k: 1.0, label: '標準', hint: 'いつもの大きさに戻します' },
  { key: 'l', k: 1.3, label: '大きく', hint: '札と文字を1.3倍にします。離れた所からでも型式と納期が読めます' },
  { key: 'xl', k: 1.6, label: 'もっと大きく', hint: '札と文字を1.6倍にします。一度に見えるレーンは減ります' },
]);
export const BOARD_ZOOM_DEFAULT = 'm';
/** 端末に覚えさせる時の名前。⚠ 他と衝突しない物にする。 */
export const BOARD_ZOOM_KEY = 'opsim.board.zoom.v1';

/** 知らない名前が来ても壊れない（既定＝標準へ落とす）。 */
export function zoomStepOf(key) {
  return BOARD_ZOOM_STEPS.find((s) => s.key === key)
    || BOARD_ZOOM_STEPS.find((s) => s.key === BOARD_ZOOM_DEFAULT);
}

/**
 * 倍率 k から、盤の寸法を **作り直す**。
 * 🚨 盤の計算と描画は、この返り値だけを見る（BASE_DIMS を直に読む所を1つでも残すと、
 *   そこだけ大きくならずに重なる）。
 *
 * ⚠ 上の帯（TOP_STRIP）と作業者の帯（RAIL_H）だけは **k<1 でも縮めない**。
 *   あの2つの中身は rem の文字と押すピルで、k を下げても縮まない。
 *   箱だけ縮めると中身がはみ出す。大きくする側（k>1）には付いていく。
 */
export function dimsOf(k) {
  const z = Number.isFinite(Number(k)) && Number(k) > 0 ? Number(k) : 1;
  const B = BASE_DIMS;
  const s = (n, min = 1) => Math.max(min, Math.round(n * z));
  const grow = (n) => Math.max(n, Math.round(n * z));
  const CARD_H = s(B.CARD_H, 44);
  const GAP_Y = s(B.GAP_Y, 6);
  return Object.freeze({
    k: z,
    TOP_STRIP: grow(B.TOP_STRIP),
    RAIL_H: grow(B.RAIL_H),
    BOTTOM_PAD: s(B.BOTTOM_PAD, 6),
    CARD_H,
    GAP_Y,
    ROW_H: CARD_H + GAP_Y,
    GAP_X: s(B.GAP_X, 6),
    LANE_FOOTER: s(B.LANE_FOOTER, 12),
    BADGE_H: s(B.BADGE_H, 20),
    LANE_GUTTER: s(B.LANE_GUTTER, 24),
    GATE_W: s(B.GATE_W, 36),
    GATE_R: s(B.GATE_R, 4),
    STRIP_W: s(B.STRIP_W, 108),
    CARD_W_MIN: s(B.CARD_W_MIN, 120),
    CARD_W_MAX: s(B.CARD_W_MAX, 140),
    BADGE_W_MIN: s(B.BADGE_W_MIN, 52),
    BADGE_W_MAX: s(B.BADGE_W_MAX, 88),
    BADGE_W_BASE: s(B.BADGE_W_BASE, 22),
    BADGE_W_PER_CHAR: s(B.BADGE_W_PER_CHAR, 9),
    BADGE_NEED_GAP: s(B.BADGE_NEED_GAP, 10),
    UNKNOWN_LABEL_W: s(B.UNKNOWN_LABEL_W, 72),
    UNKNOWN_GAP: s(B.UNKNOWN_GAP, 8),
    /**
     * 文字。**rem の段だけ**を切り替える（px 直書きはしない）。
     * text-2xs=0.6875rem / xs=0.75rem / sm=0.875rem / base=1rem / lg=1.125rem。
     * どれも tailwind.config.js の var(--text-*) 経由なので、文字サイズ設定にも追従する。
     */
    text: z < 1
      ? { model: 'text-xs', meta: 'text-2xs', mark: 'text-2xs', lane: 'text-2xs' }
      : z < 1.3
        ? { model: 'text-sm', meta: 'text-xs', mark: 'text-2xs', lane: 'text-2xs' }
        : z < 1.6
          ? { model: 'text-base', meta: 'text-sm', mark: 'text-xs', lane: 'text-xs' }
          : { model: 'text-lg', meta: 'text-base', mark: 'text-sm', lane: 'text-sm' },
  });
}

/** 標準（k=1.0）の寸法。倍率を渡せない所（測る前の下地）だけが読む。 */
export const D1 = dimsOf(1);

/** 入れ物（見える窓）の下限。これより低いと上の帯だけで埋まって道が1本も見えない。 */
export const MIN_VIEWPORT_H = 240;
