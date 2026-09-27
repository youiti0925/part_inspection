// ============================================================================
// 🧾 条件・根拠タブに出ていた物の「棚卸しと引っ越し先」— 製品検査
// ----------------------------------------------------------------------------
// 清水さん(2026-09-04 昼・原文):
//   「改善教育も条件根拠も全くわからん何のためにあるの？何を伝えたいの？」
// 決まり19C: 条件・根拠は **画面としては無くす**。ただし
//   **中身は1つも消さずに** 各数字の「？」と ⚙ の引き出しへ移す。
//
// 🚨 この表が「消していない」事の唯一の証拠です。
//   ・元の画面に出ていた物を1行ずつ書く（`items`）。
//   ・1行ずつ「どこへ移したか」(`to`)を書く。
//   ・見張り(scripts/opsim-basis-move-guard.mjs)が
//     「行方不明が0件」「設定が『？』に混ざっていない」を数えます。
//   ・移した数 == 元の数 を数字で出せる様にする為に、**1つの項目は1つの行き先**にします。
//
// 🚨 1行で「何のために在るか」が書けない物は、勝手に消さずに `to: 'undecided'` にして
//   画面に「この2つは意味が決まっていません」と残し、清水さんに聞きます（勝手に消さない）。
//
// 行き先の言葉:
//   'gear'      … ⚙ の引き出し（設定。押すと結果が変わる物）
//   'gearTech'  … ⚙ の一番下・技術の畳み（かかった時間・段ごとのms など。判断材料ではない）
//   'strip'     … 既にある帯に一本化（同じ事を2回言わない。帯は消さない）
//   'board'     … 盤面に常設（読み書き0件 など、いつでも見えていないと意味が無い物）
//   'why:<鍵>'  … その数字の「？」（🚨 押した数字1つの根拠だけを出す）
//   'undecided' … 1行が書けない。消さずに残して聞く
// ============================================================================

/**
 * 🚨 元の「条件・根拠」タブに出ていた物の **数**（2026-09-04 に実画面とコードで数えた物）。
 *   行を1行こっそり消しても「移した数 == 元の数」は釣り合ってしまうので、
 *   **数そのものを書いて留めます**（2026-08-23「上限が自明な量は上限と比べる」と同じ族）。
 *   ⚠ 本当に項目が増減した時だけ、この数も一緒に直してください。
 */
export const EXPECTED_ITEM_COUNT = 40;
/** 「？」の話題の数。作り忘れ・消し忘れを留める。 */
export const EXPECTED_WHY_COUNT = 7;

/** 行き先の種類。ここに無い言葉を `to` に書いたら見張りが赤にします。 */
export const MOVE_TARGETS = Object.freeze(['gear', 'gearTech', 'strip', 'board', 'undecided']);

/**
 * 「？」の話題。🚨 1つの「？」は **1つの数字の根拠だけ** を出します。
 * （全部の設定を並べると、条件・根拠タブが小さくなって戻って来るだけ＝元の木阿弥）
 *
 * 中身の形（清水さんへの説明の順番そのまま）:
 *   big      … 押した数字そのもの（大きい字）
 *   from     … どこから来たか。**関数名を書かない。現場の言葉で**
 *   parts    … 内訳（この数を作っている物）
 *   unknown  … 分かっていない事（黙って0にしない）
 *   next     … 次にやる事（押すと行ける所）
 */
