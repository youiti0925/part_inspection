// 「アプリを直したよ」を、開いた人に1回だけ見せる画面。
//
// ⚠⚠ このファイルは **製品検査アプリと最終検査アプリで同一**。片方だけ直すと必ずズレる。
//   中身の決まりごとは src/domain/appNotices.js（保存・購読はここに書かない）。
//
// 清水さん(2026-08-01):「今アプリ直すとみんなにお知らせもしたいから、
//   アプリ開いたら一回だけ相手に更新したお知らせを見れるようにしてほしいな」
// 清水さん(2026-08-10):「更新した部分を相手に知らせるために画像を追加できるようにしてほしい。
//   後、更新した内容をそっちで作成してくれると嬉しい、こっちはだれに出すか決めるだけみたいな」
//
// ⚠「見た」は **端末ごと** に覚える。共有の棚に書くと、誰か1人が読んだ瞬間に全員から消える。

import React, { useEffect, useMemo, useState } from 'react';
import { Megaphone, X, Send, Trash2, Eye, EyeOff, ImagePlus, FileText, Check, Loader2 } from 'lucide-react';
import {
    NOTICE_TARGETS, noticeTargetLabel, buildNotice, canSubmitNotice,
    pendingNotices, sortNotices, liveNoticeCount,
    parseSeenNotices, withSeenNotice, NOTICE_SEEN_LS_KEY,
    noticeImagesOf, noticeImageBytes, canAddNoticeImage,
    NOTICE_IMAGE_MAX_COUNT, NOTICE_IMAGE_BUDGET,
} from './domain/appNotices.js';
import { NOTICE_DRAFTS, draftAlreadySent, visibleDrafts, hiddenDraftIds, withHiddenDraft } from './domain/noticeDrafts.js';

const fmt = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const kb = (bytes) => `${Math.round(bytes / 1024)}KB`;

// ============================================================ 📷 画像の小さくする係
// ⚠ここでしっかり小さくしないと、Firestore の 1MB 上限に当たって **保存が丸ごと落ちる**。
//   スマホの写真はそのままだと 3〜8MB ある。1枚で即アウト。
//   画面写真は文字が読めないと意味が無いので、まず大きめの品質で試し、
//   目安を超えていたら段々小さくする(いきなり潰さない)。
const NOTICE_IMG_STEPS = [[1200, 0.82], [1000, 0.78], [860, 0.72], [720, 0.64]];
const NOTICE_IMG_TARGET = 200 * 1024; // 1枚あたりの目安

const loadImageEl = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読めませんでした'));
    img.src = src;
});

