// =============================================================================
// 📨 工程連絡の「App 側」— 製品 src/App.jsx の App 本体にある連絡の配線を1か所に集めて写した。
//   P060(未読・音・ティッカー) / P070(連絡タブの購読) / P126(検査完了の連絡) / P140(プッシュ) /
//   P142(到着予定→入荷時刻へ自動反映) / P162(再通知・上司へ) / P163(アイコンの数字)。
//   写した範囲: 製品 App.jsx 45178-45186・45224-45238・45307-45323・45325-45755・50154-50280。
//   ⚠ App.jsx は他の組も同時に変えるので、App へは「useContactHub を呼ぶ1行と描く所」だけを足す。
//   ⚠ 品目コード(lot.model)は鍵のまま。品名(modelText)は見せる所だけで足す。
// =============================================================================
import React, { useState, useEffect, useMemo, useRef } from 'react';
/* eslint-disable react-refresh/only-export-components -- hook と画面部品を1つの窓口にまとめる為(開発中の再読込が効かないだけ) */
import { CheckCircle2, Send } from 'lucide-react';
import {
  RENRAKU_PORTAL, buildArrivalByLot, contactMergeShared, CONTACT_SHARED_NS, firePushNotify, CONTACT_SEEN_LS_KEY,
  contactFeedEvents, contactShouldBeep, contactEventAlarmText, contactUnlockAudio, contactSoundOn, contactSoundCfg, contactBeep,
  fmtContactTime, contactCompleteGroupFor, contactCompleteOf, newContactId, contactRemindOf, contactKindLabel, contactRoutingOf,
  contactGroupsOf, contactArrivalDT, contactArrivalOf, contactThanksOf, contactAutoAskOf, contactSideLabel, contactMembersOf,
  contactPushMessage, ForegroundPushToast, ContactAlarm, ContactReplyTicker, ContactArrivalApplyModal, ContactView,
  ContactSendModal, WorkContactPanel,
} from './ContactKit.jsx';
import { mergeArrivalEntries } from '../domain/contactBoard.js';
import {
  lotQtyOf, completePartsOf, sentQtyOf, remainingQtyOf, isFullyNotified, isDeclined, canSendComplete,
  buildCompletePart, completeNotifyPatch, completeMessage,
} from '../domain/completeSplit.js';
import { ACTUAL_COL, buildActual, actualIdOf, remindMessage } from '../domain/arrivalActual.js';
import { settleSaveBriefly, mayCloseAfterSave, SAVE_REFUSED_MESSAGE } from '../domain/settleSave.js';
import { resolveItemName } from '../domain/itemMaster.js';

const DEFAULT_CONTACT_GROUPS_FALLBACK = ['組立'];

/**
 * 工程連絡の状態と見回りを1つにまとめた hook。App の最上位で1回だけ呼ぶ。
 * ⚠ 購読(contact_requests / arrival_times / push_tokens)もここで張る(App の購読の並びは触らない)。
 */