export const WHY_TOPICS = Object.freeze({
  idleMinutes: {
    title: '手が空いた時間',
    lead: 'この人が、この期間に「仕事が無くて待っていた」分数です。',
    from: '盤面の割付そのものから出しています。人ごとに、勤務時間の中で仕事が当たらなかった区間を足した物です。',
    parts: ['作業中の人数', '手が空いている人数', '休み・時間外の人数', '手が空いているのに残っている仕事の件数'],
    unknown: ['「手が空いた」の中に、道具待ち・設備待ちは入っていません（設備を1件も繋いでいないため）。'],
    next: '空いている理由（仕事が無い／その工程を持てる人が居ない）は、盤面の納期一覧の右に出ます。',
  },
  capacity: {
    title: '働ける時間',
    lead: '1日にこの工場が使える直接作業の時間です。',
    from: '設定の勤務時間 ÷ 間接の割合 × 名簿の人数。工場の暦（祝日・休業）を引いた営業日で数えます。',
    parts: ['1日の勤務時間（設定）', '間接作業の割合（設定）', '名簿の人数', '営業日（工場の暦を引いた後）'],
    unknown: [
      '勤務の予定が入っていない「人×日」がある月は、その分を働ける時間に入れていません。',
      '工場の暦が0件の月は、祝日を1日も引いていません（多めに見積もります）。',
      '名前のある人数と設定の人数が食い違う時は、名前のある人で計算しています。',
    ],
    next: '勤務時間・間接の割合・工場の暦は ⚙ の引き出しで確かめられます。',
  },
  estimate: {
    title: '工数の見積り',
    lead: 'この仕事に何分かかると置いたかです。',
    from: '過去に同じ 型式×テンプレ×工程 で実際にかかった時間の分布から取っています。',
    parts: ['見積りの取り方（P50／P75／P90）', '工数が分からない工程の件数', '工数の信頼度が低い工程の件数'],
    unknown: [
      '工数が分からない工程は、目標時間で置いています（実績ではありません）。',
      '信頼度が低い工程は、材料になった記録が少ない物です。',
    ],
    next: '取り方（P50／P75／P90）は ⚙ の引き出しで変えられます。変えると計算し直しになります。',
  },
  arrivalAssumed: {
    title: '仮に置いた入荷日',
    lead: '入荷日が入っていない仕事を、いつ着くと置いたかです。',
    from: '納期の2日前に着くと置いています。2日前がもう過ぎている物は、次の勤務開始に置いています。',
    parts: ['納期の2日前に置けた件数', '2日前がもう過ぎていて次の勤務開始に置いた件数', '到着予定を過ぎたまま現物未確認の件数'],
    unknown: ['本当の入荷日は分かりません。元のデータには1文字も書き戻していません。'],
    next: '仮に置くのを止めると、入荷日が無い物は判定がつかなくなります（⚙ の引き出し）。',
  },
  stale: {
    title: '対象外にした仕事',
    lead: '納期がもう過ぎていて、この期間の計算に載せなかった仕事の件数です。',
    from: '納期の日が基準時刻より前の物を、この期間の外として分けています。',
    parts: ['過去納期のため対象外', '到着予定が無いため対象外'],
    unknown: ['対象外にしても、仕事が無くなった訳ではありません。遅れている事実は残ります。'],
    next: '遅れて終わった記録は、盤面のロットの流れの右に残しています。',
  },
  finish: {
    title: '終わる見込みの時刻',
    lead: 'この仕事が終わると計算した時刻です。',
    from: '入荷日から順に、工程の順番どおりに人を貼り付けて時間を進めた結果です。',
    parts: ['入荷日（本当の日／仮に置いた日）', '前の工程が終わる時刻', '担当できる人の空き'],
    unknown: [
      '🚨 設備（治具・機械）の空きを1件も見ていません。設備待ちで止まる分はこの時刻に出ません。',
      '2人でできる工程は、人を2人押さえるだけで、かかる時間は縮めていません。',
    ],
    next: '設備の制約はまだ繋いでいません。繋ぐまでは、この時刻は「設備が空いていればこの時刻」です。',
  },
  worker: {
    title: '担当者と、その人が持てる理由',
    lead: 'この工程をこの人に当てた理由です。',
    from: '過去にこの人がこの工程をやった記録があるかどうかだけで決めています。',
    parts: ['この工程を持てる人の名前', '材料にした記録の件数', '空いている理由（仕事が無い／持てる人が居ない）'],
    unknown: [
      '🚨 力量は過去の作業記録から作った仮の物です。正式な認定ではありません。',
      '🚨 記録が無いのは「分かりません」であって、やれないという意味ではありません。',
    ],
    next: 'スキルの登録を足すと、この割付が変わります（スキルマップ）。',
  },
});

/**
 * 元の「条件・根拠」タブに出ていた物、全部。
 * 🚨 実画面（本番の写し 2026-08-30・633ロット）で1つずつ数えた物です。
 * `shown:false` は「いま0件で画面に出ていないが、コードが出す道を持っている」物。
 *   0件だからと表から外すと、次に出た時に行き先が無くなるので必ず残します。
 */
