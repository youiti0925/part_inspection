// 工程連絡ポータル / 連絡タブの「見せ方」を決める純関数群。
// 製品検査アプリ・最終検査アプリで同一ファイル(片方だけ直すと必ずズレるのでコピーで揃える)。
//
// ここに置く理由: 表示期間の切り方・到着予定の返信状況・作業状況の予想終了時刻は
// 「合っているか」を目で見て確かめるのが難しい。UIから切り離して test で固定する。
//
// ⚠ Firestore は「配列の中の配列」を保存できない。ここが返す構造をそのまま保存しないこと
//   (この module の戻り値は画面表示専用。保存する形は呼び出し側で組み立てる)。

// ==================== 表示期間 ====================
// 検査完了のお知らせ・やりとり履歴は放っておくと永久に溜まる。既定は「2日分」。
// ⚠ 暦日で切る。now-48時間 で切ると、朝に見た時に一昨日の夜の分が残って「2日分」に見えない。
export const RANGE_OPTIONS = [
    { id: '2d', label: '2日分', days: 2 },
    { id: '3d', label: '3日分', days: 3 },
    { id: '1w', label: '1週間', days: 7 },
    { id: '2w', label: '2週間', days: 14 },
    { id: '1m', label: '1か月', days: 31 },
    { id: 'all', label: 'すべて', days: null },
];
export const DEFAULT_RANGE_ID = '2d';

export const rangeOptionOf = (id) => RANGE_OPTIONS.find(o => o.id === id) || RANGE_OPTIONS.find(o => o.id === DEFAULT_RANGE_ID);

// その期間の「先頭の瞬間」。days=2 なら 昨日の 00:00 (=昨日と今日)。all は null(=無制限)。
export const rangeStartMs = (id, now = Date.now()) => {
    const opt = rangeOptionOf(id);
    if (!opt || opt.days == null) return null;
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (opt.days - 1));
    return d.getTime();
};

export const withinRange = (ms, id, now = Date.now()) => {
    const start = rangeStartMs(id, now);
    if (start == null) return true;           // すべて
    if (!Number.isFinite(ms) || !ms) return false; // 時刻が無いものは期間で切れない = 出さない
    return ms >= start;
};

// 期間で絞った結果と「隠した件数」を必ずセットで返す。黙って切ると「消えた」と言われる。
export const filterByRange = (items, id, now = Date.now(), atOf = (x) => x?.at) => {
    const all = Array.isArray(items) ? items : [];
    const shown = all.filter(x => withinRange(atOf(x), id, now));
    return { shown, hidden: all.length - shown.length, total: all.length };
};

// ==================== 簡易選択 (日付・時刻) ====================
// 日付/時刻の入力欄は指が太いと押しづらい。「本日(7/29)」「10時」のボタンで1タップにする。
// ⚠既存の日付/時刻入力は残す(簡易選択で足りない時刻が必ずある)。
export const DEFAULT_QUICK_TIMES = ['10:00', '12:00', '15:00', '17:00'];

export const quickTimesOf = (settings) => {
    const raw = settings?.contactArrival?.quickTimes;
    const list = Array.isArray(raw) ? raw.map(x => String(x || '').trim()).filter(x => /^\d{1,2}:\d{2}$/.test(x)) : [];
    return list.length ? list.slice(0, 8) : DEFAULT_QUICK_TIMES;
};

export const toDateStr = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const toTimeStr = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const WDAY = ['日', '月', '火', '水', '木', '金', '土'];

// 本日(7/29 火) / 明日(7/30 水) / あさって。曜日まで出す = 「明日って何日だっけ」を無くす。
export const quickDateOptions = (now = Date.now(), count = 3) => {
    const base = new Date(now); base.setHours(0, 0, 0, 0);
    const names = ['本日', '明日', 'あさって'];
    const out = [];
    for (let i = 0; i < Math.max(1, count); i++) {
        const d = new Date(base); d.setDate(d.getDate() + i);
        out.push({
            key: `d${i}`,
            value: toDateStr(d.getTime()),
            label: `${names[i] || `${i}日後`}(${d.getMonth() + 1}/${d.getDate()} ${WDAY[d.getDay()]})`,
            short: names[i] || `${i}日後`,
        });
    }
    return out;
};

