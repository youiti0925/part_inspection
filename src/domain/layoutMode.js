// PC / スマホ 表示切替の「決め方」だけを置く場所。
// 製品検査アプリ・最終検査アプリで同一ファイル(片方だけ直すと必ずズレるのでコピーで揃える)。
//
// 【なぜ contactBoard.js から出したか】
// もともと LAYOUT_MODES / isWideLayout は contactBoard.js(工程連絡ポータル専用)の中に居た。
// 切替はポータルだけの話ではなく、どの画面でも要る。連絡ポータルの中に置いたままだと
// 「他の画面用にもう1個作る」を誘発する。**定義は1つ**にしたいので、ここへ移した。
// ⚠ contactBoard.js は このファイルから import して re-export しているだけ。
//    同じ物を2つ書かない事。直すならここだけ。
//
// 【いちばん大事な決まり: 幅だけで決めない】
// スマホを横に倒すと 844×390 になる。幅は 844px あるので「幅だけ」で見ると PC に見えるが、
// 縦が 390px しか無い。ここで PC の配置(横に並べる・縦に積む)を出すと何も読めない。
// → 高さが足りない状態を **'short'** として必ず別に持つ。

// ==================== 切替の3つの値 ====================
// 'auto' = 画面の大きさで決める / 'wide' = いつも広い版 / 'narrow' = いつも縦1列
// ⚠ ボタンは 自動 → PC → スマホ → 自動 と回る(nextLayoutMode)。並び順を変えると回り方が変わる。
export const LAYOUT_MODES = [
    { id: 'auto', label: '自動' },
    { id: 'wide', label: 'PC(広く)' },
    { id: 'narrow', label: 'スマホ(縦)' },
];

// 幅がこれ以上なら「広い版」。タブレット縦(768)は入れない
// = 768px を2列にすると1列384px しか無く、押す物(44px以上)を並べると破綻する為。
export const WIDE_MIN_PX = 1024;

// 高さがこれ未満なら「縦が足りない」= スマホ横。
// 実寸の根拠: スマホ横の高さは 360〜430px(390/375/360 など)。
// 一方 640(小型Android縦を横にした物ではない)/720/768(タブレット横・小型ノート) は足りている。
// 500 はこの2群の谷。720 を short にしてしまうと普通のノートPCが巻き込まれる。
export const SHORT_MAX_PX = 500;

// ==================== 値の掃除 ====================
// 保存された文字が化けていても、知らない値なら 'auto' に戻す(画面が固まるより良い)。
export const normalizeLayoutMode = (mode) =>
    (LAYOUT_MODES.some(m => m.id === mode) ? mode : 'auto');

export const layoutModeOf = (mode) =>
    LAYOUT_MODES.find(m => m.id === normalizeLayoutMode(mode)) || LAYOUT_MODES[0];

// ボタンを押した時の次の値。自動 → PC → スマホ → 自動。
// ⚠ 連絡ポータルのボタンが元からこの順。順番を変えると「押したら戻った」になる。
export const nextLayoutMode = (mode) => {
    const list = LAYOUT_MODES.map(m => m.id);
    const i = list.indexOf(normalizeLayoutMode(mode));
    return list[(i + 1) % list.length];
};

// ==================== 判定 ====================
// 【後方互換】元の contactBoard.js の物と1文字も変えていない。答えを変えてはいけない。
// 高さを見ないので、スマホ横(844×390)に true を返す事はない(844 < 1024)が、
// 「1280×400 の細長い窓」には true を返してしまう。新しい画面は layoutOf を使う事。
export const isWideLayout = (mode, widthPx) => {
    if (mode === 'wide') return true;
    if (mode === 'narrow') return false;
    return Number(widthPx) >= WIDE_MIN_PX;
};

// 縦が足りないか。高さが分からない(undefined / 0 / NaN)時は false
// = 「知らないから short にする」は、高さを渡していない既存の呼び出しを全部壊す為。
export const isShortViewport = (heightPx) => {
    const h = Number(heightPx);
    if (!Number.isFinite(h) || h <= 0) return false;
    return h < SHORT_MAX_PX;
};