export const BASIS_ITEMS = Object.freeze([
  // ── BasisControls（見る範囲・何日先まで・工数の見方・仮の入荷日）──────────
  { id: 'scope', label: '見ている範囲（手元にある物／すべて）', kind: 'setting', to: 'gear', shown: true },
  { id: 'horizonDays', label: '何日先まで（5日／30日）', kind: 'setting', to: 'gear', shown: true },
  { id: 'estimateMode', label: '工数の見方（P50／P75／P90）', kind: 'setting', to: 'gear', shown: true },
  { id: 'assumeArrivalDays', label: '仮の入荷日を置くか（納期の2日前・既定ON）', kind: 'setting', to: 'gear', shown: true },
  { id: 'assumeArrivalNote', label: '「仮で置いた件数と顔ぶれは上の⚠の帯に出ます」の案内', kind: 'note', to: 'strip', shown: true },

  // ── WorkerList（作業者・全員）───────────────────────────────────────────
  { id: 'tallyWorking', label: '作業中 ◯人', kind: 'number', to: 'why:idleMinutes', shown: true },
  { id: 'tallyWaiting', label: '手が空いています ◯人', kind: 'number', to: 'why:idleMinutes', shown: true },
  { id: 'tallyAway', label: '休み・時間外 ◯人', kind: 'number', to: 'why:idleMinutes', shown: true },
  { id: 'workerRows', label: '作業者1人ずつの行（名前・状態・いま持っている型式｜テンプレ・終わる時刻）', kind: 'note', to: 'board', shown: true },
  { id: 'unheldLots', label: 'いま誰も手を付けていない仕事 ◯件', kind: 'number', to: 'undecided', shown: true },
  { id: 'idleWithWork', label: '手が空いているのに残っている仕事がある、の一言', kind: 'note', to: 'why:idleMinutes', shown: true },
  { id: 'capacityLine', label: '1日に使える時間 ◯h（勤務時間・間接の割合・人数から）', kind: 'number', to: 'why:capacity', shown: true },

  // ── AssumptionCard（仮定を置いて比べる）──────────────────────────────────
  { id: 'assumeSub', label: '「ここで入れた値はこの画面の中だけの仮定です」の但し書き', kind: 'note', to: 'gear', shown: true },
  { id: 'rerunButton', label: '「もう一度計算」ボタン', kind: 'setting', to: 'gear', shown: true },
  { id: 'absencePicker', label: '休みにする人と日数', kind: 'setting', to: 'gear', shown: true },
  { id: 'ojtPicker', label: '単独でできる様になったと仮定する人と工程', kind: 'setting', to: 'gear', shown: true },
  { id: 'overtimeExtra', label: '残業の量（満額／＋30分／＋60分）', kind: 'setting', to: 'gear', shown: true },
  { id: 'swapPicker', label: '人の任せ替え（誰の仕事を → 誰に）', kind: 'setting', to: 'gear', shown: true },
  { id: 'soloMode', label: '「1つの型式は1人で」の入り切り', kind: 'setting', to: 'undecided', shown: true },
  { id: 'twoPersonKeys', label: '2人でできる工程（複数選べる）', kind: 'setting', to: 'gear', shown: true },
  { id: 'saveError', label: '「保存できませんでした」の赤い札', kind: 'note', to: 'gear', shown: false },
  { id: 'savingNote', label: '「保存しています…」／「ここだけは設定として残します」', kind: 'note', to: 'gear', shown: true },
  { id: 'noEditNotice', label: '「使用者を選ぶと仮定の入力が使えます」の案内', kind: 'note', to: 'gear', shown: false },
  { id: 'stepHoursText', label: '工数の見積りの説明文（stepHoursText）', kind: 'note', to: 'why:estimate', shown: true },

  // ── StaleStrip（対象外の帯）─────────────────────────────────────────────
  { id: 'staleCount', label: '過去納期のため対象外 ◯件', kind: 'number', to: 'why:stale', shown: true },

  // ── BasisNotes（分かっていない事・暦・力量・基準時刻・読み書き・性能）─────
  { id: 'arrivalOverdue', label: '到着予定を過ぎたまま現物未確認 ◯ロット', kind: 'number', to: 'why:arrivalAssumed', shown: true },
  { id: 'arrivalUnknown', label: '到着日時が分からない ◯ロット', kind: 'number', to: 'why:arrivalAssumed', shown: true },
  { id: 'missingEstimate', label: '工数が分からない ◯工程', kind: 'number', to: 'why:estimate', shown: true },
  { id: 'lowConfidenceEstimate', label: '工数の信頼度が低い ◯工程', kind: 'number', to: 'why:estimate', shown: true },
  { id: 'missingAvailability', label: '勤務の予定が入っていない ◯人日（人×日）', kind: 'number', to: 'why:capacity', shown: true },
  { id: 'equipmentUnmodeled', label: '「設備を見ていません」の札', kind: 'note', to: 'why:finish', shown: true },
  { id: 'workerCountConflict', label: '「名前のある人数と設定の人数が食い違っています」の赤い札', kind: 'note', to: 'why:capacity', shown: false },
  { id: 'factoryCalendar', label: '📅 工場の暦（◯日分引いた／引いていない ＋ 月ごとの営業日）', kind: 'number', to: 'why:capacity', shown: true },
  { id: 'skillProvisional', label: '「力量は過去の作業記録から作った仮の物です」', kind: 'note', to: 'why:worker', shown: true },
  { id: 'baseNowLine', label: '「◯月◯日 ◯時 時点の見立て」の基準時刻', kind: 'note', to: 'strip', shown: true },
  { id: 'evidenceButton', label: '「根拠を見る」ボタン', kind: 'setting', to: 'gear', shown: true },
  { id: 'elapsedMs', label: 'かかった時間 ◯ms', kind: 'tech', to: 'gearTech', shown: true },
  { id: 'ioCounts', label: '追加の読み取り ◯件 / 書き込み ◯件', kind: 'tech', to: 'board', shown: true },
  { id: 'perfBreakdown', label: '段ごとの所要時間（①履歴〜⑥教育の9行と棒）', kind: 'tech', to: 'gearTech', shown: true },

  // ── EvidenceCard（根拠・データ監査）─────────────────────────────────────
  { id: 'evidenceCard', label: '根拠・データ監査（ロット／テンプレ／作業者の生データ）', kind: 'setting', to: 'gear', shown: true },
]);