export const useContactHub = ({
  db, user, DATA, APP_DATA_ID, settings, saveSettings, saveData, deleteData, lots, lotsLoaded = true,
  currentUserName, activeTab, setActiveTab, contactShared, templates = [], setErrorMsg = null,
  calculateLotEstimatedTime = null, readFailed = null, cleanUndefined = (o) => o,
}) => {
  const [contactRequests, setContactRequests] = useState([]);
  const [arrivalTimes, setArrivalTimes] = useState([]);
  const [pushTokens, setPushTokens] = useState([]);
  const [arrivalsLoaded, setArrivalsLoaded] = useState(false);
  // 部品の設定は読めた時に comboPresets を必ず配列で入れる(App の watchDoc)。読む前の初期値には無い。
  const settingsLoaded = Array.isArray(settings?.comboPresets);
  // 工程連絡 機能全体のON/OFF (マスタ設定で切替)。⚠製品と同じく既定は ON。
  // ⚠ 既定: 部品では OFF(相手が部品の棚を読む画面がまだ無い)。マスタ設定の「工程連絡」で入れる。製品は既定 ON。
  const contactFeatureOn = settings?.contactFeature?.enabled === true;
  useEffect(() => {
    if (!user || !db || !DATA || !(contactFeatureOn || RENRAKU_PORTAL)) return;
    const P = DATA(db);
    const onErr = (c) => (readFailed ? readFailed(c) : (e) => console.warn(c, e));
    const un = [
      P.watchCollection(APP_DATA_ID, 'contact_requests', (rows) => setContactRequests(rows || []), { onError: onErr('contact_requests') }),
      P.watchCollection(APP_DATA_ID, 'arrival_times', (rows) => { setArrivalTimes(rows || []); setArrivalsLoaded(true); }, { onError: onErr('arrival_times') }),
      P.watchCollection(APP_DATA_ID, 'push_tokens', (rows) => setPushTokens(rows || []), { onError: onErr('push_tokens') }),
    ];
    return () => un.forEach(u => { try { if (typeof u === 'function') u(); } catch { /* noop */ } });
  }, [user, db, contactFeatureOn]); // eslint-disable-line react-hooks/exhaustive-deps -- 窓口と名前空間は起動中に変わらない
  const arrivalByLot = useMemo(() => buildArrivalByLot(arrivalTimes, contactRequests, lots), [arrivalTimes, contactRequests, lots]);
  const contactSettings = useMemo(() => contactMergeShared(settings, contactShared), [settings, contactShared]);
  // 共通の棚(宛先グループ・班メンバー)への保存。製品・最終・部品で同じ班を見る。
  const saveContactShared = async (patch) => {
    if (!db || !user) return;
    try { await DATA(db).save(CONTACT_SHARED_NS, 'settings', 'config', cleanUndefined({ ...patch, updatedAt: Date.now() })); }
    catch (e) { console.error(e); if (setErrorMsg) setErrorMsg(e.message || '宛先グループの保存に失敗しました'); }
  };
   // 通知音: この端末で最初にどこかを触った時に解禁する(ブラウザは操作前に音を鳴らせない)。
   //   解禁できたかは contactAudioReady() で判る。解禁前は連絡タブに「🔔音を有効にする」を出す。
   useEffect(() => {
     if (RENRAKU_PORTAL) return;
     const on = () => contactUnlockAudio();
     window.addEventListener('pointerdown', on, { passive: true });
     window.addEventListener('keydown', on, { passive: true });
     return () => { window.removeEventListener('pointerdown', on); window.removeEventListener('keydown', on); };
   }, []);
   // 工程連絡のプッシュ通知送信(fire-and-forget)。settings.push 未設定なら何もしない。
   const notifyContactPush = (args) => { if (contactFeatureOn) firePushNotify(contactSettings, pushTokens, args, deleteData); };
   // 工程連絡OFFに切り替わった時、連絡タブに居た端末が空白画面に取り残されないよう検査リストへ退避
   useEffect(() => { if (!contactFeatureOn && activeTab === 'contact') setActiveTab('inspection'); }, [contactFeatureOn, activeTab, setActiveTab]);
   // 返信の画面内通知: 未読 = 既読時刻(この端末のlocalStorage)より新しい返信。連絡タブを開いたら自動既読。
   // 初回起動の端末は「今」を既読起点にする(過去の返信が全部未読で溢れるのを防ぐ。通知は今後の新着だけ)
   const [contactSeenAt, setContactSeenAt] = useState(() => { try { const v = Number(localStorage.getItem(CONTACT_SEEN_LS_KEY)); if (v) return v; localStorage.setItem(CONTACT_SEEN_LS_KEY, String(Date.now())); } catch { /* noop */ } return Date.now(); });
   const markContactSeen = () => { const t = Date.now(); setContactSeenAt(t); try { localStorage.setItem(CONTACT_SEEN_LS_KEY, String(t)); } catch { /* noop */ } };
   const contactUnseen = useMemo(() => {
     if (!contactFeatureOn) return [];
     // 到着回答は「検査リストへ反映」済みなら通知からも消す(仕事が終わったサイン)
     return contactFeedEvents(contactRequests, currentUserName).filter(ev => ev.at > contactSeenAt && !(ev.type === 'arrival' && ev.it?.applied));
   }, [contactFeatureOn, contactRequests, contactSeenAt, currentUserName]);
   useEffect(() => { if (activeTab === 'contact' && contactUnseen.length) markContactSeen(); }, [activeTab, contactUnseen.length]);
   // 連絡アラーム(確認を押すまで鳴り続ける)用のイベント。検査側は画面内フィードから拾う(返信はプッシュが飛ばないことがあるため)。
   const contactAlarmEvents = useMemo(() => (contactUnseen || []).filter(ev => contactShouldBeep(ev)).map(ev => ({ key: ev.key, title: contactEventAlarmText(ev), body: '' })), [contactUnseen]);
  const knowledgeNew = 0; // 部品には📚知識標準の新着がまだ無い
   //     「画面の赤い数字の合計 === アイコンの数字」の約束が壊れる)。
   //     📚知識標準の新着も、新しい setAppBadge を足すのではなく **この n に足し込んである**。
   //   ⚠knowledgeNew より **後**に置くこと(前に置くと宣言前参照で画面が真っ白になる)。
   useEffect(() => {
     // ⚠⚠ **連絡ポータル(?renraku=1)では書かない。**
     //   ポータルには ContactPortal 自身の書き手がある。ここも走ると書き手が2人になり、
     //   後から走るこちらが勝つ。しかもポータルには連絡タブが無く markContactSeen が
     //   一度も呼ばれないので、**組立のアイコンの数字が増える一方で一生消えない**。
     //   同じ hook の兄弟は全部このガードを持っていて、ここだけ抜けていた(2026-08-14 発覚)。
     if (RENRAKU_PORTAL) return;
     if (!('setAppBadge' in navigator)) return; // 非対応ブラウザ(iOS Safari等)は黙って何もしない
     const n = (contactFeatureOn ? contactUnseen.length : 0) + knowledgeNew;
     try { if (n > 0) navigator.setAppBadge(n); else navigator.clearAppBadge(); } catch { /* 権限なし等。バッジは飾りなので握りつぶす */ }
   }, [contactUnseen.length, contactFeatureOn, knowledgeNew]);
   // 緊急の連絡が新しく届いたら音を鳴らす。鳴らすのは緊急だけ(全部鳴らすと必ず無視されるようになる)。
   //   同じ出来事で二度鳴らさないよう、鳴らしたキーを覚えておく。
   const beepedRef = useRef(new Set());
   useEffect(() => {
     if (RENRAKU_PORTAL || !contactFeatureOn || !contactSoundOn(settings)) return;
     const sc = contactSoundCfg(settings);
     const fresh = (contactUnseen || []).filter(ev => contactShouldBeep(ev, sc.types) && !beepedRef.current.has(ev.key));
     if (!fresh.length) return;
     // 鳴らせた時だけ「鳴らした」と記録する。解禁前(音が出ない)に記録すると、その連絡は二度と鳴らなくなる。
     if (contactBeep(sc.count, sc.freq, sc.volume)) fresh.forEach(ev => beepedRef.current.add(ev.key));
   }, [contactUnseen, contactFeatureOn, settings]);
   // 到着回答→検査リスト反映モーダル (ティッカー/連絡タブ詳細のどちらからでも開ける)
   const [arrivalApply, setArrivalApply] = useState(null); // {reqId, itemIdx}
   const [completePrompt, setCompletePrompt] = useState(null); // 検査完了→組立へ完了連絡の確認 {lot}
   const completeSeenRef = useRef(null); // このセッション開始時点の完了ロット集合(基準)。初回ロード分にはプロンプトを出さない。
  const contactEstimateSecOf = (lot) => (calculateLotEstimatedTime ? calculateLotEstimatedTime(lot, settings?.customTargetTimes || {}, (settings && Array.isArray(settings.modelGroups)) ? settings.modelGroups : []) : 0);
   // 検査完了→次工程(組立)へ完了連絡を送る。宛先(grp)は送信時に選んだ班。役職ルーティングでその班の職長の携帯が鳴る。
   //   製品(型式)によって連絡する職長が違うので、送った班は型式ごとに記憶し、次回その型式が完了した時の既定にする。
   //   確認返信(ack)がOFFの時は status='notice' = 返事を求めないお知らせ。どちらでも催促(再通知・エスカレーション)はしない。
   // 戻り値 = 「プロンプトを閉じてよいか」。false は **保存が拒否された時だけ**(閉じると印の無いまま消える)。
   // 🚨 2026-08-31: 送信の2本の保存(依頼と、二重送信を止める印)を **投げっぱなしにしない**。
   //   印(completeNotified)が待ち行列に入らないまま画面を閉じると、他の端末から同じ連絡がもう一度送れる。
   //   ⚠順番は **依頼(見届け) → 印(見届け)**。
   //     ・依頼が拒否されたら印を書かない = 「送っていないのに連絡済み」を作らない(2026-08-21 の族)。
   //     ・印だけ拒否されたら、開いたまま断りを出す。やり直すと相手に二重に届き得るが、
   //       二重は**見えて直せる**。逆(印だけ在って連絡が無い)は誰にも見えない。
   //     ・詰まっている(pending)だけなら両方とも端末の待ち行列に順番どおり入るので進んでよい。
   // 🚨🚨 2026-08-31(夜) **同じ端末の2度押しガード**。
   //   送信は「依頼を見届ける → 印を見届ける」で最大6秒かかる。その間ボタンが押せたままだったので、
   //   2回押すと **依頼2件+印2件** が入った(順番を直した副作用。直す前は印を先に投げていたので
   //   2度目が「連絡済み」で止まっていた)。他端末との窓(印が依頼の受領後に遅れる分)は残るが、
   //   そちらは merge の設計が「見えて直せる二重」として許容している既存の性質。
   //   ⚠押した瞬間に効くのは ref だけ(state は次の描き直しまで反映されないので2度押しには間に合わない)。
   //   ⚠2度目は **false**(=窓を閉じない)を返す。1度目の結果だけが窓を閉じてよいかを決める。
   const completeSendingRef = useRef(false);
   const [completeBusy, setCompleteBusy] = useState(false);
   const sendComplete = async (lot, grp, qty = null) => {
     if (completeSendingRef.current) return false;
     completeSendingRef.current = true;
     setCompleteBusy(true);
     try { return await sendCompleteOnce(lot, grp, qty); }
     finally { completeSendingRef.current = false; setCompleteBusy(false); }
   };
   const sendCompleteOnce = async (lot, grp, qty = null) => {
     if (!lot) return true;
     // 二重送信ガード: このプロンプトは開いている全端末に同時に出る。自分がモーダルを開いている間に
     // 別端末が送信/見送りを済ませている事があるので、押された時点の最新のロットで必ず確かめる
     // (completePrompt.lot は完了した瞬間のスナップショットで、その後の他端末の操作を知らない)。
     //   ⚠**分納にしたので「1件でも送っていたら止める」ではダメ**。まだ残りがあるなら送れる。
     const cur = (lots || []).find(l => l && l.id === lot.id) || lot;
     const cn = cur.completeNotified || null;
     if (cn && cn.declined) {
       alert(`この指図は ${cn.by || '別の人'} が ${cn.at ? fmtContactTime(cn.at) : ''} に「連絡しない」を選んでいます。二重に送らないよう、送信を取りやめました。`);
       setCompletePrompt(null); return true;
     }
     if (isFullyNotified(cur)) {
       alert(`この指図は ${cn?.by || '別の人'} が ${cn?.at ? fmtContactTime(cn.at) : ''} に ${cn?.group || ''} へ 全${lotQtyOf(cur)}台 連絡済みです。二重に送らないよう、送信を取りやめました。`);
       setCompletePrompt(null); return true;
     }
     const total = lotQtyOf(cur);
     const sentBefore = sentQtyOf(cur);
     const n = qty == null ? remainingQtyOf(cur) : Math.floor(Number(qty) || 0);
     // 🚨🚨 2026-08-31(夜) ここから下の2つは **1バイトも送っていない** ので false を返す(=窓を開けたまま)。
     //   直す前は true を返していた。呼び出し側は `if (ok) setCompletePrompt(null)` なので、
     //   何も送っていないのに窓が閉じ、その指図は自動プロンプトが二度と出ない(completeSeenRef が進む)。
     //   📦の復旧一覧も sentQtyOf>0 が条件なので載らない ＝ **連絡する道が消える**。
     //   2026-08-21「背景タップで取り消せない確定をするな(最終検査の完了連絡が一度も飛んでいなかった)」と同じ族。
     //   ⚠上の2つ(別の人が「連絡しない」を選んだ / 既に全数連絡済み)は話が片付いているので閉じてよい。
     //     こちらは **人が直せば送れる** ので閉じない(台数を直す / グループを足す)。
     const chk = canSendComplete(cur, n);
     if (!chk.ok) { alert(chk.reason); return false; }
     const g = String(grp || '').trim() || contactCompleteGroupFor(contactSettings, lot.model);
     if (!g) { alert('連絡先グループが未設定です（連絡タブの「宛先・公開設定」でグループを追加してください）'); return false; }
     const needAck = contactCompleteOf(contactSettings).ack;
     const id = newContactId();
     const pReq = saveData('contact_requests', id, {
       kind: 'complete', to: g, from: currentUserName || '検査',
       orderNo: lot.orderNo || '', model: lot.model || '', quantity: n,
       lotQty: total, sentTotal: sentBefore + n,   // 相手が「何台のうち何台か」を見られるように
       // ⚠型式を必ず入れる。指図番号だけだと相手は何の話か分からない(清水さん指摘 2026-08-01)。
       message: completeMessage({ model: lot.model, qty: n, total, sentBefore }),
       needAck, // 送った時点の設定を焼き付ける(後で設定を変えても、送信済みのカードの見え方は変わらない)
       createdAt: Date.now(), status: needAck ? 'waiting' : 'notice',
     });
     // ① 依頼を見届ける。拒否なら印も書かない(「送っていないのに連絡済み」を作らない)。
     const rReq = await settleSaveBriefly(pReq);
     if (!mayCloseAfterSave(rReq)) { alert(SAVE_REFUSED_MESSAGE); return false; }
     // ② ⚠parts は **1件だけ** を送る(merge:true が既存の便を残す)。数値の合計は保存しない。
     const rLot = await settleSaveBriefly(saveData('lots', lot.id, completeNotifyPatch(cur, buildCompletePart({
       id, qty: n, by: currentUserName || '検査', group: g, now: Date.now(),
     }))));
     if (!mayCloseAfterSave(rLot)) {
       alert('🚨 連絡は送れましたが、「送った」の印の保存が拒否されました。画面は閉じません。\n\n'
         + '通信を確かめて、もう一度「連絡する」を押してください。\n'
         + '（やり直すと相手に同じ連絡が二重に届く事があります。二重なら相手の画面で分かります）');
       return false;
     }
     const m = String(lot.model || '').trim();
     if (m && contactCompleteOf(contactSettings).modelGroups[m] !== g) {
       saveSettings({ contactComplete: { ...(settings?.contactComplete || {}), modelGroups: { ...contactCompleteOf(contactSettings).modelGroups, [m]: g } } });
     }
     notifyContactPush({ toGroup: g, toSide: 'portal', toLevel: 'auto', title: `✅ 検査完了: ${lot.orderNo || ''} ${lot.model || ''}`, // ⚠分納: 指図の総数(lot.quantity)ではなく **今回送った台数** を書く(「4台完了」と出て2台しか無い、を防ぐ)
       body: `${completeMessage({ model: lot.model, qty: n, total, sentBefore })}（${currentUserName || '検査'}）`, link: `${window.location.origin}/?renraku=1`, tag: `done-${lot.id}-${sentBefore + n}` });
     return true;
   };
   // 🚚到着チェック。
   //   ⚠⚠ 保存先は **検査アプリ自身の棚(arrival_actuals)**。
   //     連絡の棚(arrival_times / contact_requests)には1バイトも書かない。
   //     あそこは組立ポータルがそのまま読んでいるので、書いた瞬間に相手へ見える。
   const checkArrival = async (row, actualTs) => {
     if (!db) throw new Error('まだつながっていません');
     const rec = buildActual({
       lotId: row.lotId, orderNo: row.orderNo, model: row.model, group: row.group,
       date: row.date, time: row.time, plannedTs: row.planned, actualTs,
       qty: row.qty, by: currentUserName || '', now: Date.now(),
     });
     await DATA(db).save(APP_DATA_ID, ACTUAL_COL, rec.id, rec);
   };
   const undoArrivalCheck = async (row) => {
     try { await DATA(db).remove(APP_DATA_ID, ACTUAL_COL, actualIdOf(row.lotId, row.date, row.time)); }
     catch (e) { console.error(e); alert('取り消せませんでした: ' + (e?.message || e)); }
   };
   // 催促は **既存の連絡機能**で送る(新しい経路を作らない)。⚠宛先は班だけ(清水さん 2026-08-01)。
   const remindArrival = async (row) => {
     if (!row.group) { alert('この到着予定には班が記録されていないため、催促を送れません。'); return; }
     if (!window.confirm(`${row.group} へ催促を送ります。\n\n${remindMessage(row)}`)) return;
     const id = newContactId();
     try {
       await saveData('contact_requests', id, {
         kind: 'call', to: row.group, from: currentUserName || '検査', status: 'waiting',
         orderNo: row.orderNo || '', model: row.model || '',
         message: remindMessage(row),
         createdAt: Date.now(),
       });
       notifyContactPush({ toGroup: row.group, toSide: 'portal', toLevel: 'auto', title: `⏰ 到着の確認: ${row.orderNo || ''} ${row.model || ''}`, body: remindMessage(row), link: `${window.location.origin}/?renraku=1`, tag: `remind-${row.lotId}-${row.date}-${row.time}` });
     } catch (e) { console.error(e); alert('催促を送れませんでした: ' + (e?.message || e)); }
   };
   // 「連絡しない」= 見送りも全端末で共有する。ここを保存しないと、自分の画面から消えるだけで
   // 他の端末には同じモーダルが開いたまま残り、そこで押されて「キャンセルしたのに送られた」になる。
   //   送信と同じ completeNotified に declined を立てる(この印は 30533 の新規検出の除外にそのまま効く)。
   //   連絡は作らない・プッシュも出さない = 見送りは組立には一切伝わらない。
   // 🚨 2026-08-31: 保存の約束を返す(呼ぶ側が settleSaveBriefly で見届けてから閉じる)。
   //   「連絡しない」の印が待ち行列に入らないまま閉じると、他の端末のモーダルは開いたまま残り、
   //   そこで押されて「キャンセルしたのに送られた」になる(この関数の上の注釈の事故がそのまま再発する)。
   const declineComplete = (lot) => {
     if (!lot) return null;
     const cur = (lots || []).find(l => l && l.id === lot.id) || lot;
     if (!cur.completeNotified) return saveData('lots', lot.id, { completeNotified: { at: Date.now(), by: currentUserName || '検査', declined: true } });
     return null;
   };
   // 🚨2026-08-21 「連絡しない」を取り消せるようにする。
   //   本番実測: 完了124件のうち **98件(79%)** が「連絡しない」になっていて、8/13以降は15件中15件が全部それ。
   //   原因は、この確認の**外側をタップしただけで「連絡しない」が確定**していた事(その1タップで二度と送れなくなる)。
   //   外側タップは閉じるだけに直したが、既に付いた印を外せないと過去分が救えないので取り消しを足す。
   // 🚨 2026-08-31 SS-201: すぐ上の declineComplete は約束を返すのに、こちらは投げっぱなしだった。
   //   ここが黙って落ちると「連絡しない」の印が外れないまま画面だけ元に戻り、
   //   押した人は取り消せたと思う。その印が残る限り**二度と知らせられない**(8/21 の事故そのもの)。
   const undoDeclineComplete = async (lot) => {
     if (!lot) return;
     const cur = (lots || []).find(l => l && l.id === lot.id) || lot;
     if (!cur.completeNotified || !cur.completeNotified.declined) return;
     const r = await settleSaveBriefly(saveData('lots', lot.id, { completeNotified: null }));
     if (!mayCloseAfterSave(r)) { alert(SAVE_REFUSED_MESSAGE); return; }
   };
   // 未返信の自動フォロー: ①職長への再通知(N分毎×最大M回・修正/入荷それぞれON/OFF) ②上司へのエスカレーション(設定分で1回)。
   //   arrival(入荷・到着予定)は items が全部埋まると status='answered' になるので、待ちの間だけ対象。
   //   ⚠⚠この処理は全端末で1分ごとに走る。以前は「書いてから送る」だけで書き込みを待っていなかったため、
   //     2台が同じ古い状態を読むと同じ再通知・同じ上司通知を二重に送れた(監査確定)。
   //     → 送る前にトランザクションで「この1回を送る権利」を1台だけが取る。取れなかった端末は送らない。
   useEffect(() => {
     if (!contactFeatureOn || RENRAKU_PORTAL) return;
     // 権利取り: 期待した状態のままなら patch を書いて true。他端末が先に書いていたら false。
     //   ⚠通信失敗・認証失敗・サーバーエラーを「他端末に取られた」と同じ扱いにしない。
     //     どちらも送らない点は同じだが、原因が分からなくなると
     //     「通知が来ない」の調査で必ず迷子になる。理由を分けて記録する。
     const claim = async (reqId, expect, patch) => {
       if (!db) return false;
       const r = await DATA(db).claimOnce(APP_DATA_ID, 'contact_requests', reqId, expect, patch);
       if (r.acquired) return true;
       if (r.reason === 'error') console.warn('通知権の取得に失敗(送信を見送り)', r.error);
       return false;
     };
     const isWaiting = (r) => {
       if (!r || r.status === 'canceled' || r.status === 'done') return false;
       // 完了連絡=こちらから知らせるだけ(相手が確認しなくても催促しない)。社内連絡=宛先が検査側なので、あっち向けの再通知・エスカレーションの対象外。
       // 組立からの連絡(portalmsg)も向こうが出した物なので催促しない。
       // ⚠⚠ここを足し忘れると、下の受け皿で 'repair' 扱いになり、**出した本人(組立の班)へ**
       //   「まだ返信がありません」の再通知と、上司へのエスカレーションが飛ぶ。
       // 🆕 検査リストに無い品の連絡(newlot)も組立が出した物。返事を待っているのは**こちら(検査側)**。
       //   ⚠⚠外し忘れると status:'waiting' のまま拾われ、申告した組立班自身に催促プッシュが飛ぶ。
       if (r.kind === 'complete' || r.kind === 'internal' || r.kind === 'portalmsg' || r.kind === 'newlot') return false;
       if (r.kind === 'arrival' || r.kind === 'finish') return (r.items || []).some(i => !i.time);
       return r.status === 'waiting';
     };
     const check = () => {
       const now = Date.now();
       // 🚨 2026-09-02(NC3): 1tick で書く数に **上限** を付けた。
       //   前は「待っている連絡の件数ぶん」を1分ごとに全部なめていた＝1回で何件書くか上限が無い。
       //   ⚠ただ切るだけだと、後ろに並んだ連絡が **永久に催促されない**。
       //     だから **催促が古い順に並べてから** 切る。書けた物は lastRemindAt が今になって
       //     列の後ろへ回るので、次の1分で必ず次の6件が出てくる(取りこぼしゼロ)。
       //   ⚠時計は60秒のまま変えない。設定の remind.min は実測で **1分**(組立 南班・高木班)。
       //     時計を遅くすると、催促そのものが設定どおりに飛ばなくなる。
       //   6件の根拠: 1分間に鳴らす通知の実用上限。実測(2026-08-30の控え)で
       //     contact_requests は40件・うち待ちは10件。
       (contactRequests || [])
         .filter((r) => isWaiting(r) && r.createdAt)
         .sort((a, b) => Number(a.lastRemindAt || a.createdAt) - Number(b.lastRemindAt || b.createdAt))
         .slice(0, 6)
         .forEach(async (r) => {
         if (!isWaiting(r) || !r.createdAt) return;   // ⚠上の filter と同じ判定(念のため残す)
         // ⚠ここは受け皿。ここに落ちた種類は全部「修正依頼」として催促され、宛先は r.to になる。
         //   新しい種類を足す時は、必ず上の isWaiting で先に外すこと(でないと出した本人に催促が飛ぶ)。
         const kind = (r.kind === 'arrival' || r.kind === 'finish') ? 'arrival' : 'repair';
         // ① 職長への再通知(リマインド)
         const rm = contactRemindOf(contactSettings, r.to, kind);
         if (rm.on) {
           const sent = Number(r.reminds || 0);
           const base = Number(r.lastRemindAt || r.createdAt);
           if (sent < rm.count && now - base >= rm.min * 60000) {
             // 「reminds がまだ sent のまま」の時だけ書けた端末が送る(二重通知を止める)
             //   ⚠数として比べる。0 を null に潰すと reminds:0 が実在した時に永久に送れなくなる。
             const got = await claim(r.id, { reminds: sent }, { reminds: sent + 1, lastRemindAt: now });
             if (!got) return;
             firePushNotify(contactSettings, pushTokens, {
               toSide: 'portal', toGroup: r.to, toLevel: 'auto',
               title: `🔔 再通知(${sent + 1}/${rm.count}) ${contactKindLabel(r)}`,
               body: `${r.from || '検査'} → ${r.to}${r.toPerson ? ` ${r.toPerson}さん` : ''}: まだ返信がありません`,
               link: `${window.location.origin}/?renraku=1`, tag: `rem-${r.id}-${sent + 1}`,
             }, deleteData);
           }
         }
         // ② 上司へのエスカレーション(修正/呼出のみ・1回)
         if (kind === 'repair' && !r.escalatedAt) {
           const cfg = contactRoutingOf(contactSettings, r.to);
           if (cfg.escalateMin && now - r.createdAt >= cfg.escalateMin * 60000) {
             // 「まだ誰もエスカレーションしていない」時だけ書けた端末が送る(上司への二重通知を止める)
             const got = await claim(r.id, { escalatedAt: null }, { escalatedAt: now });
             if (!got) return;
             firePushNotify(contactSettings, pushTokens, {
               toSide: 'portal', toGroup: r.to, toLevel: 'boss',
               title: `⏰ ${cfg.escalateMin}分 返信なし: ${contactKindLabel(r)}`,
               body: `${r.from || '検査'} → ${r.to}${r.toPerson ? ` ${r.toPerson}さん` : ''}: ${String(r.message || '').slice(0, 100)}`,
               link: `${window.location.origin}/?renraku=1`, tag: `esc-${r.id}`,
             }, deleteData);
           }
         }
       });
     };
     const t = setInterval(check, 60000);
     return () => clearInterval(t);
   }, [contactFeatureOn, contactRequests, settings, pushTokens]); // eslint-disable-line react-hooks/exhaustive-deps
   // 検査完了→次工程(組立)への完了連絡: ロットが「このセッション中に」新しく完了したらワンタップ確認を出す。
   //   初回ロード時点の既存完了ロットは基準化して出さない(seenRef)。連絡済(completeNotified)は対象外。勝手には送らず必ず確認を挟む。
   useEffect(() => {
     if (RENRAKU_PORTAL || !contactFeatureOn) return;
     if (!lots || !lots.length) return; // ロット未ロード(初期空)の間は基準化しない。空を基準にすると、後で読み込まれた既完了ロットが全部「新規完了」に見えて起動時に誤発火する。
     const done = new Set(lots.filter(l => l && (l.status === 'completed' || l.location === 'completed')).map(l => l.id));
     if (completeSeenRef.current === null) { completeSeenRef.current = done; return; } // ロード完了時点の完了集合を基準に(以後の"新しい完了"だけ拾う)
     if (contactCompleteOf(contactSettings).enabled && contactGroupsOf(contactSettings).length) {
       const toMsC = (v) => (typeof v === 'number' ? v : (v && v.seconds ? v.seconds * 1000 : (v ? new Date(v).getTime() : 0)));
       const fresh = lots.find(l => {
         if (!l || l.completeNotified || completeSeenRef.current.has(l.id)) return false;
         if (!(l.status === 'completed' || l.location === 'completed')) return false;
         const t = toMsC(l.completedAt); // 念のため: 完了時刻が判る場合、6時間より前の古い完了には出さない
         return !t || (Date.now() - t) < 6 * 3600 * 1000;
       });
       // 宛先の初期値=この型式の前回の連絡先(無ければ設定の既定)。プロンプト上で変えられる。
       if (fresh) setCompletePrompt(p => p || { lot: fresh, group: contactCompleteGroupFor(contactSettings, fresh.model) });
     }
     completeSeenRef.current = done;
   }, [lots, contactFeatureOn, settings]); // eslint-disable-line react-hooks/exhaustive-deps
   // 開いているプロンプトは、別端末が「連絡した/連絡しない」を決めた時点で自動で閉じる。
   //   このモーダルは開いている全端末に同時に出るので、閉じないと「誰かがもう決めた件」を
   //   別の人がもう一度押せてしまう(=二重送信/取り消したはずの送信)。
   useEffect(() => {
     if (!completePrompt) return;
     const cur = (lots || []).find(l => l && l.id === completePrompt.lot.id);
     // ⚠分納にしたので「1件でも送ったら閉じる」ではダメ。**全部送り終わった時だけ**閉じる。
     //   ここを completeNotified の有無で見ていると、📦の残りリストから開いた瞬間に閉じてしまう。
     if (cur && (isDeclined(cur) || isFullyNotified(cur))) setCompletePrompt(null);
   }, [lots, completePrompt]);
   // 【初回だけの地ならし】この機能を入れる前から在る到着予定に「もう入れた」の印(applied)だけ付ける。ロットは絶対に触らない。
   //   これが無いと、機能を入れた瞬間に過去の到着予定が全部「新規」に見えて、手で直した入荷時間を黙って上書きしてしまう。
   //   印を付けたあとは「印の無い到着予定 = 本当に新しく登録された分」だけになるので、夜間に登録された分も翌朝ちゃんと入る。
   //   settings.contactArrival.baselinedAt が目印(1回で終わる)。地ならしが済むまで下の自動反映は動かさない。
   useEffect(() => {
     if (RENRAKU_PORTAL || !contactFeatureOn) return;
     if (!settingsLoaded || !arrivalsLoaded) return; // 設定と到着予定の両方が読めるまで待つ(空のまま地ならしすると、後から来た本物の新着を『昔からある』と誤判定する)
     if (settings.contactArrival?.baselinedAt) return; // 済み
     (arrivalTimes || []).forEach(a => {
       if (!a || !a.id || !a.time || a.applied) return;
       const ts = contactArrivalDT(a);
       if (ts) saveData('arrival_times', a.id, { applied: { at: Date.now(), entryAt: ts, by: 'baseline' } });
     });
     saveSettings({ contactArrival: { ...(settings.contactArrival || {}), baselinedAt: Date.now() } });
   }, [arrivalTimes, arrivalsLoaded, contactFeatureOn, settings, settingsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
   // 到着予定(あっちが登録/回答した「いつ来るか」)→ そのロットの入荷時間(entryAt)へ自動反映。
   //   arrival_times は docId=lotId なので対象ロットは一意に決まる。同じ指図でテンプレ違いのロットが複数ある場合の
   //   振り分けは従来どおり「検査リストへ反映」モーダルで人が選ぶ(ここでは触らない=勝手に別ロットへ書かない)。
   //   一度入れた到着(applied.entryAt)は入れ直さない → 後から入荷時間を手で直しても、この処理が上書きし返すことはない。
   //   あっちが到着時刻を変えた時だけ applied.entryAt と食い違うので、その時に入れ直す。
   // 🚨2026-08-31(夜) 進行中の印付け(ロット|時刻 → 返事待ち)と、断られた印付け(→ 断られた時刻)。
   //   ⚠描き直しで消えない入れ物に置く(消えると、走り直しのたびに同じ保存を投げ直す)。
   const arrivalApplyingRef = useRef(new Map());
   const arrivalRefusedRef = useRef(new Map());
   const ARRIVAL_APPLY_RETRY_MS = 60000; // 断られた到着を、次に試すまで置く長さ
   useEffect(() => {
     if (RENRAKU_PORTAL || !contactFeatureOn) return;
     if (!contactArrivalOf(settings).autoEntry) return;
     if (!settings?.contactArrival?.baselinedAt) return; // 地ならし前は動かさない(過去分の一斉上書きを防ぐ)
     if (!lotsLoaded) return; // 🚨読み込みの門: 読めていない間は自動で1バイトも書かない(2026-08-17)
     if (!lots || !lots.length || !arrivalTimes || !arrivalTimes.length) return;
     arrivalTimes.forEach(a => {
       if (!a || !a.id || !a.time) return;
       const ts = contactArrivalDT(a);
       if (!ts) return;
       if (a.applied && a.applied.entryAt === ts) return; // この到着はもう入れた(地ならし分もここで止まる)
       const lot = lots.find(l => l && l.id === a.id);
       if (!lot || lot.status === 'completed' || lot.location === 'completed') return;
       // 🚨「もう入れた」の印(applied)は、入れる本体(entryAt)の保存を見届けてから書く(2026-08-31)。
       //   直す前は印を先に投げっぱなしで書いていた。本体が拒否されると、印だけ残って
       //   ロットの入荷時間は古いまま・次の巡回も印を見て飛ばす = **二度と直らない**。
       //   拒否なら印を書かない → 次の巡回が自動でやり直す(この処理は元から冪等)。
       // 🚨🚨 2026-08-31(夜) **印は「サーバの本物の返事」にだけ乗せる**。
       //   直した直後は「entryAt が既に同じ値なら本体を書かずに印だけ書く」近道が残っていた。ところが
       //     ①この効果は lots が変わるたびに走り直す
       //     ②Firestore は投げた瞬間に **手元の lots を先に**書き換える(返事はまだ来ていない)
       //   ので、1回目の返事を待っている間に走り直した2回目が「もう同じ値だ」と見て
       //   **返事を待たずに印を書いていた**。拒否されても印だけ残る = 直そうとした事故がそのまま残っていた。
       //   → ⓐ同じ到着(ロット|時刻)の返事待ちの間は、走り直しをまるごと飛ばす
       //     ⓑ近道を捨てて必ず本体を書き、その **本物の返事** に印を乗せる
       //       (merge:true なので同じ値を書き直しても中身は変わらない=害はない)。
       const key = `${a.id}|${ts}`;
       if (arrivalApplyingRef.current.get(key)) return; // 返事待ち = 二重に書かない
       const refusedAt = arrivalRefusedRef.current.get(key) || 0;
       // ⚠拒否されるとロットが元に戻る=この効果がまた走る。間を置かないと拒否のたびに書き直し続ける。
       if (refusedAt && Date.now() - refusedAt < ARRIVAL_APPLY_RETRY_MS) return;
       arrivalApplyingRef.current.set(key, true);
       settleSaveBriefly(saveData('lots', a.id, { entryAt: ts })).then((r) => {
         arrivalApplyingRef.current.delete(key);
         if (!mayCloseAfterSave(r)) { arrivalRefusedRef.current.set(key, Date.now()); return; } // 拒否 = 印を書かない(次の巡回で再試行)
         arrivalRefusedRef.current.delete(key);
         saveData('arrival_times', a.id, { applied: { at: Date.now(), entryAt: ts, by: 'auto' } });
       });
     });
   }, [arrivalTimes, lots, lotsLoaded, contactFeatureOn, settings]); // eslint-disable-line react-hooks/exhaustive-deps
   // 到着予定に返信をもらったら「ご協力ありがとうございます」を自動で返す(依頼1件につき1回)。
   //   ⚠comments[] への追記にはしない: 配列の読んで書き足す方式は、開いている全端末が同時に走ると
   //     後勝ちで他人のコメントを消す。単一フィールド(autoThanks)なら何度書いても同じ結果になる。
   //   ⚠プッシュは出さない(お礼で鳴らすと本当の急ぎが埋もれる)。ポータルの履歴に出るだけ。
   useEffect(() => {
     if (RENRAKU_PORTAL || !contactFeatureOn) return;
     // ⚠⚠ MISTAKES.md A2: 設定が届く前に走らせない。
     //   contactThanksOf の既定は **ON**(`t.on !== false`)なので、読み込み前に走ると
     //   「切ってあるのに勝手にお礼が飛ぶ」。しかも文面も既定のものになる。
     //   最終検査には入っていたガードが、製品検査だけ抜けていた(2026-08-14 の点検で発覚)。
     if (!settingsLoaded) return;
     const cfg = contactThanksOf(settings);
     if (!cfg.on) return;
     (contactRequests || []).forEach(r => {
       if (!r || r.autoThanks || r.status === 'canceled') return;
       if (r.kind !== 'arrival' && r.kind !== 'finish') return;
       if (r._self) return;                                   // 自発登録(こちらが頼んでいない)は対象外
       const answered = (r.items || []).some(i => i && i.time); // 1件でも答えてもらえたらお礼
       if (!answered) return;
       saveData('contact_requests', r.id, { autoThanks: { at: Date.now(), text: cfg.text, by: '検査' } });
     });
   }, [contactRequests, contactFeatureOn, settings, settingsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
   // 【定時おうかがい】設定した時刻に「まだ到着予定をもらっていない指図」を班ごとにまとめて自動で聞く。
   //   ⚠このアプリにサーバーは無く、動くのは開いているブラウザだけ。全端末が同じ時刻に同じ処理を走らせるので、
   //     素直に作ると端末の数だけ依頼が飛ぶ。→ **docIdを日付+班で決め打ち**にして、何台が同時に書いても
   //     同じ1件を上書きするだけ(=物理的に増えない)ようにする。ランダムIDにしたら必ず二重送信になる。
   //   ⚠プッシュだけは端末ごとに飛びうるが、tag が同じなので携帯側では1つの通知に畳まれる。
   //   ⚠時刻を過ぎてから起動した端末が「今日のぶん」を送らないよう、送信は設定時刻から60分以内に限る。
   useEffect(() => {
     if (RENRAKU_PORTAL || !contactFeatureOn) return;
     const cfg = contactAutoAskOf(settings);
     if (!cfg.on) return;
     if (!settingsLoaded || !arrivalsLoaded) return;      // 未ロードで走ると「到着予定なし」に見えて全部聞いてしまう
     // 🚨読み込みの門(2026-08-31): lots.length>0 は「読み込みが終わった」の証拠にならない(MISTAKES A1)。
     //   片方の購読だけ届いた途中で走ると、依頼の items が「その時見えていた分だけ」で確定し、
     //   docId が日付+班の決め打ちなので **その日はもう作り直されない**(短いリストが焼き付く)。
     if (!lotsLoaded) return;
     if (!lots || !lots.length) return;
     const groups = contactGroupsOf(contactSettings);
     if (!groups.length) return;
     const tick = () => {
       const now = new Date();
       if (!cfg.days.includes(now.getDay())) return;
       const [hh, mm] = cfg.time.split(':').map(Number);
       const due = new Date(now); due.setHours(hh, mm, 0, 0);
       const diffMin = (now.getTime() - due.getTime()) / 60000;
       if (diffMin < 0 || diffMin > 60) return;            // まだ時刻前 / 遅れすぎ(今日のぶんは見送る)
       const dateKey = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
       // 対象 = 未完了で、入荷予定が lookaheadDays 以内(or 未定)で、まだ到着予定をもらっていない指図
       const horizon = now.getTime() + cfg.lookaheadDays * 86400000;
       const arrivedIds = new Set((arrivalTimes || []).filter(a => a && a.time).map(a => a.id));
       const askedIds = new Set((contactRequests || [])
         .filter(r => r && r.kind === 'arrival' && r.status !== 'canceled' && (r.items || []).some(i => !i.time))
         .flatMap(r => (r.items || []).map(i => i.lotId)));
       const targets = (lots || []).filter(l => {
         if (!l || l.status === 'completed' || l.location === 'completed') return false;
         if (arrivedIds.has(l.id) || askedIds.has(l.id)) return false;   // もう聞いた/もう来た
         if (l.entryAt && l.entryAt <= horizon) return true;             // 入荷予定が近い
         return !l.entryAt;                                             // 入荷未定も聞く
       });
       if (!targets.length) return;
       // 班ごとに1件。宛先は型式で覚えている班(完了連絡と同じ記憶)を使い、無ければ最初の班。
       const byGroup = {};
       targets.forEach(l => {
         const g = contactCompleteGroupFor(contactSettings, l.model) || groups[0];
         (byGroup[g] = byGroup[g] || []).push(l);
       });
       // 🚨 2026-09-02(NC3): 1tick で書く数に **上限** を付けた。
       //   前は班の数ぶん書けて、その数がコードから読めなかった。
       //   ⚠**まだ今日送っていない班だけ**に絞ってから切る。先に切ると、
       //     すでに送った班が枠を埋めて、後ろの班へ永久に送られない。
       //   6件の根拠: 実測(2026-08-30の控え)で班は5つ（組立 高木班/前班/南班・工長・職長）。
       Object.entries(byGroup)
         .filter(([g]) => !(contactRequests || []).some(r => r && r.id === `arr-auto-${dateKey}-${g}`))
         .slice(0, 6)
         .forEach(([g, list]) => {
         const id = `arr-auto-${dateKey}-${g}`;            // ← 決め打ちID(全端末で同じ = 二重にならない)
         if ((contactRequests || []).some(r => r && r.id === id)) return; // 今日のぶんは送信済み(念のため残す)
         saveData('contact_requests', id, {
           kind: 'arrival', to: g, from: '検査(自動)', auto: true,
           message: `到着予定（いつ来るか）を教えてください ※${cfg.time}の定期連絡`,
           items: list.slice(0, 40).map(l => ({ lotId: l.id, orderNo: l.orderNo || '', model: l.model || '' })),
           createdAt: Date.now(), status: 'waiting',
         });
         notifyContactPush({
           toGroup: g, toSide: 'portal', toLevel: 'auto',
           title: `🚚 到着予定を教えてください（${list.length}件）`,
           body: `${cfg.time}の定期連絡です。ポータルで時間を入れてください`,
           link: `${window.location.origin}/?renraku=1`, tag: `arr-auto-${dateKey}-${g}`,
         });
       });
     };
     tick();
     const t = setInterval(tick, 60000);
     return () => clearInterval(t);
   }, [contactFeatureOn, settings, settingsLoaded, arrivalsLoaded, lotsLoaded, lots, arrivalTimes, contactRequests]); // eslint-disable-line react-hooks/exhaustive-deps
  const overlays = (<>
       {/* プッシュ通知のフォアグラウンド表示(画面を開いている時。閉じている時はブラウザ通知) */}
       <ForegroundPushToast ready={!!db} settings={settings} />
       {/* 連絡アラーム: 緊急連絡は確認を押すまで鳴り続ける(設定で細かく調整・既定OFF) */}
       {contactFeatureOn && <ContactAlarm ready={!!db} settings={settings} extraEvents={contactAlarmEvents} />}
       {/* 返信の画面内通知: どのタブに居ても左下に出る。到着回答は1タップで検査リストへ反映 */}
       {contactFeatureOn && activeTab !== 'contact' && (
         <ContactReplyTicker events={contactUnseen} onSeen={markContactSeen} settings={settings}
           onOpenTab={() => { setActiveTab('contact'); markContactSeen(); }}
           onApply={(ev) => setArrivalApply({ reqId: ev.reqId, itemIdx: ev.itemIdx })} />
       )}
       {/* 到着予定→検査リスト反映＋終了予定の返信 モーダル
           (ティッカー / 連絡タブ詳細 / 到着予定ボード のどこからでも同じ画面が開く) */}
       {arrivalApply && contactFeatureOn && (() => {
         // arrivalApply は {key} か、古い呼び出しの {reqId,itemIdx}。どちらも entry へ寄せる。
         const key = arrivalApply.key || `req:${arrivalApply.reqId}:${arrivalApply.itemIdx}`;
         const entry = mergeArrivalEntries({ arrivalTimes, contactRequests }).find(e => e.key === key);
         if (!entry || entry.ts == null) return null;
         return <ContactArrivalApplyModal entry={entry} contactRequests={contactRequests} lots={lots} templates={templates} settings={settings} saveData={saveData} notifyPush={notifyContactPush} currentUserName={currentUserName} estimateSecOf={contactEstimateSecOf} onClose={() => setArrivalApply(null)} />;
       })()}
       {/* 検査完了→次工程(組立)へ完了連絡 の確認プロンプト(自動送信ではなくワンタップ確認) */}
       {completePrompt && contactFeatureOn && (() => {
         const cgroups = contactGroupsOf(contactSettings);
         const remembered = contactCompleteOf(contactSettings).modelGroups[String(completePrompt.lot.model || '').trim()];
         const sel = completePrompt.group || '';
         const sideLabel = contactSideLabel(contactSettings);
         return (
         <div className="fixed inset-0 z-[96] bg-black/50 flex items-center justify-center p-4" onClick={() => {
           // 🚨送信中は外側タップでも閉じない(閉じた後に拒否されると、断りの行き先が無くなる)。
           if (!completeSendingRef.current) setCompletePrompt(null);
         }}>
           <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[92vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
             <div className="shrink-0 px-4 py-3 bg-emerald-600 text-white flex items-center gap-2"><CheckCircle2 className="w-5 h-5" /><span className="font-black">検査完了！</span></div>
             <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-2.5 text-sm">
               <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap">
                 <span className="font-mono font-black text-slate-700">{completePrompt.lot.orderNo}</span>
                 <span className="font-bold text-slate-600">{completePrompt.lot.model}</span>
                 {completePrompt.lot.quantity ? <span className="text-xs text-slate-400">{completePrompt.lot.quantity}台</span> : null}
               </div>
               {/* 📦分納: 4台のうち今日2台ぶんだけ知らせる。⚠残りを超える台数は送れない。 */}
               {(() => {
                 const curLot = (lots || []).find(l => l && l.id === completePrompt.lot.id) || completePrompt.lot;
                 const total = lotQtyOf(curLot);
                 const rest = remainingQtyOf(curLot);
                 const doneParts = completePartsOf(curLot);
                 const n = completePrompt.qty == null ? rest : completePrompt.qty;
                 if (total <= 1) return null;   // 1台の指図に分納の入口は出さない(邪魔なだけ)
                 return (
                   <div className="border border-slate-200 rounded-lg p-2.5 flex flex-col gap-2">
                     <div className="text-xs font-black text-slate-500">今回 何台ぶんを知らせますか？</div>
                     {doneParts.length > 0 && (
                       <div className="fi-tap-text text-slate-500 bg-slate-50 rounded px-2 py-1">
                         これまで {doneParts.map(p => `${p.qty}台(${fmtContactTime(p.at)})`).join('・')} を連絡済み ／ <b>残り {rest}台</b>
                       </div>
                     )}
                     <div className="flex items-center gap-1.5 flex-wrap">
                       <button onClick={() => setCompletePrompt(p => ({ ...p, qty: rest }))}
                         className={`px-3 py-2 rounded-lg text-sm font-black border-2 ${n === rest ? 'bg-emerald-600 border-emerald-700 text-white' : 'bg-white border-slate-300 text-slate-600'}`}>
                         残り全部（{rest}台）
                       </button>
                       {Array.from({ length: Math.min(rest - 1, 6) }, (_, i) => i + 1).map(k => (
                         <button key={k} onClick={() => setCompletePrompt(p => ({ ...p, qty: k }))}
                           className={`px-3 py-2 rounded-lg text-sm font-black border-2 ${n === k ? 'bg-emerald-600 border-emerald-700 text-white' : 'bg-white border-slate-300 text-slate-600'}`}>
                           {k}台
                         </button>
                       ))}
                       {rest > 7 && (
                         <input type="number" min={1} max={rest} value={n}
                           onChange={e => setCompletePrompt(p => ({ ...p, qty: Math.max(1, Math.min(rest, Number(e.target.value) || 1)) }))}
                           className="w-16 border-2 border-slate-300 rounded-lg px-2 py-1.5 text-sm text-center font-black" />
                       )}
                     </div>
                     {n < rest && <div className="fi-tap-text text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                       残り {rest - n}台 は、また終わった時に同じ画面から知らせます（連絡タブの「📦 検査完了の連絡が途中の指図」から出せます）。
                     </div>}
                   </div>
                 );
               })()}
               {/* 宛先=製品(型式)によって職長が違うので、その場で選ぶ。前にこの型式で送った班が最初から選ばれている。 */}
               <div>
                 <div className="text-xs font-black text-slate-500 mb-1">どこに連絡しますか？（{sideLabel}の班 — 選んだ班の職長の携帯が鳴ります）</div>
                 <div className="flex items-center gap-1.5 flex-wrap">
                   {cgroups.map(g => (
                     <button key={g} onClick={() => setCompletePrompt(p => ({ ...p, group: g }))}
                       className={`px-3 py-2 rounded-lg text-sm font-black border-2 ${sel === g ? 'bg-emerald-600 border-emerald-700 text-white' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                       {g}{remembered === g && sel !== g ? ' ★' : ''}
                     </button>
                   ))}
                   {cgroups.length === 0 && <span className="text-xs text-rose-600 font-bold">宛先グループが未設定です（連絡タブ→宛先・公開設定で追加）</span>}
                 </div>
                 {remembered
                   ? <div className="fi-tap-text text-slate-400 mt-1">★ = 前に「{completePrompt.lot.model}」を連絡した班。ここで変えると、次からこの型式はその班が最初に選ばれます。</div>
                   : <div className="fi-tap-text text-slate-400 mt-1">選んだ班は「{completePrompt.lot.model}」の連絡先として覚えます（次から自動で選ばれます）。</div>}
               </div>
               <div className="fi-tap-text text-slate-400">
                 {contactCompleteOf(contactSettings).ack
                   ? '相手が「確認しました」を押すと、こちらに返信が届きます（催促はしません）。'
                   : 'お知らせを流すだけです（相手の確認返信は求めません）。'}
                 設定は連絡タブ→宛先・公開設定。
               </div>
               {/* この確認は開いている検査端末すべてに同時に出る。どちらを押しても他の端末の分は閉じる、と明示する。 */}
               <div className="fi-tap-text text-slate-500 bg-slate-50 border border-slate-200 rounded px-2 py-1.5">
                 この確認は、いま開いている検査の画面すべてに出ています。<b>どちらを押しても他の人の画面からは消えます</b>ので、二重に送られることはありません。
               </div>
             </div>
             <div className="shrink-0 px-4 py-3 border-t border-slate-200 flex gap-2 justify-end">
               <button disabled={completeBusy} onClick={() => setCompletePrompt(null)} className="px-3 py-2 rounded-lg text-sm font-bold text-sky-700 hover:bg-sky-50 disabled:opacity-40">あとで</button>
               <button disabled={completeBusy} data-complete="decline" onClick={async () => {
                 // 🚨「連絡しない」の印の保存を見届けてから閉じる。拒否されたら閉じない(2026-08-31)。
                 // 🚨2度押しガード(2026-08-31 夜)。送信側と同じ入れ物を使うので、送信中は断りも押せない。
                 if (completeSendingRef.current) return;
                 completeSendingRef.current = true; setCompleteBusy(true);
                 try {
                   const r = await settleSaveBriefly(declineComplete(completePrompt.lot));
                   if (!mayCloseAfterSave(r)) { alert(SAVE_REFUSED_MESSAGE); return; }
                   setCompletePrompt(null);
                 } finally { completeSendingRef.current = false; setCompleteBusy(false); }
               }} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-40">{completeBusy ? '…送信中' : '連絡しない'}</button>
               <button disabled={!sel || completeBusy} data-complete="send" onClick={async () => {
                 // 🚨送信の保存(依頼+印)を見届けてから閉じる。拒否されたら閉じない(2026-08-31)。
                 const ok = await sendComplete(completePrompt.lot, sel, completePrompt.qty);
                 if (ok) setCompletePrompt(null);
               }} className="px-4 py-2 rounded-lg text-sm font-black text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-1.5"><Send className="w-4 h-4" /> {completeBusy ? '…送信中' : `${sel || sideLabel}に連絡する`}</button>
             </div>
           </div>
         </div>
         );
       })()}
  </>);
  // 🔧 P131 NG の瞬間に「修正のお願い」の下書きを開くか。既定: OFF(誰へ出すかが決まるまで)。
  const repairContactOnNg = contactFeatureOn && settings?.contactFeature?.repairOnNg === true;
  const reworkContactSkip = settings?.reworkContactSkip || null;
  return {
    repairContactOnNg, reworkContactSkip,
    contactFeatureOn, contactSettings, contactRequests, arrivalTimes, pushTokens, arrivalByLot, saveContactShared,
    notifyContactPush, contactUnseen, markContactSeen, setArrivalApply, setCompletePrompt, contactEstimateSecOf,
    checkArrival, undoArrivalCheck, remindArrival, undoDeclineComplete, overlays,
  };
};

/**
 * 作業画面の「📨 連絡・呼出」(P058)。製品の WorkContactPanel + sharedContactSendModal を1つにした物。
 * ⚠ 既定: 部品の作業画面の並びは変えず、右下に浮かせて置く(畳める)。
 * ⚠ draft / setDraft は作業画面側が持つ(不具合報告の「📨 報告して連絡」からも開くため・P027)。
 */
export const WorkContactBlock = ({
  lot, draft, setDraft, contactEnabled = false, contactRequests = [], contactGroups = [], contactMembers = {},
  chipOptions = [], from = '', saveData = null, notifyPush = null, itemMaster = null,
}) => {
  const [open, setOpen] = useState(true);
  const [sentMsg, setSentMsg] = useState('');
  if (!lot || !saveData || !contactEnabled) return null;
  // 品名は名簿からも補う(品目コードは鍵のまま)
  const lotShown = { ...lot, modelText: resolveItemName(lot.model, lot.modelText, itemMaster) || lot.modelText || '' };
  return (<>
    <div className="fixed right-2 bottom-2 z-[55] max-w-[min(26rem,calc(100vw-1rem))] bg-white/95 rounded-xl shadow-2xl border border-slate-200 py-1">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full text-left px-3 fi-tap-text font-bold text-slate-400">{open ? '▾ 連絡(たたむ)' : '▸ 連絡・呼出'}</button>
      {open && <WorkContactPanel lot={lotShown} contactRequests={contactRequests} onOpenSend={(d) => setDraft(d || { kind: 'call', message: '' })} />}
      {sentMsg && <div className="px-3 pt-1 fi-tap-text text-emerald-700 font-bold">{sentMsg}</div>}
    </div>
    {draft && (
      <ContactSendModal
        draft={draft} groups={contactGroups.length ? contactGroups : DEFAULT_CONTACT_GROUPS_FALLBACK} members={contactMembers} chipOptions={chipOptions || []} from={from} lot={lotShown}
        onClose={() => setDraft(null)}
        onSend={(payload) => {
          const reqId = newContactId();
          saveData('contact_requests', reqId, payload);
          // 宛先グループの携帯へプッシュ通知(設定済みなら)
          if (notifyPush) { const m = contactPushMessage(payload); notifyPush({ toGroup: payload.to, toSide: 'portal', toLevel: payload.toLevel || 'auto', title: m.title, body: m.body, link: `${window.location.origin}/?renraku=1`, tag: `req-${reqId}` }); }
          setDraft(null); setSentMsg('📨 連絡を送信しました。返信はこの画面に表示されます');
        }}
      />
    )}
  </>);
};

// 作業画面へ渡す連絡の束(App から1つの props で渡す)
export const contactPropsOf = (hub) => (hub && hub.contactFeatureOn ? {
  contactEnabled: true,
  contactRequests: hub.contactRequests,
  contactGroups: contactGroupsOf(hub.contactSettings),
  contactMembers: contactMembersOf(hub.contactSettings),
  notifyPush: hub.notifyContactPush,
  repairContactOnNg: !!hub.repairContactOnNg,
  reworkContactSkip: hub.reworkContactSkip || null,
} : { contactEnabled: false });

// 連絡タブの赤い数字(未読)/橙の丸(返事待ち)。製品 topTabBadge と同じ決め方。
export const ContactTabBadge = ({ hub }) => {
  if (!hub || !hub.contactFeatureOn) return null;
  const u = hub.contactUnseen.length;
  const n = (hub.contactRequests || []).filter(r => r && r.status === 'waiting').length;
  if (u) return <span className="absolute -top-1 -right-1 bg-rose-600 animate-pulse text-white fi-tap-text rounded-full min-w-4 h-4 px-1 flex items-center justify-center font-black" title="新しい連絡（連絡タブを開くと消えます）">{u}</span>;
  return n ? <span className="absolute -top-1 -right-1 bg-amber-500 rounded-full w-2.5 h-2.5" title={`返事待ちが ${n}件（連絡タブで確認できます）`} /> : null;
};

// 連絡タブの中身(製品 App.jsx 50572 の ContactView の呼び方を写した)
export const ContactTab = ({ hub, lots, saveSettings, saveData, deleteData, currentUserName, templates, onRegisterLot = null }) => {
  if (!hub || !hub.contactFeatureOn) return null;
  return (
    <ContactView contactRequests={hub.contactRequests} arrivalTimes={hub.arrivalTimes} lots={lots} settings={hub.contactSettings} saveSettings={saveSettings} saveShared={hub.saveContactShared} saveData={saveData} deleteData={deleteData} currentUserName={currentUserName} pushTokens={hub.pushTokens} notifyPush={hub.notifyContactPush} onApplyArrival={(reqId, itemIdx) => hub.setArrivalApply({ reqId, itemIdx })} onOpenArrivalEntry={(key) => hub.setArrivalApply({ key })} templates={templates}
      arrivalActuals={[]} onCheckArrival={hub.checkArrival} onUndoArrival={hub.undoArrivalCheck} onRemindArrival={hub.remindArrival}
      onOpenComplete={(lot) => hub.setCompletePrompt({ lot, group: contactCompleteGroupFor(hub.contactSettings, lot.model), qty: null })}
      onUndoDecline={hub.undoDeclineComplete} onRegisterLot={onRegisterLot} />
  );
};