// 画面1つ分の答え。'wide' | 'narrow' | 'short' のどれか1つ。
//
// 決める順番(この順番が結論):
//   1. 縦が足りなければ 'short'。**手で選んでも縦は伸びない**ので、ここは手動指定より先。
//   2. 手で 'PC' を選んでいれば 'wide'(狭くても)。
//   3. 手で 'スマホ' を選んでいれば 'narrow'(広くても)。
//   4. 'auto' は幅で決める。
//
// ⚠ 'short' は **narrow の仲間**(縦1列側)。'wide' の反対側に居る。
//    `layout === 'narrow'` だけで分岐を書くと、スマホ横が PC 扱いに落ちる。
//    迷ったら layoutInfo() の wide / narrow / short を使う事。
export const layoutOf = (mode, widthPx, heightPx) => {
    if (isShortViewport(heightPx)) return 'short';
    const m = normalizeLayoutMode(mode);
    if (m === 'wide') return 'wide';
    if (m === 'narrow') return 'narrow';
    return Number(widthPx) >= WIDE_MIN_PX ? 'wide' : 'narrow';
};

// 画面側が間違えにくい形。分岐は wide / narrow / short の真偽値で書く。
// narrow は「縦1列側」= short を含む。wide の完全な反対。
export const layoutInfo = (mode, widthPx, heightPx) => {
    const layout = layoutOf(mode, widthPx, heightPx);
    return {
        mode: normalizeLayoutMode(mode),
        layout,
        wide: layout === 'wide',
        narrow: layout !== 'wide',
        short: layout === 'short',
    };
};

// ==================== ボタンの文字 ====================
export const LAYOUT_LABELS = { wide: 'PC', narrow: 'スマホ', short: 'スマホ横' };

// 'auto' の時だけ「いま実際どっちで出ているか」を括弧で見せる。
// 手で選んでいる時は LAYOUT_MODES の label をそのまま出す(自分で選んだ物が見えないと不安になる)。
export const layoutModeLabel = (mode, layout) => {
    const m = normalizeLayoutMode(mode);
    if (m !== 'auto') return layoutModeOf(m).label;
    return `自動(${LAYOUT_LABELS[layout] || 'PC'})`;
};

// ==================== 保存 ====================
// ⚠ 鍵は既存の 'renrakuLayout' のまま。名前は連絡ポータル由来だが、
//   変えると「連絡ポータルでスマホにしていた人」の選択が黙って自動に戻る。
//   **鍵を2つ持たない**(片方だけ書いて片方だけ読む事故が必ず起きる)。
export const LAYOUT_MODE_STORAGE_KEY = 'renrakuLayout';

const defaultStorage = () => {
    try { return globalThis.localStorage || null; } catch { return null; }
};

// 保存された切替を読む。無い / 壊れている / localStorage が使えない → 'auto'。
// (Safari のプライベート閲覧では localStorage を触るだけで例外が飛ぶ)
export const readLayoutMode = (storage = undefined) => {
    const store = storage === undefined ? defaultStorage() : storage;
    if (!store) return 'auto';
    try { return normalizeLayoutMode(store.getItem(LAYOUT_MODE_STORAGE_KEY)); } catch { return 'auto'; }
};

// 切替を保存する。**掃除した後の値を返す**ので、そのまま state に入れてよい。
//   setLayoutMode(saveLayoutMode(nextLayoutMode(layoutMode)))
export const saveLayoutMode = (mode, storage = undefined) => {
    const m = normalizeLayoutMode(mode);
    const store = storage === undefined ? defaultStorage() : storage;
    if (store) {
        try { store.setItem(LAYOUT_MODE_STORAGE_KEY, m); } catch { /* 保存できなくても画面は動かす */ }
    }
    return m;
};
