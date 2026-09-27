// 「アプリにこうしてほしい」を現場から受け取る画面。
//
// ⚠⚠ このファイルは **製品検査アプリと最終検査アプリで同一**。片方だけ直すと必ずズレる。
//   保存・購読はここに書かない(呼び出し側から関数で受け取る)。
//   → 中身の決まりごとは src/domain/appFeedback.js
//
// 入口は2つ:
//   ① 検査側アプリのヘッダー(作業者・管理者)
//   ② 組立ポータルのヘッダー(相手側の人)
// どちらも 💡 を押すと「送る」と「みんなの声」の2枚が出る。管理用の一覧は設定タブ。
//
// ⚠⚠ 清水さん(2026-08-01):
//   「見えたら他の人たちからこんな要望出していいのか、同じこと思ってた、みたいな感じで
//     共有できるから、やりとりできるようにしておいてほしい」
//   → **出した人が返事を見られること** が要。今までは管理側の設定タブにしか一覧が無く、
//     書いた本人は返事が付いたことすら知れなかった。
//   「各種機能はＯＮＯＦＦできるようにしてほしい、何かあったら見えなくしないとだめだから」
//   → 一覧・やりとり・賛同・名前表示を個別に切れる。1件だけ隠すこともできる。

import React, { useMemo, useState } from 'react';
import { Lightbulb, X, Trash2, Send, Search, ThumbsUp, MessageSquare, EyeOff, Eye } from 'lucide-react';
import {
    FEEDBACK_KINDS, FEEDBACK_STATUS, FEEDBACK_FILTER_ACTIVE, feedbackKindOf, feedbackStatusOf,
    appLabelOf, canSubmitFeedback, buildFeedback, filterFeedback, sortFeedback, openFeedbackCount,
    commentsOf, canSubmitComment, buildComment,
    agreeKeyOf, agreeCount, hasAgreed, feedbackConfigOf, boardFeedback, displayNameOf,
} from './domain/appFeedback.js';

const STATUS_CLS = {
    rose: 'bg-rose-100 text-rose-700 border-rose-200',
    amber: 'bg-amber-100 text-amber-700 border-amber-200',
    emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    slate: 'bg-slate-100 text-slate-500 border-slate-200',
};
const fmt = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// この端末の目印。⚠賛同を「誰が押したか」で持つために要る(名前は任意入力なので鍵にできない)。
//   端末の中だけで完結する乱数。個人を特定する情報は入れない。
const DEVICE_LS_KEY = 'fbDeviceId';
export const feedbackDeviceId = () => {
    try {
        let v = localStorage.getItem(DEVICE_LS_KEY);
        if (!v) { v = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; localStorage.setItem(DEVICE_LS_KEY, v); }
        return v;
    } catch (e) { return 'nostorage'; }
};

