// 🔤 画面の言葉の辞書(labels/1): 「アプリの言葉を全部編集できる」形の土台。辞書が空なら画面は1文字も変わらない
// 目的: 司令塔・グループごとに画面の言葉(単語・画面名・見出し・ボタン)を変えられる様にする。今の文字をコードに残し、上書きだけをデータで持つ。
// 入力: t('機械の場所の目印', '今の文字') / 辞書 { schema:'labels/1', words:{単語:置き換え}, keys:{目印:文字} }(重ね方: コードの今の文字 → 種類の既定 → 司令塔 → グループ)
// 出力: 文字列(辞書に無い・壊れている時は 今の文字のまま。例外は投げない)
// 触る外の物: なし(メモリの中だけ・Firebase に触れない)。置き場の設計は docs/設計_最上位司令塔とSAP工程の登録_1125.md §3
// 確かめ方: node --test src/domain/__tests__/labels.test.mjs
import { LABEL_CATALOG, COMMON_WORDS, KIND_LABEL_DEFAULTS } from './labelsDefault.js';

export const LABELS_SCHEMA = 'labels/1';
/** 上限(名前だけに絞る・多すぎる辞書で設定の文書が膨らまない様に): 1語/1文字列の長さ・件数 */
export const LABEL_LIMITS = Object.freeze({ textMax: 30, keysMax: 300, wordsMax: 100 });

const isPlain = (o) => o != null && typeof o === 'object' && !Array.isArray(o);

/** 辞書の候補 → { labels:{words,keys}, problems:[日本語の理由] }。壊れた所だけ捨てて残りは使う(全部捨てない・落ちない) */
export function cleanLabels(raw) {
    const out = { words: {}, keys: {} }, problems = [];
    if (raw == null) return { labels: out, problems };
    if (!isPlain(raw)) return { labels: out, problems: ['辞書の形が違うので使いません'] };
    if (raw.schema != null && raw.schema !== LABELS_SCHEMA) return { labels: out, problems: [`知らない版の辞書です(${String(raw.schema)})・使いません`] };
    for (const [part, max] of [['words', LABEL_LIMITS.wordsMax], ['keys', LABEL_LIMITS.keysMax]]) {
        const src = raw[part];
        if (src == null) continue;
        if (!isPlain(src)) { problems.push(`${part} の形が違うので使いません`); continue; }
        let n = 0;
        for (const [k, v] of Object.entries(src)) {
            if (!k || typeof v !== 'string' || !v.trim()) { problems.push(`${part}「${k}」は空か文字でないので使いません`); continue; }
            if (v.length > LABEL_LIMITS.textMax) { problems.push(`${part}「${k}」は ${LABEL_LIMITS.textMax} 文字を超えるので使いません`); continue; }
            if (++n > max) { problems.push(`${part} は ${max} 件までです。超えた分は使いません`); break; }
            out[part][k] = v;
        }
    }
    return { labels: out, problems };
}

/** 重ねる(後ろの層が強い)。[種類の既定, 司令塔, グループ] の順に渡す。壊れた層は捨てて他を使う */
export function mergeLabelLayers(layers) {
    const out = { words: {}, keys: {} };
    for (const l of layers || []) {
        const { labels } = cleanLabels(l);
        Object.assign(out.words, labels.words);
        Object.assign(out.keys, labels.keys);
    }
    return out;
}

/** 辞書 → t 関数。t(目印, 今の文字): 目印の上書きがあればそれ・無ければ 今の文字に 単語の置き換えをかけて返す */
export function makeT(merged) {
    const keys = (merged && merged.keys) || {};
    const words = Object.entries((merged && merged.words) || {}).sort((a, b) => b[0].length - a[0].length);   // 長い単語を先に(「立旋盤」が「旋盤」に食われない)
    return function t(key, fallback) {
        const base = typeof fallback === 'string' ? fallback : String(fallback ?? '');
        try {
            if (Object.prototype.hasOwnProperty.call(keys, key)) return keys[key];
            let s = base;
            for (const [w, to] of words) if (w && s.includes(w)) s = s.split(w).join(to);
            return s;
        } catch { return base; }
    };
}

/** 種類の既定 + 司令塔の上書き + グループの上書き を重ねた辞書(各層は labels/1 の形・無ければ空) */
export function buildLabels({ kind = null, commander = null, group = null } = {}) {
    return mergeLabelLayers([kind && KIND_LABEL_DEFAULTS[kind], commander, group]);
}

// 今使う辞書(既定=空=今の文字そのまま)。画面は t() を呼ぶだけ。差し替えはメモリの中だけ
let activeT = makeT(null);
export const t = (key, fallback) => activeT(key, fallback);
export function setActiveLabels(merged) { activeT = makeT(merged); }

/** 見張り用: 辞書(上書き)に書いてある目印のうち、画面の目録(LABEL_CATALOG)に無い物 = 打ち間違いで効かない上書き */
export function unknownKeysOf(labels) {
    const known = new Set(LABEL_CATALOG.map((e) => e.key));
    return Object.keys(cleanLabels(labels).labels.keys).filter((k) => !known.has(k));
}

export { LABEL_CATALOG, COMMON_WORDS, KIND_LABEL_DEFAULTS };