/**
 * 🚨 1行で「何のために在るか」が書けなかった物。**消さずに画面に出して聞きます**。
 * 清水さんの答えが来るまで、勝手に消しません。
 */
export const UNDECIDED_NOTES = Object.freeze({
  unheldLots: {
    label: 'いま誰も手を付けていない仕事 ◯件',
    problem: '盤面の「手が付かない仕事 ◯ロット」と名前がほとんど同じなのに、数が違います。'
      + '（こちらは「その時刻に人が当たっていない残りのある仕事」、盤面は「期間の終わりまで一度も人が付かなかったロット」）',
    ask: 'どちらの数を見たいですか。片方に寄せますか、名前を変えて2つとも残しますか。',
  },
  soloMode: {
    label: '1つの型式は1人で',
    problem: '画面自身が「同じ型式を同時に2人が触らない」なのか「その型式は最初に触った人が最後まで持つ」なのか'
      + '決まっていないと書いています。いまは前者で計算しています。',
    ask: 'どちらの意味ですか。',
  },
});

/** 移した先ごとの数。🚨 ここで数えるのは1回だけ（同じ数字を2つの計算から出さない）。 */
export function tallyMoves(items = BASIS_ITEMS) {
  const by = {};
  items.forEach((it) => {
    const key = String(it.to || '');
    by[key] = (by[key] || 0) + 1;
  });
  return by;
}

/** 「？」の鍵ごとに、そこへ移った元の項目。画面の「？」の中で「ここに◯件まとめました」と言う為。 */
export function itemsForWhy(topicKey, items = BASIS_ITEMS) {
  return items.filter((it) => it.to === `why:${topicKey}`);
}

export default BASIS_ITEMS;