// ---------------------------------------------------------------- 入口ボタン
export const FeedbackButton = ({ onClick, compact = false, className = '', n = 0 }) => (
    <button
        onClick={onClick}
        title="アプリに追加してほしいこと・直してほしいことを送る／みんなの声を見る"
        className={`relative ${className || (compact
            ? 'min-h-11 min-w-11 inline-flex items-center justify-center bg-amber-500 hover:bg-amber-600 text-white p-2 rounded-md shadow-sm'
            : 'bg-amber-500 hover:bg-amber-600 text-white px-3 py-2 rounded-xl text-xs font-black shadow-sm flex items-center gap-1.5')}`}>
        <Lightbulb className="w-4 h-4" />
        {!compact && <span>アプリへの要望</span>}
        {n > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white fi-tap-text font-black flex items-center justify-center border-2 border-white">{n}</span>}
    </button>
);

// ------------------------------------------------------------ 1件のカード
// ⚠一覧(みんなの声)と管理一覧で **同じ部品** を使う。別々に書くと必ず片方だけ直し忘れる。
const FeedbackCard = ({ row, config, admin = false, me, onComment, onAgree, onSetStatus, onToggleHidden, onDelete }) => {
    const [draft, setDraft] = useState('');
    const [openThread, setOpenThread] = useState(false);
    const [busy, setBusy] = useState(false);
    const k = feedbackKindOf(row.kind);
    const st = feedbackStatusOf(row.status);
    const cs = commentsOf(row);
    const myKey = me ? agreeKeyOf(me.deviceId, me.name) : '';
    const agreed = hasAgreed(row, myKey);
    const nAgree = agreeCount(row);

    const send = async () => {
        if (!canSubmitComment(draft) || busy) return;
        setBusy(true);
        try {
            await onComment(row, buildComment({ text: draft, by: (me && me.name) || '', app: (me && me.app) || '', admin, now: Date.now() }));
            setDraft('');
        } catch (e) {
            // ⚠握りつぶさない。「書けたつもり」が一番困る。
            alert(`書き込めませんでした。電波を確かめてもう一度お願いします。\n${e?.message || e}`);
        } finally { setBusy(false); }
    };

    return (
        <div className={`border rounded-2xl bg-white p-3.5 ${row.hidden ? 'border-slate-300 border-dashed bg-slate-50' : 'border-slate-200'}`}>
            <div className="flex items-start gap-2 flex-wrap">
                <span className="text-lg leading-none shrink-0">{k.emoji}</span>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-slate-800 whitespace-pre-wrap break-words">{row.text}</div>
                    <div className="fi-tap-text text-slate-400 mt-1 flex items-center gap-2 flex-wrap">
                        <span>{fmt(row.createdAt)}</span>
                        <span className="font-bold text-slate-500">{displayNameOf(row.by, { admin, showNames: config.showNames })}</span>
                        {row.where ? <span className="bg-slate-100 rounded px-1.5 py-0.5">{row.where}</span> : null}
                        <span className="bg-slate-100 rounded px-1.5 py-0.5">{appLabelOf(row.app)}{row.side === 'portal' ? '・組立' : ''}</span>
                        {row.hidden ? <span className="text-slate-500 font-black flex items-center gap-1"><EyeOff className="w-3 h-3" />みんなには出していません</span> : null}
                    </div>
                </div>
                <span className={`shrink-0 fi-tap-text font-black rounded-full border px-2 py-1 ${STATUS_CLS[st.color]}`}>{st.label}</span>
            </div>

            {/* 賛同 と やりとりを開く */}
            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                {config.agree && (
                    <button onClick={() => onAgree && onAgree(row, myKey, (me && me.name) || '')}
                        title={agreed ? 'もう一度押すと取り消せます' : '同じことを思っていた、を伝えます'}
                        className={`px-3 py-1.5 rounded-full text-xs font-black border flex items-center gap-1.5 ${agreed ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}>
                        <ThumbsUp className="w-3.5 h-3.5" />
                        同じこと思ってた{nAgree > 0 ? ` ${nAgree}` : ''}
                    </button>
                )}
                {config.comments && (
                    <button onClick={() => setOpenThread(v => !v)}
                        className="px-3 py-1.5 rounded-full text-xs font-black border bg-white text-slate-500 border-slate-200 hover:border-slate-300 flex items-center gap-1.5">
                        <MessageSquare className="w-3.5 h-3.5" />
                        やりとり{cs.length > 0 ? ` ${cs.length}` : ''}
                    </button>
                )}
                {admin && (
                    <button onClick={() => onToggleHidden && onToggleHidden(row, !row.hidden)}
                        title={row.hidden ? 'みんなの一覧に戻します' : 'みんなの一覧から隠します（消しません）'}
                        className="ml-auto px-2.5 py-1.5 rounded-lg fi-tap-text font-black border bg-white text-slate-400 border-slate-200 hover:border-slate-400 flex items-center gap-1">
                        {row.hidden ? <><Eye className="w-3.5 h-3.5" />みんなに出す</> : <><EyeOff className="w-3.5 h-3.5" />隠す</>}
                    </button>
                )}
            </div>

            {/* やりとり。⚠既定は閉じておく(全部開くと一覧が読めない)。返事が付いていれば開いて見せる。 */}
            {config.comments && (openThread || cs.length > 0) && (
                <div className="mt-2.5 flex flex-col gap-1.5">
                    {cs.map(c => (
                        <div key={c.id} className={`rounded-xl px-3 py-2 text-xs ${c.admin ? 'bg-emerald-50 border border-emerald-200' : 'bg-slate-50'}`}>
                            <div className={`font-black mb-0.5 ${c.admin ? 'text-emerald-800' : 'text-slate-600'}`}>
                                {displayNameOf(c.by, { admin, showNames: config.showNames, isAdminPost: c.admin })}
                                <span className="ml-2 font-normal text-slate-400">{fmt(c.at)}</span>
                            </div>
                            <div className="text-slate-700 whitespace-pre-wrap break-words">{c.text}</div>
                        </div>
                    ))}
                    {openThread && (
                        <div className="flex items-center gap-2">
                            <input value={draft} onChange={e => setDraft(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(); }}
                                placeholder={admin ? '返事を書く（出した人と、みんなが見ます）' : '「私もそう思う」「こういう時に困る」など'}
                                className="flex-1 border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs outline-none focus:border-slate-400" />
                            <button onClick={send} disabled={!canSubmitComment(draft) || busy}
                                className="px-3 py-1.5 rounded-xl bg-slate-700 hover:bg-slate-800 disabled:opacity-30 text-white text-xs font-black">
                                {busy ? '送信中' : '書く'}
                            </button>
                        </div>
                    )}
                    {!openThread && cs.length > 0 && (
                        <button onClick={() => setOpenThread(true)} className="fi-tap-text font-black text-slate-400 hover:text-slate-600 self-start">＋ 返事を書く</button>
                    )}
                </div>
            )}

            {/* 管理グループだけ: 状態を変える・消す */}
            {admin && (
                <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center gap-1.5 flex-wrap">
                    {FEEDBACK_STATUS.map(s => (
                        <button key={s.id} onClick={() => onSetStatus && onSetStatus(row, s.id)}
                            className={`px-2.5 py-1 rounded-lg fi-tap-text font-black border ${(row.status || 'open') === s.id ? STATUS_CLS[s.color] : 'bg-white text-slate-400 border-slate-200 hover:border-slate-300'}`}>
                            {s.label}
                        </button>
                    ))}
                    <button onClick={() => { if (window.confirm('この要望を消します。やりとりも一緒に消えます。よろしいですか？')) onDelete && onDelete(row); }}
                        className="ml-auto p-1.5 rounded-lg text-slate-300 hover:text-rose-600 hover:bg-rose-50" title="消す">
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            )}
        </div>
    );
};

// ------------------------------------------------------- みんなの声(一覧)
export const FeedbackBoard = ({ items, config, admin = false, me, onComment, onAgree, onSetStatus, onToggleHidden, onDelete, empty = 'まだ要望はありません' }) => {
    const [status, setStatus] = useState(FEEDBACK_FILTER_ACTIVE);
    const [kind, setKind] = useState('all');
    const [q, setQ] = useState('');
    const base = useMemo(() => boardFeedback(items, { admin }), [items, admin]);
    const rows = useMemo(() => sortFeedback(filterFeedback(base, { status, kind, q })), [base, status, kind, q]);
    const counts = useMemo(() => {
        // ⚠先に status 別を入れてから active/all を入れる(先に入れると 'open' に上書きされる)
        const m = {};
        FEEDBACK_STATUS.forEach(s => { m[s.id] = base.filter(r => (r?.status || 'open') === s.id).length; });
        m.all = base.length;
        m[FEEDBACK_FILTER_ACTIVE] = openFeedbackCount(base);
        return m;
    }, [base]);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
                {/* ⚠「まだ終わっていない」は 未対応+対応中。id を 'open' にすると「未対応」ボタンと重なる */}
                {[{ id: FEEDBACK_FILTER_ACTIVE, label: 'まだ終わっていない' }, { id: 'all', label: 'すべて' }, ...FEEDBACK_STATUS].map(s => (
                    <button key={s.id} onClick={() => setStatus(s.id)}
                        className={`px-3 py-1.5 rounded-full text-xs font-black border ${status === s.id ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>
                        {s.label}<span className="ml-1 opacity-70">{counts[s.id] || 0}</span>
                    </button>
                ))}
                <span className="w-px h-5 bg-slate-200 mx-1" />
                {[{ id: 'all', label: '両方' }, ...FEEDBACK_KINDS].map(k => (
                    <button key={k.id} onClick={() => setKind(k.id)}
                        className={`px-3 py-1.5 rounded-full text-xs font-black border ${kind === k.id ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>
                        {k.emoji || ''}{k.label}
                    </button>
                ))}
                <div className="relative ml-auto">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input value={q} onChange={e => setQ(e.target.value)} placeholder="言葉で探す"
                        className="border border-slate-200 rounded-full pl-8 pr-3 py-1.5 text-xs w-44 outline-none focus:border-slate-400" />
                </div>
            </div>

            <div className="flex flex-col gap-2">
                {rows.map(r => (
                    <FeedbackCard key={r.id} row={r} config={config} admin={admin} me={me}
                        onComment={onComment} onAgree={onAgree} onSetStatus={onSetStatus}
                        onToggleHidden={onToggleHidden} onDelete={onDelete} />
                ))}
                {rows.length === 0 && (
                    <div className="text-center text-sm text-slate-400 py-10 border border-dashed border-slate-200 rounded-2xl">
                        {base.length === 0 ? empty : 'このしぼり込みに合うものはありません'}
                    </div>
                )}
            </div>
        </div>
    );
};

// 管理側(設定タブ)。⚠中身は同じ部品。admin=true で状態変更と「隠す」が出る。
export const FeedbackList = (props) => <FeedbackBoard {...props} admin />;

// ---------------------------------------------------------------- 入力シート
// ⚠1画面で終わらせる。種類は大きい2択、本文は最初から開いている。
//   「どの画面で」「名前」は任意にする(必須にすると書かずに閉じられる)。
export const FeedbackModal = ({
    open, onClose, onSubmit, app, side = 'app', defaultBy = '', places = [],
    // みんなの声(見せない設定なら渡さなくてよい)
    items = null, shared = null, admin = false, onComment, onAgree, onSetStatus, onToggleHidden, onDelete,
}) => {
    const [tab, setTab] = useState('write');
    const [kind, setKind] = useState('add');
    const [text, setText] = useState('');
    const [where, setWhere] = useState('');
    const [by, setBy] = useState(defaultBy || '');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const config = useMemo(() => feedbackConfigOf(shared), [shared]);
    const me = useMemo(() => ({ deviceId: feedbackDeviceId(), name: by || defaultBy || '', app }), [by, defaultBy, app]);
    if (!open) return null;
    const draft = { kind, text };
    const ok = canSubmitFeedback(draft) && !busy;
    const showBoard = config.board && Array.isArray(items);
    const close = () => { setText(''); setWhere(''); setDone(false); setBusy(false); setTab('write'); onClose && onClose(); };
    const submit = async () => {
        if (!ok) return;
        setBusy(true);
        try {
            await onSubmit(buildFeedback({ kind, text, where, by, app, side, now: Date.now() }));
            setDone(true);
            setText(''); setWhere('');
        } catch (e) {
            // ⚠握りつぶさない。「送れたつもり」が一番困る。
            alert(`送れませんでした。電波を確かめてもう一度お願いします。\n${e?.message || e}`);
        } finally { setBusy(false); }
    };
    return (
        <div className="fixed inset-0 z-[1000] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={close}>
            <div className="bg-white w-full sm:max-w-2xl rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                <div className="sticky top-0 bg-white px-5 py-4 border-b border-slate-100 flex items-center gap-2 z-10">
                    <Lightbulb className="w-5 h-5 text-amber-500" />
                    <div className="font-black text-slate-800">アプリへの要望・不具合</div>
                    <button onClick={close} className="ml-auto p-1.5 rounded-lg hover:bg-slate-100"><X className="w-5 h-5 text-slate-400" /></button>
                </div>

                {showBoard && (
                    <div className="px-5 pt-3 flex items-center gap-1.5">
                        {[['write', '✍️ 送る'], ['board', `💬 みんなの声 ${boardFeedback(items, { admin }).length}`]].map(([id, lbl]) => (
                            <button key={id} onClick={() => setTab(id)}
                                className={`px-4 py-2 rounded-xl text-sm font-black ${tab === id ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>{lbl}</button>
                        ))}
                    </div>
                )}

                {showBoard && tab === 'board' ? (
                    <div className="p-5">
                        <div className="fi-tap-text text-slate-500 bg-slate-50 rounded-xl px-3 py-2 mb-3 leading-relaxed">
                            みんなが出した要望と、その返事です。<b>「同じこと思ってた」</b>を押すと、どれを先に直すかの目安になります。
                            {!config.showNames && <> ※お名前は出していません。</>}
                        </div>
                        <FeedbackBoard items={items} config={config} admin={admin} me={me}
                            onComment={onComment} onAgree={onAgree} onSetStatus={onSetStatus}
                            onToggleHidden={onToggleHidden} onDelete={onDelete}
                            empty="まだ誰も出していません。1番目になってください。" />
                    </div>
                ) : done ? (
                    <div className="p-8 text-center">
                        <div className="text-5xl mb-3">🙏</div>
                        <div className="font-black text-lg text-slate-800 mb-1">ありがとうございます</div>
                        <div className="text-sm text-slate-500 mb-6">受け取りました。返事が付いたら{showBoard ? '「みんなの声」' : 'この画面'}で見られます。</div>
                        <div className="flex gap-2 justify-center flex-wrap">
                            <button onClick={() => setDone(false)} className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm font-black text-slate-700">続けて書く</button>
                            {showBoard && <button onClick={() => { setDone(false); setTab('board'); }} className="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-black">みんなの声を見る</button>}
                            <button onClick={close} className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-sm font-black">閉じる</button>
                        </div>
                    </div>
                ) : (
                    <div className="p-5 flex flex-col gap-4">
                        <div>
                            <div className="text-xs font-black text-slate-500 mb-2">どちらですか？</div>
                            <div className="grid grid-cols-2 gap-2">
                                {FEEDBACK_KINDS.map(k => (
                                    <button key={k.id} onClick={() => setKind(k.id)}
                                        className={`px-3 py-3 rounded-2xl border-2 text-left ${kind === k.id ? 'border-amber-500 bg-amber-50' : 'border-slate-200 hover:border-slate-300'}`}>
                                        <div className="text-lg">{k.emoji}</div>
                                        <div className="font-black text-sm text-slate-800">{k.label}</div>
                                        <div className="fi-tap-text text-slate-500 leading-tight">{k.hint}</div>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div>
                            <div className="text-xs font-black text-slate-500 mb-1.5">どうしてほしいですか？<span className="text-rose-500 ml-1">必須</span></div>
                            <textarea value={text} onChange={e => setText(e.target.value)} rows={5} autoFocus
                                placeholder={kind === 'fix' ? '例）検査リストで指図を押しても開かないことがある' : '例）まとめて開始のあとに台数を直せるようにしてほしい'}
                                className="w-full border-2 border-slate-200 focus:border-amber-400 rounded-2xl px-3 py-2.5 text-sm outline-none resize-y" />
                            <div className="fi-tap-text text-slate-400 mt-1">うまく書けなくて大丈夫です。「〇〇の画面が見づらい」だけでも助かります。</div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <div className="text-xs font-black text-slate-500 mb-1.5">どの画面ですか？<span className="text-slate-300 ml-1">任意</span></div>
                                <input value={where} onChange={e => setWhere(e.target.value)} list="fb-places"
                                    placeholder="例）作業画面" className="w-full border-2 border-slate-200 focus:border-amber-400 rounded-xl px-3 py-2 text-sm outline-none" />
                                {places.length > 0 && <datalist id="fb-places">{places.map(p => <option key={p} value={p} />)}</datalist>}
                            </div>
                            <div>
                                <div className="text-xs font-black text-slate-500 mb-1.5">お名前<span className="text-slate-300 ml-1">任意</span></div>
                                <input value={by} onChange={e => setBy(e.target.value)}
                                    placeholder="聞き返したい時に使います" className="w-full border-2 border-slate-200 focus:border-amber-400 rounded-xl px-3 py-2 text-sm outline-none" />
                                {/* ⚠既定では名前を一覧に出さない。書いた人が不安にならないよう、その場で言う。 */}
                                <div className="fi-tap-text text-slate-400 mt-1">
                                    {config.showNames ? 'みんなの一覧にも名前が出ます。' : 'みんなの一覧には名前を出しません（管理グループだけが見ます）。'}
                                </div>
                            </div>
                        </div>

                        <button onClick={submit} disabled={!ok}
                            className="w-full py-3.5 rounded-2xl bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white font-black flex items-center justify-center gap-2">
                            <Send className="w-4 h-4" /> {busy ? '送っています…' : '送る'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default FeedbackModal;