// "10:00" → "10時" / "10:30" → "10:30"。ボタンの文字は短いほど押しやすい。
export const quickTimeLabel = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    if (!m) return String(t || '');
    return m[2] === '00' ? `${Number(m[1])}時` : `${Number(m[1])}:${m[2]}`;
};

// 日付(YYYY-MM-DD) + 時刻(HH:MM) → ミリ秒。どちらか欠けたら null。
export const dateTimeMs = (date, time) => {
    if (!date || !time) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    const t = /^(\d{1,2}):(\d{2})$/.exec(String(time));
    if (!m || !t) return null;
    const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]), 0, 0).getTime();
    return Number.isFinite(ms) ? ms : null;
};

// ==================== 到着予定ボード ====================
// 到着予定は2つの入口から来る:
//   ① 組立が頼まれる前に自分で登録  → arrival_times/{lotId} だけ (contact_requests には無い)
//   ② 検査が「いつ来るか」を聞いた回答 → contact_requests(kind='arrival').items[] と arrival_times の両方
// 「いつ終わる」の返事は ①は arrival_times.finish / ②は items[].finish に入る。
// 画面では1つの表で見たいので、ここで束ねて重複を消す。
//
// ⚠ ②を二重に出さないため、arrival_times 側の viaReq(=依頼ID)が実在する依頼を指していたら捨てる。
//   古いデータには viaReq が無いので、実データで突合する(lotId + 依頼側 items の lotId)。
//
// ⚠「元の依頼が消されている到着予定」= 孤児。viaReq が今は存在しない依頼を指している状態。
//   依頼を消しても arrival_times のほうは残るので起きる。片方の画面だけがこれを拾うと
//   「板には出るのに履歴の表には無い」になる(実際に起きた: 1001398676 TWA-160)。
//   → orphan: true を付けて**両方の画面で同じように**扱い、その場で消せるようにする。
// ============================================================================
// 🚚 到着予定の回答を「後勝ちで消えない」形で読む
// ----------------------------------------------------------------------------
// ⚠⚠ 2026-08-14 の点検で判明した事故の形:
//   定時おうかがいは 1件の依頼に最大40ロットを items[] の配列で持つ。組立の何人かが
//   別々の端末で同じ通知を開いて、ほぼ同時に時間を入れると、**後から押した端末が
//   40行ぶんの配列を丸ごと作り直して書き戻す**ので、直前に別の人が入れた回答が消える
//   (setDoc merge:true でも配列は丸ごと差し替わる)。
//   消えた側は「未返信」のまま残るので、**答えた本人の班に催促が飛ぶ**。
//
// → 回答は **鍵つきの入れ物 itemAnswers** に1行ずつ書く。鍵が違えばぶつからない。
//   読む側はここで「古い items[] の上に itemAnswers を重ねる」1回だけを行う。
//
// ⚠⚠ **items[] への書き込みはやめない。**
//   ③司令塔(factory-overview-app/src/AssemblyPortal.jsx)が同じ書類を直接読み、
//   `(r.items||[]).some(i => !i.time)` で班ごとの待ち件数を数えている。③には
//   このファイルが無いので、items[] を更新しなくすると **③の待ち件数が永久に減らない**。
//   だから「items[] は今までどおり書く / 正しい値は itemAnswers を正とする」。
//
// ⚠⚠ 取り消し(回答のやり直し)は **鍵を消さない**。消すと重ねが古い items[] に落ちて
//   **移行前の古い回答が復活する**(merge は消したキーを消さない。2026-07-26 の既知の罠)。
//   `{ cleared: true }` を明示的に書く。
// ============================================================================