const drawToJpeg = (img, maxW, quality) => {
    const natW = img.naturalWidth || img.width || 1;
    const natH = img.naturalHeight || img.height || 1;
    const scale = Math.min(1, maxW / natW);
    const w = Math.max(1, Math.round(natW * scale));
    const h = Math.max(1, Math.round(natH * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    // ⚠画面写真は白地が多い。JPEG は透明を **黒** で埋めるので、先に白で塗っておく。
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return cv.toDataURL('image/jpeg', quality);
};

/** File / Blob / URL / data URI → 小さくした data URI。⚠失敗は投げる(黙って何も起きない、を作らない)。 */
const shrinkToDataUrl = async (source) => {
    const objUrl = (typeof source === 'string') ? null : URL.createObjectURL(source);
    try {
        const img = await loadImageEl(objUrl || source);
        let out = null;
        for (const [maxW, q] of NOTICE_IMG_STEPS) {
            out = drawToJpeg(img, maxW, q);
            if (out.length <= NOTICE_IMG_TARGET) return out;
        }
        return out;
    } finally {
        if (objUrl) URL.revokeObjectURL(objUrl);
    }
};

// ============================================================ 🔍 画像を大きく見る
const Lightbox = ({ src, caption, onClose }) => {
    useEffect(() => {
        const on = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
    }, [onClose]);
    if (!src) return null;
    return (
        <div className="fixed inset-0 z-[1300] bg-black/85 flex flex-col items-center justify-center p-4" onClick={onClose}>
            <img src={src} alt={caption || ''} className="max-w-full max-h-[85vh] object-contain rounded-xl" onClick={e => e.stopPropagation()} />
            {caption ? <div className="text-white text-sm font-bold mt-3 text-center max-w-2xl">{caption}</div> : null}
            <button onClick={onClose} className="mt-4 px-5 py-2.5 rounded-2xl bg-white/15 hover:bg-white/25 text-white font-black text-sm">とじる</button>
        </div>
    );
};

// ============================================================ 出す側(自動)
/**
 * 開いた時に、まだ見ていないお知らせを1枚だけ出す。閉じたら次の1枚。
 * ⚠一度に何枚も重ねない。3枚出ると人は読まずに全部閉じる。
 */
export const NoticePopup = ({ notices, app, side = 'app', enabled = true }) => {
    const [seen, setSeen] = useState(() => { try { return parseSeenNotices(localStorage.getItem(NOTICE_SEEN_LS_KEY)); } catch (e) { return []; } });
    const [now] = useState(() => Date.now()); // ⚠開いた時刻で判定する(表示中に期限が切れて消えるのを防ぐ)
    const [zoom, setZoom] = useState(null);
    const queue = useMemo(
        () => (enabled ? pendingNotices({ rows: notices, seen, app, side, now }) : []),
        [enabled, notices, seen, app, side, now]);
    const cur = queue[0] || null;
    const images = useMemo(() => noticeImagesOf(cur), [cur]);

    const close = () => {
        if (!cur) return;
        const next = withSeenNotice(seen, cur.id);
        setSeen(next);
        try { localStorage.setItem(NOTICE_SEEN_LS_KEY, JSON.stringify(next)); } catch (e) { /* 覚えられなくても画面は動く */ }
    };
    // ⚠Escでも閉じられるようにする。閉じられない画面は「壊れた」と言われる。
    //   ⚠ただし画像を大きく見ている間は、Esc は画像だけ閉じる(お知らせごと消えると読み直せない)。
    useEffect(() => {
        if (!cur) return undefined;
        const on = (e) => { if (e.key === 'Escape' && !zoom) close(); };
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
    }); // eslint-disable-line react-hooks/exhaustive-deps

    if (!cur) return null;
    return (
        <>
        <div className="fixed inset-0 z-[1200] bg-black/50 flex items-center justify-center p-4">
            <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
                <div className="px-5 py-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white flex items-center gap-2 shrink-0">
                    <Megaphone className="w-6 h-6 shrink-0" />
                    <div className="font-black text-lg">アプリを更新しました</div>
                    {queue.length > 1 && <span className="ml-auto text-xs font-black bg-white/20 rounded-full px-2.5 py-1">あと {queue.length - 1} 件</span>}
                </div>
                <div className="p-6 overflow-y-auto">
                    <div className="font-black text-xl text-slate-800 mb-2 break-words">{cur.title}</div>
                    {cur.body ? <div className="text-sm text-slate-600 whitespace-pre-wrap break-words leading-relaxed">{cur.body}</div> : null}
                    {/* 📷 画面写真。⚠押すと大きく見られる(小さいままだと、どこが変わったか分からない)。 */}
                    {images.length > 0 && (
                        <div className="mt-4 flex flex-col gap-3">
                            {images.map((im, i) => (
                                <button key={i} onClick={() => setZoom(im)} className="block text-left w-full group">
                                    <img src={im.src} alt={im.caption || `画面 ${i + 1}`}
                                        className="w-full rounded-2xl border-2 border-slate-200 group-hover:border-blue-400" />
                                    <div className="fi-tap-text text-slate-500 mt-1.5 flex items-center gap-1">
                                        <span className="font-bold text-blue-600">押すと大きく見られます</span>
                                        {im.caption ? <span className="min-w-0 break-words">・{im.caption}</span> : null}
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="fi-tap-text text-slate-400 mt-4">{fmt(cur.createdAt)}{cur.by ? ` ／ ${cur.by}` : ''}</div>
                </div>
                <div className="px-5 py-4 border-t border-slate-100 shrink-0">
                    <button onClick={close} className="w-full py-3.5 rounded-2xl bg-slate-800 hover:bg-slate-900 text-white font-black">
                        {queue.length > 1 ? '確認しました（次を見る）' : '確認しました'}
                    </button>
                    {/* ⚠「もう出ません」と先に言う。押した後で「また出るのでは」と不安にさせない。 */}
                    <div className="fi-tap-text text-slate-400 text-center mt-2">押すと、この端末では二度と出ません。</div>
                </div>
            </div>
        </div>
        <Lightbox src={zoom?.src} caption={zoom?.caption} onClose={() => setZoom(null)} />
        </>
    );
};

// ============================================================ 書く側(管理)
export const NoticeEditor = ({ notices, onSave, onDelete, by = '', enabled = true, onToggleEnabled, shared = null, onHideDraft = null }) => {
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [targets, setTargets] = useState(['all']);
    const [until, setUntil] = useState('');
    const [busy, setBusy] = useState(false);
    // 📷 付ける画像 [{src(data URI), caption}]
    const [images, setImages] = useState([]);
    const [imgBusy, setImgBusy] = useState(false);
    const [imgErr, setImgErr] = useState('');
    // 📝 どの下書きから起こしたか(出す時に一緒に保存して、二度出しの目印にする)
    const [fromDraft, setFromDraft] = useState('');
    const [draftBusy, setDraftBusy] = useState('');
    const [zoom, setZoom] = useState(null);

    const rows = useMemo(() => sortNotices(notices), [notices]);
    // 🗑下書きは隠せる(清水さん 2026-08-12「下書きはいつでも削除できるように」)。
    //   ⚠隠した記録は **共有** に置く。端末ローカルに置くと、他の端末では消えていないことになる。
    const drafts = useMemo(() => visibleDrafts(shared, NOTICE_DRAFTS), [shared]);
    const hiddenIds = useMemo(() => hiddenDraftIds(shared), [shared]);
    const live = liveNoticeCount(notices, Date.now());
    const ok = canSubmitNotice({ title }) && !busy && !imgBusy;
    const usedBytes = noticeImageBytes(images);

    const toggleTarget = (id) => {
        if (id === 'all') { setTargets(['all']); return; }
        setTargets(prev => {
            const cur = prev.filter(t => t !== 'all');
            return cur.includes(id) ? (cur.filter(t => t !== id).length ? cur.filter(t => t !== id) : ['all']) : [...cur, id];
        });
    };

    const reset = () => {
        setTitle(''); setBody(''); setUntil(''); setTargets(['all']);
        setImages([]); setFromDraft(''); setImgErr('');
    };

    // 📷 画像を足す。⚠1枚ずつ順に処理して、入らなくなった所で理由を出して止める。
    //   全部まとめて足してから「大きすぎます」と言うと、どれを消せばいいか分からない。
    const addFiles = async (fileList) => {
        const files = Array.from(fileList || []).filter(f => f && String(f.type || '').startsWith('image/'));
        if (!files.length) return;
        setImgBusy(true); setImgErr('');
        let cur = images;
        const problems = [];
        for (const f of files) {
            try {
                const src = await shrinkToDataUrl(f);
                const gate = canAddNoticeImage(cur, src.length);
                if (!gate.ok) { problems.push(`${f.name}: ${gate.reason}`); break; }
                cur = [...cur, { src, caption: '' }];
            } catch (e) {
                problems.push(`${f.name}: ${(e && e.message) || '読めませんでした'}`);
            }
        }
        setImages(cur);
        setImgErr(problems.join('\n'));
        setImgBusy(false);
    };

    // 📝 用意しておいた下書きを流し込む。⚠画像も一緒に読み込んで焼き付ける。
    //   読めなかった画像は **黙って落とさず** 画面に出す(画像ありのつもりで出すのを防ぐ)。
    const applyDraft = async (d) => {
        if (!d) return;
        if ((title.trim() || body.trim() || images.length) &&
            !window.confirm('いま書いている内容を、この下書きで置き換えます。よろしいですか？')) return;
        setDraftBusy(d.id); setImgErr('');
        try {
            setTitle(d.title || '');
            setBody(d.body || '');
            setTargets(Array.isArray(d.suggestedTargets) && d.suggestedTargets.length ? [...d.suggestedTargets] : ['all']);
            setUntil('');
            setFromDraft(d.id);
            const out = [];
            const problems = [];
            for (const im of (d.images || [])) {
                try {
                    const src = await shrinkToDataUrl(im.url);
                    const gate = canAddNoticeImage(out, src.length);
                    if (!gate.ok) { problems.push(gate.reason); break; }
                    out.push({ src, caption: im.caption || '' });
                } catch (e) {
                    problems.push(`画像「${im.caption || im.url}」を読めませんでした。手で足してください。`);
                }
            }
            setImages(out);
            setImgErr(problems.join('\n'));
        } finally { setDraftBusy(''); }
    };

    const save = async () => {
        if (!ok) return;
        setBusy(true);
        try {
            const untilMs = until ? new Date(`${until}T23:59:59`).getTime() : 0;
            await onSave(buildNotice({ title, body, targets, by, until: untilMs, images, fromDraft, now: Date.now() }));
            reset();
        } catch (e) {
            alert(`出せませんでした。\n${e?.message || e}`); // ⚠握りつぶさない
        } finally { setBusy(false); }
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 flex-wrap">
                <div className="text-sm font-black text-slate-700 flex items-center gap-2"><Megaphone className="w-4 h-4 text-blue-600" />更新のお知らせ</div>
                <span className="fi-tap-text font-bold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">いま配信中 {live}件</span>
                <button onClick={() => onToggleEnabled && onToggleEnabled(!enabled)}
                    className={`ml-auto px-3 py-1.5 rounded-full text-xs font-black border ${enabled ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-white text-slate-400 border-slate-200'}`}>
                    {enabled ? 'お知らせを出す：ON' : 'お知らせを出す：OFF'}
                </button>
            </div>
            {!enabled && <div className="fi-tap-text font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">OFFの間は、書いても誰の画面にも出ません。</div>}

            {/* ============ 📝 用意しておいた下書き ============ */}
            {drafts.length > 0 && (
                <div className="border-2 border-indigo-200 bg-indigo-50/50 rounded-2xl p-4 flex flex-col gap-2.5">
                    <div className="text-sm font-black text-indigo-800 flex items-center gap-2">
                        <FileText className="w-4 h-4" />用意しておいた下書き
                    </div>
                    <div className="fi-tap-text text-indigo-700 leading-relaxed">
                        文章と画面写真はこちらで作ってあります。<b>やることは「誰に出すか」を選んで「出す」を押すだけ</b>です。<br />
                        <span className="text-indigo-500">※ここに並んでいるだけでは、まだ誰にも届いていません。</span>
                    </div>
                    {drafts.map(d => {
                        const sent = draftAlreadySent(notices, d.id);
                        const loading = draftBusy === d.id;
                        return (
                            <div key={d.id} className={`rounded-2xl border-2 p-3 bg-white ${sent ? 'border-slate-200' : 'border-indigo-300'}`}>
                                <div className="flex items-start gap-2 flex-wrap">
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-black text-slate-800 break-words">{d.title}</div>
                                        <div className="fi-tap-text text-slate-400 mt-1 flex items-center gap-2 flex-wrap">
                                            <span>{d.shipped} の更新</span>
                                            {(d.images || []).length > 0 && <span className="bg-slate-100 rounded px-1.5 py-0.5 font-bold">📷 画像 {(d.images || []).length}枚</span>}
                                            {(d.suggestedTargets || []).map(t => <span key={t} className="bg-indigo-50 text-indigo-700 rounded px-1.5 py-0.5 font-bold">おすすめの宛先: {noticeTargetLabel(t)}</span>)}
                                            {sent && <span className="text-emerald-700 font-black flex items-center gap-0.5"><Check className="w-3 h-3" />もう出しました</span>}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <button onClick={() => applyDraft(d)} disabled={loading || busy}
                                            className="px-3.5 py-2 rounded-xl text-xs font-black border-2 border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1.5">
                                            {loading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />読み込み中…</> : 'この下書きを使う'}
                                        </button>
                                        {onHideDraft && (
                                            <button
                                                onClick={() => { if (window.confirm(`下書き「${d.title}」を一覧から消します。
（出したお知らせは消えません。あとで戻せます）`)) onHideDraft(withHiddenDraft(shared, d.id, true)); }}
                                                title="この下書きを一覧から消す（あとで戻せます）"
                                                className="w-9 h-9 rounded-xl border-2 border-slate-200 text-slate-400 hover:text-rose-600 hover:border-rose-300 flex items-center justify-center font-black">
                                                ✕
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    {/* ⚠消した物を「無かったこと」にしない。何件消したかと、戻す道を必ず出す。 */}
                    {onHideDraft && hiddenIds.length > 0 && (
                        <div className="fi-tap-text text-slate-500 flex items-center gap-2 flex-wrap">
                            一覧から消した下書き {hiddenIds.length}件
                            <button onClick={() => onHideDraft([])} className="underline font-bold text-indigo-600">全部もどす</button>
                        </div>
                    )}
                </div>
            )}
            {onHideDraft && drafts.length === 0 && hiddenIds.length > 0 && (
                <div className="fi-tap-text text-slate-500 border border-slate-200 rounded-xl px-3 py-2 flex items-center gap-2 flex-wrap">
                    用意しておいた下書きは、すべて一覧から消してあります（{hiddenIds.length}件）。
                    <button onClick={() => onHideDraft([])} className="underline font-bold text-indigo-600">全部もどす</button>
                </div>
            )}

            <div className="border border-slate-200 rounded-2xl p-4 flex flex-col gap-3 bg-white">
                {fromDraft && (
                    <div className="fi-tap-text font-black text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2 flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 shrink-0" />
                        <span className="min-w-0">用意しておいた下書きを読み込みました。宛先を確かめて「出す」を押してください（文章は直せます）。</span>
                        <button onClick={reset} className="ml-auto shrink-0 underline text-indigo-500">やめる</button>
                    </div>
                )}
                <div>
                    <div className="text-xs font-black text-slate-500 mb-1.5">なにを直しましたか？<span className="text-rose-500 ml-1">必須</span></div>
                    <input value={title} onChange={e => setTitle(e.target.value)} maxLength={60}
                        placeholder="例）到着予定を「9時に2台・12時に1台」と分けて出せるようにしました"
                        className="w-full border-2 border-slate-200 focus:border-blue-400 rounded-xl px-3 py-2.5 text-sm outline-none" />
                </div>
                <div>
                    <div className="text-xs font-black text-slate-500 mb-1.5">くわしく<span className="text-slate-300 ml-1">任意</span></div>
                    <textarea value={body} onChange={e => setBody(e.target.value)} rows={4}
                        placeholder="使い方や、気をつけてほしいことがあれば。"
                        className="w-full border-2 border-slate-200 focus:border-blue-400 rounded-2xl px-3 py-2.5 text-sm outline-none resize-y" />
                </div>

                {/* ============ 📷 画像 ============ */}
                <div>
                    <div className="text-xs font-black text-slate-500 mb-1.5 flex items-center gap-2 flex-wrap">
                        <span>直した所の画面写真<span className="text-slate-300 ml-1">任意</span></span>
                        <span className={`font-bold ${usedBytes > NOTICE_IMAGE_BUDGET * 0.8 ? 'text-amber-600' : 'text-slate-400'}`}>
                            {images.length}/{NOTICE_IMAGE_MAX_COUNT}枚・{kb(usedBytes)} / {kb(NOTICE_IMAGE_BUDGET)}
                        </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <label className={`px-3.5 py-2.5 rounded-xl text-xs font-black border-2 border-dashed cursor-pointer flex items-center gap-1.5 ${imgBusy ? 'border-slate-200 text-slate-300' : 'border-blue-300 text-blue-700 hover:bg-blue-50'}`}>
                            {imgBusy ? <><Loader2 className="w-4 h-4 animate-spin" />小さくしています…</> : <><ImagePlus className="w-4 h-4" />画像を足す</>}
                            <input type="file" accept="image/*" multiple disabled={imgBusy} className="hidden"
                                onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
                        </label>
                        <span className="fi-tap-text text-slate-400">スマホの写真も貼れます（自動で小さくします）</span>
                    </div>
                    {imgErr && <div className="mt-2 fi-tap-text font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 whitespace-pre-wrap">{imgErr}</div>}
                    {images.length > 0 && (
                        <div className="mt-2.5 grid grid-cols-2 gap-2.5">
                            {images.map((im, i) => (
                                <div key={i} className="border-2 border-slate-200 rounded-2xl overflow-hidden bg-slate-50 flex flex-col">
                                    <button onClick={() => setZoom(im)} className="block">
                                        <img src={im.src} alt={`画像 ${i + 1}`} className="w-full h-28 object-cover object-top" />
                                    </button>
                                    <div className="p-2 flex flex-col gap-1.5">
                                        <input value={im.caption} onChange={e => setImages(list => list.map((x, k) => (k === i ? { ...x, caption: e.target.value } : x)))}
                                            placeholder="この画像の説明（任意）" maxLength={60}
                                            className="w-full border border-slate-200 focus:border-blue-400 rounded-lg px-2 py-1.5 fi-tap-text outline-none" />
                                        <div className="flex items-center gap-2">
                                            <span className="fi-tap-text text-slate-400">{kb(im.src.length)}</span>
                                            <button onClick={() => setImages(list => list.filter((_, k) => k !== i))}
                                                className="ml-auto px-2 py-1 rounded-lg fi-tap-text font-black text-slate-400 hover:text-rose-600 hover:bg-rose-50 flex items-center gap-1">
                                                <Trash2 className="w-3 h-3" />消す
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex items-end gap-4 flex-wrap">
                    <div>
                        <div className="text-xs font-black text-slate-500 mb-1.5">誰に出しますか？</div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            {[{ id: 'all', label: 'ぜんぶ' }, ...NOTICE_TARGETS].map(t => (
                                <button key={t.id} onClick={() => toggleTarget(t.id)}
                                    className={`px-3 py-1.5 rounded-full text-xs font-black border ${targets.includes(t.id) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>
                                    {t.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <div className="text-xs font-black text-slate-500 mb-1.5">いつまで出す？<span className="text-slate-300 ml-1">任意</span></div>
                        <input type="date" value={until} min={ymd(Date.now())} onChange={e => setUntil(e.target.value)}
                            className="border-2 border-slate-200 focus:border-blue-400 rounded-xl px-3 py-2 text-sm outline-none" />
                    </div>
                    <button onClick={save} disabled={!ok}
                        className="ml-auto px-5 py-2.5 rounded-2xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-black flex items-center gap-2">
                        <Send className="w-4 h-4" />{busy ? '出しています…' : '出す'}
                    </button>
                </div>
                <div className="fi-tap-text text-slate-400">
                    出すと、対象の人が次にアプリを開いた時に<b>1回だけ</b>出ます。読んだ人にはもう出ません（端末ごとに覚えます）。
                </div>
            </div>

            <div className="flex flex-col gap-2">
                {rows.map(n => {
                    const expired = !!(n.until && Date.now() > n.until);
                    const off = n.active === false;
                    const ims = noticeImagesOf(n);
                    return (
                        <div key={n.id} className={`border rounded-2xl p-3.5 ${off || expired ? 'border-slate-200 bg-slate-50' : 'border-blue-200 bg-white'}`}>
                            <div className="flex items-start gap-2 flex-wrap">
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-black text-slate-800 break-words">{n.title}</div>
                                    {n.body ? <div className="text-xs text-slate-500 mt-1 whitespace-pre-wrap break-words">{n.body}</div> : null}
                                    {ims.length > 0 && (
                                        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                                            {ims.map((im, i) => (
                                                <button key={i} onClick={() => setZoom(im)} title={im.caption || '大きく見る'}
                                                    className="w-16 h-12 rounded-lg overflow-hidden border border-slate-200 hover:border-blue-400">
                                                    <img src={im.src} alt="" className="w-full h-full object-cover object-top" />
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    <div className="fi-tap-text text-slate-400 mt-1.5 flex items-center gap-2 flex-wrap">
                                        <span>{fmt(n.createdAt)}</span>
                                        {(n.targets || ['all']).map(t => <span key={t} className="bg-slate-100 rounded px-1.5 py-0.5 font-bold">{noticeTargetLabel(t)}</span>)}
                                        {n.until ? <span className={expired ? 'text-rose-600 font-black' : ''}>{expired ? '期限切れ' : `${ymd(n.until)} まで`}</span> : null}
                                        {off ? <span className="text-slate-500 font-black">止めています</span> : null}
                                    </div>
                                </div>
                                <button onClick={() => onSave({ ...n, active: off, updatedAt: Date.now() })}
                                    title={off ? 'また出します' : 'これ以上は出しません（消しません）'}
                                    className="px-2.5 py-1.5 rounded-lg fi-tap-text font-black border bg-white text-slate-400 border-slate-200 hover:border-slate-400 flex items-center gap-1">
                                    {off ? <><Eye className="w-3.5 h-3.5" />また出す</> : <><EyeOff className="w-3.5 h-3.5" />止める</>}
                                </button>
                                <button onClick={() => { if (window.confirm('このお知らせを消します。よろしいですか？')) onDelete && onDelete(n); }}
                                    className="p-1.5 rounded-lg text-slate-300 hover:text-rose-600 hover:bg-rose-50" title="消す">
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    );
                })}
                {rows.length === 0 && (
                    <div className="text-center text-sm text-slate-400 py-8 border border-dashed border-slate-200 rounded-2xl">まだお知らせはありません</div>
                )}
            </div>
            <Lightbox src={zoom?.src} caption={zoom?.caption} onClose={() => setZoom(null)} />
        </div>
    );
};

export default NoticePopup;
