// =============================================================================
//  MascotFx.jsx — ケンサくん(ロット完了などで褒める演出)。P156: 製品 App.jsx:44037-44198 から写した。
//  部品向けの違い: 製品の fi-tap-text(部品に無い class)を text-xs に。MTog を外へ出し・使わない catch (e) を catch に。それ以外は製品と同じ。
//  lots を読むだけ・検査ロジックには触らない。
// =============================================================================
import React, { useState, useEffect, useMemo, useRef } from 'react';

const MASCOT_EMOJIS = ['🐣', '🐥', '🐤', '🐰', '🐻', '🦉', '🐧', '🐱', '🤖', '🧑‍🔧', '👷', '😊', '⭐', '🌟', '🍀', '🎉', '💪', '🦾'];
const DEFAULT_MASCOT = {
    enabled: true, name: 'ケンサくん', emoji: '🐣', position: 'top',
    confetti: true, sound: false, cooldownSec: 15, milestoneStep: 100, encourageMin: 20,
    triggers: {
        dayStart: { on: true, lines: ['今日もいちにち、ご安全に！', 'さあ、はじめよう！', 'おはよう！今日もよろしくね。'] },
        lotComplete: { on: true, lines: ['おつかれさま！', 'ナイス検査！', 'その調子！', 'バッチリ！', 'ていねいだね！', 'いい流れ！', 'きっちり仕上げたね！'] },
        milestone: { on: true, lines: ['やったね！大記録だよ！', 'すごい積み上げ！', 'どんどん進むね！'] },
        ngFound: { on: true, lines: ['ナイス発見！見つけてえらい！', 'よく気づいたね！', 'その一手間が品質を守る！'] },
        encourage: { on: false, lines: ['がんばってるね！', 'いい集中！', 'ムリせずいこう。'] },
    },
};
const MASCOT_TRIGGER_LABELS = { dayStart: '出勤あいさつ（その日いちばん最初）', lotComplete: 'ロットが完了したとき', milestone: '通算キリ番を達成したとき', ngFound: 'NG（不良）を見つけたとき', encourage: '作業中の応援（一定間隔ごと）' };
const mergeMascot = (s) => { const m = (s && s.mascot) || {}; return { ...DEFAULT_MASCOT, ...m, triggers: { ...DEFAULT_MASCOT.triggers, ...(m.triggers || {}) } }; };
const mascotConfetti = (big) => {
    try {
        if (typeof document === 'undefined') return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const cvs = document.createElement('canvas');
        cvs.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9998';
        cvs.width = window.innerWidth; cvs.height = window.innerHeight;
        document.body.appendChild(cvs);
        const ctx = cvs.getContext('2d');
        const colors = ['#10b981', '#34d399', '#6366f1', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899'];
        const parts = Array.from({ length: big ? 180 : 120 }, () => ({ x: cvs.width / 2 + (Math.random() - 0.5) * cvs.width * 0.6, y: -20 - Math.random() * cvs.height * 0.3, vx: (Math.random() - 0.5) * 7, vy: 2 + Math.random() * 5, s: 5 + Math.random() * 8, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3, c: colors[Math.floor(Math.random() * colors.length)] }));
        let frame = 0;
        const tick = () => { frame++; ctx.clearRect(0, 0, cvs.width, cvs.height); parts.forEach(p => { p.x += p.vx; p.y += p.vy; p.vy += 0.09; p.rot += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore(); }); if (frame < 170 && parts.some(p => p.y < cvs.height + 40)) requestAnimationFrame(tick); else cvs.remove(); };
        requestAnimationFrame(tick);
    } catch { /* 演出失敗は無視 */ }
};
const mascotBeep = () => {
    try {
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        const ac = new AC(); const o = ac.createOscillator(); const g = ac.createGain();
        o.type = 'sine'; o.connect(g); g.connect(ac.destination);
        o.frequency.setValueAtTime(880, ac.currentTime); o.frequency.setValueAtTime(1320, ac.currentTime + 0.09);
        g.gain.setValueAtTime(0.06, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.28);
        o.start(); o.stop(ac.currentTime + 0.3);
        setTimeout(() => { try { ac.close(); } catch { /* noop */ } }, 450);
    } catch { /* noop */ }
};
// ⚠🚨 baselineKey: **過去のロットがまとめて届いた合図**(2026-08-18)。
//   ロットの購読を「最近の分＋未完了」に細くし、過去は要る画面で1回だけ取り寄せる形にした。
//   取り寄せが届いた瞬間、完了ロットが数百件いきなり増える。ここを素通しすると
//   ケンサくんが「ロット完了！」「通算◯◯台 達成！」を **嘘で祝ってしまう**。
//   → この合図が変わったら、祝わずに基準だけ取り直す。
const MascotFx = ({ lots = [], settings = null, onSaveSettings = null, baselineKey = '' }) => {
    const cfg = useMemo(() => mergeMascot(settings), [settings]);
    const enabled = cfg.enabled !== false && settings?.funFx !== false;
    const [toast, setToast] = useState(null);
    const seenRef = useRef(null); const msRef = useRef(null); const ngRef = useRef(null);
    const baseRef = useRef(baselineKey);
    const lastShown = useRef(0); const hideT = useRef(null); const encT = useRef(null);
    const totalUnits = useMemo(() => (lots || []).reduce((n, l) => n + ((l.status === 'completed' || l.location === 'completed') ? (l.quantity || 1) : 0), 0), [lots]);
    const ngCount = useMemo(() => (lots || []).reduce((n, l) => n + Object.values(l.tasks || {}).filter(t => t && t.status === 'ng').length, 0), [lots]);
    const showRef = useRef(() => {});
    showRef.current = (key, opts = {}) => {
        const t = cfg.triggers[key] || {};
        if (!opts.force && (!enabled || t.on === false)) return;
        if (!opts.big && !opts.force && Date.now() - lastShown.current < (cfg.cooldownSec || 0) * 1000) return;
        lastShown.current = Date.now();
        const src = opts.cfg || cfg;
        const lines = (t.lines && t.lines.length) ? t.lines : ['おつかれさま！'];
        const comment = opts.comment || lines[Math.floor(Math.random() * lines.length)];
        if ((opts.confetti != null ? opts.confetti : (src.confetti !== false)) && (opts.big || key === 'lotComplete' || key === 'milestone')) mascotConfetti(opts.big);
        if (src.sound) mascotBeep();
        setToast({ emoji: opts.emoji || (opts.big ? '🏆' : (src.emoji || '🐣')), name: opts.name || src.name || 'ケンサくん', headline: opts.headline || '', comment, big: !!opts.big, position: opts.position || src.position || 'top' });
        if (hideT.current) clearTimeout(hideT.current);
        hideT.current = setTimeout(() => setToast(null), opts.big ? 6000 : 4200);
    };
    useEffect(() => {
        const completed = new Set((lots || []).filter(l => l.status === 'completed' || l.location === 'completed').map(l => l.id));
        const step = cfg.milestoneStep || 100;
        // 🚨1回目、または「過去がまとめて届いた」時は **祝わずに基準を取り直す**。
        if (seenRef.current === null || baseRef.current !== baselineKey) {
            baseRef.current = baselineKey;
            seenRef.current = completed; msRef.current = Math.floor(totalUnits / step); ngRef.current = ngCount; return;
        }
        let newly = 0; completed.forEach(id => { if (!seenRef.current.has(id)) newly++; }); seenRef.current = completed;
        const mNow = Math.floor(totalUnits / step);
        const hit = (msRef.current != null && mNow > msRef.current) ? mNow * step : null; msRef.current = mNow;
        const ngUp = (ngRef.current != null && ngCount > ngRef.current); ngRef.current = ngCount;
        if (hit) showRef.current('milestone', { big: true, headline: `通算 ${hit.toLocaleString()} 台 達成！` });
        else if (newly > 0) showRef.current('lotComplete', { headline: 'ロット完了！' });
        if (ngUp) showRef.current('ngFound');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lots, totalUnits, ngCount, baselineKey]);
    useEffect(() => {
        if (!enabled || cfg.triggers.dayStart?.on === false) return;
        try { const today = new Date().toISOString().slice(0, 10); if (localStorage.getItem('mascotDay') !== today) { localStorage.setItem('mascotDay', today); const id = setTimeout(() => showRef.current('dayStart'), 900); return () => clearTimeout(id); } } catch { /* noop */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);
    useEffect(() => {
        if (encT.current) { clearInterval(encT.current); encT.current = null; }
        if (enabled && cfg.triggers.encourage?.on) encT.current = setInterval(() => showRef.current('encourage'), Math.max(5, cfg.encourageMin || 20) * 60000);
        return () => { if (encT.current) clearInterval(encT.current); };
    }, [enabled, cfg.triggers.encourage?.on, cfg.encourageMin]);
    useEffect(() => {
        const h = (e) => { const d = e.detail || {}; showRef.current(d.key || 'lotComplete', d.opts || {}); };
        window.addEventListener('mascotFire', h);
        return () => window.removeEventListener('mascotFire', h);
    }, []);
    if (!toast) return null;
    return (
        <div className={`fixed left-1/2 -translate-x-1/2 z-[9999] pointer-events-none ${toast.position === 'bottom' ? 'bottom-6' : 'top-4'}`}>
            <div className={`bg-white/95 backdrop-blur border-2 ${toast.big ? 'border-amber-400' : 'border-emerald-300'} rounded-2xl shadow-2xl px-5 py-3 flex items-center gap-3`}>
                <span className="text-4xl animate-bounce" aria-hidden>{toast.emoji}</span>
                <div className="min-w-0">
                    {toast.headline && <div className={`font-black text-sm ${toast.big ? 'text-amber-600' : 'text-emerald-700'}`}>{toast.headline}</div>}
                    <div className={toast.headline ? 'text-xs text-slate-500' : `font-black text-sm ${toast.big ? 'text-amber-600' : 'text-emerald-700'}`}>{toast.headline ? `${toast.name}「${toast.comment}」` : toast.comment}</div>
                    {!toast.headline && <div className="text-xs text-slate-400">{toast.name}</div>}
                </div>
                {onSaveSettings && <button onClick={() => { onSaveSettings({ mascot: { ...cfg, enabled: false } }); setToast(null); }} className="pointer-events-auto text-xs text-slate-400 hover:text-slate-600 underline ml-1 self-start" title="マスコットをOFFにする(設定でいつでも戻せます)">OFF</button>}
            </div>
        </div>
    );
};
// 部品向け: 製品は MascotSettingsPanel の中で作っていた(描くたびに作り直し)。外へ出しただけで中身は同じ。
const MTog = ({ val, onChange }) => (<button type="button" onClick={() => onChange(!val)} className={`relative w-12 h-6 rounded-full transition-colors shrink-0 ${val ? 'bg-emerald-500' : 'bg-slate-300'}`}><span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${val ? 'translate-x-6' : ''}`} /></button>);
const MascotSettingsPanel = ({ settings, onSave }) => {
    const [draft, setDraft] = useState(() => mergeMascot(settings));
    const [dirty, setDirty] = useState(false);
    const set = (patch) => { setDraft(d => ({ ...d, ...patch })); setDirty(true); };
    const setTrig = (key, patch) => { setDraft(d => ({ ...d, triggers: { ...d.triggers, [key]: { ...(d.triggers[key] || {}), ...patch } } })); setDirty(true); };
    const save = () => { const clean = { ...draft, triggers: Object.fromEntries(Object.entries(draft.triggers).map(([k, v]) => [k, { ...v, lines: (v.lines || []).map(s => s.trim()).filter(Boolean) }])) }; onSave({ mascot: clean }); setDraft(clean); setDirty(false); };
    const test = () => { const lc = draft.triggers.lotComplete || {}; window.dispatchEvent(new CustomEvent('mascotFire', { detail: { key: 'lotComplete', opts: { force: true, headline: 'テスト表示', cfg: draft, comment: (lc.lines && lc.lines[0]) || 'やっほー！' } } })); };
    const enabled = draft.enabled !== false;
    return (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <div className="flex items-center justify-between gap-2 mb-1">
                <h3 className="text-lg font-bold flex items-center gap-2 text-slate-800"><span className="text-2xl">{draft.emoji}</span> マスコット（{draft.name || 'ケンサくん'}）の設定</h3>
                <MTog val={enabled} onChange={(v) => set({ enabled: v })} />
            </div>
            <p className="text-xs text-slate-500 mb-4">検査中に励ましてくれるマスコット。<b>いつ出るか・何を言うか・見た目</b>を細かく調整できます。うるさければトリガーを切るか、右上のスイッチでOFFに。</p>
            <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                    <div><label className="block text-xs font-bold text-slate-500 mb-1">名前</label><input value={draft.name} onChange={e => set({ name: e.target.value })} className="w-full border rounded p-2 text-sm" placeholder="ケンサくん" /></div>
                    <div><label className="block text-xs font-bold text-slate-500 mb-1">出る位置</label><select value={draft.position} onChange={e => set({ position: e.target.value })} className="w-full border rounded p-2 text-sm"><option value="top">画面の上</option><option value="bottom">画面の下</option></select></div>
                </div>
                <div className="mb-3"><label className="block text-xs font-bold text-slate-500 mb-1">キャラクター</label><div className="flex flex-wrap gap-1.5">{MASCOT_EMOJIS.map(em => <button key={em} type="button" onClick={() => set({ emoji: em })} className={`text-2xl w-10 h-10 rounded-lg border ${draft.emoji === em ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-300' : 'border-slate-200 hover:bg-slate-50'}`}>{em}</button>)}</div></div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-4 text-sm">
                    <label className="flex items-center gap-2"><MTog val={draft.confetti !== false} onChange={v => set({ confetti: v })} /> 紙吹雪</label>
                    <label className="flex items-center gap-2"><MTog val={!!draft.sound} onChange={v => set({ sound: v })} /> 効果音</label>
                    <label className="flex items-center gap-1 text-slate-600">連発防止 <input type="number" min="0" max="120" value={draft.cooldownSec} onChange={e => set({ cooldownSec: Math.max(0, Number(e.target.value) || 0) })} className="w-16 border rounded px-1 py-0.5" /> 秒あける</label>
                    <label className="flex items-center gap-1 text-slate-600">キリ番 <input type="number" min="10" step="10" value={draft.milestoneStep} onChange={e => set({ milestoneStep: Math.max(10, Number(e.target.value) || 100) })} className="w-20 border rounded px-1 py-0.5" /> 台ごと</label>
                </div>
                <div className="border-t pt-3 space-y-2">
                    <div className="text-sm font-bold text-slate-600">いつ出す？（それぞれON/OFF・セリフは1行に1つ・自由に編集）</div>
                    {Object.keys(MASCOT_TRIGGER_LABELS).map(key => { const t = draft.triggers[key] || {}; return (
                        <div key={key} className="border border-slate-200 rounded-lg p-2">
                            <label className="flex items-center justify-between gap-2 cursor-pointer"><span className="text-sm font-bold text-slate-700">{MASCOT_TRIGGER_LABELS[key]}</span><MTog val={t.on !== false} onChange={v => setTrig(key, { on: v })} /></label>
                            {t.on !== false && <textarea value={(t.lines || []).join('\n')} onChange={e => setTrig(key, { lines: e.target.value.split('\n') })} rows={Math.min(7, Math.max(2, (t.lines || []).length + 1))} className="w-full border border-slate-200 rounded p-1.5 text-xs mt-1" placeholder="言ってほしいセリフを1行に1つ" />}
                        </div>
                    ); })}
                </div>
            </div>
            <div className="flex items-center gap-2 mt-4">
                <button onClick={test} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold border">▶ テスト表示</button>
                <button onClick={save} disabled={!dirty} className={`ml-auto px-6 py-1.5 rounded-lg text-white text-sm font-bold ${dirty ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-slate-300 cursor-not-allowed'}`}>{dirty ? '保存する' : '保存済み'}</button>
            </div>
        </div>
    );
};

export { MascotFx, MascotSettingsPanel };
