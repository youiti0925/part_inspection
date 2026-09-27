/* eslint-disable react-refresh/only-export-components, no-unused-vars, no-empty, react-hooks/purity, react-hooks/static-components, react-hooks/refs */
// =============================================================================
// 📨 工程連絡(連絡タブ・送るモーダル・到着予定・プッシュ・ポータル)— 製品 src/App.jsx から写した
//   P058 / P059 / P060 / P070 / P126 / P140 / P141 / P142 / P162 / P163 の画面側。
//   写した範囲: 製品 App.jsx 729-773(buildArrivalByLot)・5327-5338(RENRAKU_PORTAL)・5574-5590・5774-10625。
//   ⚠ 中身は製品のまま(見た目・動きを揃える)。eslint の上の除外は「製品のままの書き方」を
//     部品の基準値へ持ち込まない為(no-undef / JSX の未定義は除外していない=白画面の網は生きている)。
//   ⚠ App.jsx にしか無い小さな道具(納期の読み方・目標時間など)は bindContactHelpers で App から受け取る。
//     部品の同じ名前の関数を使う(品目コード= lot.model はそのまま鍵)。
// =============================================================================
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  AlertTriangle, Bell, BellRing, Check, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Clock, Copy, Download,
  HelpCircle, Lightbulb, Loader2, MessageCircle, Package, Pencil, Phone, Plus, RefreshCw, Search, Send, Settings,
  Smartphone, Trash2, Truck, User, Users, X,
} from 'lucide-react';
import { DATA_DELETE } from '../data/sentinels.js';
import {
  RANGE_OPTIONS, DEFAULT_RANGE_ID, filterByRange,
  DEFAULT_QUICK_TIMES, quickTimesOf, quickDateOptions, quickTimeLabel, dateTimeMs,
  templateWordsOf, templateWordMatches, ARRIVAL_WHEN, arrivalWhenOf,
  mergeArrivalEntries, arrivalReplyStats, finishReplyEnabled,
  buildWorkStatusRows, groupRowsByWorker, workStatusEnabled, workStatusShowName, lotFirstStartMs,
  buildHistory, arrivalAnswerSave,
} from '../domain/contactBoard.js';
import {
  MAX_SPLITS, addSplitRow, arrivalForWhen, buildArrivalDoc, draftFromArrival, finishBaseMs, formatSplits,
  isSplitArrival, splitTotalQty, splitsOf, validateSplits,
} from '../domain/arrivalSplits.js';
import { UNREAD_LANES, initSeen, laneCounts, laneOfTab, parseSeen, totalNew, withSeen } from '../domain/unreadBadge.js';
import { buildUnreadMessage, canMarkSeen, isEmbedded, parentOriginOf, parseActiveMessage, portalLayoutOf } from '../domain/portalBridge.js';
import { completeStatusLabel, isDeclined, isPartiallyNotified, remainingQtyOf } from '../domain/completeSplit.js';
import { disablePush, enablePush, listenForegroundPush, pushDeviceId, pushPlatform, pushSupportProblem, sendPushViaWorker } from '../push.js';
import { explainMissingOrder } from '../domain/progressSheet.js';
import { feedbackConfigOf } from '../domain/appFeedback.js';
import { noticeConfigOf } from '../domain/appNotices.js';
import { addWorkSeconds } from '../domain/workClock.js';
import { buildArrivalItems } from '../domain/arrivalActual.js';
import { finishEta, finishEtaView } from '../domain/finishEta.js';
import { layoutInfo, nextLayoutMode, readLayoutMode, saveLayoutMode, layoutModeLabel } from '../domain/layoutMode.js';
import Viz from '../opsim/vizKit.jsx';
import { FeedbackModal } from '../AppFeedback.jsx';
import { NoticePopup } from '../AppNotice.jsx';
import { ArrivalCheckPanel } from '../ArrivalCheck.jsx';

// 🔌 App.jsx にしか無い道具を受け取る口(App の最上位で1回だけ bindContactHelpers を呼ぶ)。
const H = {};
export const bindContactHelpers = (h) => { Object.assign(H, h || {}); };
const dueMsOf = (...a) => (H.dueMsOf ? H.dueMsOf(...a) : null);
const fmtDue = (...a) => (H.fmtDue ? H.fmtDue(...a) : String(a[0] ?? ''));
const toMsAny = (...a) => (H.toMsAny ? H.toMsAny(...a) : null);
const getEffectiveTargetTime = (...a) => (H.getEffectiveTargetTime ? H.getEffectiveTargetTime(...a) : (a[0]?.targetTime || 0));
const getLotElapsedMs = (...a) => (H.getLotElapsedMs ? H.getLotElapsedMs(...a) : 0);
const modelGroupsOf = (s) => (s && Array.isArray(s.modelGroups)) ? s.modelGroups : [];
// 部品には制御装置(ControlDeviceReadOnly)が無い。ポータルは controllers が空なので描かれない。
const ControlDeviceReadOnly = () => null;
// 到着の確かめ(ArrivalCheck)は製品でも封印中(2026-08-05)。⚠製品・最終と必ず同じ値にする。
export const ARRIVAL_CHECK_ENABLED = false;
// 工場の暦(ロット単位の暦)。部品では配る側が無いので null(=既定の暦)。
export const FactoryCalendarContext = React.createContext(null);

// 📱 PC / スマホ の見せ方(製品 App.jsx の useLayout を写した。決め方は domain/layoutMode.js の1本)
const layoutSubscribers = new Set();
let layoutModeValue = null;
const layoutModeNow = () => (layoutModeValue === null ? (layoutModeValue = readLayoutMode()) : layoutModeValue);
const setLayoutModeGlobal = (m) => { layoutModeValue = saveLayoutMode(m); layoutSubscribers.forEach(f => { try { f(); } catch { /* 1つ壊れても他は起こす */ } }); };
const viewportNow = () => {
  try { return { w: window.innerWidth || 1280, h: window.innerHeight || 800 }; } catch { return { w: 1280, h: 800 }; }
};
const useLayout = () => {
  const [, setTick] = useState(0);
  const [vp, setVp] = useState(viewportNow);
  useEffect(() => {
    const bump = () => setTick(t => t + 1);
    const onResize = () => setVp(viewportNow());
    layoutSubscribers.add(bump);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    onResize();
    return () => {
      layoutSubscribers.delete(bump);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  const mode = layoutModeNow();
  const info = layoutInfo(mode, vp.w, vp.h);
  return {
    ...info,
    vw: vp.w, vh: vp.h,
    mode,
    deviceNarrow: !layoutInfo('auto', vp.w, vp.h).wide,
    label: layoutModeLabel(mode, info.layout),
    cycle: () => setLayoutModeGlobal(nextLayoutMode(layoutModeNow())),
    setMode: setLayoutModeGlobal,
  };
};

const buildArrivalByLot = (arrivalTimes, contactRequests, lots = null) => {
  const list = (arrivalTimes || []).filter(a => a && a.id);
  // ① まず原本。ロットID = ドキュメントID なので、そのまま入れる。
  const own = {};
  list.forEach(a => { own[a.id] = a; });
  const m = { ...own };
  // ② 反映した先のロットへ「同じ原本を指し示す」だけの行を足す。
  //    src = 広げる元の到着予定(原本) / applied = どのロットへ反映したかの記録。
  // 広げてよい先か。⚠lots が渡されていない時は今までどおり全部広げる(呼び出し漏れで消えないように)。
  const liveLot = lots ? new Map((lots || []).filter(l => l && l.id).map(l => [l.id, l])) : null;
  const canSpreadTo = (id) => {
    if (!liveLot) return true;
    const l = liveLot.get(id);
    if (!l) return false;                                              // もう無いロット = 幻の行になる
    if (l.status === 'completed' || l.location === 'completed') return false; // 完了は「これから来るもの」ではない
    return true;
  };
  const spread = (src, applied) => {
    // 時間が入っていない到着予定は、広げても何も出せない(画面はどこも .time を見る)ので広げない。
    if (!src || !src.id || !src.time) return;
    const ids = Array.isArray(applied?.lotIds) ? applied.lotIds : [];
    ids.forEach(id => {
      if (!id || id === src.id) return;
      if (own[id]) return;                 // 自分の到着予定がある物には触らない
      if (!canSpreadTo(id)) return;        // ⚠実在しない/完了したロットへは広げない
      const cur = m[id];
      if (cur && (cur._spreadAt || 0) >= (applied?.at || 0)) return;  // あとから反映した方が勝つ
      // ⚠id は「見せる先のロットID」に差し替える。中身(日時・分納・台数・班)は原本のまま。
      //   _spreadAt は勝ち負けを決めるためだけの物。原本の applied を上書きしない
      //   (回答経由だと原本に applied が無く、「誰が反映したか」は依頼側にしかないため別に持つ)。
      m[id] = { ...src, id, _spreadFrom: src.id, _spreadAt: applied?.at || 0, _spreadBy: applied?.by || '' };
    });
  };
  // ②-1 自発登録の到着予定: applied は行そのものに付いている。
  list.forEach(a => spread(a, a.applied));
  // ②-2 依頼への回答: applied は依頼(contact_requests)の items[] に付いている。
  //      元の到着予定は「その item の lotId」の行。無ければ広げようがないので何もしない。
  (contactRequests || []).forEach(r => {
    (r?.items || []).forEach(it => {
      if (!it || !it.lotId || !it.applied) return;
      spread(own[it.lotId], it.applied);
    });
  });
  return m;
};
const RENRAKU_PORTAL = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('renraku') === '1';
// 「アプリとしてインストール」した時に開く先を、いま見ている画面に合わせる。
//   検査の人は検査画面(/)、組立の人は連絡ポータル(/?renraku=1)を入れたい。manifestはページに1つしか
//   紐づけられないので、ポータルで開いている時だけ差し替える。ブラウザはインストールする瞬間に読むので、
//   ここで書き換えれば間に合う。
//   ⚠これが無いと、組立が ?renraku=1 からインストールしてもアイコンを押すと検査画面が開く(=使えない)。
if (RENRAKU_PORTAL && typeof document !== 'undefined') {
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.setAttribute('href', '/manifest-renraku.json');
}
// 📱 撮影用(?live=合言葉): PCが出したQRをスマホで読むと、この画面だけが開く。
// ⚠⚠ **検査アプリ本体は一切動かさない。** スマホは携帯回線なので、
// ==================== 工程間連絡 (contact_requests / arrival_times) ====================
// 電話連絡(修正に来て/いつ来るか)を「依頼→ワンタップ返信→履歴」に置き換える。
// contact_requests: kind 'repair'(修正依頼)・'call'(呼出/質問) = すぐ行く/10分後/20分後/行けない のワンタップ返信
//                   kind 'arrival'(到着予定) = items[] を1件ずつ時間入力で返信
// arrival_times: docId=lotId の到着予定(自発登録も依頼への回答もここに集約) → 検査リストのカードにバッジ表示
const CONTACT_REPLY_CHOICES = [
  { id: 'now', label: 'すぐ行く', cls: 'bg-emerald-600 hover:bg-emerald-700' },
  { id: '10', label: '10分後', cls: 'bg-sky-600 hover:bg-sky-700' },
  { id: '20', label: '20分後', cls: 'bg-indigo-600 hover:bg-indigo-700' },
  { id: 'no', label: '行けない', cls: 'bg-rose-600 hover:bg-rose-700' },
];
// 'ack'(確認しました)は CONTACT_REPLY_CHOICES に入れてはいけない: あの配列は相手の返信ボタンを生やす元なので、
// 足すと修正依頼の返信欄に「確認しました」ボタンが増えてしまう。表示名だけここで補う。
// (これが無いと ack が素通りして、表の「返信内容」に生のまま `ack` と出る)
const CONTACT_REPLY_EXTRA_LABELS = { ack: '確認しました' };
const contactReplyLabel = (choice) => (CONTACT_REPLY_CHOICES.find(c => c.id === choice)?.label) || CONTACT_REPLY_EXTRA_LABELS[choice] || choice || '';

const InstallAppButton = ({ compact = false }) => {
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const [state, setState] = useState(() => (isStandalone() ? 'installed' : (window.__pwaInstallEvent ? 'ready' : 'wait')));
  const [swOk, setSwOk] = useState(null);
  useEffect(() => {
    const onReady = () => setState(isStandalone() ? 'installed' : 'ready');
    const onDone = () => setState('installed');
    window.addEventListener('pwa-installable', onReady);
    window.addEventListener('pwa-installed', onDone);
    // 合図が来ない時の切り分け用: Service Worker が居るかどうかだけ見ておく(原因の半分はこれ)
    if (navigator.serviceWorker?.getRegistrations) navigator.serviceWorker.getRegistrations().then(r => setSwOk(r.length > 0)).catch(() => setSwOk(false));
    // 合図はページ表示の少し後に来ることがある
    const t = setTimeout(() => setState(s => (s === 'wait' && window.__pwaInstallEvent ? 'ready' : s)), 3000);
    return () => { window.removeEventListener('pwa-installable', onReady); window.removeEventListener('pwa-installed', onDone); clearTimeout(t); };
  }, []);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints || 0) > 1);

  if (state === 'installed') {
    return <div className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">✅ このアプリは<b>入っています</b>。あとは端末の設定で通知の重要度を「緊急」に、電池を「制限なし」にすれば完了です（ヘルプの⬇️の章）。</div>;
  }
  if (state === 'ready') {
    return (
      <button
        onClick={async () => {
          const e = window.__pwaInstallEvent;
          if (!e) return;
          e.prompt();
          const r = await e.userChoice.catch(() => null);
          if (r && r.outcome === 'accepted') setState('installed');
          window.__pwaInstallEvent = null;
        }}
        className={`rounded-lg font-black text-white bg-emerald-600 hover:bg-emerald-700 flex items-center gap-1.5 ${compact ? 'px-3 py-1.5 text-sm' : 'px-4 py-2.5 text-base'}`}>
        📱 このアプリを入れる（1タップ）
      </button>
    );
  }
  // 合図が来ない = 自動では入れられない。黙らず理由と代わりの手順を出す。
  return (
    <div className="fi-tap-text text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex flex-col gap-1">
      <div className="font-bold text-slate-600">この画面からは自動で入れられません。手動で入れてください:</div>
      {ios
        ? <div><b>Safari</b>で開く →下の<b>共有</b>ボタン →「<b>ホーム画面に追加</b>」（iPhoneはこの方法だけです。<b>追加しないと通知が1件も届きません</b>）</div>
        : <div><b>Chrome</b>で開く →右上の <b>⋮</b> →「<b>アプリをインストール</b>」（無い場合は「ホーム画面に追加」）／PCはアドレスバー右端の <b>⊕</b></div>}
      <div className="text-slate-400">
        状態: {swOk === null ? '確認中…' : swOk ? '準備OK（ブラウザの合図待ち。ページを再読み込みすると出ることがあります）' : '⚠準備できていません（このブラウザは対応していない可能性があります）'}
        {!ios && ' ／ すでに入れている場合はこの表示のままです。'}
      </div>
    </div>
  );
};
const DEFAULT_CONTACT_GROUPS = ['組立', '機械', '管理者'];
const contactGroupsOf = (settings) => {
  const g = Array.isArray(settings?.contactGroups) ? settings.contactGroups.map(x => String(x || '').trim()).filter(Boolean) : [];
  return g.length ? g : DEFAULT_CONTACT_GROUPS;
};
// 相手側(前後工程)の呼び名。既定「組立」。設定で変更可(将来 機械 等が増えても呼び替えられるように)。
const contactSideLabel = (settings) => String(settings?.contactSideLabel || '').trim() || '組立';
const newContactId = () => `cr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// 班(宛先グループ)ごとのメンバー名簿 settings.contactMembers = { グループ名: [名前,...] }。
// 送信時に「宛先の人」を指名でき、ポータル/通知に「→○○さん」と出る。
const contactMembersOf = (settings) => {
  const raw = settings?.contactMembers || {};
  const out = {};
  Object.keys(raw).forEach(g => {
    const v = raw[g];
    out[g] = Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean)
      : String(v || '').split(/[,、\n]/).map(x => x.trim()).filter(Boolean);
  });
  return out;
};
// 依頼に添付された不具合報告(写真つき)を lots から引く。r.lotId + r.refIntId → interruption。
// 実体をコピーせず参照で持つ(Firestore 1MB制限と二重管理を避ける)。報告が消えたら文面だけ残る。
const contactAttachmentOf = (r, lots) => {
  if (!r || !r.refIntId || !r.lotId) return null;
  const lot = (lots || []).find(l => l && l.id === r.lotId);
  const it = (lot?.interruptions || []).find(i => i && i.id === r.refIntId);
  if (!it) return null;
  return { label: it.label || '', causeProcess: it.causeProcess || '', photos: (it.photos || []).filter(p => typeof p === 'string'), workerName: it.workerName || '' };
};
const fmtContactTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const fmtContactElapsed = (fromTs, toTs) => {
  if (!fromTs) return '';
  const sec = Math.max(0, Math.floor(((toTs || Date.now()) - fromTs) / 1000));
  if (sec < 60) return `${sec}秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${m % 60 ? `${m % 60}分` : ''}`;
  return `${Math.floor(h / 24)}日`;
};
// ⚠種類を1つ足したら、名前・色(表/履歴)・状況判定・しぼり込み・詳細・通知・音・未読・催促の除外まで
//   全部そろえること。1つでも抜けると「動いているように見えて全部間違った顔」になる。
// ⚠🆕 newlot = 組立が「検査リストに無いもの」を知らせてきた連絡。
//   ここに足さないと、else に落ちて **「修正依頼」の名前で** 出る(まったく別の話に見える)。
const contactKindLabel = (req) => req?.kind === 'arrival' ? '到着予定' : (req?.kind === 'finish' ? '終了予定' : (req?.kind === 'complete' ? '検査完了' : (req?.kind === 'internal' ? '社内連絡' : (req?.kind === 'portalmsg' ? '組立から連絡' : (req?.kind === 'newlot' ? '新規検査の連絡' : (req?.kind === 'call' ? '呼出・連絡' : '修正依頼'))))));
const contactStatusInfo = (req) => {
  if (!req) return { label: '', cls: '' };
  if (req.status === 'canceled') return { label: '取消', cls: 'bg-slate-100 text-slate-400 border-slate-300' };
  // 組立から届いた連絡は「こちらが返事を待たせている物」ではない。
  //   待ち扱いにすると永久に「待ち」で残り、催促の対象に見える。
  if (req.kind === 'portalmsg') return req.answer
    ? { label: '確認済', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' }
    : { label: '連絡あり', cls: 'bg-teal-100 text-teal-700 border-teal-300' };
  // 🆕 組立からの「検査リストに無いもの」の連絡。こちらがやる事は1つ=検査対象に登録すること。
  //   だから状況も「登録したか」で言い切る(「返信あり」では何をしたのか分からない)。
  //   ⚠ここで新しいラベルの文字を作ったら、**状況のしぼり込み(statusF)にも同じ文字を足すこと**。
  //     足し忘れると「待ち」や「返信あり」で絞った瞬間、この行が表から消える。
  if (req.kind === 'newlot') return req.lotId
    ? { label: '登録済', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' }
    : { label: '待ち(未登録)', cls: 'bg-rose-100 text-rose-700 border-rose-300 animate-pulse' };
  if (req.kind === 'arrival' || req.kind === 'finish') {
    const items = req.items || [];
    const done = items.filter(i => i.time).length;
    if (items.length && done >= items.length) return { label: '返信あり', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' };
    if (done > 0) return { label: `返信 ${done}/${items.length}`, cls: 'bg-sky-100 text-sky-700 border-sky-300' };
    return { label: '待ち', cls: 'bg-amber-100 text-amber-700 border-amber-300 animate-pulse' };
  }
  if (req.status === 'answered') return { label: '返信あり', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' };
  if (req.status === 'done') return { label: '対応済み', cls: 'bg-slate-100 text-slate-500 border-slate-300' };
  // 'notice' = 返事を求めないお知らせ(完了連絡で「確認返信」をOFFにした時)。待ち扱いにすると永久に「待ち」で残るため別ラベル。
  if (req.status === 'notice') return { label: '通知のみ', cls: 'bg-slate-100 text-slate-500 border-slate-300' };
  return { label: '待ち', cls: 'bg-amber-100 text-amber-700 border-amber-300 animate-pulse' };
};
// 連絡一覧の1行の見せ方。種類によって「意味のある欄」が違うので、**関係ない欄は必ず「—」**にする。
//   ⚠⚠ 相手が自分から知らせてきた到着予定(自発)は、こちらが送ったものでも返信でもない。
//     それを「送信時間 / 返信あり / 返信時間 / 返信内容」の欄にそのまま流し込んでいたので、
//     こちらが何も返していないのに「返信あり・返信時間・返信内容」が埋まって見えていた(現場が混乱)。
//     到着予定の日時は専用の「予定日時」欄に出し、状況は「連絡あり / 返事済」で言い分ける。
// 分納の便を「表に出せる形」に整える(早い順・日付が空の古い記録は代表日で補うだけ)。
//   ⚠無い日付は作らない。fallbackDate はその記録に実際に入っている代表日だけを使う。
const splitRowsForDisplay = (sp, fallbackDate = '') => (sp || [])
  .map(s => ({ ...s, date: s.date || fallbackDate || '' }))
  .sort((a, b) => {
    const ta = dateTimeMs(a.date, a.time); const tb = dateTimeMs(b.date, b.time);
    return (ta == null ? Infinity : ta) - (tb == null ? Infinity : tb);
  });
// ⚠第3引数 splitsByLot = ロットID → 分納の便[]。分納の内訳は arrival_times にしか無いので、
//   依頼(contact_requests)の行から便を出すには外から渡してもらうしかない。
const contactRowCells = (r, nowTick, splitsByLot = {}) => {
  const st = contactStatusInfo(r);
  const waiting = st.label.startsWith('待ち') || st.label.startsWith('返信 ');
  // (A) 相手が自分から知らせてきた到着予定
  if (r._self) {
    const it = (r.items || [])[0] || {};
    const fin = r._finish || null;
    const sp = r._splits || [];
    return {
      // ⚠⚠ 分納は **便ごとに日付を付ける**(清水さん 2026-08-05「分納のとき片方の日付が出てない、時間だけ出てる」)。
      //   今まで: 頭に日付を1つ + formatSplits(sp) = 時刻だけ、だった。
      //   ところが arrival_times の date は buildArrivalDoc が入れる「**一番早い便**の日付」。
      //   だから 8/5 15:00 と 8/6 10:00 の分納だと「08/05 分納2回 15:00×2台 / 10:00×2台」と出て、
      //   2便目の 8/6 がどこにも出ず、しかも 15:00→10:00 と逆さまに読めてしまっていた。
      //   → 見出しは「分納2回 計4台」だけにして、中身は下の whenSplits で1便1行に分ける。
      when: sp.length > 1
        ? `分納${sp.length}回 計${splitTotalQty(sp)}台`
        : (it.time ? `${String(it.date || '').slice(5).replace('-', '/')} ${it.time}` : ''),
      // 便ごとの明細(早い順)。⚠日付が空の古い記録は、その記録の代表日で補うだけ。無い日付は作らない。
      whenSplits: sp.length > 1 ? splitRowsForDisplay(sp, it.date) : [],
      whenKind: sp.length > 1 ? '分納' : '到着',
      status: fin ? { label: '返事済', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' }
                  : { label: '連絡あり', cls: 'bg-teal-100 text-teal-700 border-teal-300' },
      sentAt: r.createdAt, sentLabel: '相手から連絡が来た時刻',
      elapsed: null,                                  // 返事を待たせている時間ではないので出さない
      replyAt: fin?.at || null,
      replyText: fin?.ts ? `🏁 検査終了予定 ${fmtContactDT(fin.ts)}` : '',
      replyGood: !!fin,
    };
  }
  // (B) 到着予定を聞いた依頼 / いつ終わる？の質問 — 回答は items[] に入る
  if (r.kind === 'arrival' || r.kind === 'finish') {
    const done = (r.items || []).filter(i => i && i.time);
    const rAt = contactReplyAt(r);
    // 🚚 依頼への返事で分納が来た分も、自発登録と同じように**便ごとに1行**で出す。
    //   ⚠依頼の items[] には「一番早い便」しか書かれていない(便の内訳は arrival_times.splits)。
    //     ここを出していなかったので、依頼経由で答えた分納は2便目以降が表のどこにも出ていなかった。
    //   ⚠回答が1件の時だけにする。複数ロットの便を1つの欄に混ぜると、どの指図の便か分からなくなる。
    const sp = (r.kind === 'arrival' && done.length === 1 && done[0].lotId)
      ? (splitsByLot[done[0].lotId] || []) : [];
    const multi = sp.length > 1;
    return {
      when: multi
        ? `分納${sp.length}回 計${splitTotalQty(sp)}台`
        : (done.length === 1 ? `${String(done[0].date || '').slice(5).replace('-', '/')} ${done[0].time}` : (done.length ? `${done.length}件` : '')),
      whenSplits: multi ? splitRowsForDisplay(sp, done[0].date) : [],
      whenKind: multi ? '分納' : (r.kind === 'arrival' ? '到着' : '終了'),
      status: st,
      sentAt: r.createdAt, sentLabel: 'この依頼を送った時刻',
      elapsed: waiting ? 'waiting' : (rAt || null),
      replyAt: rAt,
      replyText: contactAnswerSummary(r),
      replyGood: done.length > 0,
    };
  }
  // (C) 検査完了のお知らせ — 確認返信を求めない設定(notice)なら、返事の欄は最初から「—」
  if (r.kind === 'complete') {
    const noAck = r.needAck === false || r.status === 'notice';
    return {
      when: '', whenKind: '',
      status: st,
      sentAt: r.createdAt, sentLabel: '完了を知らせた時刻',
      elapsed: noAck ? null : (waiting ? 'waiting' : (r.answer?.at || null)),
      replyAt: noAck ? null : (r.answer?.at || null),
      replyText: noAck ? '' : contactAnswerSummary(r),
      replyGood: !!r.answer,
    };
  }
  // (C2) 組立から届いた連絡 — こちらが送った物ではないので「経過」は出さない(出すと催促中に見える)
  if (r.kind === 'portalmsg') {
    return {
      when: '', whenKind: '',
      status: st,
      sentAt: r.createdAt, sentLabel: '組立から連絡が来た時刻',
      elapsed: null,
      replyAt: r.answer?.at || null,
      replyText: contactAnswerSummary(r),
      replyGood: !!r.answer,
    };
  }
  // (C3) 🆕 組立からの「検査リストに無いもの」の連絡
  //   ⚠これが無いと下の (D) に落ちて、①「送った時刻」= こちらから送った顔になり
  //     ②予定日時が常に「—」= 組立が入れてくれた到着予定が表のどこにも出なくなる。
  if (r.kind === 'newlot') {
    const it = (r.items || [])[0] || {};
    return {
      // 到着予定は任意。入っていない時は無理に埋めない(元データに無い値を作らない)。
      when: it.time ? `${String(it.date || '').slice(5).replace('-', '/')} ${it.time}` : '',
      whenSplits: [],
      whenKind: '到着',
      status: st,
      sentAt: r.createdAt, sentLabel: '組立から連絡が来た時刻',
      // 経過 = 登録するまで待たせている時間。放置していることが一目で分かるように出す。
      elapsed: r.lotId ? null : 'waiting',
      replyAt: null,
      replyText: contactAnswerSummary(r),
      replyGood: !!r.lotId,
    };
  }
  // (D) 修正・呼出・社内連絡 — 今までどおり
  return {
    when: '', whenKind: '',
    status: st,
    sentAt: r.createdAt, sentLabel: '送った時刻',
    elapsed: waiting ? 'waiting' : (r.answer?.at || null),
    replyAt: r.answer?.at || null,
    replyText: contactAnswerSummary(r),
    replyGood: !!r.answer,
  };
};
const contactReplyAt = (req) => {
  if (!req) return null;
  if (req.kind === 'arrival' || req.kind === 'finish') { const ts = (req.items || []).map(i => i.at || 0).filter(Boolean); return ts.length ? Math.max(...ts) : null; }
  return req.answer?.at || null;
};
const contactAnswerSummary = (req) => {
  if (!req) return '';
  if (req.kind === 'arrival' || req.kind === 'finish') {
    const done = (req.items || []).filter(i => i.time);
    if (!done.length) return '';
    return done.map(i => `${i.orderNo || ''}→${i.date ? `${String(i.date).slice(5).replace('-', '/')} ` : ''}${i.time}`).join(' / ');
  }
  // 🆕「検査リストに無いもの」の連絡は、返信ではなく「登録したかどうか」が答え。
  if (req.kind === 'newlot') return req.lotId ? '検査対象に登録しました' : '登録待ち';
  const a = req.answer;
  if (a) return `${contactReplyLabel(a.choice)}${a.by ? ` — ${a.by}` : ''}${a.comment ? `（${a.comment}）` : ''}`;
  // 返信が無い時、「返事を待っている」のか「そもそも返事を求めていない」のかを言い分ける。
  // 完了連絡は確認返信OFF(status='notice')で送れるので、空欄のままだと「無視されている」ように見えてしまう。
  if (req.status === 'notice') return '返信不要で送信（お知らせのみ）';
  if (req.kind === 'complete') return '確認待ち';
  return '';
};

// ---- 返信の画面内通知 + 到着回答→検査リスト反映 ----
// あっちからの返信は、プッシュ通知(携帯が鳴る)に加えて「画面内の通知(ティッカー+連絡タブの赤バッジ)」でも気づける。
// 既読はこの端末だけ(localStorage)。連絡タブを開いたら自動で既読になる。
const CONTACT_SEEN_LS_KEY = 'contactRepliesSeenAt';
// 組立ポータル側の既読。班ごと・レーンごとに持つ({班:{todo,done,finish}})。→ src/domain/unreadBadge.js
const PORTAL_SEEN_LS_KEY = 'renrakuSeenLanes';
// 到着回答(date+time)→タイムスタンプ。dateが無い回答は当日扱い。
const contactArrivalDT = (it) => {
  if (!it || !it.time) return null;
  const d = it.date || (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; })();
  const ts = new Date(`${d}T${it.time}`).getTime();
  return Number.isFinite(ts) ? ts : null;
};
const fmtContactDT = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
// contactRequests → 画面内通知に出す「連絡の出来事」一覧(新しい順)。
//   あっちの返信・到着回答だけでなく、あっちからの質問(いつ終わる?)・現場からの社内連絡・会話コメント、
//   さらに「こっちから出した連絡」も含める → どの作業者の画面でも、連絡が動いたことに気づける。
//   自分がやった事(by === meName)は自分の画面には出さない(自分の操作を自分に通知しても意味がない)。
const contactFeedEvents = (contactRequests, meName = '') => {
  const evs = [];
  const mine = (n) => !!meName && String(n || '').trim() === String(meName).trim();
  (contactRequests || []).forEach(r => {
    if (!r || r.status === 'canceled') return;
    const ord = r.orderNo ? `指図${r.orderNo} ` : '';
    // ① 到着予定の回答(1件ずつ) — 1タップで検査リストへ反映に進める
    if (r.kind === 'arrival') {
      (r.items || []).forEach((it, idx) => {
        if (it && it.time && it.at) evs.push({
          key: `arr-${r.id}-${idx}`, type: 'arrival', dir: 'in', at: it.at, reqId: r.id, itemIdx: idx, it,
          text: `🚚 ${it.orderNo || ''} ${it.model || ''} → 到着 ${it.date ? `${String(it.date).slice(5).replace('-', '/')} ` : ''}${it.time}`,
          by: it.by || '',
        });
      });
    }
    // ② あっちのワンタップ返信(修正/呼出への返事・完了連絡の確認)
    if (r.answer && r.answer.at) {
      evs.push({
        key: `ans-${r.id}`, type: 'answer', dir: 'in', at: r.answer.at, reqId: r.id,
        text: `↩ ${contactReplyLabel(r.answer.choice)}${r.answer.comment ? `（${r.answer.comment}）` : ''} — ${ord}${String(r.message || '').slice(0, 30)}`,
        by: r.answer.by || '', no: r.answer.choice === 'no',
      });
    }
    // ③ 届いた依頼: あっちからの「いつ終わる？」/ 現場からの社内連絡 / 🆕検査リストに無いものの連絡
    //   ⚠🆕 newlot をここに足さないと、画面内の知らせも連絡タブの赤い数字もアプリの数字も一切増えない。
    //     PCを前にして仕事している端末ではOS通知が出ないので、ここが唯一の気づく道になる。
    if ((r.kind === 'finish' || r.kind === 'internal' || r.kind === 'portalmsg' || r.kind === 'newlot') && r.createdAt && !mine(r.from)) {
      evs.push({
        key: `req-${r.id}`, type: r.kind, dir: 'in', at: r.createdAt, reqId: r.id,
        text: r.kind === 'finish'
          ? `🏁 いつ終わる？ ${(r.items || []).map(i => `${i.orderNo || ''} ${i.model || ''}`).join(' / ').slice(0, 40)}`
          // 組立からの連絡は「どれの話か(指図・機番)」を必ず先に出す。番号が無いと現場では動けない。
          : r.kind === 'portalmsg'
            ? `💬 組立から ${r.orderNo || ''}${r.serialNo ? ` 機番${r.serialNo}` : ''}: ${String(r.message || '').slice(0, 40)}`
            : r.kind === 'newlot'
              ? `🆕 検査リストに無い品 ${r.orderNo || ''} ${r.model || ''} ${r.quantity || 0}台: ${String(r.message || '').slice(0, 30)}`
              : `🏭 社内連絡${r.topic ? `（${r.topic}）` : ''}: ${String(r.message || '').slice(0, 40)}`,
        by: r.from || '',
      });
    }
    // ④ こっちから出した連絡 = 他の作業者の画面にも「連絡が出た」と出す(出した本人には出さない)
    if ((r.kind === 'repair' || r.kind === 'call' || r.kind === 'arrival' || r.kind === 'complete') && r.createdAt && !mine(r.from)) {
      evs.push({
        key: `out-${r.id}`, type: 'sent', dir: 'out', at: r.createdAt, reqId: r.id,
        text: `📤 ${r.to}へ ${contactKindLabel(r)}: ${r.kind === 'arrival' ? `${(r.items || []).length}件` : `${ord}${String(r.message || '').slice(0, 30)}`}`,
        by: r.from || '',
      });
    }
    // ⑤ 会話(スレッド)のコメント — 相手からも、検査の別の人からも
    (r.comments || []).forEach(c => {
      if (!c || !c.at || mine(c.by)) return;
      evs.push({
        key: `cmt-${r.id}-${c.id}`, type: 'comment', dir: c.side === 'portal' ? 'in' : 'out', at: c.at, reqId: r.id,
        text: `💬 ${c.by}: ${String(c.text || '').slice(0, 40)} — ${ord}${contactKindLabel(r)}`,
        by: c.by || '',
      });
    });
  });
  return evs.sort((a, b) => b.at - a.at);
};
// 出来事の種類ごとの見出し・色。dir 'out'(こっちから出した連絡)は落ち着いた色 = 作業の手を止める話ではないため。
const CONTACT_EVENT_LOOK = {
  arrival:  { head: '🚚 到着予定の返信が届きました', cls: 'border-teal-400',   headCls: 'bg-teal-50 text-teal-700' },
  answer:   { head: '↩ 連絡の返信が届きました',      cls: 'border-emerald-400', headCls: 'bg-emerald-50 text-emerald-700' },
  finish:   { head: '🏁 「いつ終わる？」と聞かれています', cls: 'border-indigo-400', headCls: 'bg-indigo-50 text-indigo-700' },
  internal: { head: '🏭 現場から社内連絡が届きました', cls: 'border-indigo-500', headCls: 'bg-indigo-50 text-indigo-800' },
  comment:  { head: '💬 会話に返事がありました',      cls: 'border-blue-400',   headCls: 'bg-blue-50 text-blue-700' },
  portalmsg:{ head: '💬 組立から連絡が届きました',    cls: 'border-teal-500',   headCls: 'bg-teal-50 text-teal-800' },
  // 🆕 検査リストに無い品の連絡。修正依頼(オレンジ)・到着予定(ティール)と必ず違う色にする。
  newlot:   { head: '🆕 検査リストに無い品の連絡です', cls: 'border-rose-500',   headCls: 'bg-rose-50 text-rose-700' },
  sent:     { head: '📤 連絡を出しました',            cls: 'border-slate-300',  headCls: 'bg-slate-50 text-slate-500' },
};
// 画面内ティッカー: 未読の連絡を左下に表示(どのタブ・作業画面に居ても気づける)。到着回答は1タップで検査リストへ反映に進める。
const ContactReplyTicker = ({ events, onSeen, onOpenTab, onApply, settings }) => {
  if (!events || !events.length) return null;
  const shown = events.slice(0, Math.max(1, Math.floor(Number(contactTickerCfg(settings).maxShown) || 3)));
  return (
    <div className="fixed bottom-4 left-4 z-[85] w-[360px] max-w-[92vw] flex flex-col gap-2">
      {shown.map(ev => {
        const look = CONTACT_EVENT_LOOK[ev.type] || CONTACT_EVENT_LOOK.answer;
        return (
        <div key={ev.key} className={`bg-white rounded-xl shadow-2xl border-2 overflow-hidden ${ev.no ? 'border-rose-400' : look.cls}`}>
          <div className={`px-3 py-1.5 fi-tap-text font-black flex items-center gap-1.5 ${ev.no ? 'bg-rose-50 text-rose-700' : look.headCls}`}>
            <MessageCircle className="w-3.5 h-3.5" /> {ev.no ? '⚠ 「行けない」と返信がありました' : look.head}
            <span className="ml-auto font-mono text-slate-400 font-normal">{fmtContactTime(ev.at)}</span>
          </div>
          <div className="px-3 py-2 text-sm font-bold text-slate-800">{ev.text}{ev.by ? <span className="text-xs text-slate-400 font-normal">（{ev.by}）</span> : null}</div>
          <div className="px-3 pb-2 flex gap-2">
            {ev.type === 'arrival' ? (
              <button onClick={() => onApply(ev)} className="flex-1 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-black flex items-center justify-center gap-1"><Truck className="w-4 h-4" /> 検査リストへ反映</button>
            ) : (
              <button onClick={onOpenTab} className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-black">連絡タブで見る</button>
            )}
          </div>
        </div>
        );
      })}
      <div className="flex items-center gap-2">
        {events.length > shown.length && <button onClick={onOpenTab} className="text-xs font-bold text-blue-700 bg-white/90 border border-blue-200 rounded-lg px-2 py-1 shadow">ほか {events.length - shown.length}件 → 連絡タブ</button>}
        <button onClick={onSeen} className="ml-auto text-xs font-bold text-slate-500 bg-white/90 border border-slate-300 rounded-lg px-2.5 py-1 shadow hover:bg-slate-50">✕ すべて既読にする</button>
      </div>
    </div>
  );
};
// 到着回答→検査リストへ反映モーダル:
// ①同じ指図のロット(テンプレ違いも全部)から対象を選ぶ ②入荷時間(entryAt)へ反映
// ③終了予定 = 到着 + 検査の見積時間(目標×台数) を自動計算 → 実際に合わせて修正可 → 「返信」で相手に知らせる
//
// ⚠到着予定は2つの入口(組立の自発登録 / 検査が聞いた依頼への回答)から来るが、
//   画面も返信も同じであるべきなので、このモーダル1本で両方を扱う。
//   入口は entry.source ('self' | 'req') で見分け、返事の書き込み先だけ切り替える。
//   entry = contactBoard.mergeArrivalEntries() が返す1件。
const ContactArrivalApplyModal = ({ entry, contactRequests = [], lots, templates, settings, saveData, notifyPush, currentUserName, estimateSecOf, onClose }) => {
  // 📅 工場の暦(祝日表)。🚨 hooks はガード(return null)より **上**(2026-08-27)。
  const factoryCalBatch = React.useContext(FactoryCalendarContext);
  const it = entry || null;
  // ⚠分納(何時に何台)のときは、**最後の便**が着いてから全部が終わる。
  //   入荷時間(entryAt)は「最初に物が来る時刻」= 作業を始められる時刻なので entry.ts(一番早い便)。
  //   終了予定の計算だけ最後の便を基準にする(ここを混ぜると、必ず早すぎる終了予定を送ってしまう)。
  const splits = useMemo(() => (Array.isArray(entry?.splits) ? entry.splits : []), [entry]);
  const isSplit = splits.length > 1;
  const arriveTs = entry?.ts ?? null;
  const finishBase = isSplit ? finishBaseMs({ splits }) : arriveTs;
  const candidates = useMemo(() => (lots || [])
    .filter(l => l && l.status !== 'completed' && ((it?.orderNo && l.orderNo === it.orderNo) || l.id === it?.lotId))
    .sort((a, b) => ((a.id === it?.lotId) ? -1 : 0) - ((b.id === it?.lotId) ? -1 : 0)),
  [lots, it]);
  const [sel, setSel] = useState(() => {
    const m = {};
    const own = (lots || []).find(l => l && l.id === it?.lotId && l.status !== 'completed');
    if (own) m[own.id] = true;
    return m;
  });
  // 候補が1件だけなら自動選択(テンプレ選択の手間を省く)
  useEffect(() => { if (candidates.length === 1 && !Object.values(sel).some(Boolean)) setSel({ [candidates[0].id]: true }); }, [candidates.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const selLots = candidates.filter(l => sel[l.id]);
  // 終了予定は「到着時刻から実際に働ける時間だけ進めた」時刻。到着＋見積を素で足すと、休憩・定時・土日を
  // 無視して 16:00着+3h=19:00 のような、現場では絶対に成り立たない時刻を組立に送ってしまう。
  // 🚨🚨 2026-08-20 緊急是正: 組立へ返す終了予定に **未承認の残業**が入っていた。
  //   addWorkSeconds の第4引数(includeOvertime)の既定は **true**。渡していなかったので、
  //   1日の終わりが 17:00 ではなく **19:15** になり、まだ承認もされていない残業2時間を
  //   勘定に入れた時刻を、そのまま組立へ送れる状態だった。
  //   ⚠この画面は「休憩・定時・土日は避けて計算」と説明している。**説明と実際が逆**だった。
  //   ⚠settings の includeOvertimeInCapacity を暗黙に流用しない。
  //     「その日の残業が承認済み」という **日付単位の事実** が無い限り、終了予定へ入れてはいけない。
  //   ⚠addWorkSeconds 本体の既定は変えない（他の呼び出しへ波及するため）。ここで明示する。
  //   📅 2026-09-01 工場の暦(祝日表)も渡す。祝日を跨ぐと終了予定が必ず外れていた。
  const estFinishOf = (lot) => (finishBase == null ? null
    : addWorkSeconds(finishBase, estimateSecOf(lot) || 0, settings?.workSchedule, false, factoryCalBatch));
  const autoFinishTs = (() => {
    if (!selLots.length || finishBase == null) return null;
    const ends = selLots.map(l => estFinishOf(l)).filter(t => Number.isFinite(t));
    return ends.length ? Math.max(...ends) : null; // 算出不可(見積が巨大)は混ぜない
  })();
  const [finishEdit, setFinishEdit] = useState(null); // null=自動計算のまま / {date,time}=手で修正した
  const finishTs = (() => {
    if (finishEdit && finishEdit.time) { const t = new Date(`${finishEdit.date}T${finishEdit.time}`).getTime(); if (Number.isFinite(t)) return t; }
    return autoFinishTs;
  })();
  const toDateStr = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const toTimeStr = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const tplName = (lot) => (templates || []).find(t => t.id === lot.templateId)?.name || '';
  const portalLink = (() => { try { return `${window.location.origin}/?renraku=1`; } catch (e) { return ''; } })();
  const finishOn = finishReplyEnabled(settings);
  const doApply = (alsoReply) => {
    if (!arriveTs || !selLots.length) return;
    if (alsoReply && !finishTs) return;
    // 入荷時間(entryAt)を選んだロットへ反映(検査リスト・作業予定・リードタイム集計が全部この値を見る)
    selLots.forEach(l => saveData('lots', l.id, { entryAt: arriveTs }));
    const now = Date.now();
    const applied = { at: now, by: currentUserName || '', lotIds: selLots.map(l => l.id), entryAt: arriveTs };
    const finish = (alsoReply && finishTs) ? { at: now, by: currentUserName || '', ts: finishTs } : null;
    // 返事の書き込み先は入口で変わる。依頼への回答は依頼の items[]、自発登録は arrival_times のその行。
    if (entry.source === 'req') {
      const req = (contactRequests || []).find(r => r && r.id === entry.reqId);
      // ⚠回答まわりの書き込みは全部 arrivalAnswerSave を通す(items[] と itemAnswers の両方を書く)
      const pat = { applied, ...(finish ? { finish } : {}) };
      const sv = arrivalAnswerSave(req, entry.itemIdx, pat, pat);
      if (req) saveData('contact_requests', req.id, { items: sv.items, itemAnswers: sv.itemAnswers });
    } else if (entry.lotId) {
      saveData('arrival_times', entry.lotId, { applied, ...(finish ? { finish } : {}) });
    }
    // 🚚 ⚠ここで到着予定の札(arrival_times)を**複製しない**。
    //   同じ指図でもテンプレ違いでロットが分かれる(実データ: 指図1001308543 TBS-130 は4ロット)ので、
    //   一度「反映した全ロットへ札も複製する」を作ったが、元の困りごとより害が大きかったので撤回した:
    //     ・複製した札が連絡タブの表で「自発(＝組立が自分で登録した)」に見え、逆の意味になる
    //     ・複製に返事(finish)が伝わらず、同じ返事をロット数ぶん求められる
    //     ・組立ポータルに同じ文字列の行がロット数ぶん並び、未読の赤い数字もロット数ぶんになる
    //     ・返信のたびに組立へ同じ🏁通知がもう一度飛ぶ
    //   → 記録は1件のまま。別ロットに札を「見せる」のは表示側でやる(applied.lotIds を辿る)。
    //     場所: buildArrivalByLot()。
    if (finish && notifyPush) {
      notifyPush({ toSide: 'portal', toGroup: entry.group || '', title: `🏁 検査終了予定: ${it.orderNo || ''} → ${fmtContactDT(finishTs)}`, body: `${currentUserName || '検査'} より（到着 ${it.time} の予定で計算）`, link: portalLink, tag: `fin-${entry.key}` });
    }
    onClose();
  };
  if (!it || !it.time || arriveTs == null) return null;
  return (
    <div className="fixed inset-0 z-[96] bg-black/50 flex items-center justify-center p-4" onClick={() => onClose()}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 bg-teal-600 text-white flex items-center gap-2 shrink-0">
          <Truck className="w-5 h-5" />
          <span className="font-black">到着予定を検査リストへ反映</span>
          <button onClick={() => onClose()} className="ml-auto p-1 hover:bg-white/20 rounded-full"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 overflow-y-auto flex flex-col gap-3 text-sm">
          <div className="bg-teal-50 border border-teal-200 rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap">
            <span className="font-mono font-black text-slate-700">{it.orderNo}</span>
            <span className="font-bold text-slate-600">{it.model}{it.modelText ? <span className="font-normal text-slate-400"> {it.modelText}</span> : null}</span>
            {/* 📋 組立が選んだテンプレート。下のロット選びで「どっちのテンプレか」を迷わないよう見出しに出す */}
            {it.templateName && <span className="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5">📋 {it.templateName}</span>}
            <span className="ml-auto font-black text-teal-700">🚚 到着 {fmtContactDT(arriveTs)}</span>
            {it.by && <span className="text-xs text-slate-400">回答: {it.by}</span>}
            {/* 分納は内訳を必ず出す。何台ずつ来るのかで段取りが変わる */}
            {isSplit && (
              <div className="w-full mt-1 bg-white border border-teal-200 rounded-lg px-2.5 py-2">
                {/* ⚠合計が指図の台数に足りない時は必ず言う。黙っていると「これで全部」と誤解される。 */}
                <div className="fi-tap-text font-black text-teal-700 mb-0.5">
                  🚚 分納 {splits.length}回・合計 {splitTotalQty(splits)}台
                  {it.quantity ? <span className="text-slate-500 font-bold"> / この指図 {it.quantity}台</span> : null}
                  {it.quantity && splitTotalQty(splits) < it.quantity
                    ? <span className="text-amber-700"> ⚠ 残り {it.quantity - splitTotalQty(splits)}台 は未定です</span> : null}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {splits.map((s, i) => (
                    <span key={i} className="text-xs font-black bg-teal-50 text-teal-800 rounded-lg px-2 py-1">
                      {i + 1}便 {String(s.date || '').slice(5).replace('-', '/')} {s.time} × {s.qty}台
                    </span>
                  ))}
                </div>
                <div className="fi-tap-text text-slate-500 mt-1">終了予定は<b>最後の便（{fmtContactDT(finishBase)}）</b>を基準に計算します。入荷時間は最初の便を入れます。</div>
              </div>
            )}
          </div>
          <div>
            <div className="text-xs font-black text-slate-500 mb-1">① 入荷時間を入れるロットを選ぶ {candidates.length > 1 && <span className="text-amber-600">（同じ指図でテンプレートが分かれています。当てはまる方＝わからなければ両方を選んでください）</span>}</div>
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-56 overflow-y-auto">
              {candidates.map(l => (
                <label key={l.id} className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer ${sel[l.id] ? 'bg-teal-50' : 'hover:bg-slate-50'}`}>
                  <input type="checkbox" checked={!!sel[l.id]} onChange={e => setSel(p => ({ ...p, [l.id]: e.target.checked }))} className="w-4 h-4 accent-teal-600 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-slate-800 truncate">{l.model}{l.modelText ? <span className="font-normal text-slate-400"> {l.modelText}</span> : null}</span>
                      <span className="text-xs text-slate-400 shrink-0">{l.quantity}台</span>
                    </div>
                    {/* ⚠ここで切ると「どっちのテンプレか」が分からず選べない(違いは名前の後ろ側にある) */}
                    {tplName(l) && <div className="fi-tap-text text-indigo-700 font-bold break-words leading-snug">📋 {tplName(l)}</div>}
                    <div className="fi-tap-text text-slate-400">今の入荷: {l.entryAt ? fmtContactDT(l.entryAt) : '未設定'} → <span className="font-black text-teal-700">{fmtContactDT(arriveTs)}</span></div>
                  </div>
                </label>
              ))}
              {candidates.length === 0 && <div className="px-3 py-4 text-center text-slate-400 text-xs">この指図の未完了ロットが検査リストにありません（先にロット登録してください）</div>}
            </div>
          </div>
          {entry.finish?.ts && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs font-bold text-emerald-800">
              ✅ この到着予定には <b>{fmtContactDT(entry.finish.ts)}</b> と返信済みです（{entry.finish.by || '検査'}）。もう一度返信すると上書きされます。
            </div>
          )}
          {/* 「終了予定の返信はまだだが、入荷時間は入れてある」状態を必ず出す。
              ここが見えないと「処理したのに未返信と出る」と感じる(清水さん 2026-08-05)。 */}
          {!entry.finish?.ts && entry.applied && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs font-bold text-emerald-800">
              ✅ 入荷時間は <b>{fmtContactDT(entry.applied.entryAt || arriveTs)}</b> で検査リストへ反映済みです（{entry.applied.by === 'auto' ? '自動反映' : (entry.applied.by || '検査')}）。終了予定の返信はまだです。
            </div>
          )}
          {selLots.length > 0 && finishOn && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
              <div className="text-xs font-black text-slate-500 mb-1.5">② 終了予定（到着してから検査の見積時間ぶん働いたら終わる時刻）— 実際に合わない時は直してから返信してください</div>
              <div className="flex items-center gap-2 flex-wrap">
                <input type="date" value={finishTs ? (finishEdit?.date ?? toDateStr(finishTs)) : ''} onChange={e => setFinishEdit({ date: e.target.value, time: finishEdit?.time ?? (finishTs ? toTimeStr(finishTs) : '') })} className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
                <input type="time" value={finishTs ? (finishEdit?.time ?? toTimeStr(finishTs)) : ''} onChange={e => setFinishEdit({ date: finishEdit?.date ?? (finishTs ? toDateStr(finishTs) : ''), time: e.target.value })} className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-black" />
                {finishEdit && <button onClick={() => setFinishEdit(null)} className="fi-tap-text font-bold text-blue-600 underline">自動計算に戻す</button>}
              </div>
              {/* 何をどう計算したかを必ず出す。数字だけ出して根拠が無いと、合わない時に直す判断ができない。 */}
              <div className="fi-tap-text text-slate-400 mt-1.5">
                {autoFinishTs
                  ? <>自動計算: {fmtContactDT(autoFinishTs)}（{selLots.map(l => `${l.model} ${Math.round((estimateSecOf(l) || 0) / 60)}分`).join(' / ')}）。<b className="text-slate-500">休憩・定時・土日は避けて計算しています</b>（設定→勤務スケジュール）。他の仕事の割り込み・段取り待ちは入っていません。</>
                  : <span className="text-amber-600 font-bold">見積が大きすぎて自動計算できませんでした。終了予定を手で入れてください。</span>}
              </div>
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-slate-200 flex gap-2 justify-end shrink-0">
          <button onClick={() => onClose()} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-500 hover:bg-slate-100">キャンセル</button>
          <button disabled={!selLots.length} onClick={() => doApply(false)} className="px-3 py-2 rounded-lg text-sm font-bold text-teal-700 border-2 border-teal-500 hover:bg-teal-50 disabled:opacity-40">入荷時間だけ反映</button>
          {/* 終了予定の返信は設定でOFFにできる(設定→工程連絡)。OFFの時はボタン自体を出さない。 */}
          {finishOn && <button disabled={!selLots.length || !finishTs} onClick={() => doApply(true)} className="px-4 py-2 rounded-lg text-sm font-black text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-40 flex items-center gap-1.5"><Send className="w-4 h-4" /> 反映して終了予定を返信</button>}
        </div>
      </div>
    </div>
  );
};

// ---- 宛先ルーティング(役職: 職長/工長/グループ長) ----
// あっち側の端末登録に役職を持たせ、グループごとに「どの役職の携帯へ送るか」を切替できる。
// 職長が休みの日=「職長 不在」ON→自動で上司(工長/グループ長)へ。重い不良は送信時に「職長+上司」等を選べる。
// 未返信エスカレーション=設定分数を過ぎた待ち依頼を上司へも自動通知(1回だけ)。
const CONTACT_ROLES = ['職長', '工長', 'グループ長', '一般'];
const CONTACT_BOSS_ROLES = ['工長', 'グループ長'];
const CONTACT_LEVELS = [
  ['auto', '自動（設定どおり）'], ['chief', '職長'], ['both', '職長＋上司'], ['boss', '上司のみ'], ['all', '全員'],
];
const contactRoutingOf = (settings, group) => {
  const r = (settings?.contactRouting || {})[group] || {};
  return { mode: r.mode || 'chief', chiefAway: !!r.chiefAway, escalateMin: Math.max(0, Number(r.escalateMin) || 0) };
};
// 職長への再通知(リマインド)設定。kind='repair'(修正/呼出) or 'arrival'(入荷・到着予定)。
// 未返信の間 min分ごとに最大count回、職長(=普段の宛先ルール)へもう一度プッシュして気づいてもらう。
const contactRemindOf = (settings, group, kind) => {
  const r = (((settings?.contactRouting || {})[group] || {}).remind || {})[kind] || {};
  return { on: !!r.on, min: Math.min(120, Math.max(1, Number(r.min) || 10)), count: Math.min(10, Math.max(1, Number(r.count) || 3)) };
};
// 検査完了→次工程(組立)への完了連絡の設定。enabled=既定ON(送信は毎回ワンタップ確認するので勝手には飛ばない)。group=既定の宛先(空なら先頭グループ)。
//   ack   = 相手の「確認しました」返信を求めるか。OFF=お知らせを流すだけ(status='notice')。既定ON。
//   modelGroups = 品目コードごとに前回どの班へ送ったかの記憶。製品によって連絡する職長が違うので、次からその品目コードは自動でその班が選ばれる。
const contactCompleteOf = (settings) => {
  const c = settings?.contactComplete || {};
  return { enabled: c.enabled !== false, group: String(c.group || '').trim(), ack: c.ack !== false, modelGroups: c.modelGroups || {} };
};
// 到着予定の設定。autoEntry=あっちが登録/回答した到着予定を、そのロットの入荷時間(entryAt)へ自動で入れる。既定ON。
// 到着予定の自動お礼。返信をもらった時に「ご協力ありがとうございます」を1回だけ返す。
//   ⚠鳴らさない: お礼で携帯を鳴らすと、本当に急ぎの連絡(修正依頼/呼出)が埋もれる。ポータルに出すだけ。
//   ⚠依頼1件につき1回(最初の回答時)。項目ごとに返すと、まとめて答えた時に連打になる。
const DEFAULT_CONTACT_THANKS = 'ご協力ありがとうございます';
const contactThanksOf = (settings) => {
  const a = settings?.contactArrival || {};
  const t = a.thanks || {};
  return { on: t.on !== false, text: String(t.text || '').trim() || DEFAULT_CONTACT_THANKS };
};
// 到着予定の定時おうかがい。毎日きまった時刻に「まだ到着予定をもらっていない指図」をまとめて聞く。
//   days: 0=日〜6=土。既定は平日。lookaheadDays=何日先の入荷ぶんまで聞くか。
const contactAutoAskOf = (settings) => {
  const a = settings?.contactArrival?.autoAsk || {};
  return {
    on: a.on === true,                                   // 既定OFF(勝手に送らない)
    time: /^\d{2}:\d{2}$/.test(a.time || '') ? a.time : '08:30',
    days: Array.isArray(a.days) && a.days.length ? a.days : [1, 2, 3, 4, 5],
    lookaheadDays: Number.isFinite(Number(a.lookaheadDays)) ? Math.max(1, Number(a.lookaheadDays)) : 3,
  };
};
const contactArrivalOf = (settings) => {
  const a = settings?.contactArrival || {};
  return { autoEntry: a.autoEntry !== false };
};
// この品目コードを完了連絡する既定の宛先: ①前にこの品目コードで送った班 ②設定の既定の班 ③先頭の班。送信時に手で変えられる(変えたら①として覚える)。
const contactCompleteGroupFor = (settings, model) => {
  const c = contactCompleteOf(settings);
  const m = String(model || '').trim();
  const groups = contactGroupsOf(settings);
  const cand = (m && c.modelGroups[m]) || c.group || groups[0] || '';
  return groups.includes(cand) ? cand : (groups[0] || ''); // 消された班が記憶に残っていても宛先不明にしない
};
// 送信レベルの決定: 送信時の指定(toLevel)が最優先。無ければグループの既定モード。職長不在ONなら職長→上司へ振替。
const contactResolveLevel = (settings, group, toLevel) => {
  if (toLevel && toLevel !== 'auto') return toLevel;
  const r = contactRoutingOf(settings, group);
  if (r.chiefAway) return r.mode === 'chief' ? 'boss' : (r.mode === 'both' ? 'boss' : r.mode);
  return r.mode;
};
// グループ内の端末をレベルで絞る。役職未設定の端末=職長扱い(既存登録が黙って通知から外れないため)。
// 該当0台なら 職長→上司→全員 の順で落とし、「誰にも届かない」を防ぐ。
const contactFilterByLevel = (groupTokens, settings, group, toLevel) => {
  const lvl = contactResolveLevel(settings, group, toLevel);
  const roleOf = (t) => t.role || '職長';
  const pick = (roles) => groupTokens.filter(t => roles.includes(roleOf(t)));
  if (lvl === 'all') return groupTokens;
  let out = lvl === 'boss' ? pick(CONTACT_BOSS_ROLES) : lvl === 'both' ? pick(['職長', ...CONTACT_BOSS_ROLES]) : pick(['職長']);
  if (!out.length && lvl !== 'boss') out = pick(CONTACT_BOSS_ROLES);
  if (!out.length && lvl === 'boss') out = pick(['職長']);
  if (!out.length) out = groupTokens;
  return out;
};
// ---- 通知音 ----
// 「PCに通知は来るけど気づかない」の実態: 作業中はアプリが前面なので、ブラウザ/OSは通知を出さず
// アプリ内のトーストしか出ない。しかも今まで音が1つも鳴っていなかった。そこで音を足す。
// ⚠ブラウザは「その端末で1回でも操作するまで」音を鳴らせない(自動再生ポリシー)。最初のタップで解禁する。
// ⚠鳴らすのは緊急だけ。全部鳴らすと鳴りっぱなしになって、人は必ず無視するようになる(通知疲れ)。
let contactAudioCtx = null;
const contactAudioReady = () => !!contactAudioCtx && contactAudioCtx.state === 'running';
const contactUnlockAudio = () => {
  try {
    if (!contactAudioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; contactAudioCtx = new AC(); }
    if (contactAudioCtx.state === 'suspended') contactAudioCtx.resume().catch(() => {});
  } catch (e) { /* 音が出せない端末でも連絡そのものは届く */ }
};
// ピッ…ピッ と鳴らす。回数・高さ・音量は連絡タブの設定で変えられる(既定=2回/880Hz/0.25)。
const contactBeep = (times = 2, freq = 880, volume = 0.25) => {
  try {
    if (!contactAudioReady()) return false;
    const ctx = contactAudioCtx;
    const n = Math.max(1, Math.floor(Number(times) || 2));
    const f = Math.max(50, Number(freq) || 880);
    const vol = Math.max(0.0002, Math.min(1, Number(volume) || 0.25));
    for (let i = 0; i < n; i++) {
      const t0 = ctx.currentTime + i * 0.28;
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(f, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + 0.22);
    }
    return true;
  } catch (e) { return false; }
};
// 音を鳴らす出来事 = 手を止めて動く必要があるものだけ。
//   'answer'(あっちの返信)/'finish'(いつ終わる?)/'internal'(現場からの社内連絡) と、「行けない」返信(=擬似タイプ 'no')。
//   'sent'(自分たちが出した連絡)/'comment'(会話)/'arrival'(到着予定の回答) は既定では鳴らさない = 画面に出るだけ。
const CONTACT_BEEP_TYPES = ['answer', 'internal', 'finish', 'portalmsg'];
const contactShouldBeep = (ev, types) => {
  if (!ev) return false;
  const list = Array.isArray(types) ? types : [...CONTACT_BEEP_TYPES, 'no'];
  return list.includes(ev.no ? 'no' : ev.type);
};
// 通知音の設定。既定ON。うるさければ連絡タブの設定でOFFにできる。
const contactSoundOn = (settings) => settings?.contactSound?.enabled !== false;
// 通知音(軽いビープ)の詳細設定。種類/回数/高さ/音量。
// ⚠🆕 newlot を既定に入れておく。⚠ここに足すだけでは、既に音の設定を保存してある端末には届かない
//   (設定は浅く重ねるので、保存済みの types がそのまま勝つ)。下の設定画面の TYPE_LABELS にも必ず1行足して、
//   使う人が自分でチェックを入れられるようにすること。
const CONTACT_SOUND_DEFAULTS = { count: 2, freq: 880, volume: 0.25, types: ['answer', 'internal', 'finish', 'portalmsg', 'newlot', 'no'] };
const contactSoundCfg = (settings) => ({ ...CONTACT_SOUND_DEFAULTS, ...(settings?.contactSound || {}) });
// 画面内トースト(フォアグラウンド受信表示)の設定。緊急とみなす言葉/自動で消える秒数/同時に出す最大数。
//   position: 'br'=右下(既定) / 'top'=上の真ん中。作業中は視線が画面の中心にあるので、
//     上に出すと手元の操作を隠す。右下なら邪魔になりにくい。
//   stayUntilClick: 押すまで消さない(既定ON)。⚠自動で消えると「気づかないうちに消えた」が起きる。
const CONTACT_TOAST_DEFAULTS = { urgentWords: ['修正依頼', '呼出', '社内連絡', '行けない', '至急'], autoHideSec: 10, maxStack: 3, position: 'br', stayUntilClick: true, blinkTitle: true };
const contactToastCfg = (settings) => ({ ...CONTACT_TOAST_DEFAULTS, ...(settings?.contactToast || {}) });
const contactToastWords = (cfg) => (Array.isArray(cfg.urgentWords) ? cfg.urgentWords : CONTACT_TOAST_DEFAULTS.urgentWords).map(x => String(x || '').trim()).filter(Boolean);
// 画面内ティッカー(左下の未読)の設定。表示件数。
const CONTACT_TICKER_DEFAULTS = { maxShown: 3 };
const contactTickerCfg = (settings) => ({ ...CONTACT_TICKER_DEFAULTS, ...(settings?.contactTicker || {}) });
// ============================================================
// 連絡アラーム(A: 画面を開いている時「確認」を押すまで鳴り続ける)
//   携帯のアラーム/着信のように、緊急連絡が来たら音+バイブ+全画面で鳴らし続け、確認を押すまで止めない。
//   ⚠これが効くのは「アプリを開いている間」だけ(閉じている時はOSの通知が担当。B=requireInteraction)。
//   秒数・回数に上限は設けない(0=無制限=触るまで)。ON/OFF・数値・色まで全部 設定で変えられる。
// ============================================================
const CONTACT_ALARM_DEFAULTS = {
  enabled: false,          // アラーム全体のON/OFF(既定OFF=まず設定で意識して有効化してもらう)
  triggers: ['修正依頼', '呼出', '社内連絡', '行けない', '至急', '再通知'],
  sound: true,
  freq: 880,
  toneCount: 3,
  volume: 0.35,
  intervalSec: 3,
  maxSec: 0,               // 0=無制限=触るまで
  maxCount: 0,             // 0=無制限
  vibrate: true,
  vibratePattern: '400,150,400',
  flash: true,
  flashColor: '#e11d48',
  quietEnabled: false,
  quietFrom: '22:00',
  quietTo: '6:00',
};
const contactAlarmCfg = (settings) => ({ ...CONTACT_ALARM_DEFAULTS, ...(settings?.contactAlarm || {}) });
const contactAlarmTriggers = (cfg) => (Array.isArray(cfg.triggers) ? cfg.triggers : CONTACT_ALARM_DEFAULTS.triggers).map(x => String(x || '').trim()).filter(Boolean);
const contactAlarmMatches = (cfg, text) => { const s = String(text || ''); return contactAlarmTriggers(cfg).some(w => s.includes(w)); };
const contactAlarmInQuiet = (cfg, d = new Date()) => {
  if (!cfg.quietEnabled) return false;
  const toMin = (hhmm) => { const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const from = toMin(cfg.quietFrom), to = toMin(cfg.quietTo);
  if (from == null || to == null) return false;
  const now = d.getHours() * 60 + d.getMinutes();
  return from <= to ? (now >= from && now < to) : (now >= from || now < to);
};
const contactAlarmRing = (cfg) => {
  try {
    if (cfg.sound && contactAudioReady()) {
      const ctx = contactAudioCtx;
      const n = Math.max(1, Math.floor(Number(cfg.toneCount) || 3));
      const vol = Math.max(0, Math.min(1, Number(cfg.volume) || 0.35));
      const freq = Math.max(50, Number(cfg.freq) || 880);
      for (let i = 0; i < n; i++) {
        const t0 = ctx.currentTime + i * 0.22;
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = 'square'; osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.18);
      }
    }
  } catch (e) { /* 音が出せない端末でも画面表示は出る */ }
  try {
    if (cfg.vibrate && typeof navigator !== 'undefined' && navigator.vibrate) {
      const pat = String(cfg.vibratePattern || '400,150,400').split(',').map(x => Math.max(0, Math.round(Number(x.trim()) || 0)));
      navigator.vibrate(pat.length ? pat : [400, 150, 400]);
    }
  } catch (e) { /* noop */ }
};
const CONTACT_EVENT_ALARM_LABEL = { internal: '社内連絡', finish: 'いつ終わる？の質問', answer: '返信がありました', arrival: '到着予定の回答', portalmsg: '組立から連絡', newlot: '検査リストに無い品の連絡', comment: '会話', sent: '送信' };
const contactEventAlarmText = (ev) => ev?.no ? '⚠ 行けない と返信' : (CONTACT_EVENT_ALARM_LABEL[ev?.type] || '連絡');
const CONTACT_OSNOTIFY_DEFAULTS = { requireInteraction: true, vibratePattern: '400,150,400' };
const contactOsNotifyCfg = (settings) => ({ ...CONTACT_OSNOTIFY_DEFAULTS, ...(settings?.contactOsNotify || {}) });
const contactOsNotifyOpts = (settings) => {
  const c = contactOsNotifyCfg(settings);
  const vibrate = String(c.vibratePattern || '').split(',').map(x => Math.max(0, Math.round(Number(x.trim()) || 0))).filter((x, i, a) => a.length > 0);
  return { requireInteraction: c.requireInteraction !== false, vibrate: vibrate.length ? vibrate : undefined };
};
// ---- 検査アプリ共通の連絡設定(宛先グループ・班メンバー) ----
// 「組立の班」は製品検査でも最終検査でも同じ相手なので、アプリごとの棚(APP_DATA_ID)ではなく共通の棚に1つだけ置く。
// → どちらの設定画面で直しても両方に効く。班を2つのアプリで別々に管理する必要がなくなる。
// 旧データ(アプリ個別の settings.contactGroups)は、共通の棚が空のときだけ自動で引っ越す(seed)。
const CONTACT_SHARED_NS = 'contact-shared-v1';
// 共通の棚が使えている時はそれが正。まだ空(引っ越し前)ならアプリ個別の設定で従来どおり動く。
const contactMergeShared = (settings, shared) => {
  if (!shared) return settings;
  const out = { ...(settings || {}) };
  if (Array.isArray(shared.contactGroups)) out.contactGroups = shared.contactGroups; // 空配列も「全部消した」という意思として尊重(旧いアプリ個別の値へ戻さない)
  if (shared.contactMembers) out.contactMembers = shared.contactMembers;
  if (shared.portalModelFamilies) out.portalModelFamilies = shared.portalModelFamilies; // 品目コードの仕分けも2アプリ共通
  if (shared.portalModelPrefixMap) out.portalModelPrefixMap = shared.portalModelPrefixMap;
  // 組立ポータルの見た目(1画面/今まで通り)。⚠共通の棚だけが正。falseも「戻した」という意思として尊重する。
  if (typeof shared.portalCompact === 'boolean') out.portalCompact = shared.portalCompact;
  // VAPID鍵とWorkerURLは2アプリで同じインフラ(同じFirebaseプロジェクト・同じCloudflare Worker)なので共通の棚に置く。
  //   → 片方で設定すれば両方でプッシュが飛ぶ。⚠受信端末(push_tokens)はサイトごとに別なので、端末の🔔登録は各ポータルで1回ずつ必要。
  if (shared.push && (shared.push.vapidKey || shared.push.workerUrl)) out.push = { ...(settings?.push || {}), ...shared.push };
  return out;
};
// ---- ポータルの品目コードしぼり込み ----
// 組立側は製品の数が多くて目的の指図を探しづらい。品目コードは「英字＋ハイフン＋数字」(例 RTT-215)なので、
// 先頭の英字だけを取り出して仕分ける。前方一致(RT と RTT / RW と RWB)で取り違えないよう、必ず英字の並び全体で比べること。
const portalModelPrefix = (model) => {
  const m = String(model || '').trim().toUpperCase().match(/^[A-Z]+/);
  return m ? m[0] : '';
};
// 英字で始まらない品名(例「200EクランプAssy」)のまとめ先。頭文字ボタンにこの名前で出る。
const PORTAL_NO_PREFIX = '品目コード名以外';
// 特注機/標準機の仕分けは現場の呼び分け(清水さん指定)。ここに無い頭文字は「その他」に入れる = 勝手に決めつけない。
//   ⚠実データの品目コードは RWA/E/H-160R・RWB-250R・RWU-320L・RBS/H-160R のように、指定の呼び名(RW/RB)の後ろに文字が続く。
//   そのため「頭文字が家名で始まるか(startsWith)」で判定する。RT と RTT は両方とも特注機なので、この判定でぶつかっても害はない。
//   (個別の品目コードボタンは実データの頭文字そのままを使うので、RT と RTT が混ざることはない)
const PORTAL_MODEL_GROUPS = [
  { id: 'custom', label: '特注機', families: ['RTT', 'RTH', 'RTV', 'RT'], color: '#7c3aed', bg: 'bg-violet-600', border: 'border-violet-700' },
  { id: 'standard', label: '標準機', families: ['RW', 'TWA', 'TWB', 'RB', 'RCH', 'RCV'], color: '#0d9488', bg: 'bg-teal-600', border: 'border-teal-700' },
];
// 仕分けは設定で足せる(共通の棚に保存 → 製品検査・最終検査で同じ仕分けになる)。
// 既定は現場の呼び分け(清水さん指定)。ここに無い頭文字(TBS/CTAP/TWM 等)は「その他」に出るので、
// 設定の「品目コードの仕分け」でワンタップで特注機/標準機へ移せる。私が勝手に決めない。
const portalModelFamiliesOf = (settings) => {
  const ov = settings?.portalModelFamilies || {};
  return PORTAL_MODEL_GROUPS.map(g => ({ ...g, families: Array.isArray(ov[g.id]) ? ov[g.id] : g.families }));
};
// 頭文字→グループ の手動指定。設定の「品目コードの仕分け」で押した結果はここに入る(共通の棚に保存)。
const portalModelPrefixMapOf = (settings) => {
  const m = settings?.portalModelPrefixMap;
  return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
};
const portalModelPrefixMapWith = (settings, prefix, toGroupId) => ({ ...portalModelPrefixMapOf(settings), [prefix]: toGroupId });
// 仕分けの判定。①手動指定(頭文字ピッタリ)が最優先 ②無ければ家名の前方一致(RWA←RW 等)。
//   ⚠②だけだと「RWA を その他 に戻す」ができない(families から 'RWA' を消しても 'RW' が拾ってしまう)ので①が要る。
const portalModelGroupOf = (model, fams = null, ovMap = null) => {
  const p = portalModelPrefix(model);
  if (!p) return 'other';
  const ov = (ovMap || {})[p];
  if (ov) return ov;                       // 'custom' | 'standard' | 'other' を明示指定できる
  const list = fams || PORTAL_MODEL_GROUPS;
  const g = list.find(x => (x.families || []).some(f => p === f || p.startsWith(f)));
  return g ? g.id : 'other';
};
// ---- 社内(検査職制)連絡: 現場作業者 → 検査の職長/工長 ----
// 宛先は検査側(side:'app')端末のうち役職(職長/工長/グループ長)を付けた端末だけ。役職付き端末が1台も無ければ
// 検査の全端末へ(誰にも届かない事態を防ぐ)。現場作業者の端末は役職未設定=通常は宛先から外れる。
const CONTACT_INTERNAL_GROUP = '（社内）';
const CONTACT_INTERNAL_TOPICS = ['応援要請', '相談', '申し送り', '未検査あり', '保留', '設備・道具', 'その他']; // P059: 部品に機番待ちは無いので『保留』に替えた
const contactInternalTargets = (appTokens) => {
  const roled = (appTokens || []).filter(t => t && (t.role === '職長' || t.role === '工長' || t.role === 'グループ長'));
  return roled.length ? roled : (appTokens || []);
};

// ---- プッシュ通知 (FCM) ----
// 「見てなくても携帯が鳴って気づく」層。設定は settings.push { vapidKey, workerUrl }(管理者が連絡タブで1回設定)。
// 受信登録は push_tokens コレクション(docId=端末ID)。side:'app'=検査側 / 'portal'=あっち側(グループ名つき)。
// 送信はWorker(/fcm/send)経由のfire-and-forget — 通知が失敗しても連絡そのもの(Firestore)は必ず届く。
const pushCfgOf = (settings) => {
  const p = settings?.push || {};
  return { vapidKey: String(p.vapidKey || '').trim(), workerUrl: String(p.workerUrl || '').trim() };
};
// 依頼payload→通知の文面
const contactPushMessage = (payload) => {
  if (payload.kind === 'arrival') {
    const items = payload.items || [];
    return { title: `🚚 到着予定を教えてください (${items.length}件)`, body: (items.map(i => i.orderNo).filter(Boolean).slice(0, 5).join(', ') + (items.length > 5 ? ' …' : '')) };
  }
  const head = payload.kind === 'repair' ? '🔧 修正依頼' : '📞 呼出・連絡';
  return { title: `${head}${payload.toPerson ? ` → ${payload.toPerson}さん` : ''}${payload.from ? `（${payload.from}）` : ''}`, body: `${payload.orderNo ? `指図${payload.orderNo}: ` : ''}${payload.message || ''}`.slice(0, 200) };
};
// 宛先トークンを選んでWorkerへ送る。unregistered(端末側で無効化済み)のトークンdocは自動掃除。
// 依頼(toSide:'portal')は、管理者CC(admin:true登録の端末)へ「誰が誰に何を送ったか」を自動で写し送りする。
const firePushNotify = (settings, pushTokens, { toGroup, toSide, title, body, link, tag, toLevel, internal }, deleteData) => {
  try {
    const cfg = pushCfgOf(settings);
    if (!cfg.vapidKey || !cfg.workerUrl) return;
    const osOpts = contactOsNotifyOpts(settings); // 触るまで消さない/バイブ(閉じている時のOS通知)
    const alive = (pushTokens || []).filter(t => t && t.token && t.enabled !== false);
    const cleanup = (targets) => (res) => {
      if (res && Array.isArray(res.results) && deleteData) {
        // 🚨 2026-09-02(NC3): 二重の繰り返し(結果 × 宛先)を **1本にまとめ**、消す数に上限を付けた。
        //   前は「1回で何件消すのか」がコードから読めず、書き込みの見張りが止めていた。
        //   ⚠上限で切っても取りこぼさない: 残った古いトークンは次の通知でまた報告され、
        //     その時に消える(この掃除は何回やっても同じ結果になる)。
        //   ⚠二重の繰り返しは、同じトークンが結果に2回出ると同じ札を2回消しに行っていた。
        //     1本にすると宛先ごとに1回だけになる(＝書き込みが減る)。
        //   6件の根拠: 1回の通知の宛先は多くて数台。実測(2026-08-30の控え)で
        //     push_tokens は 製品10件 / 最終2件しかない。
        const dead = new Set(res.results.filter(r => r && r.unregistered).map(r => r.token));
        targets.filter(t => t && dead.has(t.token)).slice(0, 6)
          .forEach(t => { try { deleteData('push_tokens', t.id); } catch (e) { /* noop */ } });
      }
    };
    let targets = alive
      .filter(t => (toSide ? t.side === toSide : true))
      .filter(t => (toGroup ? t.group === toGroup : true));
    // あっち側宛ては役職ルーティング(職長/上司/全員…)で絞る。検査側宛て(返信・到着回答)は従来どおり全端末。
    if (toSide === 'portal' && toGroup) targets = contactFilterByLevel(targets, settings, toGroup, toLevel);
    else if (internal && toSide === 'app') targets = contactInternalTargets(targets); // 社内連絡=検査の職長/工長へ
    if (targets.length) {
      sendPushViaWorker(cfg.workerUrl, { tokens: [...new Set(targets.map(t => t.token))], title, body, link, tag, ...osOpts }).then(cleanup(targets));
    }
    if (toSide === 'portal') {
      const sent = new Set(targets.map(t => t.token));
      const ccTargets = alive.filter(t => t.admin === true && !sent.has(t.token));
      if (ccTargets.length) {
        sendPushViaWorker(cfg.workerUrl, {
          tokens: [...new Set(ccTargets.map(t => t.token))],
          title: `📋 CC(${toGroup || 'あっち'}宛): ${title}`, body,
          link: (typeof window !== 'undefined' ? `${window.location.origin}/` : link), tag: `${tag || 'cc'}-cc`, ...osOpts,
        }).then(cleanup(ccTargets));
      }
    }
  } catch (e) { console.warn('プッシュ送信に失敗(連絡自体は送信済み)', e); }
};

// 画面を開いている時の受信表示(閉じている時はService Worker+ブラウザ通知が担当)
// 緊急かどうかは文面で見る(FCMのpayloadに種類が入っていないため)。誤って緊急にしても「押すまで残る」だけで害は小さく、
//   取りこぼす方(消えて気づかない)が致命的なので、この向きに倒している。
// 緊急とみなす文面か。既定は 修正依頼|呼出|社内連絡|行けない|至急。設定で言葉を足せる。
const contactToastUrgent = (m, words) => {
  const list = Array.isArray(words) ? words : CONTACT_TOAST_DEFAULTS.urgentWords;
  const s = String(m?.title || '') + String(m?.body || '');
  return list.some(w => w && s.includes(w));
};
// ウィンドウ(タブ)の題名を点滅させる。
// ⚠**タスクバーのアイコンそのものを点滅させることは、Webアプリからはできない**(OSの機能で、
//   ブラウザからは触れない)。Webから出来るのは ①アイコンのバッジ(数字) ②題名 ③音 ④画面内の表示 の4つ。
//   最小化していても題名は見えるので、点滅で気づける。画面を見ている間(前面)は点滅させない(邪魔なだけ)。
const useDocumentTitleBlink = (count) => {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const base = document.title;
    if (!count) return undefined;
    let on = false;
    const t = setInterval(() => {
      if (!document.hidden) { document.title = base; return; } // 見ている時は普通の題名に戻す
      on = !on;
      document.title = on ? `🔔 ${count}件 新しい連絡` : base;
    }, 1200);
    return () => { clearInterval(t); document.title = base; };
  }, [count]);
};

const ForegroundPushToast = ({ ready, settings }) => {
  // ⚠1件しか持たないと、未読の緊急トーストが後から来た1本(例: 到着予定の回答)で黙って上書きされて消える。
  //   最大N件まで積み、緊急は押すまで残す。件数・自動で消える秒数・緊急の言葉は設定で変えられる。
  const cfg = contactToastCfg(settings);
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
  const words = contactToastWords(cfg);
  const [msgs, setMsgs] = useState([]);
  const drop = (key) => setMsgs(ms => ms.filter(x => x.key !== key));
  useEffect(() => {
    if (!ready) return;
    let unsub = null; let dead = false;
    listenForegroundPush((m) => setMsgs(ms => [...ms, { ...m, at: Date.now(), key: `${Date.now()}-${Math.random()}` }].slice(-Math.max(1, Math.floor(Number(cfgRef.current.maxStack) || 3)))))
      .then(u => { if (dead) { try { u(); } catch (e) { /* noop */ } } else unsub = u; });
    return () => { dead = true; if (unsub) { try { unsub(); } catch (e) { /* noop */ } } };
  }, [ready]);
  // 自動で消すのは「押すまで消さない」がOFFの時だけ。緊急はどちらでも消さない。
  //   ⚠既定は「押すまで消さない」。自動で消えると、手を動かしている間に出て消えて誰も気づかない。
  const stay = cfg.stayUntilClick !== false;
  useEffect(() => {
    if (stay) return undefined;
    const hideMs = Math.max(1000, (Number(cfg.autoHideSec) || 10) * 1000);
    const soft = msgs.filter(m => !contactToastUrgent(m, words));
    if (!soft.length) return undefined;
    const ts = soft.map(m => setTimeout(() => drop(m.key), Math.max(500, hideMs - (Date.now() - m.at))));
    return () => ts.forEach(t => clearTimeout(t));
  }, [msgs, stay]); // eslint-disable-line react-hooks/exhaustive-deps
  // ⚠タスクバーのアイコンそのものを点滅させることは、Webアプリからはできない(OSの機能)。
  //   代わりにウィンドウ(タブ)の題名を点滅させる。最小化していても題名は見える。
  useDocumentTitleBlink(cfg.blinkTitle !== false ? msgs.length : 0);
  if (!msgs.length) return null;
  const br = (cfg.position || 'br') !== 'top';
  return (
    <div className={br
      ? 'fixed bottom-3 right-3 z-[999] max-w-sm w-[calc(100%-1.5rem)] sm:w-96 flex flex-col gap-2'
      : 'fixed top-3 left-1/2 -translate-x-1/2 z-[999] max-w-md w-[calc(100%-2rem)] flex flex-col gap-2'}>
      {msgs.length > 1 && (
        <button onClick={() => setMsgs([])} className="self-end fi-tap-text font-black text-white bg-slate-700 hover:bg-slate-600 rounded-full px-3 py-1 shadow-lg">
          {msgs.length}件をまとめて消す
        </button>
      )}
      {msgs.map(msg => {
        const urgentToast = contactToastUrgent(msg, words);
        return (
          <div key={msg.key} className="cursor-pointer" onClick={() => drop(msg.key)}>
            <div className={`text-white rounded-xl shadow-2xl px-4 py-3 flex items-start gap-2.5 border-2 ${urgentToast ? 'bg-rose-700 border-rose-300 animate-pulse' : 'bg-slate-800 border-slate-600'}`}>
              <BellRing className="w-5 h-5 text-amber-300 shrink-0 mt-0.5 animate-pulse" />
              <div className="min-w-0 flex-1">
                <div className="font-black text-sm truncate">{msg.title}</div>
                {msg.body && <div className="text-xs text-slate-300 break-words">{msg.body}</div>}
              </div>
              {(urgentToast || stay)
                ? <span className="fi-tap-text font-black bg-white text-rose-700 rounded px-1.5 py-1 shrink-0 whitespace-nowrap">押すと消える</span>
                : <X className="w-4 h-4 text-slate-400 shrink-0" />}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// 連絡アラーム: 画面を開いている間、緊急連絡が来たら「確認」を押すまで 音+バイブ+全画面 で鳴らし続ける。
//   トリガーは ①フォアグラウンドで受け取ったプッシュ(組立ポータル・検査側 共通) ②画面内フィード(検査側のみ・extraEvents)。
//   ⚠既に鳴っている時は上書きしない(最初の緊急を優先。確認したら次の緊急へ)。
const ContactAlarm = ({ ready, settings, extraEvents }) => {
  const cfg = contactAlarmCfg(settings);
  const [active, setActive] = useState(null); // { title, body }
  const timerRef = useRef(null);
  const startedRef = useRef(0);
  const countRef = useRef(0);
  const seenRef = useRef(new Set());
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg; // 鳴っている最中に設定を変えても最新を見る
  const stop = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) { /* noop */ }
    setActive(null);
  };
  const trigger = (msg) => {
    const c = cfgRef.current;
    if (!c.enabled) return;
    if (contactAlarmInQuiet(c)) return;
    if (!contactAlarmMatches(c, `${msg.title || ''} ${msg.body || ''}`)) return;
    setActive(prev => prev || { title: msg.title || '連絡', body: msg.body || '' });
  };
  useEffect(() => {
    if (!ready) return;
    let unsub = null, dead = false;
    listenForegroundPush((m) => trigger(m)).then(u => { if (dead) { try { u(); } catch (e) { /* noop */ } } else unsub = u; });
    return () => { dead = true; if (unsub) { try { unsub(); } catch (e) { /* noop */ } } };
  }, [ready]);
  useEffect(() => {
    if (!extraEvents || !extraEvents.length) return;
    extraEvents.forEach(ev => {
      if (!ev || seenRef.current.has(ev.key)) return;
      seenRef.current.add(ev.key);
      trigger({ title: ev.title || '', body: ev.body || '' });
    });
  }, [extraEvents]);
  useEffect(() => {
    if (!active) return;
    startedRef.current = Date.now(); countRef.current = 0;
    // 鳴っている間、画面を明るいまま保つ(暗転・スリープさせない)。
    //   ⚠効くのは「アプリを開いている間」だけ。ロック画面が真っ黒の状態を点けることはできない(OSの仕様)。
    //   そこは通知の重要度を「緊急」にして初めてAndroidが画面を点ける。
    let wl = null; let released = false;
    const acquire = async () => {
      if (released || wl) return;
      try { if (navigator.wakeLock && document.visibilityState === 'visible') wl = await navigator.wakeLock.request('screen'); } catch (e) { /* 非対応端末は黙って諦める */ }
    };
    acquire();
    const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
    document.addEventListener('visibilitychange', onVis);
    const ring = () => {
      const c = cfgRef.current;
      contactAlarmRing(c);
      countRef.current += 1;
      const maxSec = Math.max(0, Number(c.maxSec) || 0);
      const maxCount = Math.max(0, Number(c.maxCount) || 0);
      if (maxSec > 0 && (Date.now() - startedRef.current) / 1000 >= maxSec) { stop(); return; }
      if (maxCount > 0 && countRef.current >= maxCount) { stop(); return; }
    };
    ring();
    const iv = Math.max(0.2, Number(cfgRef.current.intervalSec) || 3) * 1000;
    timerRef.current = setInterval(ring, iv);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVis);
      if (wl) { try { wl.release(); } catch (e) { /* noop */ } wl = null; }
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [active]);
  if (!active) return null;
  return (
    <div onClick={stop} className="fixed inset-0 z-[1000] flex items-center justify-center cursor-pointer p-4"
      style={{ background: cfg.flash ? undefined : 'rgba(0,0,0,0.65)' }}>
      {cfg.flash && <div className="absolute inset-0 animate-pulse" style={{ background: cfg.flashColor || '#e11d48', opacity: 0.85 }} />}
      <div className="relative bg-white rounded-2xl shadow-2xl border-4 border-rose-400 px-6 py-6 max-w-md w-full text-center flex flex-col gap-3">
        <div className="text-6xl animate-bounce">🔔</div>
        <div className="text-lg font-black text-rose-700 break-words">{active.title}</div>
        {active.body && <div className="text-sm text-slate-600 break-words">{active.body}</div>}
        <button onClick={(e) => { e.stopPropagation(); stop(); }} className="mt-1 px-6 py-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-lg font-black shadow-lg active:scale-95">確認しました（音を止める）</button>
        <div className="fi-tap-text text-slate-400">画面のどこを触っても止まります</div>
      </div>
    </div>
  );
};

// 通知の設定方法ヘルプ(端末別)。連絡タブ(検査側)とポータル(あっち側)の両方から開ける。
const PushHelpModal = ({ onClose, sideLabel = '組立' }) => {
  const Sec = ({ emoji, title, children, open }) => (
    <details open={open} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <summary className="px-3 py-2.5 font-black text-slate-700 cursor-pointer select-none hover:bg-slate-50">{emoji} {title}</summary>
      <div className="px-4 pb-3 pt-1 text-sm text-slate-600 flex flex-col gap-2">{children}</div>
    </details>
  );
  const Step = ({ n, children }) => (
    <div className="flex gap-2 items-start">
      <span className="shrink-0 w-5 h-5 rounded-full bg-blue-600 text-white fi-tap-text font-black flex items-center justify-center mt-0.5">{n}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
  const Warn = ({ children }) => (<div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">⚠ {children}</div>);
  return (
    <div className="fixed inset-0 z-[97] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-100 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 bg-slate-800 text-white flex items-center gap-2 shrink-0">
          <MessageCircle className="w-5 h-5 text-blue-300" />
          <span className="font-black">工程連絡ヘルプ（使い方・通知設定）</span>
          <button onClick={onClose} className="ml-auto p-1 hover:bg-white/20 rounded-full"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 overflow-y-auto flex flex-col gap-3">
          <Sec emoji="🗺" title="全体のしくみ（1分でわかる）" open>
            <p>電話で「修正来て」「いつ来る？」とやっていた連絡を、アプリに置き換えるものです。登場するのは2つの画面:</p>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap">{`【こっち = 検査側】          【相手 = ${sideLabel}・機械など】
 このアプリの「連絡」タブ  ⇄   ポータル(渡すURLで開く専用ページ)

 依頼を送る ────────────────▶ 依頼が表示+携帯に通知🔔
                              「すぐ行く/10分後/20分後/行けない」
 返信が表示+通知🔔 ◀──────── をワンタップで返信`}</div>
            <ul className="list-disc ml-5 flex flex-col gap-1">
              <li><b>依頼の種類は3つ</b>: 修正依頼(NG→修正から自動)・呼出/連絡(自由文)・到着予定を聞く(複数製品まとめて)</li>
              <li>あっちが登録した<b>到着予定</b>は、こっちの検査リストのカードに🚚バッジで出ます</li>
              <li>やりとりは全部「連絡」タブの一覧に残ります(状況/送信/経過/返信時間つき)</li>
            </ul>
          </Sec>
          <Sec emoji="✅" title="最初にやること（管理者・順番どおり）">
            <Step n={1}><b>宛先グループを決める</b> — 連絡タブ→「宛先・公開設定」で「組立」「機械」など(既定で入っています)</Step>
            <div className="bg-teal-50 border border-teal-200 rounded-lg px-3 py-2 my-1">
              <b>👥 誰の携帯が鳴るか（役職と宛先ルール）</b>
              <ul className="list-disc ml-5 mt-1 space-y-0.5">
                <li>{sideLabel}側の端末は登録時に<b>役職</b>（職長/工長/グループ長/一般）を選べます。普段の通知は<b>職長</b>の携帯へ（役職未設定の端末も職長あつかい）</li>
                <li><b>職長が休みの日</b> → 宛先・公開設定→宛先ルールで「職長 不在」をONにすると、自動で<b>上司（工長・グループ長）</b>へ切り替わります</li>
                <li><b>重い内容（大きい不良など）</b> → 送信画面の「誰の携帯を鳴らすか」で<b>職長＋上司</b>や<b>上司のみ</b>を選べます</li>
                <li><b>返信が来ない時</b> → 宛先ルールで「未返信◯分で上司にも自動通知」を設定できます（0=しない）</li>
                <li>該当役職の端末が1台も無い時は 職長→上司→全員 の順に自動で振り替え、<b>誰にも届かない事態を防ぎます</b>。通知が絞られても、連絡そのものはポータル画面に全員分表示されます</li>
              </ul>
            </div>
            <Step n={2}><b>班のメンバーを登録</b>(任意) — 同じ画面の「班のメンバー」欄に「小川、佐藤」のように入れると、送信時に人を指名できます</Step>
            <Step n={3}><b>{sideLabel}にURLを渡す</b> — 「{sideLabel}に渡すURL」をコピーして、組立・機械の端末で開いてもらう→グループを選んでもらう(これだけで使えます)</Step>
            <Step n={4}><b>通知を設定</b>(下の「管理者の初期設定」) — 携帯が鳴るようになります。設定しなくても連絡機能自体は使えます</Step>
            <Step n={5}>機能ごと止めたい時は マスタ設定→「工程連絡」のチェックをOFF</Step>
          </Sec>
          <Sec emoji="📤" title="依頼を送る3つの方法（こっち側）">
            <div><b>① 連絡タブから</b> — 「連絡・呼出」ボタン。宛先グループ→(任意で人を指名)→内容を書くか「よく使う内容」チップをタップ→送信</div>
            <div><b>② 作業中のNG→修正から</b> — 修正を押すと「連絡しますか？」が自動で開き、工程・台数・NG理由が入った状態で送れます。返信は作業画面にそのまま表示されます<br /><span className="fi-tap-text text-slate-400">※ マスタ設定で「中間分割の精度・バックラッシュNGは連絡せずに返却する」をONにしている場合、その組み合わせの時だけ②は開きません（完品分割は今までどおり開きます）</span></div>
            <div><b>③ 不具合報告から</b> — 報告画面の「📨 報告して連絡」。報告内容と<b>写真</b>が依頼に添付され、あっちの画面で写真をタップ拡大できます</div>
            <div><b>到着予定を聞く</b> — 連絡タブ→「到着予定を聞く」で製品を複数選んで送ると、あっちが1件ずつ日時を入れて返してくれます</div>
            <div className="bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
              <b>🚚 回答が来たら → 検査リストへ反映 → 🏁 終了予定を返す</b>
              <ol className="list-decimal ml-5 mt-1 space-y-0.5">
                <li>回答が届くと<b>画面左下に通知</b>が出ます（連絡タブにも赤バッジ）。「検査リストへ反映」を押す</li>
                <li>同じ指図で<b>テンプレートが分かれている時はどのロットか選ぶ</b>（わからなければ両方でOK）→ 到着時刻がそのロットの<b>入荷時間</b>に入ります</li>
                <li><b>終了予定</b>（到着してから検査の見積時間ぶん働いたら終わる時刻）が自動で出ます。実際に合わない時は時刻を直して「反映して終了予定を返信」→ 相手のポータルに🏁終了予定が表示＋通知されます</li>
              </ol>
              <div className="fi-tap-text text-slate-500 mt-1">※ 自動計算は「目標時間×台数」を、<b>休憩・定時・土日を避けて</b>足した時刻です（設定→勤務スケジュールの時間割を使います）。例: 16時到着で見積3時間なら、15時休憩や定時を跨いで<b>翌営業日</b>になることもあります。他の仕事の割り込み・段取り待ちは入っていないので、現実に合わせて直してから返すのがおすすめです。</div>
            </div>
          </Sec>
          <Sec emoji="📥" title={`${sideLabel}側の使い方（ポータル）`}>
            <Step n={1}>渡されたURLを開く→自分のグループ(組立など)を押す(最初の1回だけ)</Step>
            <Step n={2}>依頼が来たら「すぐ行く/10分後/20分後/行けない」をタップ+ひとことコメント(任意)</Step>
            <Step n={3}>「いつ来るか」依頼には日付と時間を入れて返信</Step>
            <Step n={4}>頼まれる前でも「到着予定を登録」から自発的に知らせられます</Step>
            <Step n={5}>右上の🔔から「この端末で通知を受け取る」— これで画面を見ていなくても携帯が鳴ります(<b>通知を受け取りたい端末ごと</b>に1回。送るだけなら登録不要)</Step>
            <p className="text-xs text-slate-400">ポータルは限定表示です(指図・品目コードと、設定で許可した台数・納期のみ。検査データや分析は見えません)。</p>
          </Sec>
          <Sec emoji="📋" title="管理者CC（誰が誰に何を送ったか見る）">
            <p>管理者は、連絡タブ→通知(プッシュ)で自分の端末を登録した後「<b>📋 管理者CC: ON</b>」にすると、<b>誰かが依頼を送るたびに写しの通知</b>が届きます(例:「📋 CC(組立宛): 🔧修正依頼 → 小川さん（尾田）」)。返信の通知は登録した検査側全端末に元々届きます。現場で起きているアクシデントの把握に使えます。</p>
          </Sec>
          <Sec emoji="🔔" title="通知のしくみ（読むだけでOK）">
            <p>依頼や返信が来たとき、<b>画面を見ていなくても携帯・パソコンに通知が届き</b>ます。いつものブラウザ（Chrome/Safari）がそのまま受け取ります。</p>
            <p>やることは1回だけ: 「<b>この端末で通知を受け取る</b>」ボタン→「<b>許可</b>」。<b>受け取りたい端末ごと</b>に行ってください（送るだけの端末は不要）。</p>
            <p className="text-xs text-slate-400">※通知が失敗しても連絡そのものはアプリ/ポータルの画面に必ず表示されます（通知は「気づかせる」ための上乗せ）。テスト通知は「押した端末」だけに届きます。</p>
          </Sec>
          {/* PWA(アプリとしてインストール)。「Galaxyで通知に気づかない」への唯一の打ち手なので、通知の章の直後に置く。 */}
          <Sec emoji="⬇️" title="アプリとして入れる（通知に気づかない人は必ずこれ）">
            <p><b>これが「通知が出ない・まとめて来る・画面が黒いまま」の唯一の対策です。</b>ブラウザのタブで開いているだけだと、端末の設定に「このアプリ」の項目が出てこないので、通知を強くする方法がそもそも存在しません。入れると独立したアプリとして扱われ、設定をいじれるようになります。</p>
            <div className="font-bold text-slate-700 mt-1">① 入れる — <b className="text-emerald-700">このボタンを押すだけです</b></div>
            <InstallAppButton />
            <div className="fi-tap-text text-slate-400">※ボタンが出ない時は、手動でも入れられます: <b>Galaxy</b>=Chromeの右上 <b>⋮</b> →「アプリをインストール」／<b>iPhone</b>=Safariの<b>共有</b> →「ホーム画面に追加」／<b>PC</b>=アドレスバー右端の <b>⊕</b></div>
            <div className="font-bold text-rose-700 mt-1">② 入れたあと、ここまでやらないと意味がありません</div>
            <Step n={1}><b>Galaxy</b>: 設定 →アプリ →入れたアプリ →<b>通知</b> →重要度を「<b>緊急</b>」(ポップアップ表示)に上げる</Step>
            <Step n={2}><b>Galaxy</b>: 同じ画面の <b>バッテリー</b> →「<b>制限なし</b>」にする（溜め込まれなくなります）</Step>
            <Step n={3}><b>PC</b>: Windowsの 設定 →システム →通知 →入れたアプリ →バナー表示ON。集中モードを使うなら「<b>優先通知</b>」に入れる</Step>
            <Warn><b>iPhoneはホーム画面に追加しないと、そもそも通知が1件も届きません</b>（iPhoneの仕様です）。Safariのタブで開いているだけの人がいたら、必ず追加してもらってください。</Warn>
            <div className="font-bold text-slate-700 mt-1">③ 入れると出るもの</div>
            <p>アイコンの右上に<b>未読の件数バッジ</b>が出ます（PCならタスクバー、スマホならホーム画面）。連絡を開けば消えます。通知音も、最初に「🔊音を有効にする」を押さなくても鳴るようになります。</p>
            <p className="text-xs text-slate-400">※<b>組立の人はポータルの画面から</b>入れてください。そこから入れると、アイコンを押した時にポータルが開きます（検査の画面からだと検査画面が開いてしまいます）。※PCの「作業中に気づかない」はこれでは直りません（画面を見ている間はOS通知が出ない仕組みのため）。そこは通知音と画面内の通知が担当しています。</p>
          </Sec>
          <Sec emoji="📱" title="Galaxy・Android の設定">
            <Step n={1}>このページを <b>Chrome</b>（または Samsung Internet）で開く</Step>
            <Step n={2}>「<b>この端末で通知を受け取る</b>」ボタンを押す</Step>
            <Step n={3}>「通知を許可しますか？」→「<b>許可</b>」を押す</Step>
            <Step n={4}>「テスト通知」ボタンで届くことを確認</Step>
            <div className="font-bold text-slate-700 mt-1">通知が遅い・来ないとき（Galaxyの省電力が原因のことが多い）:</div>
            <Step n={1}>端末の「設定」→「アプリ」→「<b>Chrome</b>」→「バッテリー」→「<b>制限なし</b>」を選ぶ</Step>
            <Step n={2}>「設定」→「バッテリー」（またはデバイスケア）→「バックグラウンド使用の制限」→「<b>スリープ中のアプリ</b>」「<b>ディープスリープ中のアプリ</b>」に Chrome が入っていたら外す</Step>
            <Step n={3}>「使用していないアプリを自動でスリープ」がONの場合、Chromeを「スリープさせないアプリ」に追加</Step>
            <Warn>Galaxyは本体アップデート後にこの設定が元に戻ることがあります。通知が来なくなったらここを再確認してください。</Warn>
          </Sec>
          <Sec emoji="🍎" title="iPhone・iPad の設定">
            <p>iPhoneは<b>「ホーム画面に追加」してから開く</b>のが必須です（iOS 16.4以上）。普通にSafariで開いただけでは通知は使えません。</p>
            <Step n={1}>このページを <b>Safari</b> で開く</Step>
            <Step n={2}>画面下の「<b>共有ボタン</b>」（四角から↑が出ているマーク）を押す</Step>
            <Step n={3}>下にスクロールして「<b>ホーム画面に追加</b>」→「追加」</Step>
            <Step n={4}>ホーム画面にできた<b>アイコンから開き直す</b></Step>
            <Step n={5}>「<b>この端末で通知を受け取る</b>」→「<b>許可</b>」→「テスト通知」で確認</Step>
            <Warn>集中モード・おやすみモード中は通知が表示されません（設定→集中モードで確認）。通知が出ないときは 設定→通知 でこのアプリがONになっているかも確認してください。</Warn>
            <p className="text-xs text-slate-400">※iOS 16.3以前は通知に対応していません。その場合もポータル画面を開けば連絡は見られます。</p>
          </Sec>
          <Sec emoji="💻" title="パソコン（Windows / Chrome・Edge）の設定">
            <Step n={1}>このページを Chrome か Edge で開く</Step>
            <Step n={2}>「<b>この端末で通知を受け取る</b>」→「<b>許可</b>」</Step>
            <Step n={3}>「テスト通知」で画面右下に出ることを確認</Step>
            <Warn>Windowsの「応答不可（集中モード）」がONだと通知が出ません。画面右下の通知センターから確認できます。</Warn>
            <p className="text-xs text-slate-400">※詰所のPCでポータルを開きっぱなしにする場合は、通知が無くても画面上部に新着が出ます。</p>
          </Sec>
          <Sec emoji="🛠" title="管理者の初期設定（最初の1回だけ）">
            <p>通知の送信にはWorker(送信サーバー)とVAPID鍵の設定が必要です。<b>連絡タブ →「宛先・公開設定」→ 通知（プッシュ）</b>に入力欄があります。</p>
            <Step n={1}>Firebaseコンソール → プロジェクト設定 → <b>Cloud Messaging</b> → 「ウェブプッシュ証明書」で鍵ペアを生成し、公開鍵（Bで始まる長い文字列）を「<b>VAPID鍵</b>」欄に貼る</Step>
            <Step n={2}>「<b>Worker URL</b>」欄に既存Worker（gemini-proxy）のURLを入れる</Step>
            <Step n={3}>Googleコンソール(IAM)でサービスアカウントに「<b>Firebase Cloud Messaging API 管理者</b>」ロールを付与（worker/README_セットアップ手順.md の「FCMプッシュ通知」章に詳細手順）</Step>
            <Step n={4}>自分の端末で「この端末で通知を受け取る」→「テスト通知」が届けば完了</Step>
          </Sec>
          <Sec emoji="❓" title="通知が来ないとき（チェックリスト）">
            <ol className="list-decimal ml-5 flex flex-col gap-1">
              <li><b>アプリとして入れて、通知の重要度を「緊急」にしたか</b>（上の「⬇️アプリとして入れる」欄。<b>通知が出ない・まとめて来る・画面が黒いままは、ほぼこれで直ります</b>。ブラウザのタブのままだと打つ手がありません）</li>
              <li>「テスト通知」ボタンを押して結果メッセージを確認（エラーが出るなら設定の問題、成功なのに出ないなら端末の問題）</li>
              <li>ブラウザのサイト設定で通知が「許可」か（アドレスバーの鍵マーク→通知）</li>
              <li>端末の設定でブラウザ自体の通知がONか（設定→通知→Chrome/Safari）</li>
              <li>Galaxy: 電池の最適化からChromeを除外しているか（上のGalaxy欄参照）</li>
              <li>iPhone: ホーム画面のアイコンから開いているか／集中モードがOFFか</li>
              <li>機内モード・Wi-Fi/電波の状態</li>
              <li>それでもダメなら一度「この端末の通知を解除」→再度「受け取る」で登録し直す</li>
            </ol>
          </Sec>
        </div>
        <div className="px-4 py-3 border-t border-slate-200 bg-white flex justify-end shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-800 text-white text-sm font-bold">閉じる</button>
        </div>
      </div>
    </div>
  );
};

// 通知(プッシュ)の受信登録+テスト。admin=trueで管理者設定(VAPID鍵/Worker URL)と登録端末一覧も出す。
// 検査側(連絡タブ, side='app')とあっち側(ポータル, side='portal'+グループ名)の両方で使う。
const PushSettingsPanel = ({ settings, saveSettings, saveShared = null, saveData, deleteData, pushTokens = [], side, group = '', personName = '', admin = false, onOpenHelp }) => {
  // 📱スマホでは押す物を 44px 以上に。⚠PC(wide)では何も足さない = 今までと1pxも変わらない。
  //   ⚠この部品は 検査側の設定画面 と 組立ポータルの🔔 の両方から開かれる。片方だけ直せない。
  const { narrow } = useLayout();
  const mTap = narrow ? ' min-h-11' : '';
  const cfg = pushCfgOf(settings);
  const sideLabel = contactSideLabel(settings);
  const [vapidDraft, setVapidDraft] = useState(cfg.vapidKey);
  const [workerDraft, setWorkerDraft] = useState(cfg.workerUrl || 'https://gemini-proxy.you0925.workers.dev');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const deviceId = pushDeviceId();
  const mine = (pushTokens || []).find(t => t && t.id === deviceId);
  const prob = pushSupportProblem();
  const ready = !!(cfg.vapidKey && cfg.workerUrl);
  const plat = pushPlatform();
  // 役職(あっち側のみ): 職長=既定の宛先 / 工長・グループ長=上司(職長不在時・重い内容・エスカレーション先)
  const [role, setRole] = useState(() => { try { return localStorage.getItem('renrakuRole') || ''; } catch (e) { return ''; } });
  const saveRole = (r) => {
    setRole(r);
    try { localStorage.setItem('renrakuRole', r); } catch (e) { /* noop */ }
    if (mine) saveData('push_tokens', deviceId, { role: r });
  };
  const enableHere = async () => {
    setBusy(true); setErr(''); setInfo('');
    try {
      const token = await enablePush(cfg.vapidKey);
      await saveData('push_tokens', deviceId, {
        token, side, group: group || '', name: personName || '',
        ...(side === 'portal' ? { role: role || '' } : {}),
        platform: `${plat.os}${plat.standalone ? '-pwa' : ''}`,
        ua: String(navigator.userAgent || '').slice(0, 160), enabled: true, at: Date.now(),
      });
      setInfo('この端末を登録しました。「テスト通知」で届くか確認してください');
    } catch (e) { setErr(e?.message || String(e)); }
    setBusy(false);
  };
  const disableHere = async () => {
    setBusy(true); setErr(''); setInfo('');
    try {
      await disablePush();
      if (mine && deleteData) await deleteData('push_tokens', deviceId);
      setInfo('この端末の通知を解除しました');
    } catch (e) { setErr(e?.message || String(e)); }
    setBusy(false);
  };
  const sendTest = async () => {
    if (!mine || !cfg.workerUrl) return;
    setBusy(true); setErr(''); setInfo('');
    const res = await sendPushViaWorker(cfg.workerUrl, {
      tokens: [mine.token], title: '✅ テスト通知', body: 'この端末に工程連絡の通知が届きます',
      // tagは毎回ユニークに(同じtagだと前の通知が残っている時に音なしで置き換わり「届かない」ように見える)
      link: (typeof window !== 'undefined' ? `${window.location.origin}${side === 'portal' ? '/?renraku=1' : '/'}` : ''), tag: `push-test-${Date.now()}`,
    });
    if (res?.ok && res.sent > 0) setInfo('この端末宛てにテスト通知を送りました（テストは押した端末だけに届きます。他の端末はその端末で押してください）');
    else setErr(`テスト送信に失敗: ${res?.results?.[0]?.error || res?.error || '不明なエラー'}`);
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-black text-slate-500 flex items-center gap-1.5">
        <BellRing className="w-3.5 h-3.5 text-amber-500" /> 通知（プッシュ）— 画面を見ていなくても携帯に届く
        {onOpenHelp && <button onClick={onOpenHelp} className={`ml-1 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 ${narrow ? 'text-xs' : 'fi-tap-text'} font-bold flex items-center gap-1${mTap}`}><HelpCircle className="w-3 h-3" /> 設定方法（Galaxy/iPhone/PC）</button>}
      </div>
      {admin && (
        <details className="bg-slate-50 border border-slate-200 rounded-lg">
        <summary className="px-2.5 py-2 fi-tap-text font-bold text-slate-500 cursor-pointer select-none">⚙ 管理者はこちら（通知サーバー設定 — 最初の1回だけ。作業者は触らないでください）</summary>
        <div className="p-2.5 pt-0 flex flex-col gap-1.5">
          <div className="fi-tap-text font-bold text-amber-600">⚠ ここを変えると全員の通知が止まることがあります。取り方は上の「設定方法」→ 管理者の初期設定。</div>
          <div className="flex items-center gap-1.5">
            <span className="fi-tap-text font-bold text-slate-500 w-20 shrink-0">VAPID鍵</span>
            <input value={vapidDraft} onChange={e => setVapidDraft(e.target.value)} placeholder="Bで始まる長い文字列（Firebaseコンソール→Cloud Messaging→ウェブプッシュ証明書）" className="flex-1 border border-slate-300 rounded-lg px-2 py-1 text-xs font-mono" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="fi-tap-text font-bold text-slate-500 w-20 shrink-0">Worker URL</span>
            <input value={workerDraft} onChange={e => setWorkerDraft(e.target.value)} placeholder="https://gemini-proxy.…workers.dev" className="flex-1 border border-slate-300 rounded-lg px-2 py-1 text-xs font-mono" />
            <button onClick={() => { (saveShared || saveSettings)({ push: { ...(settings?.push || {}), vapidKey: vapidDraft.trim(), workerUrl: workerDraft.trim().replace(/\/+$/, '') } }); setInfo('通知設定を保存しました（製品検査・最終検査の両方に効きます）'); }} className="px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-black shrink-0">保存</button>
          </div>
          {!ready && <div className="fi-tap-text text-amber-600 font-bold">VAPID鍵とWorker URLの両方を保存すると通知が使えるようになります（未設定の間も連絡機能自体は普通に使えます）</div>}
          <div className="fi-tap-text text-slate-500 bg-blue-50 border border-blue-100 rounded-lg px-2.5 py-1.5">
            💡 <b>{sideLabel}・機械などの端末とのつなげ方:</b> その端末で上の「{sideLabel}に渡すURL」を開く → グループ（組立など）を選ぶ → 右上の🔔 →「この端末で通知を受け取る」。これで<b>そのグループ宛ての依頼</b>がその端末に届きます。ここ（検査側）で登録した端末には<b>返信・到着回答</b>が届きます。
          </div>
        </div>
        </details>
      )}
      {!admin && !ready && <div className="text-xs text-slate-400 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">通知はまだ準備中です（検査側の管理者が設定すると使えるようになります）。連絡はこの画面に表示されます。</div>}
      {ready && side === 'portal' && !prob && (
        <div className="flex items-center gap-2 flex-wrap text-xs font-bold text-slate-600">
          <span className="shrink-0">この端末の役職:</span>
          <select value={mine ? (mine.role || role || '') : role} onChange={e => saveRole(e.target.value)} className={`border border-slate-300 rounded-lg px-2 py-1 font-bold${mTap}`}>
            <option value="">未設定（職長あつかい）</option>
            {CONTACT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <span className="fi-tap-text text-slate-400 font-normal">職長=普段の宛先 / 工長・グループ長=職長が休みの時や重い内容の時に受け取る「上司」/ 一般=「全員」宛てのときだけ</span>
        </div>
      )}
      {ready && (
        <div className="flex items-center gap-2 flex-wrap">
          {prob
            ? <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 font-bold">{prob}</span>
            : mine
              ? (<>
                  <span className="text-xs font-black text-emerald-700 bg-emerald-50 border border-emerald-300 rounded-full px-2.5 py-1 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> この端末は通知を受け取ります{mine.name ? `（${mine.name}）` : ''}{mine.role ? <span className="ml-0.5 fi-tap-text bg-teal-100 border border-teal-300 text-teal-700 rounded px-1">{mine.role}</span> : null}</span>
                  <button disabled={busy} onClick={sendTest} className={`px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold disabled:opacity-40${mTap}`}>テスト通知</button>
                  <button disabled={busy} onClick={disableHere} className={`px-2.5 py-1 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50 text-xs font-bold disabled:opacity-40${mTap}`}>解除</button>
                  {side === 'app' && (
                    <button disabled={busy} onClick={() => saveData('push_tokens', deviceId, { admin: !mine.admin })}
                      title="ON: 誰が誰にどんな依頼を送ったかのCC通知がこの端末に届きます(管理者向け)"
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold disabled:opacity-40 ${mine.admin ? 'bg-purple-600 hover:bg-purple-700 text-white' : 'border border-purple-300 text-purple-600 hover:bg-purple-50'}`}>
                      📋 管理者CC: {mine.admin ? 'ON' : 'OFF'}
                    </button>
                  )}
                </>)
              : <button disabled={busy} onClick={enableHere} className={`px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-black flex items-center gap-1.5 disabled:opacity-40${mTap}`}><Bell className="w-4 h-4" /> この端末で通知を受け取る</button>}
          {busy && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
        </div>
      )}
      {err && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 font-bold">
          {err}
          <div className="mt-1 font-normal text-slate-500">※通知が失敗しても、連絡そのものはこの画面に必ず表示されます。急ぎは今まで通り電話でもOK。直し方は「設定方法」→「通知が来ないとき」。</div>
        </div>
      )}
      {info && <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 font-bold">{info}</div>}
      {admin && (pushTokens || []).length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr><th className="text-left px-2 py-1.5">側</th><th className="text-left px-2 py-1.5">グループ</th><th className="text-left px-2 py-1.5">役職</th><th className="text-left px-2 py-1.5">名前</th><th className="text-left px-2 py-1.5">端末</th><th className="text-left px-2 py-1.5">登録</th><th className="px-2 py-1.5"></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(pushTokens || []).filter(t => t).sort((a, b) => (b.at || 0) - (a.at || 0)).map(t => (
                <tr key={t.id} className={t.id === deviceId ? 'bg-emerald-50/60' : ''}>
                  <td className="px-2 py-1.5 font-bold">{t.side === 'portal' ? sideLabel : '検査'}{t.admin ? <span className="ml-1 fi-tap-text font-black text-purple-600 bg-purple-50 border border-purple-200 rounded px-1">CC</span> : null}</td>
                  <td className="px-2 py-1.5">{t.group || '—'}</td>
                  <td className="px-2 py-1.5">
                    <select value={t.role || ''} onChange={e => saveData('push_tokens', t.id, { role: e.target.value })} className="border border-slate-200 rounded px-1 py-0.5 fi-tap-text font-bold">
                      <option value="">{t.side === 'portal' ? '未設定(職長扱い)' : '未設定(社内連絡は対象外)'}</option>
                      {CONTACT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">{t.name || '—'}{t.id === deviceId ? '（この端末）' : ''}</td>
                  <td className="px-2 py-1.5 text-slate-500">{t.platform === 'ios-pwa' ? 'iPhone(ホーム追加)' : t.platform === 'ios' ? 'iPhone' : String(t.platform || '').startsWith('android') ? 'Android' : 'PC'}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-400">{fmtContactTime(t.at)}</td>
                  <td className="px-2 py-1.5 text-right"><button onClick={() => { if (window.confirm('この端末の通知登録を削除しますか？')) deleteData('push_tokens', t.id); }} className="text-rose-500 hover:text-rose-700"><Trash2 className="w-3.5 h-3.5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// 連絡の送信モーダル。NG→修正の「連絡しますか？」と、作業画面/連絡タブの「連絡・呼出」の両方で使う。
const ContactSendModal = ({ draft, groups, from, lot, onClose, onSend, members = {}, chipOptions = [], onNotifyUnitsDone = null }) => {
  const [to, setTo] = useState(groups[0] || '');
  const [toPerson, setToPerson] = useState('');
  const [message, setMessage] = useState(draft?.message || '');
  const [moreChips, setMoreChips] = useState(false);
  const [toLevel, setToLevel] = useState('auto'); // 誰の携帯を鳴らすか(重い内容は職長+上司などに切替)
  // 添付写真の拡大。⚠このモーダル(z-[95])の上(z-[110])に出す。
  // ⚠早期 return より前に置く事(フックの規則)。
  const [zoomImg, setZoomImg] = useState(null);
  if (!draft) return null;
  const isRepair = draft.kind === 'repair';
  // タップで本文に挿し込める文例: NG理由など文脈チップ(draft.chips)+軽微不良・改善提案マスタ
  const allChips = [...new Set([...(draft.chips || []), ...(chipOptions || [])].map(c => String(c || '').trim()).filter(Boolean))];
  const shownChips = moreChips ? allChips : allChips.slice(0, 8);
  const groupMembers = members[to] || [];
  return (
    <div className="fixed inset-0 z-[95] bg-black/50 flex items-center justify-center p-4" onClick={() => { if (message.trim() && !window.confirm('書きかけの内容を捨てて閉じますか？')) return; onClose(); }}>
      {/* ⚠max-h と内側スクロールが要る。修正依頼の経路では全部の欄が同時に出て実測 約777px になり、
             【送信】が画面の外へ出る。宛先の人・よく使う内容のチップは設定件数で伸びるので、写真を小さくしても抑えきれない。 */}
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[92vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className={`shrink-0 px-4 py-3 text-white flex items-center gap-2 ${isRepair ? 'bg-orange-600' : 'bg-blue-600'}`}>
          <MessageCircle className="w-5 h-5" />
          <span className="font-black">{isRepair ? '連絡しますか？（修正依頼）' : '連絡・呼出を送る'}</span>
          <button onClick={onClose} className="ml-auto p-1 hover:bg-white/20 rounded-full"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3">
          {lot && lot.id && (
            <div className="text-xs font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded px-2 py-1.5">
              指図 {lot.orderNo} / {lot.model}{lot.modelText ? ` ${lot.modelText}` : ''}{draft.stepTitle ? ` / ${draft.stepTitle}` : ''}{draft.unitLabel ? ` / ${draft.unitLabel}` : ''}
            </div>
          )}
          {/* ✅ 清水さん(2026-08-21)「一台終わったら連絡できるような機能」。
              ロットが全部終わるのを待たずに、終わった台数ぶんだけ次工程へ知らせる。
              ⚠中身は既にある分納の仕組み(domain/completeSplit.js)をそのまま使う。二重に作らない。
              ⚠ここでは送らない。台数と宛先を選ぶ確認画面を開くだけ(勝手に飛ばさない)。 */}
          {onNotifyUnitsDone && lot && lot.id && remainingQtyOf(lot) > 0 && (
            <button onClick={onNotifyUnitsDone} className="w-full rounded-lg border-2 border-emerald-400 bg-emerald-50 hover:bg-emerald-100 px-3 py-2 text-left">
              <div className="text-sm font-black text-emerald-800">✅ 終わった台数ぶんを次工程へ知らせる</div>
              <div className="fi-tap-text text-emerald-700 mt-0.5">この指図はまだ {remainingQtyOf(lot)}台ぶん 知らせていません。1台からでも送れます。</div>
            </button>
          )}
          <label className="text-xs font-bold text-slate-500">宛先
            <select value={to} onChange={e => { setTo(e.target.value); setToPerson(''); }} className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-2 text-sm font-bold">
              {groups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          {groupMembers.length > 0 && (
            <div>
              <div className="text-xs font-bold text-slate-500">宛先の人（任意・押すと指名になります）</div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {groupMembers.map(n => (
                  <button key={n} onClick={() => setToPerson(p => p === n ? '' : n)}
                    className={`px-2.5 py-1.5 rounded-full text-xs font-bold border ${toPerson === n ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                    {n}{toPerson === n ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          {allChips.length > 0 && (
            <div>
              <div className="text-xs font-bold text-slate-500">よく使う内容（押すと本文に追加）</div>
              <div className="flex flex-wrap gap-1 mt-1">
                {shownChips.map(c => (
                  <button key={c} onClick={() => setMessage(m => m.trim() ? `${m.trim()} / ${c}` : c)}
                    className="px-2 py-1 rounded-lg fi-tap-text font-bold bg-slate-100 border border-slate-200 text-slate-600 hover:bg-blue-50 hover:border-blue-300">{c}</button>
                ))}
                {allChips.length > 8 && <button onClick={() => setMoreChips(v => !v)} className="px-2 py-1 rounded-lg fi-tap-text font-bold text-blue-600 underline">{moreChips ? '閉じる' : `他${allChips.length - 8}件…`}</button>}
              </div>
            </div>
          )}
          <label className="text-xs font-bold text-slate-500">内容
            <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3} className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-2 text-sm" placeholder="例: ○○の修正をお願いします / 手が空いたら来てください" />
          </label>
          {(draft.attachPhotos || []).length > 0 && (
            <div>
              <div className="text-xs font-bold text-slate-500">添付される写真（不具合報告のもの・相手のポータルに表示されます）</div>
              <div className="fi-tap-text text-slate-400">押すと大きく見られます</div>
              {/* ⚠h-16 のまま大きくしない。このカードは max-h も overflow-y-auto も無いので、
                  中身が伸びると【送る】が画面の外へ出る。拡大は別の窓で見せる。 */}
              <div className="flex gap-1.5 mt-1 overflow-x-auto">
                {draft.attachPhotos.map((p, i) => <img key={i} src={p} alt="" onClick={() => setZoomImg(p)} title="押すと大きく見られます" className="h-16 rounded-lg border border-slate-200 shrink-0 cursor-zoom-in" />)}
              </div>
            </div>
          )}
          <div>
            <div className="text-xs font-bold text-slate-500">誰の携帯を鳴らすか <span className="font-normal text-slate-400">— 重い内容（大きい不良など）は「職長＋上司」がおすすめ</span></div>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {CONTACT_LEVELS.map(([id, lbl]) => (
                <button key={id} onClick={() => setToLevel(id)}
                  className={`px-2.5 py-1.5 rounded-full text-xs font-bold border ${toLevel === id ? 'bg-teal-600 border-teal-600 text-white' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                  {lbl}{toLevel === id ? ' ✓' : ''}
                </button>
              ))}
            </div>
          </div>
          <div className="fi-tap-text text-slate-400">相手は「すぐ行く / 10分後 / 20分後 / 行けない」からワンタップで返信できます。返信は作業画面と連絡タブに表示されます。</div>
        </div>
        {/* ⚠【送信】は本文の外に出して常に見える位置へ固定する。中に置くと、
               宛先の人や よく使う内容 が増えた時に画面の外へ出て押せなくなる。 */}
        <div className="shrink-0 px-4 py-3 border-t border-slate-200 flex gap-2 justify-end">
            <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-500 hover:bg-slate-100">送らない</button>
            <button
              disabled={!to || !message.trim()}
              onClick={() => onSend({
                kind: isRepair ? 'repair' : 'call', to, toPerson: toPerson || '', from: from || '', message: message.trim(),
                lotId: lot?.id || '', orderNo: lot?.orderNo || '', model: lot?.model || '', modelText: lot?.modelText || '',
                stepTitle: draft.stepTitle || '', unitLabel: draft.unitLabel || '',
                refIntId: draft.refIntId || '',
                toLevel,
                createdAt: Date.now(), status: 'waiting',
              })}
              className="px-4 py-2 rounded-lg text-sm font-black text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1.5"
            ><Send className="w-4 h-4" /> 送信</button>
        </div>
      </div>
      {/* 添付写真の拡大。⚠この送信モーダルが z-[95] なので必ずその上(z-[110])。
          ⚠元の写真がそこまで大きくないので max-* のままにする(w-full にすると引き伸ばしてボケるだけ)。 */}
      {zoomImg && (
        <div className="fixed inset-0 z-[110] bg-black/90 flex items-center justify-center p-3" onClick={(e) => { e.stopPropagation(); setZoomImg(null); }}>
          <img src={zoomImg} alt="" className="max-w-full max-h-full object-contain rounded-lg shadow-lg"/>
          <button onClick={(e) => { e.stopPropagation(); setZoomImg(null); }} className="absolute top-4 right-4 bg-white/20 hover:bg-white/30 text-white rounded-full w-10 h-10 flex items-center justify-center text-xl font-bold">✕</button>
        </div>
      )}
    </div>
  );
};

// 作業画面ヘッダ下: 呼出ボタン+このロットの連絡と返信(すぐ行く/10分後/…)をライブ表示。
const WorkContactPanel = ({ lot, contactRequests, onOpenSend }) => {
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNowTick(Date.now()), 30000); return () => clearInterval(t); }, []);
  const mine = useMemo(() => (contactRequests || [])
    .filter(r => r && r.lotId === lot.id && r.kind !== 'arrival' && r.status !== 'canceled' && r.status !== 'done')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 3), [contactRequests, lot.id]);
  return (
    <div className="shrink-0 mx-3 mt-2 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onOpenSend(null)} className="px-4 py-2.5 min-h-[44px] rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-black flex items-center gap-1.5 shadow-sm" title="他工程を呼ぶ/質問する（返信はここに表示されます）">
          <MessageCircle className="w-4 h-4" /> 連絡・呼出
        </button>
        {mine.length === 0 && <span className="fi-tap-text text-slate-400">修正に来てほしい時・質問したい時はここから連絡</span>}
      </div>
      {mine.map(r => {
        const st = contactStatusInfo(r);
        const fresh = r.answer?.at && (nowTick - r.answer.at) < 10 * 60 * 1000; // 返信10分以内は強調
        return (
          <div key={r.id} className={`rounded-lg border px-2.5 py-1.5 text-xs flex items-center gap-2 flex-wrap ${r.status === 'answered' ? (fresh ? 'bg-emerald-50 border-emerald-400 ring-2 ring-emerald-300/60' : 'bg-emerald-50 border-emerald-300') : 'bg-amber-50 border-amber-300'}`}>
            <span className="font-black text-slate-500 shrink-0">{contactKindLabel(r)}</span>
            <span className="text-slate-600 truncate max-w-[32ch]" title={r.message}>{r.message}</span>
            <span className="text-slate-400 shrink-0">→ {r.to}</span>
            {r.status === 'answered' && r.answer ? (
              <span className={`font-black shrink-0 ${r.answer.choice === 'no' ? 'text-rose-700' : 'text-emerald-700'}`}>
                返信: {contactReplyLabel(r.answer.choice)}{r.answer.comment ? `（${r.answer.comment}）` : ''}
                <span className="font-mono fi-tap-text opacity-70 ml-1">{fmtContactTime(r.answer.at)}</span>
              </span>
            ) : (
              <span className={`shrink-0 px-1.5 py-0.5 rounded border font-bold ${st.cls}`}>{st.label} {fmtContactElapsed(r.createdAt, nowTick)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
};

// 到着予定を聞くモーダル: 検査リストから複数指定して「いつ来るか」をあっちへ依頼する。
const ContactAskArrivalModal = ({ lots, groups, from, onClose, onSend }) => {
  const [to, setTo] = useState(groups[0] || '');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState({});
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (lots || [])
      .filter(l => l && l.status !== 'completed')
      .filter(l => !s || String(l.orderNo || '').toLowerCase().includes(s) || String(l.model || '').toLowerCase().includes(s))
      .sort((a, b) => (dueMsOf(a.dueDate) ?? Infinity) - (dueMsOf(b.dueDate) ?? Infinity));
  }, [lots, q]);
  const count = Object.values(sel).filter(Boolean).length;
  return (
    <div className="fixed inset-0 z-[95] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 bg-teal-600 text-white flex items-center gap-2 shrink-0">
          <Truck className="w-5 h-5" />
          <span className="font-black">到着予定を聞く（いつ来るか）</span>
          <button onClick={onClose} className="ml-auto p-1 hover:bg-white/20 rounded-full"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 flex flex-col gap-3 min-h-0 flex-1">
          <div className="flex gap-2 items-center shrink-0">
            <label className="text-xs font-bold text-slate-500 flex items-center gap-1">宛先
              <select value={to} onChange={e => setTo(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-bold">
                {groups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="指図・品目コードで絞り込み" className="w-full border border-slate-300 rounded-lg pl-8 pr-2 py-1.5 text-sm" />
            </div>
            <span className="text-xs font-black text-teal-700 shrink-0">{count}件 選択中</span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {list.map(l => (
              <label key={l.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${sel[l.id] ? 'bg-teal-50' : 'hover:bg-slate-50'}`}>
                <input type="checkbox" checked={!!sel[l.id]} onChange={e => setSel(p => ({ ...p, [l.id]: e.target.checked }))} className="w-4 h-4 accent-teal-600" />
                <span className="font-mono text-sm font-bold text-slate-700 w-28 shrink-0 truncate">{l.orderNo}</span>
                <span className="text-sm font-bold text-slate-800 flex-1 truncate">{l.model}{l.modelText ? <span className="font-normal text-slate-400"> {l.modelText}</span> : null}</span>
                <span className="text-xs text-slate-500 shrink-0">{l.quantity}台</span>
                <span className="text-xs text-slate-500 shrink-0">納期 {fmtDue(l.dueDate) || '—'}</span>
              </label>
            ))}
            {list.length === 0 && <div className="p-4 text-center text-sm text-slate-400">対象ロットがありません</div>}
          </div>
          <div className="flex justify-end gap-2 shrink-0">
            <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-500 hover:bg-slate-100">キャンセル</button>
            <button
              disabled={!to || count === 0}
              onClick={() => onSend({
                kind: 'arrival', to, from: from || '', message: '到着予定（いつ来るか）を教えてください',
                createdAt: Date.now(), status: 'waiting',
                items: list.filter(l => sel[l.id]).map(l => ({ lotId: l.id, orderNo: l.orderNo || '', model: l.model || '', modelText: l.modelText || '', quantity: l.quantity || 0, dueDate: l.dueDate || '', date: '', time: '' })),
              })}
              className="px-4 py-2 rounded-lg text-sm font-black text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-40 flex items-center gap-1.5"
            ><Send className="w-4 h-4" /> {count}件を依頼</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// 連絡タブ: 依頼リスト(状況/送信/経過/返信) + 詳細 + 到着依頼作成 + 宛先/公開設定 + ポータルURL。
// 社内連絡(現場→検査の職長/工長)の送信モーダル。用件チップ+指図(任意)+内容。組立ではなく検査の職制へ通知。
const ContactInternalModal = ({ from, onClose, onSend }) => {
  const [topic, setTopic] = useState(CONTACT_INTERNAL_TOPICS[0]);
  const [message, setMessage] = useState('');
  const [orderNo, setOrderNo] = useState('');
  const send = () => {
    onSend({
      kind: 'internal', to: CONTACT_INTERNAL_GROUP, from: from || '現場',
      topic, orderNo: orderNo.trim(), message: message.trim() || topic,
      createdAt: Date.now(), status: 'waiting',
    });
  };
  return (
    <div className="fixed inset-0 z-[96] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 bg-indigo-700 text-white flex items-center gap-2"><MessageCircle className="w-5 h-5" /><span className="font-black">職長・工長へ 社内連絡</span><button onClick={onClose} className="ml-auto p-1 hover:bg-white/20 rounded-full"><X className="w-4 h-4" /></button></div>
        <div className="p-4 flex flex-col gap-3 text-sm">
          <div>
            <div className="text-xs font-black text-slate-500 mb-1">用件</div>
            <div className="flex flex-wrap gap-1.5">
              {CONTACT_INTERNAL_TOPICS.map(t => (
                <button key={t} onClick={() => setTopic(t)} className={`px-2.5 py-1 rounded-full text-xs font-bold border ${topic === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>{t}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs font-black text-slate-500 mb-1">指図（任意）</div>
            <input value={orderNo} onChange={e => setOrderNo(e.target.value)} placeholder="指図番号（あれば）" className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
          </div>
          <div>
            <div className="text-xs font-black text-slate-500 mb-1">内容</div>
            <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3} placeholder="例: 5工程で手が足りません。応援お願いします。 / 号機の取り合いで止まっています。" className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm resize-none" />
          </div>
          <div className="fi-tap-text text-slate-400">検査の職長・工長の携帯に通知が届きます（連絡タブの端末一覧で役職を付けた端末へ。未登録なら検査の全端末へ）。</div>
        </div>
        <div className="px-4 py-3 border-t border-slate-200 flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-500 hover:bg-slate-100">やめる</button>
          <button onClick={send} className="px-4 py-2 rounded-lg text-sm font-black text-white bg-indigo-700 hover:bg-indigo-800 flex items-center gap-1.5"><Send className="w-4 h-4" /> 職長へ送る</button>
        </div>
      </div>
    </div>
  );
};

// 連絡カードの会話スレッド(構造化リクエスト＋自由対話のハイブリッド)。検査(app)⇄組立(portal)がその場でやり取り。
// 依頼カードはそのまま(状態/宛先/返信は従来通り)、その下に会話欄を足すだけ=強み(追跡/集計/ルーティング)を保つ。
const contactNewCommentId = () => `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ContactThread = ({ req, mySide, onAdd }) => {
  // 📱スマホでは入力欄と送信を 44px 以上にする。⚠PC(wide)では何も足さない = 今までと1pxも変わらない。
  //   ⚠この部品は 検査側(ContactView)と 組立ポータル(ContactPortal)の両方で使う。片方だけ直せない。
  const { narrow } = useLayout();
  const mTap = narrow ? ' min-h-11' : '';
  const [text, setText] = useState('');
  const comments = req?.comments || [];
  const add = () => { const t = text.trim(); if (!t) return; onAdd(t); setText(''); };
  const seenOther = mySide === 'app' ? req?.seenPortal : req?.seenApp;
  const otherLabel = mySide === 'app' ? '組立' : '検査';
  return (
    <div className="border-t border-slate-200 pt-2 mt-1">
      <div className="fi-tap-text font-black text-slate-500 mb-1 flex items-center gap-1.5 flex-wrap">💬 会話
        {seenOther?.at && <span className="fi-tap-text font-normal text-emerald-600">👁 {otherLabel}が見ました {fmtContactTime(seenOther.at)}{seenOther.by ? `（${seenOther.by}）` : ''}</span>}
      </div>
      {comments.length > 0 && (
        <div className="flex flex-col gap-1 max-h-44 overflow-y-auto mb-1.5">
          {comments.map((c, i) => (
            <div key={c.id || i} className={`flex ${c.side === mySide ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[82%] rounded-2xl px-3 py-1.5 ${c.side === mySide ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-800'}`}>
                <div className={`fi-tap-text ${c.side === mySide ? 'text-blue-100' : 'text-slate-400'}`}>{c.by || (c.side === 'portal' ? '組立' : '検査')} ・ {fmtContactTime(c.at)}</div>
                <div className="text-sm whitespace-pre-wrap break-words">{c.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } }} placeholder="メッセージを書く…" className={`flex-1 border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm${mTap}`} />
        <button onClick={add} disabled={!text.trim()} className={`px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-black disabled:opacity-40 shrink-0${mTap}`}>送信</button>
      </div>
    </div>
  );
};

// saveShared = 検査アプリ共通の棚(宛先グループ・班メンバー)への保存。ここに書けば製品検査・最終検査の両方に効く。
const ContactView = ({ contactRequests, arrivalTimes, lots, settings, saveSettings, saveShared = null, saveData, deleteData, currentUserName, pushTokens = [], notifyPush = null, onApplyArrival = null, onOpenArrivalEntry = null,
  // 🚚到着チェック(来た/来ない・班のクセ)。⚠検査側だけ。組立ポータルには渡さない。
  arrivalActuals = [], onCheckArrival = null, onUndoArrival = null, onRemindArrival = null,
  // 🆕「検査リストに無い品」の連絡を、検査対象の登録画面へ流し込む(実際に作るのは親)
  onRegisterLot = null,
  onOpenComplete = null, onUndoDecline = null }) => {
  const [showPushHelp, setShowPushHelp] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNowTick(Date.now()), 30000); return () => clearInterval(t); }, []);
  // 通知音が解禁できたか。解禁は画面のどこを触っても起きる(=Reactは再描画しない)ので、1秒ごとに見て
  //   「音を有効にする」ボタンを自動で引っ込める。押したのにボタンが残る、を防ぐ。
  const [audioOk, setAudioOk] = useState(() => contactAudioReady());
  useEffect(() => { if (audioOk) return; const t = setInterval(() => { if (contactAudioReady()) setAudioOk(true); }, 1000); return () => clearInterval(t); }, [audioOk]);
  const [statusF, setStatusF] = useState('all');
  const [kindF, setKindF] = useState('all');
  const [q, setQ] = useState('');
  const [detailId, setDetailId] = useState(null);
  // 添付写真の拡大。⚠詳細モーダルが z-[95] なので、その上(z-[110])に出す。
  const [zoomImg, setZoomImg] = useState(null);
  const [showAsk, setShowAsk] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  // 宛先・公開設定のタイル(排他アコーディオン)。開いたタイルを枠の一番上へ寄せて中身が下に隠れないようにする。
  //   toggle はバブリングしないので capture で拾う(最終検査と同じ直し 2026-07-23)。
  const cfgBoxRef = useRef(null);
  useEffect(() => {
    const box = cfgBoxRef.current;
    if (!showCfg || !box) return;
    const onTog = (e) => {
      const d = e.target;
      if (!d || d.tagName !== 'DETAILS' || !d.open) return;
      requestAnimationFrame(() => {
        try {
          const br = box.getBoundingClientRect();
          const dr = d.getBoundingClientRect();
          box.scrollBy({ top: dr.top - br.top, behavior: 'smooth' });
        } catch (_) {}
      });
    };
    box.addEventListener('toggle', onTog, true);
    return () => box.removeEventListener('toggle', onTog, true);
  }, [showCfg]);
  const [newGroup, setNewGroup] = useState('');
  const [copied, setCopied] = useState(false);
  const groups = contactGroupsOf(settings);
  const sideLabel = contactSideLabel(settings);
  const [groupF, setGroupF] = useState('all'); // 班しぼり込み(「この班から到着予定が来ていない」を見るため)
  // あっちが頼まれる前に自分で登録した到着予定は contact_requests に無い(arrival_times だけ)。
  // それも同じ表に「到着予定(自発)」として並べる → 後から「この班からは到着予定が来ていない」と分かる。
  // 依頼への回答は contact_requests 側にも出るので、二重に出さないよう除く(古いデータには viaReq が無いので実データで突合)。
  // ⚠この表と「もらった到着予定」の板は**同じ規則**で作る。別々の判定にしていたせいで、
  //   元の依頼が削除された到着予定(=孤児)が板には出て表には出ない、が起きた(1001398676 TWA-160)。
  //   ⚠この表に出るのは arrival_times の**原本だけ**。反映で同じ指図の別ロットへ広げた分は原本を増やさない
  //     ので、ここには出ない。行を増やすと同じ文字列がロット数ぶん並び、未読の赤い数字まで増えてしまう。
  const selfArrivals = useMemo(() => mergeArrivalEntries({ arrivalTimes, contactRequests, now: nowTick })
    .filter(e => e.source === 'self')
    .map(e => ({
      id: `self-${e.lotId}`, _self: true, _docId: e.lotId, _orphan: e.orphan, _finish: e.finish || null, kind: 'arrival',
      to: e.group || '', from: e.by || '',
      orderNo: e.orderNo || '', model: e.model || '',
      _tplName: e.templateName || '',   // 📋 組立が選んだテンプレート名。表の「内容」に品目コードと並べて出す
      message: e.orphan ? '到着予定（元の依頼は削除済み）' : '到着予定（相手が自分から登録）',
      createdAt: e.at || 0, status: 'answered',
      _splits: e.splits || [],   // 分納(何時に何台)。表の「予定日時」に内訳を出す
      items: [{ lotId: e.lotId, orderNo: e.orderNo || '', model: e.model || '', date: e.date || '', time: e.time, by: e.by || '', at: e.at || 0 }],
    })), [arrivalTimes, contactRequests, nowTick]);
  // 🚚 分納の内訳(便)は arrival_times にしか無い。依頼(contact_requests)の行から便を出すために、
  //   ロットID → 便[] の早見表を作って表に渡す。⚠2便以上の物だけ入れる(1便は今までどおり普通の到着予定)。
  const arrivalSplitsByLot = useMemo(() => {
    const m = {};
    (arrivalTimes || []).forEach(a => { if (a && a.id && Array.isArray(a.splits) && a.splits.length > 1) m[a.id] = a.splits; });
    return m;
  }, [arrivalTimes]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...(contactRequests || []).filter(r => r), ...selfArrivals]
      .filter(r => {
        if (kindF === 'all') return true;
        // 🚚分納だけを見る(清水さん「分納用で表も分けた方がいい」)。表そのものは分けず、
        //   同じ総合表を分納の行だけに絞る。
        //   ⚠_splits は自発到着予定の行にしか入らない。依頼への返事で分納になった物は
        //     items[].splitCount(返事した時に書いてある)で見る。ここを見ていなかったので、
        //     依頼経由の分納は「分納だけ」に1件も出ていなかった(2026-08-05)。
        if (kindF === 'split') return (r._splits || []).length > 1
          || (r.items || []).some(i => Number(i?.splitCount || 0) > 1);
        if (kindF === 'arrival') return r.kind === 'arrival' || r.kind === 'finish';
        if (kindF === 'complete') return r.kind === 'complete';
        if (kindF === 'internal') return r.kind === 'internal';
        if (kindF === 'portalmsg') return r.kind === 'portalmsg';
        if (kindF === 'newlot') return r.kind === 'newlot';
        // ⚠ここは受け皿。種類を足したら必ずここからも外す。外し忘れると「修正/呼出」に混ざる。
        return r.kind !== 'arrival' && r.kind !== 'finish' && r.kind !== 'complete' && r.kind !== 'internal' && r.kind !== 'portalmsg' && r.kind !== 'newlot'; // 'repair' = 修正・呼出
      })
      .filter(r => groupF === 'all' || r.to === groupF)
      .filter(r => {
        if (statusF === 'all') return true;
        // ⚠⚠ ここは contactStatusInfo が返す**ラベルの文字そのもの**で振り分けている。
        //   種類を足して新しいラベルを作ったら、必ずここの2行にも足すこと。
        //   足し忘れると「すべて」以外を選んだ瞬間その行が表から消える(=新着に気づけない)。
        //   2026-08-05: 組立から来た連絡(portalmsg)の「連絡あり」「確認済」が両方から漏れていて、
        //   「待ち」で運用している端末には新着が1件も出ていなかった。
        const lbl = contactStatusInfo(r).label;
        // まだこちらが何もしていない側 ⚠'待ち(未登録)'(newlot)は startsWith('待ち') でここに入る
        if (statusF === 'waiting') return lbl.startsWith('待ち') || lbl.startsWith('返信 ') || lbl === '連絡あり';
        // もう片付いた側
        return lbl === '返信あり' || lbl === '対応済み' || lbl === '通知のみ' || lbl === '確認済' || lbl === '登録済';
      })
      .filter(r => !s || [r.orderNo, r.model, r.modelText, r.message, r.to, r.from, ...((r.items || []).map(i => i && i.modelText))].some(v => String(v || '').toLowerCase().includes(s)))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [contactRequests, selfArrivals, kindF, groupF, statusF, q]);
  // 連絡は放っておくと何百件にもなるので、表も既定は2日分で切る。
  //   ⚠隠した件数は必ず出す(黙って切らない)。期間はコンボボックスで広げられる。
  const [listRange, setListRange] = useState(DEFAULT_RANGE_ID);
  const listCut = useMemo(() => filterByRange(list, listRange, nowTick, r => r.createdAt), [list, listRange, nowTick]);
  const listShown = listCut.shown;
  // ==== もらった到着予定と「いつ終わる」の返事 ====
  // 依頼への回答(contact_requests) と 自発登録(arrival_times) を1つの表に束ねる。
  //   ⚠ これが無いと、相手が自分から教えてくれた到着予定に返事をする場所がどこにも無かった
  //     (依頼への回答にしか返信の入口が無かった)。教えてもらっているのに返せない = 一方通行になる。
  //   ⚠ 未返信は期間で切らない。返していないのに古いから消える、では確認しようがない。
  // 組立ポータルを1画面にするか。⚠共通の棚に置く(どちらの検査から変えても同じ)。
  const portalCompactOn = portalLayoutOf(settings) === 'compact';
  const arrEntries = useMemo(() => mergeArrivalEntries({ arrivalTimes, contactRequests, now: nowTick }), [arrivalTimes, contactRequests, nowTick]);
  const arrStats = useMemo(() => arrivalReplyStats(arrEntries), [arrEntries]);
  const [arrRange, setArrRange] = useState(DEFAULT_RANGE_ID);
  const [arrOnlyTodo, setArrOnlyTodo] = useState(false); // 未返信だけ
  const [arrBig, setArrBig] = useState(false);           // 拡大表示(画面いっぱい)
  // ⚠ 到着予定が増えると下の連絡一覧(総合表)が押し出されて見えなくなる、という指摘(清水さん 2026-08-05)。
  //   たたむと一覧が画面いっぱいまで広がる。端末ごとの見た目の好みなので localStorage に覚える。
  const [arrFold, setArrFold] = useState(() => { try { return localStorage.getItem('arrBoardFold') === '1'; } catch (e) { return false; } });
  const toggleArrFold = () => setArrFold(v => { const n = !v; try { localStorage.setItem('arrBoardFold', n ? '1' : '0'); } catch (e) { /* noop */ } return n; });
  // 🚚到着チェックに出す行(便ごと)。⚠分納は便ごとに1行にする(まとめると「9時のぶんだけ着いた」が表せない)
  const arrLotById = useMemo(() => { const m = {}; (lots || []).forEach(l => { if (l && l.id) m[l.id] = l; }); return m; }, [lots]);
  const arrCheckItems = useMemo(
    () => buildArrivalItems({ arrivals: arrivalTimes, splitsOf, lotById: arrLotById, now: nowTick }),
    [arrivalTimes, arrLotById, nowTick]);
  const arrBoard = useMemo(() => {
    const pick = arrEntries.filter(e => groupF === 'all' || e.group === groupF);
    const waiting = pick.filter(e => !e.replied);
    // 「未対応だけ」= 終了予定の返信も 入荷時間の反映も していないもの。
    //   入荷時間を入れて処理が済んでいるものはここに出さない(清水さん 2026-08-05)。
    //   ⚠ 通常表示(下の行)では、返信していないものは反映済みでも期間で切らずに残す。返す機会を消さないため。
    if (arrOnlyTodo) { const todo = pick.filter(e => !e.handled); return { rows: todo, hidden: pick.length - todo.length }; }
    const cut = filterByRange(pick.filter(e => e.replied), arrRange, nowTick, e => e.finish?.at || e.at);
    return { rows: [...waiting, ...cut.shown], hidden: cut.hidden };
  }, [arrEntries, groupF, arrRange, nowTick, arrOnlyTodo]);
  // 到着予定を消す。元の依頼が消えて取り残された分(孤児)を片付けるのが主な用途。
  //   ⚠ arrival_times は docId=lotId。消すとそのロットの🚚バッジも消える(入荷時間は残る)。
  const deleteArrival = (e) => {
    if (!e || !deleteData) return;
    const what = `${e.orderNo || ''} ${e.model || ''}（${String(e.date || '').slice(5).replace('-', '/')} ${e.time}）`;
    if (e.source === 'req') {
      if (!window.confirm(`この到着予定の回答を取り消しますか？
${what}
※依頼は残り、「未回答」に戻ります`)) return;
      const req = (contactRequests || []).find(r => r && r.id === e.reqId);
      // ⚠⚠ 取り消しは **鍵を消さずに「消した」と書く**。消すだけだと重ねが古い items[] に落ちて
      //   移行前の回答が復活する(merge は消したキーを消さない。2026-07-26 の既知の罠)。
      const sv = arrivalAnswerSave(req, e.itemIdx, { date: '', time: '', by: '', at: 0 }, { cleared: true });
      if (req) saveData('contact_requests', req.id, { items: sv.items, itemAnswers: sv.itemAnswers, status: 'waiting' });
      if (e.lotId) deleteData('arrival_times', e.lotId);
      return;
    }
    if (!window.confirm(`この到着予定を削除しますか？
${what}
※検査リストの🚚到着バッジも消えます（入荷時間はそのまま残ります）`)) return;
    deleteData('arrival_times', e.lotId);
  };
  const finishOn = finishReplyEnabled(settings);
  const detail = detailId ? (contactRequests || []).find(r => r.id === detailId) : null;
  const portalUrl = (() => { try { return `${window.location.origin}${window.location.pathname}?renraku=1`; } catch (e) { return '?renraku=1'; } })();
  const portalCfg = settings?.contactPortal || {};
  const [finishDraft, setFinishDraft] = useState({}); // 「いつ終わる？」への回答下書き
  const [showInternal, setShowInternal] = useState(false); // 社内連絡(現場→職長/工長)モーダル
  const internalReqs = useMemo(() => (contactRequests || []).filter(r => r && r.kind === 'internal').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 30), [contactRequests]);
  const sendReq = (payload) => {
    const reqId = newContactId();
    saveData('contact_requests', reqId, payload);
    // 宛先グループの携帯へプッシュ通知(設定済みなら)。失敗しても連絡自体は届いている。
    if (notifyPush) {
      const m = contactPushMessage(payload);
      notifyPush({ toGroup: payload.to, toSide: 'portal', toLevel: payload.toLevel || 'auto', title: m.title, body: m.body, link: `${window.location.origin}/?renraku=1`, tag: `req-${reqId}` });
    }
  };
  // あっちの「いつ終わる？」に検査側が終了予定を回答 → ポータルへ通知
  const answerFinish = (r, idx) => {
    const key = `${r.id}__${idx}`; const dt = finishDraft[key] || {};
    if (!dt.time) return;
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const pat = { date: dt.date || today, time: dt.time, by: currentUserName || '検査', at: Date.now() };
    const sv = arrivalAnswerSave(r, idx, pat, pat);
    saveData('contact_requests', r.id, { items: sv.items, itemAnswers: sv.itemAnswers, status: sv.answered ? 'answered' : 'waiting' });
    setFinishDraft(p => ({ ...p, [key]: {} }));
    const it = sv.items[idx];
    if (notifyPush) notifyPush({ toSide: 'portal', toGroup: r.to, title: `🏁 検査終了予定: ${it.orderNo || ''} → ${it.date ? `${String(it.date).slice(5).replace('-', '/')} ` : ''}${it.time}`, body: `${currentUserName || '検査'} が回答しました`, link: `${window.location.origin}/?renraku=1`, tag: `fina-${r.id}-${idx}` });
  };
  // 社内連絡(現場→検査の職長/工長)を送る。組立ではなく検査側(side:'app')の役職端末へ通知。
  const sendInternal = (payload) => {
    const reqId = newContactId();
    saveData('contact_requests', reqId, payload);
    if (notifyPush) notifyPush({ toSide: 'app', internal: true, title: `🏭 社内: ${payload.topic || ''}（${payload.from || '現場'}）`, body: `${payload.orderNo ? `指図${payload.orderNo}: ` : ''}${payload.message || ''}`.slice(0, 200), link: `${window.location.origin}/`, tag: `int-${reqId}` });
    setShowInternal(false);
  };
  // 社内連絡に「対応します」= 検査側(現場含む全端末)に「△△が対応します」を通知して既読を返す。
  const ackInternal = (r) => {
    saveData('contact_requests', r.id, { status: 'answered', answer: { choice: 'ack', by: currentUserName || '職長', at: Date.now() } });
    if (notifyPush) notifyPush({ toSide: 'app', title: `🏭 ${currentUserName || '職長'} が対応します`, body: `${r.topic || ''} ${String(r.message || '').slice(0, 80)}`, link: `${window.location.origin}/`, tag: `intack-${r.id}` });
  };
  // 連絡カードの会話に検査側からコメント追加 → 相手(組立/社内)へ通知。
  const addComment = (r, text) => {
    if (!r) return;
    const c = { id: contactNewCommentId(), by: currentUserName || '検査', text, at: Date.now(), side: 'app' };
    saveData('contact_requests', r.id, { comments: [...(r.comments || []), c] });
    if (notifyPush) {
      if (r.kind === 'internal') notifyPush({ toSide: 'app', internal: true, title: `💬 ${currentUserName || '検査'}: ${text.slice(0, 40)}`, body: `${r.topic || ''} の会話`, link: `${window.location.origin}/`, tag: `cmt-${c.id}` });
      else notifyPush({ toSide: 'portal', toGroup: r.to, title: `💬 ${currentUserName || '検査'}: ${text.slice(0, 40)}`, body: `${r.orderNo ? `指図${r.orderNo} ` : ''}${contactKindLabel(r)}の会話`, link: `${window.location.origin}/?renraku=1`, tag: `cmt-${c.id}` });
    }
  };
  // 検査が連絡を開いたら「既読」を記録(初回のみ)。相手側に「検査が見ました」と出る。
  useEffect(() => {
    if (!detailId) return;
    const r = (contactRequests || []).find(x => x && x.id === detailId);
    if (r && !r.seenApp) saveData('contact_requests', detailId, { seenApp: { at: Date.now(), by: currentUserName || '検査' } });
  }, [detailId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="h-full flex flex-col gap-3 overflow-y-auto lg:overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 flex-wrap">
        <h2 className="text-lg font-black text-slate-800 flex items-center gap-2"><MessageCircle className="w-5 h-5 text-blue-600" /> 工程連絡</h2>
        <button onClick={() => setShowAsk(true)} className="px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-black flex items-center gap-1.5"><Truck className="w-4 h-4" /> 到着予定を聞く</button>
        <button onClick={() => setShowSend(true)} className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-black flex items-center gap-1.5"><Send className="w-4 h-4" /> 連絡・呼出</button>
        <button onClick={() => setShowInternal(true)} className="px-3 py-1.5 rounded-lg bg-indigo-700 hover:bg-indigo-800 text-white text-sm font-black flex items-center gap-1.5" title="検査の職長・工長へ社内連絡(応援要請・相談・申し送り)">🏭 職長へ(社内)</button>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="検索 (指図/品目コード/内容/宛先)" className="border border-slate-300 rounded-lg pl-8 pr-2 py-1.5 text-sm w-56" />
        </div>
        <div className="flex rounded-lg border border-slate-300 overflow-hidden text-xs font-bold">
          {[['all', 'すべて'], ['waiting', '待ち'], ['answered', '返信あり']].map(([id, lbl]) => (
            <button key={id} onClick={() => setStatusF(id)} className={`px-2.5 py-1.5 ${statusF === id ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>{lbl}</button>
          ))}
        </div>
        <div className="flex rounded-lg border border-slate-300 overflow-hidden text-xs font-bold">
          {/* 🚚分納だけ = 総合表を分納の行だけに絞る(表を分ける代わり。列は増やさない)
              💬組立から連絡 = 組立ポータルの到着予定シートから届いた「ひとこと」だけを見る */}
          {[['all', '全種類'], ['repair', '修正/呼出'], ['arrival', '到着・終了予定'], ['split', '🚚 分納だけ'], ['complete', '検査完了'], ['portalmsg', '組立から連絡'], ['newlot', '🆕 リストに無い品'], ['internal', '社内']].map(([id, lbl]) => (
            <button key={id} onClick={() => setKindF(id)} className={`px-2.5 py-1.5 ${kindF === id ? 'bg-slate-700 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>{lbl}</button>
          ))}
        </div>
        {/* 班しぼり込み: 「この班からは到着予定が来ていない」等を見るため */}
        {groups.length > 1 && (
          <div className="flex rounded-lg border border-slate-300 overflow-hidden text-xs font-bold">
            <button onClick={() => setGroupF('all')} className={`px-2.5 py-1.5 ${groupF === 'all' ? 'bg-slate-700 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>全班</button>
            {groups.map(g => (
              <button key={g} onClick={() => setGroupF(g)} className={`px-2.5 py-1.5 ${groupF === g ? 'bg-slate-700 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>{g}</button>
            ))}
          </div>
        )}
        {/* 期間: 連絡は放っておくと何百件にもなる。既定2日分で切り、隠した件数を出す。 */}
        <div className="flex items-center gap-1.5">
          <select value={listRange} onChange={e => setListRange(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-bold text-slate-600 bg-white">
            {RANGE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          {listCut.hidden > 0 && <span className="fi-tap-text text-slate-400">古い{listCut.hidden}件は非表示</span>}
        </div>
        <button onClick={() => setShowCfg(v => !v)} className={`ml-auto px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1.5 ${showCfg ? 'bg-slate-700 text-white' : 'bg-white border border-slate-300 text-slate-600 hover:bg-slate-50'}`}><Settings className="w-4 h-4" /> 宛先・公開設定</button>
        <button onClick={() => setShowPushHelp(true)} className="px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1.5 bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100"><HelpCircle className="w-4 h-4" /> ヘルプ</button>
      </div>
      {/* 「アプリとして入れる」= 通知に気づかせる唯一の打ち手。連絡タブを開いた瞬間に見える所に置く。
          ⚠設定やヘルプの奥に置くと辿り着けない(実際「ヘルプがどこか分からない」「インストールなんて無い」と言われた)。
          入れ終わった端末では InstallAppButton 側が「✅入っています」に変わるだけなので邪魔にならない。 */}
      {/* ⚠ この案内だけで166px使う。shrink-0 のままだと到着予定と連絡一覧の両方を潰すので、
          場所が足りない時だけ縮んで中でスクロールするようにした(2026-08-05)。広い時は今までどおり全部出る。 */}
      <div className={`min-h-0 max-h-[15vh] overflow-y-auto overscroll-contain bg-white rounded-xl border-2 border-emerald-300 px-3 py-2.5 flex flex-col gap-1.5 ${showCfg ? 'hidden' : ''}`}>
        <div className="text-sm font-black text-emerald-800">⬇️ このアプリを端末に入れる（通知に気づかない人は必ず）</div>
        <div className="fi-tap-text text-slate-500">入れると端末の設定に「このアプリ」の項目が現れ、<b>通知の重要度を「緊急」</b>に上げられます。ブラウザのタブのままだとその設定が存在せず、通知は埋もれたままです。<b>入れた後に重要度を上げるまでが1セット</b>（やり方は右上の「ヘルプ」→<b>⬇️アプリとして入れる</b>）。</div>
        <InstallAppButton compact />
      </div>
      {showCfg && (
        <div ref={cfgBoxRef} className="flex-1 min-h-0 bg-white rounded-xl border border-slate-200 p-3 flex flex-col gap-2 overflow-y-auto overscroll-contain">
          <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-500 flex items-center gap-2">
            <span className="text-lg">👆</span>
            <span>下のカードを<b className="text-slate-700">1枚タップ</b>すると、その中だけ開きます（ほかは自動で閉じます）。ふだんは閉じたままでOK。</span>
          </div>
          {/* 検査完了→次工程(組立)への完了連絡 のON/OFFと宛先 */}
          {(() => { const cc = contactCompleteOf(settings); const mg = Object.entries(cc.modelGroups).filter(([, g]) => g); return (
            <details name="cfgacc" className="shrink-0 group bg-emerald-50/50 border-2 border-emerald-200 rounded-2xl overflow-hidden">
              <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-emerald-50">
                <span className="text-2xl shrink-0">✅</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black text-slate-800">検査完了を{sideLabel}へ連絡</div>
                  <div className="fi-tap-text text-slate-500 truncate">完了時に「どこへ連絡？」を確認して送る</div>
                </div>
                <span className={`shrink-0 fi-tap-text font-black px-2 py-0.5 rounded-full ${cc.enabled ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-500'}`}>{cc.enabled ? 'ON' : 'OFF'}</span>
                <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
              </summary>
            <div className="px-3.5 pb-3.5 pt-1 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-black text-emerald-800">✅ 検査完了を{sideLabel}へ連絡</span>
                <button onClick={() => saveSettings({ contactComplete: { ...(settings?.contactComplete || {}), enabled: !cc.enabled } })} className={`px-2.5 py-1 rounded-full text-xs font-black ${cc.enabled ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{cc.enabled ? 'ON' : 'OFF'}</button>
                <span className="fi-tap-text font-bold text-slate-500">はじめに選ばれる宛先</span>
                <select value={cc.group || (groups[0] || '')} onChange={e => saveSettings({ contactComplete: { ...(settings?.contactComplete || {}), group: e.target.value } })} className="border border-slate-300 rounded-lg px-1.5 py-1 text-xs font-bold">
                  {groups.length === 0 && <option value="">（グループ未設定）</option>}
                  {groups.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div className="fi-tap-text text-slate-500">ロット完了時に「どこに連絡しますか？」の確認が出て、<b>その場で班を選べます</b>（自動送信ではありません）。選んだ班は品目コードごとに覚えます。</div>
              {/* 確認返信(ack)のON/OFF: OFF=お知らせを流すだけ。どちらでも催促(再通知)はしません。 */}
              <div className="flex items-center gap-2 flex-wrap bg-white border border-emerald-200 rounded-lg px-2 py-1.5">
                <span className="text-xs font-bold text-slate-600">相手の「確認しました」返信</span>
                <button onClick={() => saveSettings({ contactComplete: { ...(settings?.contactComplete || {}), ack: !cc.ack } })} className={`px-2.5 py-1 rounded-full text-xs font-black ${cc.ack ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{cc.ack ? '求める' : '求めない（通知だけ）'}</button>
                <span className="fi-tap-text text-slate-400">{cc.ack ? '相手が押すと、こちらに「✅組立が確認」が返ります。' : 'ポータルには確認ボタンが出ず、お知らせだけが並びます。'} どちらでも<b>催促（再通知・上司へのエスカレーション）はしません</b>。</span>
              </div>
              {/* 品目コードごとに覚えた宛先。違っていたらここで直せる(次の完了連絡から反映)。 */}
              {mg.length > 0 && (
                <details className="bg-white border border-emerald-200 rounded-lg">
                  <summary className="px-2 py-1.5 text-xs font-black text-slate-600 cursor-pointer select-none">📌 品目コードごとに覚えた連絡先（{mg.length}件）— 違っていたらここで直せます</summary>
                  <div className="p-2 flex flex-col gap-1 max-h-56 overflow-y-auto">
                    {mg.sort((a, b) => a[0].localeCompare(b[0])).map(([model, g]) => (
                      <div key={model} className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-slate-700 w-32 shrink-0 truncate" title={model}>{model}</span>
                        <select value={groups.includes(g) ? g : ''} onChange={e => saveSettings({ contactComplete: { ...(settings?.contactComplete || {}), modelGroups: { ...cc.modelGroups, [model]: e.target.value } } })} className="border border-slate-300 rounded-lg px-1.5 py-1 text-xs font-bold">
                          <option value="">（覚えない）</option>
                          {groups.map(x => <option key={x} value={x}>{x}</option>)}
                        </select>
                        {!groups.includes(g) && <span className="fi-tap-text font-bold text-rose-600">班「{g}」は今ありません</span>}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
            </details>
          ); })()}
          {/* 到着予定 → 入荷時間への自動反映 */}
          {(() => { const ca = contactArrivalOf(settings); return (
            <details name="cfgacc" className="shrink-0 group bg-teal-50/50 border-2 border-teal-200 rounded-2xl overflow-hidden">
              <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-teal-50">
                <span className="text-2xl shrink-0">🚚</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black text-slate-800">到着予定を入荷時間に入れる</div>
                  <div className="fi-tap-text text-slate-500 truncate">{sideLabel}の到着予定を、そのロットの入荷時間に自動セット</div>
                </div>
                <span className={`shrink-0 fi-tap-text font-black px-2 py-0.5 rounded-full ${ca.autoEntry ? 'bg-teal-500 text-white' : 'bg-slate-200 text-slate-500'}`}>{ca.autoEntry ? 'ON' : 'OFF'}</span>
                <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
              </summary>
              <div className="px-3.5 pb-3.5 pt-1 flex items-center gap-2 flex-wrap">
                <button onClick={() => saveSettings({ contactArrival: { ...(settings?.contactArrival || {}), autoEntry: !ca.autoEntry } })} className={`px-3 py-1.5 rounded-full text-xs font-black ${ca.autoEntry ? 'bg-teal-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{ca.autoEntry ? 'ON（自動で入れる）' : 'OFF（入れない）'}</button>
                <span className="fi-tap-text text-slate-500 w-full">{sideLabel}が登録・回答した到着予定が、そのロットの<b>入荷時間</b>に入ります（検査リストのカード・作業予定・リードタイム集計がこの値を見ます）。<b>後から手で直した入荷時間を上書きし返すことはありません</b>。同じ指図でテンプレが分かれている時は、今までどおり「検査リストへ反映」で選んでください。</span>
                {/* 終了予定の返信 ON/OFF。OFFにすると返信ボタンが消え、ポータルの「返事待ち」表示も出なくなる
                    (返す気が無いのに相手を待たせる表示だけ残る、を作らない)。 */}
                <div className="w-full border-t border-teal-200 pt-2 mt-1 flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-black text-slate-700">🏁 「いつ終わるか」を返信する</span>
                  <button onClick={() => saveSettings({ contactArrival: { ...(settings?.contactArrival || {}), finishReply: !finishReplyEnabled(settings) } })} className={`px-3 py-1.5 rounded-full text-xs font-black ${finishReplyEnabled(settings) ? 'bg-teal-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{finishReplyEnabled(settings) ? 'ON（返信する）' : 'OFF（返信しない）'}</button>
                  <span className="fi-tap-text text-slate-500 w-full">ONにすると、もらった到着予定に<b>検査の終了予定を返せます</b>（到着時刻＋見積時間から自動計算・休憩や定時は避けて計算します）。返した内容は{sideLabel}のポータルに出ます。OFFの時は返信ボタンを出さず、相手側にも「返事待ち」を表示しません。</span>
                </div>
                {/* 簡易選択の時刻(ポータルの「到着予定を登録」で1タップで選べる候補)。 */}
                <div className="w-full border-t border-teal-200 pt-2 mt-1 flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-black text-slate-700">⏱ 簡易選択の時刻</span>
                  <input
                    value={(settings?.contactArrival?.quickTimes || DEFAULT_QUICK_TIMES).join(', ')}
                    onChange={e => saveSettings({ contactArrival: { ...(settings?.contactArrival || {}), quickTimes: e.target.value.split(',').map(x => x.trim()).filter(Boolean) } })}
                    placeholder="10:00, 12:00, 15:00, 17:00"
                    className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-mono w-64" />
                  <span className="fi-tap-text text-slate-500 w-full">ポータルの「到着予定を登録」で<b>1タップで選べる時刻</b>です（最大8個）。形が違う値は無視して既定（10:00, 12:00, 15:00, 17:00）に戻ります。日付は「本日・明日・あさって」が自動で出ます。</span>
                </div>
              </div>
            </details>
          ); })()}
          {/* 相手に見せる「検査の今」 */}
          {(() => { const wsOn = workStatusEnabled(settings); const nameOn = workStatusShowName(settings); const patch = (p) => saveSettings({ contactPortal: { ...(settings?.contactPortal || {}), ...p } }); return (
            <details name="cfgacc" className="shrink-0 group bg-blue-50/50 border-2 border-blue-200 rounded-2xl overflow-hidden">
              <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-blue-50">
                <span className="text-2xl shrink-0">👀</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black text-slate-800">検査の今を{sideLabel}に見せる</div>
                  <div className="fi-tap-text text-slate-500 truncate">誰が何をしていて、いつ終わりそうかをポータルに出す</div>
                </div>
                <span className={`shrink-0 fi-tap-text font-black px-2 py-0.5 rounded-full ${wsOn ? 'bg-blue-500 text-white' : 'bg-slate-200 text-slate-500'}`}>{wsOn ? 'ON' : 'OFF'}</span>
                <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
              </summary>
              <div className="px-3.5 pb-3.5 pt-1 flex items-center gap-2 flex-wrap">
                <button onClick={() => patch({ showWorkStatus: !wsOn })} className={`px-3 py-1.5 rounded-full text-xs font-black ${wsOn ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{wsOn ? 'ON（見せる）' : 'OFF（見せない）'}</button>
                <button onClick={() => patch({ showWorkerName: !nameOn })} disabled={!wsOn} className={`px-3 py-1.5 rounded-full text-xs font-black disabled:opacity-40 ${nameOn ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{nameOn ? '担当者名を出す' : '担当者名は伏せる'}</button>
                <span className="fi-tap-text text-slate-500 w-full">ポータルに<b>指図・品目コード・台数・開始時間・予想終了時間</b>を出します。相手が段取りを組めるようになります。表は<b>相手が「更新」を押した時だけ</b>作り直します（勝手に動いて読めなくならないように）。まだ始めていないロットも、<b>到着予定をもらっていれば</b>そこから終了予定を計算して出します。</span>
              </div>
            </details>
          ); })()}
          {/* 定時おうかがい(自動送信) + 自動お礼 */}
          {(() => {
            const aa = contactAutoAskOf(settings);
            const th = contactThanksOf(settings);
            const patch = (p) => saveSettings({ contactArrival: { ...(settings?.contactArrival || {}), ...p } });
            const DOW = [['日', 0], ['月', 1], ['火', 2], ['水', 3], ['木', 4], ['金', 5], ['土', 6]];
            return (
              <details name="cfgacc" className="shrink-0 group bg-teal-50/40 border-2 border-teal-200 rounded-2xl overflow-hidden">
                <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-teal-50">
                  <span className="text-2xl shrink-0">⏰</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-black text-slate-800">決まった時刻に「到着予定」を自動で聞く</div>
                    <div className="fi-tap-text text-slate-500 truncate">毎日の時刻に自動送信＋返信に自動お礼</div>
                  </div>
                  <span className={`shrink-0 fi-tap-text font-black px-2 py-0.5 rounded-full ${aa.on ? 'bg-teal-500 text-white' : 'bg-slate-200 text-slate-500'}`}>{aa.on ? 'ON' : 'OFF'}</span>
                  <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
                </summary>
                <div className="px-3.5 pb-3.5 pt-1 flex flex-col gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-black text-teal-800">⏰ 決まった時刻に「到着予定」を自動で聞く</span>
                  <button onClick={() => patch({ autoAsk: { ...(settings?.contactArrival?.autoAsk || {}), on: !aa.on } })} className={`px-2.5 py-1 rounded-full text-xs font-black ${aa.on ? 'bg-teal-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{aa.on ? 'ON' : 'OFF'}</button>
                </div>
                {aa.on && (
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <span className="font-bold text-slate-600">毎日</span>
                    <input type="time" value={aa.time} onChange={e => patch({ autoAsk: { ...(settings?.contactArrival?.autoAsk || {}), time: e.target.value } })} className="border border-slate-300 rounded-lg px-2 py-1 font-black" />
                    <span className="font-bold text-slate-600">に</span>
                    <div className="flex items-center gap-1">
                      {DOW.map(([label, d]) => (
                        <button key={d} onClick={() => { const cur = aa.days.includes(d) ? aa.days.filter(x => x !== d) : [...aa.days, d].sort(); patch({ autoAsk: { ...(settings?.contactArrival?.autoAsk || {}), days: cur.length ? cur : [d] } }); }}
                          className={`w-7 h-7 rounded-full font-black ${aa.days.includes(d) ? 'bg-teal-600 text-white' : 'bg-white border border-slate-300 text-slate-400'}`}>{label}</button>
                      ))}
                    </div>
                    <span className="font-bold text-slate-600 ml-2">入荷予定</span>
                    <input type="number" min="1" max="14" value={aa.lookaheadDays} onChange={e => patch({ autoAsk: { ...(settings?.contactArrival?.autoAsk || {}), lookaheadDays: Number(e.target.value) } })} className="border border-slate-300 rounded-lg px-2 py-1 w-16 font-black" />
                    <span className="font-bold text-slate-600">日先まで</span>
                  </div>
                )}
                <div className="fi-tap-text text-slate-500">
                  {aa.on
                    ? <>まだ到着予定をもらっていない指図を<b>班ごとに1件にまとめて</b>自動で聞きます（品目コードごとに覚えた班へ。入荷日が未定の指図も含みます）。同じ指図を二度聞くことはありません。ポータルでは「定期」と表示されます。</>
                    : <>OFFの間は、今までどおり「到着予定を聞く」を押した時だけ送られます。</>}
                </div>
                <div className="border-t border-teal-200 pt-2 flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-black text-teal-800">🙏 返信をもらったら自動でお礼</span>
                  <button onClick={() => patch({ thanks: { ...(settings?.contactArrival?.thanks || {}), on: !th.on } })} className={`px-2.5 py-1 rounded-full text-xs font-black ${th.on ? 'bg-teal-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{th.on ? 'ON' : 'OFF'}</button>
                  {th.on && <input value={th.text} onChange={e => patch({ thanks: { ...(settings?.contactArrival?.thanks || {}), text: e.target.value } })} className="border border-slate-300 rounded-lg px-2 py-1 text-xs font-bold flex-1 min-w-[16ch]" placeholder={DEFAULT_CONTACT_THANKS} />}
                  <span className="fi-tap-text text-slate-500 w-full">到着予定の回答が届いたら、この一言を相手のポータルに1回だけ出します。<b>相手の携帯は鳴りません</b>（お礼で鳴らすと、本当に急ぎの修正依頼や呼出が埋もれるため）。</span>
                </div>
                </div>
              </details>
            );
          })()}
          {/* 🔔 連絡の知らせ方 — 音/画面/アラーム/OS通知を、子どもでも分かるカード式に。
              既定はスイッチだけ見えて、数字は「くわしく設定」を開いた時だけ出す(=普段はごちゃごちゃしない)。 */}
          {(() => {
            const soundOn = contactSoundOn(settings);
            const sc = contactSoundCfg(settings);
            const tc = contactToastCfg(settings);
            const kc = contactTickerCfg(settings);
            const a = contactAlarmCfg(settings);
            const os = contactOsNotifyCfg(settings);
            const setSC = (patch) => saveSettings({ contactSound: { ...(settings?.contactSound || {}), ...patch } });
            const setTC = (patch) => saveSettings({ contactToast: { ...(settings?.contactToast || {}), ...patch } });
            const setKC = (patch) => saveSettings({ contactTicker: { ...(settings?.contactTicker || {}), ...patch } });
            const setA = (patch) => saveSettings({ contactAlarm: { ...(settings?.contactAlarm || {}), ...patch } });
            const setOs = (patch) => saveSettings({ contactOsNotify: { ...(settings?.contactOsNotify || {}), ...patch } });
            const num = (v, def = 0) => { const n = Number(v); return (isFinite(n) && n >= 0) ? n : def; };
            const soundTypes = Array.isArray(sc.types) ? sc.types : CONTACT_SOUND_DEFAULTS.types;
            // ⚠🆕 newlot(検査リストに無い品の連絡)の行が無いと、既に音の設定を保存してある端末では
            //   既定に足しても届かず、いつまでも鳴らない。使う人が自分でチェックを入れられるようにする。
            const TYPE_LABELS = [['answer', '返信'], ['no', '行けない'], ['internal', '社内連絡'], ['portalmsg', '組立から連絡'], ['newlot', 'リストに無い品'], ['finish', 'いつ終わる?'], ['arrival', '到着回答'], ['comment', '会話']];
            const toggleType = (t) => setSC({ types: soundTypes.includes(t) ? soundTypes.filter(x => x !== t) : [...soundTypes, t] });
            const toastWords = contactToastWords(tc);
            const trigs = contactAlarmTriggers(a);
            const COMMON_TRIGGERS = ['修正依頼', '呼出', '社内連絡', '行けない', '至急', '再通知', 'いつ終わ', '到着予定', '返信', 'CC'];
            const toggleTrig = (w) => setA({ triggers: trigs.includes(w) ? trigs.filter(x => x !== w) : [...trigs, w] });
            const Sw = ({ on, onClick, color = 'emerald' }) => (
              <button onClick={onClick} className={`shrink-0 w-[52px] h-[30px] rounded-full relative transition-colors ${on ? (color === 'rose' ? 'bg-rose-500' : 'bg-emerald-500') : 'bg-slate-300'}`} title={on ? 'ON' : 'OFF'}>
                <span className={`absolute top-[3px] left-[3px] w-6 h-6 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[22px]' : ''}`} />
              </button>
            );
            const Num = ({ label, value, onCommit, suffix, min = 0, step = 1, width = 'w-16' }) => (
              <label className="text-xs font-bold text-slate-600 flex items-center gap-1">{label}
                <input type="number" min={min} step={step} defaultValue={value} onBlur={e => onCommit(num(e.target.value, value))} className={`${width} border border-slate-300 rounded-lg px-1.5 py-1 text-center`} />{suffix}
              </label>
            );
            const Chip = ({ on, onClick, children, color = 'slate' }) => (
              <button onClick={onClick} className={`px-2.5 py-1 rounded-full text-xs font-black border transition-colors ${on ? (color === 'rose' ? 'bg-rose-500 border-rose-600 text-white' : 'bg-amber-500 border-amber-600 text-white') : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50'}`}>{children}</button>
            );
            const More = ({ children }) => (
              <details className="mt-1 group">
                <summary className="cursor-pointer select-none text-xs font-black text-slate-400 hover:text-slate-600 list-none flex items-center gap-1"><span className="inline-block transition-transform group-open:rotate-90">▶</span> くわしく設定</summary>
                <div className="mt-2 flex flex-col gap-2 pl-1">{children}</div>
              </details>
            );
            return (
              <details name="cfgacc" className="shrink-0 group bg-sky-50/40 border-2 border-sky-200 rounded-2xl overflow-hidden">
                <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-sky-50">
                  <span className="text-2xl shrink-0">🔔</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-black text-slate-800">連絡の知らせ方（音・画面・アラーム）</div>
                    <div className="fi-tap-text text-slate-500 truncate">来たときの鳴らし方。検査画面と{sideLabel}ポータルの両方に効きます</div>
                  </div>
                  <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
                </summary>
                <div className="px-3 pb-3.5 pt-1 flex flex-col gap-2.5">
                <div className="rounded-xl bg-sky-50 border border-sky-200 px-3 py-2 text-xs text-slate-600 leading-relaxed">
                  この鳴らし方は<b className="text-sky-700">この検査の画面</b>と<b className="text-sky-700">{sideLabel}ポータル</b>の<b>両方</b>に効きます。{sideLabel}の人は自分で設定できないので、<b>ここで決めてあげてください</b>。
                </div>

                <div className="rounded-2xl border-2 border-amber-200 bg-amber-50/60 p-3 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl">🔊</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-black text-slate-800">音で知らせる</div>
                      <div className="fi-tap-text text-slate-500">連絡が来たら「ピッ」と鳴らします。</div>
                    </div>
                    {soundOn && (audioOk
                      ? <button onClick={() => contactBeep(sc.count, sc.freq, sc.volume)} className="px-2.5 py-1.5 rounded-xl text-xs font-black bg-white border border-amber-300 text-amber-800 hover:bg-amber-100 shrink-0">🔊 試す</button>
                      : <button onClick={() => { contactUnlockAudio(); setTimeout(() => { contactBeep(sc.count, sc.freq, sc.volume); setAudioOk(contactAudioReady()); }, 150); }} className="px-2.5 py-1.5 rounded-xl text-xs font-black bg-rose-600 text-white animate-pulse shrink-0">🔊 音を有効にする</button>)}
                    <Sw on={soundOn} onClick={() => saveSettings({ contactSound: { ...(settings?.contactSound || {}), enabled: !soundOn } })} />
                  </div>
                  {soundOn && (
                    <More>
                      <div className="flex flex-wrap gap-1.5 items-center">
                        <span className="fi-tap-text font-bold text-slate-500 w-full">どの連絡で鳴らす？</span>
                        {TYPE_LABELS.map(([t, lbl]) => <Chip key={t} on={soundTypes.includes(t)} onClick={() => toggleType(t)}>{lbl}</Chip>)}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Num label="回数" value={sc.count} onCommit={v => setSC({ count: Math.max(1, v) })} suffix="回" width="w-14" min={1} />
                        <Num label="高さ" value={sc.freq} onCommit={v => setSC({ freq: Math.max(50, v) })} suffix="Hz" width="w-20" min={50} />
                        <label className="text-xs font-bold text-slate-600 flex items-center gap-1">音量<input type="range" min="0" max="1" step="0.05" defaultValue={sc.volume} onChange={e => setSC({ volume: num(e.target.value, sc.volume) })} className="w-24 accent-amber-500" /></label>
                      </div>
                    </More>
                  )}
                </div>

                <div className="rounded-2xl border-2 border-slate-200 bg-white p-3 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl">💬</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-black text-slate-800">画面に出す</div>
                      <div className="fi-tap-text text-slate-500">お知らせが{(tc.position || 'br') === 'top' ? '画面の上' : '画面の右下'}に出ます。左下にも未読が並びます。<span className="text-slate-400">（これは常に出ます）</span></div>
                    </div>
                  </div>
                  <More>
                    {/* 出す場所・消え方。⚠自動で消えると「気づかないうちに消えた」が起きるので既定は押すまで残す */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="fi-tap-text font-bold text-slate-500">出す場所</span>
                      {[['br', '右下'], ['top', '上の真ん中']].map(([id, lbl]) => (
                        <button key={id} onClick={() => setTC({ position: id })}
                          className={`px-3 py-1.5 rounded-full fi-tap-text font-black border ${(tc.position || 'br') === id ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-300'}`}>{lbl}</button>
                      ))}
                    </div>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input type="checkbox" checked={tc.stayUntilClick !== false} onChange={e => setTC({ stayUntilClick: e.target.checked })} className="w-4 h-4 accent-slate-700 mt-0.5" />
                      <span className="fi-tap-text text-slate-600"><b>押すまで消さない</b>（おすすめ）。OFFにすると、大事な言葉が入っていないお知らせは下の秒数で勝手に消えます。</span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input type="checkbox" checked={tc.blinkTitle !== false} onChange={e => setTC({ blinkTitle: e.target.checked })} className="w-4 h-4 accent-slate-700 mt-0.5" />
                      <span className="fi-tap-text text-slate-600"><b>ほかの画面を見ている時、ウィンドウの題名を点滅させる</b>。※タスクバーのアイコン自体を点滅させることはWebアプリからはできません（アイコンに出せるのは数字のバッジまで）。</span>
                    </label>
                    <div className="flex flex-col gap-1">
                      <span className="fi-tap-text font-bold text-slate-500">大事な言葉（含むと自動で消えず残る）</span>
                      <div className="flex flex-wrap gap-1">
                        {toastWords.map(w => (
                          <span key={w} className="inline-flex items-center gap-1 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5 fi-tap-text font-bold text-rose-700">{w}<button onClick={() => setTC({ urgentWords: toastWords.filter(x => x !== w) })} className="text-rose-400 hover:text-rose-700"><X className="w-3 h-3" /></button></span>
                        ))}
                        <input placeholder="言葉を追加+Enter" onKeyDown={e => { if (e.key === 'Enter') { const v = e.target.value.trim(); if (v && !toastWords.includes(v)) setTC({ urgentWords: [...toastWords, v] }); e.target.value = ''; } }} className="border border-slate-300 rounded-lg px-2 py-0.5 fi-tap-text w-28" />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Num label="大事以外が消えるまで" value={tc.autoHideSec} onCommit={v => setTC({ autoHideSec: Math.max(1, v) })} suffix="秒" width="w-14" min={1} />
                      <Num label="同時に出す最大" value={tc.maxStack} onCommit={v => setTC({ maxStack: Math.max(1, v) })} suffix="件" width="w-14" min={1} />
                      <Num label="左下の一覧" value={kc.maxShown} onCommit={v => setKC({ maxShown: Math.max(1, v) })} suffix="件" width="w-14" min={1} />
                    </div>
                  </More>
                </div>

                <div className="rounded-2xl border-2 border-rose-200 bg-rose-50/60 p-3 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl">🚨</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-black text-slate-800">確認するまで鳴らし続ける</div>
                      <div className="fi-tap-text text-slate-500">大事な連絡は、確認を押すまで<b>音・振動・画面</b>で鳴らし続けます（携帯のアラームみたいに）。</div>
                    </div>
                    {a.enabled && <button onClick={() => { contactUnlockAudio(); setTimeout(() => contactAlarmRing({ ...a, vibrate: true }), 120); }} className="px-2.5 py-1.5 rounded-xl text-xs font-black bg-white border border-rose-300 text-rose-700 hover:bg-rose-100 shrink-0">🔊 試す</button>}
                    <Sw on={a.enabled} color="rose" onClick={() => setA({ enabled: !a.enabled })} />
                  </div>
                  {a.enabled && (
                    <More>
                      <div className="fi-tap-text text-slate-500 bg-white rounded-lg border border-rose-100 px-2.5 py-1.5">アプリを開いている間だけ。<b>秒数・回数に上限なし</b>（0＝無制限＝触るまで）。</div>
                      <div className="flex flex-col gap-1">
                        <span className="fi-tap-text font-bold text-slate-500">何で鳴らす？（この言葉を含む連絡だけ）</span>
                        <div className="flex flex-wrap gap-1.5">{COMMON_TRIGGERS.map(w => <Chip key={w} on={trigs.includes(w)} onClick={() => toggleTrig(w)} color="rose">{w}</Chip>)}</div>
                        <div className="flex items-center gap-1.5"><input placeholder="言葉を追加（例: クレーム）+Enter" onKeyDown={e => { if (e.key === 'Enter') { const v = e.target.value.trim(); if (v && !trigs.includes(v)) setA({ triggers: [...trigs, v] }); e.target.value = ''; } }} className="flex-1 border border-slate-300 rounded-lg px-2 py-1 text-xs" /></div>
                        {trigs.some(w => !COMMON_TRIGGERS.includes(w)) && <div className="flex flex-wrap gap-1">{trigs.filter(w => !COMMON_TRIGGERS.includes(w)).map(w => <span key={w} className="inline-flex items-center gap-1 bg-slate-100 border border-slate-300 rounded-full px-2 py-0.5 fi-tap-text font-bold text-slate-700">{w}<button onClick={() => toggleTrig(w)} className="text-slate-400 hover:text-rose-600"><X className="w-3 h-3" /></button></span>)}</div>}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-1.5"><span className="text-xs font-black text-slate-700">🔊 音</span><Sw on={a.sound} onClick={() => setA({ sound: !a.sound })} /></div>
                        {a.sound && <><Num label="高さ" value={a.freq} onCommit={v => setA({ freq: v })} suffix="Hz" width="w-20" /><Num label="回数" value={a.toneCount} onCommit={v => setA({ toneCount: v })} suffix="ピッ" width="w-14" /><label className="text-xs font-bold text-slate-600 flex items-center gap-1">音量<input type="range" min="0" max="1" step="0.05" defaultValue={a.volume} onChange={e => setA({ volume: num(e.target.value, a.volume) })} className="w-24 accent-rose-600" /></label></>}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Num label="間隔" value={a.intervalSec} onCommit={v => setA({ intervalSec: v })} suffix="秒ごと" step="0.5" min={0.2} width="w-16" />
                        <Num label="最大" value={a.maxSec} onCommit={v => setA({ maxSec: v })} suffix="秒で停止(0=無制限)" width="w-16" />
                        <Num label="最大" value={a.maxCount} onCommit={v => setA({ maxCount: v })} suffix="回で停止(0=無制限)" width="w-16" />
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-1.5"><span className="text-xs font-black text-slate-700">📳 振動</span><Sw on={a.vibrate} onClick={() => setA({ vibrate: !a.vibrate })} /></div>
                        {a.vibrate && <label className="text-xs font-bold text-slate-600 flex items-center gap-1">パターン(ms)<input defaultValue={a.vibratePattern} onBlur={e => setA({ vibratePattern: e.target.value.trim() || '400,150,400' })} placeholder="400,150,400" className="w-32 border border-slate-300 rounded-lg px-1.5 py-1 text-center" /></label>}
                        <div className="flex items-center gap-1.5"><span className="text-xs font-black text-slate-700">💡 画面点滅</span><Sw on={a.flash} onClick={() => setA({ flash: !a.flash })} /></div>
                        {a.flash && <input type="color" defaultValue={a.flashColor} onChange={e => setA({ flashColor: e.target.value })} className="w-10 h-7 rounded border border-slate-300" />}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1.5"><span className="text-xs font-black text-slate-700">🌙 夜は鳴らさない</span><Sw on={a.quietEnabled} onClick={() => setA({ quietEnabled: !a.quietEnabled })} /></div>
                        {a.quietEnabled && <label className="text-xs font-bold text-slate-600 flex items-center gap-1"><input type="time" defaultValue={a.quietFrom} onChange={e => setA({ quietFrom: e.target.value })} className="border border-slate-300 rounded px-1 py-0.5" /> 〜 <input type="time" defaultValue={a.quietTo} onChange={e => setA({ quietTo: e.target.value })} className="border border-slate-300 rounded px-1 py-0.5" /></label>}
                      </div>
                    </More>
                  )}
                </div>

                <div className="rounded-2xl border-2 border-indigo-200 bg-indigo-50/50 p-3 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl">📴</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-black text-slate-800">アプリを閉じてる時の通知</div>
                      <div className="fi-tap-text text-slate-500">通知が<b>触るまで消えない</b>ようにします。</div>
                    </div>
                    <Sw on={os.requireInteraction !== false} onClick={() => setOs({ requireInteraction: os.requireInteraction === false })} />
                  </div>
                  <More>
                    <label className="text-xs font-bold text-slate-600 flex items-center gap-1">通知の振動(ms)<input defaultValue={os.vibratePattern} onBlur={e => setOs({ vibratePattern: e.target.value.trim() })} placeholder="400,150,400" className="w-32 border border-slate-300 rounded-lg px-1.5 py-1 text-center" /></label>
                    <div className="fi-tap-text text-slate-400">閉じている時は「鳴らし続ける」はできません（OSの仕様）。代わりに通知を残す＋再通知（下の「通知のルール」）で気づかせます。iPhone等は振動指定が無視されます。ロック画面を点けるには、端末に<b>アプリを入れて重要度を「緊急」</b>に（右上ヘルプ参照）。</div>
                  </More>
                </div>
                </div>
              </details>
            );
          })()}
          {/* 品目コードの仕分け(ポータルの「しぼる」ボタン) — その他に落ちた頭文字をワンタップで振り分ける */}
          {(() => {
            const fams = portalModelFamiliesOf(settings);
            const pmap = portalModelPrefixMapOf(settings);
            const counts = {}; const pgroup = {};
            (lots || []).filter(l => l && l.status !== 'completed').forEach(l => {
              const pre = portalModelPrefix(l.model) || PORTAL_NO_PREFIX;
              counts[pre] = (counts[pre] || 0) + 1;
              pgroup[pre] = portalModelGroupOf(l.model, fams, pmap);
            });
            const prefixes = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
            if (!prefixes.length) return null;
            const others = prefixes.filter(x => pgroup[x] === 'other' && x !== PORTAL_NO_PREFIX);
            const move = (pre, gid) => (saveShared || saveSettings)({ portalModelPrefixMap: portalModelPrefixMapWith(settings, pre, gid) });
            return (
              <details name="cfgacc" className="shrink-0 group bg-violet-50/50 border-2 border-violet-200 rounded-2xl overflow-hidden">
                <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-violet-50">
                  <span className="text-2xl shrink-0">🔎</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-black text-slate-800">品目コードの仕分け（ポータルの「しぼる」）</div>
                    <div className="fi-tap-text text-slate-500 truncate">{others.length > 0 ? <span className="text-rose-600 font-bold">その他に {others.length}種類（{others.slice(0, 4).join('・')}{others.length > 4 ? '…' : ''}）— 振り分けて</span> : '特注機／標準機に振り分け（済み）'}</div>
                  </div>
                  {others.length > 0 && <span className="shrink-0 w-2.5 h-2.5 rounded-full bg-rose-500" title="振り分け待ちあり" />}
                  <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
                </summary>
                <div className="p-3 flex flex-col gap-1.5">
                  <div className="fi-tap-text text-slate-500">
                    いま検査リストに並んでいる品目コードの頭文字です。<b>特注機・標準機のどちらでもない頭文字は「その他」に置いてあります</b>（勝手に決めていません）。
                    押すと仕分けが変わり、{sideLabel}のポータルの「しぼる」ボタンに反映されます。<span className="font-bold text-teal-700">🔗 製品検査・最終検査の共通</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
                    {prefixes.map(pre => {
                      const cur = pgroup[pre];
                      return (
                        <div key={pre} className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg px-2 py-1.5">
                          <span className="font-black text-sm text-slate-800 w-24 shrink-0 truncate" title={pre}>{pre}</span>
                          <span className="fi-tap-text text-slate-400 w-12 shrink-0">{counts[pre]}件</span>
                          {pre === PORTAL_NO_PREFIX
                            ? <span className="fi-tap-text text-slate-400">英字で始まらない品名（仕分けできません・その他に出ます）</span>
                            : [...fams.map(g => [g.id, g.label]), ['other', 'その他']].map(([gid, label]) => (
                              <button key={gid} onClick={() => move(pre, gid)}
                                className={`px-2.5 py-1 rounded-lg text-xs font-black border ${cur === gid ? 'bg-slate-700 border-slate-800 text-white' : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50'}`}>{label}</button>
                            ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </details>
            );
          })()}
          {/* ⓪ 組立ポータルの見た目(1画面にするか)。⚠既定は今まで通り。 */}
          <details name="cfgacc" className="shrink-0 group bg-slate-50 border-2 border-slate-200 rounded-2xl overflow-hidden">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-slate-100">
              <span className="text-2xl shrink-0">🗂️</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-slate-800">組立ポータルの見た目</div>
                <div className="fi-tap-text text-slate-500 truncate">{portalCompactOn ? '1画面（タブで切り替え・帯と案内は畳む）' : '今まで通り（ヘッダー＋流れの帯＋アプリの入れ方）'}</div>
              </div>
              <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="p-3 flex flex-col gap-2">
              <div className="fi-tap-text text-slate-500 leading-relaxed">
                組立の人が開く連絡ポータル（1画面に <b>製品検査</b> と <b>最終検査</b> の2つのタブ）の見た目です。
                <b>1画面</b>にすると、上の「流れの帯」と「アプリの入れ方の案内」を畳んで、連絡の一覧をできるだけ広く出します。
                リストは今まで通り<b>それぞれ別</b>です（製品検査は製品検査だけ、最終検査は最終検査だけ）。混ざりません。
                <span className="ml-1 font-bold text-teal-700">🔗 製品検査・最終検査の共通</span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button onClick={() => (saveShared || saveSettings)({ portalCompact: false })}
                  className={`px-3 py-2 rounded-lg text-sm font-black border-2 ${!portalCompactOn ? 'bg-slate-700 border-slate-800 text-white' : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50'}`}>
                  今まで通り
                </button>
                <button onClick={() => (saveShared || saveSettings)({ portalCompact: true })}
                  className={`px-3 py-2 rounded-lg text-sm font-black border-2 ${portalCompactOn ? 'bg-blue-600 border-blue-700 text-white' : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50'}`}>
                  1画面にする
                </button>
              </div>
              <div className="fi-tap-text text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                切り替えると<b>組立の人の画面が変わります</b>。相手に一言かけてから変えてください（元に戻すのはここで「今まで通り」を押すだけです）。
              </div>
            </div>
          </details>
          {/* ① グループとメンバー */}
          <details name="cfgacc" className="shrink-0 group bg-blue-50/40 border-2 border-blue-200 rounded-2xl overflow-hidden">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-blue-50">
              <span className="text-2xl shrink-0">👥</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-slate-800">宛先グループと班メンバー</div>
                <div className="fi-tap-text text-slate-500 truncate">{groups.length}班：{groups.slice(0, 3).join('・')}{groups.length > 3 ? '…' : ''}</div>
              </div>
              <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="p-3 flex flex-col gap-3">
              <div>
                <div className="text-xs font-black text-slate-500 mb-1">宛先グループ（相手側もこの名前でポータルに入ります）<span className="ml-1 font-bold text-teal-700">🔗 製品検査・最終検査の共通</span></div>
                <div className="fi-tap-text text-slate-400 mb-1">組立の班はどちらの検査でも同じ相手なので、ここは<b>2つのアプリで1つ</b>です。ここで直すと最終検査側にもそのまま反映されます。</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {groups.map(g => (
                    <span key={g} className="inline-flex items-center gap-1 bg-slate-100 border border-slate-300 rounded-full px-2.5 py-1 text-xs font-bold text-slate-700">
                      {g}
                      <button onClick={() => { if (!window.confirm(`宛先「${g}」を削除しますか？（製品検査・最終検査の両方から消えます）`)) return; (saveShared || saveSettings)({ contactGroups: groups.filter(x => x !== g) }); }} className="text-slate-400 hover:text-rose-600"><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                  <input value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder="グループ追加" className="border border-slate-300 rounded-lg px-2 py-1 text-xs w-28" />
                  <button disabled={!newGroup.trim() || groups.includes(newGroup.trim())} onClick={() => { (saveShared || saveSettings)({ contactGroups: [...groups, newGroup.trim()] }); setNewGroup(''); }} className="px-2 py-1 rounded-lg bg-blue-600 text-white text-xs font-bold disabled:opacity-40">追加</button>
                </div>
              </div>
              <div>
                <div className="text-xs font-black text-slate-500 mb-1">班のメンバー（カンマ区切り — 送信時に「宛先の人」として指名でき、通知・ポータルに「→○○さん」と出ます）</div>
                <div className="flex flex-col gap-1">
                  {groups.map(g => (
                    <div key={g} className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-slate-600 w-20 shrink-0 truncate">{g}</span>
                      <input
                        defaultValue={(contactMembersOf(settings)[g] || []).join('、')}
                        onBlur={e => {
                          const names = e.target.value.split(/[,、\n]/).map(x => x.trim()).filter(Boolean);
                          (saveShared || saveSettings)({ contactMembers: { ...(settings?.contactMembers || {}), [g]: names } });
                        }}
                        placeholder="例: 小川、佐藤、田中"
                        className="flex-1 border border-slate-300 rounded-lg px-2 py-1 text-xs"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </details>
          {/* ② 通知の宛先ルールと再通知 */}
          <details name="cfgacc" className="shrink-0 group bg-amber-50/40 border-2 border-amber-200 rounded-2xl overflow-hidden">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-amber-50">
              <span className="text-2xl shrink-0">📨</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-slate-800">通知の宛先ルール</div>
                <div className="fi-tap-text text-slate-500 truncate">誰の携帯へ・返信ない時の再通知・上司へ自動</div>
              </div>
              <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="p-3 flex flex-col gap-2">
              <div className="fi-tap-text text-slate-400">端末の役職は、{sideLabel}ポータルの🔔（または下の「通知（プッシュ）」の端末一覧）で設定します。役職未設定の端末は「職長」あつかい。上司=工長・グループ長。該当の役職が1台も無い時は 職長→上司→全員 の順に自動で振り替えます（誰にも届かない事態を防ぐ）。</div>
              {groups.map(g => {
                const r = contactRoutingOf(settings, g);
                const save = (patch) => saveSettings({ contactRouting: { ...(settings?.contactRouting || {}), [g]: { ...((settings?.contactRouting || {})[g] || {}), ...patch } } });
                const saveRemind = (kind, patch) => {
                  const cur = ((settings?.contactRouting || {})[g] || {}).remind || {};
                  save({ remind: { ...cur, [kind]: { ...contactRemindOf(settings, g, kind), ...patch } } });
                };
                const RemindRow = ({ kind, icon, label }) => {
                  const rm = contactRemindOf(settings, g, kind);
                  return (
                    <div className={`flex items-center gap-2 flex-wrap rounded-lg px-2 py-1.5 border ${rm.on ? 'bg-amber-50 border-amber-300' : 'bg-white border-slate-200'}`}>
                      <span className="text-xs font-bold text-slate-600 w-32 shrink-0">{icon} {label}</span>
                      <button onClick={() => saveRemind(kind, { on: !rm.on })} className={`px-2.5 py-1 rounded-full text-xs font-black ${rm.on ? 'bg-amber-500 text-white' : 'bg-slate-200 text-slate-500'}`}>{rm.on ? '再通知 ON' : '再通知 OFF'}</button>
                      {rm.on && (
                        <span className="fi-tap-text font-bold text-slate-600 flex items-center gap-1">
                          返信がない間、
                          <input type="number" min="1" value={rm.min} onChange={e => saveRemind(kind, { min: Math.max(1, Number(e.target.value) || 1) })} className="w-14 border border-slate-300 rounded px-1 py-0.5 text-center" />
                          分ごとに もう一度職長へ（最大
                          <input type="number" min="1" value={rm.count} onChange={e => saveRemind(kind, { count: Math.max(1, Number(e.target.value) || 1) })} className="w-14 border border-slate-300 rounded px-1 py-0.5 text-center" />
                          回）
                        </span>
                      )}
                    </div>
                  );
                };
                return (
                  <div key={g} className="bg-slate-50 border border-slate-200 rounded-xl p-2 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-black text-slate-800 bg-white border border-slate-300 rounded-lg px-2.5 py-1">{g}</span>
                      <label className="fi-tap-text font-bold text-slate-500 flex items-center gap-1">普段の宛先
                        <select value={r.mode} onChange={e => save({ mode: e.target.value })} className="border border-slate-300 rounded-lg px-1.5 py-1 text-xs font-bold">
                          <option value="chief">職長のみ（既定）</option>
                          <option value="both">職長＋上司</option>
                          <option value="boss">上司のみ</option>
                          <option value="all">全員</option>
                        </select>
                      </label>
                      <label className={`text-xs font-black flex items-center gap-1.5 px-2 py-1 rounded-lg border cursor-pointer ${r.chiefAway ? 'bg-rose-50 border-rose-300 text-rose-700' : 'bg-white border-slate-300 text-slate-500'}`}>
                        <input type="checkbox" checked={r.chiefAway} onChange={e => save({ chiefAway: e.target.checked })} className="w-4 h-4 accent-rose-600" />
                        職長 不在（休み）→ 上司へ
                      </label>
                      <label className="fi-tap-text font-bold text-slate-500 flex items-center gap-1">未返信
                        <input type="number" min="0" max="120" value={r.escalateMin} onChange={e => save({ escalateMin: Math.max(0, Number(e.target.value) || 0) })} className="w-14 border border-slate-300 rounded-lg px-1.5 py-1 text-xs font-bold text-center" />
                        分で上司にも自動通知（0=しない）
                      </label>
                    </div>
                    <RemindRow kind="repair" icon="🔧" label="修正・呼出の再通知" />
                    <RemindRow kind="arrival" icon="🚚" label="入荷(到着予定)の再通知" />
                  </div>
                );
              })}
            </div>
          </details>
          {/* ③ ポータル公開とURL */}
          <details name="cfgacc" className="shrink-0 group bg-emerald-50/40 border-2 border-emerald-200 rounded-2xl overflow-hidden">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-emerald-50">
              <span className="text-2xl shrink-0">🌐</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-slate-800">{sideLabel}ポータル（公開情報とURL）</div>
                <div className="fi-tap-text text-slate-500 truncate">相手の呼び名・出す情報・渡すURLのコピー</div>
              </div>
              <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="p-3 flex flex-col gap-3">
              <div>
                <div className="text-xs font-black text-slate-500 mb-1">相手側の呼び名 — 画面表示に使います（例: 組立 / 機械 / 前工程）</div>
                <input defaultValue={sideLabel} onBlur={e => { const v = e.target.value.trim(); if (v && v !== sideLabel) saveSettings({ contactSideLabel: v }); }} placeholder="組立" className="border border-slate-300 rounded-lg px-2 py-1 text-sm w-40" />
              </div>
              <div>
                <div className="text-xs font-black text-slate-500 mb-1">ポータル（{sideLabel}の画面）に出す情報 — 指図と品目コード以外は隠せます</div>
                <div className="flex gap-4 text-xs font-bold text-slate-600">
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={portalCfg.showQuantity !== false} onChange={e => saveSettings({ contactPortal: { ...portalCfg, showQuantity: e.target.checked } })} className="w-4 h-4 accent-blue-600" /> 台数を表示</label>
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={portalCfg.showDueDate !== false} onChange={e => saveSettings({ contactPortal: { ...portalCfg, showDueDate: e.target.checked } })} className="w-4 h-4 accent-blue-600" /> 納期を表示</label>
                  {/* 制御装置(号機)を組立に見せる。⚠見るだけ(向こうから変更・登録・削除はできません)。 */}
                  <label className="flex items-center gap-1.5" title="指図ごとにどの号機を使うか・号機マスタを、組立側でも見られるようにします。変更はできません（印刷はできます）"><input type="checkbox" checked={portalCfg.showControlDevices !== false} onChange={e => saveSettings({ contactPortal: { ...portalCfg, showControlDevices: e.target.checked } })} className="w-4 h-4 accent-blue-600" /> 制御装置(号機)を見せる<span className="fi-tap-text text-slate-400">見るだけ・印刷可</span></label>
                </div>
              </div>
              <div>
                <div className="text-xs font-black text-slate-500 mb-1">{sideLabel}に渡すURL（限定表示: 返信・到着/終了予定・履歴だけが使えます）</div>
                <div className="flex items-center gap-2">
                  <input readOnly value={portalUrl} className="flex-1 border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-mono bg-slate-50" onFocus={e => e.target.select()} />
                  <button onClick={() => { try { navigator.clipboard.writeText(portalUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) { /* noop */ } }} className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold flex items-center gap-1"><Copy className="w-3.5 h-3.5" /> {copied ? 'コピー済み' : 'コピー'}</button>
                </div>
              </div>
            </div>
          </details>
          {/* ④ プッシュ通知(VAPID/端末) */}
          <details name="cfgacc" className="shrink-0 group bg-slate-50 border-2 border-slate-200 rounded-2xl overflow-hidden">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-3 px-3.5 py-3 hover:bg-slate-100">
              <span className="text-2xl shrink-0">📳</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-slate-800">通知（プッシュ）の設定・端末一覧</div>
                <div className="fi-tap-text text-slate-500 truncate">VAPID鍵・この端末の登録・つながっている端末</div>
              </div>
              <span className="shrink-0 text-slate-300 text-xl transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="p-3">
              <PushSettingsPanel
                settings={settings} saveSettings={saveSettings} saveShared={saveShared} saveData={saveData} deleteData={deleteData}
                pushTokens={pushTokens} side="app" group="" personName={currentUserName} admin
                onOpenHelp={() => setShowPushHelp(true)}
              />
            </div>
          </details>
        </div>
      )}
      {/* ⚠ ここから下の箱は shrink-0 にしない。縮まないと、下の連絡一覧(総合表)が画面の外へ押し出される。 */}
      {internalReqs.some(r => r.status === 'waiting') && (
        <div className="min-h-0 bg-indigo-50 border border-indigo-200 rounded-xl p-2 flex flex-col gap-1.5 max-h-[28vh] overflow-y-auto overscroll-contain">
          <div className="text-xs font-black text-indigo-800 flex items-center gap-1.5">🏭 社内連絡（現場→職長・工長）<span className="fi-tap-text font-normal text-indigo-500">対応待ち {internalReqs.filter(r => r.status === 'waiting').length}件</span></div>
          {internalReqs.filter(r => r.status === 'waiting').map(r => (
            <div key={r.id} className="bg-white rounded-lg border border-indigo-200 px-3 py-2 flex items-center gap-2 flex-wrap">
              <span className="fi-tap-text font-black text-indigo-700 bg-indigo-100 rounded px-1.5 py-0.5 shrink-0">{r.topic || '連絡'}</span>
              {r.orderNo && <span className="font-mono text-xs font-bold text-slate-500 shrink-0">{r.orderNo}</span>}
              <span className="text-sm text-slate-800 truncate flex-1 min-w-[8ch]" title={r.message}>{r.message}</span>
              <span className="fi-tap-text text-slate-400 shrink-0">{r.from || ''}・{fmtContactElapsed(r.createdAt, nowTick)}前</span>
              <button onClick={() => ackInternal(r)} className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-black shrink-0">対応します</button>
            </div>
          ))}
        </div>
      )}
      {/* 📦 検査完了の連絡が途中の指図(分納)。残りを出す入口。ここが無いと2便目が送れない。
          🚨2026-08-21 分納の途中だけでなく **まだ1台も知らせていない完了ロット** と
            **「連絡しない」にした物** もここに出す。
            本番実測で完了124件のうち98件(79%)が「連絡しない」になっており、
            そこから送り直す道がどこにも無かった(=現場から「通知が無い」と言われた実体)。 */}
      {!showCfg && onOpenComplete && (() => {
        const isDoneLot = (l) => !!l && (l.status === 'completed' || l.location === 'completed');
        const rest = (lots || []).filter(l => isDoneLot(l) && (isPartiallyNotified(l) || !l.completeNotified || isDeclined(l)));
        if (!rest.length) return null;
/* 📐 2026-09-15 実測: この箱(24vh)と下の到着予定(26vh)で画面の半分を使い、
              主役のはずの連絡一覧は **0行** しか出ていなかった(本番の写し 1740x1020)。
              🚨 1件も消さない。箱の **高さだけ** を 14vh へ落とす(中は今までどおりスクロールする)。
                代わりに見出しへ「286件のうち どれだけが『連絡しない』にした物か」の帯を出す。
              🚨 帯の長さは すぐ上で作った rest を2つに分けただけ。**新しい集計ではない**ので、
                分けた数はどちらも札として画面に出す(隠れた数字を作らない)。 */
        return (
          <div className="min-h-0 bg-white rounded-xl border-2 border-emerald-200 p-2 flex flex-col gap-1.5 max-h-[14vh] overflow-y-auto overscroll-contain">
            <div className="text-xs font-black text-emerald-800 sticky top-0 bg-white pb-1 flex items-center gap-1.5 flex-wrap">
              <Viz.Glyph kind="lot" className="w-4 h-4 text-emerald-700" />
              📦 まだ知らせていない検査完了 <span className="text-white bg-emerald-600 rounded-full px-2 py-0.5">{rest.length}件</span>
              <Viz.StackBar
                className="w-24 shrink-0" height="h-3" total={rest.length}
                segments={[
                  { key: 'notyet', value: rest.filter(l => !isDeclined(l)).length, tone: 'ahead', title: 'まだ知らせていない' },
                  { key: 'declined', value: rest.filter(isDeclined).length, tone: 'quiet', title: '連絡しない にした' },
                ]}
              />
              <span className="fi-tap-text font-normal text-slate-500">まだ {rest.filter(l => !isDeclined(l)).length}件 ／ 連絡しない にした {rest.filter(isDeclined).length}件</span>
              <span className="ml-2 fi-tap-text font-normal text-slate-400">1台ぶんだけでも、ここから知らせられます</span>
            </div>
            {/* 📐PU5-H 2026-09-07: 1件で横帯を1本(1316px)使い、中身は左の24%だけで右は丸ごと空だった
                  (本番実測 42px×21本 = 900px 超)。**3列の格子**に並べ替えて、縦を およそ1/3 にする。
                  🚨 押す物・行き先・文言は1つも消していない(並べ方だけを変えた)。
                  🚨 押す物は min-h-11(44px)。指で押せる大きさは格子でも守る。 */}
            <div data-pu5="notshared-grid" className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-1.5">
            {/* 🧹 2026-09-23: 「連絡しない にした」(決めた物)が先頭に並び、まだ知らせていない物(やる事)が下へ埋もれていた。やる事を先に、新しく終わった順 */}
            {[...rest].sort((x, y) => (Number(isDeclined(x)) - Number(isDeclined(y))) || ((new Date(toMsAny(y.completedAt) || 0).getTime() || 0) - (new Date(toMsAny(x.completedAt) || 0).getTime() || 0))).map(l => (
              <div key={l.id} data-pu5-row="notshared" className="min-w-0 rounded-lg border border-emerald-200 bg-emerald-50/40 px-2 py-1 flex items-center gap-2 flex-wrap">
                {/* 🎨 この3列の格子は notext の写しで **空の枠が21個** だった。
                    ロットの印(箱)と「残り何台」を点で出して、字を読まなくても量が分かるようにする。
                    🚨 残り台数は右のボタンが既に出している remainingQtyOf(l) を **そのまま**使う(数え直さない)。
                    🚨 押す物は1つも足していない(この箱の押す物は2つのまま = 見張り PU5-3)。 */}
                <Viz.Glyph kind="lot" className={`w-4 h-4 shrink-0 ${isDeclined(l) ? 'text-slate-400' : 'text-emerald-600'}`} title={isDeclined(l) ? '連絡しない にしたロット' : 'まだ知らせていないロット'} />
                <Viz.Dots count={remainingQtyOf(l)} cap={6} tone={isDeclined(l) ? 'quiet' : 'ahead'} size="w-2 h-2" className="shrink-0" title={isDeclined(l) ? `連絡しない にしました（残り ${remainingQtyOf(l)}台）` : `残り ${remainingQtyOf(l)}台`} />
                <span className="font-mono text-xs font-black text-slate-600 shrink-0">{l.orderNo}</span>
                <span className="text-sm font-bold text-slate-700 truncate min-w-0 flex-1">{l.model}{l.modelText ? <span className="font-normal text-slate-400"> {l.modelText}</span> : null}</span>
                <span className="fi-tap-text font-black text-emerald-800 bg-white border border-emerald-200 rounded px-1.5 py-0.5 shrink-0">{isDeclined(l) ? '連絡しない にした' : completeStatusLabel(l)}</span>
                {isDeclined(l) && onUndoDecline && (
                  <button onClick={() => onUndoDecline(l)} className="min-h-11 px-2.5 py-1.5 rounded-lg bg-white border border-emerald-400 text-emerald-700 text-xs font-black shrink-0">やっぱり知らせる</button>
                )}
                {!isDeclined(l) && (
                  <button onClick={() => onOpenComplete(l)} className="min-h-11 ml-auto px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black shrink-0">
                    残り {remainingQtyOf(l)}台 を知らせる
                  </button>
                )}
              </div>
            ))}
            </div>
          </div>
        );
      })()}
      {/* 🚚 到着チェック(来た/来ない)と班のクセ。⚠検査グループだけの画面。組立には出さない。
          ⚠ いまは ARRIVAL_CHECK_ENABLED=false で封印中（2026-08-05）。中身は消していない。 */}
      {ARRIVAL_CHECK_ENABLED && !showCfg && onCheckArrival && (
        <div className="shrink-0 bg-white rounded-xl border-2 border-slate-200 p-3">
          <ArrivalCheckPanel
            items={arrCheckItems} actuals={arrivalActuals} now={nowTick}
            onCheck={onCheckArrival} onUndo={onUndoArrival} onRemind={onRemindArrival}
          />
        </div>
      )}
      {/* 🚚 もらった到着予定 → 「いつ終わる」を返す。返したか/返していないかをこの1枚で分かるようにする。
          ⚠ shrink-0 にしない + たためるようにする。ここが伸びると下の連絡一覧(総合表)が見えなくなる。 */}
      {!showCfg && arrBoard.rows.length > 0 && (
        <div className={`min-h-0 bg-white rounded-xl border-2 border-teal-200 p-2 flex flex-col gap-1.5 overflow-y-auto overscroll-contain ${arrBig ? 'fixed inset-3 z-[900] max-h-none shadow-2xl' : arrFold ? 'max-h-none' : 'min-h-[5.5rem] max-h-[26vh]'}`}>
          <div className="text-xs font-black text-teal-800 flex items-center gap-1.5 flex-wrap sticky top-0 bg-white pb-1">
            🚚 もらった到着予定
            {arrFold && <span className="text-white bg-teal-600 rounded-full px-2 py-0.5">{arrBoard.rows.length}件</span>}
            {/* たたむ: 下の連絡一覧(総合表)を広く見たい時(清水さん 2026-08-05) */}
            {!arrBig && (
              <button onClick={toggleArrFold} title={arrFold ? '到着予定の一覧をひらく' : 'たたんで、下の連絡一覧を広く見る'}
                className="px-2 py-0.5 rounded-lg fi-tap-text font-black bg-slate-100 hover:bg-slate-200 text-slate-600">
                {arrFold ? '▼ ひらく' : '▲ たたむ'}
              </button>
            )}
            {/* 拡大: 一覧が狭くて読みにくい時に画面いっぱいで見る(清水さん 2026-08-01) */}
            <button onClick={() => setArrBig(v => !v)} title={arrBig ? '元の大きさに戻す' : '画面いっぱいに広げて見る'}
              className="px-2 py-0.5 rounded-lg fi-tap-text font-black bg-slate-100 hover:bg-slate-200 text-slate-600">
              {arrBig ? '× 閉じる' : '⤢ 拡大'}
            </button>
            {/* 急かすのは「まだ何もしていない」ものだけ。入荷時間を入れた時点で処理は済んでいる(清水さん 2026-08-05) */}
            {finishOn && arrStats.untouched > 0 && <span className="text-white bg-teal-600 rounded-full px-2 py-0.5 animate-pulse">未対応 {arrStats.untouched}件</span>}
            {/* 🎨 2026-09-15: この行は notext の写しで **完全に消えた**(字だけ)。
                「返信済 / 反映だけ / 未対応」の比を1本の帯にする。数字は右にそのまま残す。
                🚨 帯の長さは arrStats が いま持っている数をそのまま使う(ここで数え直さない)。 */}
            <span className="flex items-center gap-1.5 min-w-0">
              <Viz.StackBar
                className="w-24 shrink-0" height="h-3" total={arrStats.total}
                segments={[
                  { key: 'replied', value: arrStats.replied, tone: 'ahead', title: `終了予定を返信 ${arrStats.replied}件` },
                  { key: 'applied', value: arrStats.appliedOnly, tone: 'plain', title: `入荷時間の反映だけ ${arrStats.appliedOnly}件` },
                  { key: 'todo', value: arrStats.untouched, tone: 'idle', title: `未対応 ${arrStats.untouched}件` },
                ]}
              />
              <span className="fi-tap-text font-normal text-slate-400">処理済 {arrStats.handled} / {arrStats.total}件（終了予定を返信 {arrStats.replied}件・入荷時間の反映だけ {arrStats.appliedOnly}件）</span>
            </span>
            {!finishOn && <span className="fi-tap-text font-bold text-slate-400">（「いつ終わるか」の返信はOFF）</span>}
            <span className="ml-auto flex items-center gap-1.5 shrink-0">
              <button onClick={() => setArrOnlyTodo(v => !v)} title="終了予定の返信も、入荷時間の反映も していないものだけ出します" className={`px-2.5 py-1 rounded-full fi-tap-text font-black ${arrOnlyTodo ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>未対応だけ</button>
              {arrBoard.hidden > 0 && <span className="fi-tap-text font-normal text-slate-400">{arrOnlyTodo ? `処理済 ${arrBoard.hidden}件は非表示` : `返信済の古い${arrBoard.hidden}件は非表示`}</span>}
              <select value={arrRange} onChange={e => setArrRange(e.target.value)} disabled={arrOnlyTodo} className="border border-slate-300 rounded-lg px-1.5 py-1 fi-tap-text font-bold text-slate-600 bg-white disabled:opacity-40">
                {RANGE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </span>
          </div>
          {/* 色: 処理済み(=終了予定を返信 した または 入荷時間へ反映 した)は白。
              まだ何もしていなくて到着予定を過ぎたものだけ橙で目立たせる(清水さん 2026-08-05)。 */}
          {!arrFold && arrBoard.rows.map(e => (
            <div key={e.key} className={`rounded-lg border px-3 py-1.5 flex items-center gap-2 flex-wrap ${e.handled ? 'bg-white border-slate-200' : e.late ? 'bg-amber-50 border-amber-300' : 'bg-teal-50/60 border-teal-200'}`}>
              {/* 🚦 この行が「返し終わったのか / まだなのか」＝この画面の答え。
                  いままでは 🏁✅⚠ の **絵文字と文字** だけだったので、文字を消すと1つも残らなかった(実測)。
                  🚨 判定は **行がすでに背景色で使っている e.handled / e.late をそのまま**使う。
                    新しい判定を書かない(書くと背景と信号がいつか食い違う)。
                  🚨 色だけでなく形も変わる(大丈夫=丸 / 気を付ける=三角 / 危ない=丸に縦棒)ので白黒でも読める。 */}
              <Viz.Signal
                level={e.handled ? 'ok' : e.late ? 'danger' : 'warn'}
                size="w-4 h-4" className="shrink-0"
                title={e.replied ? '終了予定を返信済' : e.applied ? '入荷時間は反映済（終了予定はまだ）' : e.late ? '未対応（到着予定を過ぎています）' : '未対応'}
              />
              <span className="font-mono text-xs font-black text-slate-600 shrink-0">{e.orderNo}</span>
              <span className="text-sm font-bold text-slate-700 truncate">{e.model}{e.modelText ? <span className="font-normal text-slate-400"> {e.modelText}</span> : null}</span>
              {/* 📋 組立が選んだテンプレート(検査手順)。古い到着予定には入っていないので、有る時だけ出す。 */}
              {e.templateName && <span className="fi-tap-text font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5 shrink-0">📋 {e.templateName}</span>}
              <span className="fi-tap-text font-black text-teal-700 bg-white border border-teal-200 rounded px-1.5 py-0.5 shrink-0">🚚 {fmtContactDT(e.ts)}</span>
              <span className="fi-tap-text text-slate-400 shrink-0">{e.group || ''}{e.by ? `・${e.by}` : ''}{e.source === 'self' && !e.orphan ? '・自発' : ''}</span>
              {/* 元の依頼が削除されている = やりとりの履歴をたどれない。放置すると「送った覚えがない」になる。 */}
              {e.orphan && <span className="fi-tap-text font-bold text-amber-700 bg-amber-100 rounded px-1.5 py-0.5 shrink-0" title="この到着予定の元になった依頼が削除されています。履歴からはたどれません">元の依頼は削除済み</span>}
              {/* ⚠「返信」と「反映」は別の意味。
                    返信 = 相手へ「いつ終わるか」を返した / 反映 = こちらの入荷時間(検査リスト)へ入れた。
                    入荷時間を入れた時点で処理は済んでいるので、そこは警告にしない(清水さん 2026-08-05)。 */}
              {e.replied
                ? <span className="ml-auto text-xs font-black text-teal-700 shrink-0">🏁 {fmtContactDT(e.finish.ts)} 返信済{e.finish.by ? `（${e.finish.by}）` : ''}</span>
                : e.applied
                  ? <span className="ml-auto text-xs font-black text-emerald-700 shrink-0" title={`入荷時間 ${fmtContactDT(e.applied.entryAt || e.ts)} を検査リストへ入れました${e.applied.by === 'auto' ? '（自動反映）' : e.applied.by ? `（${e.applied.by}）` : ''}`}>✅ 反映済（入荷時間）{finishOn ? <span className="font-bold text-slate-400">・終了予定はまだ</span> : null}</span>
                  : <span className={`ml-auto text-xs font-black shrink-0 ${e.late ? 'text-amber-700' : 'text-slate-400'}`}>{finishOn ? (e.late ? '⚠ 未対応（到着予定を過ぎています）' : '未対応') : '—'}</span>}
              {finishOn && onOpenArrivalEntry && (
                <button onClick={() => onOpenArrivalEntry(e.key)} className={`px-2.5 py-1 rounded-lg text-xs font-black shrink-0 ${e.replied ? 'bg-white border border-teal-300 text-teal-700 hover:bg-teal-50' : 'bg-teal-600 hover:bg-teal-700 text-white'}`}>
                  {e.replied ? '返信し直す' : '🏁 終了予定を返信'}
                </button>
              )}
              {deleteData && (
                <button onClick={() => deleteArrival(e)} title="この到着予定を消す" className="p-1.5 rounded-lg text-slate-300 hover:text-rose-600 hover:bg-rose-50 shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
              )}
            </div>
          ))}
        </div>
      )}
      {/* 連絡の一覧(総合表)。⚠ min-h-0 だと上の箱に押されて高さ0になり「下に行って見えない」状態になる。
          ここだけは必ず 30vh 残す(2026-08-05 清水さん指摘)。上の箱は縮む側に回す。 */}
      <div className={`flex-1 min-h-[30vh] overflow-y-auto bg-white rounded-xl border border-slate-200 ${showCfg ? 'hidden' : ''}`}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 fi-tap-text text-slate-500 z-10">
            <tr className="border-b border-slate-200">
              <th className="text-left px-3 py-2 whitespace-nowrap">種類</th>
              <th className="text-left px-3 py-2">内容</th>
              <th className="text-left px-2 py-2 whitespace-nowrap">宛先</th>
              <th className="text-left px-2 py-2 whitespace-nowrap" title="到着予定・終了予定の日時">予定日時</th>
              <th className="text-left px-2 py-2 whitespace-nowrap">状況</th>
              <th className="text-left px-2 py-2 whitespace-nowrap" title="こちらが送った時刻 / 相手から連絡が来た時刻">時刻</th>
              <th className="text-left px-2 py-2 whitespace-nowrap" title="返事を待たせている時間(返事の要らないものは —)">経過</th>
              <th className="text-left px-2 py-2 whitespace-nowrap">返信時間</th>
              <th className="text-left px-3 py-2">返信内容</th>
              <th className="w-10 px-2 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {listShown.map(r => {
              const c = contactRowCells(r, nowTick, arrivalSplitsByLot);
              const st = c.status;
              return (
                <tr key={r.id} onClick={() => { if (!r._self) setDetailId(r.id); }} className={r._self ? 'bg-slate-50/60' : 'cursor-pointer hover:bg-blue-50/50'}>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`fi-tap-text font-black px-1.5 py-0.5 rounded ${r.kind === 'arrival' ? 'bg-teal-100 text-teal-700' : r.kind === 'finish' ? 'bg-indigo-100 text-indigo-700' : r.kind === 'complete' ? 'bg-emerald-100 text-emerald-700' : r.kind === 'portalmsg' ? 'bg-teal-100 text-teal-800' : r.kind === 'newlot' ? 'bg-rose-100 text-rose-700' : r.kind === 'internal' ? 'bg-indigo-100 text-indigo-800' : r.kind === 'call' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>{contactKindLabel(r)}</span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {r._self && <span className="fi-tap-text font-black text-teal-700 bg-teal-50 border border-teal-200 rounded px-1 py-0.5 shrink-0" title="頼まれる前に相手が自分から登録した到着予定">自発</span>}
                      {r.orderNo && <span className="font-mono text-xs font-bold text-slate-500 shrink-0">{r.orderNo}</span>}
                      {/* 機番(組立からの連絡)。指図だけでは何台目の話か決まらないので必ず並べて出す */}
                      {r.serialNo && <span className="font-mono text-xs font-black text-teal-700 bg-teal-50 border border-teal-200 rounded px-1 py-0.5 shrink-0">機番 {r.serialNo}</span>}
                      {/* ⚠指図番号だけでは何の話か分からない。**品目コードも必ず出す**(清水さん指摘 2026-08-01)。
                          データには最初から model が入っていたのに、表に出していなかった。 */}
                      {r.model && r.kind !== 'arrival' && r.kind !== 'finish' && (
                        <span className="text-xs font-bold text-slate-700 shrink-0 max-w-[20ch] truncate" title={r.model}>{r.model}{r.modelText ? <span className="font-normal text-slate-400"> {r.modelText}</span> : null}</span>
                      )}
                      {/* 🆕 検査リストに無い品の連絡は「何台か」が要る(登録する時に必ず要る数字)。
                          ほかの連絡には台数の欄が無いので、ここだけ出す。 */}
                      {r.kind === 'newlot' && !!r.quantity && (
                        <span className="text-xs font-black text-rose-700 bg-rose-50 border border-rose-200 rounded px-1 py-0.5 shrink-0">{r.quantity}台</span>
                      )}
                      {(r.kind === 'arrival' || r.kind === 'finish')
                        ? <span className="text-xs text-slate-600 truncate">{r._self ? `${r.model}${r._tplName ? ` 📋${r._tplName}` : ''}` : `${(r.items || []).length}件: ${(r.items || []).map(i => i.orderNo).filter(Boolean).slice(0, 4).join(', ')}${(r.items || []).length > 4 ? '…' : ''}`}</span>
                        : <span className="text-slate-700 truncate max-w-[36ch]" title={r.message}>{r.message}</span>}
                    </div>
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap text-xs font-bold text-slate-600">{r.to || <span className="text-slate-300">—</span>}{r.toPerson ? <span className="text-blue-600"> → {r.toPerson}</span> : ''}</td>
                  {/* 予定日時: 到着予定・終了予定だけ意味がある。それ以外は — 。
                      ⚠分納は「便ごとに1行」に分ける。日をまたぐ便があるので、行には必ず日付を出す。
                      列は増やさない(増やすと横に長くなって他の欄が読めなくなる)。 */}
                  <td className="px-2 py-2 whitespace-nowrap font-mono text-xs align-top">
                    {c.when
                      ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-black text-teal-700">{c.whenKind === '終了' ? '🏁' : '🚚'} {c.when}</span>
                          {(c.whenSplits || []).map((s, i) => (
                            <span key={i} className="fi-tap-text font-bold text-teal-600">
                              {i + 1}便 {String(s.date || '').slice(5).replace('-', '/')} {s.time} × {s.qty}台
                            </span>
                          ))}
                        </div>
                      )
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap"><span className={`fi-tap-text font-black px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span></td>
                  <td className="px-2 py-2 whitespace-nowrap font-mono text-xs text-slate-500" title={c.sentLabel}>{fmtContactTime(c.sentAt)}</td>
                  <td className="px-2 py-2 whitespace-nowrap font-mono text-xs">{c.elapsed === 'waiting' ? <span className="text-amber-700 font-bold">{fmtContactElapsed(c.sentAt, nowTick)}</span> : (c.elapsed ? <span className="text-slate-400">{fmtContactElapsed(c.sentAt, c.elapsed)}</span> : <span className="text-slate-300">—</span>)}</td>
                  <td className="px-2 py-2 whitespace-nowrap font-mono text-xs text-slate-500">{c.replyAt ? fmtContactTime(c.replyAt) : <span className="text-slate-300">—</span>}</td>
                  {/* 返信が「来た」のか「不要なので無い」のかを色でも分ける(緑=返信あり / 灰=返信不要・待ち) */}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs font-bold truncate block max-w-[26ch] ${r.answer?.choice === 'no' ? 'text-rose-700' : c.replyGood ? 'text-emerald-700' : 'text-slate-300 font-normal'}`} title={c.replyText}>{c.replyText || '—'}</span>
                      {/* 自発の到着予定は行がクリックできない(詳細を開けない)ので、ここに削除ボタンを出す。
                          実体は arrival_times(ロット単位)。消すとそのロットの🚚バッジも消える。 */}
                      {r._self && r._docId && (
                        <button onClick={(e) => { e.stopPropagation(); if (window.confirm('この到着予定を削除しますか？\n（検査リストのこのロットの🚚到着バッジも消えます）')) deleteData('arrival_times', r._docId); }} className="ml-auto p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded shrink-0" title="この到着予定を削除"><Trash2 className="w-3.5 h-3.5" /></button>
                      )}
                    </div>
                  </td>
                  {/* 表から直接消せるように(今までは行→詳細を開く→削除、の2手だった)。行クリックで詳細が開くので伝播を止める。 */}
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`この連絡を削除しますか？（履歴からも消えます）\n\n${contactKindLabel(r)}${r.orderNo ? ` / 指図 ${r.orderNo}` : ''}\n${fmtContactTime(r.createdAt)} → ${r.to || ''}`)) deleteData('contact_requests', r.id);
                      }}
                      title="この連絡を削除"
                      className="p-1.5 rounded-lg text-slate-300 hover:text-rose-600 hover:bg-rose-50"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              );
            })}
            {listShown.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-slate-400">{listCut.hidden > 0 ? `この期間の連絡はありません（古い分が ${listCut.hidden}件 あります。右上の期間を広げると出ます）` : '連絡はまだありません。「到着予定を聞く」「連絡・呼出」から送れます。作業画面のNG→修正からも自動で聞かれます。'}</td></tr>}
          </tbody>
        </table>
      </div>
      {detail && (
        <div className="fixed inset-0 z-[95] bg-black/50 flex items-center justify-center p-4" onClick={() => setDetailId(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 bg-slate-700 text-white flex items-center gap-2 shrink-0">
              <span className="font-black">{contactKindLabel(detail)} の詳細</span>
              <span className={`fi-tap-text font-black px-1.5 py-0.5 rounded border ${contactStatusInfo(detail).cls}`}>{contactStatusInfo(detail).label}</span>
              <button onClick={() => setDetailId(null)} className="ml-auto p-1 hover:bg-white/20 rounded-full"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 overflow-y-auto flex flex-col gap-2 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <div><span className="text-slate-400 font-bold">宛先:</span> <span className="font-bold">{detail.to}{detail.toPerson ? ` → ${detail.toPerson}さん` : ''}</span></div>
                <div><span className="text-slate-400 font-bold">依頼者:</span> <span className="font-bold">{detail.from || '—'}</span></div>
                <div><span className="text-slate-400 font-bold">送信:</span> <span className="font-mono">{fmtContactTime(detail.createdAt)}</span></div>
                <div><span className="text-slate-400 font-bold">返信:</span> <span className="font-mono">{contactReplyAt(detail) ? fmtContactTime(contactReplyAt(detail)) : '—'}</span></div>
                {detail.orderNo && <div><span className="text-slate-400 font-bold">指図:</span> <span className="font-mono font-bold">{detail.orderNo}</span></div>}
                {/* 機番。組立からの連絡で「どの台か」を言うために足した欄 */}
                {detail.serialNo && <div><span className="text-slate-400 font-bold">機番:</span> <span className="font-mono font-black text-teal-700">{detail.serialNo}</span></div>}
                {detail.model && <div><span className="text-slate-400 font-bold">品目コード:</span> <span className="font-bold">{detail.model}</span>{detail.modelText ? <span className="text-slate-500"> {detail.modelText}</span> : null}</div>}
                {detail.stepTitle && <div><span className="text-slate-400 font-bold">工程:</span> <span className="font-bold">{detail.stepTitle} {detail.unitLabel}</span></div>}
              </div>
              {detail.message && <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 whitespace-pre-wrap">{detail.message}</div>}
              {(() => {
                const att = contactAttachmentOf(detail, lots);
                if (!att || !att.photos.length) return null;
                return (
                  <div>
                    <div className="fi-tap-text font-bold text-slate-400 mb-1">添付写真（不具合報告より）— 押すと大きく見られます</div>
                    <div className="flex gap-1.5 overflow-x-auto">
                      {/* ⚠寸法(h-24)は変えない。ここは一覧なので、拡大する道を足すだけ。 */}
                      {att.photos.map((p, i) => <img key={i} src={p} alt="" onClick={() => setZoomImg(p)} title="押すと大きく見られます" className="h-24 rounded-lg border border-slate-200 shrink-0 cursor-zoom-in" />)}
                    </div>
                  </div>
                );
              })()}
              {detail.kind !== 'arrival' && detail.answer && (
                <div className={`border rounded-lg px-3 py-2 ${detail.answer.choice === 'no' ? 'bg-rose-50 border-rose-300' : 'bg-emerald-50 border-emerald-300'}`}>
                  <div className={`font-black ${detail.answer.choice === 'no' ? 'text-rose-700' : 'text-emerald-700'}`}>返信: {contactReplyLabel(detail.answer.choice)}</div>
                  {detail.answer.comment && <div className="text-xs text-slate-600 mt-0.5">{detail.answer.comment}</div>}
                  <div className="fi-tap-text text-slate-400 mt-0.5">{detail.answer.by || ''} ・ {fmtContactTime(detail.answer.at)}</div>
                </div>
              )}
              {/* 🆕「検査リストに無い品」の連絡。共通の見出しには台数と到着予定の欄が無いので、ここで出す。
                  これを出さないと、登録する時に一番要る「何台か」が画面のどこにも出ない。 */}
              {detail.kind === 'newlot' && (() => {
                const it = (detail.items || [])[0] || {};
                return (
                  <div className="border-2 border-rose-200 bg-rose-50 rounded-lg px-3 py-2 flex flex-col gap-1">
                    <div className="fi-tap-text font-black text-rose-700">🆕 検査の一覧に無いものの連絡です。下の「この内容で検査対象に登録」から登録できます。</div>
                    {/* 🔎 2026-09-16 この指図が本当に無いのか(取込で落ちた／消した／完了済み／もう在る)を、取込の記録から言う */}
                    <MissingOrderHint orderNo={detail.orderNo} lots={lots} settings={settings} showOpen />
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <div><span className="text-slate-400 font-bold">台数:</span> <span className="font-black text-slate-800">{detail.quantity || 0}台</span></div>
                      <div><span className="text-slate-400 font-bold">納期:</span> <span className="font-bold">{detail.dueDate ? fmtDue(detail.dueDate) : '—'}</span></div>
                      {/* 到着予定は組立が入れてくれた時だけ出す。無い時は空のまま(こちらで作らない)。 */}
                      <div className="col-span-2"><span className="text-slate-400 font-bold">到着予定:</span> {it.time
                        ? <span className="font-black text-teal-700">🚚 {it.date ? `${String(it.date).slice(5).replace('-', '/')} ` : ''}{it.time}</span>
                        : <span className="text-slate-400">まだ聞いていません</span>}</div>
                    </div>
                    <div className="fi-tap-text text-slate-500 leading-snug">⚠ 検査手順（テンプレート）は連絡には書かれていません。上の「検査内容」を読んで、登録画面で選んでください。</div>
                  </div>
                );
              })()}
              {detail.kind === 'arrival' && (
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    {/* 📋 テンプレート列: 組立が選んだ検査手順。回答時に items へ書き戻した分だけ出る */}
                    <thead className="bg-slate-50 text-slate-500"><tr><th className="text-left px-2 py-1.5">指図</th><th className="text-left px-2 py-1.5">品目コード</th><th className="text-left px-2 py-1.5">テンプレート</th><th className="text-left px-2 py-1.5">到着予定</th><th className="text-left px-2 py-1.5">回答者</th><th className="text-left px-2 py-1.5">検査リスト反映</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {(detail.items || []).map((it, i) => (
                        <tr key={i}>
                          <td className="px-2 py-1.5 font-mono font-bold">{it.orderNo}</td>
                          <td className="px-2 py-1.5">{it.model}</td>
                          <td className="px-2 py-1.5 font-bold text-indigo-700">{it.templateName || <span className="text-slate-300 font-normal">—</span>}</td>
                          <td className="px-2 py-1.5">{it.time ? <span className="font-black text-emerald-700">{it.date ? `${String(it.date).slice(5).replace('-', '/')} ` : ''}{it.time}</span> : <span className="text-amber-600 font-bold animate-pulse">待ち</span>}</td>
                          <td className="px-2 py-1.5 text-slate-500">{it.by || '—'}</td>
                          <td className="px-2 py-1.5">
                            {!it.time ? <span className="text-slate-300">—</span> : it.applied ? (
                              <div className="flex flex-col gap-0.5">
                                <span className="text-emerald-700 font-black whitespace-nowrap">✓ 反映済</span>
                                {it.finish?.ts && <span className="text-teal-700 font-bold whitespace-nowrap">🏁 {fmtContactDT(it.finish.ts)} 返信済</span>}
                                {onApplyArrival && <button onClick={() => { onApplyArrival(detail.id, i); setDetailId(null); }} className="fi-tap-text underline text-blue-600 text-left">やり直す</button>}
                              </div>
                            ) : (
                              onApplyArrival ? <button onClick={() => { onApplyArrival(detail.id, i); setDetailId(null); }} className="px-2 py-1 rounded bg-teal-600 hover:bg-teal-700 text-white font-black whitespace-nowrap">反映する</button> : <span className="text-slate-300">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {detail.kind === 'finish' && (
                <div className="border border-indigo-200 rounded-lg overflow-hidden">
                  <div className="px-2 py-1.5 bg-indigo-50 fi-tap-text font-bold text-indigo-700">🏁 「いつ終わりますか？」と聞かれています。終了予定を入れて回答してください。</div>
                  <div className="divide-y divide-slate-100">
                    {(detail.items || []).map((it, i) => {
                      const key = `${detail.id}__${i}`; const dt = finishDraft[key] || {};
                      return (
                        <div key={i} className="px-2 py-2 flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-black text-slate-700">{it.orderNo}</span>
                          <span className="text-xs font-bold text-slate-600 truncate">{it.model}{it.modelText ? <span className="font-normal text-slate-400"> {it.modelText}</span> : null}</span>
                          {it.time ? (
                            <span className="ml-auto font-black text-emerald-700 text-xs">{it.date ? `${String(it.date).slice(5).replace('-', '/')} ` : ''}{it.time} 回答済</span>
                          ) : (
                            <span className="ml-auto flex items-center gap-1.5">
                              <input type="date" value={dt.date || ''} onChange={e => setFinishDraft(p => ({ ...p, [key]: { ...dt, date: e.target.value } }))} className="border border-slate-300 rounded-lg px-1.5 py-1 text-xs" />
                              <input type="time" value={dt.time || ''} onChange={e => setFinishDraft(p => ({ ...p, [key]: { ...dt, time: e.target.value } }))} className="border border-slate-300 rounded-lg px-1.5 py-1 text-xs" />
                              <button disabled={!dt.time} onClick={() => answerFinish(detail, i)} className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-black disabled:opacity-40">回答</button>
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <ContactThread req={detail} mySide="app" onAdd={t => addComment(detail, t)} />
            </div>
            <div className="px-4 py-3 border-t border-slate-200 flex gap-2 justify-end shrink-0">
              <button onClick={() => { if (window.confirm('この連絡を削除しますか？（履歴からも消えます）')) { deleteData('contact_requests', detail.id); setDetailId(null); } }} className="px-3 py-1.5 rounded-lg text-xs font-bold text-rose-600 hover:bg-rose-50 flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> 削除</button>
              {detail.status === 'waiting' && <button onClick={() => saveData('contact_requests', detail.id, { status: 'canceled' })} className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-500 border border-slate-300 hover:bg-slate-50">取消にする</button>}
              {/* 組立からの連絡に「確認しました」を返す。返した事は組立の「やりとりの履歴」に出る(一方通行にしない)。
                  ⚠choice:'ack' は CONTACT_REPLY_EXTRA_LABELS で「確認しました」と表示される既存の仕組み。 */}
              {detail.kind === 'portalmsg' && !detail.answer && (
                <button onClick={() => saveData('contact_requests', detail.id, { status: 'answered', answer: { choice: 'ack', by: currentUserName || '検査', at: Date.now() } })} className="px-3 py-1.5 rounded-lg text-xs font-black text-white bg-teal-600 hover:bg-teal-700">✅ 確認しました</button>
              )}
              {detail.kind !== 'arrival' && detail.status === 'answered' && <button onClick={() => saveData('contact_requests', detail.id, { status: 'done' })} className="px-3 py-1.5 rounded-lg text-xs font-black text-white bg-emerald-600 hover:bg-emerald-700">対応済みにする</button>}
              {/* 🆕「検査リストに無い品」の連絡。ここが主役のボタン。指図・品目コード・台数はそのまま入るので打ち直しは要らない。 */}
              {/*    ⚠ここでは作らない。登録画面で人がテンプレートを選んで「登録実行」を押したときに作る。 */}
              {detail.kind === 'newlot' && (detail.lotId
                ? <span className="px-3 py-1.5 rounded-lg text-xs font-black text-emerald-700 bg-emerald-50 border border-emerald-300">✓ 検査対象に登録済み</span>
                : (onRegisterLot
                  ? <button onClick={() => { onRegisterLot(detail); setDetailId(null); }} className="px-3 py-1.5 rounded-lg text-xs font-black text-white bg-rose-600 hover:bg-rose-700">この内容で検査対象に登録</button>
                  : null))}
              <button onClick={() => setDetailId(null)} className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-600 border border-slate-300 hover:bg-slate-50">閉じる</button>
            </div>
          </div>
        </div>
      )}
      {showAsk && <ContactAskArrivalModal lots={lots} groups={groups} from={currentUserName} onClose={() => setShowAsk(false)} onSend={(p) => { sendReq(p); setShowAsk(false); }} />}
      {showSend && <ContactSendModal draft={{ kind: 'call', message: '' }} groups={groups} members={contactMembersOf(settings)} chipOptions={settings?.complaintOptions || []} from={currentUserName} lot={null} onClose={() => setShowSend(false)} onSend={(p) => { sendReq(p); setShowSend(false); }} />}
      {showInternal && <ContactInternalModal from={currentUserName} onClose={() => setShowInternal(false)} onSend={sendInternal} />}
      {showPushHelp && <PushHelpModal onClose={() => setShowPushHelp(false)} sideLabel={sideLabel} />}
      {/* 添付写真の拡大。⚠詳細モーダルが z-[95] なので必ずその上(z-[110])。下げると閉じるボタンが押せない。
          ⚠元の写真がそこまで大きくないので max-* のままにする(w-full にすると引き伸ばしてボケるだけ)。 */}
      {zoomImg && (
        <div className="fixed inset-0 z-[110] bg-black/90 flex items-center justify-center p-3" onClick={() => setZoomImg(null)}>
          <img src={zoomImg} alt="" className="max-w-full max-h-full object-contain rounded-lg shadow-lg"/>
          <button onClick={(e) => { e.stopPropagation(); setZoomImg(null); }} className="absolute top-4 right-4 bg-white/20 hover:bg-white/30 text-white rounded-full w-10 h-10 flex items-center justify-center text-xl font-bold">✕</button>
        </div>
      )}
    </div>
  );
};

// 到着予定を「1件だけ大きく出して」知らせるシート。
//   ⚠一覧の行に日付ボタン・時刻ボタン・入力欄を全部並べてはいけない。1台ぶんで画面が縦に伸びて
//     何台も見渡せなくなる(実際「押したら下にすごい広がる」と言われた)。押した1件だけを大きく出す。
//   ⚠module の外に置くこと。render の中で定義すると毎回別物になり、入力途中の値が消える。
const ArrivalSheet = ({
  head = '到着予定を知らせる', orderNo, model, quantity, dueDate, tplLabel,
  current = null, dates = [], times = [], todayStr,
  showQty = true, showDue = true,
  canAskFinish = false, onAskFinish = null, askedFinish = false,
  // 💬到着予定と同じ場所から「ひとこと」を送る(清水さん 2026-08-05)。
  //   例:「RTT-221 を組立に返却したが、これ以上精度が変えられないのでこのまま行く」。
  //   ⚠指図番号か機番を必ず添えられること。到着の時間が決まっていなくても送れること。
  onSendMessage = null, defaultSerial = '',
  submitLabel = 'この時間で知らせる', onSubmit, onClose,
  // 🗑 2026-09-24 清水さん「組立登録用アプリでキャンセル項目も(有給とかで作業出来なくなった場合用)…わかりやすく」。
  //   取り消しは前から「検査から → 到着の返事」の行の右端に在ったが、登録した画面から見えず 無いと思われていた。
  //   → 知らせた予定を開いた時は 画面の一番上に「いま知らせている予定」と「取り消す」を出す。中身は一覧の取り消しと同じ関数(確認あり)。
  onCancel = null,
}) => {
  // 📱ここが組立の **一番よく押す画面**(到着の時間を入れる)。スマホでは押す物を44px以上にする。
  //   ⚠PC(wide)では何も足さない = 今までと1pxも変わらない。
  const { narrow } = useLayout();
  const mTap = narrow ? ' min-h-11' : '';
  const mTapSq = narrow ? ' min-h-11 min-w-11 flex items-center justify-center' : '';
  const t11 = narrow ? 'text-xs' : 'fi-tap-text';
  const [date, setDate] = useState(current?.date || todayStr);
  const [time, setTime] = useState(current?.time || '');
  const [manual, setManual] = useState(false);
  // 💬ひとこと。msg=本文 / serial=機番・番号(指図は上に大きく出ているので、足りないのは機番だけ)
  const [msg, setMsg] = useState('');
  const [serial, setSerial] = useState(defaultSerial || '');
  // 🚚到着の時間 / 💬ひとこと の切替。既定は今までどおり「到着の時間」。
  //   ⚠2026-08-10 清水さん「検査へのひとことはスクロールしないと気づけないのがつらい」。
  //     ひとことの欄はシートの一番下にあり、時刻ボタン・分納の行を全部通り越さないと見えなかった。
  //     別の入口(別ボタン・別画面)は作らない — 同じシートの中で切り替えるだけにする。
  //     「別の入口を作ると誰も見つけられない」は 2026-08-05 に自分で書いた決まり。
  const [tab, setTab] = useState('arrival');
  // 📋押すだけの定型文(清水さん 2026-08-06「何台目を合格にします、みたいな通知を送れるボタン作って」)。
  //   ⚠押した瞬間には送らない。**本文欄に入れて、目で見てから送る**。打ち間違い・誤送信を防ぐため。
  //   ⚠自由記入は今までどおり残す。定型で足りない話はそのまま書き足せる。
  const [unitNo, setUnitNo] = useState(1);
  // 何台目かは「そのロットの台数」の中から選ぶ。台数が分からない時だけ数字で入れてもらう(値は作らない)。
  const unitChoices = Number(quantity) > 0 ? Array.from({ length: Number(quantity) }, (_, i) => i + 1) : [];
  // すでに書いた文は消さずに下へ足す(書き直しになるため)。同じ文の二重押しだけは無視する。
  const addPreset = (text) => setMsg(prev => {
    const base = String(prev || '').trim();
    if (!base) return text;
    if (base.split('\n').includes(text)) return base;
    return `${base}\n${text}`;
  });
  const PRESET_BTN = `text-left px-3 py-2 rounded-xl border-2 border-teal-300 bg-white hover:bg-teal-100 text-sm font-black text-teal-900${mTap}`;
  // ---- 分納(分けて知らせる) --------------------------------------------
  //   清水さん「4台ロットで 9時に2台・12時に1台・17時に1台 を指定して連絡したい」。
  //   ⚠日付は上の共通のものを使い、行には 時刻と台数だけ を置く。
  //     行ごとに日付ボタンを並べると1便で画面が埋まって、何便あるか見渡せなくなる。
  //     日をまたぐ便だけ「別の日」を押して個別に指定する。
  //   ⚠既に到着予定が入っているロットを開いた時は、最初から「分けて知らせる」にしておく。
  //     2026-08-05 清水さん指摘: 1台目を知らせた後に2台目を知らせると、既定が「まとめて1回」に
  //     戻っているせいで1台目を消してしまっていた。1便目は下の行にそのまま出るので、
  //     「＋ もう1便 足す」で2便目を足すだけで済む。まだ何も入っていない時は今までどおり「まとめて1回」。
  const [splitMode, setSplitMode] = useState(() => splitsOf(current).length > 0);
  const [rows, setRows] = useState(() => draftFromArrival(current, { todayStr: current?.date || todayStr, quantity }));
  const setRow = (i, patch) => setRows(rs => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  // 「ほかの時間」を押した便だけ 時計欄を出す。空の --:-- を最初から見せない
  //   (2026-09-08: 空の時計欄が主役に見えて、押せば済む丸札が使われていなかった)。
  const [manualRow, setManualRow] = useState({});
  // 人が台数を触った便。便を足す時の釣り合わせで **この便からは移さない**(人の入力に逆らわない)
  const touchedRef = useRef(new Set());
  const markTouched = (i) => { touchedRef.current.add(i); };
  // 🚨 便を足したら台数も釣り合わせる(純関数 addSplitRow)。
  //   前は [...rs, {qty:1}] と足すだけで、合計が必ず台数を超えて赤字になり、
  //   手で － を押して直すまで送れなかった = 分納が使われない一番の理由。
  const addRow = () => setRows(rs => addSplitRow(rs, quantity, { touched: touchedRef.current, date }));
  const delRow = (i) => setRows(rs => (rs.length <= 1 ? rs : rs.filter((_, k) => k !== i)));
  // 分納の行は「上の共通の日付」を既定にする。行で「別の日」を選んだものはそのまま。
  const rowsWithDate = rows.map(r => ({ ...r, date: r.date || date }));
  const check = validateSplits(rowsWithDate, quantity);

  const ready = splitMode ? check.ok : !!(date && time);
  const dateLabel = dates.find(d => d.value === date)?.label
    || (date ? `${String(date).slice(5).replace('-', '/')}` : '');
  const submit = () => {
    if (!ready) return;
    // ⚠「まとめて1回」で知らせると、いま入っている便は全部この1件に置き換わる。
    //   2026-08-05 清水さん指摘「1台目を入力した後に2台目を入力すると1台目が消える」の直接の入口。
    //   消える中身が実際にある時だけ、消えるものを見せて一度だけ聞く。
    //   何も入っていない時(初回の登録)は今までどおり黙って進む。
    const before = splitsOf(current);
    if (!splitMode && before.length) {
      const nowLabel = before.length > 1 ? formatSplits(before) : `${before[0].time}${before[0].qty ? ` に ${before[0].qty}台` : ''}`;
      if (!window.confirm(`いま入っている到着予定（${nowLabel}）は消えて、${time} の1件だけになります。\n\n1台目を残したまま2台目を足したい時は「🚚 分けて知らせる」を押してください。\n\nこのまま置き換えますか？`)) return;
    }
    // ⚠どちらの形でも呼び出し側には splits で渡す(保存の作り方を1本にするため)
    const splits = splitMode ? rowsWithDate.filter(r => r.time) : [{ date, time, qty: quantity || 0 }];
    // 💬書いたひとことを捨てない。⚠onSubmit がシートを閉じるので、必ずその前に送る。
    if (onSendMessage && msg.trim()) onSendMessage({ message: msg.trim(), serialNo: serial.trim() });
    onSubmit({ date: splits[0].date, time: splits[0].time, splits });
  };
  return (
    <div className="fixed inset-0 z-[97] bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 bg-blue-600 text-white flex items-center gap-2 shrink-0">
          <Truck className="w-5 h-5 shrink-0" />
          <span className="font-black text-lg">{head}</span>
          <button onClick={onClose} className={`ml-auto p-2 -mr-2 hover:bg-white/20 rounded-full${mTapSq}`}><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-4">
          {/* どの製品の話かを、まず大きく */}
          <div>
            <div className="font-mono text-2xl font-black text-slate-800 leading-tight">{orderNo}</div>
            <div className="text-lg font-bold text-slate-700 leading-tight">{model}</div>
            <div className="mt-1 flex items-center gap-2 flex-wrap text-sm text-slate-400">
              {showQty && quantity ? <span>{quantity}台</span> : null}
              {showDue && dueDate ? <span>納期 {fmtDue(dueDate)}</span> : null}
              {tplLabel && <span className="text-indigo-600 font-bold">📋 {tplLabel}</span>}
            </div>
          </div>

          {/* 💬ひとこと への切替。⚠押した先が空っぽに見えないよう、書きかけがある時は緑の点を出す。 */}
          {onSendMessage && (
            <div className="grid grid-cols-2 gap-2">
              {[['arrival', '🚚 到着の時間', 'いつ着くかを知らせる'], ['msg', '💬 検査へ ひとこと', '時間が決まっていなくても送れます']].map(([v, lbl, hint]) => (
                <button key={v} onClick={() => setTab(v)}
                  className={`relative px-3 py-2.5 rounded-2xl border-2 text-left leading-tight ${tab === v ? (v === 'msg' ? 'border-teal-600 bg-teal-50' : 'border-blue-600 bg-blue-50') : 'border-slate-200 hover:border-slate-300 bg-white'}`}>
                  <div className="text-sm font-black text-slate-800">{lbl}</div>
                  <div className={`${t11} text-slate-500`}>{hint}</div>
                  {v === 'msg' && !!msg.trim() && (
                    <span className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-teal-500 ring-2 ring-white" title="書きかけがあります" />
                  )}
                </button>
              ))}
            </div>
          )}

          {tab === 'arrival' && (<>
          {/* 🗑 いま知らせている到着予定と 取り消し(2026-09-24)。知らせた物がある時だけ出す。押す物は44px以上。 */}
          {onCancel && current && current.time ? (
            <div className="rounded-2xl border-2 border-rose-200 bg-rose-50 px-3 py-2.5 flex items-center gap-2 flex-wrap" data-arr-sheet-cancel="1">
              <div className="flex-1 min-w-[10rem] leading-tight">
                <div className={`${t11} font-bold text-rose-700`}>いま検査へ知らせている到着予定</div>
                <div className="text-sm font-black text-slate-800">🚚 {String(current.date || '').slice(5).replace('-', '/')} {current.time}{splitsOf(current).length > 1 ? `（分納${splitsOf(current).length}回）` : ''}</div>
                <div className={`${t11} text-slate-600`}>行けなくなった(有給など)・知らせ間違えた時は 取り消せます。時間を変える時は 下で選び直してください。</div>
              </div>
              <button type="button" onClick={onCancel}
                className="shrink-0 min-h-11 px-4 rounded-xl border-2 border-rose-300 bg-white text-rose-700 text-sm font-black hover:bg-rose-100">🗑 この到着予定を取り消す</button>
            </div>
          ) : null}
          {/* まとめて1回 / 分けて知らせる(分納)。既定は今までどおり「まとめて1回」 */}
          <div className="grid grid-cols-2 gap-2">
            {[[false, '📦 まとめて1回', '全部が同じ時間に着く'], [true, '🚚 分けて知らせる', '9時に2台・12時に1台…']].map(([v, lbl, hint]) => (
              <button key={String(v)} onClick={() => setSplitMode(v)}
                className={`px-3 py-2.5 rounded-2xl border-2 text-left leading-tight ${splitMode === v ? 'border-blue-600 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                <div className="text-sm font-black text-slate-800">{lbl}{v && Number(quantity) >= 2 && <span className="ml-1 text-xs font-bold text-teal-600">・{quantity}台</span>}</div>
                <div className={`${t11} text-slate-500`}>{hint}</div>
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="text-sm font-black text-slate-500">いつ着きますか？{splitMode && <span className="ml-1 font-bold text-slate-400">（この日にちが各便の既定になります）</span>}</div>
            <div className="grid grid-cols-3 gap-2">
              {dates.map(d => (
                <button key={d.key} onClick={() => setDate(d.value)}
                  className={`py-3 rounded-2xl text-sm font-black leading-tight ${date === d.value ? 'bg-blue-600 text-white shadow' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                  <div>{d.short}</div>
                  <div className={`${t11} font-bold opacity-70`}>{d.label.replace(/^[^(]+\(|\)$/g, '')}</div>
                </button>
              ))}
            </div>

            {!splitMode ? (
              <>
                <div className="grid grid-cols-4 gap-2">
                  {times.map(t => (
                    <button key={t} onClick={() => setTime(t)}
                      className={`py-3.5 rounded-2xl text-base font-black ${time === t ? 'bg-blue-600 text-white shadow' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                      {quickTimeLabel(t)}
                    </button>
                  ))}
                </div>
                {/* 簡易選択に無い時刻(13:20 など)は必ず出る。押した時だけ入力欄を出す。 */}
                {!manual
                  ? <button onClick={() => setManual(true)} className={`self-start text-xs font-bold text-blue-600 underline${narrow ? ' inline-flex items-center px-3 min-h-11' : ''}`}>ほかの日・時間を入れる</button>
                  : (
                    <div className="flex items-center gap-2 flex-wrap bg-slate-50 rounded-2xl p-3">
                      <input type="date" value={date} onChange={e => setDate(e.target.value)} className={`border border-slate-300 rounded-xl px-2 py-2 text-sm${mTap}`} />
                      <input type="time" value={time} onChange={e => setTime(e.target.value)} className={`border border-slate-300 rounded-xl px-2 py-2 text-sm font-black${mTap}`} />
                      <button onClick={() => setManual(false)} className={`text-xs font-bold text-slate-400 underline ml-auto${narrow ? ' inline-flex items-center px-3 min-h-11' : ''}`}>とじる</button>
                    </div>
                  )}
              </>
            ) : (
              <div className="flex flex-col gap-2">
                {/* 🧭 初めての人向けの案内。時間を１つも入れていない間だけ出す(入れたら消える)。
                    清水さん 2026-09-08「分納ってこうするんだよみたいに分かりやすく」。
                    ⚠ 数字は入れない(台数と取り違える)。丸３つと矢印だけの絵にする。 */}
                {!rows.some(r => r.time) && (
                  <div className="flex items-center gap-2 px-1 text-xs font-bold text-slate-500" data-split-guide="1">
                    <svg width="72" height="18" viewBox="0 0 72 18" aria-hidden="true" className="shrink-0">
                      <circle cx="9" cy="9" r="7" fill="none" stroke="#2563eb" strokeWidth="2" /><path d="M18 9h8" stroke="#94a3b8" strokeWidth="2" />
                      <circle cx="36" cy="9" r="7" fill="none" stroke="#2563eb" strokeWidth="2" /><path d="M45 9h8" stroke="#94a3b8" strokeWidth="2" />
                      <circle cx="63" cy="9" r="7" fill="none" stroke="#2563eb" strokeWidth="2" />
                    </svg>
                    <span>① 時間を押す → ② 台数を合わせる → ③ もう1便 足す</span>
                  </div>
                )}
                {rows.map((r, i) => (
                  <div key={i} className="rounded-2xl bg-slate-50 p-2.5 flex flex-col gap-2" data-split-row={i}>
                    {/* 1行目: 何便目 + 時刻の丸札(ここが主役)。
                        ⚠ 空の --:-- を最初から見せない。「ほかの時間」を押した便だけ時計欄を出す。
                        ⚠ 時刻ボタンから日付を一緒に送らない(日付→時刻と続けて押すと日付が戻る)。 */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-black text-slate-500 shrink-0">{i + 1}便目</span>
                      {times.map(t => (
                        <button key={t} onClick={() => setRow(i, { time: t })}
                          className={`px-2.5 py-2 rounded-full text-sm font-black ${r.time === t ? 'bg-blue-600 text-white' : 'bg-white border border-slate-300 text-slate-600'}${mTap}${narrow ? ' whitespace-nowrap shrink-0' : ''}`}>
                          {quickTimeLabel(t)}
                        </button>
                      ))}
                      {(manualRow[i] || (r.time && !times.includes(r.time))) && (
                        <input type="time" value={r.time} onChange={e => setRow(i, { time: e.target.value })}
                          className={`border-2 border-slate-200 focus:border-blue-400 rounded-xl px-2 py-2 text-base font-black outline-none w-28${mTap}`} />
                      )}
                      {rows.length > 1 && (
                        <button onClick={() => { delRow(i); touchedRef.current = new Set(); }} className={`ml-auto p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 shrink-0${mTapSq}`} title="この便を消す"><Trash2 className="w-4 h-4" /></button>
                      )}
                    </div>
                    {/* 2行目: 台数 + 別の日 + 🗑(単独の行にしない)。
                        ⚠ 台数を人が触った便は覚えておく(便を足す時の釣り合わせで動かさない)。 */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => { markTouched(i); setRow(i, { qty: Math.max(1, (Number(r.qty) || 1) - 1) }); }} className={`w-9 h-9 rounded-xl bg-white border border-slate-300 font-black text-slate-600${mTapSq}`}>－</button>
                        <input type="number" min="1" value={r.qty} onChange={e => { markTouched(i); setRow(i, { qty: Math.max(0, Number(e.target.value) || 0) }); }}
                          className={`w-12 text-center border-2 border-slate-200 focus:border-blue-400 rounded-xl px-1 py-2 text-base font-black outline-none${mTap}`} />
                        <span className="text-xs font-bold text-slate-500">台</span>
                        <button onClick={() => { markTouched(i); setRow(i, { qty: (Number(r.qty) || 0) + 1 }); }} className={`w-9 h-9 rounded-xl bg-white border border-slate-300 font-black text-slate-600${mTapSq}`}>＋</button>
                      </div>
                      {/* 「ほかの時間」は台数の行に置く。丸札の行に並べると 390px幅で折り返して
                          1行(44px)ぶん背が高くなる(実測 164px → 116px)。 */}
                      {!(manualRow[i] || (r.time && !times.includes(r.time))) && (
                        <button onClick={() => setManualRow(m => ({ ...m, [i]: true }))}
                          className={`text-xs font-bold text-blue-600 underline${narrow ? ' inline-flex items-center px-1 min-h-11' : ''}`}>ほかの時間</button>
                      )}
                      {(r.date && r.date !== date)
                        ? <input type="date" value={r.date} onChange={e => setRow(i, { date: e.target.value })} className={`border border-slate-300 rounded-lg px-1.5 py-1 ${t11}${mTap}`} />
                        : <button onClick={() => setRow(i, { date: date })} className={`${t11} font-bold text-blue-600 underline${narrow ? ' inline-flex items-center px-1.5 min-h-11' : ''}`}>別の日にする</button>}
                    </div>
                  </div>
                ))}
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={addRow} disabled={rows.length >= MAX_SPLITS}
                    className={`px-3 py-2 rounded-xl bg-blue-50 text-blue-700 text-sm font-black disabled:opacity-40${mTap}`}>＋ もう1便 足す</button>
                  <span className={`text-xs font-black ${!check.ok ? 'text-rose-600' : (quantity && check.short === 0 ? 'text-emerald-600' : 'text-slate-500')}`}>
                    合計 {check.total}台{quantity ? ` / この指図 ${quantity}台` : ''}
                    {check.ok && quantity && check.short === 0 ? ' ✓' : ''}
                    {check.ok && check.short > 0 ? `（あと ${check.short}台 ぶんは未定）` : ''}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* 選んだ内容を大きく読み上げる(押し間違いをここで気づける) */}
          <div className={`rounded-2xl px-4 py-3 text-center ${ready ? 'bg-blue-50 text-blue-800' : 'bg-slate-50 text-slate-400'}`}>
            {!splitMode
              ? (ready
                ? <span className="text-lg font-black">{dateLabel} {quickTimeLabel(time)} に到着予定</span>
                : <span className="text-sm font-bold">日にちと時間をえらんでください</span>)
              : (check.ok
                // ⚠日をまたぐ分納があるので、確認文は **便ごとに日付を出す**。
                //   今までは時刻の文字だけで並べ替えていたため、8/5 15:00 と 8/6 10:00 が
                //   「10:00 → 15:00」の逆順に見え、8/6 の日付も出ていなかった。
                //   splitsOf は日付+時刻の本当の順に並べ替えてくれるので、それに任せる。
                ? <span className="text-base font-black">{formatSplits(splitsOf({ splits: rowsWithDate.filter(r => r.time) }), { withDate: true, max: MAX_SPLITS })} で到着予定</span>
                : <span className="text-sm font-bold text-rose-600">{check.reason}</span>)}
          </div>
          {current?.time && (
            <div className="text-xs text-slate-400 text-center">
              {/* ⚠分納は便ごとに日付を出す。頭の日付は「一番早い便」でしかなく、別の日の便が隠れる */}
              いま登録されているのは {splitsOf(current).length > 1
                ? formatSplits(splitsOf(current), { withDate: true, max: MAX_SPLITS })
                : `${String(current.date || '').slice(5).replace('-', '/')} ${current.time}`} です（このまま知らせると上書きされます）
            </div>
          )}
          {current?.finish?.ts && (
            <div className="text-xs font-bold text-teal-700 bg-teal-50 rounded-xl px-3 py-2 text-center">🏁 検査の終了予定 {fmtContactDT(current.finish.ts)} と返事をもらっています</div>
          )}
          </>)}
          {/* 💬検査へのひとこと。時間を知らせるのと同じシートに置く(別の入口を作ると誰も見つけられない)。
              ⚠指図番号は画面の一番上に大きく出ているので、ここで足すのは機番だけ。
                番号の無い連絡は現場で使えない(どの台の話か決まらない)。 */}
          {onSendMessage && tab === 'msg' && (
            <div className="rounded-2xl border-2 border-teal-200 bg-teal-50/50 p-3 flex flex-col gap-2">
              <div className="text-sm font-black text-teal-800">💬 検査へひとこと（任意）</div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-slate-500 shrink-0">機番・番号</span>
                <input value={serial} onChange={e => setSerial(e.target.value)} placeholder="例) RTT-221"
                  className={`flex-1 min-w-0 border-2 border-slate-200 focus:border-teal-400 rounded-xl px-2.5 py-2 text-base font-black outline-none${mTap}`} />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="fi-tap-text font-black text-slate-500">よく使う文（押すと下の欄に入ります。まだ送りません）</div>
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="fi-tap-text font-black text-slate-500 shrink-0">何台目？</span>
                  {unitChoices.length > 0
                    ? unitChoices.map(n => (
                      <button key={n} onClick={() => setUnitNo(n)}
                        className={`w-8 h-8 rounded-lg text-sm font-black ${unitNo === n ? 'bg-teal-600 text-white' : 'bg-white border border-slate-300 text-slate-600 hover:bg-slate-50'}${mTapSq}`}>{n}</button>
                    ))
                    : (
                      <>
                        <input type="number" min="1" value={unitNo} onChange={e => setUnitNo(Math.max(1, Number(e.target.value) || 1))}
                          className={`w-16 border-2 border-slate-200 focus:border-teal-400 rounded-xl px-2 py-1.5 text-base font-black outline-none${mTap}`} />
                        <span className="fi-tap-text text-slate-400">台数が分からないので、数字で入れてください</span>
                      </>
                    )}
                </div>
                <div className="grid gap-1.5">
                  <button onClick={() => addPreset(`${unitNo}台目を合格にします`)} className={PRESET_BTN}>✅ {unitNo}台目を合格にします</button>
                  <button onClick={() => addPreset('このまま行きます（これ以上 精度が出ません）')} className={PRESET_BTN}>🙆 このまま行きます（これ以上 精度が出ません）</button>
                  <button onClick={() => addPreset(`${unitNo}台目は 修正して返します`)} className={PRESET_BTN}>🔧 {unitNo}台目は 修正して返します</button>
                </div>
              </div>
              <textarea value={msg} onChange={e => setMsg(e.target.value)} rows={3}
                placeholder="例) 組立に返却しましたが、これ以上精度が変えられないのでこのまま行きます"
                className="w-full border-2 border-slate-200 focus:border-teal-400 rounded-xl px-3 py-2 text-sm outline-none" />
              <div className="fi-tap-text text-slate-500">この指図（{orderNo}）に付けて検査へ送ります。到着の時間を入れなくても、これだけ送れます。</div>
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-slate-100 flex items-center gap-2 shrink-0">
          {canAskFinish && (
            <button onClick={onAskFinish} disabled={askedFinish}
              className={`px-3 py-3 rounded-2xl text-sm font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-40 shrink-0${mTap}`}
              title="この製品の検査がいつ終わるか、検査側に聞きます">🏁 いつ終わる？</button>
          )}
          {/* 💬だけ送る = 到着の時間が決まっていなくても連絡できる。返却品はまさにこれ。
              ⚠開いているタブで主役を入れ替える。「いま押すボタン」が一番大きい状態を保つ。 */}
          {onSendMessage && (
            <button disabled={!msg.trim()} onClick={() => onSendMessage({ message: msg.trim(), serialNo: serial.trim() })}
              className={`rounded-2xl font-black text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-40 ${tab === 'msg' ? 'flex-1 py-3.5 text-base' : 'px-3 py-3 text-sm shrink-0'}${mTap}`}
              title="到着の時間は入れずに、ひとことだけ検査へ送ります">💬 {tab === 'msg' ? 'ひとことを送る' : '送る'}</button>
          )}
          {/* ⚠ひとことのタブでは、到着の時間を選んでいる時だけ出す。
              時間を選んでいないのに「知らせる」が並ぶと、何が送られるのか分からない。
              押した時は submit() が ひとことも一緒に送る(上の submit を参照)。 */}
          {(tab === 'arrival' || ready) && (
            <button disabled={!ready} onClick={submit}
              title={tab === 'msg' ? '選んだ到着の時間と、書いたひとことを一緒に送ります' : undefined}
              className={`rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-black disabled:opacity-40 disabled:hover:bg-blue-600 ${tab === 'msg' ? 'px-3 py-3 text-sm shrink-0' : 'flex-1 py-3.5 text-base'}${mTap}`}>
              {tab === 'msg' ? '🚚 時間も知らせる' : (splitMode ? (rowsWithDate.filter(r => r.time).length === 0 ? '時間を選んでください' : `${rowsWithDate.filter(r => r.time).length}回に分けて知らせる`) : submitLabel)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// 🆕「検査リストに無いもの」を組立から検査へ知らせるシート。
//   ⚠ArrivalSheet は流用できない。あれは「ロットがもうある」前提で、指図・品目コード・台数を **出すだけ**
//     (入力欄が1つも無い)。しかも渡す中身を作る所でロットが引けないと null を返す作りなので、
//     検査リストに無い物ではそもそも画面が出ない。だから別の部品として新しく作る。
//   ⚠module の外に置くこと。render の中で定義すると毎回別物になり、入力途中の値が消える。
// 🔎 「なぜ一覧に無いか」の札(2026-09-16)。文は domain/progressSheet.js の explainMissingOrder ただ1本。
//   組立のポータル(検索して0件の時)と、検査側の 🆕 の連絡の両方で使う。showOpen=true なら「在ります」も出す。
const MissingOrderHint = ({ orderNo, lots = [], settings = null, showOpen = false }) => {
  const why = explainMissingOrder({ orderNo, lots, importLast: settings?.progressImportLast || null });
  if (!why) return null;
  if (why.kind === 'open' && !showOpen) return null;
  const cls = why.kind === 'open' ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-amber-300 bg-amber-50 text-amber-900';
  return <div data-missing-order-hint={why.kind} className={`fi-tap-text rounded-xl border px-3 py-2 leading-snug ${cls}`}>{why.text}</div>;
};

const NewLotSheet = ({ models = [], dates = [], times = [], todayStr, onSubmit, onClose }) => {
  // 📱スマホでは押す物を44px以上に。⚠PC(wide)では何も足さない = 今までと1pxも変わらない。
  const { narrow } = useLayout();
  const mTap = narrow ? ' min-h-11' : '';
  const mTapSq = narrow ? ' min-h-11 min-w-11 flex items-center justify-center' : '';
  const t11 = narrow ? 'text-xs' : 'fi-tap-text';
  const [orderNo, setOrderNo] = useState('');
  const [model, setModel] = useState('');
  const [qty, setQty] = useState(1);
  const [message, setMessage] = useState('');
  const [dueDate, setDueDate] = useState('');
  // 到着予定は任意。押した時だけ日付・時刻を出す(「まだ分からない」でも送れるようにするため)。
  const [arrOn, setArrOn] = useState(false);
  const [date, setDate] = useState(todayStr);
  const [time, setTime] = useState('');
  const [manual, setManual] = useState(false);
  // 二度押しで同じ申告が2件できるのを防ぐ。⚠送るのをやめた時は必ず戻す(押せないまま固まらせない)。
  const [sending, setSending] = useState(false);
  const ready = !!(orderNo.trim() && model.trim() && (Number(qty) || 0) > 0 && message.trim());
  const submit = () => {
    if (!ready || sending) return;
    setSending(true);
    const ok = onSubmit({
      orderNo: orderNo.trim(), model: model.trim(), quantity: Number(qty) || 1,
      message: message.trim(), dueDate: dueDate || '',
      date: (arrOn && time) ? (date || todayStr) : '',
      time: (arrOn && time) ? time : '',
    });
    // 「同じ指図がもうあります」の確認でやめた時は false が返る。押せる状態に戻す。
    if (ok === false) setSending(false);
  };
  return (
    <div className="fixed inset-0 z-[97] bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 bg-rose-600 text-white flex items-center gap-2 shrink-0">
          <Truck className="w-5 h-5 shrink-0" />
          <span className="font-black text-lg">検査リストに無いものを知らせる</span>
          <button onClick={onClose} className={`ml-auto p-2 -mr-2 hover:bg-white/20 rounded-full${mTapSq}`}><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-4">
          <div className="fi-tap-text text-slate-500 bg-rose-50 rounded-2xl px-3 py-2.5 leading-relaxed">
            検査の一覧に出てこない物（急な追加・客先立会い分など）を、この内容のまま検査へ送ります。<br />
            検査側は受け取った内容を<b>そのまま検査対象として登録</b>できます（指図・品目コード・台数を打ち直す必要はありません）。
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-black text-slate-500">指図番号<span className="ml-1 fi-tap-text font-black text-rose-600">必須</span></span>
            <input value={orderNo} onChange={e => setOrderNo(e.target.value)} placeholder="例: 123456"
              className="border-2 border-slate-200 focus:border-rose-400 rounded-2xl px-3 py-3 text-lg font-mono font-black outline-none" />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-black text-slate-500">品目コード<span className="ml-1 fi-tap-text font-black text-rose-600">必須</span></span>
            <input value={model} onChange={e => setModel(e.target.value)} list="newlot-model-options" placeholder="品目コードを入れてください"
              className="border-2 border-slate-200 focus:border-rose-400 rounded-2xl px-3 py-3 text-lg font-black outline-none" />
            <datalist id="newlot-model-options">{models.map(m => <option key={m} value={m} />)}</datalist>
            <span className="fi-tap-text text-slate-400 leading-snug">今の検査リストにある品目コードが候補に出ます（打ち間違いを減らすため）。候補に無い品目コードは、そのまま打ってかまいません。</span>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-black text-slate-500">台数<span className="ml-1 fi-tap-text font-black text-rose-600">必須</span></span>
            <div className="flex items-center gap-2">
              <button onClick={() => setQty(v => Math.max(1, (Number(v) || 1) - 1))} className="w-12 h-12 rounded-2xl bg-slate-100 border border-slate-300 text-xl font-black text-slate-600">−</button>
              <input type="number" min="1" value={qty} onChange={e => setQty(Math.max(1, Number(e.target.value) || 1))}
                className="w-20 text-center border-2 border-slate-200 focus:border-rose-400 rounded-2xl px-1 py-3 text-lg font-black outline-none" />
              <span className="text-sm font-bold text-slate-500">台</span>
              <button onClick={() => setQty(v => (Number(v) || 0) + 1)} className="w-12 h-12 rounded-2xl bg-slate-100 border border-slate-300 text-xl font-black text-slate-600">＋</button>
            </div>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-black text-slate-500">何を検査してほしいですか？<span className="ml-1 fi-tap-text font-black text-rose-600">必須</span></span>
            <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3}
              placeholder="例: 外観と寸法だけ見てほしい / 客先立会い分 / 前に不具合が出た所を重点で"
              className="border-2 border-slate-200 focus:border-rose-400 rounded-2xl px-3 py-3 text-sm outline-none leading-relaxed" />
            <span className="fi-tap-text text-slate-400 leading-snug">検査のテンプレート名は分からなくて大丈夫です。ふだんの言葉のまま書いてください（どのテンプレートを使うかは検査側で選びます）。</span>
          </label>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-black text-slate-500">納期<span className="ml-1 fi-tap-text font-bold text-slate-400">任意</span></span>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={`border border-slate-300 rounded-xl px-2 py-2 text-sm${mTap}`} />
            {dueDate && <button onClick={() => setDueDate('')} className={`${t11} font-bold text-slate-400 underline${narrow ? ' inline-flex items-center px-3 min-h-11' : ''}`}>消す</button>}
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-black text-slate-500">いつ着きますか？<span className="ml-1 fi-tap-text font-bold text-slate-400">任意</span></span>
              <button onClick={() => setArrOn(v => !v)}
                className={`px-3 py-1.5 rounded-full text-xs font-black ${arrOn ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}${mTap}`}>
                {arrOn ? '✓ 到着予定も知らせる' : '到着予定も知らせる'}
              </button>
              <span className="fi-tap-text text-slate-400">まだ分からなければ、入れずに送ってかまいません</span>
            </div>
            {arrOn && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-3 gap-2">
                  {dates.map(d => (
                    <button key={d.key} onClick={() => setDate(d.value)}
                      className={`py-3 rounded-2xl text-sm font-black leading-tight ${date === d.value ? 'bg-blue-600 text-white shadow' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                      <div>{d.short}</div>
                      <div className={`${t11} font-bold opacity-70`}>{d.label.replace(/^[^(]+\(|\)$/g, '')}</div>
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {times.map(t => (
                    <button key={t} onClick={() => setTime(t)}
                      className={`py-3.5 rounded-2xl text-base font-black ${time === t ? 'bg-blue-600 text-white shadow' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                      {quickTimeLabel(t)}
                    </button>
                  ))}
                </div>
                {!manual
                  ? <button onClick={() => setManual(true)} className={`self-start text-xs font-bold text-blue-600 underline${narrow ? ' inline-flex items-center px-3 min-h-11' : ''}`}>ほかの日・時間を入れる</button>
                  : (
                    <div className="flex items-center gap-2 flex-wrap bg-slate-50 rounded-2xl p-3">
                      <input type="date" value={date} onChange={e => setDate(e.target.value)} className={`border border-slate-300 rounded-xl px-2 py-2 text-sm${mTap}`} />
                      <input type="time" value={time} onChange={e => setTime(e.target.value)} className={`border border-slate-300 rounded-xl px-2 py-2 text-sm font-black${mTap}`} />
                      <button onClick={() => setManual(false)} className={`text-xs font-bold text-slate-400 underline ml-auto${narrow ? ' inline-flex items-center px-3 min-h-11' : ''}`}>とじる</button>
                    </div>
                  )}
                {/* ⚠分納(何時に何台)はここでは作らない。検査対象に登録されたあとは、いつもの
                    「到着予定を知らせる」から便ごとに入れ直せる。同じ入力欄を2つ作らない。 */}
                <div className="fi-tap-text text-slate-400 leading-snug">分けて着く（分納）ときは、検査対象に登録されたあとに「到着予定を知らせる」から便ごとに入れ直せます。</div>
              </div>
            )}
          </div>

          {/* 送る中身を大きく読み上げる(押し間違い・入れ忘れをここで気づける) */}
          <div className={`rounded-2xl px-4 py-3 text-center ${ready ? 'bg-rose-50 text-rose-800' : 'bg-slate-50 text-slate-400'}`}>
            {ready
              ? <span className="text-base font-black leading-snug">{orderNo.trim()} / {model.trim()} / {Number(qty) || 1}台{(arrOn && time) ? ` / 🚚 ${String(date || todayStr).slice(5).replace('-', '/')} ${quickTimeLabel(time)}` : ''} を知らせます</span>
              : <span className="text-sm font-bold">指図番号・品目コード・台数・検査内容 の4つを入れてください</span>}
          </div>
        </div>
        <div className="px-5 py-4 border-t border-slate-100 flex items-center gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-3.5 rounded-2xl text-sm font-bold text-slate-500 bg-slate-100 hover:bg-slate-200 shrink-0">やめる</button>
          <button disabled={!ready || sending} onClick={submit}
            className="flex-1 py-3.5 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white text-base font-black disabled:opacity-40 disabled:hover:bg-rose-600">
            {sending ? '送っています…' : 'この内容で検査へ知らせる'}
          </button>
        </div>
      </div>
    </div>
  );
};

// あっち(前後工程)用ポータル: 限定表示。修正依頼へのワンタップ返信+到着予定の時間登録ができる。
//   ⚠ここは「協力してくれている相手」に見せる画面。こちらの状況(誰が何をしていて何時に終わるか)まで
//     見えるようにして、相手が段取りを組めるようにする = もらった協力に返せるものを増やす、が狙い。
//   ⚠画面の作りは「①返事が要るもの ②到着予定を知らせる(主役) ③検査からの情報」の3つだけに絞る。
//     一度に全部を並べると、いちばんやってほしい「到着予定を知らせる」が埋もれる。
// 🏁 組立が一番知りたいのは「自分がいつ動けるか」＝ **終わる時刻**。だからそれを一番大きく出す。
//   ⚠⚠ ここでは1つも計算しない。数字も言い回しも finishEta / finishEtaView が作った物をそのまま並べるだけ。
//     （画面で足し算を書くと、2アプリで違う数字が出て相手工程が振り回される）
//   ⚠ 並びは決まり: ① 止まっているなら**それを先に** ② 終わる時刻(一番大きい字) ③ 出どころ ④ いま何をしているか
//   ⚠ 最終検査アプリの同じ場所と **同じ言葉・同じ並び**。片方だけ直さない。
//   ⚠ コンポーネントを描画関数の中で作らない為、ここ(モジュールの一番外)に置く。
const FinishEtaBlock = ({ eta = null, fmtTime = null }) => {
  const v = finishEtaView(eta, { fmtTime });
  const bigColor = v.kind === 'eta' ? 'text-indigo-700' : v.kind === 'done' ? 'text-emerald-700' : 'text-slate-400';
  return (
    <div className="mt-1.5">
      {v.pausedText
        ? <div className="text-sm font-black text-amber-700">{v.pausedText}</div>
        : null}
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-xs font-black text-slate-400 shrink-0">🏁 終わり</span>
        <span className={`text-xl font-black ${bigColor}`}>{v.headline}</span>
        {v.headlineNote
          ? <span className="text-xs font-black text-slate-500">{v.headlineNote}</span>
          : null}
      </div>
      {v.whyText
        ? <div className="text-xs font-bold text-slate-500">{v.whyText}</div>
        : null}
      {v.basisLines.map((t, i) => <div key={i} className="text-xs text-slate-400">{t}</div>)}
      {v.nowText
        ? <div className="text-xs text-slate-400">いま検査しているところ: {v.nowText}</div>
        : null}
    </div>
  );
};

const ContactPortal = ({ lots, contactRequests, arrivalTimes, saveData, settings, pushTokens = [], notifyPush = null, deleteData = null, templates = [], workers = [], estimateSecOf = null, onSendFeedback = null, controllers = [], orderMotors = [],
  // 💡アプリへの要望箱と 📣更新のお知らせ。⚠組立の人にも同じものを見せる(片方だけにすると必ず不公平になる)
  appFeedback = [], appNotices = [], contactShared = null, onFeedbackComment = null, onFeedbackAgree = null }) => {
  // 📅 工場の暦(祝日表)。🚨 hooks はガードより上。
  //   ⚠ 連絡ポータルは共通の棚(contactShared)を既に持っているので、そこから直に読める。
  //     入れ物(context)からも読めるが、**同じ値を2つの道から取らない**ためここは棚1本にする。
  const factoryCalWs = contactShared?.factoryCalendar || null;
  const groups = contactGroupsOf(settings);
  const sideLabel = contactSideLabel(settings);
  const tplName = (lot) => (templates || []).find(t => t.id === lot?.templateId)?.name || '';
  const lotById = useMemo(() => { const m = {}; (lots || []).forEach(l => { if (l && l.id) m[l.id] = l; }); return m; }, [lots]);
  const tplNameForItem = (it) => { const l = lotById[it?.lotId]; return l ? tplName(l) : ''; };
  // 班の決め方: ①URLの ?group=(③の統合ポータルが渡してくる。組立に班を二度選ばせないため) ②この端末の前回の選択
  const [group, setGroup] = useState(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('group');
      if (q && q.trim()) return q.trim();
      return localStorage.getItem('renrakuGroup') || '';
    } catch (e) { return ''; }
  });
  const [name, setName] = useState(() => { try { return localStorage.getItem('renrakuName') || ''; } catch (e) { return ''; } });
  const [showPushCfg, setShowPushCfg] = useState(false);
  const [showPushHelp, setShowPushHelp] = useState(false);
  const [zoomImg, setZoomImg] = useState(null); // 添付写真(不具合報告)の拡大表示
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNowTick(Date.now()), 30000); return () => clearInterval(t); }, []);
  const [q, setQ] = useState('');
  const [commentDraft, setCommentDraft] = useState({});
  const [showAnswered, setShowAnswered] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false); // 💡アプリへの要望
  // 開いているシート: {kind:'lot', lot} = 自発登録 / {kind:'req', req, idx} = 依頼への回答
  const [sheet, setSheet] = useState(null);
  // 🆕「検査リストに無いものを知らせる」シートの入切。
  //   ⚠上の sheet に相乗りさせない。sheet の中身を作る所は「ロットが引けなければ null」なので、
  //     検査リストに無い物では画面が出ない。だから独立した入切で持つ。
  const [showNewLot, setShowNewLot] = useState(false);
  // 「検査から」のカードで今どれを見ているか。
  // 🏁 既定は「いつ終わるか」(＝旧「検査の今」)。
  //   ⚠⚠ 2026-08-16 清水さん「いつ終わるかの記載がない」。調べたら **物は最初から在った**。
  //     出ていなかったのではなく、**4つ並んだタブの3番目**で、指で開かないと出なかっただけ。
  //     だから **新しい置き場所を作らない**。既に在るタブを先頭に出して、最初から開いておく。
  //   ⚠「検査の今を見せる」がOFFの現場ではそのタブ自体が存在しないので 'done' から始める。
  const [infoTab, setInfoTab] = useState(() => (workStatusEnabled(settings) ? 'now' : 'done'));
  // ⚠設定が後から OFF に変わっても infoTab は 'now' のまま残る → タブも中身も無い＝カードが白紙になる。
  //   その時だけ 'done' として扱う。**state は書き換えない**(描画中に setState すると輪になる)。
  const infoTabEff = (infoTab === 'now' && !workStatusEnabled(settings)) ? 'done' : infoTab;
  // 表示期間。溜まり続けるものは既定「2日分」で切る(古い分で今日の話が埋もれるのを防ぐ)。
  const [noticeRange, setNoticeRange] = useState(DEFAULT_RANGE_ID); // 検査完了のお知らせ
  const [histRange, setHistRange] = useState(DEFAULT_RANGE_ID);     // やりとりの履歴
  const [arrRange, setArrRange] = useState(DEFAULT_RANGE_ID);       // 教えた到着予定(返事待ちは期間に関係なく出す)
  // 📱 PC/スマホの並べ方。⚠**新しい判定を作らない**。アプリ全体で1つの決め方(domain/layoutMode.js)を使う。
  //   ⚠ここは前まで **幅だけ** を見ていた(isWideLayout)。スマホを横に倒すと 844×390 で、
  //     幅は足りていても縦が 390px しか無い。1280×400 のような細長い窓では
  //     「広い版(2列)」が出て何も読めなかった。layoutInfo は高さも見て short を返す。
  //   ⚠narrow は short(スマホ横)を **含む**。分岐は必ず wide / narrow で書く事
  //     (`layout === 'narrow'` で書くとスマホ横が漏れる)。
  //   ⚠保存先の鍵は今までと同じ 'renrakuLayout'。この画面で選んだ物は検査アプリ側にも効く。
  const { wide, narrow, label: layoutLabel, cycle: cycleLayout } = useLayout();
  const portalCfg = settings?.contactPortal || {};
  const showQty = portalCfg.showQuantity !== false;
  const showDue = portalCfg.showDueDate !== false;
  const todayStr = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  // 🚚 ⚠ここは組立ポータル(組立が見る画面)。**わざと buildArrivalByLot を使わない**(原本だけを引く)。
  //   検査側の画面は「反映した先のロットにも同じ到着予定を見せる」ようにしてあるが、
  //   ここで同じことをすると、組立の「まだ教えていないもの」の一覧と赤い数字が、
  //   **検査が反映した瞬間に黙って減る**。教えたかどうかを決めるのは組立であって検査ではない。
  //   (組立が別のロットにも自分から時間を知らせたい時に、その入口が消えてしまう)
  //   ⚠検査側と組立側で意図的に規則が違う。片方を直す時はもう片方も見ること。
  const arrivalByLot = useMemo(() => { const m = {}; (arrivalTimes || []).forEach(a => { if (a && a.id) m[a.id] = a; }); return m; }, [arrivalTimes]);
  // 修正・呼出の受信箱。到着/終了予定/完了連絡/社内連絡は専用レーンで扱うので、この一覧(3択返信)からは除外する。
  // ⚠ここも受け皿。組立が自分で出した連絡(portalmsg)を外し忘れると、送った本人の受信箱に
  //   「すぐ行く/10分後/…」の3択が出る(自分の連絡に自分で返事することになる)。
  //   ⚠🆕 newlot(検査リストに無いものの連絡)は **組立からこちらが出すもの**。ここで除外し忘れると、
  //     自分が出した申告が自分の受信箱に「すぐ行く/10分後」の3択カードとして出てしまい、
  //     さらに todo レーンの未読(赤い数字)まで勝手に増える。必ず除外する。
  const isRepairKind = (r) => r && r.kind !== 'arrival' && r.kind !== 'finish' && r.kind !== 'complete' && r.kind !== 'internal' && r.kind !== 'portalmsg' && r.kind !== 'newlot';
  const inbox = useMemo(() => (contactRequests || []).filter(r => isRepairKind(r) && r.to === group && r.status === 'waiting').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), [contactRequests, group]);
  const answeredRecent = useMemo(() => (contactRequests || []).filter(r => isRepairKind(r) && r.to === group && r.status === 'answered' && (nowTick - (r.answer?.at || 0)) < 24 * 3600 * 1000).sort((a, b) => (b.answer?.at || 0) - (a.answer?.at || 0)), [contactRequests, group, nowTick]);
  // 検査側からの「検査完了」お知らせ。ワンタップ「確認しました」で検査側に既読が返る。
  //   ⚠ずっと溜まるので既定は2日分。件数と「隠した件数」を必ず出す(黙って切らない)。
  const completeAll = useMemo(() => (contactRequests || []).filter(r => r && r.kind === 'complete' && r.to === group && r.status !== 'canceled').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)), [contactRequests, group]);
  const completeCut = useMemo(() => filterByRange(completeAll, noticeRange, nowTick, r => r.createdAt), [completeAll, noticeRange, nowTick]);
  const completeNotices = completeCut.shown;
  const completeUnread = completeNotices.filter(r => r.needAck !== false && r.status !== 'answered').length;
  const arrivalReqs = useMemo(() => (contactRequests || []).filter(r => r && r.kind === 'arrival' && r.to === group && r.status !== 'canceled' && (r.items || []).some(i => !i.time)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), [contactRequests, group]);
  const arrivalReqCount = useMemo(() => arrivalReqs.reduce((n, r) => n + (r.items || []).filter(i => !i.time).length, 0), [arrivalReqs]);
  // 教えた到着予定と、それに対する検査の返事(いつ終わるか)。「返事したかどうか」を一目で分かるようにする。
  //   ⚠返事待ちのものは期間で切らない。返事が来ていないのに古いから消える、では確認のしようがない。
  const arrivalEntries = useMemo(() => mergeArrivalEntries({ arrivalTimes, contactRequests, group, now: nowTick }), [arrivalTimes, contactRequests, group, nowTick]);
  const arrivalStats = useMemo(() => arrivalReplyStats(arrivalEntries), [arrivalEntries]);
  const finishOn = finishReplyEnabled(settings);
  const arrivalBoard = useMemo(() => {
    const waiting = arrivalEntries.filter(e => !e.replied);
    const repliedCut = filterByRange(arrivalEntries.filter(e => e.replied), arrRange, nowTick, e => e.finish?.at || e.at);
    return { rows: [...waiting, ...repliedCut.shown], hidden: repliedCut.hidden };
  }, [arrivalEntries, arrRange, nowTick]);
  // 検査側が返してくれた「検査終了予定」は下で作る(finishInfos)。バッジの計算はその後に置く。
  // 検査側が返してくれた「検査終了予定」。①到着回答へのお返し ②終了予定を聞いた回答 ③自発登録への返事。48時間以内。
  const finishInfos = useMemo(() => {
    const out = [];
    (contactRequests || []).filter(r => r && r.to === group).forEach(r => {
      if (r.kind === 'arrival') (r.items || []).forEach(it => { if (it && it.finish && it.finish.ts && (nowTick - (it.finish.at || 0)) < 48 * 3600 * 1000) out.push({ orderNo: it.orderNo, model: it.model, ts: it.finish.ts, by: it.finish.by, at: it.finish.at }); });
      if (r.kind === 'finish') (r.items || []).forEach(it => { if (it && it.time && it.at && (nowTick - it.at) < 48 * 3600 * 1000) out.push({ orderNo: it.orderNo, model: it.model, ts: new Date(`${it.date || todayStr}T${it.time}`).getTime(), by: it.by, at: it.at }); });
    });
    (arrivalTimes || []).forEach(a => {
      if (!a || !a.finish || !a.finish.ts || a.viaReq) return;
      if (group && a.group && a.group !== group) return;
      if ((nowTick - (a.finish.at || 0)) >= 48 * 3600 * 1000) return;
      out.push({ orderNo: a.orderNo, model: a.model, ts: a.finish.ts, by: a.finish.by, at: a.finish.at });
    });
    return out.sort((a, b) => (b.at || 0) - (a.at || 0));
  }, [contactRequests, arrivalTimes, group, nowTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ==== 未読バッジ(見たら消える) ==========================================
  //   ⚠⚠ 約束: **画面に出る赤い数字の合計 === アプリアイコン(タスクバー)の数字**。
  //     アイコンに数字がある = 新しい連絡が来た。開いて見たら消える = もう見るものは無い。
  //     だから数えるのは「やることの残り」ではなく「前に見た時より後に届いたもの」。
  //     残っている用事(返事待ちなど)は数字にせず、色の付いた小さな印で出す(消えない数字を出さない)。
  //
  //   ⚠⚠ この画面は ③(組立の統合ポータル)の中に **iframe で入ることがある**。その時は:
  //     ① アイコンの数字を書くのは **一番外側の ③ だけ**。ここでも書くと数字を書く者が2人になり、
  //        どちらが後に走ったかで数字が変わる(= 画面の赤い数字と合わない)。ここは数を報告するだけ。
  //     ② `display:none` の iframe でも `document.hidden` は **false のまま**。そのままだと
  //        組立が一度も見ていない側の数字が勝手に消える。親から「表に出ている」と言われるまで既読にしない。
  //     決まりごとは src/domain/portalBridge.js。
  const embedded = useMemo(() => (typeof window !== 'undefined' ? isEmbedded(window) : false), []);
  const [embActive, setEmbActive] = useState(false); // 親から聞いた「今この画面が表に出ているか」
  const embHeardRef = useRef(false);                 // 親から一度でも合図が来たか
  const embSinceRef = useRef(Date.now());
  const [embGrace, setEmbGrace] = useState(false);   // 古い③(合図を送らない版)への保険が効いたか
  useEffect(() => {
    if (!embedded || typeof window === 'undefined') return undefined;
    const on = (e) => {
      const m = parseActiveMessage(e.data);
      if (!m) return;             // 知らない形の message は捨てる
      embHeardRef.current = true;
      setEmbActive(m.active);
    };
    window.addEventListener('message', on);
    // ⚠合図が一度も来ないまま黙ると「いくら見ても既読にならない」画面になる。時間で通す。
    const t = setTimeout(() => setEmbGrace(true), 8100);
    return () => { window.removeEventListener('message', on); clearTimeout(t); };
  }, [embedded]);
  const [seenMap, setSeenMap] = useState(() => { try { return parseSeen(localStorage.getItem(PORTAL_SEEN_LS_KEY)); } catch (e) { return {}; } });
  const saveSeen = useCallback((next) => {
    setSeenMap(next);
    try { localStorage.setItem(PORTAL_SEEN_LS_KEY, JSON.stringify(next)); } catch (e) { /* 保存できなくても表示は動く */ }
  }, []);
  // この端末で初めて開いた班は「今」を起点にする(過去の連絡が全部未読になって何十件も出るのを防ぐ)
  useEffect(() => {
    if (!group) return;
    const next = initSeen(seenMap, group, UNREAD_LANES, Date.now());
    if (next !== seenMap) saveSeen(next);
  }, [group, seenMap, saveSeen]);
  // レーンに入れるもの。⚠重ならせない(同じ連絡を2レーンで数えると合計がアイコンとズレる)
  const todoItems = useMemo(() => [
    ...inbox.map(r => ({ at: r.createdAt || 0 })),
    ...arrivalReqs.map(r => ({ at: r.createdAt || 0 })),
  ], [inbox, arrivalReqs]);
  const unread = useMemo(() => laneCounts({
    map: seenMap, group,
    todo: todoItems,
    done: completeNotices.map(r => ({ at: r.createdAt || 0 })),
    finish: finishInfos,
  }), [seenMap, group, todoItems, completeNotices, finishInfos]);
  const unreadTotal = totalNew(unread);
  // アプリアイコンのバッジ。⚠「アプリとしてインストール」した時だけ出る(ブラウザのタブのままだと何も起きない)
  useEffect(() => {
    if (embedded) return;                        // ③ の中にいる時は ③ が唯一の書き手
    if (!('setAppBadge' in navigator)) return;
    try { if (unreadTotal > 0) navigator.setAppBadge(unreadTotal); else navigator.clearAppBadge(); } catch (e) { /* バッジは飾りなので握りつぶす */ }
  }, [unreadTotal, embedded]);
  // ③ へ未読の数を報告する。⚠渡すのは数だけ(連絡の中身は一切渡さない)。
  useEffect(() => {
    if (!embedded || typeof window === 'undefined') return;
    const target = parentOriginOf(document.referrer) || '*';
    try { window.parent.postMessage(buildUnreadMessage({ app: 'product', group, counts: unread, at: Date.now() }), target); }
    catch (e) { /* 届かなくても画面は動く */ }
  }, [embedded, group, unread, unreadTotal]);
  // 見たら既読にする。⚠裏に回っている(画面が見えていない)時は既読にしない = 見ていないのに消えるのを防ぐ。
  const markLaneSeen = useCallback((lane) => {
    if (!lane || !group) return;
    if (!canMarkSeen({
      hidden: typeof document !== 'undefined' && document.hidden,
      embedded, active: embActive, heard: embHeardRef.current,
      sinceMs: embGrace ? Infinity : (Date.now() - embSinceRef.current),
    })) return;
    saveSeen(withSeen(seenMap, group, lane, Date.now()));
  }, [group, seenMap, saveSeen, embedded, embActive, embGrace]);
  // 「返事をお願いします」は画面のいちばん上に常に出ている = 開いた時点で見たとみなす
  useEffect(() => { if (unread.todo > 0) markLaneSeen('todo'); }, [unread.todo, markLaneSeen]);
  // 「検査から」は開いているタブのぶんだけ既読にする
  useEffect(() => { const l = laneOfTab(infoTabEff); if (l && unread[l] > 0) markLaneSeen(l); }, [infoTabEff, unread, markLaneSeen]);
  // 裏から戻ってきた時も、その時点で見えているものを既読にする
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const on = () => {
      if (document.hidden) return;
      if (unread.todo > 0) markLaneSeen('todo');
      const l = laneOfTab(infoTabEff); if (l && unread[l] > 0) markLaneSeen(l);
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [infoTabEff, unread, markLaneSeen]);

  // ==== 検査の今(作業状況) ====
  //   ⚠更新ボタンを押した時だけ作り直す。裏で勝手に入れ替わると、読んでいる行が動いて読めない。
  const wsOn = workStatusEnabled(settings);
  const wsShowName = workStatusShowName(settings);
  const [wsSnap, setWsSnap] = useState(null); // {rows, at}
  const workerNameOf = useCallback((lot) => (workers || []).find(w => w && w.id === lot?.workerId)?.name || '', [workers]);
  const refreshWorkStatus = useCallback(() => {
    // ⚠now は1回だけ取って全部に配る。行ごとに Date.now() を呼ぶと、同じ表の中で基準時刻がズレる。
    const nowMs = Date.now();
    // 🏁 組立に見せる「いつ終わるか」。⚠⚠ **時刻は finishEta ただ1本が作る**。ここでも表でも足し算をしない。
    //   🚨2026-08-16: 前は buildWorkStatusRows にも finishAt を渡していて、**行の並び順だけが別の式**
    //     (見積−経過・人数を見ない・残業込み)で決まっていた。画面の 🏁 と最大15時間ズレる。
    //     → etaOf で finishEta を渡し、並び順の鍵も画面の時刻も同じ値にした。
    //   ⚠目標時間は**このアプリが見積に使っている物と同じ値**(較正値→品目コードグループ→テンプレ既定)を渡す。
    //     渡さないとテンプレの既定値だけで数えてしまい、画面の見積と終了予定が食い違う。
    //     ⚠これは「材料をそろえる」だけ。**終わりの時刻を作っているのは finishEta**。
    //   ⚠人数は「このロットに付いている担当者」だけ。担当が決まっていなければ 0人 →
    //     finishEta が「分かりません(人がいません)」を返す。**それらしい時刻を作らせない為に空で渡す。**
    const ctt = settings?.customTargetTimes || null;
    const mgs = modelGroupsOf(settings);
    const lotForEta = (lot) => (!lot || !Array.isArray(lot.steps) ? lot : {
      ...lot,
      steps: lot.steps.map(s => (s ? { ...s, targetTime: getEffectiveTargetTime(s, lot.model, ctt, mgs) } : s)),
    });
    const etaOf = (l) => finishEta({
      lot: lotForEta(l || null),
      now: nowMs,
      schedule: settings?.workSchedule,
      calendar: factoryCalWs,   // 📅 祝日・全社休業を跨がない
      workers: workerNameOf(l) ? [workerNameOf(l)] : [],
    });
    const rows = buildWorkStatusRows({
      lots, arrivalByLot,
      estimateSecOf: (l) => (estimateSecOf ? (estimateSecOf(l) || 0) : 0),
      elapsedMsOf: getLotElapsedMs,
      etaOf,
      workerNameOf,
      startedAtOf: lotFirstStartMs,
    });
    setWsSnap({ rows, at: nowMs });
  }, [lots, arrivalByLot, settings, estimateSecOf, workerNameOf, factoryCalWs]);
  // 初回だけ自動で出す(開いた瞬間が空だと「壊れている」に見える)。以降は更新ボタンを押した時だけ。
  // 🚨⚠⚠ 2026-08-16 実測で見つけた欠陥: ここは **ロットが1件も届いていない画面を出した直後** に走っていた。
  //   1枚目が「0件」で固まり、wsSnap が埋まるので二度と作り直されない。
  //   → 組立が開くと、いつまでも「いま動いている検査はありません」。**更新を押すまで一生出ない。**
  //   タブが3番目だった頃も同じだったが、ここを既定タブにした事で
  //   **組立が最初に見る画面がまるごと嘘になる**ので、必ず直す必要がある。
  //   ⚠直し方は「材料が届いてから1枚目を作る」だけ。裏で入れ替える仕掛けは足していない
  //     (1枚できたら wsSnap が埋まるので、以降はやはり更新を押した時だけ)。
  //
  // 🚨⚠⚠ 「材料」は**ロットだけではない**。ロットが先に届いて workers がまだの一瞬に1枚目を作ると、
  //   担当がちゃんと付いているのに workerNameOf が空を返し、全行が
  //   **「この検査に付く人がいません」＝ 嘘の理由** で固まる(2026-08-16 実測。実際にこの目で見た)。
  //   担当を名指ししているロットが有るのに workers が1件も来ていない間は、まだそろっていない。
  //   ⚠workers が本当に0件の現場でも止まらないよう、「誰も名指ししていない」なら待たない。
  const wsReady = (lots || []).length > 0
    && ((workers || []).length > 0 || !(lots || []).some(l => l && l.workerId));
  useEffect(() => {
    if (wsOn && !wsSnap && wsReady) refreshWorkStatus();
  }, [wsOn, wsSnap, wsReady, refreshWorkStatus]);
  const wsGroups = useMemo(() => groupRowsByWorker(wsSnap?.rows || []), [wsSnap]);
  // ⚠この画面は「更新を押した時だけ」作り直す静止画。開きっぱなしにすると 🏁 は静かに古くなる。
  //   nowTick は既に30秒ごとに進んでいるので、**新しい仕掛けを足さずに**「何分前の話か」を出せる。
  //   ⚠ここでは終わりの時刻を計算していない。出しているのは「作った時刻からの経過」だけ。
  const wsAgeMin = wsSnap ? Math.max(0, Math.floor((nowTick - wsSnap.at) / 60000)) : 0;
  // このグループがこちら(検査)とやりとりした全履歴(読み取り専用)。到着予定(自発登録)も混ぜる。
  const historyCut = useMemo(() => buildHistory({ contactRequests, arrivalTimes, group, rangeId: histRange, now: nowTick }), [contactRequests, arrivalTimes, group, histRange, nowTick]);
  const history = historyCut.shown.slice(0, 200);
  // 品目コードしぼり込み: null=すべて / {type:'group',id} / {type:'prefix',p}
  const [modelPick, setModelPick] = useState(null);
  const [showPick, setShowPick] = useState(false);
  const openLots = useMemo(() => (lots || []).filter(l => l && l.status !== 'completed'), [lots]);
  const modelFams = useMemo(() => portalModelFamiliesOf(settings), [settings]);
  const modelMap = useMemo(() => portalModelPrefixMapOf(settings), [settings]);
  const pickBuckets = useMemo(() => {
    const byPrefix = {}; const byGroup = {}; const prefixGroup = {};
    openLots.forEach(l => {
      // 「200EクランプAssy」のように英字で始まらない品名もある。頭文字なし=PORTAL_NO_PREFIX として「その他」で必ず拾う。
      const p = portalModelPrefix(l.model) || PORTAL_NO_PREFIX;
      byPrefix[p] = (byPrefix[p] || 0) + 1;
      const g = portalModelGroupOf(l.model, modelFams, modelMap);
      prefixGroup[p] = g;
      byGroup[g] = (byGroup[g] || 0) + 1;
    });
    const prefixesOf = (gid) => Object.keys(byPrefix).filter(p => prefixGroup[p] === gid).sort((a, b) => byPrefix[b] - byPrefix[a] || a.localeCompare(b));
    const gs = modelFams
      .map(g => ({ ...g, count: byGroup[g.id] || 0, prefixes: prefixesOf(g.id) }))
      .filter(g => g.count > 0);
    return { byPrefix, groups: gs, other: { count: byGroup.other || 0, prefixes: prefixesOf('other') } };
  }, [openLots, modelFams, modelMap]);
  // 「まだ時間を教えていない分」を先に出す。相手がやるべき事が上に来る。
  const [onlyTodo, setOnlyTodo] = useState(false);
  // テンプレートの言葉でしぼる(中間/一般/傾斜/回転)。テンプレが何十種類もあるので、品目コードの頭文字だけでは辿り着けない。
  const [tplWord, setTplWord] = useState('');
  const tplWords = useMemo(() => templateWordsOf(settings), [settings]);
  const tplWordCounts = useMemo(() => {
    const m = {};
    tplWords.forEach(w => { m[w] = openLots.filter(l => templateWordMatches(tplName(l), w)).length; });
    return m;
  }, [openLots, tplWords, templates]); // eslint-disable-line react-hooks/exhaustive-deps
  const lotList = useMemo(() => {
    const s = q.trim().toLowerCase();
    return openLots
      .filter(l => !s || String(l.orderNo || '').toLowerCase().includes(s) || String(l.model || '').toLowerCase().includes(s))
      .filter(l => {
        if (!modelPick) return true;
        if (modelPick.type === 'group') return portalModelGroupOf(l.model, modelFams, modelMap) === modelPick.id;
        if (modelPick.type === 'prefix') return (portalModelPrefix(l.model) || PORTAL_NO_PREFIX) === modelPick.p;
        return true;
      })
      .filter(l => !onlyTodo || !(arrivalByLot[l.id]?.time))
      .filter(l => !tplWord || templateWordMatches(tplName(l), tplWord))
      .sort((a, b) => {
        const ta = arrivalByLot[a.id]?.time ? 1 : 0;
        const tb = arrivalByLot[b.id]?.time ? 1 : 0;
        if (ta !== tb) return ta - tb;                                  // 未登録が先
        return (dueMsOf(a.dueDate) ?? Infinity) - (dueMsOf(b.dueDate) ?? Infinity);
      });
  }, [openLots, q, modelPick, modelFams, modelMap, onlyTodo, arrivalByLot, tplWord, templates]); // eslint-disable-line react-hooks/exhaustive-deps
  const LOT_LIST_CAP = 200; // 表示上限(これを超えたら件数を出して知らせる=黙って切らない)
  const lotListShown = lotList.slice(0, LOT_LIST_CAP);
  const todoCount = useMemo(() => openLots.filter(l => !(arrivalByLot[l.id]?.time)).length, [openLots, arrivalByLot]);
  const pickLabel = !modelPick ? 'すべて'
    : modelPick.type === 'prefix' ? modelPick.p
    : (modelFams.find(g => g.id === modelPick.id)?.label || 'その他');
  const byName = name.trim() || group;
  const quickDates = useMemo(() => quickDateOptions(nowTick, 3), [nowTick]);
  const quickTimes = useMemo(() => quickTimesOf(settings), [settings]);
  // 返信・回答は検査側の端末(side:'app')へプッシュ通知(設定済みなら)
  const appLink = (() => { try { return `${window.location.origin}/`; } catch (e) { return ''; } })();
  const reply = (r, choice) => {
    // 「行けない」だけは取り返しがつきにくいので誤タップ防止の確認を挟む
    if (choice === 'no' && !window.confirm('「行けない」と返信します。よろしいですか？')) return;
    saveData('contact_requests', r.id, { status: 'answered', answer: { choice, comment: (commentDraft[r.id] || '').trim(), by: byName, at: Date.now() } });
    setCommentDraft(p => ({ ...p, [r.id]: '' }));
    if (notifyPush) notifyPush({ toSide: 'app', title: `↩ ${contactReplyLabel(choice)}（${byName}）`, body: String(r.message || '').slice(0, 120), link: appLink, tag: `reply-${r.id}` });
  };
  // 検査完了のお知らせに「確認しました」= 検査側に既読を返す(次工程が受け取ったサイン)
  const ackComplete = (r) => {
    saveData('contact_requests', r.id, { status: 'answered', answer: { choice: 'ack', by: byName, at: Date.now() } });
    if (notifyPush) notifyPush({ toSide: 'app', title: `✅ ${sideLabel}が確認: ${r.orderNo || ''} ${r.model || ''}`, body: `${byName} が検査完了を確認しました`, link: appLink, tag: `doneack-${r.id}` });
  };
  // 会話に組立側からコメント追加 → 検査側へ通知。
  const addComment = (r, text) => {
    if (!r) return;
    const c = { id: contactNewCommentId(), by: byName, text, at: Date.now(), side: 'portal' };
    saveData('contact_requests', r.id, { comments: [...(r.comments || []), c] });
    if (notifyPush) notifyPush({ toSide: 'app', title: `💬 ${byName}: ${text.slice(0, 40)}`, body: `${r.orderNo ? `指図${r.orderNo} ` : ''}${String(r.message || '').slice(0, 60)}`, link: appLink, tag: `cmt-${c.id}` });
  };
  // 組立がポータルで表示中の依頼は「見た」= 検査側に既読を返す(初回のみ)。
  useEffect(() => {
    (inbox || []).forEach(r => { if (r && !r.seenPortal) saveData('contact_requests', r.id, { seenPortal: { at: Date.now(), by: byName } }); });
  }, [inbox]); // eslint-disable-line react-hooks/exhaustive-deps
  // ⚠分納(複数便)でも通る形にする。依頼の items[] は今までどおり「1件=1つの日時」なので、
  //   items には **一番早い便** を書き、便の内訳は arrival_times.splits に持たせる
  //   (検査側の既存の表示・集計を1つも壊さないため)。
  const answerArrivalItem = (r, idx, when) => {
    if (!when || !when.time) return;
    const splits = (when.splits && when.splits.length) ? when.splits : [{ date: when.date || todayStr, time: when.time, qty: 0 }];
    const head = splits[0];
    // 📋 テンプレート名も依頼側に書き戻す。検査側の「連絡の詳細」表で、どの手順の物かが見えるようにする。
    //    ⚠ 依頼を作った時点(ContactAskArrivalModal)には入っていないので、回答した時にここで入れる。
    // ⚠⚠ ここが一番ぶつかる所。班の何人かが同じ通知を開いて同時に時間を入れる。
    //   items[] を丸ごと書き戻すと、直前に別の人が入れた回答が消えていた(2026-08-14 発覚)。
    const pat = { date: head.date || todayStr, time: head.time, by: byName, at: Date.now(), splitCount: splits.length, templateName: tplNameForItem((r.items || [])[idx] || {}) };
    const sv = arrivalAnswerSave(r, idx, pat, pat);
    saveData('contact_requests', r.id, { items: sv.items, itemAnswers: sv.itemAnswers, status: sv.answered ? 'answered' : 'waiting' });
    const items = sv.items;
    const it = items[idx];
    // group=どの班からの到着予定か(連絡タブの表で班ごとに見るため) / viaReq=依頼への回答である印(自発登録と区別)
    if (it.lotId) {
      const lot = lotById[it.lotId] || {};
      // 📋 テンプレート(検査手順)も一緒に残す。組立はこの画面で手順を見て選んでいるのに、
      //    到着予定の履歴には指図と品目コードしか残らず「どの手順の物か」が後から分からなかった(清水さん指摘)。
      saveData('arrival_times', it.lotId, buildArrivalDoc({
        lot: { orderNo: it.orderNo || lot.orderNo || '', model: it.model || lot.model || '', quantity: it.quantity || lot.quantity || 0, dueDate: it.dueDate || lot.dueDate || '', templateId: lot.templateId || '' },
        templateName: tplNameForItem(it),
        splits, by: byName, group, viaReq: r.id, now: Date.now(),
      }));
    }
    // ⚠分納は日付付きにする。通知だけ見て段取りする人がいるので、時刻だけだと日またぎが分からない。
    const label = splits.length > 1 ? formatSplits(splits, { withDate: true }) : head.time;
    if (notifyPush) notifyPush({ toSide: 'app', title: `🚚 到着予定: ${it.orderNo || ''} → ${label}`, body: `${byName} が回答しました`, link: appLink, tag: `arr-${r.id}-${idx}` });
    setSheet(null);
  };
  // 💬組立→検査の「ひとこと」。到着予定と同じシートから送る(清水さん 2026-08-05)。
  //   ⚠新しい種類 kind:'portalmsg'。**返事を求めないお知らせ**なので status は 'notice'。
  //     'waiting' にすると検査側の自動フォローが「返信がない」と見なして、
  //     **出した本人(この班)へ**再通知と上司へのエスカレーションを飛ばす。
  //   ⚠to には自分の班を入れる。連絡タブの表と班しぼり込みは r.to を「どの班の話か」として使っており、
  //     相手が自分から登録した到着予定(自発)と同じ約束にそろえる。
  const sendPortalMessage = (lot, { message, serialNo }) => {
    const text = String(message || '').trim();
    if (!text) return;
    const sn = String(serialNo || '').trim();
    const id = newContactId();
    saveData('contact_requests', id, {
      kind: 'portalmsg', to: group, from: byName, side: 'portal',
      lotId: lot?.id || '', orderNo: lot?.orderNo || '', model: lot?.model || '',
      serialNo: sn,                       // 機番・番号(自由文)。書かれなければ空のまま(勝手に埋めない)
      message: text,
      createdAt: Date.now(), status: 'notice',
    });
    if (notifyPush) notifyPush({
      toSide: 'app',
      title: `💬 組立から連絡: ${lot?.orderNo || ''}${sn ? ` 機番${sn}` : ''}`,
      body: `${byName}: ${text}`.slice(0, 200), link: appLink, tag: `pmsg-${id}`,
    });
    setSheet(null);
  };
  const registerArrival = (lot, when) => {
    if (!when || !when.time) return;
    const splits = (when.splits && when.splits.length) ? when.splits : [{ date: when.date || todayStr, time: when.time, qty: lot.quantity || 0 }];
    // 自発登録(頼まれる前に知らせる)。group=どの班が知らせたか / viaReq='' = 依頼への回答ではない
    // 📋 テンプレート名も添える。lot には id しか入っていないので、ここで名前に直して渡す。
    saveData('arrival_times', lot.id, buildArrivalDoc({ lot, templateName: tplName(lot), splits, by: byName, group, viaReq: '', now: Date.now() }));
    // ⚠分納は日付付きにする(日をまたぐ便が「時刻だけ」だと、いつの分か分からない)。
    const label = splits.length > 1 ? formatSplits(splits, { withDate: true }) : splits[0].time;
    if (notifyPush) notifyPush({ toSide: 'app', title: `🚚 到着予定 登録: ${lot.orderNo || ''} → ${label}`, body: `${byName} が登録しました`, link: appLink, tag: `arr-reg-${lot.id}` });
    setSheet(null);
  };
  // 🚫 教えた到着予定を取り消す(清水さん 2026-09-08「組立連絡アプリの方で検査に到着予定登録したけど、
  //   間違ってて削除したいとき用の削除ボタンがほしい」)。
  //   ⚠ 消すのは到着予定だけ。ロット・入荷時間・検査の記録には触らない。
  //   ⚠ 到着予定は2種類あって消し方が違う。検査側の deleteArrival と **同じ順で同じ関数** を使う
  //     (自分で消し方を考えない)。
  //     ①自発登録(source:'self') … arrival_times/{lotId} を消すだけ。
  //     ②依頼への回答(source:'req') … 依頼は残して「未回答」へ戻す。
  //        🚨🚨 鍵を消さずに「消した」と書く(cleared: true)。ただ消すと merge は消した鍵を消さないので、
  //           重ねが古い items[] に落ちて **移行前の回答が復活する**(2026-07-26 の既知の罠)。
  // 🗑 シートから取り消す時の相手(一覧と同じ行)。依頼への返事なら その依頼のその行、自分から知らせた物なら 指図で引く。
  const arrivalEntryOf = (lotId, reqId = null, idx = null) => (arrivalEntries || []).find((e) => e && (reqId
    ? (e.source === 'req' && e.reqId === reqId && e.itemIdx === idx)
    : (e.lotId === lotId && e.source !== 'req'))) || (lotId ? (arrivalEntries || []).find((e) => e && e.lotId === lotId) : null) || null;
  const cancelArrival = (e) => {
    if (!e || !deleteData || !group || e.group !== group) return false;
    const when = `${String(e.date || '').slice(5).replace('-', '/')} ${e.time}`;
    const what = `${e.orderNo || ''} ${e.model || ''}（${when}）`;
    // 🚨 到着予定の書類には **検査が書いた物**(終了予定の返事 finish・受け取り applied)が同居している。
    //   取り消すとそれも一緒に消えるので、消える前に必ず言う(2026-09-08 確かめ役の指摘)。
    //   ⚠ 押せなくはしない。清水さんの困り事は「間違えて登録したのを消したい」で、
    //     検査が受け取った後こそ直したい場面だから。**黙って消さない** だけにする。
    const alsoGone = (e.replied || e.applied)
      ? '⚠ 検査はもうこの予定を受け取っています。検査が返した終了予定の返事も一緒に消えます。\n'
      : '';
    // ⚠ 枝は「印(e.source === 'req')」ではなく **実際に依頼が引けたか** で選ぶ。
    //   引けないのに回答の枝へ入ると『依頼は残り、未回答に戻ります』と言いながら
    //   依頼は answered のまま取り残される(2026-09-09 確かめ役の指摘)。
    const req = e.source === 'req' ? (contactRequests || []).find(r => r && r.id === e.reqId) : null;
    if (req) {
      // ⚠ 取り消す前に必ず聞く。背景を押して閉じられる形にしない(2026-08-21)ので window.confirm を使う。
      if (!window.confirm(`この到着予定の回答を取り消しますか？
${what}
${alsoGone}※依頼は残り、「未回答」に戻ります`)) return false;
      const sv = arrivalAnswerSave(req, e.itemIdx, { date: '', time: '', by: '', at: 0 }, { cleared: true });
      saveData('contact_requests', req.id, { items: sv.items, itemAnswers: sv.itemAnswers, status: 'waiting' });
      if (e.lotId) deleteData('arrival_times', e.lotId);
    } else {
      if (!window.confirm(`この到着予定を取り消しますか？
${what}
${alsoGone}※検査リストの🚚到着バッジも消えます（入荷時間はそのまま残ります）`)) return false;
      deleteData('arrival_times', e.lotId);
    }
    // 🚨 検査側へ知らせる。登録の通知だけを見て段取りしている人が居るので、黙って消すと古い予定で動いてしまう。
    if (notifyPush) notifyPush({ toSide: 'app', title: `🚚 到着予定 取り消し: ${e.orderNo || ''} → ${when}`, body: `${byName} が取り消しました`, link: appLink, tag: `arr-del-${e.key}` });
    return true;
  };
  // あっちから検査へ「いつ終わりますか？」を聞く。検査側(連絡タブ)で終了予定を回答してもらう。
  const askedFinishOf = (lotId) => (contactRequests || []).some(r => r && r.kind === 'finish' && (r.items || []).some(i => i.lotId === lotId && !i.time));
  const askFinish = (lot) => {
    if (askedFinishOf(lot.id)) { alert('この製品はもう「いつ終わるか」を聞いています（回答待ち）'); return; }
    const id = newContactId();
    saveData('contact_requests', id, {
      kind: 'finish', to: group, from: byName, message: '検査はいつ終わりますか？',
      createdAt: Date.now(), status: 'waiting',
      items: [{ lotId: lot.id, orderNo: lot.orderNo || '', model: lot.model || '', modelText: lot.modelText || '', quantity: lot.quantity || 0, dueDate: lot.dueDate || '', date: '', time: '' }],
    });
    if (notifyPush) notifyPush({ toSide: 'app', title: `🏁 いつ終わる？: ${lot.orderNo || ''} ${lot.model || ''}`, body: `${byName} が終了予定を聞いています`, link: appLink, tag: `finq-${id}` });
  };
  // 🆕検査リストに無いものを検査へ知らせる。
  //   ⚠組立側は検査のテンプレート名を知らないので、検査内容は自由記入(message)にする。
  //   ⚠新しいフィールド名を作らない。指図/品目コード/台数/本文/納期はどれも既存の連絡と同じキーに入れる。
  //     到着予定も既存の items[](1件=1つの日時)の形にそろえる。こうしておくと、検査側が
  //     検査対象に登録したあと、その中身をそのまま到着予定として渡せる。
  //   ⚠戻り値: 送るのをやめた時だけ false を返す(シート側の「送っています…」を解除するため)。
  const sendNewLot = (v) => {
    if (!v || !v.orderNo || !v.model || !v.message) return false;
    // 同じ指図がもう検査の一覧にあるなら、二重に作ってしまう前にここで気づいてもらう。
    const dup = (lots || []).find(l => l && String(l.orderNo || '') === v.orderNo && l.status !== 'completed');
    if (dup && !window.confirm(`指図 ${v.orderNo} は検査の一覧にもうあります（${dup.model || ''}）。\nそれでも「リストに無いもの」として知らせますか？`)) return false;
    const id = newContactId();
    saveData('contact_requests', id, {
      kind: 'newlot', to: group, from: byName,
      orderNo: v.orderNo, model: v.model, quantity: v.quantity,
      message: v.message, dueDate: v.dueDate || '',
      createdAt: Date.now(), status: 'waiting',
      items: [{ lotId: '', orderNo: v.orderNo, model: v.model, quantity: v.quantity, dueDate: v.dueDate || '', date: v.date || '', time: v.time || '' }],
    });
    if (notifyPush) notifyPush({ toSide: 'app', title: `🆕 検査リストに無い品: ${v.orderNo} ${v.model}`, body: `${byName}（${group}）/ ${v.quantity}台 / ${String(v.message).slice(0, 60)}`, link: appLink, tag: `newlot-${id}` });
    setShowNewLot(false);
    alert('検査側へ知らせました。\n検査の一覧に載ると「到着予定を知らせる」にも出てきます。');
    return true;
  };
  // 品目コードの打ち間違いを減らすための候補。今の検査リストに実際にある品目コードだけを出す(架空の候補は作らない)。
  const modelOptions = useMemo(() => Array.from(new Set((openLots || []).map(l => String(l.model || '').trim()).filter(Boolean))).sort(), [openLots]);
  const myFinishAsks = useMemo(() => (contactRequests || []).filter(r => r && r.kind === 'finish' && r.to === group).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20), [contactRequests, group]);
  // 機能OFF時はポータルも閉じる (URLを知っていても何も見えない)
  if (settings?.contactFeature?.enabled === false) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md text-center">
          <MessageCircle className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <div className="font-black text-slate-700">工程連絡は現在停止中です</div>
          <div className="text-xs text-slate-400 mt-1">検査側の「マスタ設定 → 工程連絡」でONにすると使えるようになります</div>
        </div>
      </div>
    );
  }
  if (!group) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md flex flex-col gap-4">
          <div className="flex items-center gap-2"><MessageCircle className="w-6 h-6 text-blue-600" /><h1 className="text-xl font-black text-slate-800">工程連絡ポータル</h1></div>
          <p className="text-sm text-slate-500">あなたのグループを選んでください（検査からの連絡がここに届きます）</p>
          {groups.map(g => (
            <button key={g} onClick={() => { try { localStorage.setItem('renrakuGroup', g); } catch (e) { /* noop */ } setGroup(g); }} className="w-full py-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-lg font-black">{g}</button>
          ))}
        </div>
      </div>
    );
  }

  const card = 'bg-white rounded-3xl border border-slate-200/80 shadow-sm overflow-hidden';

  // ==================== 📱スマホの時だけ足す指定 ====================
  // 🚨 決まりは2つだけ。
  //   ① 押す物は 44px 以上          → mTap(高さ) / mTapSq(高さと幅の両方。アイコンの正方形)
  //   ② 押す物の文字と数字は 12px 以上 → t11 / t10 (説明文は小さいままでよい)
  // 🚨 **PC(wide)では必ず元と同じ文字列を返す**。「PCの見た目を1pxも変えない」を、
  //    直す所ごとに考えずに済ませる為に、ここ1か所で受け持つ。
  //    ⚠だから三項演算子の **else 側を書き換えてはいけない**(書き換えた瞬間にPCが動く)。
  // ⚠ narrow は short(スマホ横 844×390)を含む。ここを wide の否定で作ってあるので漏れない。
  // ⚠ text-xs = 12px。text-2xs = 11px / text-3xs = 10px(tailwind.config.js の段)。
  //    px 直書き(fi-tap-text)は **PC側に残っている元の値** だけ。新しくは足していない。
  // ⚠ 最終検査アプリの ContactPortal と同じ書き方。片方だけ直さない事。
  const mTap = narrow ? ' min-h-11' : '';
  // ⚠正方形のアイコンボタンは幅も広げる。広げた分の中で絵が真ん中に来るよう flex も一緒に付ける。
  const mTapSq = narrow ? ' min-h-11 min-w-11 flex items-center justify-center' : '';
  const t11 = narrow ? 'text-xs' : 'fi-tap-text';
  const t10 = narrow ? 'text-xs' : 'fi-tap-text';
  // 🏷 しぼり込みのチップ。狭い画面で **1文字ずつ縦に割れる** のを止める。
  const mChip = narrow ? ' whitespace-nowrap shrink-0' : '';
  const mChips = narrow ? ' overflow-x-auto' : '';

  const rangeSelect = (value, onChange, hidden) => (
    <span className="ml-auto flex items-center gap-1.5 shrink-0">
      {hidden > 0 && <span className="fi-tap-text text-slate-400">古い{hidden}件は非表示</span>}
      <select value={value} onChange={e => onChange(e.target.value)} className={`border border-slate-200 rounded-lg px-1.5 py-1 text-xs font-bold text-slate-500 bg-white${mTap}`}>
        {RANGE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </span>
  );

  // ================= ① 返事が要るもの =================
  const todoTotal = inbox.length + arrivalReqCount;
  const secTodo = (
    <section className="flex flex-col gap-3">
      {/* ⚠ここは「まだ返していない用事の数」= 返すまで消えない。赤い数字(新着・見たら消える)と区別するため橙にする。 */}
      <h2 className="text-sm font-black text-slate-400 tracking-wide px-1">返事をお願いします {todoTotal > 0 && <span className="ml-1 bg-amber-500 text-white rounded-full px-2 py-0.5 text-xs" title="まだ返事していない用事の数です（返すまで消えません）">{todoTotal}</span>}</h2>
      {todoTotal === 0 && (
        <div className={`${card} px-4 py-3 text-sm text-slate-400 flex items-center gap-2`}>
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> 返事待ちはありません。ありがとうございます
        </div>
      )}
      {inbox.map(r => (
        <div key={r.id} className="bg-white rounded-3xl border-2 border-orange-300 shadow-sm overflow-hidden">
          <div className="px-4 py-2 bg-orange-50 flex items-center gap-2 flex-wrap text-xs">
            <span className="font-black text-orange-700">{contactKindLabel(r)}</span>
            {r.toPerson && <span className="bg-rose-600 text-white font-black rounded-full px-2 py-0.5">→ {r.toPerson}さん</span>}
            <span className="text-slate-500 font-bold">{r.from || '検査'} から</span>
            <span className="font-mono text-slate-400">{fmtContactElapsed(r.createdAt, nowTick)}前</span>
            {r.orderNo && <span className="font-mono font-bold text-slate-600">指図 {r.orderNo}</span>}
            {r.model && <span className="font-bold text-slate-600">{r.model}{r.modelText ? <span className="font-normal text-slate-400"> {r.modelText}</span> : null}</span>}
            {r.stepTitle && <span className="text-slate-500">{r.stepTitle} {r.unitLabel}</span>}
          </div>
          <div className="px-4 py-3 text-base font-bold text-slate-800 whitespace-pre-wrap">{r.message}</div>
          {(() => {
            const att = contactAttachmentOf(r, lots);
            if (!att || !att.photos.length) return null;
            return (
              <div className="px-4 pb-1 flex gap-1.5 overflow-x-auto">
                {att.photos.map((p, i) => <img key={i} src={p} alt="" onClick={() => setZoomImg(p)} className="h-24 rounded-xl border border-slate-200 shrink-0 cursor-zoom-in" />)}
              </div>
            );
          })()}
          <div className="px-4 pb-4 flex flex-col gap-2">
            <input value={commentDraft[r.id] || ''} onChange={e => setCommentDraft(p => ({ ...p, [r.id]: e.target.value }))} placeholder="ひとことコメント（任意）" className={`w-full border border-slate-200 rounded-xl px-3 py-2 text-sm${mTap}`} />
            {/* 2×2で押しやすく。「行けない」は白地赤枠にして誤タップと視認性を両立 */}
            <div className="grid grid-cols-2 gap-2">
              {CONTACT_REPLY_CHOICES.map(c => (
                <button key={c.id} onClick={() => reply(r, c.id)} className={`py-3.5 rounded-2xl text-sm font-black ${c.id === 'no' ? 'bg-white border-2 border-rose-500 text-rose-600 hover:bg-rose-50' : `text-white ${c.cls}`}`}>{c.label}</button>
              ))}
            </div>
            <ContactThread req={r} mySide="portal" onAdd={t => addComment(r, t)} />
          </div>
        </div>
      ))}
      {/* 「いつ来るか」の依頼: 1件ずつ、押すとシートが開く(行の中に入力欄を並べない) */}
      {arrivalReqs.map(r => (
        <div key={r.id} className="bg-white rounded-3xl border-2 border-teal-300 shadow-sm overflow-hidden">
          <div className="px-4 py-2 bg-teal-50 flex items-center gap-2 text-xs flex-wrap">
            <span className="font-black text-teal-700">到着予定を教えてください</span>
            <span className="text-slate-500 font-bold">{r.from || '検査'} から</span>
            <span className="font-mono text-slate-400">{fmtContactTime(r.createdAt)}</span>
            {r.auto && <span className="fi-tap-text font-bold text-slate-400 bg-white border border-slate-200 rounded px-1.5 py-0.5" title="設定した時刻に自動で送られた定期のおうかがいです">定期</span>}
          </div>
          {r.autoThanks && (
            <div className="px-4 py-2 bg-emerald-50 border-b border-emerald-100 text-xs font-bold text-emerald-800 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />{r.autoThanks.text}（{r.autoThanks.by || '検査'}）
            </div>
          )}
          <div className="divide-y divide-slate-100">
            {(r.items || []).map((it, idx) => (
              it.time ? (
                <div key={idx} className="px-4 py-3 flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-mono font-black text-slate-500 shrink-0">{it.orderNo}</span>
                  <span className="font-bold text-slate-500 truncate">{it.model}{it.modelText ? <span className="font-normal text-slate-400"> {it.modelText}</span> : null}</span>
                  <span className="ml-auto flex flex-col items-end shrink-0">
                    <span className="font-black text-emerald-600">{String(it.date || '').slice(5).replace('-', '/')} {it.time} ✓</span>
                    {it.finish?.ts && <span className={`${t11} font-black text-teal-700`}>🏁 検査終了予定 {fmtContactDT(it.finish.ts)}</span>}
                  </span>
                </div>
              ) : (
                <button key={idx} onClick={() => setSheet({ kind: 'req', reqId: r.id, idx })}
                  className="w-full text-left px-4 py-3.5 flex items-center gap-2 flex-wrap hover:bg-teal-50 active:bg-teal-100">
                  <span className="font-mono text-sm font-black text-slate-700 shrink-0">{it.orderNo}</span>
                  <span className="text-sm font-bold text-slate-600 truncate">{it.model}{it.modelText ? <span className="font-normal text-slate-400"> {it.modelText}</span> : null}</span>
                  {tplNameForItem(it) && <span className={`${t11} font-bold text-indigo-700 bg-indigo-50 rounded px-1.5 py-0.5 shrink-0`}>📋 {tplNameForItem(it)}</span>}
                  {showQty && it.quantity ? <span className="text-xs text-slate-400 shrink-0">{it.quantity}台</span> : null}
                  <span className="ml-auto text-sm font-black text-teal-700 shrink-0">時間を入れる →</span>
                </button>
              )
            ))}
          </div>
        </div>
      ))}
      {answeredRecent.length > 0 && (
        <div className="px-1">
          <button onClick={() => setShowAnswered(v => !v)} className={`text-xs font-bold text-slate-400 underline${mTap}`}>返信済み {answeredRecent.length}件（24時間以内）{showAnswered ? 'を隠す' : 'を見る'}</button>
          {showAnswered && (
            <div className="mt-1.5 flex flex-col gap-1">
              {answeredRecent.map(r => (
                <div key={r.id} className="bg-white rounded-xl border border-slate-200 px-3 py-1.5 text-xs flex items-center gap-2 flex-wrap">
                  <span className="text-slate-500 truncate max-w-[40ch]">{r.message}</span>
                  <span className={`ml-auto font-black shrink-0 ${r.answer?.choice === 'no' ? 'text-rose-600' : 'text-emerald-600'}`}>{contactReplyLabel(r.answer?.choice)}</span>
                  <span className="font-mono text-slate-400 shrink-0">{fmtContactTime(r.answer?.at)}</span>
                  <button onClick={() => { if (window.confirm('この返信を取り消して選び直しますか？')) saveData('contact_requests', r.id, { status: 'waiting', answer: DATA_DELETE }); }} className={`shrink-0 px-2 py-1 rounded border border-blue-200 text-blue-600 font-bold hover:bg-blue-50${mTap}`}>やり直す</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );

  // ================= ② 到着予定を知らせる(主役) =================
  const secRegister = (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-black text-slate-800 px-1 flex items-center gap-2">
        <Truck className="w-5 h-5 text-blue-600" /> 到着予定を知らせる
        {todoCount > 0 && <span className="text-xs font-bold text-slate-400">まだ {todoCount}件</span>}
        {/* 🆕検査リストに無い物は、検索しても出てこない=下の一覧のどこにも現れない。
            空表示の下だけに入口を置くと「探して空振りした人」しか気づけないので、見出しにも常に置く。 */}
        <button onClick={() => setShowNewLot(true)}
          title="検査の一覧に無い物（急な追加など）を、指図・品目コード・台数・検査内容を書いて検査側へ知らせます"
          className={`ml-auto px-3 py-1.5 rounded-full text-xs font-black bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 shrink-0${mTap}`}>
          🆕 リストに無い
        </button>
      </h2>
      <div className={card}>
        <div className="p-3 flex flex-col gap-2 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="指図・品目コードで検索" className={`w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-3 py-2.5 text-sm${mTap}`} />
            </div>
            <button onClick={() => setShowPick(v => !v)} className={`px-3 py-2.5 rounded-xl text-sm font-black shrink-0 ${showPick || modelPick ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}${mTapSq}`}>
              🔎{modelPick ? ` ${pickLabel}` : ''}
            </button>
          </div>
          <div className={`flex items-center gap-1.5 flex-wrap${mChips}`}>
            <button onClick={() => setOnlyTodo(v => !v)} className={`px-3 py-1.5 rounded-full text-xs font-black ${onlyTodo ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}${mTap}${mChip}`}>
              {onlyTodo ? '✓ まだ知らせていない分だけ' : 'まだ知らせていない分だけ'}
            </button>
            {/* 検査のテンプレート名でしぼる。今そのテンプレの製品が並んでいる時だけボタンを出す
                (押しても0件になるボタンは作らない)。言葉は 連絡タブ→宛先・公開設定 で変えられる。 */}
            {tplWords.filter(w => tplWordCounts[w] > 0).map(w => (
              <button key={w} onClick={() => setTplWord(tplWord === w ? '' : w)}
                className={`px-3 py-1.5 rounded-full text-xs font-black ${tplWord === w ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'}${mTap}${mChip}`}>
                {w}<span className="font-normal opacity-70"> {tplWordCounts[w]}</span>
              </button>
            ))}
            {(modelPick || tplWord) && <button onClick={() => { setModelPick(null); setTplWord(''); }} className={`px-2.5 py-1.5 rounded-full text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100${mTap}${mChip}`}>✕ しぼり込み解除</button>}
            <span className={`ml-auto ${t11} text-slate-400${mChip}`}>{lotList.length}件{lotList.length > LOT_LIST_CAP ? `（上から${LOT_LIST_CAP}件）` : ''}</span>
          </div>
          {showPick && (
            <div className="bg-slate-50 rounded-2xl p-2.5 flex flex-col gap-2">
              <div className={`flex flex-wrap gap-1.5${mChips}`}>
                <button onClick={() => setModelPick(null)} className={`px-3 py-2 rounded-xl text-sm font-black ${!modelPick ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 border border-slate-200'}${mTap}${mChip}`}>すべて（{openLots.length}）</button>
                {pickBuckets.groups.map(g => {
                  const on = modelPick?.type === 'group' && modelPick.id === g.id;
                  return <button key={g.id} onClick={() => setModelPick(on ? null : { type: 'group', id: g.id })}
                    className={`px-3 py-2 rounded-xl text-sm font-black ${on ? `${g.bg} text-white` : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}${mTap}${mChip}`}>{g.label}（{g.count}）</button>;
                })}
                {pickBuckets.other.count > 0 && (() => {
                  const on = modelPick?.type === 'group' && modelPick.id === 'other';
                  return <button onClick={() => setModelPick(on ? null : { type: 'group', id: 'other' })}
                    className={`px-3 py-2 rounded-xl text-sm font-black ${on ? 'bg-slate-600 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}${mTap}${mChip}`}>その他（{pickBuckets.other.count}）</button>;
                })()}
              </div>
              {/* 品目コードごとのボタン。いま並んでいる品目コードだけ出す(押して0件になるボタンは作らない) */}
              {pickBuckets.groups.map(g => (
                <div key={g.id} className={`flex items-center gap-1.5 flex-wrap${mChips}`}>
                  <span className={`${t11} font-black text-slate-400 w-12 shrink-0`}>{g.label}</span>
                  {g.prefixes.map(p => {
                    const on = modelPick?.type === 'prefix' && modelPick.p === p;
                    return <button key={p} onClick={() => setModelPick(on ? null : { type: 'prefix', p })}
                      className={`px-2.5 py-1.5 rounded-lg text-sm font-black ${on ? 'text-white' : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'}${mTap}${mChip}`}
                      style={on ? { backgroundColor: g.color } : {}}>{p}<span className={`font-normal opacity-70 ${t11}`}> {pickBuckets.byPrefix[p]}</span></button>;
                  })}
                </div>
              ))}
              {pickBuckets.other.prefixes.length > 0 && (
                <div className={`flex items-center gap-1.5 flex-wrap${mChips}`}>
                  <span className={`${t11} font-black text-slate-400 w-12 shrink-0`}>その他</span>
                  {pickBuckets.other.prefixes.map(p => {
                    const on = modelPick?.type === 'prefix' && modelPick.p === p;
                    return <button key={p} onClick={() => setModelPick(on ? null : { type: 'prefix', p })}
                      className={`px-2.5 py-1.5 rounded-lg text-sm font-black ${on ? 'bg-slate-600 text-white' : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'}${mTap}${mChip}`}>{p}<span className={`font-normal opacity-70 ${t11}`}> {pickBuckets.byPrefix[p]}</span></button>;
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        {/* 1件=1行。押すと大きなシートが開く(行の中に入力欄を並べない=縦に伸びない) */}
        <div className={`divide-y divide-slate-100 overflow-y-auto ${wide ? 'max-h-[62vh]' : 'max-h-[56vh]'}`}>
          {lotListShown.map(l => {
            const cur = arrivalByLot[l.id];
            const done = !!(cur && cur.time);
            return (
              <button key={l.id} onClick={() => setSheet({ kind: 'lot', lotId: l.id })}
                className="w-full text-left px-4 py-3.5 flex items-center gap-2.5 hover:bg-blue-50 active:bg-blue-100">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-base font-black text-slate-800">{l.orderNo}</span>
                    <span className="text-sm font-bold text-slate-600 truncate">{l.model}{l.modelText ? <span className="font-normal text-slate-400"> {l.modelText}</span> : null}</span>
                  </div>
                  <div className={`flex items-center gap-2 flex-wrap ${t11} text-slate-400 mt-0.5`}>
                    {showQty ? <span>{l.quantity}台</span> : null}
                    {showDue && l.dueDate ? <span>納期 {fmtDue(l.dueDate)}</span> : null}
                  </div>
                  {/* ⚠テンプレ名は途中で切らない。違いが名前の後ろ側にあるので、切ると全部同じに見える
                      (清水さん「テンプレート名が全部映るようにして、全然かわらないから」)。行を分けて折り返す。 */}
                  {tplName(l) && <div className={`${t11} text-indigo-600 font-bold mt-0.5 break-words leading-snug`}>📋 {tplName(l)}</div>}
                </div>
                {done
                  ? (
                    <span className="shrink-0 text-right max-w-[45%]">
                      {/* 分納は「何時に何台」を全部出す。1便だけなら今までどおり1行 */}
                      {isSplitArrival(cur)
                        ? (
                          <>
                            {/* ⚠見出しに日付を出さない。ここに出せるのは「一番早い便」の日付だけで、
                                日をまたぐ2便目が別の日だと嘘になる。日付は下の内訳に便ごとに出す。 */}
                            <span className="block text-sm font-black text-teal-700">🚚 分納{splitsOf(cur).length}回・計{splitTotalQty(splitsOf(cur))}台</span>
                            <span className={`block ${t11} font-bold text-teal-600 leading-snug break-words`}>{formatSplits(splitsOf(cur), { withDate: true, max: MAX_SPLITS })}</span>
                          </>
                        )
                        : <span className="block text-sm font-black text-teal-700">🚚 {String(cur.date || '').slice(5).replace('-', '/')} {cur.time}</span>}
                      {cur.finish?.ts
                        ? <span className={`block ${t11} font-bold text-teal-600`}>🏁 {fmtContactDT(cur.finish.ts)}</span>
                        : finishOn ? <span className={`block ${t11} text-slate-400`}>検査の返事待ち</span> : null}
                    </span>
                  )
                  : <span className="shrink-0 text-sm font-black text-blue-600 bg-blue-50 rounded-full px-3 py-1.5">時間を入れる</span>}
              </button>
            );
          })}
          {lotListShown.length === 0 && (
            <div className="p-6 flex flex-col items-center gap-3">
              {/* 🆕探して出てこなかった=ここが「検査リストに無い」と気づく場所。一番近い所に入口を置く。 */}
              <div className="text-center text-sm text-slate-400">対象がありません{onlyTodo ? '（全部の時間を教えてもらっています。ありがとうございます）' : (modelPick || tplWord) ? '（しぼり込みを外すと出るかもしれません）' : ''}</div>
              <button onClick={() => setShowNewLot(true)}
                className="px-5 py-3 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-black">
                🆕 検査リストに無いものを知らせる
              </button>
              <div className="fi-tap-text text-slate-400 text-center leading-snug">指図・品目コード・台数と「何を検査してほしいか」を書いて、検査側へそのまま送れます</div>
              {/* 🔎 2026-09-16 指図で探して0件の時、なぜ無いか(完了済み／取込で落ちた／取込で消した／表に無い)を言う */}
              <MissingOrderHint orderNo={q} lots={lots} settings={settings} />
            </div>
          )}
        </div>
      </div>
    </section>
  );

  // ================= ③ 検査からの情報(1枚にまとめる) =================
  // ⚠赤い数字(n)は「新しく届いた件数」だけ。開いたら消える。
  //   まだ片付いていない用事の数(返事待ち・未確認)は数字にせず、消えない小さな印(dot)で出す。
  //   数字を2種類の意味で使うと、アイコンの数字と画面の数字が合わなくなる。
  // 🏁 並びは「組立が一番知りたい順」。一番知りたいのは自分がいつ動けるか＝いつ終わるか。
  //   ⚠タブ名を「検査の今」から「🏁 いつ終わるか」に直した。中身は前から**この事**を出していたのに、
  //     名前が探している言葉と違ったので見つけてもらえなかった(2026-08-16)。**中身は作り直していない。**
  //   ⚠「終了予定」タブとは別物なので名前を分けたまま残す:
  //       🏁 いつ終わるか … アプリが今の残りから出した**見込み**（根拠の式つき）
  //       終了予定       … 検査の人が**返事した**時刻（約束）
  const infoTabs = [
    ...(wsOn ? [{ id: 'now', label: '🏁 いつ終わるか', n: 0 }] : []),
    { id: 'done', label: '検査完了', n: unread.done, dot: completeUnread > 0 },
    // 🗑 2026-09-24「到着の返事」だと 自分が知らせた予定を消せる場所だと気づけなかった
    { id: 'arr', label: '知らせた到着予定', n: 0, dot: finishOn && arrivalStats.waiting > 0 },
    { id: 'finish', label: '終了予定', n: unread.finish },
  ];
  const secInfo = (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-black text-slate-400 tracking-wide px-1">検査から</h2>
      <div className={card}>
        {/* ⚠この帯は元から横に送れる(overflow-x-auto)。狭い画面ではタブが痩せて字が割れないよう
            shrink-0 も足す(mChip)。⚠🏁 が先頭に来る並びは変えていない。
            ⚠390px では4つ並べると「終了予定」が右へ 27px はみ出し、指で送らないと出てこなかった。
              スマホでは折り返して2段にする = **どのタブも最初から見えている**(情報を隠さない)。
              PCは今までどおり1段(flex-wrap を付けない)。 */}
        <div className={`flex items-center gap-1 p-1.5 bg-slate-50 border-b border-slate-100 overflow-x-auto${narrow ? ' flex-wrap' : ''}`}>
          {infoTabs.map(t => (
            <button key={t.id} onClick={() => setInfoTab(t.id)}
              className={`px-3 py-2 rounded-xl text-xs font-black whitespace-nowrap flex items-center gap-1.5 ${infoTabEff === t.id ? 'bg-white shadow text-slate-800' : 'text-slate-500 hover:bg-white/60'}${mTap}${mChip}`}>
              {t.label}
              {t.n > 0
                ? <span className={`bg-rose-500 text-white rounded-full px-1.5 ${t10}`} title="新しく届いた件数（見たら消えます）">{t.n}</span>
                : t.dot ? <span className="w-2 h-2 rounded-full bg-amber-400" title="まだ片付いていない用事があります（数ではなく印で出しています）" /> : null}
            </button>
          ))}
        </div>

        {infoTabEff === 'done' && (
          <div>
            <div className="px-4 py-2 flex items-center gap-2 fi-tap-text text-slate-400 border-b border-slate-50">検査が終わったお知らせ{rangeSelect(noticeRange, setNoticeRange, completeCut.hidden)}</div>
            <div className="divide-y divide-slate-100 max-h-[40vh] overflow-y-auto">
              {completeNotices.map(r => {
                // needAck=false = 検査側が「確認返信はいらない」設定で送ったお知らせ。ボタンを出さない(押させない)。
                const wantAck = r.needAck !== false;
                return (
                  <div key={r.id} className="px-4 py-3 flex items-center gap-2 flex-wrap">
                    <span className="text-emerald-600 font-black text-sm shrink-0">✅</span>
                    <span className="font-mono text-sm font-black text-slate-700">{r.orderNo}</span>
                    <span className="text-sm font-bold text-slate-600 truncate">{r.model}{r.modelText ? <span className="font-normal text-slate-400"> {r.modelText}</span> : null}</span>
                    {r.quantity ? <span className="text-xs text-slate-400">{r.quantity}台</span> : null}
                    <span className={`font-mono ${t11} text-slate-400`}>{fmtContactTime(r.createdAt)}（{r.from || '検査'}）</span>
                    {!wantAck
                      ? <span className="ml-auto fi-tap-text font-bold text-slate-300">返信不要</span>
                      : r.status === 'answered'
                        ? <span className="ml-auto text-xs font-black text-slate-400">確認済 {r.answer?.by ? `(${r.answer.by})` : ''}</span>
                        : <button onClick={() => ackComplete(r)} className={`ml-auto px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-black shrink-0${mTap}`}>確認しました</button>}
                  </div>
                );
              })}
              {completeNotices.length === 0 && <div className="p-6 text-center text-sm text-slate-400">この期間のお知らせはありません{completeCut.hidden > 0 ? `（古い分が ${completeCut.hidden}件）` : ''}</div>}
            </div>
          </div>
        )}

        {infoTabEff === 'arr' && (
          <div>
            <div className="px-4 py-2 flex items-center gap-2 fi-tap-text text-slate-400 border-b border-slate-50">知らせた到着予定と検査の返事・行けなくなった時は 右端の「取り消し」{rangeSelect(arrRange, setArrRange, arrivalBoard.hidden)}</div>
            <div className="divide-y divide-slate-100 max-h-[40vh] overflow-y-auto">
              {arrivalBoard.rows.map(e => (
                <div key={e.key} className="px-4 py-3 flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-mono font-black text-slate-700 shrink-0">{e.orderNo}</span>
                  <span className="font-bold text-slate-600 truncate">{e.model}{e.modelText ? <span className="font-normal text-slate-400"> {e.modelText}</span> : null}</span>
                  <span className="text-xs font-black text-teal-700 shrink-0">🚚 {String(e.date || '').slice(5).replace('-', '/')} {e.time}</span>
                  {/* 分納は内訳を必ず出す(何時に何台来るのかが本題)。
                      ⚠左の🚚は「一番早い便」の日時なので、内訳は便ごとに日付付きで出す(日またぎ対策)。 */}
                  {(e.splits || []).length > 1 && <span className={`${t11} font-bold text-teal-600 bg-teal-50 rounded px-1.5 py-0.5`}>分納{e.splits.length}回 {formatSplits(e.splits, { withDate: true, max: MAX_SPLITS })}</span>}
                  {/* 検査が入荷時間へ入れていれば「受け取ってもらえた」ことが分かる。
                      何もされていない時だけ「予定を過ぎています」と出す(清水さん 2026-08-05)。 */}
                  {e.replied
                    ? <span className="ml-auto font-black text-teal-700 shrink-0">🏁 {fmtContactDT(e.finish.ts)}{e.finish.by ? `（${e.finish.by}）` : ''}</span>
                    : e.applied
                      ? <span className="ml-auto text-xs font-bold text-emerald-600 shrink-0">📥 検査が受け取りました{finishOn ? '（終了予定はこれから）' : ''}</span>
                      : finishOn
                        ? <span className={`ml-auto text-xs font-bold shrink-0 ${e.late ? 'text-amber-600' : 'text-slate-400'}`}>{e.late ? '⏳ 返事待ち（予定を過ぎています）' : '⏳ 返事待ち'}</span>
                        : <span className="ml-auto text-xs text-slate-300 shrink-0">受け取りました</span>}
                  {/* 🚫 間違えて教えた到着予定を取り消す(清水さん 2026-09-08)。
                      ⚠ 自分の班が知らせた物だけに出す。他の班の予定は消せない(名前では絞らない。
                        同じ班の別の人が直せなくなるため)。
                      ⚠ 押す物は 44px 以上・文字12px以上。消す物なので赤系だが、登録の押す物より目立たせない。 */}
                  {/* ⚠ deleteData が親から渡っていない場面では出さない。検査側と同じ形。
                      出すだけだと「押せるのに黙って何も起きない押す物」になる。 */}
                  {deleteData && !!group && e.group === group && (
                    <button type="button" data-arr-cancel={e.key} onClick={() => cancelArrival(e)}
                      className="shrink-0 min-h-11 px-3 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm font-bold hover:bg-rose-100">取り消し</button>
                  )}
                </div>
              ))}
              {arrivalBoard.rows.length === 0 && <div className="p-6 text-center text-sm text-slate-400">まだ到着予定を知らせていません</div>}
            </div>
          </div>
        )}

        {infoTabEff === 'now' && wsOn && (
          <div>
            {/* ⚠見出しは「いま何をしているか」だった。中身は前からそれに加えて **いつ終わるか** を出していたので、
                探している言葉で書き直す。⚠スマホ(390px)で折り返しても読めるよう flex-wrap を付ける。 */}
            <div className={`px-4 py-2 flex items-center gap-2 flex-wrap ${t11} text-slate-400 border-b border-slate-50`}>
              いま検査しているもの → いつ終わるか
              <span className="ml-auto flex items-center gap-2 shrink-0">
                {/* 🕒 これは静止画。**何分前の話か**を必ず出す(5分以上は色を変えて「古い」と分かるようにする)。
                    ⚠ここで終わりの時刻は作らない。出しているのは作った時刻とその経過だけ。 */}
                {wsSnap && (
                  <span className={`font-mono ${wsAgeMin >= 5 ? 'text-amber-600 font-black' : ''}`}>
                    {fmtContactTime(wsSnap.at)} 時点{wsAgeMin >= 1 ? `（${wsAgeMin}分前）` : ''}
                  </span>
                )}
                <button onClick={refreshWorkStatus} className={`px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black flex items-center gap-1${mTap}`}><RefreshCw className="w-3.5 h-3.5" /> 更新</button>
              </span>
            </div>
            <div className="max-h-[40vh] overflow-y-auto">
              {wsGroups.length === 0 && <div className="p-6 text-center text-sm text-slate-400">いま動いている検査はありません（「更新」で最新にできます）</div>}
              {wsGroups.map(g => (
                <div key={g.name}>
                  <div className="px-4 py-1.5 bg-slate-50 flex items-center gap-2">
                    <span className="font-black text-slate-700 text-sm">{wsShowName ? g.name : '検査'}</span>
                    <span className={`${t11} text-slate-400`}>{g.rows.length}件{g.processing > 0 ? ` / 作業中 ${g.processing}` : ''}</span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {g.rows.map(r => (
                      <div key={r.lotId} className="px-4 py-2.5 text-sm">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`fi-tap-text font-black px-1.5 py-0.5 rounded shrink-0 ${r.state === 'processing' ? 'bg-blue-600 text-white' : r.state === 'paused' ? 'bg-amber-100 text-amber-700' : r.state === 'waiting' ? 'bg-slate-100 text-slate-500' : 'bg-slate-200 text-slate-600'}`}>
                            {r.state === 'processing' ? '作業中' : r.state === 'paused' ? '中断' : r.state === 'waiting' ? '着手前' : '停止'}
                          </span>
                          <span className="font-mono font-black text-slate-700 shrink-0">{r.orderNo}</span>
                          <span className="font-bold text-slate-600 truncate">{r.model}{r.modelText ? <span className="font-normal text-slate-400"> {r.modelText}</span> : null}</span>
                          {showQty && r.quantity ? <span className="text-xs text-slate-400 shrink-0">{r.quantity}台</span> : null}
                          {r.startedAt && <span className="text-xs text-slate-400 font-mono shrink-0">開始 {fmtContactDT(r.startedAt)}</span>}
                          {r.estEndFrom === 'arrival' && r.arrivalTs && <span className="text-xs text-teal-600 font-bold shrink-0">🚚 {fmtContactDT(r.arrivalTs)}</span>}
                        </div>
                        {/* 🏁 いつ終わるか。⚠時刻も言葉も finishEta / finishEtaView が作った物だけを出す */}
                        <FinishEtaBlock eta={r.eta} fmtTime={fmtContactDT} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="px-4 py-2 fi-tap-text text-slate-400 border-t border-slate-50">
              🏁 の時刻は<b>見込み</b>です。<b>残っている検査の目安時間</b>を、いま付いている担当者の人数で分け、休憩・定時・土日を避けて数えています（1行ずつ、その式を下に出しています）。
              目安の時間が無い・担当が決まっていない・止まっている、など<b>材料が足りない時は数字を作らず「分かりません」と、その理由を出します。</b>
              <b>「更新」を押した時だけ作り直します</b>（いつ作った物かは右上の「◯時◯分 時点」を見てください。5分以上たつと色が変わります）。
            </p>
          </div>
        )}

        {infoTabEff === 'finish' && (
          <div className="divide-y divide-slate-100 max-h-[40vh] overflow-y-auto">
            {finishInfos.map((it, i) => (
              <div key={i} className="px-4 py-3 flex items-center gap-2 flex-wrap text-sm">
                <span className="font-mono font-black text-slate-700 shrink-0">{it.orderNo}</span>
                <span className="font-bold text-slate-600 truncate">{it.model}{it.modelText ? <span className="font-normal text-slate-400"> {it.modelText}</span> : null}</span>
                <span className="ml-auto font-black text-teal-700 shrink-0">🏁 {fmtContactDT(it.ts)}</span>
                {it.by && <span className="fi-tap-text text-slate-400 shrink-0">{it.by}</span>}
              </div>
            ))}
            {myFinishAsks.map(r => (r.items || []).filter(it => !it.time).map((it, i) => (
              <div key={`${r.id}-${i}`} className="px-4 py-3 flex items-center gap-2 flex-wrap text-sm">
                <span className="font-mono font-black text-slate-500 shrink-0">{it.orderNo}</span>
                <span className="font-bold text-slate-500 truncate">{it.model}{it.modelText ? <span className="font-normal text-slate-400"> {it.modelText}</span> : null}</span>
                <span className="ml-auto text-amber-600 font-bold shrink-0">検査からの回答待ち</span>
              </div>
            )))}
            {finishInfos.length === 0 && myFinishAsks.length === 0 && <div className="p-6 text-center text-sm text-slate-400">検査の終了予定はまだありません（48時間以内の分が出ます）</div>}
          </div>
        )}
      </div>
    </section>
  );

  // ================= ④ 履歴 =================
  // ================= ④ 制御装置(号機) 見るだけ =================
  //   ⚠ここは閲覧専用。保存する関数を渡さない = 組立側から中身を変えられない。
  //     設定→組立ポータル で出す/出さないを切り替えられる(既定=出す)。
  const secControl = (settings?.contactPortal?.showControlDevices !== false && (controllers || []).length > 0)
    ? <ControlDeviceReadOnly controllers={controllers} orderMotors={orderMotors} lots={lots} settings={settings} />
    : null;

  const secHistory = (
    <details className={card}>
      <summary className={`px-4 py-3 text-sm font-black text-slate-500 cursor-pointer select-none${mTap}`}>🗒 やりとりの履歴</summary>
      <div className={`px-4 pb-2 flex items-center gap-2 ${t11} text-slate-400`}>このグループ・{history.length}件{rangeSelect(histRange, setHistRange, historyCut.hidden)}</div>
      <div className="divide-y divide-slate-100 max-h-[45vh] overflow-y-auto">
        {history.map(h => {
          if (h.type === 'arrival') {
            const a = h.arrival;
            return (
              <div key={h.key} className="px-4 py-2.5 flex items-start gap-2 text-sm">
                <span className="fi-tap-text font-black px-1.5 py-0.5 rounded shrink-0 mt-0.5 bg-teal-100 text-teal-700">到着予定</span>
                <div className="min-w-0 flex-1">
                  <div className="text-slate-700 truncate">{a.orderNo} {a.model} → {String(a.date || '').slice(5).replace('-', '/')} {a.time} に到着予定と連絡{a.by ? `（${a.by}）` : ''}</div>
                  {a.finish?.ts && <div className={`${t11} text-teal-700 font-bold truncate`}>→ 🏁 検査終了予定 {fmtContactDT(a.finish.ts)}</div>}
                </div>
                <div className="text-right shrink-0">
                  {/* ⚠時刻は「数字」。スマホでは 12px 未満にしない(10px は老眼だと読めない) */}
                  <div className={`font-mono ${t10} text-slate-400`}>{fmtContactTime(a.at)}</div>
                  <span className={`fi-tap-text font-black px-1.5 py-0.5 rounded ${a.finish?.ts ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-400'}`}>{a.finish?.ts ? '返事あり' : '連絡済'}</span>
                </div>
              </div>
            );
          }
          const r = h.req;
          const st = contactStatusInfo(r);
          const ans = contactAnswerSummary(r);
          return (
            <div key={h.key} className="px-4 py-2.5 flex items-start gap-2 text-sm">
              <span className={`fi-tap-text font-black px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${r.kind === 'arrival' ? 'bg-teal-100 text-teal-700' : r.kind === 'finish' ? 'bg-indigo-100 text-indigo-700' : r.kind === 'complete' ? 'bg-emerald-100 text-emerald-700' : r.kind === 'portalmsg' ? 'bg-teal-100 text-teal-800' : r.kind === 'newlot' ? 'bg-rose-100 text-rose-700' : r.kind === 'call' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>{contactKindLabel(r)}</span>
              <div className="min-w-0 flex-1">
                {/* ⚠🆕 newlot をここに足さないと、自分が出した申告が履歴では「修正依頼」のオレンジで、
                    しかも本文だけの顔で出る。指図・品目コード・台数を出して、出した物だと分かるようにする。 */}
                <div className="text-slate-700 truncate">{r.kind === 'arrival' || r.kind === 'finish' ? `${(r.items || []).length}件: ${(r.items || []).map(i => i.orderNo).filter(Boolean).slice(0, 4).join(', ')}` : r.kind === 'complete' ? `${r.orderNo || ''} ${r.model || ''} 検査完了` : r.kind === 'portalmsg' ? `${r.orderNo || ''}${r.serialNo ? ` 機番${r.serialNo}` : ''} ${r.message || ''}` : r.kind === 'newlot' ? `${r.orderNo || ''} ${r.model || ''} ${r.quantity || 0}台: ${r.message || ''}` : (r.message || '')}</div>
                {/* ⚠緑は「片付いた」の色。まだ登録されていない申告(newlot で lotId が無い)を緑で出すと、
                    済んだように見えてしまう。その時だけ灰色にする。 */}
                {ans && <div className={`fi-tap-text font-bold truncate ${(r.kind === 'newlot' && !r.lotId) ? 'text-slate-400' : 'text-emerald-700'}`}>→ {ans}</div>}
              </div>
              <div className="text-right shrink-0">
                <div className={`font-mono ${t10} text-slate-400`}>{fmtContactTime(r.createdAt)}</div>
                <span className={`fi-tap-text font-black px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
              </div>
            </div>
          );
        })}
        {history.length === 0 && <div className="p-6 text-center text-sm text-slate-400">この期間の履歴はありません{historyCut.hidden > 0 ? `（古い分が ${historyCut.hidden}件）` : ''}</div>}
      </div>
    </details>
  );

  // シートに渡す中身(自発登録 / 依頼への回答 のどちらか)
  const sheetProps = (() => {
    if (!sheet) return null;
    if (sheet.kind === 'lot') {
      const l = lotById[sheet.lotId];
      if (!l) return null;
      return {
        head: '到着予定を知らせる', orderNo: l.orderNo, model: l.model, quantity: l.quantity, dueDate: l.dueDate,
        tplLabel: tplName(l), current: arrivalByLot[l.id] || null,
        canAskFinish: true, askedFinish: askedFinishOf(l.id), onAskFinish: () => { askFinish(l); setSheet(null); },
        // 💬ひとこと。機番の既定は空(元データに無い値を勝手に埋めない)
        onSendMessage: (m) => sendPortalMessage(l, m), defaultSerial: '',
        submitLabel: (arrivalByLot[l.id]?.time ? 'この時間に変える' : 'この時間で知らせる'),
        onSubmit: (when) => registerArrival(l, when),
        onCancel: (() => { const ce = arrivalEntryOf(l.id); return ce && (deleteData && !!group && ce.group === group) ? () => { if (cancelArrival(ce)) setSheet(null); } : null; })(),
      };
    }
    const r = (contactRequests || []).find(x => x && x.id === sheet.reqId);
    const it = r && (r.items || [])[sheet.idx];
    if (!r || !it) return null;
    const l = lotById[it.lotId];
    return {
      head: '到着予定を返事する', orderNo: it.orderNo, model: it.model, quantity: it.quantity, dueDate: it.dueDate,
      // ⚠⚠ いま入っている到着予定を必ず渡す(2026-08-05 清水さん「1台目を入れた後に2台目を入れると1台目が消える」の残り)。
      //   ここを null 決め打ちにしていたので、依頼への返事から入った時だけ
      //   ①「このまま置き換えますか？」の確認が一度も出ず ②「分けて知らせる」の既定にも戻らず、
      //   もう入っている分納が黙って全部消えていた。自発登録(上の 'lot' の枝)と同じ物を渡してそろえる。
      //   ⚠依頼の items[] には lotId が無いことがある。その時は今までどおり null(何も入っていない扱い)。
      tplLabel: tplNameForItem(it), current: (it.lotId && arrivalByLot[it.lotId]) || null,
      canAskFinish: !!l, askedFinish: l ? askedFinishOf(l.id) : true, onAskFinish: () => { if (l) askFinish(l); setSheet(null); },
      // 💬ひとこと。ロットが手元に無い(依頼の中身だけ)時も、依頼に書いてある指図・品目コードで送れるようにする
      onSendMessage: (m) => sendPortalMessage(l || { id: it.lotId || '', orderNo: it.orderNo || '', model: it.model || '' }, m), defaultSerial: '',
      submitLabel: 'この時間で返事する',
      onSubmit: (when) => answerArrivalItem(r, sheet.idx, when),
      onCancel: (() => { const ce = arrivalEntryOf(it.lotId, r.id, sheet.idx); return ce && (deleteData && !!group && ce.group === group) ? () => { if (cancelArrival(ce)) setSheet(null); } : null; })(),
    };
  })();

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 bg-slate-800 text-white px-3 py-2.5 flex items-center gap-2 flex-wrap shadow-md">
        <MessageCircle className="w-5 h-5 text-blue-300 shrink-0" />
        <div className="font-black whitespace-nowrap"><span className="hidden sm:inline">工程</span>連絡ポータル</div>
        <span className="bg-blue-600 rounded-full px-2.5 py-0.5 text-sm font-black whitespace-nowrap">{group}</span>
        <button onClick={() => { if (!window.confirm('グループを選び直しますか？(表示される依頼が切り替わります)')) return; try { localStorage.removeItem('renrakuGroup'); } catch (e) { /* noop */ } setGroup(''); }} className={`${t11} font-bold text-slate-200 border border-slate-500 rounded-lg px-2.5 py-1.5 whitespace-nowrap hover:bg-slate-700${mTap}`}>変更</button>
        <input value={name} onChange={e => { setName(e.target.value); try { localStorage.setItem('renrakuName', e.target.value); } catch (err) { /* noop */ } }} placeholder="名前(任意)" className={`ml-auto w-24 min-w-0 flex-1 max-w-[9rem] bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-sm${mTap}${narrow ? ' min-w-24' : ''}`} />
        {/* 表示の切替(PCで横がすかすかになるのを直す)。自動→PC→スマホ の順に回る。
            ⚠ 文字も回り方も domain/layoutMode.js が持っている物をそのまま使う(ここで作らない)。 */}
        <button onClick={cycleLayout}
          title="画面の並べ方を切り替えます（自動 / PC向けに広く / スマホ向けに縦1列）"
          className={`${t11} font-bold text-slate-200 border border-slate-500 rounded-lg px-2.5 py-1.5 whitespace-nowrap hover:bg-slate-700 shrink-0${mTap}`}>
          {layoutLabel}
        </button>
        {/* 💡この画面への要望・不具合。組立側からも出せるようにする(使う人が一番よく分かっている)
            ⚠設定(要望箱そのもの / 組立からも出せる)がOFFなら入口ごと消す */}
        {feedbackConfigOf(contactShared).enabled && feedbackConfigOf(contactShared).portal && (
          <button onClick={() => setFeedbackOpen(true)} title="要望を出す・みんなの声を見る"
            className={`p-1.5 rounded-lg shrink-0 bg-slate-700 hover:bg-slate-600 text-amber-300${mTapSq}`}>
            <Lightbulb className="w-5 h-5" />
          </button>
        )}
        <button onClick={() => setShowPushCfg(v => !v)} title="通知とアプリの設定" className={`relative p-1.5 rounded-lg shrink-0 ${showPushCfg ? 'bg-amber-500 text-white' : 'bg-slate-700 hover:bg-slate-600 text-amber-300'}${mTapSq}`}>
          <Bell className="w-5 h-5" />
          {/* 通知が使える状態なのに未登録なら赤ドットで気づかせる */}
          {!!(pushCfgOf(settings).vapidKey && pushCfgOf(settings).workerUrl) && !(pushTokens || []).find(t => t && t.id === pushDeviceId()) && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-rose-500 rounded-full animate-pulse" />}
        </button>
      </header>
      {/* 組立ポータルからの要望。side='portal' で「相手側から出た」と分かるようにする */}
      {/* ⚠組立の人にも「みんなの声」と返事を見せる。出した本人が返事を見られないと、二度と書かれない。 */}
      <FeedbackModal
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        onSubmit={onSendFeedback}
        app="product"
        side="portal"
        defaultBy={name || ''}
        places={['到着予定を知らせる', '返事をお願いします', '検査から', 'やりとりの履歴', '通知の設定', '制御装置（号機）']}
        items={appFeedback}
        shared={contactShared}
        onComment={onFeedbackComment}
        onAgree={onFeedbackAgree}
      />
      {/* 📣「アプリを直したよ」。開いた時に1回だけ出る(端末ごとに覚える)。 */}
      <NoticePopup notices={appNotices} app="product" side="portal" enabled={noticeConfigOf(contactShared).enabled} />
      {showPushCfg && (
        <div className={`mx-auto px-4 pt-3 w-full ${wide ? 'max-w-[1500px]' : 'max-w-3xl'}`}>
          <div className={`${card} p-4 flex flex-col gap-3`}>
            {/* ⚠アプリとして入れる案内は、以前この画面の一番上に出しっぱなしにしていた。
                入れ終わった人には毎回ただの邪魔物なので、🔔(通知の設定)を押した時だけここに出す。
                通知の話とアプリを入れる話は同じ1セットなので、置き場所としてもここが正しい。 */}
            <div className="rounded-2xl border-2 border-emerald-300 px-3 py-2.5 flex flex-col gap-1.5">
              <div className="text-sm font-black text-emerald-800">⬇️ この画面をアプリとして入れてください</div>
              <div className="fi-tap-text text-slate-500">
                入れると、この端末の設定に「連絡ポータル」という項目が現れ、<b>通知の重要度を「緊急」</b>に上げられます。ブラウザで開いているだけだとその設定が存在せず、<b>通知が出ない・後からまとめて来る・画面が黒いまま</b>のままです。<b>入れた後に重要度を上げるまでが1セット</b>（やり方は下の「設定方法」）。
              </div>
              <InstallAppButton compact />
            </div>
            <PushSettingsPanel
              settings={settings} saveSettings={null} saveData={saveData} deleteData={deleteData}
              pushTokens={pushTokens} side="portal" group={group} personName={byName} admin={false}
              onOpenHelp={() => setShowPushHelp(true)}
            />
          </div>
        </div>
      )}
      {showPushHelp && <PushHelpModal onClose={() => setShowPushHelp(false)} sideLabel={sideLabel} />}
      <main className={`mx-auto p-4 flex flex-col gap-6 pb-16 ${wide ? 'max-w-[1500px]' : 'max-w-3xl'}`}>
        {wide ? (
          <>
            {/* PC: 左=いちばんやってほしい「到着予定を知らせる」/ 右=返事が要るもの+検査からの情報 */}
            <div className="grid grid-cols-12 gap-6 items-start">
              <div className="col-span-7 flex flex-col gap-6">{secRegister}</div>
              <div className="col-span-5 flex flex-col gap-6">{secTodo}{secInfo}</div>
            </div>
            {secControl}
            {secHistory}
          </>
        ) : (
          <>
            {secTodo}
            {secRegister}
            {secInfo}
            {secControl}
            {secHistory}
          </>
        )}
      </main>
      {sheetProps && (
        <ArrivalSheet
          {...sheetProps}
          dates={quickDates} times={quickTimes} todayStr={todayStr}
          showQty={showQty} showDue={showDue}
          onClose={() => setSheet(null)}
        />
      )}
      {showNewLot && (
        <NewLotSheet
          models={modelOptions}
          dates={quickDates} times={quickTimes} todayStr={todayStr}
          onSubmit={sendNewLot}
          onClose={() => setShowNewLot(false)}
        />
      )}
      {zoomImg && (
        <div className="fixed inset-0 z-[98] bg-black/80 flex items-center justify-center p-3" onClick={() => setZoomImg(null)}>
          <img src={zoomImg} alt="" className="max-w-full max-h-full rounded-lg" />
          <button className="absolute top-3 right-3 bg-white/20 rounded-full p-2 text-white"><X className="w-5 h-5" /></button>
        </div>
      )}
    </div>
  );
};

// 🚚到着予定の札。
// ⚠⚠ 清水さん(2026-08-01):
//   「到着予定で到着時間とカードの表示が被ってるからなんとかして」
//   「到着予定があるやつは他の作業エリアにもっていっても到着時間表示はカードにつけたままに
//     しておいてほしい、そのエリアでいつものが届くかわかるからね」
//   → ①カードの **上に浮かせない**(指図番号が隠れる)。カードの中の1行として並べる。
//     ②到着予定エリア専用にしない。**カードの持ち物**にして、どのエリアへ移しても付いて回る。
//   ⚠分納は「次に来る便」で出す(1便目が着いただけで⚠が出っぱなしにならない)。
const ArrivalTag = ({ arrival, compact = false }) => {
  if (!arrival || !arrival.time) return null;
  const aw = arrivalWhenOf(arrivalForWhen(arrival));
  if (aw.when === ARRIVAL_WHEN.NONE) return null;
  const cls = aw.when === ARRIVAL_WHEN.PAST ? 'bg-amber-100 text-amber-900 border-amber-400'
    : aw.when === ARRIVAL_WHEN.TODAY ? 'bg-teal-600 text-white border-teal-700'
    : aw.when === ARRIVAL_WHEN.TOMORROW ? 'bg-sky-100 text-sky-900 border-sky-300'
    : 'bg-white text-teal-700 border-teal-300';
  const splits = splitsOf(arrival);
  // 🚚 この札が「組立が直接このロットについて言ってきた物」なのか、
  //    「同じ指図の別ロットへ検査が反映して広げた物」なのかを、必ず見て分かるようにする。
  //    ⚠広げた物には元になった連絡が1件しか無い。時間を変えたい時は元の連絡の側を直す。
  const spread = !!arrival._spreadFrom;
  const splitTitle = splits.length > 1 ? `分納 ${splits.length}回: ${formatSplits(splits, { withDate: true, max: MAX_SPLITS })}` : '組立から教えてもらった到着予定';
  const spreadTitle = spread
    ? `／ ⚠この札は同じ指図の別ロットへの連絡を、検査が「到着予定を反映」した時に広げた物です${arrival._spreadBy ? `（反映: ${arrival._spreadBy}）` : ''}。組立がこのロットについて直接言ってきた物ではありません。`
    : '';
  return (
    <div className={`${compact ? 'fi-tap-text px-1.5 py-0.5' : 'text-xs px-2 py-0.5'} font-black rounded border w-fit max-w-full truncate ${cls}`}
      // ⚠最終検査(App.firebase.jsx:3157)は日付付きなのに、製品だけ時刻だけだった。表記を揃える。
      title={`${splitTitle}${spreadTitle}`}>
      {/* ⚠棚のカード(compact)では「予定」の2文字を落とす。札の色と🚚で意味は伝わるのに、
             この2文字だけでカードが30pxほど伸びていた。広い所では今までどおり書く。 */}
      🚚 {aw.when === ARRIVAL_WHEN.PAST ? '⚠' : ''}{compact ? String(aw.label || '').replace(/\s*予定$/, '') : aw.label}
      {splits.length > 1 && <span className="font-normal opacity-90"> ・{splits.length}便</span>}
      {/* ⚠棚のカード(compact)では「・同じ指図から」の7文字が札を90pxほど伸ばし、
             カード全体が横に長くなる原因になっていた(清水さん 2026-08-10)。
             印だけにして、意味は title(上のspreadTitle)に残す。広い所では今までどおり書く。 */}
      {spread && (compact
        ? <span className="font-normal opacity-90" title="同じ指図から広げた札"> ↗</span>
        : <span className="font-normal opacity-90"> ・同じ指図から</span>)}
    </div>
  );
};

// 🛠 カードの ✏編集／🗑削除 を出す窓(2026-09-09 清水さん「現場マップとかで編集とか削除するところがボタン隠れてて見えない」)。
//   今までは ⋮ を押すと <details> の小さな窓が **カードの中** に開いていた。カードは overflow-hidden なので、
//   窓のうちカードの外へはみ出す分(下へ約80px)が **切られて編集／削除が見えなかった**。
//   → body へ描く(createPortal)。どのカード・エリアの overflow にも切られない。
//   ⚠ 背景を押したら **閉じるだけ**(取り消せない確定はしない。2026-08-21 の決まり)。
//   ⚠ カードの onClick(作業画面を開く)・長押しドラッグへ伝えない(stopPropagation)。
//   ⚠ 削除の確認文は前の ⋮ の窓と1文字も変えていない。

// 📤 App.jsx / ContactHub.jsx から使う物
export {
  buildArrivalByLot, RENRAKU_PORTAL, CONTACT_REPLY_CHOICES, contactReplyLabel, InstallAppButton,
  contactGroupsOf, contactMembersOf, contactSideLabel, newContactId, contactAttachmentOf, fmtContactTime, contactKindLabel,
  CONTACT_SEEN_LS_KEY, contactArrivalDT, contactFeedEvents, ContactReplyTicker, ContactArrivalApplyModal,
  contactRoutingOf, contactRemindOf, contactCompleteOf, contactThanksOf, contactAutoAskOf, contactArrivalOf, contactCompleteGroupFor,
  contactUnlockAudio, contactBeep, contactShouldBeep, contactSoundOn, contactSoundCfg, contactEventAlarmText,
  CONTACT_SHARED_NS, contactMergeShared, CONTACT_INTERNAL_GROUP, CONTACT_INTERNAL_TOPICS,
  pushCfgOf, contactPushMessage, firePushNotify, ForegroundPushToast, ContactAlarm, PushHelpModal, PushSettingsPanel,
  ContactSendModal, WorkContactPanel, ContactAskArrivalModal, ContactInternalModal, ContactThread, ContactView,
  ArrivalSheet, NewLotSheet, FinishEtaBlock, ContactPortal, ArrivalTag,
};