/**
 * 依頼の1行の鍵。
 * ⚠並び順(index)だけを鍵にすると、将来「行を消せるようにする」と黙って別の行に化ける。
 *   ロットIDがあればそれを使い、無い時だけ並び順に落とす。
 */
export const itemAnswerKey = (it, idx) => {
  const lot = String((it && it.lotId) || '').replace(/[.[\]#$/\s]/g, '_');
  return lot ? `L${lot}` : `i${idx}`;
};

/** 依頼に書き足す回答1件ぶん。⚠画面側はこれを使って書く(自分で形を作らない)。 */
export const answerPatch = (it, idx, answer) => ({ itemAnswers: { [itemAnswerKey(it, idx)]: answer } });

/**
 * 古い items[] の上に itemAnswers を重ねた「いまの中身」。
 * ⚠回答を読む所は **必ずこれを通す**。素の r.items を読むと後勝ちで消えた値が見える。
 */
export const effectiveItems = (r) => {
  const ans = (r && r.itemAnswers && typeof r.itemAnswers === 'object' && !Array.isArray(r.itemAnswers)) ? r.itemAnswers : null;
  const items = Array.isArray(r && r.items) ? r.items : [];
  if (!ans) return items;
  return items.map((it, idx) => {
    const a = ans[itemAnswerKey(it, idx)];
    if (!a || typeof a !== 'object') return it;
    // 取り消し: 回答が無かったことにする(古い items[] の値を見せない)
    if (a.cleared) return { ...it, date: '', time: '', by: '', at: 0, applied: null, finish: null };
    return { ...it, ...a };
  });
};

/**
 * 到着予定の回答を保存する時の中身を作る。**書く所は全部これを通す。**
 *
 * ⚠⚠ items[] と itemAnswers の **両方** を返す。
 *   ・itemAnswers … 正しい値(鍵つきなのでぶつからない)
 *   ・items[]     … ③司令塔が直接読んでいるので今までどおり書く(消すと待ち件数が減らない)
 * ⚠answered は **重ねた後** の中身で数える。items[] だけで数えると、他の端末の回答が
 *   後勝ちで消えている時に「まだ未回答」と誤判定する。
 *
 * @param itemsPatch   items[idx] に重ねる値(取り消しなら空文字を入れる)
 * @param answerFields itemAnswers に書く値(取り消しなら { cleared: true })
 * @returns { items, itemAnswers, answered }
 */
export const arrivalAnswerSave = (req, idx, itemsPatch, answerFields) => {
  const src = Array.isArray(req && req.items) ? req.items : [];
  const items = src.map((x, i) => (i === idx ? { ...x, ...itemsPatch } : x));
  // 🚨🚨 cleared は **いつも書く**(取り消しなら true・答え直しなら false)。
  //   書かないと、保存が merge(setDoc merge:true)なので **前の取り消しの cleared: true が
  //   マップの中に残り続け**、答え直しても effectiveItems が毎回その回答を空に戻す。
  //   = 入れ直した到着予定が どの板にも出ない(やり直しが1回きりで詰む)。
  //   merge は「書かなかった鍵」を消さないので、false を **上書きで** 書くしかない。
  //   (2026-07-26 の罠と同じ根。2026-09-09 に確かめ役2人が別々に見つけた)
  const answer = { ...(answerFields || {}), cleared: !!(answerFields && answerFields.cleared) };
  const itemAnswers = { [itemAnswerKey(src[idx] || {}, idx)]: answer };
  const merged = { ...(req || {}), items, itemAnswers: { ...((req && req.itemAnswers) || {}), ...itemAnswers } };
  const eff = effectiveItems(merged);
  return { items, itemAnswers, answered: eff.length > 0 && eff.every((i) => i && i.time) };
};

export const mergeArrivalEntries = ({ arrivalTimes = [], contactRequests = [], group = null, now = Date.now() } = {}) => {
    const reqs = (contactRequests || []).filter(r => r && r.kind === 'arrival' && r.status !== 'canceled' && (!group || r.to === group));
    // 依頼IDの存在確認は「取消・班しぼり込みで外れた分」も含めた全依頼で見る。
    // reqs(絞り込み後)で見ると、班を切り替えただけで孤児が増えたり減ったりする。
    const allReqIds = new Set((contactRequests || []).map(r => r?.id).filter(Boolean));
    // 分納の内訳(splits)は arrival_times 側にしか無い。依頼への回答は arrival_times の写しを
    // 捨てるので、ここで拾っておかないと **分納が板から消える**。
    const byLot = {};
    (arrivalTimes || []).forEach(a => { if (a && a.id) byLot[a.id] = a; });
    const out = [];
    const fromReqLotIds = new Set();
    const reqIds = new Set();
    reqs.forEach(r => {
        reqIds.add(r.id);
        effectiveItems(r).forEach((it, idx) => {
            if (!it || !it.time) return; // まだ回答が来ていない = 到着予定ではない
            if (it.lotId) fromReqLotIds.add(it.lotId);
            const ts = dateTimeMs(it.date, it.time);
            const src = it.lotId ? byLot[it.lotId] : null;
            out.push({
                key: `req:${r.id}:${idx}`,
                source: 'req', reqId: r.id, itemIdx: idx,
                lotId: it.lotId || '', orderNo: it.orderNo || '', model: it.model || '',
                quantity: it.quantity || 0, dueDate: it.dueDate || '',
                date: it.date || '', time: it.time || '', ts,
                splits: (src && Array.isArray(src.splits)) ? src.splits : [],
                by: it.by || '', group: r.to || '',
                at: it.at || r.createdAt || 0,
                finish: (it.finish && it.finish.ts) ? { ts: it.finish.ts, by: it.finish.by || '', at: it.finish.at || 0 } : null,
                // 入荷時間(entryAt)を検査リストへ入れたか。= 「もう処理した」の印。
                //   ⚠依頼への回答は items[].applied に入るが、自動反映(by:'auto')は arrival_times 側へ書く。
                //     どちらか有る方を拾わないと「入れてあるのに未対応と出る」(清水さん 2026-08-05)。
                applied: (it.applied && (it.applied.at || it.applied.entryAt)) ? it.applied
                    : ((src && src.applied && (src.applied.at || src.applied.entryAt)) ? src.applied : null),
                // 📋 組立が選んだテンプレート(検査手順)の名前。回答した時に書き込まれる。
                //   ⚠昔の記録には入っていない。空のままにして、こちらで作らない。
                templateName: String(it.templateName || (src && src.templateName) || ''),
            });
        });
    });
    (arrivalTimes || []).forEach(a => {
        if (!a || !a.id || !a.time) return;
        if (group && a.group && a.group !== group) return;
        // ②の写しは捨てる。⚠捨ててよいのは「その依頼が **この画面に出ている**」時だけ(reqIds)。
        //   全依頼(allReqIds)で捨てると、依頼の宛先班と到着予定の班が食い違っている行が
        //   **どこにも出ずに消える**(写しとしても孤児としても出ない)。2026-08-01 の点検で発見。
        if (a.viaReq && reqIds.has(a.viaReq)) return;
        if (fromReqLotIds.has(a.id)) return;
        const ts = dateTimeMs(a.date, a.time);
        out.push({
            key: `self:${a.id}`,
            source: 'self', reqId: '', itemIdx: -1,
            // 依頼への回答だったのに、その依頼が **どこにも無い** = 孤児。やりとりの履歴をたどれない。
            //   ⚠孤児かどうかは全依頼(allReqIds)で見る。班の切り替えで孤児が増えたり減ったりしないように。
            orphan: !!a.viaReq && !allReqIds.has(a.viaReq),
            lotId: a.id, orderNo: a.orderNo || '', model: a.model || '',
            quantity: a.quantity || 0, dueDate: a.dueDate || '',
            date: a.date || '', time: a.time || '', ts,
            splits: Array.isArray(a.splits) ? a.splits : [],
            by: a.by || '', group: a.group || '',
            at: a.at || 0,
            finish: (a.finish && a.finish.ts) ? { ts: a.finish.ts, by: a.finish.by || '', at: a.finish.at || 0 } : null,
            // 入荷時間を検査リストへ入れた印(人が反映モーダルで入れた分と、自動反映 by:'auto' の両方)
            applied: (a.applied && (a.applied.at || a.applied.entryAt)) ? a.applied : null,
            // 📋 組立が選んだテンプレート(検査手順)の名前。昔の記録には入っていないので空のまま。
            templateName: String(a.templateName || ''),
        });
    });
    return out
        // handled = 「もう処理した」。終了予定を返信した **または** 入荷時間を検査リストへ入れた。
        //   ⚠返信(replied)だけを処理済みと見なしていたので、入荷時間を入れて片付けたものが
        //     いつまでも「未返信」と出て急かしていた(清水さん 2026-08-05)。
        .map(e => ({ orphan: false, splits: [], applied: null, templateName: '', ...e, replied: !!e.finish, handled: !!e.finish || !!e.applied, late: e.ts != null && e.ts < now && !e.finish }))
        .sort((a, b) => (b.at || 0) - (a.at || 0));
};

// 「返事したか」の数。画面の見出しに出して、返し忘れを一目で分かるようにする。
//   ⚠数え方は3つに分ける。混ぜると「処理したのに急かされる」になる。
//     replied     = 終了予定を返信した
//     appliedOnly = 返信はしていないが、入荷時間は検査リストへ入れた
//     untouched   = どちらもしていない(=本当にまだ何もしていない件数。急かすのはこれだけ)
export const arrivalReplyStats = (entries = []) => {
    const total = entries.length;
    const replied = entries.filter(e => e && e.replied).length;
    const handled = entries.filter(e => e && (e.replied || e.applied)).length;
    return { total, replied, waiting: total - replied, handled, appliedOnly: handled - replied, untouched: total - handled };
};

// 終了予定の返信機能が有効か。既定ON。設定 contactArrival.finishReply === false で止まる。
export const finishReplyEnabled = (settings) => settings?.contactArrival?.finishReply !== false;

// ==================== テンプレートの言葉でしぼる ====================
// 製品検査はテンプレートが何十種類もあり、名前に「中間分割」「回転分割」「傾斜分割」「一般精度」
// のような言葉が入っている。ポータルで型式の頭文字だけでは目的の製品に辿り着けないので、
// テンプレ名に含まれる言葉のボタンでしぼれるようにする。
// ⚠ 最終検査アプリにはテンプレートの概念が無いので、そちらでは使わない。
export const DEFAULT_TEMPLATE_WORDS = ['中間', '一般', '傾斜', '回転'];
export const templateWordsOf = (settings) => {
    const raw = settings?.contactPortal?.templateWords;
    const list = Array.isArray(raw) ? raw.map(x => String(x || '').trim()).filter(Boolean) : [];
    return list.length ? list.slice(0, 8) : DEFAULT_TEMPLATE_WORDS;
};
// テンプレ名がその言葉を含むか。テンプレ名が無いものは、どの言葉にも当たらない。
export const templateWordMatches = (tplName, word) => {
    const n = String(tplName || '');
    const w = String(word || '').trim();
    return !!(n && w && n.includes(w));
};

// ==================== 到着予定の「いつ」 ====================
// 検査リスト・現場マップで「今日来る」「明日来る」「予定を過ぎた」を色分けするための判定。
//   ⚠暦日で見る。now+24h で「明日」を出すと、夕方に見た時に明後日の朝が「明日」になる。
export const ARRIVAL_WHEN = { PAST: 'past', TODAY: 'today', TOMORROW: 'tomorrow', LATER: 'later', NONE: 'none' };
export const arrivalWhenOf = (arrival, now = Date.now()) => {
    const ts = arrival && arrival.time ? dateTimeMs(arrival.date, arrival.time) : null;
    if (ts == null) return { when: ARRIVAL_WHEN.NONE, ts: null, label: '' };
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    const day0 = d0.getTime();
    const day1 = day0 + 86400000;
    const day2 = day0 + 2 * 86400000;
    const hhmm = String(arrival.time);
    if (ts < now) return { when: ARRIVAL_WHEN.PAST, ts, label: `${ts >= day0 ? '本日' : `${new Date(ts).getMonth() + 1}/${new Date(ts).getDate()}`} ${hhmm} 予定` };
    if (ts < day1) return { when: ARRIVAL_WHEN.TODAY, ts, label: `本日 ${hhmm}` };
    if (ts < day2) return { when: ARRIVAL_WHEN.TOMORROW, ts, label: `明日 ${hhmm}` };
    const d = new Date(ts);
    return { when: ARRIVAL_WHEN.LATER, ts, label: `${d.getMonth() + 1}/${d.getDate()} ${hhmm}` };
};
// 検査リストのしぼり込み用。空配列=しぼらない。
//   ⚠分納は「次に来る便」で判定する。呼び出し側で arrivalForWhen() を通してから渡すこと
//     (ここで splits を読むと arrivalSplits.js と judgement が2箇所に散る)。
export const arrivalFilterMatches = (arrival, picked = [], now = Date.now()) => {
    if (!picked || !picked.length) return true;
    const has = !!(arrival && arrival.time);
    if (picked.includes('none') && !has) return true;
    if (!has) return false;
    const { when } = arrivalWhenOf(arrival, now);
    if (picked.includes('has')) return true;
    return picked.includes(when);
};

// ==================== 作業状況ボード ====================
// 「いま誰が何をしているか」を相手工程に見せる。更新ボタンを押した時だけ作り直す(勝手に動かない)。
//
// 🚨⚠⚠ **終わりの時刻を、ここでは1秒も計算しない**(2026-08-16)。
//   前はここで estEndTs = finishAt(now, 見積−経過) を自分で出していた。画面に大きく出ている 🏁 は
//   finishEta.js が出しているので、**同じロットに 2つの終了時刻**が有り、
//     ・画面の 🏁      = finishEta.finishAt
//     ・行の並び順の鍵 = ここの estEndTs
//   と食い違っていた。実測(2026-08-16)で 9通り中 8通りがズレ、最大で **15時間**ズレた
//   (16:30に残り120分 → ここは残業込みで当日18:45 / finishEta は定時までで翌朝10:00)。
//   並び順だけが違うと「上から順に終わる」と読んだ相手工程が必ず外れる。
//   → 終了時刻は **finishEta ただ1本**。ここは etaOf で受け取って持ち回るだけにした。
//   ⚠ここに「見積−経過」で時刻を作る行を二度と足さない。足した瞬間にまた2本になる。
//
// 引数はすべて注入 = この module は勤務スケジュールもテンプレートも知らない(テストしやすい)。
//   estimateSecOf(lot)  → そのロットの見積(秒)。⚠数字を見せる為だけ。時刻には使わない
//   elapsedMsOf(lot)    → そのロットの実作業経過(ミリ秒・進行中の分も込み)。⚠同上
//   etaOf(lot)          → finishEta() の戻り。**終わりの時刻はここからしか採らない**
//                         (渡さなければ estEndTs は null = 「分かりません」。勝手に作らない)
//   workerNameOf(lot)   → 担当者名
//   ⚠ `now` はもう受け取らない。「いま」を持っているのは finishEta だけ(呼ぶ側が etaOf に渡す)。
//     ここに now を残すと「now + 残り」で時刻を作りたくなる = また2本になる。渡されても無視する。
export const buildWorkStatusRows = ({
    lots = [], arrivalByLot = {},
    estimateSecOf = () => 0,
    elapsedMsOf = () => 0,
    etaOf = null,
    workerNameOf = () => '',
    startedAtOf = null,
} = {}) => {
    const rows = [];
    (lots || []).forEach(lot => {
        if (!lot || !lot.id) return;
        if (lot.status === 'completed' || lot.location === 'completed') return;
        const processing = lot.status === 'processing';
        const paused = lot.status === 'paused';
        const elapsedMs = Math.max(0, elapsedMsOf(lot) || 0);
        const started = processing || paused || elapsedMs > 0;
        const arrival = arrivalByLot[lot.id] || null;
        const arrivalTs = arrival ? dateTimeMs(arrival.date, arrival.time) : null;
        // 始まっていない & 到着予定も無い = 出さない (相手が見たいのは「今動いているもの」と「もう時間を教えた分」)
        if (!started && arrivalTs == null) return;
        const estimateSec = Math.max(0, estimateSecOf(lot) || 0);
        const elapsedSec = elapsedMs / 1000;
        // ⚠これは「予定の目安 − もう働いた分」という**ただの引き算**。時計の時刻ではない。
        //   休憩も定時も土日も人数も入っていないので、**これを時刻に変えてはいけない**。
        const remainSec = Math.max(0, estimateSec - elapsedSec);
        const startedAt = started
            ? (startedAtOf ? startedAtOf(lot) : (lot.workStartTime || null))
            : null;
        // 🏁 終わりの時刻は finishEta ただ1本。出せない時(人がいない・止まっている・目安が無い等)は
        //   ok:false で返ってくるので **null のまま**にする。ここで代わりの時刻を作らない。
        const eta = typeof etaOf === 'function' ? (etaOf(lot) || null) : null;
        const estEndTs = (eta && eta.ok === true && Number.isFinite(eta.finishAt)) ? eta.finishAt : null;
        rows.push({
            eta,                       // 画面はこれを finishEtaView に渡す(言葉も出どころも1か所で作る)
            lotId: lot.id,
            workerId: lot.workerId || '',
            workerName: workerNameOf(lot) || '',
            orderNo: lot.orderNo || '',
            model: lot.model || '',
            quantity: lot.quantity || 0,
            dueDate: lot.dueDate || '',
            state: processing ? 'processing' : paused ? 'paused' : started ? 'stopped' : 'waiting',
            started,
            startedAt,
            arrivalTs,
            arrivalBy: arrival?.by || '',
            elapsedSec: Math.round(elapsedSec),
            estimateSec: Math.round(estimateSec),
            remainSec: Math.round(remainSec),
            estEndTs,                  // = eta.finishAt(出せた時だけ)。⚠ここ以外で作らない
            // ⚠この行が「いま動いている側」か「到着待ち側」かの札。**終了時刻の出どころではない**
            //   (終了時刻は必ず eta)。画面が 🚚到着 の札を出す判定に使っているので名前は残す。
            estEndFrom: started ? 'now' : 'arrival',
        });
    });
    // 動いているものが先。次に止まっているもの、最後に到着予定だけのもの。
    //   同順位は「終わりが早い順」。⚠終わりが出せない行(止まっている・担当未定など)は
    //   代わりに**到着予定**で並べる。到着予定も無ければ指図番号順。
    //   ⚠⚠ 並びの鍵は画面に出ている 🏁 と**同じ値**(eta.finishAt)。別の式で並べると
    //     「上から順に終わる」と読んだ相手工程が必ず外れる。
    const rank = { processing: 0, paused: 1, stopped: 2, waiting: 3 };
    const orderKey = (r) => r.estEndTs ?? r.arrivalTs ?? Infinity;
    return rows.sort((a, b) =>
        (rank[a.state] - rank[b.state]) ||
        (orderKey(a) - orderKey(b)) ||
        String(a.orderNo).localeCompare(String(b.orderNo)));
};

// ロットの「最初に着手した時刻」。
// ⚠ lot.workStartTime は“今のひと続き”の開始で、止めると消える。相手に見せる「開始時間」に使うと
//   休憩を挟んだだけで時刻が飛ぶ。タスクの firstStartTime の最小(=本当に手を付けた時刻)を採る。
export const lotFirstStartMs = (lot) => {
    const tasks = lot?.tasks || {};
    let min = null;
    Object.keys(tasks).forEach(k => {
        const v = tasks[k] && tasks[k].firstStartTime;
        if (Number.isFinite(v) && v > 0 && (min == null || v < min)) min = v;
    });
    return min != null ? min : (lot?.workStartTime || null);
};

// 作業状況を相手に見せるか。既定ON(見せるために作った機能なので)。設定でOFFにできる。
export const workStatusEnabled = (settings) => settings?.contactPortal?.showWorkStatus !== false;
// 担当者の名前を出すか。既定ON。名前を伏せたい会社もあるので分けておく。
export const workStatusShowName = (settings) => settings?.contactPortal?.showWorkerName !== false;

// 作業者ごとにまとめた見出し用。誰が何件持っているか。
export const groupRowsByWorker = (rows = [], unknownLabel = '担当なし') => {
    const map = new Map();
    rows.forEach(r => {
        const k = r.workerName || unknownLabel;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
    });
    // 動いている人が上。次に件数の多い人。
    return [...map.entries()]
        .map(([name, list]) => ({ name, rows: list, processing: list.filter(r => r.state === 'processing').length }))
        .sort((a, b) => (b.processing - a.processing) || (b.rows.length - a.rows.length) || a.name.localeCompare(b.name));
};

// ==================== やりとり履歴 (到着予定込み) ====================
// 履歴には依頼(contact_requests)だけでなく、組立が自分で登録した到着予定も混ぜる。
// 「教えたのに履歴に出ない」= 教えた事実が残らない、になるため。
export const buildHistory = ({ contactRequests = [], arrivalTimes = [], group = null, rangeId = DEFAULT_RANGE_ID, now = Date.now() } = {}) => {
    const items = [];
    (contactRequests || []).forEach(r => {
        if (!r || r.status === 'canceled') return;
        if (group && r.to !== group) return;
        items.push({ key: `req:${r.id}`, type: 'req', at: r.createdAt || 0, req: r });
    });
    // 自発登録の到着予定だけ(依頼への回答は上の req 側に出るので除く)
    const reqIds = new Set((contactRequests || []).map(r => r?.id).filter(Boolean));
    (arrivalTimes || []).forEach(a => {
        if (!a || !a.id || !a.time) return;
        if (group && a.group && a.group !== group) return;
        if (a.viaReq && reqIds.has(a.viaReq)) return;
        items.push({ key: `arr:${a.id}:${a.at || 0}`, type: 'arrival', at: a.at || 0, arrival: a });
    });
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    return filterByRange(items, rangeId, now, x => x.at);
};

// ==================== PC / スマホ 表示切替 ====================
// ⚠ 中身は `domain/layoutMode.js` へ移した(連絡ポータル以外の画面でも使う為)。
//   ここは既存の import (`from './domain/contactBoard.js'`) を壊さない為の通り道。
//   **定義は layoutMode.js に1つだけ**。ここに書き足さない事。
//   高さも見る新しい判定(layoutOf / layoutInfo / short)は layoutMode.js から直接どうぞ。
export { LAYOUT_MODES, WIDE_MIN_PX, isWideLayout } from './layoutMode.js';
