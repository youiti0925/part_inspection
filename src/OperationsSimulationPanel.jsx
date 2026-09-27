import PlanControlPanel from './opsim/planControl/PlanControlPanel.jsx';
import ParallelLabPanel from './opsim/parallelLab/ParallelLabPanel.jsx';
import LotPairLab from './opsim/parallelLab/LotPairLab.jsx';
import { RiskFlowBoard } from './opsim/RiskFlowBoard.jsx';
import { ItemNameProvider, ItemNameTag } from './opsim/partsItemName.jsx';
// 🗂 割付と空き(Codex 13bb9d2 の画面。清水さん「全部確認してちゃんと入れて」2026-09-23)
import DecisionBoard from './opsim/DecisionBoard.jsx';
// 🚨 2026-09-23 清水さん「使えない物を追加した」: 並列ラボは本番の控えで効き目 0件(docs/効き目_本番の控え.json)。
//   効かない画面は本番に出さない(約束 P35。旧番号 P33)。効いた件数が書けるまで false。見張りが false を確かめる。
const PARALLEL_LAB_SHOWN = false;
// 🧭 2026-09-24 清水さん「①(ChatGPT の見本)に②(区画どうしの距離)を足せばいいだけ」「本来合体してるものだよね」
//   → 見本の iframe(架空の2ロット)と ZoneTravelPanel(508件中3件)を外し、1つの道具にした(src/opsim/parallelLab/LotPairLab.jsx)。
//   本番のロットを2つ選ぶと、自動運転の空き(ロットの中で他の台の手作業を埋めた後)と区画どうしの距離から
//   「このロットの中で埋まる／この距離でこの2ロットを行き来する価値があるか」を ChatGPT の3案の絵で出す。効き目は docs/効き目_本番の控え.json lotPair。
const LOT_PAIR_SHOWN = true;
// 🧭 2026-09-23 ChatGPT/Codex の枝から入れた2画面(清水さん「全部確認してちゃんと入れて」)。写し(本番の控え 2026-09-23_1230)で
//   遅れの見取り図=これから・いま遅れ 20件＋遅れて完了 80件、割付と空き=人3人の順番＋遅れ20件が出た(docs/効き目_本番の控え.json)。
const RISK_VIEW_SHOWN = true;
const DISPATCH_TAB_SHOWN = true;
// 📏 2026-09-24 夕 保存計画まわり3画面の旗(約束 P35・docs/効き目_本番の控え.json の planControl / fieldPlanStrip / workRouting)。
//   計画を保存・比較 … 控え 2026-09-24_0930 で 最初の版が 1090/1090工程 そのまま保存できる(scripts/measure/planControl.mjs)→ 出す。
//   現場の指示の元の帯 … 採用した版が0なので「これは今の試算」としか言わない → 最初の版を採用したら出す。
//   実施エリアを選ぶ … 移動後の割付と納期を出さない作り(routeShelf.js は必ず complete:false)→ 足りない物が揃うまで下げる。
//   部品と計算は消さない(false の間は描かないだけ)。
const PLAN_CONTROL_SHOWN = true;
const FIELD_PLAN_SHOWN = false;
const WORK_ROUTING_SHOWN = false;
import { adoptedScenarioOf } from './domain/parallelLab/adoption.js';
// 🚶 2026-09-26 清水さん「基本は1ロットずつ・場合によって並列へ切り替え」。切り替えは settings.opsim.jugglingMode(製品だけ)
import { readJugglingMode, jugglingScenarioOf, JUGGLING_KEY } from './domain/parallelLab/juggling.js';
import { JugglingStrip } from './opsim/JugglingStrip.jsx';
import FieldPlanStrip from './opsim/planControl/FieldPlanStrip.jsx';
import { useAdoptedPlan } from './opsim/planControl/useAdoptedPlan.js';
import { dayWindowOf } from './domain/planControl/fieldOrders.js';
import WorkRoutingAction from './opsim/workRouting/WorkRoutingAction.jsx';
// =============================================================================
//  OperationsSimulationPanel.jsx — 操業シミュレーションを1枚の画面に組む
// -----------------------------------------------------------------------------
//  出典: 是正指示書 6章（画面仕様）／ src/domain/operationsSimulation/PANEL_SPEC.md
//
//  🚨 ここは **部品を並べるだけ**。計算は1行も書かない。
//     ・時間を進める計算 … src/domain/operationsSimulation/（完成済み）
//     ・別スレッドへの受け渡し … src/useOperationsSimulation.js
//     ・上の4枚と操作 … src/opsim/Header.jsx
//     ・盤面 … src/opsim/Board.jsx
//     ・作業者一覧と根拠 … src/opsim/Side.jsx
//
//  ■ この画面が守っている事
//   🚨 高さ: `h-full flex flex-col overflow-hidden` ＋ 中身は `flex-1 min-h-0 overflow-y-auto`。
//      過去に「下が切れる」「一番下のボタンが画面の外に出て押せない」を何度もやっている。
//      1280×720 / 1024×768 でも一番下まで届く事。
//   🚨 自動再生は初期状態で止める（指示書6.5）。動かす時も setInterval ではなく
//      requestAnimationFrame。画面から離れれば必ず止まる（裏で回り続けない）。
//   🚨 追加の読み取り0件 / 書き込み0件（指示書8.1）。この画面は Firestore を1件も触らない。
//      出している数字は normalized.diagnostics の実測値で、Header が出す。
//   🚨 ErrorBoundary で包む。ここが転んでも分析タブの他の画面を巻き込まない。
//
//  ■ 出してはいけない言葉（PANEL_SPEC 7章）
//   できない・不可・未経験・初級・上級者・有意・標本・スコア・偏差
//   記録が無い＝「分かりません」。「やれません」ではない。
// =============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowLeftRight, CalendarOff, ChevronDown, ChevronRight, GraduationCap,
  Info, Loader2, Maximize2, RefreshCw, Search, X,
} from 'lucide-react';

import { ErrorBoundary } from './ErrorBoundary.jsx';
import { useOperationsSimulation, makeScopeFilter, makeDefaultScopeFilter, SCOPE_PRESETS, DEFAULT_HORIZON_DAYS } from './useOperationsSimulation.js';
// 決定(2026-08-28): 過去納期+到着予定なし=対象外 / 入荷が納期より後=矛盾アラーム
import { staleOverdue, dueConflict } from './domain/dueConflict.js';
// 🚨 盤の見せ方は3通り。**どれも同じ計算結果を置くだけ**（計算はここでも向こうでもしない）。
//   見せ方が増えても答えが増えない事が要点。増えると必ず片方が腐る。
import { WorkerLanes } from './opsim/WorkerLanes.jsx';
import { DueCalendar } from './opsim/DueCalendar.jsx';
import { mergeSpans } from './opsim/dueAxis.js';
// 今日の判断の本体(2026-09-02 決まり8・9): 人ごとの指示 ＋ 何が・どれだけ遅れるか(横棒)。
//   遅れて完了(決まり10)は下の lateDone **その1つ** を読む(盤の棚・納期一覧と同じ物)。
// 🚨 2026-09-18 案A: 「今日の判断」という画面(札)は無くなりました。**中身は1つも消していません**:
//   ・人ごとの指示(WorkerLanes) … 見せ方の切替の [人ごとの指示] と 新しい「今日の指示」へ **移した**
//     (同じ部品を2つに増やさない為、ここでは TodayJudgment の入れ物を呼ばない)
//   ・何が・どれだけ遅れるか(TodayLateBars) … 主役のすぐ下の「くわしく」に **畳んだ**
//   ・🎲引き直し(ResampleFoldStrip) … 同じ「くわしく」の中に **畳んだ**
import { TodayLateBars } from './opsim/TodaySignal.jsx';
// 🗒 2026-09-18 案A(絵: scratchpad/design2/Main.dc.html ②)。人ごとに「いま → 次」を1枚。
//   🚨 製品検査と最終検査で同じファイル(md5 の対)。数はここでは1つも作らない。
import { TodayOrders } from './opsim/TodayOrders.jsx';
import TodayDecisions from './opsim/TodayDecisions.jsx';
import { todayDecisionsOf } from './opsim/todayDecisions.js';
// 🧰 2026-09-18 案A(絵: scratchpad/design2/Toolbox.dc.html)。散らばっていた道具を1つの引き出しへ。
//   🚨 入れ物だけ。中身は今まで画面に居た **同じ部品** をそのまま渡す(コピーを作らない)。
import { Toolbox, ToolboxButton } from './opsim/Toolbox.jsx';
// 📅 月ごと(2026-09-03 清水さん「一月毎に、月毎の必要な人材を確認する」)。
//   中身は Worker が返す result.monthly（monthly.js の buildMonthlyOutlook）。この画面では数えない。
import { MonthlyOutlook } from './opsim/Monthly.jsx';
// 追記(2026-08-30 画面4分割): Header は4タブの出し分けを持ち、改善・教育タブの中身(ImproveDeck)と
//   条件・根拠タブの部品(BasisControls/BasisNotes)を別部品として出す様になった。
import {
  Header, ImproveDeck, BasisControls, BasisNotes, BoardConclusionLine,
  // 拡大の時に盤の上へ残す1行の操作帯（2026-09-04 決まり20）
  BoardFullStrip,
  // 盤面タブの シナリオ▾ / ⏱ 時間を進める▾（2026-09-05 決まり31 で操作の1行へ移した **同じ部品**）
  BoardDrawerButtons,
  // 主因・副因・判定上の不足(2026-09-19: 「今日の判断」の札が無くなり開けなくなっていた → 主役の下の「▾ くわしく」へ)
  CauseTiersNote,
} from './opsim/Header.jsx';
// 拡大の時の寸法。🚨 帯を1行足した分だけ盤の使える高さを減らす（純関数ただ1本）。
import { opsimFullBoardPx } from './opsim/fullBoard.js';
// 期間の切替(2026-09-04 決まり19A)。5営業日 / 今月 / 来月。日数と届く日の持ち主は horizonRange.js ただ1本。
import {
  OPSIM_RANGES, opsimRangeDays, opsimNeedsDayStep,
} from './opsim/horizonRange.js';
// 期間の切替の帯と、月を選んだ時の「案C」の画面（割付を回さずに 人日と 誰も持てない工程まで）。
import { PeriodPills, PeriodRunNote } from './opsim/PeriodStrip.jsx';
// 🗓 来月の手当て(決まり19B)。**枠だけ**ここで作り、中身は丸ごとこの部品が持つ（写しを作らない）。
import { NextMonthPlan } from './opsim/nextMonth/index.js';
// 追記(2026-08-30 清水さんの要望3): 再生の「刻み」「速さ」の表は playPace.js がただ1つ持つ。
//   Panel は札(key)を覚えて渡すだけ＝2箇所に写しを作らない（前は Panel と Header に写しが有った）。
import {
  OPSIM_STEP_DEFAULT, OPSIM_PLAY_MS_DEFAULT, opsimStepOf, opsimPlayMsOf, opsimStepDays,
} from './opsim/playPace.js';
// 追記(2026-08-30): 条件比較の1表。契約の props(store/currentKey/onPick/overtimeStep/swapReady)を渡すだけ。
import { ScenarioCompare } from './opsim/ScenarioCompare.jsx';
// 追記(2026-08-30 清水さん「カードには品目コード・納期・残り時間・担当状態だけ」):
//   SelectedCardFacts＝カードから外した物（テンプレ名・台数・進み・状態の言い方・
//   担当が付いていない理由・ロットID）の **移し先**。値は盤と同じ lotFactsOf で作る。
import { Board, SelectedCardFacts } from './opsim/Board.jsx';
// 追記(2026-08-30 清水さん「ロットを押した時だけ、右から詳細を開く」): 引き出し。
import { LotDrawer } from './opsim/LotDrawer.jsx';
// 🪜 決まり23(2026-09-04 清水さん「残業したらとか土曜日でたら納期遅れが回避できるとかも
//   見やすく表示できるといいな」): 効く手のはしご。**押した時だけ** 4回ぶん割付を引き直す。
//   数は純関数 domain/operationsSimulation/rescueLadder.js が作る(この画面は数を作らない)。
import { RescueLadder } from './opsim/RescueLadder.jsx';
import { runLadderRung, lotsByIdOf, disposeLadderWorker } from './opsim/ladderRunner.js';
import { SharedWorkerStrip } from './opsim/SharedWorkerStrip.jsx';
import { SharedWorkerPlan } from './opsim/SharedWorkerPlan.jsx';
// 🕒 納期対応の残業・土曜(必要分)(2026-09-16)。箱は OvertimePlanCard、scenario への写しは overtimePlan.js の純関数。
import { OvertimePlanCard } from './opsim/OvertimePlanCard.jsx';
// 👤📊 2026-09-17 「このテンプレを優先」がどれだけ効いたか／人ごとの この期間の負荷(純関数。数はここで作らない)
import { templatePrefStats } from './domain/operationsSimulation/templatePrefStats.js';
import { workerLoadInWindow } from './domain/operationsSimulation/workerLoad.js';
import { scenarioOfOvertimePlan } from './domain/operationsSimulation/overtimePlan.js';
import { buildDailyLoadDoc, pickPlacement, placementKey, clearPlacement, composeAbsences, ymdsFrom, buildDueListDoc } from './domain/operationsSimulation/sharedWorkerPlan.js';
import { OPSIM_RULES, readOpsimRules, rulesScenarioOf, rulesBasisLines } from './domain/opsimRules.js';
import { buildRouteInputs } from './domain/workRouting/routeInputs.js';
// 📋🔀📌 2026-09-15 納期一覧の行の数(相手へ渡す書類と同じ)・並べ方・手で決めた担当・相手の納期一覧
import { dueRowFacts } from './domain/operationsSimulation/dueRowFacts.js';
import { normalizeDueSort } from './domain/operationsSimulation/dueListOrder.js';
import { skipHistoryText } from './domain/operationsSimulation/skipHistory.js';
import { pinsMapOf, pinsListWith } from './domain/operationsSimulation/lotPins.js';
// 📌 2026-09-17 「固定を全部外す」で使う印(自動へ戻す)。
//   ⚠ 上の1行は見張り(due-list-ops-wired W-4)が字で見ているので、別の行で足す。
import { PIN_AUTO } from './domain/operationsSimulation/lotPins.js';
// 🧷 2026-09-18 決めた物は固定が既定。現場で手が付いたロットは「記録の実際の担当」のまま出す。
//   🚨 純関数(両アプリ同じファイル)。ここでは数を1つも作らない。
import { actualWorkerPinsOf, actualPinsText } from './domain/operationsSimulation/actualPins.js';
import { mainWorkerOf, assignmentsByLot } from './opsim/mainWorker.js';
import { OtherDueList } from './opsim/OtherDueList.jsx';
import { WorkerList, LotDetail } from './opsim/Side.jsx';
// ❓⚙ 決まり19C(2026-09-04 清水さん「条件根拠も全くわからん何のためにあるの？」):
//   条件・根拠は画面としては無くし、中身を1つも消さずに
//   **各数字の「？」** と **⚙ の引き出し** へ移す。
//   引っ越しの表は src/opsim/basisRegistry.js（見張り scripts/opsim-basis-move-guard.mjs が数えます）。
import { Why, GearDrawer, GearButton } from './opsim/WhyDrawer.jsx';
import { fmtInt } from './opsim/fmtNum.js';
import { SoloDependencyPanel } from './SoloDependencyPanel.jsx';
import { makeCalendar } from './domain/operationsSimulation/calendar.js';
// 📅 月の帯(営業日・暦日・祝日)を作る。🚨 画面で日数を数え直さない為。
import { buildMonthPeriods } from './domain/operationsSimulation/forecast.js';
// 📅 工場の暦を畳む。🚨 この画面で曜日の判定を自分で書かない為。
import { makeIsWorkday as fcalMakeIsWorkday } from './domain/factoryCalendar.js';
import { buildEligibility, MODE_ALL } from './domain/operationsSimulation/historyEligibility.js';
import { buildSkillConfig } from './domain/skillRegistry.js';
// 🚨 「通常との差」は **同じ土俵の時だけ** 出す（仕様書5.8 / T013 / T014）。
import { compareScenarios, rankImprovements, SCENARIO_ID } from './domain/operationsSimulation/scenarios.js';
import { computeSoloDependency, docIdOf } from './domain/soloDependency.js';
// 🕒 納期対応の残業・土曜(必要分)の呼び出し口が、範囲の絞り込み(未完了だけ)に使う(はしご ladderRunner と同じ見方)。
import { isOpenLot } from './domain/dueDefense.js';
// 追記(2026-08-29 契約C4): what-if と「いつも通り」の引き直し(resample)の差分。純関数。
import { buildResampleDiff } from './domain/operationsSimulation/whatifDiff.js';
// 追記(2026-08-30): 基準時刻の2択(今から / 次の勤務開始から)。純関数＋試験は domain 側が持つ。
//   🚨 暦の決まりはこの画面に1行も置かない。policy.js / calendar.js の物をそのまま使う。
import { resolveBaseNow, BASE_TIME_MODE } from './domain/opsimBaseNow.js';
// 決まり10（2026-09-02）: 遅れて完了した物を消さない。数える式は App.jsx の納期分析と同じ1本。
import { buildLateDone } from './domain/operationsSimulation/lateDone.js';
// 決まり12（2026-09-02）: 品目コードにテンプレ名を必ず添える。名前の引き方は workerPlan.js の1本。
import { tplNameOf } from './domain/workerPlan.js';
// 決まり14-3・16（2026-09-03 清水さん「暇な理由が仕事が全くないのかスキルがないのか」）:
//   誰が・いつ・どれだけ手が空くか・なぜかは、割付の結果（idleLog / unresolved）から **この1本** で作る。
//   画面（IdleStrip / PersonDay）は置くだけで数え直さない。
import { buildIdleByDay, dayStartsBetween } from './domain/operationsSimulation/idleReason.js';
// 🏭 決まり(2026-09-06 清水さん「作業している場所が被ってる人いたわ。過去データからそこも意識して」):
//   作業する区画(エリア)の定員。過去の実測(同時に居た最大人数)から作り、人が上書きできる。純関数・見張りあり。
import { observedZoneConcurrency, zoneCapacityMap, zoneCapacityRows } from './domain/operationsSimulation/zoneCapacity.js';
// 🎛 決まり(2026-09-07 清水さん「実際の生産に近い状態でシミュレーションしたい」):
//   本物に近づける8つの設定。数字は **全部この純関数たちから貰う**(この画面で数え直さない)。
//   🚨🚨 8つとも **既定 OFF**。清水さんが何も選んでいない間は scenario へ 1バイトも足さない
//     ＝ シミュの答えは1ミリも変わらない(既存の見張りが全部そのまま緑である事が合格の条件)。
import { HABIT_MODE, arrivalHabitRows } from './domain/operationsSimulation/arrivalHabit.js';
import { buildEquipmentCapacity, readManualEquipmentCaps } from './domain/operationsSimulation/equipmentCapacity.js';
import { splitArrivalLoad } from './domain/operationsSimulation/splitArrivalLoad.js';
import { shipYMDOfLot } from './domain/operationsSimulation/shipDeadline.js';
// 🚗 2026-09-12 その 品目コード×テンプレ に「この品目コードだけの工程編集」が在るか。
//   🚨 探し方は domain/modelMaster.js が持つ物ただ1本。画面で当て直さない。
import { findModelTemplate } from './domain/modelMaster.js';
import { workerSpeedRows, clampLabel } from './domain/operationsSimulation/workerSpeed.js';
// 🎛 設定の読み方(既定は全部 OFF)と、scenario への渡し方。🚨 持ち主はこのファイルただ1つ。
//   📊 実績の表(buildXxx)も **realism.js の buildRealismTable ただ1か所** で作る(2026-09-10 ChatGPT の②)。
//   この画面で buildReworkRate 等を直に呼ばない(表示と計算で2回作らない・別の物を見せない)。
import {
  REALISM_KEY, REALISM_DEFAULT, MAX_LEAD_DAYS,
  REALISM_3_CHOICES, REALISM_ONOFF_CHOICES, REALISM_EQUIP_CHOICES,
  readOpsimRealism, wantsObservedEquipment, normalizeCapInput, normalizeLeadInput,
  realismTableWanted, buildRealismTable, realismScenarioOf, workerAvailabilityScenarioOf,
  // 👥 分担の区切り(2026-09-10 清水さん「後分担するときはできたら一台毎で区切る感じじゃないとだめだからね」)。
  //   🚨 札の言葉は handoff.js の物をそのまま(realism.js が中継する)。この画面で書き直さない。
  //   🚨 既定は 'unit'。エンジンの既定は 'none' のままなので、**渡すのはこの画面の仕事**。
  HANDOFF_KEY, HANDOFF_CHOICES, HANDOFF_FACT, HANDOFF_DEFAULT_NOTE,
  readOpsimHandoff, handoffBasisLine,
  // 🧵🚩 ロットは持ったら最後まで／優先度の区分(2026-09-10 清水さん「ロット処理して次のロットでいいでしょ」
  //   「緊急＞特注＞通常」)。🚨 既定は2つとも ON。渡すのはこの画面の仕事(エンジンの既定は「無し」)。
  LOT_FOCUS_KEY, PRIORITY_CLASS_KEY, LOT_FOCUS_CHOICES, LOT_FOCUS_LABEL, PRIORITY_CLASS_LABEL,
  LOT_FOCUS_FACT, PRIORITY_CLASS_FACT, LOT_FOCUS_DEFAULT_NOTE,
  readOpsimLotFocus, readOpsimPriorityClass, lotFocusScenarioOf, lotFocusBasisLine, priorityClassBasisLine,
  TEMPLATE_PREF_MODE_KEY, TEMPLATE_PREF_MODE_CHOICES, TEMPLATE_PREF_MODE_LABEL, TEMPLATE_PREF_MODE_FACT, readOpsimTemplatePrefMode,
} from './opsim/realism.js';

// -----------------------------------------------------------------------------
// 決め打ちの値。🚨 ここ以外に散らかさない。
// -----------------------------------------------------------------------------
/** 盤面の写真を撮る間隔。🚨 これを渡さないと snapshots が0件になり、カードが1ミリも動かない。 */
// 🚨 2026-08-23 実測: `+0.3日` を押しても位置が1つも変わらない回があった(1.6日目→1.9日目)。
//   原因は刻み。`+0.3日` は本番の設定だと実働 1.69時間(定時7時間20分 ÷ 間接係数1.3 × 0.3)なのに、
//   記録の刻みが 2時間 だったので、**同じ記録を2回見る**回が出ていた。
//   刻みをボタン1回ぶんより細かくして、押すたびに必ず次の記録へ進むようにする。
//   ⚠ 刻みを細かくすると記録の枚数が増える(上限は simulate.js の MAX_SNAPSHOTS が持っている)。
const SNAPSHOT_EVERY_MS = 30 * 60 * 1000;
/**
 * 再生の「刻み」と「速さ」。
 * 🚨 表そのものは opsim/Header.jsx が1つだけ持つ（ここに写しを作らない）。
 *   2026-08-30 まで、同じ2択が Panel と Header の両方に書いてあった＝
 *   片方だけ直すと画面の札と実際の動きが食い違う形になっていた。
 * 🚨 刻みは **記録(snapshot)の刻みとは別物**。記録は上の SNAPSHOT_EVERY_MS（30分）ごと。
 *   それより細かく進めた時に動くのは **カードの横位置だけ**で、
 *   誰が何をしているかは記録のまま＝測っていない割り当てをこちらで作らない。
 * 2026-08-24 清水さん「自動で0.05日毎で2秒毎で動くのあったらいいな」→ d005 + ms2000 として残っている。
 * 2026-08-30 清水さん「0.5時間毎を1秒毎とか2秒毎とか…こっちで細かく設定して」→ 刻みと速さを別々に選べる様にした。
 */
/** 何日ぶん先まで見るか（軽い方）。🚨 期間の切替で「今月/来月」を押すまではこの日数で回す。 */
const HORIZON_DAYS = DEFAULT_HORIZON_DAYS;

/**
 * 画面の一覧（2026-09-04 決まり19）。
 * 🚨 主役は **2つだけ**。清水さんが「何のためにあるの／何を伝えたいの」と言った3つは
 *   主役から外し、`secondary` にして **強さを下げる**。
 *   ⚠ 消していない（決まり6・19「情報は移す・畳む・強さを変える。消さない」）。
 *   ⚠ 今夜のうちに中身まで盤面の帯へ畳み切れていない物は、畳んだ札から開ける形で残した
 *     （中身は Header と ⚙ の引き出しに居て、別の担当が今夜同じ場所を触っている）。
 * 各画面の「この画面は◯◯を伝える」1行（決まり21）は hint に書く。書けない物は出さない。
 */
/* ══ 案A(2026-09-18 清水さん「いろんなところに機能が散らばりすぎてる、整理整頓しないとダメ」) ══
   画面の札は **[今日] [月] の2つだけ** にします（絵: scratchpad/design2/Main.dc.html / Month.dc.html）。
   🚨 **1つも消していません**。5つ在った札の中身は、全部この2つの中の置き場へ移しました:
     ・盤面           → [今日]（主役。納期一覧／人ごとの指示）
     ・今日の判断     → [今日] の 今日の指示（人ごとの「いま→次」）と、主役の下の「くわしく」
     ・来月の手当て   → [月]（NextMonthPlan。1枚目）
     ・月ごと         → [月]（MonthlyOutlook。2枚目）
     ・改善・教育     → [月]（ImproveDeck。3枚目。教育のリードタイムは月の話なので月に居るのが正しい）
   🚨 札を減らしたら **描く枝も一緒に** 直す事（見張り scripts/opsim-basis-move-guard.mjs が
     「札 ↔ 描く枝」を1対1で数えます。札の無い枝＝誰も辿り着けない画面 も赤になります）。 */
const OPSIM_TABS_MAIN = Object.freeze([
  {
    key: 'board',
    label: '今日',
    hint: '今日、誰が何をどの順でやって、いつ終わり、納期に間に合うか。手が空くなら なぜか',
  },
  {
    key: 'month',
    label: '月',
    hint: 'この先3か月、人は足りるか。足りないなら どの工程を・誰に・いつまでに 教えれば間に合うか',
  },
  /* 🗂 割付と空き(2026-09-23 Codex 13bb9d2 の画面を接いだ。清水さん「全部確認してちゃんと入れて」)。
     描く枝は下の {opsimTab === 'dispatch' && <DecisionBoard …/>}。既定の札は盤面のまま(決まり13・19)。 */
  ...(DISPATCH_TAB_SHOWN ? [  {
    key: 'dispatch',
    label: '割付と空き',
    hint: '人ごとの順番・空き・理由と、どの担当記録があれば空きを仕事へ変えられるか(🎓 技能の試行)',
  },
  /* 🚨🚨 2026-09-05: ここに `{ key: 'basis', … }` の札が残っていました。
     決まり19C で **描く枝を消した**のに札だけ残っていた＝
     **押せるのに、押した先が真っ白**。出荷を止める欠陥（確かめ役が実画面で実測）。
     中身は1行も消さずに次の3つへ移してあります（引っ越しの表 src/opsim/basisRegistry.js）:
       ・設定       … ⚙ の引き出し（下の <GearDrawer>。押すと結果が変わる物）
       ・数字の意味 … 各数字の横の ？（押した数字1つの根拠だけ）
       ・読み書き0件 … 盤面の上に常設
     🚨 札を戻すなら **描く枝**（下の {opsimTab !== '…' ? null : …}）も一緒に作る事。
       見張り scripts/opsim-basis-move-guard.mjs が
       「この表の鍵 全部に描く枝が在るか」を数えて赤にします。 */] : []),
]);

/**
 * ⚙ の引き出しの中の「ここです」の枠（2026-09-05・決まり19C の続き）。
 *
 * なぜ要るか:
 *   「条件・根拠」の札を外すと、そこへ行っていた道（「見ている範囲を広げてください」等）が
 *   **押しても何も起きない道** になります。だから道の行き先を ⚙ の引き出しへ繋ぎ直し、
 *   開いた時に **探している場所を光らせて、そこまで送る**。
 *
 * 🚨 光るのは「押して飛んで来た時」だけ（focus が一致した時だけ）。素で ⚙ を開いた時は
 *   1つも光りません（いつも光っていると、光っている事に意味が無くなる）。
 * 🚨 見た目だけです。何も確定しない・何も送らない・何も数えません。
 * 🚨 描画関数の中でコンポーネントを定義しない（毎回作り直されて状態が飛ぶ）。だからここに置く。
 * 🚨 px を1つも直書きしない（rem 段のクラスだけ）。zoom / transform:scale も使わない。
 */
// ── 🕒 納期対応の残業・土曜(必要分)の Worker 呼び出し口(2026-09-16) ─────────────────
// 🚨 盤の Worker(useOperationsSimulation)とも はしごの Worker(ladderRunner)とも **別の物** を立てる。
//   同じ物へ割り込むと、走っている計算が中止されて盤が空になる(worker は runId が変わると前の計算を捨てる)。
// 🚨 計算は1行も持たない。kind:'overtimePlan' を送り、Worker が返した物をそのまま渡すだけ。
//   Worker を作れない端末では同じファイルの runOvertimePlanPipeline をこの場で回す(その間、画面は止まる)。
let overtimePlanWorker = null;
let overtimePlanSeq = 0;
let overtimePlanWorkerBroken = false;
const OVERTIME_PLAN_TIMEOUT_MS = 180000;
function runOvertimePlanPayload(payload) {
  const runHere = async () => {
    const mod = await import('./workers/operationsSimulation.worker.js');
    return mod.runOvertimePlanPipeline(payload, { yieldToHost: () => new Promise((r) => { setTimeout(r, 0); }) });
  };
  return new Promise((resolve, reject) => {
    let worker = null;
    if (!overtimePlanWorkerBroken) {
      try {
        if (!overtimePlanWorker) overtimePlanWorker = new Worker(new URL('./workers/operationsSimulation.worker.js', import.meta.url), { type: 'module' });
        worker = overtimePlanWorker;
      } catch { overtimePlanWorkerBroken = true; worker = null; }
    }
    if (!worker) { runHere().then(resolve, reject); return; }
    overtimePlanSeq += 1;
    const runId = `overtime-plan-${overtimePlanSeq}`;
    let done = false;
    let onMsg = null; let onErr = null; let timer = null;
    const cleanup = () => {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      clearTimeout(timer);
    };
    const fallback = () => {
      if (done) return;
      done = true; cleanup();
      try { worker.terminate(); } catch { /* 既に落ちている */ }
      overtimePlanWorker = null;
      runHere().then(resolve, reject);
    };
    onMsg = (ev) => {
      const m = (ev && ev.data && typeof ev.data === 'object') ? ev.data : null;
      if (!m || m.runId !== runId) return;
      if (m.kind === 'result') {
        done = true; cleanup();
        if (m.ok) resolve(m.result); else reject(new Error(String(m.error || '必要分の計算に失敗しました')));
      }
    };
    onErr = () => { fallback(); };
    timer = setTimeout(fallback, OVERTIME_PLAN_TIMEOUT_MS);
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    try { worker.postMessage({ kind: 'overtimePlan', runId, ...payload }); } catch { fallback(); }
  });
}

function GearFocusBox({ id, focus, title, children }) {
  const on = focus === id;
  const boxRef = useRef(null);
  useEffect(() => {
    if (!on) return undefined;
    // ⚠ 開いた物が画面の外だと「押しても何も起きない」に見える。必ず見える所まで送る
    //   （handleOpenEvidence と同じやり方。写しではなく、同じ形を踏襲しているだけ）。
    const t = setTimeout(() => {
      const el = boxRef.current;
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
    return () => clearTimeout(t);
  }, [on]);
  return (
    <div
      ref={boxRef}
      data-opsim-gear-section={id}
      data-opsim-gear-focus={on ? '1' : undefined}
      /* 🚨 scroll-mt … 引き出しの見出しは sticky で上に貼り付いている。それを見込んで
         止める位置を下げないと、「▼ ここです」の行が見出しの下へ潜って読めない（実測）。
         rem 段のクラスで指定（px 直書きをしない）。 */
      className={on ? 'scroll-mt-12 rounded-2xl border-2 border-amber-400 bg-amber-50 p-2' : undefined}
    >
      {on ? (
        <div className="mb-1.5 text-2xs font-black leading-snug text-amber-800">
          ▼ ここです：{title}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * 件数を押した時に出る一覧（T027）。
 * 🚨 描画関数の中でコンポーネントを定義しない（毎回作り直されて状態が飛ぶ）。だからここに置く。
 * 🚨 窓に max-h を必ず付ける。付けないと件数が多い時に下のボタンが画面の外へ出る
 *   （2026-08-21 に3種類で起きた）。
 * 🚨 背景を押しても **閉じるだけ**。ここで何かを確定させない（背景タップの焼き付き対策）。
 */
function LotListDialog({ req, lots, onClose, onPick, templatesById = null }) {
  const ids = Array.isArray(req && req.lotIds) ? req.lotIds : [];
  const byId = new Map();
  (Array.isArray(lots) ? lots : []).forEach((l) => {
    const id = (l && (l.__id || l.id)) || '';
    if (id) byId.set(String(id), l);
  });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
      >
        <div className="shrink-0 flex items-center gap-2 border-b border-slate-200 px-3 py-2">
          <span className="text-sm font-black text-slate-800">{req.title}</span>
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-2xs font-black text-slate-600 tabular-nums">
            {ids.length}{req.unit || '件'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto min-h-11 px-3 rounded-lg border border-slate-300 bg-white text-2xs font-bold text-slate-700 hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {ids.length === 0 ? (
            <div className="p-3 text-2xs text-slate-500">1件もありません。</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {ids.map((id) => {
                const l = byId.get(String(id));
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => onPick && onPick(id)}
                      className="w-full text-left min-h-[44px] px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-cyan-50"
                    >
                      <span className="block text-xs font-bold text-slate-800">
                        {(l && l.model) || '（品目コードの記録がありません）'}
                        {l && l.model ? <ItemNameTag model={l.model} modelText={l.modelText} /> : null}
                        <span className="font-bold text-slate-500">{`｜${tplNameOf(templatesById, l && l.templateId) || 'テンプレ名なし'}`}</span>
                      </span>
                      <span className="block text-2xs text-slate-500">
                        {(l && l.orderNo) ? `指図 ${l.orderNo}・` : ''}
                        {(l && (l.quantity || 1)) || 1}台
                        {(l && l.dueDate) ? `・納期 ${l.dueDate}` : ''}
                        <span className="text-slate-400">（{id}）</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="shrink-0 border-t border-slate-200 px-3 py-1.5 text-2xs text-slate-500">
          この一覧は計算が返したロットIDをそのまま出しています（画面で数え直していません）。
          押すと、そのロットを盤で選びます。
        </div>
      </div>
    </div>
  );
}

/** 画面に出すシナリオの名前。改善策の表の見出しにも使う。 */
const SCENARIO_LABEL = Object.freeze({
  normal: '通常',
  overtime: '残業する',
  absence: '誰かが休む',
  allSkills: '全員がどの工程も持てる',
  ojt: '後継者が単独でできる様になった後',
  // 追記(2026-08-29 契約C3): 誰かの仕事を丸ごと別の人に任せた時。
  swap: '人の任せ替え',
});

/** 画面のシナリオ名 → 計算側の札（仕様書5.8 の scenarioId）。 */
const SCENARIO_ID_OF = Object.freeze({
  normal: SCENARIO_ID.BASELINE,
  overtime: SCENARIO_ID.OVERTIME,
  absence: SCENARIO_ID.ABSENCE,
  allSkills: SCENARIO_ID.ALL_SKILLS,
  ojt: SCENARIO_ID.SUCCESSOR,
  // 追記(2026-08-29 契約C3): 人の任せ替え。仕組みは assumeCertified(単独可の仮定)+absences。
  //   下流(worker/normalizeInput)が知っている札は既存の5つだけで、worker は札を
  //   metrics.scenarioId に写すだけ(実コードで確認)。新しい札を発明せず successor を使う。
  swap: SCENARIO_ID.SUCCESSOR,
});

/** Header の「見ている範囲」の key → useOperationsSimulation の SCOPE_PRESETS の key。 */
const SCOPE_TO_PRESET = Object.freeze({ onhand: 'inShop', soon: 'd14', all: 'all' });
/** preset の key → 暦日。'all' は null。🚨 SCOPE_PRESETS(useOperationsSimulation.js)ただ1つから引く。ここに日数を書かない。 */
const SCOPE_PRESET_DAYS = Object.freeze(Object.fromEntries(SCOPE_PRESETS.map((p) => [p.key, p.days])));

/**
 * 画面に出すシナリオ。
 * 🚨 「記録から」は出さない。本番の正式な力量は0件なので、既定の「通常」が
 *    そのまま『過去の作業記録から作った当て』であり、押しても数字が1つも変わらない。
 *    押しても何も変わらないタブを出さない（opsim/Header.jsx の注記どおり）。
 *    通常が実績からの仮定である事は、Header の注意1行が常に出している。
 */
const ENABLED_SCENARIOS = Object.freeze(['normal', 'overtime', 'absence', 'allSkills', 'ojt', 'swap']);

/** 休みを入れる日を数える時の「働く日」。normalizeInput の DEFAULT_WORKDAYS と同じ月〜金。 */
const ABSENCE_WORKDAYS = Object.freeze([1, 2, 3, 4, 5]);
/** 休みにできる日数の選択肢（指示書5.8-3「1日または2日休み」）。 */
const ABSENCE_DAY_CHOICES = Object.freeze([1, 2]);

/**
 * 追記(2026-08-29 契約C2): 残業の量の3択。既定は満額(従来どおり)。
 *   ＋30/＋60 は scenario.overtimeExtraMinutes として送るだけで、分数の解釈
 *   (min(定時+刻み, policyの540分)) は normalizeInput が決める。ここで分数を計算しない。
 */
const OVERTIME_EXTRA_CHOICES = Object.freeze([
  { key: '30', label: '＋30分', hint: '定時に30分だけ足す' },
  { key: '60', label: '＋60分', hint: '定時に60分だけ足す' },
  { key: 'full', label: '満額(9時間)', hint: '1日の直接作業を540分(policyの満額)として数える。従来どおり' },
]);

const MS_HOUR = 3600000;

// -----------------------------------------------------------------------------
// 小さい道具。🚨 数は必ず丸めてから文字にする（0.30000000000000004 を出さない）。
// -----------------------------------------------------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/**
 * 盤の見せ方 3通り（2026-08-24 清水さん「3パターンぐらい切り替えれたらいいね」）。
 * 🚨 どれも **同じ計算結果を置くだけ**。見せ方が増えても答えは1つ。
 *   ここで計算を足すと、同じ問いに2つの答えを持つ画面ができて、必ず片方が腐る。
 */
const VIEW_MODES = Object.freeze([
  { key: 'calendar', label: '納期一覧', hint: 'ロットごとに、誰が・いつ終わり・納期に間に合うか。上の帯は「誰が・いつ・なぜ手が空くか」' },
  { key: 'workers', label: '人ごとの指示（人・日順）', hint: '日ごとに人を固めて、その日の順番・終わる時刻・納期との関係を読む' },
  { key: 'board', label: 'ロットの流れ', hint: 'ロットが納期線へ近づく様子を見る。作業中の札は上の作業者の帯に。カードの横位置は到着から納期までの時間位置です（仕事の進捗率ではありません）' },
  // 🧭 2026-09-23 ChatGPT/Codex の枝 opsim-visual-monthly から合流(清水さん「全部確認してちゃんと入れて」)。旗は P35(効き目 0件なら出さない)
  ...(RISK_VIEW_SHOWN ? [{ key: 'risk', label: '遅れの見取り図', hint: 'これから遅れる／いま遅れている／遅れて完了 を3列に。赤い棒の長さが納期を越えた量' }] : []),
]);
const VIEW_TITLE = Object.freeze({
  workers: '人ごとの指示 — 今日、誰が・何を・どの順で・いつ終わるか（手が空くなら、なぜか）',
  board: 'ロットの流れ — 左から納期線へ近づく仕事',
  risk: '遅れの見取り図 — これから遅れる／いま遅れている／遅れて完了',
  calendar: '納期一覧 — 誰が・いつ終わり・納期に間に合うか（手が空くなら、なぜか）',
});
const VIEW_SUB = Object.freeze({
  // ⚠⚠ 先頭の一文は **最終検査(golden の opsimfi/assignView.js VIEW_SUB.workers)と1文字も同じ** にする。
  //   見張り(golden の golden-opsim-lanes.test.mjs L2)が、この文がそのまま在るかを突き合わせている。
  //   このアプリだけの言い方(テンプレ)は **末尾に足す**。途中に挿すと共通の文が切れて赤になる(2026-09-07 実測)。
  workers: '日 → 人 → その日の順番。空きの行の色が理由（橙＝記録が無い工程が待っている／灰＝仕事が無い）。「いま／次」の札は今日の見出しに畳んであります。品目コード｜テンプレ・指図・台数を全行に。',
  board: 'カードの横位置は到着から納期までの時間位置です。仕事の進捗率ではありません。',
  risk: '赤い棒が長いほど納期を大きく越えます。遅れて完了した物も消さずに残します。',
  calendar: '1行が1ロット。担当は1人に決めて出します。休みの列は棒を消しています。納期線を越えた分だけ赤。',
});
/** 🚨 0.05日刻みを round1 で丸めると 0.05 が 0.1 になり、倍の速さで進む。刻みに合わせる。 */
const roundToStep = (n, step) => {
  const s = Number(step) > 0 ? Number(step) : 0.1;
  return Math.round((Number(n) || 0) / s) * s;
};
const pad2 = (n) => String(n).padStart(2, '0');
const ymdOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
/** 「9/18（金）」。🚨 読めない時刻は '' を返す（0 を日付にして出さない）。 */
const WD_JA = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);
const fmtMDW = (ms) => {
  if (!Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  return `${d.getMonth() + 1}/${d.getDate()}（${WD_JA[d.getDay()]}）`;
};

/**
 * startMs の日から数えて、働く日を count 日ぶん拾う。
 * 🚨 土日を飛ばす。飛ばさないと「土曜に休んだ事にする」だけの空振りシナリオになる。
 */
function workdayKeysFrom(startMs, count, worksOn = null) {
  const out = [];
  // 📅 2026-09-02: 工場の暦を番む。祝日に「休んだ事にする」と、
  //   その日は元から誰も働いていないので空振りになる。
  //   「5日休む」と言いながら実際には3日分しか効かないシナリオになっていた。
  const works = typeof worksOn === 'function'
    ? worksOn
    : (ms) => new Set(ABSENCE_WORKDAYS).has(new Date(ms).getDay());
  const d = new Date(startMs);
  d.setHours(0, 0, 0, 0);
  // ⚠ 祝日が連なると拾うのに日数がかかるので、見る範囲を 30→45 日へ広げる。
  for (let guard = 0; guard < 45 && out.length < count; guard += 1) {
    if (works(d.getTime())) out.push(ymdOf(d.getTime()));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** 休みの表 { 'YYYY-MM-DD': { 名前: 'off' } } を作る。 */
function buildAbsences(name, days, startMs, worksOn = null) {
  const who = typeof name === 'string' ? name.trim() : '';
  if (!who || !isNum(startMs)) return null;
  const keys = workdayKeysFrom(startMs, Math.max(1, Math.trunc(Number(days)) || 1), worksOn);
  if (!keys.length) return null;
  const out = {};
  keys.forEach((k) => { out[k] = { [who]: 'off' }; });
  return out;
}

/**
 * 追記(2026-08-29 契約C3): 任せ替え用の休みの表。見通しの営業日ぶん丸ごと休みにする
 *   (=その人の仕事が見通しの中で他の人へ回る)。形は buildAbsences と同じ。
 *   ⚠ buildAbsences を触らないのは、既存の「誰か休み」(1〜2日)の挙動を1ミリも
 *     変えないため(追加のみの決まり)。guard 45 は 30営業日を土日込みで確実に拾う数。
 */
function buildSwapAbsences(name, workdayCount, startMs, worksOn = null) {
  const who = typeof name === 'string' ? name.trim() : '';
  if (!who || !isNum(startMs)) return null;
  const count = Math.min(30, Math.max(1, Math.trunc(Number(workdayCount)) || 1));
  // 📅 こちらも工場の暦を番む(祝日を休みにしても空振りなので)。
  const keys = workdayKeysFrom(startMs, count, worksOn);
  if (!keys.length) return null;
  const out = {};
  keys.forEach((k) => { out[k] = { [who]: 'off' }; });
  return out;
}

/**
 * 追記(2026-08-29 契約C1): 「通常」の結果から、作業者ごとの工程集合(Map 名前→Set(processKey))を作る。
 *   normalized.jobs(jobId→processKey) と base.assignments(jobId→worker) の突き合わせだけ。
 *   任せ替え(swap)で「Aさんの工程集合」を拾うための材料で、新しい数字は1つも作らない。
 */
function buildJobProcessByWorker(res) {
  const jobs = Array.isArray(res && res.normalized && res.normalized.jobs) ? res.normalized.jobs : [];
  const pkByJob = new Map();
  jobs.forEach((j) => {
    if (j && j.jobId != null) pkByJob.set(String(j.jobId), j.processKey == null ? '' : String(j.processKey));
  });
  const asg = Array.isArray(res && res.base && res.base.assignments) ? res.base.assignments : [];
  const byWorker = new Map();
  asg.forEach((a) => {
    if (!a) return;
    const w = typeof a.worker === 'string' ? a.worker.trim() : '';
    if (!w) return;
    const pk = String((a.processKey != null && a.processKey !== '' ? a.processKey : pkByJob.get(String(a.jobId))) || '');
    if (!pk) return;
    let s = byWorker.get(w);
    if (!s) { s = new Set(); byWorker.set(w, s); }
    s.add(pk);
  });
  return byWorker;
}

/** ロット・検査表の書類 id。docIdOf と同じ見方だが、ここは表示用なので軽く済ませる。 */
const idOf = (row) => (row && (row.__id || row.id)) || '';

// -----------------------------------------------------------------------------
// 見た目の部品
// 🚨 描画関数の中でコンポーネントを定義しない（毎回作り直されて状態が飛ぶ）。
//    だから全部モジュールの一番外に置く。
// -----------------------------------------------------------------------------
/**
 * ⚠ className は「画面いっぱい」の時に、この箱を縦の残り全部へ伸ばす為だけに渡す
 *   （flex の子は min-h-0 を付けないと中身の高さに押されて縮まない）。
 *   既定は空＝これまでと1pxも同じ。
 */
function CardBox({ icon: Icon, title, sub, right, children, className = '' }) {
  return (
    <div className={`bg-white border border-slate-200 shadow-sm rounded-xl overflow-hidden ${className}`}>
      {/* 📐 2026-09-18 夜: 見出し＋説明2行で約64px。1行にする(説明は切れたら title で全文)。 */}
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-1">
        {Icon ? <Icon className="w-4 h-4 shrink-0 text-cyan-600" /> : null}
        <div className="flex min-w-0 flex-1 items-baseline gap-x-2">
          <div className="shrink-0 text-sm font-black leading-tight text-slate-800">{title}</div>
          {sub ? <div className="min-w-0 truncate text-2xs leading-snug text-slate-500" title={typeof sub === 'string' ? sub : undefined}>{sub}</div> : null}
        </div>
        {right ? <div className="ml-auto shrink-0">{right}</div> : null}
      </div>
      {children}
    </div>
  );
}

function PickerRow({ label, children, note }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-bold text-slate-500">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
      {note ? <span className="text-2xs leading-snug text-slate-500">{note}</span> : null}
    </div>
  );
}

/** 選び直すと計算をやり直す物。狭い画面でも押せるよう、高さは 40px を割らない。 */
const SELECT_CLASS = 'min-h-[40px] max-w-full rounded-lg border border-slate-300 bg-white px-2 text-xs font-bold text-slate-700 disabled:opacity-40';

function NoticeBar({ tone = 'slate', icon: Icon, children }) {
  const tones = {
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
    rose: 'border-rose-300 bg-rose-50 text-rose-700',
    amber: 'border-amber-300 bg-amber-50 text-amber-800',
    cyan: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  };
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-2xs leading-snug ${tones[tone] || tones.slate}`}>
      {Icon ? <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// =============================================================================
//  🎛 本物に近づける設定（2026-09-07 清水さん「実際の生産に近い状態でシミュレーションしたい」）
// -----------------------------------------------------------------------------
// 🚨🚨 8つとも **既定 OFF**。読み方(readOpsimRealism)も渡し方(realismForScenario)も
//   src/opsim/realism.js ただ1つが持つ（この画面に写しを作らない）。
//   清水さんが何も選んでいない間は scenario へ 1バイトも足さないので、
//   シミュの答えは1ミリも変わらない（既存の見張りが全部そのまま緑である事が合格の条件）。
// 🚨 数字は純関数から貰う。この画面で数え直さない（「この設定で◯%延びる」ではなく素の実測）。
// ⚠ 配列で持つ物（設備ごとの定員）は **配列のまま** settings.opsim.equipmentCapacity へ。
//   表({id:n}) だと merge:true で1件消しても消えない（2026-07-26 の穴）。
// =============================================================================
/** 押す物は 44px 以上・文字は 12px 以上（text-xs = 12px）。 */
const REALISM_TAP = { minHeight: 'max(2.75rem, 44px)' };

/** 1つぶんの札の並び。⚠ 目印(data-*)は文言ではなく鍵で付ける（言い方を直しても見張りが赤にならない為）。 */
function RealismPicks({ name, value, choices, onPick, canEdit }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {choices.map((c) => (
        <button
          key={c.key}
          type="button"
          disabled={!canEdit}
          style={REALISM_TAP}
          data-opsim-realism-pick={`${name}:${c.key}`}
          onClick={() => { if (typeof onPick === 'function') onPick(c.key); }}
          className={`fi-tap-text rounded-lg border px-2.5 text-xs font-bold disabled:opacity-40 ${String(value) === c.key
            ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** 1行。⚠ 「見出し＋札」と「素の実測 1行」だけ。説明を積み増さない。 */
function RealismRow({ name, label, fact, children }) {
  return (
    <div className="flex flex-col gap-1 border-t border-slate-200 pt-2 first:border-t-0 first:pt-0" data-opsim-realism-row={name}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-xs font-black text-slate-700">{label}</span>
        {/* 🚨 2026-09-10: ここは `ml-auto shrink-0` だった。札が長い行(👥 分担の区切り)で
            中身 793px が枠 258px からはみ出し、**いま効いている札そのものが窓の外**で
            押せなくなっていた(確かめ役が実測)。2026-09-09 の「details 窓が overflow-hidden に
            切られて入口自体が無かった」と同じ形。縮める・折り返すの2つを許す。 */}
        <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-1.5" data-opsim-realism-picks={name}>{children}</div>
      </div>
      <span className="text-xs leading-snug text-slate-500" data-opsim-realism-fact={name}>{fact}</span>
    </div>
  );
}

/**
 * 🎛 本物に近づける設定（畳める1つの箱）。
 * 🚨 中身は「置くだけ」。実測の文(facts)は呼ぶ側が純関数から作って渡す。
 */
function RealismBox({
  canEdit, open, onToggle, cfg, onRealism, facts,
  equipRows = [], onEquipCap = null,
  // 👥 分担の区切り。⚠ 8つの 🎛 と違って **既定でも効く**(既定 'unit'＝清水さんの指定)。
  handoff = null, onHandoff = null,
  // 🧵🚩 ロットは持ったら最後まで／優先度の区分。⚠ これも **既定でも効く**(既定 ON＝清水さんの指定)。
  lotFocus = null, onLotFocus = null, priorityClass = null, onPriorityClass = null,
  // 👤 2026-09-17 「このテンプレを優先」の強さ。読み方は readOpsimTemplatePrefMode ただ1本。
  templatePrefMode = null, onTemplatePrefMode = null,
  // ⚙ 2026-09-22 割付の決まり(opsimRules)。読み方は readOpsimRules ただ1本。ここでは渡された物を出すだけ
  rules = null, onRule = null,
}) {
  const c = cfg || REALISM_DEFAULT;
  const tpm = templatePrefMode || readOpsimTemplatePrefMode(null);
  const f = facts || {};
  // 🚨 渡っていない時も「未登録＝既定」の形で読む(readOpsimHandoff ただ1本。ここで既定を書かない)。
  const h = handoff || readOpsimHandoff(null);
  const lf = lotFocus || readOpsimLotFocus(null);
  const pc = priorityClass || readOpsimPriorityClass(null);
  const onOffKey = (on) => (on ? 'on' : 'off');
  const line = (k) => (typeof f[k] === 'string' && f[k] ? f[k] : '開くと、ここに過去の実測が出ます。');
  return (
    <div className="rounded-xl border border-cyan-200 bg-cyan-50/40" data-opsim-realism-box="1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!!open}
        style={REALISM_TAP}
        data-opsim-realism-toggle="1"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 shrink-0 text-cyan-600" /> : <ChevronRight className="w-4 h-4 shrink-0 text-slate-400" />}
        <span className="min-w-0">
          <span className="block text-xs font-black text-slate-800">🎛 本物に近づける設定</span>
          <span className="block text-xs leading-snug text-slate-500">
            選んだ物だけが計算に効きます（🎛 の8つは いまは <b>使わない</b>）。
            👥 分担の区切り・🧵 ロットは持ったら最後まで・🚩 優先度の区分 は 既定でも効きます。
          </span>
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-cyan-200 px-3 py-2.5">
          {/* 👥 分担の区切り（2026-09-10 清水さん「後分担するときはできたら一台毎で区切る感じじゃないと
              だめだからね、区切りの良いところで分担ならOKね」「こういう設定もいるからね」）。
              🚨 下の8つと違い **既定でも効く**（既定 'unit'）。黙って効かせない為に、まだ誰も
                選んでいない時は札の横に「既定（清水さんの指定）」を出す（⚙ の根拠にも1行出る）。
              🚨 札の言葉は handoff.js の物をそのまま（ここで書き直さない）。 */}
          <RealismRow name="handoff" label="👥 分担の区切り" fact={HANDOFF_FACT}>
            <div className="flex flex-wrap items-center gap-1.5">
              <RealismPicks
                name="handoff" canEdit={canEdit} choices={HANDOFF_CHOICES}
                value={h.mode} onPick={(v) => { if (typeof onHandoff === 'function') onHandoff(v); }}
              />
              {h.registered ? null : (
                <span
                  className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold text-amber-800"
                  data-opsim-handoff-default="1"
                >
                  {HANDOFF_DEFAULT_NOTE}
                </span>
              )}
            </div>
          </RealismRow>

          {/* 🧵 ロットは持ったら最後まで（2026-09-10 23:30 清水さん「なんでこんなぐちゃぐちゃの仕事になるの？
              これならロット処理して次のロットでいいでしょ」）。
              🚨 既定 ON(清水さんの指定)。エンジンは scenario.lotFocus が無ければ1行も動かないので、渡すのはこの画面。
              🚨 まだ誰も選んでいない時は「既定（清水さんの指定）」の札(⚙ の根拠にも1行出る)。
              ⚠ 言葉(見出し・実測・既定の札)は realism.js の物をそのまま(ここで書き直さない)。 */}
          <RealismRow name="lotFocus" label={LOT_FOCUS_LABEL} fact={LOT_FOCUS_FACT}>
            <div className="flex flex-wrap items-center gap-1.5">
              <RealismPicks
                name="lotFocus" canEdit={canEdit} choices={LOT_FOCUS_CHOICES}
                value={onOffKey(lf.on)} onPick={(v) => { if (typeof onLotFocus === 'function') onLotFocus(v === 'on'); }}
              />
              {lf.registered ? null : (
                <span
                  className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold text-amber-800"
                  data-opsim-lot-focus-default="1"
                >
                  {LOT_FOCUS_DEFAULT_NOTE}
                </span>
              )}
            </div>
          </RealismRow>

          {/* 👤 「このテンプレを優先」の強さ(2026-09-17 清水さん「優先されているのかまったくわからん」)。
              既定は「順番だけ」(今まで)。「その人を待つ」にすると scenario.templatePrefMode='reserve' が載る。
              効いた件数は 手が空く帯の「優先テンプレの仕事 N件中 M件」(templatePrefStats)。 */}
          <RealismRow name="templatePrefMode" label={TEMPLATE_PREF_MODE_LABEL} fact={TEMPLATE_PREF_MODE_FACT}>
            <div className="flex flex-wrap items-center gap-1.5">
              <RealismPicks
                name="templatePrefMode" canEdit={canEdit} choices={TEMPLATE_PREF_MODE_CHOICES}
                value={tpm.mode} onPick={(v) => { if (typeof onTemplatePrefMode === 'function') onTemplatePrefMode(v === 'reserve' ? 'reserve' : 'order'); }}
              />
              {tpm.registered ? null : (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-bold text-slate-600" data-opsim-template-pref-default="1">既定（順番だけ）</span>
              )}
            </div>
          </RealismRow>

          {/* 🚩 優先度の区分を割付の先頭に（清水さん「優先度で通常と特注と緊急にして、緊急＞特注＞通常」）。
              🚨 既定 ON。scenario.priorityClass が無ければエンジンは優先度を読まない(いままでどおり)。 */}
          {/* ⚙ 2026-09-22 清水さん「AとBとか色々カスタマイズできるようにして…設定にないから設定できるようにしておいて」
              決まりの一覧・言葉・既定は opsimRules.js ただ1本。既定のままなら計算は今までと同じ */}
          {rules && OPSIM_RULES.map((r) => (
            <RealismRow key={r.key} name={`rule-${r.key}`} label={`${r.icon} ${r.label}`} fact={r.fact}>
              <div className="flex flex-wrap items-center gap-1.5" data-opsim-rule={r.key} data-opsim-rule-value={String(rules[r.key].value)}>
                <RealismPicks
                  name={`rule-${r.key}`} canEdit={canEdit} choices={r.choices.map((c) => ({ key: String(c.key), label: c.label + (c.key === rules[r.key].default ? '（既定）' : '') }))}
                  value={String(rules[r.key].value)} onPick={(v) => { if (typeof onRule === 'function') onRule(r.key, r.choices.find((c) => String(c.key) === v)?.key ?? rules[r.key].default); }}
                />
              </div>
            </RealismRow>
          ))}
          <RealismRow name="priorityClass" label={PRIORITY_CLASS_LABEL} fact={PRIORITY_CLASS_FACT}>
            <div className="flex flex-wrap items-center gap-1.5">
              <RealismPicks
                name="priorityClass" canEdit={canEdit} choices={LOT_FOCUS_CHOICES}
                value={onOffKey(pc.on)} onPick={(v) => { if (typeof onPriorityClass === 'function') onPriorityClass(v === 'on'); }}
              />
              {pc.registered ? null : (
                <span
                  className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold text-amber-800"
                  data-opsim-priority-class-default="1"
                >
                  {LOT_FOCUS_DEFAULT_NOTE}
                </span>
              )}
            </div>
          </RealismRow>

          {/* ① 入荷の遅れのクセ */}
          <RealismRow name="arrivalHabit" label="① 入荷の遅れのクセ" fact={line('arrivalHabit')}>
            <RealismPicks
              name="arrivalHabit" canEdit={canEdit} choices={REALISM_3_CHOICES}
              value={c.arrivalHabit} onPick={(v) => onRealism({ arrivalHabit: v })}
            />
          </RealismRow>

          {/* ② 設備の取り合い */}
          <RealismRow name="equipment" label="② 設備の取り合い" fact={line('equipment')}>
            <RealismPicks
              name="equipment" canEdit={canEdit} choices={REALISM_EQUIP_CHOICES}
              value={c.equipment} onPick={(v) => onRealism({ equipment: v })}
            />
          </RealismRow>

          {/* 手で入れる を選んだ時だけ、設備ごとの定員の表を出す。⚠ 列は3つだけ。 */}
          {c.equipment === 'manual' ? (
            <div className="flex flex-col gap-1" data-opsim-equip-cap={equipRows.length}>
              {equipRows.length === 0 ? (
                <span className="text-xs text-slate-400">設備がまだありません（検査表の工程に設備を入れると出ます）。</span>
              ) : (
                <div className="max-h-44 overflow-y-auto rounded border border-slate-200 bg-white">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-1.5 py-1 text-left font-bold">設備</th>
                        <th className="px-1.5 py-1 text-right font-bold">過去の最大</th>
                        <th className="px-1.5 py-1 text-right font-bold">定員</th>
                      </tr>
                    </thead>
                    <tbody>
                      {equipRows.map((e) => (
                        <tr key={e.equipmentId} className="border-t border-slate-100" data-opsim-equip-row={e.equipmentId} title={e.note}>
                          <td className="px-1.5 py-0.5 text-slate-700">{e.name}</td>
                          <td className="px-1.5 py-0.5 text-right font-mono text-slate-500">
                            {e.observedMax == null ? '—' : `${e.observedMax}台`}
                            <span className="ml-1 text-slate-300">{e.segments > 0 ? `/${e.segments}回` : ''}</span>
                          </td>
                          <td className="px-1.5 py-0.5 text-right">
                            <input
                              type="number"
                              min="1"
                              className="w-14 rounded border border-slate-300 px-1 py-0.5 text-right text-xs"
                              disabled={!canEdit || typeof onEquipCap !== 'function'}
                              defaultValue={e.source === 'setting' ? String(e.cap) : ''}
                              placeholder={e.observedMax == null ? '—' : String(e.observedMax)}
                              data-opsim-equip-input={e.equipmentId}
                              onBlur={(ev) => {
                                if (typeof onEquipCap !== 'function') return;
                                const got = normalizeCapInput(ev.target.value);
                                if (!got.ok) {
                                  window.alert('定員は1以上の整数で入れてください（空欄にすると過去の実測に戻ります）。');
                                  ev.target.value = e.source === 'setting' ? String(e.cap) : '';
                                  return;
                                }
                                onEquipCap(e.equipmentId, got.cap);
                              }}
                              aria-label={`${e.name} の定員`}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {/* ③ 分納を分けて積む */}
          <RealismRow name="splitArrival" label="③ 分納を分けて積む" fact={line('splitArrival')}>
            <RealismPicks
              name="splitArrival" canEdit={canEdit} choices={REALISM_ONOFF_CHOICES}
              value={c.splitArrival ? 'on' : 'off'} onPick={(v) => onRealism({ splitArrival: v === 'on' })}
            />
          </RealismRow>

          {/* ④ 出荷日から逆算した締切 */}
          <RealismRow name="shipDeadline" label="④ 出荷日から逆算した締切" fact={line('shipDeadline')}>
            <div className="flex flex-wrap items-center gap-1.5">
              <RealismPicks
                name="shipDeadline" canEdit={canEdit} choices={REALISM_ONOFF_CHOICES}
                value={c.shipDeadline ? 'on' : 'off'} onPick={(v) => onRealism({ shipDeadline: v === 'on' })}
              />
              {c.shipDeadline ? (
                <label className="flex items-center gap-1 text-xs font-bold text-slate-600">
                  梱包など
                  <input
                    type="number"
                    min="0"
                    max={String(MAX_LEAD_DAYS)}
                    className="w-14 rounded border border-slate-300 px-1 py-0.5 text-right text-xs"
                    style={REALISM_TAP}
                    disabled={!canEdit}
                    defaultValue={String(c.shipLeadDays)}
                    data-opsim-realism-lead="1"
                    onBlur={(ev) => {
                      const got = normalizeLeadInput(ev.target.value);
                      if (!got.ok) {
                        window.alert(`梱包などにかかる日数は 0〜${MAX_LEAD_DAYS} の整数で入れてください。`);
                        ev.target.value = String(c.shipLeadDays);
                        return;
                      }
                      onRealism({ shipLeadDays: got.days });
                    }}
                    aria-label="梱包などにかかる営業日数"
                  />
                  営業日前
                </label>
              ) : null}
            </div>
          </RealismRow>

          {/* ⑤ 修正(リワーク)の発生率 */}
          <RealismRow name="rework" label="⑤ 修正（やり直し）の発生率" fact={line('rework')}>
            <RealismPicks
              name="rework" canEdit={canEdit} choices={REALISM_3_CHOICES}
              value={c.rework} onPick={(v) => onRealism({ rework: v })}
            />
          </RealismRow>

          {/* ⑥ 中断(部品待ち・不良対応) */}
          <RealismRow name="interruption" label="⑥ 中断（部品待ち・不良対応）" fact={line('interruption')}>
            <RealismPicks
              name="interruption" canEdit={canEdit} choices={REALISM_3_CHOICES}
              value={c.interruption} onPick={(v) => onRealism({ interruption: v })}
            />
          </RealismRow>

          {/* ⑦ 人ごとの速さ */}
          <RealismRow name="workerSpeed" label="⑦ 人ごとの速さ" fact={line('workerSpeed')}>
            <RealismPicks
              name="workerSpeed" canEdit={canEdit} choices={REALISM_ONOFF_CHOICES}
              value={c.workerSpeed ? 'on' : 'off'} onPick={(v) => onRealism({ workerSpeed: v === 'on' })}
            />
          </RealismRow>

          {/* ⑧ 段取り替え */}
          <RealismRow name="setupChange" label="⑧ 段取り替え" fact={line('setupChange')}>
            <RealismPicks
              name="setupChange" canEdit={canEdit} choices={REALISM_ONOFF_CHOICES}
              value={c.setupChange ? 'on' : 'off'} onPick={(v) => onRealism({ setupChange: v === 'on' })}
            />
          </RealismRow>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 仮定の入力（指示書6.5）。
 * 🚨 ここで入れた値は **元のデータへ1文字も書き戻さない**。この画面の中の仮定だけ。
 */
function AssumptionCard({
  canEdit, workerNames, processOptions,
  scenarioKey, absenceName, absenceDays, ojtName, ojtProcess,
  onAbsenceName, onAbsenceDays, onOjtName, onOjtProcess, onRerun, stepHoursText,
  // 🚨 2026-08-24: 1品目コード=1人 と 2人でできる工程。ここだけは **設定として保存する**
  //   （他の仮定はこの画面の中だけ）。保存先は settings/config の中の opsim。
  soloMode = false, twoPersonKeys = [], onSoloMode = null, onTwoPersonKeys = null, saving = false, saveError = '',
  // 追記(2026-08-29 契約C2/C3): 残業の量(3択)と、人の任せ替え(誰の仕事を→誰に任せるか)。
  overtimeExtra = 'full', onOvertimeExtra = null,
  swapFrom = '', swapTo = '', onSwapFrom = null, onSwapTo = null, swapNote = '',
  // 🏭 2026-09-06: 作業する区画(エリア)の定員。行は zoneCapacity.js が作る(ここでは数え直さない)。
  zoneRows = [], onZoneCap = null,
  // 🎛 2026-09-07: 本物に近づける8つの設定。🚨 既定は全部 OFF・箱は畳んだ状態。
  //   realismFacts の文も equipRows も **純関数が作った物** を受け取るだけ(ここで数えない)。
  realism = REALISM_DEFAULT, onRealism = null, realismOpen = false, onRealismToggle = null,
  realismFacts = null, equipRows = [], onEquipCap = null,
  // ⚙ 2026-09-22 割付の決まり(opsimRules)。RealismBox へそのまま渡す
  rules = null, onRule = null,
  // 👥 2026-09-10: 分担の区切り。⚠ 読み方(既定 'unit' と 未登録の見分け)は readOpsimHandoff ただ1本。
  handoff = null, onHandoff = null,
  // 🧵🚩 2026-09-10 23:30: ロットは持ったら最後まで／優先度の区分。読み方は readOpsimLotFocus / readOpsimPriorityClass。
  lotFocus = null, onLotFocus = null, priorityClass = null, onPriorityClass = null,
  templatePrefMode = null, onTemplatePrefMode = null,
}) {
  const absenceOn = scenarioKey === 'absence';
  const ojtOn = scenarioKey === 'ojt';
  const overtimeOn = scenarioKey === 'overtime';
  const swapOn = scenarioKey === 'swap';
  return (
    <CardBox
      icon={GraduationCap}
      title="仮定を置いて比べる"
      sub="ここで入れた値は、この画面の中だけの仮定です。正式な力量や名簿へは書き戻しません。"
      right={(
        <button
          type="button"
          onClick={onRerun}
          className="inline-flex items-center gap-1 min-h-11 px-2.5 rounded-lg border border-slate-300 bg-white text-2xs font-bold text-slate-600 hover:border-cyan-400 hover:text-cyan-700"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          もう一度計算
        </button>
      )}
    >
      <div className="flex flex-col gap-3 px-3 py-2.5">
        <PickerRow
          label="休みにする人と日数（シナリオ「誰か休み」で効きます）"
          note={absenceOn && !absenceName ? '誰を休みにするか選んでください。選ぶまでは「通常」と同じ結果です。' : ''}
        >
          <CalendarOff className={`w-3.5 h-3.5 shrink-0 ${absenceOn ? 'text-amber-600' : 'text-slate-300'}`} />
          <select
            className={SELECT_CLASS}
            disabled={!canEdit}
            value={absenceName}
            onChange={(e) => onAbsenceName(e.target.value)}
            aria-label="休みにする人"
          >
            <option value="">（選んでいません）</option>
            {workerNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <select
            className={SELECT_CLASS}
            disabled={!canEdit}
            value={String(absenceDays)}
            onChange={(e) => onAbsenceDays(Number(e.target.value) || 1)}
            aria-label="休みにする日数"
          >
            {ABSENCE_DAY_CHOICES.map((d) => <option key={d} value={String(d)}>{`きょうから ${d}日`}</option>)}
          </select>
        </PickerRow>

        <PickerRow
          label="単独でできる様になったと仮定する人と工程（シナリオ「後継者が単独可になった後」で効きます）"
          note={ojtOn && (!ojtName || !ojtProcess) ? '人と工程の両方を選ぶと効きます。選ぶまでは「通常」と同じ結果です。' : ''}
        >
          <GraduationCap className={`w-3.5 h-3.5 shrink-0 ${ojtOn ? 'text-cyan-600' : 'text-slate-300'}`} />
          <select
            className={SELECT_CLASS}
            disabled={!canEdit}
            value={ojtName}
            onChange={(e) => onOjtName(e.target.value)}
            aria-label="仮に単独で任せる人"
          >
            <option value="">（選んでいません）</option>
            {workerNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <select
            className={`${SELECT_CLASS} w-full sm:w-auto sm:max-w-[22rem] truncate`}
            disabled={!canEdit || processOptions.length === 0}
            value={ojtProcess}
            onChange={(e) => onOjtProcess(e.target.value)}
            aria-label="仮に単独で任せる工程"
          >
            <option value="">{processOptions.length ? '（選んでいません）' : '（計算するとここに工程が出ます）'}</option>
            {processOptions.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </PickerRow>

        {/* ── 追記(2026-08-29 契約C2): 残業の量。既定=満額(従来どおり) ─────────────── */}
        <PickerRow
          label="残業の量（シナリオ「残業」で効きます）"
          note="満額は1日の直接作業を540分として数えます。＋30分/＋60分は定時に足した分だけで、満額の540分は超えません。"
        >
          {OVERTIME_EXTRA_CHOICES.map((c) => (
            <button
              key={c.key}
              type="button"
              disabled={!canEdit}
              title={c.hint}
              onClick={() => { if (typeof onOvertimeExtra === 'function') onOvertimeExtra(c.key); }}
              className={`min-h-[40px] rounded-lg border px-2.5 text-xs font-bold disabled:opacity-40 ${overtimeExtra === c.key
                ? (overtimeOn ? 'border-cyan-500 bg-cyan-50 text-cyan-700' : 'border-slate-400 bg-slate-100 text-slate-600')
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {c.label}
            </button>
          ))}
        </PickerRow>

        {/* ── 追記(2026-08-29 契約C3): 人の任せ替え ─────────────────────────────── */}
        <PickerRow
          label="人の任せ替え（シナリオ「人の任せ替え」で効きます）"
          note={swapNote}
        >
          <ArrowLeftRight className={`w-3.5 h-3.5 shrink-0 ${swapOn ? 'text-violet-600' : 'text-slate-300'}`} />
          <select
            className={SELECT_CLASS}
            disabled={!canEdit}
            value={swapFrom}
            onChange={(e) => { if (typeof onSwapFrom === 'function') onSwapFrom(e.target.value); }}
            aria-label="誰の仕事を"
          >
            <option value="">誰の仕事を（選んでいません）</option>
            {workerNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span className="text-2xs font-bold text-slate-500">→</span>
          <select
            className={SELECT_CLASS}
            disabled={!canEdit}
            value={swapTo}
            onChange={(e) => { if (typeof onSwapTo === 'function') onSwapTo(e.target.value); }}
            aria-label="誰に任せるか"
          >
            <option value="">誰に任せるか（選んでいません）</option>
            {workerNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </PickerRow>

        {/* ── 1品目コード=1人 と 2人でできる工程（🚨 ここだけは設定として保存する）───────── */}
        <div className="rounded-xl border border-violet-200 bg-violet-50/50 px-3 py-2.5 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-2xs font-black text-violet-800">人の付け方の決まりごと</span>
            <span className="ml-auto text-2xs text-slate-500">
              {saving ? '保存しています…' : 'ここだけは設定として残します'}
            </span>
          </div>

          {/* 🚨 保存の失敗を黙って飲み込まない。押したのに残っていない、が一番こわい。 */}
          {saveError ? (
            <div className="rounded-lg border border-rose-300 bg-rose-50 px-2 py-1.5 text-2xs text-rose-700">
              <b className="block">保存できませんでした</b>
              <span className="block mt-0.5 break-words">{saveError}</span>
            </div>
          ) : null}

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0"
              disabled={!canEdit}
              checked={!!soloMode}
              onChange={(e) => { if (typeof onSoloMode === 'function') onSoloMode(e.target.checked); }}
            />
            <span className="min-w-0">
              <span className="block text-2xs font-black text-slate-700">1つの品目コードは1人で</span>
              {soloMode ? (
                <span className="block mt-0.5 text-2xs font-bold leading-snug text-violet-700">
                  いま ON です。下の結果は、この決まりごとを入れて計算した物です。
                  ⚠ 見出し（守れる／守れない）は変わらない事があります。効くのは
                  「誰にいつ回すか」なので、変わるのは人の付き方と終わる時刻です。
                  実データで確かめた変化: 手が付いた件数 838件 → 841件。
                </span>
              ) : null}
              <span className="block mt-0.5 text-2xs leading-snug text-slate-500">
                🚨 意味は「<b>同じ品目コードを同時に2人が触らない</b>」です。
                「その品目コードは最初に触った人が最後まで全部持つ」ではありません。
                どちらを指しているか決まっていないので、いまは前者で計算します。
                違う場合は言ってください。
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-2xs font-black text-slate-700">2人でできる工程（複数選べます）</span>
            <span className="text-2xs leading-snug text-slate-500">
              🚨 選ぶと「その工程は2人を同時に押さえる」だけになります。
              <b>かかる時間は縮めません</b>（2人だと何倍早いかを測っていないので、
              勝手に縮めると測っていない数字を作る事になります）。
              もう1人の手が空いていない間は、その工程を始めません。
            </span>
            <select
              multiple
              size={Math.min(6, Math.max(3, processOptions.length))}
              className={`${SELECT_CLASS} w-full`}
              disabled={!canEdit || processOptions.length === 0}
              value={Array.isArray(twoPersonKeys) ? twoPersonKeys : []}
              onChange={(e) => {
                const picked = [...e.target.selectedOptions].map((o) => o.value);
                if (typeof onTwoPersonKeys === 'function') onTwoPersonKeys(picked);
              }}
              aria-label="2人でできる工程"
            >
              {processOptions.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            {processOptions.length === 0 ? (
              <span className="text-2xs text-slate-400">計算するとここに工程が出ます。</span>
            ) : null}
            {(Array.isArray(twoPersonKeys) ? twoPersonKeys.length : 0) === 0 ? (
              <span className="text-2xs text-slate-400">
                いまは1件も選んでいません。選ぶまでは、いままでと同じ計算です。
              </span>
            ) : null}
          </div>

          {/* 🏭 作業する区画(エリア)の定員。清水さん(2026-09-06)「作業している場所が被ってる人いたわ」。
              ⚠ 文字を増やさない: 名前・過去の最大・定員 の3列だけ。説明は1行。 */}
          <div className="flex flex-col gap-1" data-opsim-zone-cap={zoneRows.length}>
            <span className="text-2xs font-black text-slate-700">🏭 作業する場所（区画）の定員</span>
            <span className="text-2xs leading-snug text-slate-500">
              同じ区画に同時に立てる人数。空欄＝<b>過去の実測</b>（その区画で同時に居た最大人数）をそのまま使います。
            </span>
            {zoneRows.length === 0 ? (
              <span className="text-2xs text-slate-400">区画がまだありません（エリアマップで作ると出ます）。</span>
            ) : (
              <div className="max-h-44 overflow-y-auto rounded border border-slate-200">
                <table className="w-full text-2xs">
                  <thead className="sticky top-0 bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-1.5 py-1 text-left font-bold">区画</th>
                      <th className="px-1.5 py-1 text-right font-bold">過去の最大</th>
                      <th className="px-1.5 py-1 text-right font-bold">定員</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zoneRows.map((z) => (
                      <tr key={z.zoneId} className="border-t border-slate-100" data-opsim-zone-row={z.zoneId} title={z.note}>
                        <td className="px-1.5 py-0.5 text-slate-700">
                          {z.name}
                          <span className={`ml-1 rounded px-1 font-bold ${z.source === 'manual' ? 'bg-violet-100 text-violet-700' : z.source === 'observed' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                            {z.source === 'manual' ? '決めた' : z.source === 'observed' ? '実測' : '制限なし'}
                          </span>
                        </td>
                        <td className="px-1.5 py-0.5 text-right font-mono text-slate-500">
                          {z.observedMax == null ? '—' : `${z.observedMax}人`}
                          <span className="ml-1 text-slate-300">{z.segments > 0 ? `/${z.segments}回` : ''}</span>
                        </td>
                        <td className="px-1.5 py-0.5 text-right">
                          <input
                            type="number"
                            min="1"
                            className="w-14 rounded border border-slate-300 px-1 py-0.5 text-right"
                            disabled={!canEdit || typeof onZoneCap !== 'function'}
                            defaultValue={z.source === 'manual' ? String(z.cap) : ''}
                            placeholder={z.observedMax == null ? '—' : String(z.observedMax)}
                            data-opsim-zone-input={z.zoneId}
                            onBlur={(e) => {
                              if (typeof onZoneCap !== 'function') return;
                              const t = String(e.target.value || '').trim();
                              if (t === '') { onZoneCap(z.zoneId, null); return; }
                              const n = Number(t);
                              if (!Number.isInteger(n) || n < 1) {
                                window.alert('定員は1以上の整数で入れてください（空欄にすると過去の実測に戻ります）。');
                                e.target.value = z.source === 'manual' ? String(z.cap) : '';
                                return;
                              }
                              onZoneCap(z.zoneId, n);
                            }}
                            aria-label={`${z.name} の定員`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* 🎛 本物に近づける設定（2026-09-07）。区画の定員のすぐ下＝同じ並びに置く。
            🚨 8つとも既定 OFF。何も選ばない間は、この画面の他の数字が1つも変わらない。 */}
        <RealismBox
          canEdit={canEdit}
          rules={rules}
          onRule={onRule}
          open={realismOpen}
          onToggle={onRealismToggle}
          cfg={realism}
          onRealism={(patch) => { if (typeof onRealism === 'function') onRealism(patch); }}
          facts={realismFacts}
          equipRows={equipRows}
          onEquipCap={onEquipCap}
          handoff={handoff}
          onHandoff={onHandoff}
          lotFocus={lotFocus}
          onLotFocus={onLotFocus}
          priorityClass={priorityClass}
          onPriorityClass={onPriorityClass}
          templatePrefMode={templatePrefMode}
          onTemplatePrefMode={onTemplatePrefMode}
        />

        {!canEdit ? (
          <NoticeBar tone="slate" icon={Info}>
            仮定の入力は、ヘッダー左上で使用者を選ぶと使えます。この画面はどの場合も、データへ書き込みを1件もしません。
          </NoticeBar>
        ) : null}

        {stepHoursText ? (
          <div className="text-2xs leading-snug text-slate-500">{stepHoursText}</div>
        ) : null}
      </div>
    </CardBox>
  );
}

/** 根拠・データ監査（指示書3「主画面にしない」）。開いた時だけ中を作る。 */
function EvidenceCard({ open, onToggle, lots, templates, workers, innerRef }) {
  return (
    <div ref={innerRef} className="bg-white border border-slate-200 shadow-sm rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50"
      >
        {open ? <ChevronDown className="w-4 h-4 shrink-0 text-cyan-600" /> : <ChevronRight className="w-4 h-4 shrink-0 text-slate-400" />}
        <Search className="w-4 h-4 shrink-0 text-cyan-600" />
        <span className="min-w-0">
          <span className="block text-sm font-black leading-tight text-slate-800">根拠・データ監査</span>
          <span className="block mt-0.5 text-2xs leading-snug text-slate-500">
            この見立てが使っている「やった記録」を、工程ごとに数え直して見ます。開いて計算を押すまでは何も走りません。
          </span>
        </span>
      </button>
      {open ? (
        <div className="border-t border-slate-200 p-2.5">
          <SoloDependencyPanel lots={lots} templates={templates} workers={workers} />
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================
//  本体
// =============================================================================
// 📅 factoryCalendar = 工場の暦(祝日・年末年始・お盆・全社休業・休日出勤)。
// 🚨 清水さん(2026-09-01)「祝日表はいるね、これないと処理能力わからないからね」。
//   ⚠ settings ではなく共通の棚(contact-shared-v1)から来るので、別の prop で受ける。
//   🚨 登録が空(null)なら 月〜金 のまま = 今までと1ミリも同じ。
// 🚚 arrivalActuals / contactRequests は「① 入荷の遅れのクセ」の **実測を出す為だけ** に受ける。
//   🚨 既定 null ＝ 渡らない間は「まだ渡っていません」と正直に言うだけで、計算は1ミリも変わらない
//     （arrivalByLot は到着**予定**なので、遅れのクセ＝予定と実績のずれ はここからは出せない）。
function OperationsSimulationBody({ planShelf = null, publishOnly = false, isAdmin = false, readOverviewMap = null, lots, templates, workers, settings, saveSettings = null, canEdit, arrivalByLot = {}, factoryCalendar = null, otherAppWorkerNames = null, otherAppDailyLoad = null, ownDailyLoad = null, publishDailyLoad = null, capacityShelfLoaded = false, arrivalActuals = null, contactRequests = null, placementRules = null, savePlacementRule = null, onEditLot = null, onDeleteLot = null, onChangeLotPriority = null ,
  // 🚗 2026-09-12 清水さん「シュミレーション画面で各品目コードテンプレを触ったら、削除と編集画面出てくるようにしてほしい」
  //   🚨 消す式も編集の画面も、持っているのは App ただ1つ。ここは呼ぶだけ(書き写さない)。
  onEditModelTemplate = null, onRemoveModelTemplate = null, onRevertModelTemplate = null, modelTemplates = null}) {
  // 🚨 今の時刻はこの画面が開いている間ずっと同じ物を使う。毎描画で Date.now() を読むと
  //    入力が同じでも鍵が変わり、計算が終わらなくなる（同じ入力→同じ結果 も壊れる）。
  //    取り直すのは「もう一度計算」を押した時だけ(handleRerun)。
  //    🚨 2026-08-30 是正: 前は取り直す口がフックの中にもあり、押すと **向こうだけ** 動いて
  //      この画面の絞り込み・休みの日付と食い違っていた。時計の持ち主はこの1つに寄せた。
  const [panelNow, setPanelNow] = useState(() => Date.now());
  /**
   * 基準時刻の決め方（清水さんの指摘 2026-08-30 原文）:
   *   「夜に開くと全員が『勤務時間外』になります。計画用途なら、
   *     今から ／ 次の勤務開始から を切り替えられるようにすると、
   *     盤面がかなり理解しやすくなります」
   * 🚨 既定は 'now' ＝ 今までと1ミリも同じ挙動。押した時だけ動く。
   */
  const [baseMode, setBaseMode] = useState(BASE_TIME_MODE.NOW);
  /**
   * 実際に使う基準時刻。🚨 起点は必ず実時計(panelNow)。
   *   前の基準から進めると、押すたびに未来へ行ってしまう。
   * 🚨 この1つの値が「絞り込み・休みの日付・計算・盤の現在線」の全部の元になる。
   *   以前は画面(panelNow)と計算(フックの中の時計)で口が2つに分かれていた。
   */
  const baseInfo = useMemo(
    () => resolveBaseNow({ wallNowMs: panelNow, mode: baseMode, settings }),
    [panelNow, baseMode, settings],
  );
  // 🚨 下へ配るのは **数と真偽だけ**。入れ物ごと配ると、settings が同じ中身で
  //   作り直されるたびに入れ物が変わり、下の memo が無駄に走る。
  const baseNowMs = baseInfo.baseNowMs;
  const baseShifted = baseInfo.shifted;
  const baseResolved = baseInfo.resolved;

  const [scenarioKey, setScenarioKey] = useState('normal');
  // 🚨 初期の対象範囲は「手元＋14日」= soon。「手元だけ」= onhand へ戻さない。
  //    仕様書D24: 画面の初期範囲が『手元だけ』なのに、監査報告は『手元＋14日』で数えていた。
  //    同じ機能なのに件数が食い違い、どちらが本当か言えなくなる。
  //    根拠: docs/製品検査_操業シミュレーター_完全是正実装仕様書_2026-08-23.md 6.12 と T012。
  const [scopeKey, setScopeKey] = useState('soon');
  // 🚨 2026-08-23 仕様書5.2 / 6.12 / T005。
  //   以前は day=1..5 で「1日目＝いま」だった。そのため
  //   ・0日目が無く、いまの状態を 1 と呼ぶ
  //   ・5日目まで進めても 4日ぶんしか進まない（仕様書D05）
  //   → elapsedDays = 0.0〜5.0 にする。0.0 が「いま」、5.0 が 5×日能力を使い切った所。
  const [elapsedDays, setElapsedDays] = useState(0);
  /* ── 期間の切替（2026-09-04 決まり19A）─────────────────────────────────────
   * 🚨 「30日」という **届く日が言えない数字** をやめ、5営業日 / 今月 / 来月 の3つにした。
   *   根（前の担当の実測）: 「30日」は 10/16 までしか届かない。今月末=18営業日、来月末=40営業日。
   *   月末に立つ納期の山が線の外へ落ち、画面に1件も出ていなかった。
   *
   * 🚨🚨 **案C を既定にする**（親の指示2）。
   *   月を選んだ直後は割付を回さない（＝軽い方 OPSIM_LIGHT_DAYS 営業日のまま回す）。
   *   月ごとの人日・誰も持てない工程は、いま回っている結果の monthly から出る
   *   （実測: monthly の中身は 5日/18日/40日 で **同じ**。違うのは
   *     provisionalDays と noDataDays の分け方だけで、その2つの足し算は同じ。
   *     つまり月の答えを出すのに月ぶんの割付は要らない）。
   *   「この期間で 誰がどのロットをいつ」まで見たい時だけ、押して重い方を回す（案A）。
   * ⚠ 押す前は「まだ計算していません」と正直に出す。**空の盤を出さない**。
   *   estimateMode … P50(通常線) / P75(保険線) / P90(絶対線)。
   *     ⚠ どれを変えても **入力の指紋が変わる** ＝ 前の結果とは比べられない。 */
  const [rangeKey, setRangeKey] = useState('d5');
  /** 期間を切り替えてから盤が出るまでの秒数(measure した値だけ。見積りを作らない)。決まり26 で札に出す。 */
  const [fullRunSeconds, setFullRunSeconds] = useState(null);
  const fullRunStartedRef = useRef(0);
  const [estimateMode, setEstimateMode] = useState('P75');
  const [playing, setPlaying] = useState(false);            // 🚨 初期状態は止める（指示書6.5）
  const [sortMode, setSortMode] = useState('due');          // 'due' | 'risk'（納期がやばい順）
  /**
   * 🚨 並び順は **再生を始めた時に1回だけ** 決めて、再生中は動かさない（2026-08-24）。
   *   時間を進めるたびに行が入れ替わると、カードが動いたのか行が動いたのか人が判別できない。
   *   「最初へ戻す」と「つまみを 0.0（いま）へ戻す」で解ける。止めただけでは解かない
   *   （止めて見比べている最中に行が飛ぶ方が読めなくなる）。
   */
  const [frozenLaneOrder, setFrozenLaneOrder] = useState(null);
  /**
   * 時間の進み方（2026-08-30 清水さんの要望3）。**刻みと速さを別々に覚える**。
   * 🚨 既定は旧「ふつう」と1ミリも同じ（0.3日ずつ・0.9秒ごと）＝開いた瞬間の見え方は変わらない。
   * ⚠ この2つは「この端末で今どう見たいか」だけ。ロットにも設定にも1バイトも書かない。
   */
  const [playStep, setPlayStep] = useState(OPSIM_STEP_DEFAULT);
  const [playMs, setPlayMs] = useState(OPSIM_PLAY_MS_DEFAULT);
  /**
   * 🚨 仮に置く入荷日（2026-08-24 清水さん「入荷時間ないからほとんど動かなかった。
   *   8/24分以降でないものは とりあえず 納期の2日前に設定してくれない。とりあえずね」）
   *   0 = 置かない（実データだけ）。2 = 納期の2日前として仮に置く。
   * 🚨🚨 既定は **2＝仮に置く**（2026-08-31 清水さん「シミュレーションで入庫日時間がないから
   *   計算できないって言われた。俺これにならないように仮の日を入れるって言ったの覚えてないの？
   *   とりあえず仮日入れないとなんもできないのわからないの？」）。
   *   8/25(00fcc05)は既定0＝ボタンを押した時だけ効く形にしたので、清水さんから見れば
   *   「作っていない」のと同じだった。開いた直後から仮置きで計算が回る事。
   * ⚠ この値は端末に保存していない（localStorage 等の「覚え」は無い。実コードを grep して確認済み）。
   *   画面を開くたびこの既定で始まるので、古い0が端末に残って上書きが要る、という事は起きない。
   * ⚠ **仮定**。元のデータには1文字も書き戻さない。画面で必ず「仮に置いた」と言う
   *   （常設の帯 AssumedArrivalStrip・カードの「仮」印・条件・根拠タブのボタン）。
   */
  const [assumeArrivalDays, setAssumeArrivalDays] = useState(2);
  /** 盤の見せ方。'board'=納期線へ / 'workers'=人が主役 / 'calendar'=納期カレンダー */
  const [viewMode, setViewMode] = useState('calendar');
  const [selectedLotId, setSelectedLotId] = useState(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  /**
   * T027「一覧を開く導線」。件数を押した時に、どのロットかを出す。
   * 🚨 押せない数字は確かめようがない。中身は engine が返したロットIDの一覧をそのまま使う
   *   （画面でもう一度数え直さない。数え直すと2つの数がズレる）。
   */
  const [listReq, setListReq] = useState(null);
  // 旧 compact / boardOnly(「詰めて表示」「大画面」)は 2026-08-30 の画面4分割で撤去(清水さんの指示)。
  //   盤面タブ(opsimTab==='board'。宣言は既存hooksの後ろ)が旧・大画面相当の見た目を担う。
  //   (2026-08-24 の実測「1920×1080で画面の67%が盤の外」への答えは盤面タブに引き継がれた)
  /** 盤面タブの盤の高さ。窓の高さから、残す帯のぶんを引く。 */
  const [winH, setWinH] = useState(() => (typeof window === 'undefined' ? 1080 : window.innerHeight));
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setWinH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const [absenceName, setAbsenceName] = useState('');
  const [absenceDays, setAbsenceDays] = useState(1);
  const [ojtName, setOjtName] = useState('');
  const [ojtProcess, setOjtProcess] = useState('');

  // ── 追記(2026-08-29 契約C2/C3) ────────────────────────────────────────────
  //   ⚠ 既存の hooks の並びは1つも動かしていない(ここへ**追加**しただけ)。
  //   下の scenario の useMemo がこれらを読むので、宣言はそれより上に要る
  //   (後ろに置くと宣言前参照でその場で落ちる)。
  /** 残業の量。'full'=満額540分(従来どおり・既定) / '30' / '60'。 */
  const [overtimeExtra, setOvertimeExtra] = useState('full');
  /** 人の任せ替え。誰の仕事を(swapFrom) → 誰に任せるか(swapTo)。 */
  const [swapFrom, setSwapFrom] = useState('');
  const [swapTo, setSwapTo] = useState('');
  /**
   * 「同じ土俵の通常」の割付から作った任せ替えの材料。
   *   {key: groundKey, sig: 変更検知の文字列, byWorker: Map(作業者名→Set(processKey))} | null
   * 🚨 書くのは下の保管庫の effect ただ1箇所。土俵が変わったら null に戻す。
   * ⚠ state で持つのは、scenario の useMemo(下)がこの値で作り直される必要があるため
   *   (scenarioStoreRef は宣言がもっと後ろに居るので、ここから読むと宣言前参照で落ちる)。
   */
  const [swapSource, setSwapSource] = useState(null);

  /** 任せ替えの支度が揃っているか。揃うまでは何も渡さない(=通常と同じ計算)。 */
  const swapPlan = useMemo(() => {
    const from = typeof swapFrom === 'string' ? swapFrom.trim() : '';
    const to = typeof swapTo === 'string' ? swapTo.trim() : '';
    const idle = { ready: false, from, to, processKeys: [] };
    if (!from || !to) {
      return { ...idle, reason: '「誰の仕事を」「誰に任せるか」の両方を選んでください（選ぶまでは通常と同じ計算です）' };
    }
    if (from === to) {
      return { ...idle, reason: '同じ人への任せ替えは計算しません。別の人を選んでください' };
    }
    const byWorker = (swapSource && swapSource.byWorker) || null;
    if (!byWorker) {
      return { ...idle, reason: '先に「通常」を一度計算してください（いつも通りの割付から、任せ替える工程を拾います）' };
    }
    const set = byWorker.get(from);
    const keys = set ? [...set].sort() : [];
    if (!keys.length) {
      return { ...idle, reason: `いつも通りの割付では ${from} さんに付いた仕事が見つかりません（任せ替える工程がありません）` };
    }
    return { ready: true, reason: null, from, to, processKeys: keys };
  }, [swapFrom, swapTo, swapSource]);

  const evidenceRef = useRef(null);

  const lotList = useMemo(() => (Array.isArray(lots) ? lots : []), [lots]);

  /**
   * 急ぎ(lot.priority === 'high')のロットID。
   * 🚨 空でも壊れない事。空の時は画面に「急ぎ 0件」と正直に出す
   *   （0件を隠すと『急ぎが効いている』と読まれる）。
   * ⚠ priority は normalized にも snapshot にも入っていないので、生の lots から作る。
   */
  const highPriorityLotIds = useMemo(() => {
    const set = new Set();
    lotList.forEach((l) => {
      const id = l == null ? '' : String(l.id ?? l.__id ?? '');
      if (id && String(l.priority || 'normal') === 'high') set.add(id);
    });
    return set;
  }, [lotList]);
  const templateList = useMemo(() => (Array.isArray(templates) ? templates : []), [templates]);
  const workerList = useMemo(() => (Array.isArray(workers) ? workers : []), [workers]);

  const workerNames = useMemo(() => {
    const set = new Set();
    workerList.forEach((w) => {
      const n = (w && typeof w.name === 'string') ? w.name.trim() : '';
      if (n) set.add(n);
    });
    return [...set].sort();
  }, [workerList]);

  /**
   * 📅 「その日工場が動くか」を **この画面では1本だけ** 持つ。
   * 🚨 休みのシナリオ(誰か休み・任せ替え)は、祝日に「休んだ事にする」と空振りになる。
   *   「5日休む」と言いながら実際には3日分しか効かないシナリオになるので、ここで引く。
   * ⚠ 登録が空なら 月〜金 = 今までと同じ日付が選ばれる。
   */
  const worksOnDay = useMemo(() => fcalMakeIsWorkday(factoryCalendar), [factoryCalendar]);

  /* ── 期間（決まり19A）。日数は **工場の暦で数えた営業日**。─────────────────
   * 🚨 ここが「今月＝何営業日か」を決める唯一の口。
   *   数え方は normalizeInput.addWorkdays と同じ（horizonRange.js に理由を書いた）。
   *   ⚠ 見張り(verify-opsim-horizon.mjs)が、本物の normalizeInput を通した horizonEnd と
   *     この endMs が同じ日を指す事を確かめる（画面と計算で別の日を指さない）。 */
  const rangeInfo = useMemo(
    () => opsimRangeDays({ rangeKey, baseNowMs, worksOnDay }),
    [rangeKey, baseNowMs, worksOnDay],
  );
  /**
   * 🚨 エンジンへ渡す営業日の数。**案C が既定**。
   *   ・5営業日 … そのまま5
   *   ・今月/来月 … 押すまでは軽い方(OPSIM_LIGHT_DAYS)。押したら月ぶん。
   *   ⚠ 期間が空(その月に営業日が残っていない)の時も軽い方で回す。0日で回すと盤が空になる。
   */
  // 🚨 2026-09-05 決まり26(清水さん「今月指定したのに納期一覧とロットの流れが5日間だけ。何のために今月ってあるの？」):
  //   案C(月では割付を回さず、押した時だけ回す)は **撤回**。今月/来月を押したら盤面3つとも その月で回す。
  //   「重いから軽く」は私の都合で、清水さんの「盤面で月毎分出てればいい」を読み替えていた。秒数は札に出す。
  //   ⚠ その月に営業日が残っていない時だけ 5営業日で回し、その事を札(PeriodRunNote)で言う。
  const horizonDays = rangeInfo.days > 0 ? Math.max(1, rangeInfo.days) : HORIZON_DAYS;
  /** 月を選び直したら「まだ計算していません」へ戻す（前の月ぶんの盤を別の月の名前で出さない）。 */
  const handleRange = useCallback((k) => {
    setRangeKey(k);
    fullRunStartedRef.current = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    setElapsedDays(0);
    setPlaying(false);
    setFrozenLaneOrder(null);
  }, []);

  // ── 🏭 作業する区画(エリア)の定員 ────────────────────────────────────────
  // 清水さん(2026-09-06)「作業している場所が被ってる人いたわ。過去データからそこも意識するように」。
  // 過去の実測(同時に居た最大人数)を既定にし、人が決めた数が在ればそれが勝つ。
  // ⚠ 数えるのは **全ロットの完了した作業**(範囲で絞らない)。区画の広さは期間で変わらないので、
  //   絞ると「その期間に使わなかった区画」の定員が消えてしまう。
  const observedZones = useMemo(() => observedZoneConcurrency(lots || []), [lots]);
  const zoneList = useMemo(() => (Array.isArray(settings?.mapZones) ? settings.mapZones : []), [settings]);
  // ⚠⚠ 定員は **並び(配列)** で持つ: settings.opsim.zoneCapacity = [{ zoneId, cap }, ...]。
  //   表({id:n})にすると merge:true では1件消しても消えない(2026-07-26 の穴)。配列なら丸ごと置き換わる。
  //   読む時は表に直す(古い表の形で保存されていても読めるようにしておく)。
  const zoneManual = useMemo(() => {
    const raw = (settings && settings.opsim && settings.opsim.zoneCapacity) || null;
    if (!raw) return null;
    if (Array.isArray(raw)) {
      const m = {};
      for (const e of raw) { const id = String(e && e.zoneId || '').trim(); const n = Number(e && e.cap); if (id && Number.isInteger(n) && n >= 1) m[id] = n; }
      return m;
    }
    return (typeof raw === 'object') ? raw : null;
  }, [settings]);
  const zoneRows = useMemo(
    () => zoneCapacityRows({ zones: zoneList, manual: zoneManual, observed: observedZones }),
    [zoneList, zoneManual, observedZones],
  );
  const zoneCapForSim = useMemo(
    () => zoneCapacityMap({ zones: zoneList, manual: zoneManual, observed: observedZones }),
    [zoneList, zoneManual, observedZones],
  );
  const zoneNamesForSim = useMemo(() => {
    const m = {};
    for (const z of zoneList) { const id = String(z && z.id || '').trim(); if (id) m[id] = String(z.name || id); }
    return m;
  }, [zoneList]);
  // 👤 個人設定の「このテンプレを優先」。settings.workerProfiles[名前].templatePrefs = [テンプレid...]
  //   ⚠ 順番だけに効く(できる/できないは変えない)。空なら渡さない＝いままでと同じ計算。
  const tplPrefsForSim = useMemo(() => {
    const table = (settings && settings.workerProfiles && typeof settings.workerProfiles === 'object') ? settings.workerProfiles : {};
    const out = {};
    for (const [name, p] of Object.entries(table)) {
      const ids = Array.isArray(p && p.templatePrefs) ? p.templatePrefs.map((x) => String(x || '').trim()).filter(Boolean) : [];
      if (ids.length) out[String(name)] = ids;
    }
    return out;
  }, [settings]);

  // ── 🎛 本物に近づける設定（2026-09-07 清水さん「実際の生産に近い状態でシミュレーションしたい」）──
  // 🚨🚨 8つとも既定 OFF。何も選ばない間は realismForSim も equipCapForSim も null＝
  //   scenario は 1バイトも増えない＝ シミュの答えは1ミリも変わらない。
  // 🚨 実測の数字は **開いた時だけ** 数える。閉じている間は重い走査を1本も走らせない。
  const [realismOpen, setRealismOpen] = useState(false);
  const realismCfg = useMemo(() => readOpsimRealism(settings), [settings]);

  /**
   * ── 👥 分担の区切り（2026-09-10 清水さん「後分担するときはできたら一台毎で区切る感じじゃないと
   *    だめだからね、区切りの良いところで分担ならOKね」「こういう設定もいるからね」）──
   *
   * 🚨 8つの 🎛 と違って、これは **既定でも効く**（既定 'unit'＝清水さんの指定）。
   *   エンジン(handoff.js)の既定は 'none'＝渡されなければ1行も動かないので、
   *   「1台は同じ人が最後まで」で走らせているのは **この画面が渡しているから**。
   * 🚨 黙って既定を効かせない: まだ誰も選んでいない時は registered:false になり、
   *   札の横と ⚙(条件・根拠)の1行に「既定（清水さんの指定）」が出る。
   * ⚠ 読み方は readOpsimHandoff ただ1本。この画面で既定の字を書かない。
   */
  const handoffCfg = useMemo(() => readOpsimHandoff(settings), [settings]);

  /**
   * ── 🧵 ロットは持ったら最後まで ／ 🚩 優先度の区分を割付の先頭に（2026-09-10 23:30 清水さん）──
   *
   * 🚨 既定は2つとも ON(清水さんの指定)。エンジンは scenario.lotFocus / scenario.priorityClass が
   *   無ければ1行も動かないので、既定で効いているのは **この画面が渡しているから**。
   * 🚨 OFF の時は鍵ごと渡さない(lotFocusScenarioOf が null か、その鍵を持たない物を返す)。
   * ⚠ 読み方は realism.js の readOpsimLotFocus / readOpsimPriorityClass ただ1本(ここで既定を書かない)。
   */
  const lotFocusCfg = useMemo(() => readOpsimLotFocus(settings), [settings]);
  // 👤 2026-09-17 「このテンプレを優先」の強さ。'reserve' の時だけ scenario に載る。
  const tplPrefModeCfg = useMemo(() => readOpsimTemplatePrefMode(settings), [settings]);
  const priorityClassCfg = useMemo(() => readOpsimPriorityClass(settings), [settings]);
  const focusForSim = useMemo(() => lotFocusScenarioOf(settings), [settings]);
  // ⚙ 2026-09-22 割付の決まり(opsimRules)。既定のままなら null(=今までの計算と同じ)
  const rulesCfg = useMemo(() => readOpsimRules(settings), [settings]);
  const rulesForSim = useMemo(() => rulesScenarioOf(settings), [settings]);
  // ✅ 並列作業ラボで「採用」した条件だけ本番の割付へ(採用が無い/戻した/適用前なら null=今までと1バイトも同じ)
  const adoptedParallelLab = useMemo(() => adoptedScenarioOf({ settings, lots: lotList, nowMs: baseNowMs }), [settings, lotList, baseNowMs]);
  // 🚶 掛け持ちの切り替え(2026-09-26)。off=鍵を出さない(今までどおり)。on=入力(自動工程・片道)を自動で組んで parallelLab に載せる(採用より後=切り替えが勝つ)
  const jugglingMode = readJugglingMode(settings);
  const jugglingBuilt = useMemo(() => jugglingScenarioOf({ settings, lots: lotList, zones: settings?.mapZones || [] }), [settings, lotList]);
  const jugglingScenario = jugglingMode === 'on' ? jugglingBuilt.scenario : null;
  // 📦 仮の入荷日は画面の口(assumeArrivalDays)が前から在る。設定を登録したら その値を画面の口の初期値にする
  useEffect(() => { if (rulesCfg.assumeArrivalDays.registered) setAssumeArrivalDays(Number(rulesCfg.assumeArrivalDays.value) || 0); }, [rulesCfg]);
  // 🕒 納期対応の残業・土曜(必要分)(2026-09-16)。「これでいく」を押した案(adopted:true)だけ scenario へ。
  //   🚨 それ以外は null = scenario に鍵が載らない = 今までの計算と1ミリも変わらない。
  //   ⚠ 写し方は overtimePlan.js の scenarioOfOvertimePlan ただ1本(ここで日×人の表を作り直さない)。
  const overtimePlanCfg = useMemo(() => ((settings && settings.opsim && settings.opsim.overtimePlan) || null), [settings]);
  const overtimePlanForSim = useMemo(() => scenarioOfOvertimePlan(overtimePlanCfg), [overtimePlanCfg]);

  /**
   * 📊 実績の表(6つ)。**作るのは realism.js の buildRealismTable ただ1か所**。
   *   ・「使う」を選んだ物は計算に要るので、箱が閉じていても作る(scenario へ載せる)。
   *   ・箱を開けている間は、表示の1行の為に全部作る。
   *   ・どちらでもない物は **null**(重い走査を走らせない・scenario に載せない)。
   * 🚨 表は **全ロット**(lotList。完了込み)から作る。実績は完了ロットから出る。
   * ⚠ 1つずつ別の memo にしてある: 「修正率」を切り替えただけで「人ごとの速さ」(163ms)まで
   *   数え直さない為。lots が変わった時は要る物だけ数え直す。
   */
  const wantHabitTable = realismOpen || realismTableWanted(realismCfg, 'arrivalHabit');
  const habitTable = useMemo(
    () => (wantHabitTable ? buildRealismTable('arrivalHabit', { arrivalActuals, contactRequests }) : null),
    [wantHabitTable, arrivalActuals, contactRequests],
  );
  const wantSplitTable = realismOpen || realismTableWanted(realismCfg, 'splitArrival');
  const splitTable = useMemo(
    () => (wantSplitTable ? buildRealismTable('splitArrival', { lots: lotList, arrivalByLot, lotIdOf: idOf }) : null),
    [wantSplitTable, lotList, arrivalByLot],
  );
  const wantReworkTable = realismOpen || realismTableWanted(realismCfg, 'reworkRates');
  const reworkTable = useMemo(
    () => (wantReworkTable ? buildRealismTable('reworkRates', { lots: lotList }) : null),
    [wantReworkTable, lotList],
  );
  const wantInterruptionTable = realismOpen || realismTableWanted(realismCfg, 'interruptionRates');
  const interruptionTable = useMemo(
    () => (wantInterruptionTable ? buildRealismTable('interruptionRates', { lots: lotList }) : null),
    [wantInterruptionTable, lotList],
  );
  const wantSpeedTable = realismOpen || realismTableWanted(realismCfg, 'workerSpeed');
  const speedTable = useMemo(
    () => (wantSpeedTable ? buildRealismTable('workerSpeed', { lots: lotList }) : null),
    [wantSpeedTable, lotList],
  );
  const wantSetupTable = realismOpen || realismTableWanted(realismCfg, 'setupChange');
  const setupTable = useMemo(
    () => (wantSetupTable ? buildRealismTable('setupChange', { lots: lotList }) : null),
    [wantSetupTable, lotList],
  );
  /** 表を scenario の鍵の名前で束ねた物(realismScenarioOf が ON の物だけ拾う)。 */
  const realismTables = useMemo(() => ({
    arrivalHabit: habitTable,
    splitArrival: splitTable,
    reworkRates: reworkTable,
    interruptionRates: interruptionTable,
    workerSpeed: speedTable,
    setupChange: setupTable,
  }), [habitTable, splitTable, reworkTable, interruptionTable, speedTable, setupTable]);
  /**
   * scenario へ足す物 = 合図 + **合図が ON の表**(2026-09-10 ChatGPT の②: 前は合図だけで表が Worker へ届かず、
   *   「使う」を押しても simulate.js が1秒も足していなかった)。
   * 🚨🚨 8つとも OFF なら null = scenario は1バイトも増えない。
   */
  const realismForSim = useMemo(
    () => realismScenarioOf({ cfg: realismCfg, tables: realismTables }),
    [realismCfg, realismTables],
  );
  /**
   * 👤 曜日ごとの窓／有給・出張・会議 を暦に効かせる合図(2026-09-10 ChatGPT の①: 誰も渡していなかった)。
   * 🚨 合図の設定は無い。**登録が合図**: 作業者マスタの個人設定に 曜日ごとの窓 か 休みの日 を
   *   登録した人が名簿に1人でも居れば { workerAvailabilityOn: true }。登録が無ければ null(今までと同じ)。
   */
  const availForSim = useMemo(
    () => workerAvailabilityScenarioOf(settings, { rosterNames: workerNames }),
    [settings, workerNames],
  );

  /**
   * 🔧 設備の取り合い。⚠ 「使わない」の間は **一度も** 走らせない（箱を開けた時だけ下見する）。
   *   useObserved は選んだ物をそのまま渡す（'observed' の時だけ実測を上限にする）。
   */
  const equipInfo = useMemo(() => {
    if (!realismOpen && realismCfg.equipment === 'off') return null;
    return buildEquipmentCapacity({
      lots: lotList, templates: templateList, settings,
      now: baseNowMs, useObserved: wantsObservedEquipment(realismCfg),
    });
  }, [realismOpen, realismCfg, lotList, templateList, settings, baseNowMs]);
  /** 🚨 「使わない」なら必ず null。箱を開けただけで計算が変わってはいけない。 */
  const equipCapForSim = useMemo(() => {
    if (realismCfg.equipment === 'off') return null;
    const cap = equipInfo && equipInfo.capacity;
    if (!(cap && Object.keys(cap).length)) return null;
    // 🚨🚨 2026-09-10 確かめ役が本番の写し(画面と同じ経路)で見つけた穴: ここは前まで **素の表 {設備id: 台数}** を渡していた。
    //   エンジン(normalizeInput.js / simulate.js)は scenario.equipmentCapacity を
    //   **buildEquipmentCapacity の戻りの形 { capacity, stepEquipment }** で読む(scenario の鍵の約束)。
    //   素の表を渡すと src.capacity が無いので門は1件もかからず、「手で入れる 1台」を押しても
    //   同じ測定機の仕事が同時に4件始まっていた(写しで実測: 重なり30対 / realism.equipment.on=false)。
    //   → 形をエンジンの約束に揃える。stepEquipment(工程の鍵 → 設備id)も一緒に渡す。
    return { capacity: cap, stepEquipment: (equipInfo && equipInfo.stepEquipment) || {} };
  }, [realismCfg.equipment, equipInfo]);
  const equipNamesForSim = useMemo(() => {
    if (!equipCapForSim || !equipInfo) return null;
    const m = {};
    for (const e of (equipInfo.equipments || [])) { if (e && e.id) m[e.id] = e.name; }
    return m;
  }, [equipCapForSim, equipInfo]);
  const equipRows = useMemo(() => ((equipInfo && equipInfo.rows) || []), [equipInfo]);

  /**
   * 素の実測の1行（8つぶん）。
   * 🚨 数字は **全部 純関数の戻り値から** 作る。この画面で数え直さない。
   * 🚨 「この設定を入れると◯%延びる」ではなく、過去がどうだったかだけを言う。
   *
   * ── 本番の写しで実測（2026-09-10_0100 の控え・ロット603件・検査表34件）──────────
   *   箱を開けた時に1回だけ走る合計 …… 約 0.62秒
   *     ② 設備 63ms ／ ⑤ 修正 148ms ／ ⑥ 中断 78ms ／ ⑦ 人ごとの速さ 163ms ／
   *     ⑧ 段取り替え 162ms ／ ①③④ は合わせて 8ms
   *   ⚠ 開けた後は memo が覚えるので押すたびには走らない。閉じている間は1本も走らない。
   *   出た1行（そのまま画面に出る物）:
   *     ① 組立 高木班 n=6・中央値0分 ／ 組立 南班 n=2・中央値0分
   *        🚨 8件とも「予定どおり」の押し方で入っているので、使うにしても1件も動かない
   *     ② 設備 1種（測定機）。同時 最大3台（1823回の作業から）
   *     ③ 2便以上に分かれているロット 0件 / 603件
   *     ④ 出荷日が入っているロット 0件 / 603件
   *     ⑤ 修正のあったタスク 4.0%（279件 / 7022件）・中央値 6.5分
   *     ⑥ 中断のあったタスク 0.3%（18件 / 7022件）・中央値 33.5分
   *     ⑦ 記録が足りている 人×工程 105組 / 見えている 309組
   *     ⑧ 品目コードが変わった初回 535件・続き 2549件。余計にかかった中央値 0.4分
   */
  const realismFacts = useMemo(() => {
    if (!realismOpen) return null;
    const out = {};

    // 🚨 8つとも、数字は上の表(habitTable …。realism.js の buildRealismTable が作った物)から読むだけ。
    //   ここで buildXxx を呼び直さない(計算に渡る表と、画面に出る数字が別の物になる)。
    // ① 入荷の遅れのクセ
    if (!habitTable) {
      out.arrivalHabit = '到着した時刻の記録が、この画面にまだ渡っていません（渡ると班ごとの実測がここに出ます）。';
    } else {
      const habit = habitTable.habit;
      const rows = arrivalHabitRows(habit, HABIT_MODE.MEDIAN);
      out.arrivalHabit = rows.length
        ? `班ごとの実測 ${rows.slice(0, 3).map((r) => `${r.group} n=${r.n}・中央値${r.medianMin == null ? '—' : r.medianMin}分`).join(' / ')}`
          + (rows.length > 3 ? ` ほか${rows.length - 3}班` : '')
        : (habit.warnings[0] || `対になった記録 ${habit.pairs}件`);
    }

    // ② 設備の取り合い
    if (!equipInfo) {
      out.equipment = '設備の記録をまだ下見していません。';
    } else {
      const withObs = equipRows.filter((r) => r.observedMax != null);
      const top = withObs[0] || null;
      out.equipment = withObs.length
        ? `設備 ${equipRows.length}種のうち、過去の記録が採れたのは ${withObs.length}種。`
          + `いちばん多い ${top.name} は 同時 ${top.observedMax}台（${top.segments}回の作業から）`
        : ((equipInfo.warnings[0] && equipInfo.warnings[0].text) || `設備 ${equipRows.length}種。過去の記録がありません。`);
    }

    // ③ 分納を分けて積む
    {
      // 表(splitTable.byLot)には 2便以上のロットだけが載っている。便の数だけ、その表のロットで数える。
      const byLot = (splitTable && splitTable.byLot) || {};
      const split = Object.keys(byLot).length;
      let chunks = 0;
      for (const lot of lotList) {
        const arrival = byLot[idOf(lot)];
        if (arrival) chunks += splitArrivalLoad({ lot, arrival }).chunks.length;
      }
      out.splitArrival = split > 0
        ? `2便以上に分かれているロット ${split}件 / ${lotList.length}件（便は合わせて ${chunks}件）`
        : `2便以上に分かれているロットは 0件 / ${lotList.length}件（分納の記録が入るまで、いままでどおり1回で全台が着く形です）`;
    }

    // ④ 出荷日から逆算した締切
    {
      const withShip = lotList.filter((lot) => shipYMDOfLot(lot)).length;
      out.shipDeadline = withShip > 0
        ? `出荷日が入っているロット ${withShip}件 / ${lotList.length}件`
        : `出荷日はまだ 0件 / ${lotList.length}件（使うにしても、締切はいままでどおり検査の予定日のままです）`;
    }

    // ⑤ 修正（やり直し）の発生率
    {
      const rates = reworkTable || { all: null, warnings: [] };
      const a = rates.all || {};
      out.rework = a.n > 0
        ? `修正のあったタスク ${(a.rate * 100).toFixed(1)}%（${a.hit}件 / ${a.n}件）`
          + (a.medianSec == null ? '' : `・1件あたり 中央値 ${(a.medianSec / 60).toFixed(1)}分`)
        : ((rates.warnings[0] && rates.warnings[0].text) || '修正の記録がありません。');
    }

    // ⑥ 中断（部品待ち・不良対応）
    {
      const rates = interruptionTable || { all: null, warnings: [] };
      const a = rates.all || {};
      out.interruption = a.n > 0
        ? `中断のあったタスク ${(a.rate * 100).toFixed(1)}%（${a.hit}件 / ${a.n}件）`
          + (a.medianSec == null ? '' : `・1回あたり 中央値 ${(a.medianSec / 60).toFixed(1)}分`)
        : ((rates.warnings[0] && rates.warnings[0].text) || '中断の記録がありません。');
    }

    // ⑦ 人ごとの速さ
    {
      const speed = speedTable || { byWorkerStep: {}, byWorker: {}, warnings: [], clamp: [] };
      const rows = workerSpeedRows(speed);
      const enough = rows.filter((r) => r.enough).length;
      out.workerSpeed = rows.length
        ? `記録が足りている 人×工程 ${enough}組 / 見えている ${rows.length}組（掛ける倍率は ${clampLabel(speed.clamp)} の間に収めます）`
        : ((speed.warnings && speed.warnings[0]) || '人ごとの速さを出せる記録がありません。');
    }

    // ⑧ 段取り替え
    {
      const setup = setupTable || { all: null, warnings: [] };
      const a = setup.all || {};
      out.setupChange = a.n > 0
        ? `品目コードが変わった初回 ${a.n}件・同じ品目コードの続き ${a.baseN}件。`
          + `余計にかかった中央値 ${((Number(a.extraSecMedian) || 0) / 60).toFixed(1)}分`
          + (Number.isFinite(a.extraOverMixedSec) ? `（いまの目標時間へ足すのは ${(a.extraOverMixedSec / 60).toFixed(1)}分）` : '')
        : (a.why || (setup.warnings && setup.warnings[0]) || '段取り替えを数えられる記録がありません。');
    }

    return out;
  }, [realismOpen, lotList, equipInfo, equipRows,
    habitTable, splitTable, reworkTable, interruptionTable, speedTable, setupTable]);

  // ── シナリオ（エンジンへそのまま渡す）────────────────────────────────────
  // ⚠ 入れ物は毎描画で作り直されるが、useOperationsSimulation は **中身** で鍵を作るので
  //   中身が同じなら計算はやり直されない。
  // ── 📦 2026-09-12 決めた配置(両方の工場で働ける人を どの日どちらに置くか) ──────────
  //   清水さん「この配置で引き直すしても、盤とかのシュミレーション変化してないよ」
  //   🚨 置き場は 自分の書類(daily_load)の1欄 placement。相手の書類にも同じ欄が在るので、
  //     **新しい方**(decidedAt)を効かせる(pickPlacement)。読むのは開いた時に1回(親が読む)。
  const [decidedPlacement, setDecidedPlacement] = useState(null);
  const seededPlacementRef = useRef(false);
  useEffect(() => {
    if (seededPlacementRef.current) return;
    // 🚨 2026-09-17: 前は「2件とも null なら まだ届いていない」で判定していた。
    //   棚が本当に空(1件も無い)の時と見分けが付かず、読み終える前に読み戻しを諦めていた。
    //   棚を読み終えた印(capacityShelfLoaded)ただ1つで待つ。
    if (!capacityShelfLoaded) return;                                   // まだ届いていない
    seededPlacementRef.current = true;
    const found = pickPlacement({ hereDoc: ownDailyLoad, thereDoc: otherAppDailyLoad });
    if (found) setDecidedPlacement(found);
  }, [ownDailyLoad, otherAppDailyLoad, capacityShelfLoaded]);
  // 決めた配置 + 📅 曜日の配置(毎週・共有棚) → この工場の休み。効くのは その人が **相手の工場に居る日** だけ。
  //   2026-09-14 清水さん「両方作業できる作業者を曜日毎で指定したのに、シュミレーションでは全く適用していなかった」
  //   展開する日々は 計算の基準日から暦で(営業日数×7/5+7)日。仕事の無い日は盤が使わないだけ。
  //   🚨 resultDays は この行より後ろで定義される(TDZ)。ここでは horizonDays だけを使う。
  const placementYmds = useMemo(() => ymdsFrom({ fromMs: baseNowMs, days: Math.min(62, Math.ceil(((horizonDays || 5) * 7) / 5) + 7) }), [baseNowMs, horizonDays]);
  const placementAbsences = useMemo(
    () => composeAbsences({ rules: placementRules, decided: decidedPlacement, ymds: placementYmds, app: 'parts' }),
    [placementRules, decidedPlacement, placementYmds],
  );

  // 📌 2026-09-15 手で決めた担当(settings.opsim.pins・並び)。表に直して scenario へ載せる(runKey が変わり盤が引き直る)。
  const pinsCfg = useMemo(() => pinsMapOf(settings && settings.opsim && settings.opsim.pins), [settings]);
  /* 🧷 2026-09-18 案A 5-2「決めた物は固定が既定」
     清水さん「配置ボタンしたら、次開いたら忘れてることある」＝答えが揺れる。
     既定 ON。ON の時だけ 現場で手が付いたロットを **記録の実際の担当** のままにする。
     🚨 手で決めた固定(pinsCfg)の方が強い(後から重ねる)。
     🚨 OFF なら 1バイトも渡さない＝今までと1ミリも同じ計算。 */
  const keepDecided = ((settings && settings.opsim && settings.opsim.keepDecided) !== false);
  const actualPins = useMemo(
    () => (keepDecided ? actualWorkerPinsOf(lots, { isOpen: isOpenLot }) : {}),
    [keepDecided, lots],
  );
  const [planJobLocks, setPlanJobLocks] = useState({});
  const scenario = useMemo(() => {
    const sc = { snapshotEveryMs: SNAPSHOT_EVERY_MS, compareAllSkills: true };
    if (Object.keys(planJobLocks).length) sc.planJobLocks = planJobLocks;
    /* 📌 固定は 2段。手で決めた固定(pins・強い)と、実際の担当(記録)＝やわらかい固定(softPins)。
       🚨 2026-09-19: 記録の担当を 強い固定へ混ぜない。その人に 残りの工程の記録が無いと ロットが最後まで止まるため。
          やわらかい固定は「その人が出来る工程だけ その人へ」。手の固定が在るロットには載らない(エンジン側で外す)。 */
    if (Object.keys(pinsCfg).length) sc.pins = { ...pinsCfg };
    if (Object.keys(actualPins).length) sc.softPins = { ...actualPins };
    // 📦 決めた配置の休み。他のシナリオ(休みの試し)が在れば **重ねる**(消さない)。
    //   🚨 これが scenario に載る事で runKey(scenarioKey)が変わり、盤が必ず引き直る。
    if (Object.keys(placementAbsences).length) sc.absences = { ...placementAbsences };
    // 追記(2026-08-29 契約C2): 残業の刻み。＋30分/＋60分を選んだ時だけ
    //   overtimeExtraMinutes を送り、満額の合図(overtime:true)は立てない。
    //   分数の解釈は normalizeInput が決める(min(定時+刻み, policyの540分))。ここで分数を計算しない。
    const overtimeStepMin = (overtimeExtra === '30' || overtimeExtra === '60') ? Number(overtimeExtra) : 0;
    if (scenarioKey === 'overtime' && overtimeStepMin > 0) {
      sc.overtimeExtraMinutes = overtimeStepMin;
    }
    if (scenarioKey === 'overtime' && overtimeStepMin === 0) {
      // 🚨 仕様書6.12: 残業は overtime:true の **意思表示** としてエンジンへ渡す。
      //   1日の分数は policy.js の overtimeDirectMinutesPerDay(540分・仕様書D02)ただ1つが決める。
      //   ここで勤務表から数字を作って送らない。
      // 【なぜ直したか 2026-08-28】以前は computeWorkHours(勤務表) の時間数を
      //   scenario.dailyHours に入れていた。normalizeInput はその数字を
      //   「420分より大きいか」だけの合図として読むので、勤務表の合計が420分以下の現場を
      //   登録すると **残業を選んでも黙って通常420分のまま** になる穴があった
      //   (CONTRACT.md 9.1「残っている穴」)。overtime:true なら勤務表が何分でも540分が効く。
      sc.overtime = true;
    }
    if (scenarioKey === 'absence') {
      // 🚨 休みの日付は **基準時刻** から数える。実時計から数えると、
      //   「次の勤務開始から」を選んだ時に、休みの初日が基準より前になる回が出る。
      const abs = buildAbsences(absenceName, absenceDays, baseNowMs, worksOnDay);
      if (abs) {
        // 📦 決めた配置の休みと **重ねる**(同じ日は両方の名前を持つ)
        const merged = { ...(sc.absences || {}) };
        for (const d of Object.keys(abs)) merged[d] = { ...(merged[d] || {}), ...abs[d] };
        sc.absences = merged;
      }
    }
    if (scenarioKey === 'ojt' && ojtName && ojtProcess) {
      sc.assumeCertified = [{ name: ojtName, processKey: ojtProcess }];
    }
    // 追記(2026-08-29 契約C3): 人の任せ替え = 「Aを見通しの間休みに + BがAの工程を
    //   今すぐ単独で持てる仮定」。Aの工程集合は「同じ土俵の通常」の割付(swapSource)から
    //   拾う。材料が揃うまでは何も渡さない=通常と同じ計算(理由は comparison が画面に出す)。
    //   ⚠ 割付そのものはエンジンが空きを見て決める(必ずBへ行く保証ではなく、Bが持てる様になる仮定)。
    if (scenarioKey === 'swap' && swapPlan.ready) {
      const swapAbs = buildSwapAbsences(swapPlan.from, horizonDays, baseNowMs, worksOnDay);
      if (swapAbs) sc.absences = swapAbs;
      sc.assumeCertified = swapPlan.processKeys.map((pk) => ({ name: swapPlan.to, processKey: pk }));
    }
    // 🚨 2026-08-24: 「1つの品目コードは1人で」「2人でできる工程」。
    //   設定は settings/config の中の opsim に置く（新しい入れ物を作らない）。
    //   ⚠ 入っていなければ **何も渡さない**＝いままでの計算と1ミリも変わらない。
    // 🚨 仮に置く入荷日。0(OFF=実データだけ) の時は **何も渡さない**＝8/25以前と同じ計算。
    //   既定は 2(ON)＝2026-08-31 清水さん「とりあえず仮日入れないとなんもできない」。
    if (assumeArrivalDays > 0) sc.assumeArrivalDaysBeforeDue = assumeArrivalDays;
    const op = (settings && settings.opsim) || {};
    if (op.oneWorkerPerModel === true) sc.oneWorkerPerModel = true;
    const two = Array.isArray(op.twoPersonProcessKeys) ? op.twoPersonProcessKeys.filter(Boolean) : [];
    if (two.length) sc.twoPersonProcessKeys = two;
    // 🏭 区画の定員。⚠ 1件も無ければ渡さない＝いままでの計算と1ミリも変わらない。
    if (zoneCapForSim && Object.keys(zoneCapForSim).length) {
      sc.zoneCapacity = zoneCapForSim;
      sc.zoneNames = zoneNamesForSim;
    }
    // 👤 この人はこのテンプレを優先(順番だけ)。空なら渡さない。
    if (tplPrefsForSim && Object.keys(tplPrefsForSim).length) sc.workerTemplatePrefs = tplPrefsForSim;
    // 👤 2026-09-17 優先の強さ。'reserve' の時だけ鍵を載せる(既定の 'order' は今までと1バイトも同じ)。
    if (tplPrefModeCfg.mode === 'reserve' && sc.workerTemplatePrefs) sc.templatePrefMode = 'reserve';
    // 🎛 本物に近づける設定(2026-09-07)。合図 + 合図が ON の実績の表(2026-09-10)。
    //   🚨🚨 8つとも「使わない」のままなら realismScenarioOf が null を返すので、
    //     この if は1回も通らない＝ scenario は前と1バイトも同じ＝ 答えも1ミリも変わらない。
    //   ⚠ 鍵の名前は scenario の鍵の約束(arrivalHabitMode + arrivalHabit / splitArrivalOn + splitArrival /
    //     shipDeadline:{on,leadDays} / reworkMode + reworkRates …)。normalizeInput / simulate がこの名前で読む。
    if (realismForSim) Object.assign(sc, realismForSim);
    // 👤 曜日ごとの窓／休みの日の登録が1人でも在れば workerAvailabilityOn:true(登録が無ければ何も足さない)。
    if (availForSim) Object.assign(sc, availForSim);
    // 🔧 設備の定員。⚠ 区画(zoneCapacity)と同じ形で渡す。1件も無ければ渡さない。
    if (equipCapForSim) {
      sc.equipmentCapacity = equipCapForSim;
      if (equipNamesForSim) sc.equipmentNames = equipNamesForSim;
    }
    // 👥 分担の区切り(2026-09-10 清水さん「一台毎で区切る感じじゃないとだめだからね」)。
    //   🚨 ここだけは **必ず** 渡す。エンジンの既定は 'none'(渡されなければ1行も動かない)なので、
    //     まだ誰も選んでいない時に清水さんの指定('unit')で走らせるには、画面が渡すしかない。
    //   ⚠ 字は handoff.js の3つ('none'|'soft'|'unit')。読むのは normalizeInput / simulate。
    sc.handoff = handoffCfg.mode;
    // 🧵🚩 ロットは持ったら最後まで／優先度の区分(2026-09-10 23:30)。ON の鍵だけ載る(OFF は鍵ごと無し)。
    //   🚨 鍵の名前は約束の物(lotFocus / priorityClass = true)。simulate / priority がこの名前で読む。
    if (focusForSim) Object.assign(sc, focusForSim);
    // ⚙ 割付の決まり(opsimRules)。⚠ 仮の入荷日は画面の口が後で上書きする(同じ値)
    if (rulesForSim) { Object.assign(sc, rulesForSim); if (!(assumeArrivalDays > 0)) delete sc.assumeArrivalDaysBeforeDue; else sc.assumeArrivalDaysBeforeDue = assumeArrivalDays; }
    // 🕒 納期対応の残業・土曜(必要分)。「これでいく」を押した案だけ extraByDay / workOnDays として載る
    //   (runKey が変わり盤が引き直る)。無ければ鍵ごと無し。読むのは normalizeInput → calendar.js の segmentsFor。
    if (overtimePlanForSim) Object.assign(sc, overtimePlanForSim);
    // ✅ 並列作業: 採用の記録から(adoption.js)。無ければ鍵ごと無し。ラボの「待機」は scenarioPatch で parallelLab:null に上書きする
    if (adoptedParallelLab) sc.parallelLab = adoptedParallelLab;
    // 🚶 掛け持ちの切り替え(on の時だけ)。採用の記録より後に置く=清水さんの切り替えが勝つ
    if (jugglingScenario) sc.parallelLab = jugglingScenario;
    return sc;
  // 🚨 依存に入れ忘れると「押しても計算し直さない」画面になる(2026-09-06 の実例)。
  // ⚠ 🎛 の3つは **前** に置く。見張り(zone-and-template-priority-wired の W6)が
  //   `worksOnDay, zoneCapForSim, zoneNamesForSim, tplPrefsForSim]);` の並びを字で見ているので、
  //   後ろへ足すと その見張りが赤になる（並びが意味を持っている所）。
  }, [planJobLocks, pinsCfg, actualPins, tplPrefModeCfg, placementAbsences, scenarioKey, settings, absenceName, absenceDays, ojtName, ojtProcess, baseNowMs, assumeArrivalDays,
    realismForSim, availForSim, equipCapForSim, equipNamesForSim, handoffCfg, focusForSim, overtimePlanForSim,
    overtimeExtra, swapPlan, rulesForSim, adoptedParallelLab, jugglingScenario, horizonDays, worksOnDay, zoneCapForSim, zoneNamesForSim, tplPrefsForSim]);

  // 「全員がどの工程も持てる仮定」だけ担当候補の見方を変える。他は既定（実績からの仮定）。
  const mode = scenarioKey === 'allSkills' ? MODE_ALL : null;

  // 🚨 絞り込みも基準時刻で切る。計算(normalizeInput の nowMs)と別の時刻で切ると、
  //   盤に載るロットと計算に載るロットが食い違う。
  // 🚨 2026-09-05 決まり26: 今月/来月を選んだら、範囲を **その月の末日まで** 自動で広げる。
  //   実測(2026-09-05 朝): 既定「手元＋14日以内」のまま今月を出したので、9/18 より先に来るロットが計算に載らず、
  //   人ごとの指示の 9/22〜9/30 が「全員仕事なし」と描かれた(嘘)。「計算に載せていない」と「仕事がない」を分けていなかった。
  //   広げ方は既定と同じ makeDefaultScopeFilter(暦日で切る)。「未完了ぜんぶ」を選んでいる時はそのまま。
  /* 「来月の手当て」を開いている時は **来月末まで** 広げる（実測 2026-09-05: 既定の14日のままだと
     来月は構造的に必ず「登録0件」に見えた＝清水さんの判断#1。範囲で切っている事は画面で言う）。 */
  /* 🚨 2026-09-05: 画面のタブ。scopeDays(下)が読むので **宣言をここ(使う所より上)に置く**。
     下に置いたまま参照して TDZ で盤が丸ごと落ちた(「この部分だけ表示できませんでした」)。
     eslint の no-use-before-define がこのファイルを見ていなかったので素通りした → 設定に足した。 */
  const [opsimTab, setOpsimTab] = useState('board');
  const nextMonthInfo = useMemo(
    () => opsimRangeDays({ rangeKey: 'nextMonth', baseNowMs, worksOnDay }),
    [baseNowMs, worksOnDay],
  );
  const scopeDays = useMemo(() => {
    const preset = SCOPE_TO_PRESET[scopeKey] || 'inShop';
    const base = SCOPE_PRESET_DAYS[preset];
    if (base == null) return null; // 未完了ぜんぶ
    /* 🚨 2026-09-18 案A: 「来月の手当て」は [月] の画面の1枚目へ移りました。
       来月ぶんの登録まで範囲を広げるのは **月の画面を見ている時** です(札の名前が変わっただけ)。 */
    if (opsimTab === 'month') return Math.max(base, (Number(nextMonthInfo.calDays) || 0) + 1);
    if (!rangeInfo.isMonth) return base;
    return Math.max(base, (Number(rangeInfo.calDays) || 0) + 1);
  }, [scopeKey, rangeInfo, opsimTab, nextMonthInfo]);
  /** 範囲を広げた時の「どこまで」（画面で言う為だけ。数字を作らない） */
  const scopeUntilMs = scopeDays == null ? null
    : (opsimTab === 'month' ? nextMonthInfo.lastDayMs : (rangeInfo.isMonth ? rangeInfo.lastDayMs : null));
  const scopeFilter = useMemo(
    () => (scopeDays == null ? makeScopeFilter('all', baseNowMs) : makeDefaultScopeFilter(baseNowMs, scopeDays)),
    [scopeDays, baseNowMs],
  );

  // ⚠ 計算が始まる前の一瞬に「1件もありません」と出さないための下見。
  //   useEffect は描き終わってから走るので、結果を待って判断すると1こまだけ嘘が出る。
  const scopeEmpty = useMemo(
    () => !lotList.some((lot) => {
      try { return !!scopeFilter(lot); } catch { return false; }
    }),
    [lotList, scopeFilter],
  );

  // 母集団の門(決定 2026-08-28): 納期が今日より前で到着予定も無い物は「処理済みか登録間違い」
  //   なので対象外(件数は正直に出す)。入荷が納期より後は矛盾=対象には残すが警報を出す。
  const todayStartMs = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }, []);
  const duePartition = useMemo(() => {
    const simLots = []; const stale = []; const conflicts = [];
    (lotList || []).forEach((l) => {
      if (!l) return;
      if (l.status === 'completed' || l.location === 'completed') { simLots.push(l); return; }
      const arr = (arrivalByLot && arrivalByLot[l.id]) || null;
      try {
        const st = staleOverdue({ lot: l, arrival: arr, todayStartMs });
        if (st.stale) { stale.push({ id: l.id, orderNo: l.orderNo, model: l.model, templateId: l.templateId, dueMs: st.dueMs }); return; }
        const c = dueConflict({ lot: l, arrival: arr, todayStartMs });
        if (c.conflict) conflicts.push({ id: l.id, orderNo: l.orderNo, model: l.model, templateId: l.templateId, dueMs: c.dueMs, arrivalMs: c.arrivalMs, label: c.label });
      } catch { /* 門で読めない1件のために盤全体を殺さない */ }
      simLots.push(l);
    });
    return { simLots, stale, conflicts };
  }, [lotList, arrivalByLot, todayStartMs]);

  // 🧷 2026-09-17 前回の答えの主担当(lotId → 名前)。手で1つ変えた時に他のロットの担当をなるべく動かさない為の合図。
  //   🚨 runKey に混ぜない(答えが出るたびに鍵が変わって無限に回る)。フックが post の直前に scenario へ重ねる。
  const scenarioHintsRef = useRef({});
  /* 📐 2026-09-22 保存した版の条件で計算し直す時の上書き(null = 今の切替のまま)。
     🚨 scenario / mode / estimateMode をここで差し替える。基準時刻・期間は onRestoreContext が state を動かす。
        ロット・作業者・設定・暦は今の物(条件だけ当時)。画面に札を出し、黙って切替を無視しない。 */
  const [restoredConditions, setRestoredConditions] = useState(null);
  /* 👷 現場の指示の元 = 採用中の版(共有棚)。試算はあくまで比べる物。版が在れば既定で版を見せる */
  const adoptedPlan = useAdoptedPlan({ planShelf, app: 'parts' });
  const [fieldSourceTrial, setFieldSourceTrial] = useState(false);
  const useAdoptedForField = !!adoptedPlan.plan && !fieldSourceTrial;
  const effScenario = restoredConditions ? restoredConditions.scenario : scenario;
  const effMode = restoredConditions && restoredConditions.mode !== null ? restoredConditions.mode : mode;
  const effEstimateMode = restoredConditions && restoredConditions.estimateMode !== null ? restoredConditions.estimateMode : estimateMode;
  // 🚨 2026-09-23 本番では runSkillTrials を渡す口が無く 技能試行が一度も出ていなかった。
  //   「割付と空き」の 🎓 ボタンで true → 次の計算に runSkillTrials:true が載る(useOperationsSimulation が runKey と payload へ)。
  //   ⚠ hooks はガードより上(既存の並びの直前に足しただけ)。
  const [runSkillTrials, setRunSkillTrials] = useState(false);
  const sim = useOperationsSimulation({
    scenarioHints: scenarioHintsRef,
    runSkillTrials,
    lots: duePartition.simLots,
    templates: templateList,
    workers: workerList,
    settings,
    // 📅 工場の暦。フックがこれを runKey に混ぜ、settings へ混ぜてエンジンへ渡す。
    // 🚨 これを渡さないと、祝日を登録しても月の営業日が減らないし、
    //   登録し直しても計算し直さない(押しても何も変わらない画面になる)。
    factoryCalendar,
    enabled: true,          // この画面が開いている間だけ組み立てられるので、ここでは常に true
    scenario: effScenario,
    mode: effMode,
    horizonDays,
    scopeFilter,
    estimateMode: effEstimateMode,
    scenarioId: SCENARIO_ID_OF[scenarioKey] || SCENARIO_ID.BASELINE,
    // 🚨 2026-08-30 是正: 基準時刻の口を1つにする。渡さないとフックが自分の時計を持ち、
    //   「もう一度計算」でそちらだけ動いて、この画面の絞り込み・休みの日付とズレていく。
    now: baseNowMs,
  });

  const { result, loading, progress, error, elapsedMs, cancel, rerun } = sim;

  // ── 通常との差（T013 / 仕様書11章「主結果」）────────────────────────────
  // 🚨 比べてよいのは **入力の指紋・基準時刻・範囲・日数・工数モードが全部同じ** 時だけ(5.8)。
  //   違う物を並べると「残業したら悪くなった」の様な嘘が出る。
  //   だから通常の結果を「鍵つき」で覚えておき、鍵が一致した時しか比べない。
  const baselineRef = useRef(null);   // { key, metrics }
  /**
   * 🚨 2026-08-23 是正: 貯めた物を **state にも持つ**。
   *   ref は書き換えても再描画を起こさないので、useMemo の依存が変わらず
   *   「押した回の結果が表に載らない＝押しても何も起きない画面」になっていた。
   *   ⚠ ref は「同じ描画の中で読む」ため、state は「描き直す合図」のために持つ。二重に持つのはその為。
   */
  const [storeTick, setStoreTick] = useState(0);
  /**
   * 押して計算済みのシナリオを覚えておく置き場。
   * 🚨 ここに貯めるのは **同じ土俵(groundKey)の物だけ**。条件を変えたら丸ごと捨てる。
   *   捨てないと、範囲や工数モードを変えた後の数字が「通常との差」に混ざる（T014）。
   * ⚠ もう一度計算し直さないので **追加の計算コストは0**。清水さんが押した分だけ表が育つ。
   */
  const scenarioStoreRef = useRef({ key: null, byId: new Map() });
  const groundKey = useMemo(() => {
    const m = result && result.metrics;
    if (!m) return null;
    return [m.inputFingerprint, m.baseNow, horizonDays, estimateMode, scopeKey, scopeDays].join('|');
  }, [result, horizonDays, estimateMode, scopeKey, scopeDays]);

  useEffect(() => {
    const m = result && result.metrics;
    if (!m || !groundKey) return;
    // 🚨 2026-08-30 根治: シナリオを切り替えた瞬間、この effect は scenarioKey の変化だけで走り、
    //   result はまだ**前のシナリオの結果**のまま。前は「通常の結果が『残業する(1日420分)』の名札で
    //   数十秒貯まる」「通常へ戻した瞬間、古いシナリオの結果が baseline に入る」が起きていた
    //   (条件くらべの表で実測。計算が終わると上書きで自然回復するが、その間は判断を誤らせる)。
    //   → **結果自身が名乗る scenarioId** と今の選択が一致する時だけ貯める。
    //   ⚠ ojt と swap は同じ札(SUCCESSOR)なので、この照合だけでは互いの切替をすり抜ける。
    //     計算中(loading)は貯めない鍵を重ねて塞ぐ(残る縁は切替直後の1描画だけ=実害なし)。
    if (loading) return;
    const wantId = SCENARIO_ID_OF[scenarioKey] || scenarioKey;
    if (String(m.scenarioId || '') !== String(wantId)) return;
    // 通常シナリオの結果だけを土台として覚える。
    if (scenarioKey === 'normal') baselineRef.current = { key: groundKey, metrics: m };
    // 🚨 条件が変わったら貯めた物を丸ごと捨てる（混ぜない）。
    const storeWasReset = scenarioStoreRef.current.key !== groundKey;
    if (storeWasReset) {
      scenarioStoreRef.current = { key: groundKey, byId: new Map() };
    }
    // 🚨 中身が空のシナリオ（休む人を選んでいない等）は「通常と同じ計算」なので貯めない。
    const emptyAbsence = scenarioKey === 'absence' && !absenceName;
    const emptyOjt = scenarioKey === 'ojt' && (!ojtName || !ojtProcess);
    // 追記(2026-08-29 契約C3): 任せ替えは、材料が揃っていない時と、土俵が変わった直後
    //   (工程集合が前の土俵の割付から出た物)は貯めない。
    const emptySwap = scenarioKey === 'swap' && (!swapPlan.ready || storeWasReset);
    if (!emptyAbsence && !emptyOjt && !emptySwap) {
      // 追記(2026-08-29 契約C1): 同じ結果から、引き直し(base.resample.byLot)も一緒に貯める。
      //   通常の時だけ、任せ替えの材料(作業者→工程集合)も作って貯める。
      //   ⚠ 貯めるのは groundKey が一致する土俵だけ(既存の掟のまま。上で照合済み)。
      const resampleByLot = (result.base && result.base.resample && result.base.resample.byLot) || null;
      const jobProcessByWorker = scenarioKey === 'normal' ? buildJobProcessByWorker(result) : null;
      let label = SCENARIO_LABEL[scenarioKey] || scenarioKey;
      if (scenarioKey === 'overtime') {
        // 残業は3通り(＋30/＋60/満額)が同じ枠を使うので、実効の分数で名前を言い分ける。
        //   ⚠ 画面の選択(overtimeExtra)からではなく **結果そのもの** から読む。
        //   選択と結果が一瞬ずれても、貯めた数字と名前が食い違わない様に。
        const mins = Number(result.normalized && result.normalized.calendarSpec
          && result.normalized.calendarSpec.directMinutesPerDay);
        if (Number.isFinite(mins) && mins > 0) label += `(1日${Math.round(mins)}分)`;
      }
      scenarioStoreRef.current.byId.set(scenarioKey, {
        label, metrics: m, resampleByLot, jobProcessByWorker,
      });
      if (scenarioKey === 'normal' && jobProcessByWorker) {
        // 任せ替えの材料。🚨 中身が同じなら入れ替えない(毎回入れ替えると、この effect が
        //   swapPlan 経由で自分をもう一度呼び、描き直しが止まらなくなる)。
        const sig = [...jobProcessByWorker.keys()].sort()
          .map((w) => `${w}:${[...jobProcessByWorker.get(w)].sort().join(',')}`)
          .join('|');
        setSwapSource((prev) => (
          prev && prev.key === groundKey && prev.sig === sig
            ? prev
            : { key: groundKey, sig, byWorker: jobProcessByWorker }
        ));
      }
    }
    if (storeWasReset && scenarioKey !== 'normal') {
      // 土俵が変わったのに通常をまだ計算し直していない間は、材料は無い物として扱う。
      setSwapSource((prev) => (prev == null ? prev : null));
    }
    // 🚨 ここで描き直しの合図を出す。出さないと、押した回の結果が表に載らない。
    setStoreTick((v) => v + 1);
  }, [result, groundKey, scenarioKey, absenceName, ojtName, ojtProcess, swapPlan, loading]);

  /**
   * 下段「改善策ごとの実測差分」（仕様書11章 / T019）。
   * 🚨 効果の数字を持てるのは **同じ土俵で実際に計算した物だけ**。
   *   まだ押していない案は candidates に入れ、**effect を null のまま**出す。
   */
  const improvements = useMemo(() => {
    const b = baselineRef.current;
    if (!b || b.key !== groundKey) return null;
    const store = scenarioStoreRef.current;
    const measured = [];
    if (store.key === groundKey) {
      for (const [id, v] of store.byId) {
        if (id === 'normal') continue;
        measured.push({ scenarioId: id, label: v.label, metrics: v.metrics });
      }
    }
    const done = new Set(measured.map((x) => x.scenarioId));
    const candidates = Object.keys(SCENARIO_LABEL)
      .filter((k) => k !== 'normal' && !done.has(k))
      .map((k) => ({ scenarioId: k, label: SCENARIO_LABEL[k], why: 'まだ押していません（押すと効き目が出ます）' }));
    return rankImprovements({ baseline: b.metrics, measuredScenarios: measured, candidates });
  }, [groundKey, result, storeTick]);

  const comparison = useMemo(() => {
    const m = result && result.metrics;
    if (!m || scenarioKey === 'normal') return null;
    // 🚨 「誰か休み」で誰も選んでいない時は、通常と同じ計算をしているだけ。
    //   「差はありません」と出すと『休んでも大丈夫』と読めてしまう。
    if (scenarioKey === 'absence' && !absenceName) {
      return {
        comparable: false,
        reason: '休む人を選んでください（選ぶまでは通常と同じ計算です）',
        deltas: null, detail: null, hasDifference: false, changedKeys: [], better: null,
      };
    }
    if (scenarioKey === 'ojt' && (!ojtName || !ojtProcess)) {
      return {
        comparable: false,
        reason: '後継者と工程を選んでください（選ぶまでは通常と同じ計算です）',
        deltas: null, detail: null, hasDifference: false, changedKeys: [], better: null,
      };
    }
    // 追記(2026-08-29 契約C3): 任せ替えの支度が揃うまでは「通常と同じ計算」なので比べない。
    if (scenarioKey === 'swap' && !swapPlan.ready) {
      return {
        comparable: false,
        reason: swapPlan.reason,
        deltas: null, detail: null, hasDifference: false, changedKeys: [], better: null,
      };
    }
    const b = baselineRef.current;
    if (!b || b.key !== groundKey) {
      return {
        comparable: false,
        reason: '通常の結果がまだありません（同じ条件で「通常」を1回計算すると差が出せます）',
        deltas: null, detail: null, hasDifference: false, changedKeys: [], better: null,
      };
    }
    return compareScenarios(b.metrics, m);
  }, [result, scenarioKey, groundKey, absenceName, ojtName, ojtProcess, storeTick, swapPlan]);

  // Header が今受け取っている形（件数3つ）。🚨 読めない物は null。0 を入れると嘘の差が出る。
  const baselineForHeader = useMemo(() => {
    if (scenarioKey === 'normal') return null;
    const b = baselineRef.current;
    if (!b || b.key !== groundKey) return null;
    return {
      late: b.metrics.futureLateLotCount,
      unresolved: b.metrics.unresolvedTotalLotCount,
      unjudgeable: b.metrics.unjudgeableLotCount,
    };
  }, [scenarioKey, groundKey, result, storeTick]);

  // ── 時間の目盛り ─────────────────────────────────────────────────────────
  const calendar = useMemo(() => {
    const spec = result && result.normalized && result.normalized.calendarSpec;
    if (!spec) return null;
    try { return makeCalendar(spec); } catch { return null; }
  }, [result]);

  /**
   * 📅 工場の暦の札。清水さん(2026-09-01)「祝日表はいるね」の目に見える形。
   *
   * 🚨 日数はここで数えない。forecast.buildMonthPeriods に数えさせて、
   *   作られた札(rangeLabel)をそのまま出す。同じ数字を2つの計算から出さない。
   * 🚨 渡す判定は **計算で使ったのと同じ暦**(calendar.isWorkday)。
   *   ここだけ別の判定を作ると、盤と札で営業日の数が違う。
   * ⚠ 登録が0件でも札は出す(「祝日を引いていません」と正直に言うため)。
   */
  const factoryCalendarNote = useMemo(() => {
    const base = Number(result && result.normalized && result.normalized.now);
    if (!calendar || !isNum(base)) return null;
    const fc = (result && result.normalized && result.normalized.factoryCalendar) || null;
    let months = [];
    try {
      months = buildMonthPeriods({ baseNow: base, months: 3, isWorkday: calendar.isWorkday })
        .map((m) => ({
          label: m.label,
          rangeLabel: m.rangeLabel,
          workdays: m.workdays,
          calendarDays: m.calendarDays,
          holidays: m.holidays,
          workOverrides: m.workOverrides,
        }));
    } catch { months = []; }
    return { count: Number(fc && fc.count) || 0, months };
  }, [result, calendar]);

  const timeline = useMemo(() => {
    if (!result) return null;
    const snaps = Array.isArray(result.base && result.base.snapshots) ? result.base.snapshots : [];
    const startMs = Number(result.normalized && result.normalized.now);
    const endMs = Number(result.normalized && result.normalized.horizonEnd);
    let capMs = null;
    try { capMs = calendar ? calendar.dayCapacityMs() : null; } catch { capMs = null; }
    return {
      snaps,
      startMs: isNum(startMs) ? startMs : null,
      endMs: isNum(endMs) ? endMs : null,
      capMs: isNum(capMs) ? capMs : null,
    };
  }, [result, calendar]);

  /**
   * 「N日目」の実時刻。
   * 🚨 1日目 ＝ 計算を始めた時刻。+0.3日 は「働ける時間」を 0.3日ぶん足した所（指示書5.3）。
   *   実時間で 0.3×24時間 進めるのではない。土日・休憩・時間外は calendar が飛ばす。
   */
  const targetMs = useMemo(() => {
    if (!timeline || timeline.startMs == null) return null;
    if (!calendar || timeline.capMs == null) return timeline.startMs;
    // 0.0 = いま。1 を引かない（引いていたのが D05 の「5日目が4日ぶん」の原因）。
    // 🚨 2026-09-04 決まり15: ここは round1 だった。「＋0.5時間」＝0.071日 が 0.1日(42分) に、
    //   「＋2時間」＝0.286日 が 0.3日(126分) に化けて、つまみの時刻と選ばれる記録がズレていた
    //   （実測: ＋0.5時間を3回押しても記録が動かず「片山 あと4分」のまま）。刻みは小数3桁まで持つ。
    const back = Math.max(0, Number(elapsedDays) || 0);
    try {
      // 🚨 分に丸める（2026-09-04 実測）: 0.071日×420分 = 29.82分 → 8:59:49 になり、9:00 の記録が
      //   「まだ来ていない」扱いで選ばれなかった（＋0.5時間を押しても 8:30 の記録のまま）。
      //   記録は直接作業30分の目盛りに在るので、分に丸めれば同じ時刻に揃う。
      const t = Math.round(calendar.addWorkMs(timeline.startMs, back * timeline.capMs) / 60000) * 60000;
      return timeline.endMs != null ? Math.min(t, timeline.endMs) : t;
    } catch {
      return timeline.startMs;
    }
  }, [timeline, calendar, elapsedDays]);

  const snapshot = useMemo(() => {
    const snaps = (timeline && timeline.snaps) || [];
    if (!snaps.length) return null;
    if (!isNum(targetMs)) return snaps[0];
    let pick = snaps[0];
    for (const s of snaps) {
      if (s && isNum(s.atMs) && s.atMs <= targetMs) pick = s;
      else break;
    }
    return pick;
  }, [timeline, targetMs]);

  const forecastSnapshot = useMemo(() => {
    const snaps = (timeline && timeline.snaps) || [];
    return snaps.length ? snaps[snaps.length - 1] : null;
  }, [timeline]);

  /**
   * 段ごとの所要時間（2026-08-30 追記。条件・根拠タブの一番下へ小さく出す）。
   * 🚨 計算側が実測した物を **そのまま束ねるだけ**。ここで測らない・足さない・丸めない。
   *   ・result.meta.phaseMs … 段ごとのミリ秒
   *   ・result.base.resample.partsMs … 引き直しの内訳(束を作る / 引き直し本体)
   *   ・usedCachedHistory / usedCachedNormalize … 初回か再計算かの根拠
   * ⚠ 計算がまだの時・古い結果に無い時は null。0 を作らない（「一瞬で終わった」と嘘になる）。
   */
  const perfInfo = useMemo(() => {
    const meta = (result && result.meta) || null;
    if (!meta || !meta.phaseMs || typeof meta.phaseMs !== 'object') return null;
    return {
      phaseMs: meta.phaseMs,
      partsMs: (result.base && result.base.resample && result.base.resample.partsMs) || null,
      usedCachedHistory: !!meta.usedCachedHistory,
      usedCachedNormalize: !!meta.usedCachedNormalize,
    };
  }, [result]);

  /**
   * いま選んでいる刻みが「何時間ぶん」か。🚨 画面に出す前に丸める。
   * 🚨 2026-08-30: 刻みを選べる様にしたので、**選んだ刻みの札で言う**。
   *   「+0.3日」と決め打ちで書いてあると、0.5時間を選んだ人に嘘の説明が出る。
   */
  const stepHoursText = useMemo(() => {
    if (!timeline || timeline.capMs == null) return '';
    const c = opsimStepOf(playStep);
    const h = round1((opsimStepDays(c.key, timeline.capMs) * timeline.capMs) / MS_HOUR);
    return `1日目 ＝ 計算を始めた時刻です。この設定では「＋${c.label}」で ${h}時間ぶん進みます（土日・休憩・時間外は飛ばします）。`;
  }, [timeline, playStep]);

  // ── 盤面まわりの引き当て ─────────────────────────────────────────────────
  const templatesById = useMemo(() => {
    const m = new Map();
    templateList.forEach((t) => {
      const id = idOf(t);
      if (id) m.set(id, { name: (t && typeof t.name === 'string') ? t.name : '' });
    });
    return m;
  }, [templateList]);

  const normalizedLots = useMemo(
    () => (Array.isArray(result && result.normalized && result.normalized.lots) ? result.normalized.lots : []),
    [result],
  );

  /**
   * 🚨 決まり10（2026-09-02 清水さん「遅れても後から処理完了したらそこから消えてるけど、
   *   一回納期遅れてることは事実なのに情報がなくなってる」）。
   *   上の duePartition は status==='completed' を計算から逃がす。それは正しい（片付いた仕事を割り付けない）が、
   *   逃がした物のうち「納期に遅れて完了した」事実は、盤の右の棚と納期一覧の下段に **灰＋赤の +N日** で残す。
   *   数える式は App.jsx の納期分析と同じ1本（lateDone.js）。期間は **先月の1日から基準時刻まで**
   *   （今月だけだと月初は0件になって「遅れた事実」が消える）。数えていない物は counts に白状させてある。
   *   ⚠ 既存 hooks の後ろ・ガードより上。 */
  const lateDone = useMemo(() => {
    const base = isNum(baseNowMs) ? baseNowMs : Date.now();
    const d = new Date(base);
    const fromMs = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    const r = buildLateDone({ lots: lotList, fromMs, toMs: base });
    const f = new Date(fromMs);
    return {
      rows: r.rows.map((x) => ({ ...x, tplName: tplNameOf(templatesById, x.templateId) })),
      counts: r.counts,
      fromMs,
      toMs: base,
      windowText: `先月から（${f.getMonth() + 1}/${f.getDate()}〜）`,
    };
  }, [lotList, baseNowMs, templatesById]);

  const selectedLot = useMemo(
    () => normalizedLots.find((l) => l && l.lotId === selectedLotId) || null,
    [normalizedLots, selectedLotId],
  );

  /**
   * エンジンの見立てを lotId で引ける形に。
   * 🚨 盤の snapshot.lot.late は `atMs > dueLineMs` ＝ **今日の事実** なので使わない。
   *   この先で遅れるかは result.base.lotResults にしか無い。
   *   （この受け渡しが無いと、盤の「遅れます」は永久に出ない。実コードで確認済み）
   */
  const lotVerdictById = useMemo(() => {
    const m = new Map();
    const rows = Array.isArray(result && result.base && result.base.lotResults) ? result.base.lotResults : [];
    rows.forEach((r) => { if (r && r.lotId) m.set(String(r.lotId), r); });
    return m;
  }, [result]);

  const selectedLotResult = useMemo(() => {
    const rows = Array.isArray(result && result.base && result.base.lotResults) ? result.base.lotResults : [];
    return rows.find((r) => r && r.lotId === selectedLotId) || null;
  }, [result, selectedLotId]);

  // ⚠ snapshot のロットは atMs を持っていないので、ここで足す。
  //   足さないと Side.jsx が「いまの時刻」を計算の開始時刻へ落とし、納期までの残りがずれる。
  const selectedSnapshotLot = useMemo(() => {
    const rows = Array.isArray(snapshot && snapshot.lots) ? snapshot.lots : [];
    const row = rows.find((l) => l && l.lotId === selectedLotId) || null;
    if (!row) return null;
    return { ...row, atMs: isNum(snapshot.atMs) ? snapshot.atMs : null };
  }, [snapshot, selectedLotId]);

  // 「仮に単独で任せる工程」の選択肢。計算に載ったロットの工程から作る。
  const processOptions = useMemo(() => {
    const m = new Map();
    normalizedLots.forEach((lot) => {
      const tpl = templatesById.get(lot && lot.templateId);
      const tplName = (tpl && tpl.name) || '検査表の名前がありません';
      (Array.isArray(lot && lot.steps) ? lot.steps : []).forEach((s) => {
        if (!s || !s.processKey || m.has(s.processKey)) return;
        m.set(s.processKey, { key: s.processKey, label: `${tplName}／${s.title || '工程名の記録がありません'}` });
      });
    });
    return [...m.values()].sort((a, b) => (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
  }, [normalizedLots, templatesById]);

  // ── 「頼める人」（LotDetail の根拠）──────────────────────────────────────
  // 🚨 これを渡さないと LotDetail が全工程を「記録が見当たらない」と書いてしまう。
  //    調べていないだけの物を「記録が無い」と書くのは嘘なので、必ず作る。
  // ⚠ 別スレッドの戻りには関数を載せられない（eligibleFor は関数）ので、この場で作る。
  //    カードを1枚も押していない間は作らない（開いただけで待たせない）。
  // ⚠ 作り終わった相手（どの計算結果に対して作った物か）も一緒に持つ。
  //   ref に入れて描画で読むと、値が新しくなっても画面が描き直されない。
  const [eligSrc, setEligSrc] = useState(null);
  const [eligValue, setEligValue] = useState(null);
  const [eligBusy, setEligBusy] = useState(false);
  const [eligError, setEligError] = useState('');

  // 2026-09-03 決まり14-3: 納期一覧の帯と人・日順は「この人に記録が無い工程」を出すのに頼める人の表が要る。
  //   カードを押していなくても、その2つの見せ方を開いた時は作る（盤（ロットの流れ）は今まで通り押した時だけ）。
  const needEligibility = !!selectedLotId || viewMode === 'calendar' || viewMode === 'workers';
  useEffect(() => {
    if (!needEligibility || !result) return undefined;
    if (eligSrc === result) return undefined;
    let alive = true;
    setEligBusy(true);
    setEligError('');
    // ⚠ この setTimeout は別スレッド化ではない（指示書2.3）。
    //   「計算しています」を先に描かせてから走らせるためだけに1回挟んでいる。
    const timer = setTimeout(() => {
      if (!alive) return;
      try {
        const solo = computeSoloDependency({ lots: lotList, templates: templateList, workers: workerList });
        // 🚨 式は skillRegistry.buildSkillConfig ただ1つ（Worker と同じ物。2か所に書かない）。
        const skillConfig = buildSkillConfig({ settings, templates: templateList });
        const value = buildEligibility({ soloResult: solo, workers: workerList, skillConfig, mode, scenario });
        setEligValue(value);
        setEligError('');
      } catch (e) {
        setEligValue(null);
        setEligError(String((e && e.message) || e));
      } finally {
        setEligSrc(result);
        setEligBusy(false);
      }
    }, 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [needEligibility, result, eligSrc, lotList, templateList, workerList, settings, mode, scenario]);

  const eligibility = (eligSrc === result) ? eligValue : null;

  /**
   * 🚨 決まり14-3・16（2026-09-03）: 誰が・いつ・どれだけ手が空くか。仕事が無いのか、記録が無い工程が待っているのか。
   *   材料は割付の結果そのまま（base.idleLog / base.unresolved / normalized.jobs）＋ 計算で使った暦 ＋ 頼める人の表。
   *   数えるのは idleReason.js の buildIdleByDay ただ1本。納期一覧の帯と人・日順の見出しは同じ物を置く。
   *   ⚠ eligibility がまだ無い間は「この人に記録が無い工程」の内訳だけ null（調べていない事を、無いと言わない）。
   */
  const workerNamesInOrder = useMemo(() => {
    const ws = Array.isArray(result && result.normalized && result.normalized.workers) ? result.normalized.workers : [];
    return ws.map((w) => (w && typeof w.name === 'string' ? w.name.trim() : '')).filter(Boolean);
  }, [result]);
  const idleByDay = useMemo(() => {
    if (!result || !result.base || !calendar || !timeline || timeline.startMs == null || timeline.endMs == null) return null;
    try {
      return buildIdleByDay({
        idleLog: result.base.idleLog,
        calendar,
        workerNames: workerNamesInOrder,
        dayStarts: dayStartsBetween(timeline.startMs, timeline.endMs),
        // 🚨 2026-09-04: 計算した範囲そのもの。最初と最後の日を丸1日ぶん数えない
        //   （範囲の外を「働ける時間」に足すと、帯の合計が 1人1日420分の物理の上限を超える）。
        fromMs: timeline.startMs,
        toMs: timeline.endMs,
        unresolved: result.base.unresolved,
        jobs: result.normalized ? result.normalized.jobs : null,
        lots: normalizedLots,
        eligibility,
      });
    } catch (e) {
      // 🚨 黙って消さない。帯の代わりに「数えられませんでした」を出せるように印を返す(2026-09-04)。
      return { error: String((e && e.message) || e || '理由が分かりません') };
    }
  }, [result, calendar, timeline, workerNamesInOrder, normalizedLots, eligibility]);

  // ── 再生（🚨 setInterval を使わない。画面から離れれば必ず止まる）──────────
  useEffect(() => {
    if (!playing) return undefined;
    if (typeof requestAnimationFrame !== 'function') return undefined;
    // 🚨 刻みと速さは別々の札。時間で決めた刻みは、その時の1日ぶんの能力(capMs)で日へ直す
    //   （残業だと1日ぶんが増えるので、決め打ちの換算値を置かない）。
    const stepDay = opsimStepDays(playStep, timeline ? timeline.capMs : null);
    const stepMs = opsimPlayMsOf(playMs).ms;
    let raf = 0;
    let last = 0;
    const tick = (t) => {
      if (!last) last = t;
      if (t - last >= stepMs) {
        last = t;
        setElapsedDays((d) => {
          const next = roundToStep(d + stepDay, stepDay);
          // ⚠ 上限は「いま何日で回しているか」。5日/30日を切り替えたら つまみの端も動く
          return next >= horizonDays ? horizonDays : next;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); };
    // ⚠ timeline.capMs も鍵に入れる。残業へ切り替えて1日ぶんが変わったら、
    //   時間で決めた刻みの「何日ぶんか」も変わる。
  }, [playing, horizonDays, playStep, playMs, timeline]);

  useEffect(() => {
    if (playing && elapsedDays >= horizonDays) setPlaying(false);
  }, [playing, elapsedDays, horizonDays]);

  // ── 操作 ─────────────────────────────────────────────────────────────────
  const laneOrderRef = useRef([]);   // 盤がいま描いている並び。凍結の材料
  const handleLaneOrder = useCallback((ids) => {
    laneOrderRef.current = Array.isArray(ids) ? ids : [];
  }, []);

  /** 再生を始めた時に、その時の並びを凍らせる。止めても解かない（見比べる為）。 */
  const togglePlay = useCallback(() => {
    setPlaying((v) => {
      const next = !v;
      if (next) setFrozenLaneOrder((cur) => (cur == null ? laneOrderRef.current.slice() : cur));
      return next;
    });
  }, []);

  const handleDay = useCallback((d) => {
    setElapsedDays(d);
    if (Number(d) <= 0) setFrozenLaneOrder(null);   // 「いま」に戻したら並び直す
  }, []);

  const handleSortMode = useCallback((m) => {
    setSortMode(m);
    setFrozenLaneOrder(null);   // 並べ方そのものを変えたら、凍結は捨てる
  }, []);

  /**
   * 🚨「1つの品目コードは1人で」「2人でできる工程」だけは **設定として保存する**。
   *   他の仮定はこの画面の中だけだが、これは現場の決まりごとなので皆で共有する。
   *   置き場は settings/config の中の opsim（新しい入れ物を作らない）。
   * ⚠ 保存が失敗したら黙って飲み込まない。画面に出す。
   */
  const [opsimSaving, setOpsimSaving] = useState(false);
  const [opsimSaveError, setOpsimSaveError] = useState('');
  const opsimCfg = useMemo(() => ((settings && settings.opsim) || {}), [settings]);
  // 🚨 2026-09-24 第三者の指摘: 失敗を握るだけで呼び手に返さず、並列作業の道具は失敗しても「保存しました」と出していた。
  //   → 成否を true/false で返す(赤い帯の opsimSaveError はそのまま出す)。返り値を見ない呼び手は今まで通り。
  const saveOpsim = useCallback(async (patch) => {
    if (typeof saveSettings !== 'function') {
      setOpsimSaveError('保存する道がこの画面に渡っていません（開発の不備です）');
      return false;
    }
    setOpsimSaving(true);
    setOpsimSaveError('');
    try {
      await saveSettings({ opsim: { ...opsimCfg, ...patch } });
      return true;
    } catch (e) {
      setOpsimSaveError(String((e && e.message) || e));
      return false;
    } finally {
      setOpsimSaving(false);
    }
  }, [saveSettings, opsimCfg]);
  // 🔀 納期一覧の並べ方(settings.opsim.dueSort)。鍵の読み方は dueListOrder ただ1本。
  const dueSortNow = normalizeDueSort(opsimCfg.dueSort);
  const onChangeDueSort = useCallback((k) => { saveOpsim({ dueSort: normalizeDueSort(k) }); }, [saveOpsim]);
  // 📌 担当の固定(settings.opsim.pins・並び)。'__auto' は外す(自動へ戻す)。
  const onPinWorker = useCallback((lotId, value) => { saveOpsim({ pins: pinsListWith(opsimCfg.pins, lotId, value) }); }, [saveOpsim, opsimCfg]);
  // 📌 2026-09-17 清水さんの言葉「配置ボタンしたら、次開いたら忘れてることある」＝答えが揺れる。
  //   いまの答えの担当を **まとめて** 固定する／まとめて外す。
  //   🚨 中身は行ごとの固定と同じ pins。書き手は saveOpsim ただ1つ(別の書き手を作らない)。
  //   🚨 新しい数を作らない: 何件かは納期一覧が自分の行から数えて札に出す(ここは受け取った並びを畳むだけ)。
  const onPinAll = useCallback((list) => {
    saveOpsim({ pins: (list || []).reduce((acc, x) => pinsListWith(acc, x.lotId, x.worker), opsimCfg.pins) });
  }, [saveOpsim, opsimCfg]);
  const onUnpinAll = useCallback((ids) => {
    saveOpsim({ pins: (ids || []).reduce((acc, id) => pinsListWith(acc, id, PIN_AUTO), opsimCfg.pins) });
  }, [saveOpsim, opsimCfg]);
  /* 🧷 2026-09-18 「固定が既定」の ON/OFF。書き手は saveOpsim ただ 1つ(別の書き手を作らない)。
     🚨 設定には **false の時だけ** 意味がある(無ければ ONが既定)。 */
  const onKeepDecided = useCallback((v) => { saveOpsim({ keepDecided: v === true }); }, [saveOpsim]);
  // 🛠 行からの編集・削除・優先度。🚨 App の式をそのまま呼ぶ(ここに書き写さない)。渡されなければ札は出ない。
  const onEditLotRow = useCallback((lotId) => {
    if (typeof onEditLot !== 'function') return;
    const lot = lotList.find((l) => l && String(l.id) === String(lotId));
    if (lot) onEditLot(lot);
  }, [onEditLot, lotList]);
  const onDeleteLotRow = useCallback((lotId) => { if (typeof onDeleteLot === 'function') onDeleteLot(lotId); }, [onDeleteLot]);
  const onPriorityRow = useCallback((lotId, key) => { if (typeof onChangeLotPriority === 'function') onChangeLotPriority(lotId, key); }, [onChangeLotPriority]);

  const resetClock = useCallback(() => {
    setElapsedDays(0);   // 🚨「最初へ戻す」は 0.0(いま)。1 ではない
    setPlaying(false);
    setFrozenLaneOrder(null);   // 🚨 並びの凍結も解く（「いま」に戻す＝並び直す）
  }, []);

  const handleScenario = useCallback((key) => {
    setScenarioKey(key);
    resetClock();
  }, [resetClock]);

  const handleScope = useCallback((key) => {
    setScopeKey(key);
    resetClock();
  }, [resetClock]);

  const handleOpenEvidence = useCallback(() => {
    setEvidenceOpen(true);
    // ⚠ 開いた物が画面の外だと「押しても何も起きない」に見える。必ず見える所まで送る。
    setTimeout(() => {
      const el = evidenceRef.current;
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }, []);

  const handleRerun = useCallback(() => {
    resetClock();
    // 🚨 押した時だけ実時計を取り直す。ここ1箇所だけが時計を触る。
    //   絞り込み・休みの日付・計算へ渡る基準時刻が、全部この1つから作られる。
    //   ⚠「次の勤務開始から」を選んでいる時も、起点は必ず実時計。
    //     前の基準から進めると、押すたび先の週へ行ってしまう。
    setPanelNow(Date.now());
    rerun();
  }, [resetClock, rerun]);

  // ── 追記(2026-08-29 契約C4): what-if の引き直し差分 ─────────────────────────
  //   出す条件: 通常以外のシナリオ / 同じ土俵(groundKey一致)の「通常」の引き直しが
  //   保管庫に居る / 今の結果にも引き直しが居る。1つでも欠けたら帯ごと出さない(契約§5)。
  const lotMetaById = useMemo(() => {
    const map = new Map();
    lotList.forEach((l) => {
      if (!l) return;
      const id = String(l.id ?? l.__id ?? '');
      if (!id) return;
      map.set(id, {
        orderNo: l.orderNo == null ? '' : String(l.orderNo),
        model: l.model == null ? '' : String(l.model),
        tplName: tplNameOf(templatesById, l.templateId),
      });
    });
    return map;
  }, [lotList, templatesById]);

  const whatifResampleDiff = useMemo(() => {
    if (!groundKey || scenarioKey === 'normal') return null;
    // 追記(2026-08-29 あら探し係): 計算中は前のシナリオの結果が残っている。下の札照合は
    //   ojt と swap が同じ札(successor)なので **この2つの間の入れ替わりを見分けられない**。
    //   計算が終わるまで帯を出さない事で、別のシナリオの差分を数秒間見せる穴を塞ぐ。
    if (loading) return null;
    // 中身が空のシナリオ(=通常と同じ計算)に「変わりませんでした」と言わせない。
    if (scenarioKey === 'absence' && !absenceName) return null;
    if (scenarioKey === 'ojt' && (!ojtName || !ojtProcess)) return null;
    if (scenarioKey === 'swap' && !swapPlan.ready) return null;
    // シナリオを替えた直後、前の結果が1こまだけ残る。その描画では出さない(札で照合)。
    const wantId = SCENARIO_ID_OF[scenarioKey] || null;
    const gotId = (result && result.metrics && result.metrics.scenarioId) || null;
    if (!wantId || gotId !== wantId) return null;
    const store = scenarioStoreRef.current;
    if (store.key !== groundKey) return null;
    const normalEntry = store.byId.get('normal');
    const baseByLot = (normalEntry && normalEntry.resampleByLot) || null;
    const scnByLot = (result && result.base && result.base.resample && result.base.resample.byLot) || null;
    if (!baseByLot || !scnByLot) return null;
    try {
      return buildResampleDiff({ baseByLot, scnByLot, lotMetaById });
    } catch {
      return null;   // 帯が出ない事はあっても、盤全体を巻き込まない
    }
  }, [groundKey, scenarioKey, result, absenceName, ojtName, ojtProcess, swapPlan, lotMetaById, loading]);

  // ── 追記(2026-08-30 画面4分割・清水さんの指示) ─────────────────────────────
  //   どの画面を見ているか。board=盤面(既定) / nextMonth=来月の手当て /
  //   （畳んだ物）today=今日の判断 / month=月ごと / improve=改善・教育。
  //   🚨 値は OPSIM_TABS_MAIN の鍵と1対1。札を足したら **描く枝も足す**（2026-09-05 の欠陥）。
  //   🚨 見せ方の切替だけで、計算・シナリオ・保管庫には1ミリも触らない。
  //   ⚠ 既存 hooks の**後ろ**に追加(順序を1つも動かさない)。ガードより上。
  //   🚨 2026-09-04 決まり13・19: **既定は盤面**（清水さんが「見やすい」と言った唯一の画面が
  //     ここに居る。開いた瞬間に「今日の判断」の文字の壁を出さない）。
  /* ⚠ opsimTab の宣言は上(scopeDays の前)へ移した(2026-09-05)。ここで使うだけ。 */

  /* ⚙ の引き出し(決まり19C)。**設定だけ**を入れる箱。数字は「？」の側。
   *   🚨 hooks はガードより上（2026-08-27 の白画面の根因）。既存の並びは1つも動かしていない。
   *   🚨 既定は閉じている＝開くまで中を1文字も描かない（開いた時だけ作る）。 */
  const [gearOpen, setGearOpen] = useState(false);
  /* 🚨 2026-09-05: 「条件・根拠」の札を外した分、**そこへ行っていた道**を繋ぎ直す為の物。
   *   どの引き出しの、どの場所を探して来たのかを覚えておき、開いた時に **そこを光らせる**。
   *   null=どこも光らせない（⚙ を素で開いた時）。
   *   🚨 見た目だけ。何も確定しない・何も送らない（背景タップの焼き付き対策と同じ考え）。 */
  const [gearFocus, setGearFocus] = useState(null);
  /* ⚙ を開いて、探している場所まで送る。押しても何も起きない道を1つも残さない為の入口。 */
  const openGear = useCallback((section = null) => {
    setGearFocus(section || null);
    setGearOpen(true);
  }, []);

  /* ── 決まり31(2026-09-05 区画A・清水さん「もう画面がぐちゃぐちゃになってる」) ────────
   *   盤の上の段を 9段 → 3段 にする為の「畳んだかどうか」。**1つも消していません**。
   *     whyOpen    … 「？ 数字の意味」。押した時だけ 7つの ？ がそのまま出る
   *     ladderOpen … 🪜 効く手のはしご。押した時だけ 今までの1行が下に出る
   *     sharedOpen … 👥 両方の工場で働ける人。押した時だけ 今までの1行が下に出る
   *     boardDrawer… シナリオ▾ / ⏱▾ の引き出し。**開け閉めのボタンだけ**を操作の1行へ
   *                  移したので、開いているかどうかは Header と揃える
   *                  (揃えないと「押しても引き出しが開かない」になる)
   *   🚨 hooks はガード(return null)より上。既存の並びは1つも動かしていません。
   *   🚨 見た目だけ。何も確定しない・何も送らない・計算し直さない
   *     (押しただけでは1回も割付を引き直しません)。 */
  const [whyOpen, setWhyOpen] = useState(false);
  const [ladderOpen, setLadderOpen] = useState(false);
  const [sharedOpen, setSharedOpen] = useState(false);
  /* ⋯ その他(2026-09-15)の畳みは 2026-09-18 の案A で **🧰 道具箱** になりました。
     状態を1つも出していない引き出しの口4つ(🪜 / 👥 / ⚙ / 🧾)は、道具箱の
     「🕒 納期を守る」と「⚙ 設定と根拠」の箱の中に **そのまま** 居ます(1つも消していない)。
     → 開閉の状態は toolboxOpen ただ 1つになったので、moreOpen は要らなくなりました。 */
  // 🗓 期間の1行(PeriodRunNote)。実測(2026-09-06・1400px): この1行が約500pxあり、操作の行が3行に折り返して
  //   主役(納期一覧)が画面の60%に居た。押した時だけ出す(文は1文字も変えない・PeriodStrip.jsx は触らない)。
  const [periodNoteOpen, setPeriodNoteOpen] = useState(false);
  /* 🧰 2026-09-18 案A: 道具箱(右から出る引き出し)。散らばっていた道具を1か所へ。
     🚨 開いているかは **親が持つ**(Toolbox.jsx は入れ物だけ)。押しただけでは1回も計算しない。 */
  const [toolboxOpen, setToolboxOpen] = useState(false);
  // 🧰 2026-09-19: ⚙ の引き出しは 道具箱より後ろの層(z-50 < z-300)。道具箱の中から ⚙／🧾 根拠 を押した時に 後ろへ開いて見えなかった。
  //   ⚙ が開いたら 道具箱を閉じる(押した物が必ず見える)。
  useEffect(() => { if (gearOpen) setToolboxOpen(false); }, [gearOpen]);
  /* ⚠ 畳んだ警告の1行(BoardWarningsFold)を **外から開ける** ようにする為の状態(2026-09-18)。
     帯の3行目「この答えの土台」の札を押した時に、この2本がそのまま出る
     ＝「押すと一覧が開く」と書いてあるのに何も起きない、を作らない。 */
  const [warnOpen, setWarnOpen] = useState(false);
  const [boardDrawer, setBoardDrawer] = useState(null);   // null | 'scenario' | 'play'
  const toggleBoardDrawer = useCallback((key) => {
    setBoardDrawer((v) => (v === key ? null : key));
  }, []);

  /* ── 期間の切替（決まり19A）で要る、結果側の値 ────────────────────────────
   * 🚨🚨 **札に出す日数は「選んだ期間」ではなく「結果が名乗る日数」**。
   *   選んだだけの値で盤に名前を付けると、まだ計算していない月の名前で
   *   前の期間の盤を出す事になる（基準時刻で一度やった間違いと同じ族）。 */
  /* 🚨🚨 2026-09-05 **実データで撮って初めて出た欠陥**（コードの読み合わせでは出なかった）:
   *   最初 normalized 側の日数から取っていたが、Worker が返す normalized には
   *   **その鍵が無い**（normalizeInput は持っているのに、返す時に落ちている）。
   *   そのため盤が「この期間」としか言えず、期間を変えても文字が1つも変わらなかった。
   *   結果が名乗る日数の置き場は **result.meta.horizonDays ただ1つ**。 */
  const resultDays = (result && result.meta && Number.isFinite(Number(result.meta.horizonDays)))
    ? Number(result.meta.horizonDays) : null;
  useEffect(() => {
    if (loading || !fullRunStartedRef.current) return;
    const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    if (t > fullRunStartedRef.current) setFullRunSeconds((t - fullRunStartedRef.current) / 1000);
    fullRunStartedRef.current = 0;
  }, [loading, result]);
  /* 🚨 決まり19A・親の指示5（黙って放置しない）:
   *   6営業日以上の期間では盤の記録が **1日ごと** にしか無いので、0.3日ずつ進めても
   *   同じ1枚の記録が選ばれ、札の残り時間が動かない（実測6回中3回）。
   *   → 刻みを 1日 へ **見える形で** 上げる（札も「1日」に変わる）。黙って中身だけ変えない。 */
  useEffect(() => {
    if (!opsimNeedsDayStep(resultDays)) return;
    setPlayStep((cur) => (opsimStepOf(cur).day != null && opsimStepOf(cur).day >= 1 ? cur : 'd1'));
  }, [resultDays]);

  /* ── 追記(2026-09-01 清水さん「拡大ボタンがなくなってた」) ────────────────────
   *   盤だけを **窓いっぱい** に出す。上の帯・タブバー・左右の余白に食われていた分を返す。
   *   🚨 名前は「⤢ 拡大」「× 閉じる」。到着予定の一覧(src/App.jsx:8213)と **同じ言葉**に
   *     揃えた（清水さんが見慣れている物と別の言い方をしない）。
   *   🚨 結論の1行は必ず残す（BoardConclusionLine）。盤だけ大きくても
   *     「で、どうなの」が読めない画面にしない。
   *   ⚠ 既存 hooks の**後ろ**に追加（順序を1つも動かさない）。ガード（return）より上。 */
  const [boardFull, setBoardFull] = useState(false);
  const closeBoardFull = useCallback(() => setBoardFull(false), []);
  /* 🚨🚨 実画面で見つけた欠陥（2026-09-01・私の直しの中の欠陥）:
   *   この帯は z-40（作業画面 z-50 より下に居なければならない）。ところが
   *   アプリの一番上の帯も z-50 なので、fixed inset-0 の一番上 **52px が覆われ**、
   *   そこに置いた **結論の1行が丸ごと隠れていた**。
   *   ＝「盤だけ大きくても『で、どうなの』が読めない画面」そのものを、私が作っていた。
   *   ⚠ コードの読み合わせでは出なかった。実画面を撮って初めて出た。
   *
   *   直し方: z を上げない（上げると作業画面を覆う＝2026-08-30 の2つ目の壊れ方に戻る）。
   *   代わりに **何に覆われているかを実測して、その下から描く**。
   *   ⚠ 帯の高さを px で決め打ちしない。文字サイズ設定(applyFontSizes)で高さが変わる。
   *   ⚠ 画面の真ん中の縦線を上から順に突いて、**最初にこの帯が答えた所** から描く。
   *     どの部品が上に居るかを当てにしないので、上の帯の作りが変わっても付いていく。 */
  const boardFullRef = useRef(null);
  const [fullTopPx, setFullTopPx] = useState(0);
  useEffect(() => {
    if (!boardFull) { setFullTopPx(0); return undefined; }
    const measure = () => {
      const el = boardFullRef.current;
      if (!el || typeof document.elementFromPoint !== 'function') return;
      const x = Math.round(window.innerWidth / 2);
      let y = 0;
      for (; y <= 240; y += 4) {
        const hit = document.elementFromPoint(x, y);
        if (hit && el.contains(hit)) break;
      }
      setFullTopPx(y > 240 ? 0 : y);
    };
    measure();
    // 描き終わってからもう一度（開いた直後は上の帯がまだ並び終わっていない事がある）
    const t = setTimeout(measure, 300);
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('resize', measure); clearTimeout(t); };
  }, [boardFull]);
  // 閉じる道は2つ（ボタン ＋ Esc）。🚨 どちらも **閉じるだけ**。何も確定しない。
  useEffect(() => {
    if (!boardFull) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setBoardFull(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [boardFull]);
  // 盤面タブから離れたら畳む（別のタブの中身が全画面の下に隠れたままにしない）。
  useEffect(() => { if (opsimTab !== 'board') setBoardFull(false); }, [opsimTab]);
  /* 🚨 盤の入れ物の高さは「盤の上端から窓の下端まで」を **実測** して決める（2026-09-04 決まり6・7）。
   *   前は winH−190 の決め打ちで、1280×800 では盤の下 1/4 が窓の外だった（実測: 盤 436〜906px）。
   *   ⚠ px の決め打ちをしない（文字サイズ設定で上の帯の高さが変わる）。測るのは盤を包む箱の上端。
   *   ⚠ 既存 hooks の後ろ・ガードより上。見た目だけ。何も確定しない。 */
  const boardWrapRef = useRef(null);
  const [boardTopPx, setBoardTopPx] = useState(0);
  useEffect(() => {
    if (opsimTab !== 'board' || viewMode !== 'board' || boardFull) { setBoardTopPx(0); return undefined; }
    const measure = () => {
      const el = boardWrapRef.current;
      if (!el) return;
      const top = Math.round(el.getBoundingClientRect().top);
      setBoardTopPx(top > 0 ? top : 0);
    };
    measure();
    // 描き終わってからもう一度（開いた直後は上の帯がまだ並び終わっていない事がある）
    const t = setTimeout(measure, 300);
    window.addEventListener('resize', measure);
    /* 🚨🚨 2026-09-05 出荷前の検めで見つかった穴（2026-08-24「帯を足した分を引かずに
        盤を窓の外へ押し出す」の再発）:
        決まり31 で 🪜/👥/？ を **常設から「押した時だけ描く」** へ変えました。
        押すと RescueLadder / SharedWorkerStrip の1行ぶん（数十〜百数十px）
        盤の上端が下へ動きます。？ を開くと操作の1行が折り返して同じ事が起きます。
        deps に入れていないと boardTopPx は古いままで heightPx が大きすぎになり、
        **盤の下が窓の外へ出ます**。resize と 300ms の測り直しは この effect が
        動き直した時しか掛からないので、押しただけでは一度も測り直しませんでした。
        🚨 この4つを1つでも外すと、その畳みを開いた時に盤が窓からはみ出します。
          見張り A31-7 が数で赤にします。 */
    return () => { window.removeEventListener('resize', measure); clearTimeout(t); };
  }, [opsimTab, viewMode, boardFull, result, whyOpen, ladderOpen, sharedOpen, periodNoteOpen, boardDrawer]);

  // 追記(2026-08-30 清水さん「ロットを押した時だけ、右から詳細を開く」) ────────────
  //   引き出しを閉じる＝選んでいない状態へ戻すだけ。
  //   🚨 ここで確定・送信・取り消しへ行く道は1本も無い（2026-08-21 の背景タップ事故の形を作らない）。
  //   ⚠ 既存 hooks の**後ろ**に追加（順序を1つも動かさない）。ガード（return）より上。
  const handleCloseDetail = useCallback(() => { setSelectedLotId(null); }, []);

  // 任せ替えの注記(契約C5)。実測0件の工程も「仮の単独可」として数える事を正直に言う。
  const swapNote = swapPlan.ready
    ? `いつも通りの割付から、${swapPlan.from} さんの工程 ${swapPlan.processKeys.length}件が対象です。${swapPlan.to} さんは、その工程を今すぐ単独で持てる仮定になります。実測が1件も無い工程も仮の単独可として数えます（記録が無い＝分かりません、です）。割付そのものは計算が空きを見て決めます。`
    : (scenarioKey === 'swap'
      ? swapPlan.reason
      : '任せ替え先の人は「その工程を今すぐ単独で持てる」仮定になります。実測が1件も無い工程も仮の単独可として数えます（記録が無い＝分かりません、です）。');

  // 🧹 2026-09-24 毎回 新しい [] を作ると 下の useMemo が毎回作り直しになる(react-hooks/exhaustive-deps)。答えが変わった時だけ
  const lotResults = useMemo(() => (Array.isArray(result && result.base && result.base.lotResults) ? result.base.lotResults : []), [result]);
  const audit = Array.isArray(result && result.base && result.base.audit) ? result.base.audit : [];
  const unresolved = Array.isArray(result && result.base && result.base.unresolved) ? result.base.unresolved : [];
  const explain = (result && result.explain) || null;
  const normalized = (result && result.normalized) || null;
  const diagnostics = (normalized && normalized.diagnostics) || null;

  // ── 🪜 効く手のはしご(決まり23)。ここは「はしご」の受け持ちの区画 ────────────
  //   🚨 hooks はガード(return)より上。ここは既存 hooks の後ろへ**足すだけ**。
  //   🚨 数字は1つも作らない。段の条件は rescueLadder.js、引き直しは ladderRunner.js。
  const ladderLotsById = useMemo(() => lotsByIdOf(duePartition.simLots), [duePartition.simLots]);
  // 品目コードに添える文字(決まり12)。製品検査は **テンプレ名**。引き方は tplNameOf ただ1本。
  const ladderSubOf = useCallback(
    (lot) => tplNameOf(templatesById, lot && lot.templateId) || '',
    [templatesById],
  );
  // 📋 2026-09-15 自分の納期一覧の行(相手の工場が「両方の納期一覧」を同時に見る為の材料)。
  //   🚨 数は DueCalendar と同じ純関数(dueRowFacts / mainWorkerOf)。ここで数え直さない。
  // 🧷 答えが出るたびに「前回の主担当」を覚える(次の引き直しの合図。数は mainWorkerOf そのまま)。
  useEffect(() => {
    if (!result || !result.base || !Array.isArray(result.base.assignments)) return;
    const byLot = assignmentsByLot(result.base.assignments);
    const prev = {};
    for (const [lotId, list] of byLot) { const m = mainWorkerOf(list); if (m && m.worker) prev[lotId] = m.worker; }
    scenarioHintsRef.current = Object.keys(prev).length ? { prevWorkers: prev } : {};
  }, [result]);
  // 👤📊 2026-09-17 優先がどれだけ効いたか／この期間の負荷(純関数。画面で数を作らない)
  //   ⚠ Worker の答え(result.normalized)は軽くしてある事があるので、仕事の一覧と名簿は 画面が持つ normalized(同じ normalizeInput の答え)から読む。
  const prefStats = useMemo(() => { const nz = (result && result.normalized && result.normalized.jobs) ? result.normalized : normalized; return (result && result.base && nz && Array.isArray(nz.jobs))
    ? templatePrefStats({ assignments: result.base.assignments, jobs: nz.jobs, prefs: tplPrefsForSim }) : null; }, [result, normalized, tplPrefsForSim]);
  const loadByWorker = useMemo(() => { const nz = (result && result.normalized && result.normalized.jobs && result.normalized.workers) ? result.normalized : normalized; return (result && result.base && nz && Array.isArray(nz.jobs) && Array.isArray(nz.workers) && timeline)
    ? workerLoadInWindow({ assignments: result.base.assignments, jobs: nz.jobs, workers: nz.workers, fromMs: timeline.startMs, toMs: timeline.endMs }) : null; }, [result, normalized, timeline]);
  const hereDueRows = useMemo(() => {
    if (!result || !result.base || !Array.isArray(normalizedLots)) return [];
    const byLot = assignmentsByLot(result.base.assignments);
    return normalizedLots.map((l) => {
      if (!l || l.lotId == null) return null;
      const id = String(l.lotId);
      const F = dueRowFacts({ verdict: lotVerdictById ? lotVerdictById.get(id) : null, lot: l, nowMs: baseNowMs });
      const main = mainWorkerOf(byLot.get(id) || []);
      return { lotId: id, orderNo: l.orderNo, model: l.model, sub: tplNameOf(templatesById, l.templateId), qty: l.quantity, worker: main.worker, tier: F.tier, dueMs: F.dueMs, finishMs: F.finishMs, lateDays: F.lateDays, pastDays: F.pastDays, why: F.blocked,
        // 📋 2026-09-16 手が付いている区間(相手の工場が同じ棒の形で見る為)。数は割付の和集合そのまま(DueCalendar と同じ mergeSpans)
        spans: mergeSpans((byLot.get(id) || []).map((a) => [a.startMs, a.endMs])) };
    }).filter(Boolean);
  }, [result, normalizedLots, lotVerdictById, baseNowMs, templatesById]);
  // ── 📦 区画B(2026-09-06): 村さんを どの営業日は製品・どの営業日は最終 に置くか ──────────
  // 自分の工場の「日ごとの負荷」1枚。🚨 時計は中で読ませない(baseNowMs を渡す)。数字は純関数が数える。
  // 🚚 移動先(最終検査)の勤務時間・休み・技能の記録 = 相手の daily_load の欄 routeInputs(購読済みの物。読み直さない)
  const routeInputsByArea = useMemo(() => ({ final: otherAppDailyLoad && otherAppDailyLoad.routeInputs ? otherAppDailyLoad.routeInputs : null }), [otherAppDailyLoad]);
  const hereDailyLoad = useMemo(() => {
    const d = (!normalized || !result || !result.base) ? null : buildDailyLoadDoc({
      normalized,
      base: result.base,
      roster: workerList,
      sharedNames: otherAppWorkerNames ? workerList.map((w) => w.name).filter((n) => otherAppWorkerNames.includes(n)) : [],
      app: 'parts',
      nowMs: baseNowMs,
    });
    // 📦 2026-09-12 決めた配置を書類の1欄(placement)に載せる。相手の工場がこれを読んで自分の盤に効かせる。
    //   🚨 指紋にも配置の鍵を混ぜる(配置を変えた時も書く)。書く effect は「指紋が同じなら書かない」のまま。
    if (!d) return d;
    // 📋 2026-09-15 自分の納期一覧の行も載せる(相手の工場が「両方の納期一覧」を同時に見る為)。指紋にも鍵を混ぜる。
    const dueList = buildDueListDoc({ rows: hereDueRows, app: 'parts', nowMs: baseNowMs, horizonEnd: normalized.horizonEnd });
    const withDue0 = dueList ? { ...d, dueList, fingerprint: `${d.fingerprint}|due:${dueList.key}` } : d;
    // 🚚 2026-09-22 エリア移動の判断に要る 勤務時間・休み・技能の記録 を相乗り(書く口を増やさない。指紋に鍵を混ぜる)
    const ri = buildRouteInputs({ normalized, eligibleNamesByProcess: result.eligibleNamesByProcess || null, app: 'parts', nowMs: baseNowMs });
    const withDue = ri.ok ? { ...withDue0, routeInputs: ri, fingerprint: `${withDue0.fingerprint}|ri:${ri.key}` } : withDue0;
    if (!decidedPlacement) return withDue;
    return { ...withDue, placement: decidedPlacement, fingerprint: `${withDue.fingerprint}|${placementKey(decidedPlacement)}` };
  }, [normalized, result, workerList, otherAppWorkerNames, baseNowMs, decidedPlacement, hereDueRows]);
  // 📦 共有棚へ書く(2026-09-06 清水さん承認)。**計算1回につき最大1件**。指紋が前と同じなら 0件。
  //   失敗したら指紋を戻して次の計算で書き直す。🚨 setInterval では書かない(枠の見張り verify-write-budget の形)。
  const publishedFpRef = useRef(null);
  useEffect(() => {
    if (typeof publishDailyLoad !== 'function') return;
    // 🚨 2026-09-17 清水さんの言葉「配置ボタンしたら、次開いたら忘れてることある」
    //   棚を **読み終えるまで書かない**。読む前に書くと、前に決めた配置(placement)の入っていない
    //   書類で棚を丸ごと置き換え(merge:false)、決めた配置がその場で消える。
    //   ⚠ 書く回数は増えない(指紋が同じなら書かないのはそのまま)。書き始めが少し遅れるだけ。
    if (!capacityShelfLoaded) return;
    if (!hereDailyLoad || !hereDailyLoad.ok) return;
    if (publishedFpRef.current === hereDailyLoad.fingerprint) return;
    publishedFpRef.current = hereDailyLoad.fingerprint;
    // 🚨 2026-09-19: 窓口は 書けた時 true / 書かなかった時 false を返し分ける(最終検査と同じ形)。
    //   返事を捨てると「書いたつもり」で指紋を覚えたまま二度と書き直さない。失敗は黙って捨てず、必ず声に出す。
    Promise.resolve(publishDailyLoad(hereDailyLoad))
      .then((wrote) => {
        if (wrote) return;
        publishedFpRef.current = null;
        console.warn('[共有棚] 日ごとの負荷を書きませんでした(窓口が false を返しました)');
      })
      .catch((e) => {
        publishedFpRef.current = null;
        console.error('[共有棚] 日ごとの負荷の書き込みに失敗しました', e);
      });
  }, [capacityShelfLoaded, hereDailyLoad, publishDailyLoad]);
  // 決め方(平均で決める／どちらを優先／最低◯日は同じ工場)。🚨 書く時は **生の入れ物** を広げる(派生物を広げると他の鍵が消える・2026-08-17 の形)。
  //   🚨 SETTINGS_KEYS(指紋)へ sharedWorkerPlan を **足さない**: 割付の入力を変えない(効くのは純関数だけ)。足すと つまみの度に盤ぜんぶが引き直る。
  const curShared = useMemo(() => ((settings && settings.sharedWorkerPlan) || {}), [settings]);
  const sharedPlanSetting = useMemo(() => ({
    mode: curShared.mode === 'priority' ? 'priority' : 'balance',
    priority: Number.isFinite(Number(curShared.priority)) ? Number(curShared.priority) : 0.5,
    minBlockDays: Number.isFinite(Number(curShared.minBlockDays)) ? Number(curShared.minBlockDays) : 1,
  }), [curShared]);
  const onChangeSharedPlanMode = useCallback((mode) => {
    if (!canEdit || typeof saveSettings !== 'function') return;
    saveSettings({ sharedWorkerPlan: { ...curShared, mode } });
  }, [canEdit, saveSettings, curShared]);
  const onChangeSharedPlanPriority = useCallback((priority) => {
    if (!canEdit || typeof saveSettings !== 'function') return;
    saveSettings({ sharedWorkerPlan: { ...curShared, priority } });
  }, [canEdit, saveSettings, curShared]);
  const onChangeSharedPlanMinBlockDays = useCallback((minBlockDays) => {
    if (!canEdit || typeof saveSettings !== 'function') return;
    saveSettings({ sharedWorkerPlan: { ...curShared, minBlockDays } });
  }, [canEdit, saveSettings, curShared]);
  // ── 📦 ここまで ──────────────────────────────────────────────────────
  const ladderRun = useCallback((plan) => runLadderRung({
    plan,
    lots: duePartition.simLots,
    templates: templateList,
    workers: workerList,
    settings,
    factoryCalendar,
    now: baseNowMs,
    scenario,
    mode,
    estimateMode,
    scopeFilter,
  }), [duePartition.simLots, templateList, workerList, settings, factoryCalendar,
    baseNowMs, scenario, mode, estimateMode, scopeFilter]);
  // ── 🪜 ここまで ───────────────────────────────────────────────────────────

  // ── 🕒 納期対応の残業・土曜(必要分)(2026-09-16)。押した時だけ Worker(kind:'overtimePlan')を1回回す ──
  //   🚨 材料は盤と同じ(ロット・名簿・設定・暦・基準時刻・scenario・範囲)。数字は Worker(純関数)が返した物をそのまま出す。
  //   ⚠ いま採用中の案(extraByDay / workOnDays)は scenario から **外して** から回す
  //     (採用中の案の上にさらに足す計算にしない。「いまの見立てに必要な分」を出す)。
  const overtimePlanRun = useCallback(() => {
    const sc = { ...scenario, compareAllSkills: false, factoryCalendar: factoryCalendar || null };
    delete sc.extraByDay;
    delete sc.workOnDays;
    const scopeLotIds = [];
    (duePartition.simLots || []).forEach((lot) => {
      if (!isOpenLot(lot)) return;
      let ok = false; try { ok = !!scopeFilter(lot); } catch { ok = false; }
      if (!ok) return;
      const id = docIdOf(lot);
      if (id) scopeLotIds.push(id);
    });
    scopeLotIds.sort();
    return runOvertimePlanPayload({
      lots: duePartition.simLots,
      templates: templateList,
      workers: workerList,
      settings: settings ? { ...settings, factoryCalendar: factoryCalendar || settings.factoryCalendar || null } : (factoryCalendar ? { factoryCalendar } : {}),
      now: baseNowMs,
      horizonDays,
      scenario: sc,
      mode,
      estimateMode,
      scopeLotIds,
      overtime: { stepMin: 30, maxIterations: 40 },
    });
  }, [duePartition.simLots, templateList, workerList, settings, factoryCalendar, baseNowMs, horizonDays, scenario, mode, estimateMode, scopeFilter]);

  /**
   * ⚠仮の入荷日の帯(AssumedArrivalStrip)の材料（2026-08-31 清水さん「そこはわかりやすくして」）。
   * 🚨 仮で置いた件数と顔ぶれは engine が返した unknowns.arrivalAssumed **そのまま**
   *   （画面で数え直すと2つの数がズレる）。詳細(指図・品目コード・仮に置いた日・納期)は
   *   normalized.lots から同じ lotId で引くだけ。
   * 🚨 「入荷日も納期も無い」物は起点が無いので仮にも置けない。混ぜずに別に数える
   *   （黙って混ぜるなという 2026-08-22 の決まりと同じ形）。
   * ⚠ offCandidates は OFF(実データだけ)の時に「仮に置けば動く物」を言う為の数。
   *   仮置きの対象条件(入荷が無い/予定超過 × 納期あり)と同じ式で、ONの時は
   *   rows と同じ顔ぶれになる（normalizeInput は仮を当てた後も arrivalUnknown/Overdue の
   *   印を残すので、この式はON/OFFどちらでも同じ物を指す）。
   */
  const assumedInfo = useMemo(() => {
    if (!normalized) return null;
    const u = normalized.unknowns || {};
    const byId = new Map(normalizedLots.map((l) => [l.lotId, l]));
    const rows = (Array.isArray(u.arrivalAssumed) ? u.arrivalAssumed : [])
      .map((id) => {
        const l = byId.get(id) || {};
        return {
          lotId: id,
          orderNo: l.orderNo || '',
          model: l.model || '',
          tplName: tplNameOf(templatesById, l.templateId),
          arrivalMs: isNum(l.arrivalMs) ? l.arrivalMs : null,
          dueMs: isNum(l.dueMs) ? l.dueMs : null,
          // 🚨 2026-09-04: 「仮」の2通りを **engine の判定そのまま** 運ぶ（画面で日付から数え直さない）。
          //   'beforeDue' = 納期のN日前に置けた ／ 'clampedToNow' = N日前が過ぎていて基準時刻に置いた
          assumedKind: l.arrivalAssumedKind || null,
          // 丸める前の「納期のN日前」。行の title に式を書く材料。
          wantMs: isNum(l.arrivalAssumedWantMs) ? l.arrivalAssumedWantMs : null,
        };
      })
      .sort((a, b) => ((a.dueMs ?? Infinity) - (b.dueMs ?? Infinity))
        || String(a.lotId).localeCompare(String(b.lotId)));
    const hasUn = (l, k) => Array.isArray(l.unknowns) && l.unknowns.includes(k);
    const noAnchor = normalizedLots
      .filter((l) => hasUn(l, 'dueUnknown') && (hasUn(l, 'arrivalUnknown') || hasUn(l, 'arrivalOverdue')))
      .map((l) => ({ lotId: l.lotId, orderNo: l.orderNo || '', model: l.model || '', tplName: tplNameOf(templatesById, l.templateId) }));
    const offCandidates = normalizedLots
      .filter((l) => !hasUn(l, 'dueUnknown') && (hasUn(l, 'arrivalUnknown') || hasUn(l, 'arrivalOverdue')))
      .length;
    /**
     * 🚨🚨 2026-09-04 清水さん「納期の2日前に着くって話なのに 添付で見たら全然違うからいいかげんにして」。
     *   件数は **engine の1つの計算**(inputQuality.arrivalPreset = arrivalAccounting)から取る。
     *   ここで rows を数え直すと、同じ数字が2つの計算から出て また食い違う。
     */
    const acc = (normalized.inputQuality && normalized.inputQuality.arrival) || null;
    const split = acc ? {
      total: Number(acc.assumedCount) || 0,
      beforeDue: Number(acc.assumedBeforeDueCount) || 0,
      clamped: Number(acc.assumedClampedCount) || 0,
      kindUnknown: Number(acc.assumedKindUnknownCount) || 0,
    } : null;
    return { rows, noAnchor, offCandidates, split };
  }, [normalized, normalizedLots, templatesById]);
  const snapshotCount = (timeline && timeline.snaps.length) || 0;
  const scopedCount = Number(result && result.meta && result.meta.lotsScoped);

  /* 上の警告2本（納期の更新が必要／仮の入荷日）。中身は1つ。置き場所がタブで変わるだけ（2026-09-04）:
       盤面タブ … Header の一番上の行の左に、件数だけの1行（BoardWarningsFold）で。「開く」でこの2本がそのまま出る。
       他のタブ … 今まで通り Header の上に2本。 */
  const warningStrips = (
    <>
      <DueConflictStrip conflicts={duePartition.conflicts} templatesById={templatesById} />
      {/* ⚠仮の入荷日の帯(2026-08-31 清水さん「そこはわかりやすくして」)。
          🚨 どれが仮か・後から本物が入ればそちらで計算し直す事を、開いた直後・スクロール無しで言う。 */}
      <AssumedArrivalStrip
        on={assumeArrivalDays > 0}
        days={assumeArrivalDays > 0 ? assumeArrivalDays : 2}
        info={assumedInfo}
        onAssume={setAssumeArrivalDays}
        /* 🚨 2026-09-04: 丸めた先の実際の時刻。「次の勤務開始(9/7 08:30)」を数字で言う為に要る。 */
        baseNowMs={baseNowMs}
        baseShifted={baseShifted}
      />
    </>
  );
  /* 🧮 2026-09-18 案A「この答えの土台」の札の材料。
     🚨🚨 数は **ここで 1回だけ** 数え、帯の札と畳んだ警告の1行の **両方に同じ変数を渡す**。
       （同じ数字を 2つの計算から出さない。以前はこの行が BoardWarningsFold の中で直接数えていた） */
  const noHandCount = lotResults.filter((r) => r && r.finishMs == null && r.blocked != null).length;
  const missingEstimateCount = (normalized && normalized.inputQuality && Number(normalized.inputQuality.missingEstimateCount)) || 0;
  const alwaysSkippedInfo = useMemo(
    () => (normalized && normalized.inputQuality && normalized.inputQuality.alwaysSkipped
      ? { ...normalized.inputQuality.alwaysSkipped, rows: normalized.inputQuality.alwaysSkippedRows || [] } : null),
    [normalized],
  );
  const assumedCount = assumedInfo && Array.isArray(assumedInfo.rows) ? assumedInfo.rows.length : 0;
  const conflictCount = duePartition.conflicts.length;
  /** 帯の3行目「この答えの土台」。0件の札は出さない（無い物を札にしない）。
   *  🚨 2026-09-19: 警告の畳んだ1行(BoardWarningsFold の parts)と **同じ集合** にする(off／noAnchor が札に無く、1行を隠すと どこにも出なかった)。 */
  const offCandidatesCount = assumedInfo ? Number(assumedInfo.offCandidates) || 0 : 0;
  const noAnchorCount = assumedInfo && Array.isArray(assumedInfo.noAnchor) ? assumedInfo.noAnchor.length : 0;
  const snapCov = result && result.base ? result.base.snapshotCoverage : null;
  const basisChips = useMemo(() => {
    const out = [];
    // 🚨 記録が途中で切れている(30日と言って12.5日、を二度と出さない)。いちばん前に赤で。全文は title と、押して開く警告の帯。
    if (snapCov && snapCov.requested > 0 && !snapCov.complete) {
      out.push({ key: 'coverage', label: '画面の記録 途中まで', n: Number(snapCov.captured) || 0, suffix: `/${fmtInt(snapCov.requested)}枚`, tone: 'rose',
        title: `この見立ては ${snapCov.requestedLastElapsedDays}日ぶんを頼みましたが、${snapCov.lastElapsedDays == null ? '—' : snapCov.lastElapsedDays}日ぶんまでしか残っていません。この画面を「${snapCov.requestedLastElapsedDays}日ぶん見た」と読まないでください。` });
    }
    if (assumeArrivalDays > 0 && assumedCount > 0) {
      out.push({ key: 'assumed', label: '仮の入荷日', n: assumedCount, tone: 'amber',
        title: `入荷日が分からない ${assumedCount}件を、納期の${assumeArrivalDays}日前に仮に置いて計算しています。押すと内訳が出ます。` });
    }
    if (noHandCount > 0) {
      out.push({ key: 'noHand', label: '手が付かない', n: noHandCount, tone: 'rose',
        title: '終わる時刻が出ず、理由が付いているロットの件数です。理由は納期一覧の行に出ています。' });
    }
    if (alwaysSkippedInfo && alwaysSkippedInfo.applied && Number(alwaysSkippedInfo.stepCount) > 0) {
      out.push({ key: 'skip', label: '記録で飛ばす工程', n: Number(alwaysSkippedInfo.stepCount), tone: 'slate',
        title: skipHistoryText(alwaysSkippedInfo.rows || []) });
    }
    if (missingEstimateCount > 0) {
      out.push({ key: 'missEst', label: '工数が分からない', n: missingEstimateCount, tone: 'slate',
        title: '標準の時間も過去の記録も無い工程の数です。' });
    }
    if (conflictCount > 0) {
      out.push({ key: 'conflict', label: '納期の更新が必要', n: conflictCount, tone: 'rose',
        title: '入荷が納期より後になっているロットです（入荷登録されたら納期も直す決まり。2026-08-28）。' });
    }
    if (!(assumeArrivalDays > 0) && offCandidatesCount > 0) {
      out.push({ key: 'off', label: '入荷日が無い', n: offCandidatesCount, tone: 'slate',
        title: '入荷日が無いロットです。仮の入荷日を置いていないので、判定がつきません。押すと内訳と「仮に置く」の口が出ます。' });
    }
    if (noAnchorCount > 0) {
      out.push({ key: 'noAnchor', label: '入荷日も納期も無い', n: noAnchorCount, tone: 'slate',
        title: '入荷日も納期も無いので、仮の入荷日も置けないロットです。押すと一覧が出ます。' });
    }
    return out;
  }, [assumeArrivalDays, assumedCount, noHandCount, alwaysSkippedInfo, missingEstimateCount, conflictCount, offCandidatesCount, noAnchorCount, snapCov]);

  /* 🧭 2026-09-23 今日決めること(3つ)＋遅れる・止まるロットの理由の表。
     🚨 数は todayDecisionsOf ただ1本。納期の更新が必要は 帯の札と同じ一覧(duePartition.conflicts)、
        仮の入荷日は エンジンの unknowns.arrivalAssumed(帯の札と同じ一覧)。 */
  const decisionsModel = useMemo(() => todayDecisionsOf({
    lotResults,
    conflictLotIds: duePartition.conflicts.map((c) => c.id),
    assumedLotIds: assumeArrivalDays > 0 && normalized && normalized.unknowns ? normalized.unknowns.arrivalAssumed : [],
  }), [lotResults, duePartition.conflicts, assumeArrivalDays, normalized]);
  const decisionsNode = (
    <TodayDecisions
      model={decisionsModel}
      lotLabelOf={(id) => {
        const l = ladderLotsById && typeof ladderLotsById.get === 'function' ? ladderLotsById.get(String(id)) : (ladderLotsById ? ladderLotsById[String(id)] : null);
        if (!l) return null;
        return { main: l.model || l.orderNo || String(id), sub: [l.orderNo ? `指図 ${l.orderNo}` : '', l.quantity ? `×${l.quantity}` : ''].filter(Boolean).join(' ') };
      }}
      onPickLot={(id) => { setBoardFull(false); setSelectedLotId(String(id)); }}
    />
  );

  const boardWarningsLine = (
    <BoardWarningsFold
      fold
      open={warnOpen}
      onOpenChange={setWarnOpen}
      /* 📐 2026-09-18 夜: 閉じている間の1行(約70px)は 帯の「この答えの土台」の札と同じ数。札が在る時は出さない(札を押せば今までどおり開く)。 */
      hideClosedLine={Array.isArray(basisChips) && basisChips.length > 0}
      conflictCount={conflictCount}
      assumedOn={assumeArrivalDays > 0}
      assumedCount={assumedCount}
      offCandidates={offCandidatesCount}
      noAnchorCount={noAnchorCount}
      /* 🚨 2026-09-04: 仮の2通りを畳んだ1行にも運ぶ。件数は engine の1つの計算そのまま。 */
      assumedDays={assumeArrivalDays > 0 ? assumeArrivalDays : 2}
      assumedBeforeDue={assumedInfo && assumedInfo.split ? assumedInfo.split.beforeDue : null}
      assumedClamped={assumedInfo && assumedInfo.split ? assumedInfo.split.clamped : null}
      /* 🚨 2026-09-17 入力の健康状態を隠さない。数は **もう画面が持っている物** だけ(新しい集計を作らない)。
         手が付かない = エンジンの lotResults で 終わる時刻が無く(finishMs==null)、理由(blocked)が付いている行の数。
         工数が分からない = normalized.inputQuality.missingEstimateCount(条件・根拠の画面と同じ数)。 */
      noHandCount={noHandCount}
      missingEstimateCount={missingEstimateCount}
      /* 🚫 記録で飛ばす工程(2026-09-18)。数は normalizeInput の inputQuality.alwaysSkipped そのまま(行は worker が添えた alwaysSkippedRows)。 */
      alwaysSkipped={alwaysSkippedInfo}
    >
      {warningStrips}
    </BoardWarningsFold>
  );

  // 📦🔄 2026-09-19 共有棚を書き直すためだけに置かれている時は、画面を1つも描かない。
  //   🚨 hooks は全部この上に在る(ガードより上の決まり)。計算も書き込みも hooks の中なので、描かなくても今までどおり動く。
  if (publishOnly) return <span hidden data-opsim-bg-publish={loading ? 'calculating' : (hereDailyLoad && hereDailyLoad.ok ? 'ready' : 'waiting')} data-opsim-load-fp={(hereDailyLoad && hereDailyLoad.ok ? String(hereDailyLoad.fingerprint || '') : '')} />;

  return (
    <div className="h-full flex flex-col overflow-hidden" data-opsim-load-fp={(hereDailyLoad && hereDailyLoad.ok ? String(hereDailyLoad.fingerprint || '') : '')}>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-3 pb-8 pr-0.5">
{/* 🧹 2026-09-23: 閉じた2枚(計画の保存・並列ラボ)を1段に並べる。開いた方は1段まるごと使う */}
<div className="flex flex-wrap items-start gap-2 [&>*]:min-w-0 [&>*]:flex-1 [&>*]:basis-[24rem] [&>details[open]]:basis-full [&>*:has(>button[aria-expanded=true])]:basis-full">
{PLAN_CONTROL_SHOWN ? <PlanControlPanel planShelf={planShelf} app="parts" result={result} receipt={sim.planReceipt} currentRunKey={sim.planRunKey} loading={loading} lots={lotList} templates={templateList} canEdit={canEdit} onApplyLocks={setPlanJobLocks} locksActive={Object.keys(planJobLocks).length > 0} rangeKey={rangeKey} onRestoreContext={p => { setPanelNow(p.context.fromMs); setBaseMode(BASE_TIME_MODE.NOW); setRangeKey(p.rangeKey || 'd5'); setPlanJobLocks({}); }}
  conditions={{ now: baseNowMs, horizonDays, rangeKey, mode: effMode, estimateMode: effEstimateMode, scenario: effScenario }}
  onRestoreConditions={setRestoredConditions} restoredRevision={restoredConditions ? restoredConditions.revision : null} /> : null}
{/* 🧪 2026-09-22 夜 並列作業の比較シミュレーション(ラボ)。本番の割付・版・現場の指示には書かない(条件だけ settings.opsim.parallelLab)
    🚨 2026-09-23 本番の控えで効き目 0件なので下げる(PARALLEL_LAB_SHOWN)。代わりに ChatGPT の見本 */}
{PARALLEL_LAB_SHOWN ? <ParallelLabPanel lots={lotList} result={result} settings={settings} nowMs={baseNowMs} canEdit={canEdit} saveOpsim={saveOpsim} runRung={ladderRun} adopted={adoptedParallelLab} /> : null}
{/* 🚶 2026-09-26 1ロットずつ(既定)／掛け持ちあり の切り替えと、両方で引き直して並べる帯 */}
<JugglingStrip mode={jugglingMode} onMode={(v) => saveOpsim({ [JUGGLING_KEY]: v })} built={jugglingBuilt} runRung={ladderRun} disposeRun={disposeLadderWorker} horizonDays={horizonDays} inputKey={sim.planRunKey || ''} canEdit={canEdit} lotLabel={(id) => { const lot = (lotList || []).find((x) => x && (x.id === id || x.__id === id)); if (!lot) return id; const tplName = (templatesById && templatesById.get && templatesById.get(String(lot.templateId))?.name) || 'テンプレ名なし'; return `${lot.model || ''}｜${tplName} ${lot.orderNo || ''}`.trim() || id; }} />
{LOT_PAIR_SHOWN && <LotPairLab lots={lotList} templatesById={templatesById} settings={settings} canEdit={canEdit} isAdmin={isAdmin} saveOpsim={saveOpsim} estimateMode={effEstimateMode} readOverviewMap={readOverviewMap} />}
</div>

          {/* タブの外(常に上): ⚠納期の更新が必要(矛盾)の赤帯だけは全タブで上に残す(清水さん指示 2026-08-30)。
              旧S2Stripは3つに割った: 矛盾帯=ここ / staleの帯=条件・根拠タブ / 🎲=今日の判断タブの1行折りたたみ。 */}
          {/* 🚨 盤面タブでは、この警告2本を **件数だけの1行** に畳んで Header の一番上の行の左（題名の場所）へ置く
              （2026-09-04 決まり6。親の実測: 帯7段で盤が画面の 2.5%）。畳んだだけで消していない。
              「開く」で2本がそのまま出る。他のタブでは今まで通りここに2本。 */}
          {/* 🚨 2026-09-15(清水さん「ぐちゃぐちゃ」の写しの実測): 今日の判断タブは この2本の警告帯が
              赤帯(約30px)＋黄帯2行＋ボタン(約110px)＝**約140px** を占め、主役の積み棒を下へ押していた。
              盤面タブでは 2026-09-04 に同じ2本を **件数だけの1行(約34px)** へ畳んである(BoardWarningsFold)。
              同じ物を今日の判断でも畳む。🚨 1文字も消していない — 「開く」で2本がそのまま出る。 */}
          {/* 🚨 2026-09-18 写しの実測([月]の画面・1600×1000): この警告2本が
              赤帯＋黄帯2行＋ボタンで **約130px** を占め、月の札を下へ押していた。
              盤面で 2026-09-04 に畳んだのと **同じ部品**(BoardWarningsFold)で畳む。
              🚨 1文字も消していない ―「開く」で2本がそのまま出る。
              🚨 [今日] の時は Header の一番上の行の左に出る(同じ物が2つ出る事は無い)。 */}
          {opsimTab === 'board' ? null : boardWarningsLine}

          <Header
            explain={explain}
            lotResults={lotResults}
            verdictLoading={loading}
            progress={progress}
            scenarioKey={scenarioKey}
            onScenario={handleScenario}
            day={elapsedDays}
            maxDay={horizonDays}
            onDay={handleDay}
            playing={playing}
            onTogglePlay={togglePlay}
            /* 時間の進み方(2026-08-30 清水さんの要望3)。刻みと速さは別の札。
               dayCapMs は「1日ぶんの直接作業能力」。時間で決めた刻みを日へ直すのに要る。
               🚨 計算がまだの時は null。Header はその時 0.3日(既定)のまま動く。 */
            playStep={playStep}
            onPlayStep={setPlayStep}
            playMs={playMs}
            onPlayMs={setPlayMs}
            dayCapMs={timeline ? timeline.capMs : null}
            onReset={resetClock}
            onCancel={cancel}
            enabledScenarios={ENABLED_SCENARIOS}
            baseline={baselineForHeader}
            comparison={comparison}
            causeTiers={result ? result.causeTiers : null}
            onOpenList={setListReq}
            snapshotCoverage={result && result.base ? result.base.snapshotCoverage : null}
            inputQuality={result && result.normalized ? result.normalized.inputQuality : null}
            tab={opsimTab}
            onTab={setOpsimTab}
            /* 🚨 決まり19: 主役は 盤面 / 来月の手当て の2つ。残りは「畳んだ物」として弱くする。 */
            tabs={OPSIM_TABS_MAIN}
            /* 基準時刻(2026-08-30 清水さんの指摘)。
               🚨 出す時刻は **結果が名乗る baseNow**。選んだだけの時刻を「この見立ての基準時刻」
                 として出さない。切替の直後だけ2つが食い違い、Header がその事を1行で言う。 */
            baseNow={result && result.metrics ? result.metrics.baseNow : null}
            baseNowWanted={baseNowMs}
            baseMode={baseMode}
            onBaseMode={setBaseMode}
            baseShifted={baseShifted}
            baseResolved={baseResolved}
            /* 🚨 決まり10: 遅れて完了を帯の札と横棒に出す(消さない)。lateDone は盤の棚・納期一覧と同じ1つ。 */
            lateDone={lateDone}
            /* 盤面タブ: 警告2本を件数だけの1行に畳んで一番上の行の左へ（2026-09-04）。 */
            boardLeft={opsimTab === 'board' ? boardWarningsLine : null}
            boardLeftOpen={warnOpen}
            /* 🚨 決まり31(2026-09-05): シナリオ▾ / ⏱▾ の **ボタン2つ** は下の「操作の1行」で出す。
               ここに null を渡す＝Header の一番上の行には出さない(同じボタンが2つ出ない)。
               引き出しの **中身** は Header の今の場所のまま。開いているかどうかだけを親が持つ。 */
            controlsSlot={null}
            boardDrawer={boardDrawer}
            onToggleDrawer={toggleBoardDrawer}
            /* 🧮 2026-09-18 案A: 帯の3行目「この答えの土台」。
               🚨 数は畳んだ警告の1行と **同じ変数**(ここで数え直していない)。
               🚨 札を押すと 畳んである警告の帯がそのまま開く。 */
            basis={opsimTab === 'board' ? basisChips : null}
            onBasisPick={() => setWarnOpen((v) => !v)}
            decisions={opsimTab === 'board' ? decisionsNode : null}   /* 2026-09-19: 札は 開く⇄閉じる(「画面の記録 途中まで」だけの時は 警告の帯に 閉じる口が無い) */
            /* 「今日の判断」の札は無くなりました(案A)。中身は1つも消していません:
               人ごとの指示は 帯の下の「今日の指示」と見せ方の切替[人ごとの指示]へ、
               積み棒と遅れて完了・🎲は 主役のすぐ下の「くわしく」へ移してあります。 */
          />

          {/* ══ ② 今日の指示(2026-09-18 案A・絵 Main.dc.html ②) ═══════════════
              清水さん「答えを出す道具ではなく見せる道具で止まっている」への答え。
              人ごとに「いま→次」を1枚。ここが「だから今日こうしろ」。
              🚨 数をここで作らない。割付(assignments)・暦(calendar)・名簿は 盤と **同じ物**を渡すだけ。
              🚨 拡大(boardFull)の時は盤だけを出すのでここは出さない(拡大を閉じれば必ず戻る)。 */}
          {opsimTab !== 'board' || boardFull ? null : (<>
            {FIELD_PLAN_SHOWN && planShelf && <FieldPlanStrip adopted={adoptedPlan} workerNames={workerNamesInOrder} dayStartMs={dayWindowOf(targetMs).start} dayEndMs={dayWindowOf(targetMs).end} useAdopted={useAdoptedForField} onToggleSource={() => setFieldSourceTrial(v => !v)} />}
            <TodayOrders
              assignments={useAdoptedForField ? adoptedPlan.assignments : (result && result.base ? result.base.assignments : null)}
              lots={normalizedLots}
              templatesById={templatesById}
              calendar={calendar}
              baseNowMs={targetMs}
              workerNames={workerNamesInOrder}
              /* 👥 その日の休み・応援の記号。計算へ渡している物(placementAbsences)と **同じ表**。 */
              absencesToday={placementAbsences ? placementAbsences[ymdOf(targetMs)] || null : null}
              pinsByLot={pinsCfg}
              keepDecided={keepDecided}
              actualPinsNote={keepDecided ? actualPinsText(actualPins) : ''}
              onPinAll={canEdit ? onPinAll : null}
              onSelectLot={setSelectedLotId}
              dateText={fmtMDW(targetMs)}
              todayMs={panelNow}
            />
          </>)}

          {/* ══ 決まり31(2026-09-05 区画A・清水さん「もう画面がぐちゃぐちゃになってる」) ══════
              実測(1467×795)では 主役(納期一覧の見出し)の上に **9段** 積まれていて、
              主役が画面の下端に居ました。段を3つにします。
                [1] Header の一番上    … 警告の件数(左) ＋ 画面の札(右)
                [2] Header の結論の1行 … ◯日後まで守れません ＋ 基準時刻
                [3] **この行**         … 操作を全部ここへ集める
                [4] 主役               … 納期一覧 / 人ごとの指示 / ロットの流れ
              🚨 **1つも消していません**。畳んだ物は押せば必ず出ます
                （「下に あと◯件」と書いて下に何も無い、を作らない）。
                ・？×7 → 「？ 数字の意味」1つに畳む。押すと 7つがそのまま出る（記述は1文字も変えていない）
                ・🪜 効く手のはしご / 👥 両方の工場で働ける人 → ボタン。押した時だけ この下に描く
                ・シナリオ▾ / ⏱ 時間を進める▾ → Header の一番上の行から **ここへ移した**
                  （引き出しの中身は Header の今の場所のまま。開いているかどうかだけを親が持つ）
                ・期間の札 / 期間の1行 → 盤の入れ物の中から **ここへ移した**
                  （拡大の時だけ、覆われない盤の入れ物の中に同じ札を出す＝決まり20）
              🚨 この行は **どのタブでも** 出ます。盤面タブだけの物（期間・シナリオ▾・⏱▾・🪜・👥）は
                盤面タブの時だけ出します（他のタブでは今まで通り Header に札が出ます）。
              🚨 px を1つも直書きしていません（rem 段のクラスだけ）。
              🚨 ここでは数字を1つも作りません。既に画面が持っている物を置くだけです。 */}
          {/* ══ 決まり19C(2026-09-04): 盤面の上に小さく常設する1行 ═══════════════
              🚨 3つとも「条件・根拠」タブから移した物です。1つも消していません。
                ① 追加の読み取り0件 / 書き込み0件
                   … この画面が本番のデータを触らない事の **唯一の見える証拠** なので消しません。
                ② ⚙ 設定 … 見る範囲・工数の見方・仮の入荷日・仮定・根拠のデータ（**設定だけ**）
                ③ ？   … 数字の意味。🚨 押した数字1つの根拠だけを出します
                          （全部の設定を並べたら条件・根拠タブが戻って来るだけなので）。
              🚨 px を1つも直書きしていません（rem 段のクラスだけ）。 */}
          <div
            data-opsim-basis-strip="1"
            data-opsim-controls-row="1"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-slate-200 bg-white px-2 py-1"
          >
            {/* ③ 見せ方の切替(2026-09-18 案A)。盤の箱の見出しから **ここへ移した**
                （同じ札を2つ置かない。盤の箱の右端に残るのは ⤢ 拡大 だけ）。
                🚨 「ロットの流れ」は **🧰 道具箱** へ移しました（消していません。
                  1つの問いには答えない見せ方なので、主役の切替からは外して、道具箱の中から開けます）。 */}
            {opsimTab !== 'board' || boardFull ? null : (
              <span role="group" aria-label="見せ方の切替" data-opsim-view-switch={viewMode} className="inline-flex flex-wrap items-center gap-1">
                {VIEW_MODES.filter((m) => m.key !== 'board').map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    data-opsim-view-pick={m.key}
                    aria-pressed={viewMode === m.key}
                    onClick={() => setViewMode(m.key)}
                    title={m.hint}
                    className={`min-h-11 rounded-full border px-3 text-2xs font-black leading-none ${viewMode === m.key
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
                  >
                    {m.label}
                  </button>
                ))}
              </span>
            )}

            {/* ⑦⑧ 期間の札 と 期間の1行。盤の入れ物の中から移した物（文言は今のまま）。 */}
            {opsimTab !== 'board' || boardFull ? null : (
              <>
              <PeriodPills
                items={OPSIM_RANGES}
                value={rangeKey}
                onPick={handleRange}
                info={rangeInfo}
                resultDays={resultDays}
              />
              {/* 🚨 月の期間で刻みを1日へ上げた事を、必ず言葉で言う（黙って中身だけ変えない）。 */}
              {opsimNeedsDayStep(resultDays) ? (
                <span
                  className="rounded-md border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-2xs text-slate-600"
                  title={'6営業日以上の期間では、盤の記録が1日ごとにしかありません（5営業日以内の時だけ'
                    + '「直接作業30分ごと」の細かい記録を足しています）。0.3日ずつ進めても同じ記録が選ばれ、'
                    + '札の残り時間が動きません（実測6回中3回）。そのため、つまみの刻みを1日へ上げています。'}
                >
                  ⏱ <b className="font-black text-slate-800">1日ずつ</b>（記録が1日ごと）
                </span>
              ) : null}
            {/* 期間の1行は押した時だけ(理由は periodNoteOpen の宣言の所)。札には Worker が返した件数だけを出す(数を作らない)。 */}
            <button
              type="button"
              data-opsim-period-note-toggle="1"
              aria-expanded={periodNoteOpen}
              onClick={() => setPeriodNoteOpen((v) => !v)}
              title="この期間に載せたロットの件数と、回すのに掛かった秒数を出します"
              className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-2xs font-bold text-slate-600 hover:bg-slate-50"
            >
              {(result && result.meta && result.meta.lotsScoped != null && Number.isFinite(Number(result.meta.lotsScoped)))
                ? `載せた ${fmtInt(Number(result.meta.lotsScoped))}件`
                : '期間の詳しさ'}
              {periodNoteOpen ? ' ▴' : ' ▾'}
            </button>
            {periodNoteOpen ? (
              <div className="w-full">
                <PeriodRunNote
                  info={rangeInfo}
                  seconds={fullRunSeconds}
                  busy={loading}
                  scopeDays={scopeDays}
                  scopeKey={scopeKey}
                  lotsScoped={result && result.meta ? result.meta.lotsScoped : null}
                />
              </div>
            ) : null}
              </>
            )}



            {/* 🧰 道具箱(2026-09-18 案A)。散らばっていた道具を **右から出る引き出し 1つ** へ集めた。
                🚨 中身は今まで画面に居た **同じ部品**。コピーを作っていない・1つも消していない。
                🚨 押しても盤の場所を1pxも取らない(fixed の引き出し)・1回も計算しない。 */}
            <span className="ml-auto inline-flex flex-wrap items-center gap-1.5">
              <ToolboxButton open={toolboxOpen} onToggle={() => setToolboxOpen((v) => !v)} />
            </span>

            {/* 🚨 読み取り0件 / 書き込み0件 は **消しません**
                （この画面が本番のデータを触らない事の、唯一の見える証拠）。右の端へ小さく置きます。 */}
            <span
              data-opsim-io="1"
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-3xs font-bold ${
                (Number(diagnostics?.reads) || 0) === 0 && (Number(diagnostics?.writes) || 0) === 0
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-rose-200 bg-rose-50 text-rose-700'}`}
              title={`この画面が本番のデータへ足した 読み取り ${fmtInt(Number(diagnostics?.reads) || 0)}件 ／ 書き込み ${fmtInt(Number(diagnostics?.writes) || 0)}件 です。`
                + '0件のままである事が、触っていない事の証拠です。数字の意味は 🧰 道具箱 の「⚙ 設定と根拠」の中の「？ 数字の意味」を押すと出ます。'}
            >
              読み書き {fmtInt(Number(diagnostics?.reads) || 0)}／{fmtInt(Number(diagnostics?.writes) || 0)}件
            </span>
          </div>

          {error ? (
            <NoticeBar tone="rose" icon={Info}>
              <b className="block">計算が最後まで進みませんでした</b>
              <span className="block mt-0.5 break-words">{error}</span>
              <span className="block mt-0.5">「もう一度計算」を押すか、見ている範囲を狭めてから、もう一度お試しください。</span>
            </NoticeBar>
          ) : null}

          {!loading && !error && scopeEmpty ? (
            <NoticeBar tone="amber" icon={Info}>
              この範囲には、計算へ載せるロットが1件もありません。「見ている範囲」を広げてください。
              （0件だから守れる、という意味ではありません）
              {/* 🚨 2026-09-05: ここは「条件・根拠タブへ行ってください」と書いてありましたが、
                  その札は無くなっています＝**行き先の無い案内**でした。
                  押すと ⚙ が開いて「見ている範囲」の所が光ります（押しても何も起きない道を残さない）。 */}
              <button
                type="button"
                data-opsim-goto-gear="scope"
                onClick={() => openGear('scope')}
                className="ml-1 inline-flex min-h-11 items-center gap-1 rounded-lg border border-amber-400 bg-white px-2.5 text-2xs font-bold text-amber-800 hover:bg-amber-100"
              >
                ⚙ 見ている範囲をひらく
              </button>
            </NoticeBar>
          ) : null}

          {result && snapshotCount === 0 ? (
            <NoticeBar tone="amber" icon={Info}>
              盤面の記録が0枚でした。時間を進めてもカードは動きません。「もう一度計算」でやり直してください。
            </NoticeBar>
          ) : null}

          {/* ── 🗓 来月の手当てタブ(2026-09-04 決まり19B) ──────────────────────────
              伝える事(1行):「来月、人は足りるか。足りないなら **どの工程を・誰に・いつまでに**
              教えれば間に合うか」。理由＝教育のリードタイム(2026-08-31)。
              🚨 **タブの枠だけ**がここ。中身は opsim/nextMonth/ を import するだけで、
                 この画面では数字を1つも作らない（担当が違う。写しを作らない）。
              ⚠ 中身がまだ無い／材料が揃っていない時も壊れない形にしてある
                 （NextMonthPlan が「まだ出せません」を自分で言う）。 */}
          {/* ══ 案A(2026-09-18): 月の画面の1枚目は **月の札3枚**(絵 Month.dc.html)。
              次に 来月の手当て(教育の相手)・改善と教育。**3つとも今までの部品そのまま**。 */}
          {opsimTab !== 'month' ? null : (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-2xl bg-slate-900 px-4 py-2.5 text-white" data-opsim-month-head="1">
              <span className="text-lg font-black leading-tight">月の見通し ― この先3か月、人は足りる？</span>
              <span className="text-2xs text-slate-300">教育のリードタイム＝一月前に分かれば準備が間に合う（2026-08-31 清水さん）。数字は月ごとの純関数の物をそのまま</span>
            </div>
          )}

          {/* ── 月ごと(2026-09-03): この先3か月 人は足りる？ ──
              🚨 数字は全部 Worker の result.monthly（monthly.js）。ここで数え直さない。
              🚨 薄い月は灰色「まだ判定していません」。空だから「回ります」とは絶対に言わない（決まり1・2）。 */}
          {opsimTab !== 'month' ? null : (
            <MonthlyOutlook
              monthly={result ? result.monthly : null}
              loading={loading}
              error={error}
              /* 見ている範囲（⚙ の引き出しと同じ状態）。月の画面は3か月を見るので、
                 範囲が「未完了ぜんぶ」でない時はその事を言い、広げる道を1つ置く。数字はここで作らない。 */
              scopeKey={scopeKey}
              onScope={handleScope}
              meta={result ? result.meta : null}
            />
          )}

          {opsimTab !== 'month' ? null : (
            <NextMonthPlan
              monthly={result ? result.monthly : null}
              monthIndex={1}
              countPile
              decisionBoard={(result && result.decisionBoard) || null}
              educationLeadTime={(result && result.educationLeadTime) || null}
              /* 🚨 2026-09-05 出荷前の確かめで見つかった穴: 既定の範囲は「手元＋14日以内」(scopeKey='soon')。
                 来月は14日より先なので、この画面は**構造的に必ず「来月は登録0件」に見える**のに、
                 範囲で切っている事を1文字も言っていなかった(実測: 既定 10月0件 → ぜんぶ 10月2件・9月の余り 40.8→32.3人日)。
                 同じ部品は Monthly.jsx:445 で既にこの3つを受け取って断りを出している。渡すだけ。 */
              scopeKey={scopeKey}
              scopeDays={scopeDays}
              scopeUntilMs={scopeUntilMs}
              onScope={handleScope}
              meta={result ? result.meta : null}
              loading={loading}
              error={error}
            />
          )}

          {/* 🗂 割付と空き(Codex 13bb9d2 の画面。清水さん「全部確認してちゃんと入れて」2026-09-23)。
              🚨 2026-09-23 本番では runSkillTrials を渡す口が無く 技能試行が一度も出ていなかった → 🎓 ボタンで次の計算に載せる。 */}
          {opsimTab === 'dispatch' && (
            <DecisionBoard
              decisionBoard={result ? result.decisionBoard : null}
              result={result}
              snapshot={snapshot}
              nowMs={targetMs}
              toMs={timeline ? timeline.endMs : null}
              lots={lotList}
              templatesById={templatesById}
              lateDone={lateDone}
              onPickLot={setSelectedLotId}
              onRunTrials={() => { if (runSkillTrials) rerun(); else setRunSkillTrials(true); }}
              loading={loading}
            />
          )}

          {/* ── 盤面タブ: 盤を全幅(旧・大画面相当)。カードが走る道が広い方が、動きが見える。
              ロットを選んだ時だけ、下に根拠(LotDetail)が出る(押せるのに何も出ない画面にしない)。 ── */}
          {opsimTab !== 'board' ? null : (
          /* 🚨 画面いっぱい（2026-09-01）。**同じ入れ物のクラスを差し替えるだけ**にしてある。
               ここで入れ物を丸ごと別のタグに変えると、中の <Board> が付け替わって
               （React が別物と見なして）盤の状態が飛ぶ＝押していた札の選択も消える。
             🚨 z-40 にする理由（2026-08-30 に一度間違えた重なりの順番）:
               作業画面 z-50 / 全画面マップ z-40〜z-[60] / 送信の窓 z-[95] / 総合資料 z-[130] /
               測定の拡大 z-[300]。この帯は **そのどれよりも下**でなければならない。
               連絡のアラーム(鳴り続ける物)も z-[95] 以上に居るので、覆わない。 */
          <div
            ref={boardFullRef}
            data-fs="opsim-board-full"
            className={boardFull
              ? 'fixed inset-0 z-40 flex flex-col gap-1.5 overflow-hidden bg-slate-50 p-2'
              : 'grid grid-cols-1 gap-2 items-start'}
            /* 🚨 上に居る帯(z-50)に覆われた分だけ下げる。実測した値だけを使う（px の決め打ちはしない）。 */
            style={boardFull && fullTopPx > 0 ? { paddingTop: fullTopPx + 8 } : undefined}
          >
            {/* 🚨 期間の切替（2026-09-04 決まり19A）。5営業日 / 今月 / 来月。
                ・拡大の時も **消さない**（決まり20「拡大の時も操作は消さない」）。
                  🚨 この1行を 2026-09-05 に一度うっかり削り、拡大で PeriodRunNote が
                    どこにも出ない形を作りました。戻してあります。消さないでください。
                ・出す日数は「選んだ期間」ではなく **結果が名乗る日数**（食い違う時は帯が言う）。 */}
            {/* 🚨 2026-09-05 決まり31(区画A): 期間の札は 盤の上の「操作の1行」へ移しました。
                ただし拡大(fixed inset-0)の時は その行が帯に覆われて **押せなくなる**
                （2026-09-04 の実測: 拡大すると15種のうち13種が押せなくなっていた）。
                だから **拡大の時だけ** ここに出します。2つ同時には出ません
                ＝ 画面のどの状態でも「期間」は必ず1つ、押せる所に在ります。 */}
            {boardFull ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5">
              <PeriodPills
                items={OPSIM_RANGES}
                value={rangeKey}
                onPick={handleRange}
                info={rangeInfo}
                resultDays={resultDays}
              />
              {/* 🚨 月の期間で刻みを1日へ上げた事を、必ず言葉で言う（黙って中身だけ変えない）。 */}
              {opsimNeedsDayStep(resultDays) ? (
                <span
                  className="rounded-md border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-2xs text-slate-600"
                  title={'6営業日以上の期間では、盤の記録が1日ごとにしかありません（5営業日以内の時だけ'
                    + '「直接作業30分ごと」の細かい記録を足しています）。0.3日ずつ進めても同じ記録が選ばれ、'
                    + '札の残り時間が動きません（実測6回中3回）。そのため、つまみの刻みを1日へ上げています。'}
                >
                  ⏱ <b className="font-black text-slate-800">1日ずつ</b>（記録が1日ごと）
                </span>
              ) : null}
              {/* 🚨🚨 2026-09-05 出荷前の検めで見つかった抜け（決まり11「消さない」・
                  決まり20「拡大の時も操作は消さない」の再発）。
                  期間の1行(PeriodRunNote)は 2d23b18 では盤の入れ物の中に **無条件** で置いてあり、
                  拡大しても読めていました。決まり31 で「操作の1行」へ移した時、拡大用のこの写しには
                  期間の札(PeriodPills)しか入れておらず、**すぐ隣に在った この1行だけが抜けて** いました。
                  結果、拡大して「今月」を選んだ人には
                  『どの期間で・営業何日で・何ロットを載せて・何秒で回したか』を言う
                  **唯一の1行** がどこにも出ませんでした。
                  🚨 上の「操作の1行」と **同じ props**。片方だけ直すと、また食い違います。
                  🚨 拡大とふつうで2つ同時には出ません（{boardFull ? … : null} の裏表）。
                  🚨 ここでは数字を1つも作りません（PeriodRunNote が受け取った物を出すだけ）。 */}
              <PeriodRunNote
                info={rangeInfo}
                seconds={fullRunSeconds}
                busy={loading}
                scopeDays={scopeDays}
                scopeKey={scopeKey}
                lotsScoped={result && result.meta ? result.meta.lotsScoped : null}
              />
            </div>
            ) : null}

            {/* 🚨 結論だけは必ず残す。盤だけ大きくても『で、どうなの』が読めない画面にしない。
                中身は Header の盤面タブに出ている物と **同じ関数** から出る（写しではない）。 */}
            {boardFull ? (
              <BoardConclusionLine
                explain={explain}
                lotResults={lotResults}
                maxDay={horizonDays}
                inputQuality={result && result.normalized ? result.normalized.inputQuality : null}
                causeTiers={result ? result.causeTiers : null}
                /* 🧮 2026-09-18: 拡大の時も「この答えの土台」を消さない(決まり20)。
                   🚨 ふつうの時の帯と **同じ配列**(basisChips)。片方だけ直すと食い違う。 */
                basis={basisChips}
                onBasisPick={() => { setWarnOpen(true); setBoardFull(false); }}
                decisions={decisionsNode}
                /* 🚨 2026-09-05: ここは「…条件・根拠の各タブで出ます」でした。その札は無いので嘘。
                   いま在る行き先だけを言う（設定＝⚙ の引き出し・数字の意味＝？）。 */
                note="くわしい内訳は「閉じる」を押すと、主役の下の「▾ くわしく」と [月] の画面、🧰 道具箱 の ⚙ 設定・？ で出ます"
                /* 🚨 閉じる道は減らさない（2026-09-01 の見張り 約束D）。下の操作帯にも同じ
                   「× 閉じる」を置いたが、**こちらは外さない**。閉じる道は状態を持たないので
                   2つ在っても迷わない（見せ方の札とは違う）。片方を外して見張りを緩める、はしない。 */
                right={(
                  <button
                    type="button"
                    onClick={closeBoardFull}
                    title="盤を元の大きさに戻します（Esc でも閉じます）。何も確定しません。"
                    className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 hover:bg-slate-50"
                  >
                    <X className="h-4 w-4" />
                    閉じる
                  </button>
                )}
              />
            ) : null}

            {/* 🚨 拡大でも **操作は消さない**（2026-09-04 決まり20・清水さん
                「拡大したらロットの流れの再生が全くボタンがないからできない」）。
                実測（1280×800）で、拡大すると 15種のうち13種が押せなくなっていた:
                  ⏱の引き出し / シナリオ / 再生・一時停止 / 1こま戻る / 1こま送る / 最初へ戻す /
                  つまみ / 進み方2つ / 基準時刻2つ / 画面のタブ4つ
                （DOM には残るが fixed の帯に覆われて押せない。だから「在るか」ではなく
                  「押せるか」で数え直した。）
                残っていたのは 見せ方の切替3つ と × 閉じる だけ。
                🚨 帯を1行足した分、盤の使える高さは opsimFullBoardPx(winH, true) で必ず減らす
                  （足すだけだと盤を窓の外へ押し出す。2026-08-24「詰めて表示」の裏返し）。
                🚨 見せ方の切替と閉じるは **この帯へ移した**（下の箱の見出しからは外す）。
                  同じ物を2つ置くと、押した方によって選ばれる物が違うように見える。 */}
            {boardFull ? (
              <BoardFullStrip
                day={elapsedDays}
                maxDay={horizonDays}
                onDay={handleDay}
                playing={playing}
                onTogglePlay={togglePlay}
                onReset={resetClock}
                playStep={playStep}
                onPlayStep={setPlayStep}
                playMs={playMs}
                onPlayMs={setPlayMs}
                dayCapMs={timeline ? timeline.capMs : null}
                baseNow={result && result.metrics ? result.metrics.baseNow : null}
                baseNowWanted={baseNowMs}
                baseMode={baseMode}
                onBaseMode={setBaseMode}
                viewMode={viewMode}
                onViewMode={setViewMode}
                viewItems={VIEW_MODES}
                scenarioKey={scenarioKey}
                onScenario={handleScenario}
                enabledScenarios={ENABLED_SCENARIOS}
                onClose={closeBoardFull}
              />
            ) : null}

            {(
            <CardBox
              className={boardFull ? 'flex min-h-0 flex-1 flex-col' : ''}
              icon={Activity}
              title={VIEW_TITLE[viewMode] || VIEW_TITLE.board}
              /* ロットの流れの説明の1行は、盤の高さに回す（2026-09-04）。文言は切替の札の title(VIEW_MODES.hint) に移した。 */
              sub={viewMode === 'board' ? null : (VIEW_SUB[viewMode] || VIEW_SUB.board)}
              right={(
                <div className="flex items-center gap-1.5">
                  {/* 🚨 拡大（2026-09-01 清水さん「拡大ボタンがなくなってた」）。
                      名前は到着予定の一覧(src/App.jsx)と同じ「⤢ 拡大」「× 閉じる」に揃えた。
                      押した時に何が起きるかは title に必ず書く。 */}
                  {boardFull ? null : (
                    <button
                      type="button"
                      data-opsim-zoom-open="1"
                      onClick={() => setBoardFull(true)}
                      title="盤だけを画面いっぱいに出します。上の帯とタブが隠れる分、一度に見えるレーンが増えます。結論の1行は残ります（Esc または「× 閉じる」で戻ります）。"
                      className="inline-flex min-h-11 items-center gap-1 rounded-full border border-slate-300 bg-white px-2.5 text-2xs font-black leading-none text-slate-600 hover:bg-slate-50"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                      拡大
                    </button>
                  )}
                  {/* 🚨 2026-09-18 案A: 見せ方の切替は **盤の上の「切替の1段」へ移した**。
                      ここに残るのは ⤢ 拡大 ただ1つ（絵 Main.dc.html ④「CardBox の右端の札は [⤢ 拡大] だけ」）。
                      ⚠ 消していない: 同じ札を2か所に置くと、押した方によって違う物が選ばれるように見える。
                      ⚠ 拡大の時は上の1行の操作帯(BoardFullStrip)に見せ方の切替が出る（今までと同じ）。 */}
                  {loading ? <Loader2 className="w-4 h-4 animate-spin text-cyan-600" /> : null}
                </div>
              )}
            >
              <div className={boardFull ? 'flex min-h-0 flex-1 flex-col overflow-y-auto p-2.5' : 'p-2.5'}>
                {viewMode === 'workers' ? (
                  <WorkerLanes
                    /* 🚨 二重見出しをやめる。WorkerLanes 自前の帯と、この CardBox の題(VIEW_TITLE.workers)・
                       副題(VIEW_SUB.workers)が **同じ文** を上下15pxの所に二度出していた。
                       帯にしか無かった2語は VIEW_TITLE/VIEW_SUB へ移してあるので、語は1つも減らない。
                       ⚠TodaySignal.jsx の呼び側は既定(true)のまま＝あちらの見出しは消えない。 */
                    showHeading={false}
                    snapshot={snapshot}
                    assignments={result && result.base ? result.base.assignments : null}
                    lots={normalizedLots}
                    templatesById={templatesById}
                    nowMs={targetMs}
                    selectedLotId={selectedLotId}
                    onSelectLot={setSelectedLotId}
                    heightPx={Math.max(360, winH - 420)}
                    lotVerdictById={lotVerdictById}
                    /* 決まり14-5（人・日順）と 14-3（空きと理由）。暦・空きの記録・帯の材料は納期一覧と同じ物。 */
                    calendar={calendar}
                    idleLog={result && result.base ? result.base.idleLog : null}
                    idleByDay={idleByDay}
                    fromMs={(timeline && timeline.startMs) || null}
                    toMs={(timeline && timeline.endMs) || null}
                    workerNames={workerNamesInOrder}
                    /* 🚨 決まり19A: 最初に開く営業日の数を **期間から** 決める。
                       前は 5 の決め打ちで、期間を変えても開く中身が1日も増えなかった。 */
                    periodDays={resultDays}
                  />
                ) : null}

                {/* 🚨 2026-09-15 清水さん「拡大したら画面がバグってるように見える」: 拡大(fixed・overflow-hidden)の中で
                    納期一覧の下に相手の一覧を足したら、箱からはみ出た行の上に相手の一覧が重なって描かれていた。
                    → 拡大の時は 2つを1つの **送れる入れ物**(min-h-0 flex-1 overflow-y-auto)に入れる。ふつうの時は今までどおり。 */}
                <div data-opsim-calendar-wrap={boardFull ? 'full' : 'normal'} className={boardFull ? 'min-h-0 flex-1 overflow-y-auto' : 'contents'}>
                {viewMode === 'calendar' ? (
                  <DueCalendar
                    /* 🚨 2026-09-05 清水さん「月毎にしても一週間ぐらいしか出ない」。期間が月なら納期一覧を最初から全部出す(40行で切らない)。 */
                    showAllRowsOpen={!!rangeInfo.isMonth}
                    snapshot={snapshot}
                    assignments={result && result.base ? result.base.assignments : null}
                    lots={normalizedLots}
                    lotVerdictById={lotVerdictById}
                    templatesById={templatesById}
                    lateDone={lateDone}
                    fromMs={(timeline && timeline.startMs) || null}
                    toMs={(timeline && timeline.endMs) || null}
                    nowMs={targetMs}
                    selectedLotId={selectedLotId}
                    onSelectLot={setSelectedLotId}
                    heightPx={Math.max(360, winH - 420)}
                    /* 決まり14-1（休みの列は暦から）・14-3（帯）。計算で使った暦そのもの。 */
                    calendar={calendar}
                    idleByDay={idleByDay}
                    prefStats={prefStats}
                    loadByWorker={loadByWorker}
                    workerNames={workerNamesInOrder}
                    /* 🔀 並べ方(設定に残る)・🛠 行からの操作(2026-09-15)。編集/削除/優先度は App の式・担当の固定は settings.opsim.pins */
                    sortKey={dueSortNow}
                    onChangeSort={canEdit ? onChangeDueSort : null}
                    pinsByLot={pinsCfg}
                    onPinWorker={canEdit ? onPinWorker : null}
                    /* 🚨 2026-09-17 清水さんの言葉「拡大ボタン押したら見えない部分がある、編集とか削除とかね」
                        行を押すと右から引き出し(LotDrawer)が出る。その幅だけ 行の操作の帯の右を空けて、
                        ✏編集・🗑削除 が引き出しの下へ潜らない様にする(拡大の時ほど重なる)。 */
                    actionsInsetRight={!!selectedLotId}
                    /* 📌 2026-09-17 「いまの担当で全部固定」「固定を全部外す」。書き手は saveOpsim ただ1つ。 */
                    onPinAll={canEdit ? onPinAll : null}
                    onUnpinAll={canEdit ? onUnpinAll : null}
                    onChangePriority={canEdit && typeof onChangeLotPriority === 'function' ? onPriorityRow : null}
                    onEditLot={canEdit && typeof onEditLot === 'function' ? onEditLotRow : null}
                    onDeleteLot={canEdit && typeof onDeleteLot === 'function' ? onDeleteLotRow : null}
                    renderWorkRouting={WORK_ROUTING_SHOWN && canEdit ? (lotId) => <WorkRoutingAction planShelf={planShelf} routeInputsByArea={routeInputsByArea} app="parts" lotId={lotId} result={result} receipt={sim.planReceipt} currentRunKey={sim.planRunKey} loading={loading} lots={lotList} templates={templateList} canEdit={canEdit} /> : null}
                  />
                ) : null}
                {viewMode === 'calendar' ? (
                  /* 📋 2026-09-15 相手(最終検査)の納期一覧(読むだけ)。清水さん「両方の納期の一覧を同時に見える状態が望ましい」 */
                  <div className="mt-2" data-opsim-other-due="1">
                    <OtherDueList doc={otherAppDailyLoad} label="最終検査" sortKey={dueSortNow}
                      fromMs={(timeline && timeline.startMs) || null} toMs={(timeline && timeline.endMs) || null} calendar={calendar} nowMs={targetMs} />
                  </div>
                ) : null}
                </div>

                {/* 🧭 2026-09-23 遅れの見取り図(ChatGPT/Codex の枝から合流)。3列は opsim/opsimPresentation.buildDelayLanes ただ1本。遅れて完了は lateDone(lateDone.js)をそのまま置く(決まり10) */}
                {viewMode === 'risk' ? (
                  <RiskFlowBoard lotResults={lotResults} lots={normalizedLots} lateDone={lateDone} nowMs={targetMs} horizonDays={horizonDays} selectedLotId={selectedLotId} onSelectLot={setSelectedLotId} subName="テンプレ" subOf={ladderSubOf} />
                ) : null}
                {viewMode === 'board' ? (
                <div ref={boardWrapRef} data-opsim-board-wrap="">
                <Board
                  snapshot={snapshot}
                  lots={normalizedLots}
                  templatesById={templatesById}
                  lateDone={lateDone}
                  selectedLotId={selectedLotId}
                  onSelectLot={setSelectedLotId}
                  forecastSnapshot={forecastSnapshot}
                  /* 盤の「入れ物（見える窓）」の高さ。🚨 2026-09-01 から、これは
                     **段が何段入るか** に効く（前は minH に負けて1pxも効いていなかった）。
                     ・盤面タブ … アプリの帯・タブ3段・判定の行・箱の見出しに 330px を渡す
                       （2026-09-04 実測 1280×800: 盤の道の上端が y≈300。前は 190 で盤の下 1/4 が画面の外だった）
                     ・画面いっぱい … 結論の1行と箱の見出しと凡例（150px）＋ **1行の操作帯**（44px）
                       🚨 帯を1行足したら、その分だけ盤の使える高さを **必ず減らす**。
                         減らさないと、足した帯は盤を窓の外へ押し出すだけになる
                         （2026-08-24「詰めて表示が盤を1pxも大きくしていなかった」の裏返し）。
                         引き算は opsimFullBoardPx（opsim/fullBoard.js の純関数）ただ1本。
                         見張り(verify-opsim-full-controls.mjs)がこの関数を実際に呼んで
                         「帯あり ＜ 帯なし」かを確かめる。
                     入り切らない分は盤の中を縦に送れる（「何本中 何本見えています」を必ず出す）。 */
                  heightPx={boardFull
                    ? opsimFullBoardPx(winH, true)
                    : Math.max(360, winH - (boardTopPx > 0 ? boardTopPx + 14 : 330))}
                  originMs={(timeline && timeline.startMs) || null}
                  /* 🚨 2026-09-04 決まり19A: 盤の言い方（「この◯営業日」）は
                     **結果が名乗る日数**ただ1つから出る。Board はこれを1回も受け取っていなかったので、
                     期間を変えても盤は「この5日」と言い続けていた（焼き込み7か所）。 */
                  periodDays={resultDays}
                  sortMode={sortMode}
                  onSortMode={handleSortMode}
                  highPriorityLotIds={highPriorityLotIds}
                  lotVerdictById={lotVerdictById}
                  frozenLaneOrder={frozenLaneOrder}
                  onLaneOrder={handleLaneOrder}
                  assignments={result && result.base ? result.base.assignments : null}
                  nowMs={targetMs}
                />
                </div>
                ) : null}
                {/* 凡例。🚨 2026-08-30 清水さん「『分かりません』『人が決まっていません』の
                    繰り返しを減らす」。盤のカードは印だけにして、意味は **ここで1回だけ** 言う
                    （＋押した時の引き出しで、そのロットの理由つきで言う）。
                    ⚠ 印にしただけで、言葉は1つも消していない。 */}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  {viewMode === 'board' ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-cyan-500" />人が当たっています
                  </span>
                  ) : null}
                  {viewMode === 'board' ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full border border-rose-400 bg-white" />
                    <b className="font-bold text-rose-600">担当 未定</b>
                    {/* ⚠ 「右に出ます」と書かない。狭い画面(768px未満)では下から出るので、
                        書いた通りの場所に出ない＝画面の言う事が当たらなくなる。 */}
                    ＝人が決まっていません（理由はカードを押すと出ます）
                  </span>
                  ) : null}
                  {viewMode === 'board' ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block rounded border border-slate-200 bg-slate-100 px-1 text-2xs font-bold leading-none text-slate-500">?</span>
                    ＝分かりません（到着日か納期が入っていません。カードを押すと、入っている値が出ます）
                  </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />この先で遅れる見込み
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-rose-500" />納期線を越えました
                  </span>
                  {Number.isFinite(scopedCount) ? (
                    <span className="ml-auto">この範囲のロット {scopedCount.toLocaleString('ja-JP')}件</span>
                  ) : null}
                </div>
              </div>
            </CardBox>
            )}

            {/* ══ 案A(2026-09-18): 元「今日の判断」の残り(積み棒・遅れて完了・🎲引き直し)を
                **主役のすぐ下に畳む**(details)。🚨 1文字も消していない・部品も同じ物。
                なぜ畳むか: これは「で、どうなの」の答えではなく **内訳** なので、
                主役(納期一覧／人ごとの指示)より弱くする(決まり19「移す・畳む・強さを変える」)。
                🚨 拡大(boardFull)の時は盤だけを出すので、ここは出さない(閉じれば必ず戻る)。 */}
            {boardFull ? null : (
              <details className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5" data-opsim-today-more="1">
                <summary className="min-h-11 cursor-pointer list-none text-2xs font-black leading-loose text-slate-700">
                  ▾ くわしく — 原因（主因・副因）／何が・どれだけ遅れるか（積み棒）／遅れて完了した物／🎲 納期の確からしさ
                </summary>
                <div className="mt-1.5 flex flex-col gap-2">
                  {/* 2026-09-19: 帯には主因の名前だけ。内訳(主因の説明・副因・判定上の不足)は ここ。 */}
                  <CauseTiersNote causeTiers={result ? result.causeTiers : null} />
                  <TodayLateBars
                    lotResults={lotResults}
                    lots={normalizedLots}
                    templatesById={templatesById}
                    nowMs={timeline ? timeline.startMs : null}
                    lateDone={lateDone}
                    selectedLotId={selectedLotId}
                    onSelectLot={setSelectedLotId}
                  />
                  <ResampleFoldStrip
                    resample={result && result.base ? result.base.resample : null}
                    lotById={new Map((lotList || []).filter(Boolean).map((l) => [String(l.id), l]))}
                    templatesById={templatesById}
                  />
                </div>
              </details>
            )}

            {/* 🚨 2026-08-24 是正: 以前の大画面ではここを丸ごと畳んでいた。
                その結果、カードを押すと輪は付くのに **読める物が何も出ない** 画面になっていた
                （実測: 押した後に増えた本文は9文字だけ）。押せるのに裏切るのが一番悪い。
                🚨 2026-08-30 清水さん「盤面を最初から横幅いっぱいにする / ロットを押した時だけ、
                右から詳細を開く」→ ここは **流れの中に場所を1pxも取らない**（引き出しに変えた）。
                閉じる道は3つ（×／背景／Esc）で、どれも **閉じるだけ**。何も確定しない。 */}
            <LotDrawer
              open={!!selectedLotId}
              title={`${(selectedLot && selectedLot.model) || '選んだ仕事'}｜${tplNameOf(templatesById, selectedLot && selectedLot.templateId) || 'テンプレ名なし'} の詳しい話`}
              sub="カードに出ていた事と、その根拠"
              onClose={handleCloseDetail}
            >
              {selectedLotId && eligBusy ? (
                <NoticeBar tone="cyan" icon={Loader2}>
                  この仕事を頼める人を、過去の作業記録から数えています。
                </NoticeBar>
              ) : null}
              {selectedLotId && eligError ? (
                <NoticeBar tone="rose" icon={Info}>
                  <b className="block">頼める人を数えられませんでした</b>
                  <span className="block mt-0.5 break-words">{eligError}</span>
                </NoticeBar>
              ) : null}
              {/* カードから外した物の移し先（テンプレ名・台数・進み・盤の札・
                  担当が付いていない理由・ロットID）。盤と同じ式で作る＝食い違わない。 */}
              <SelectedCardFacts
                snapshot={snapshot}
                lotId={selectedLotId}
                lots={normalizedLots}
                templatesById={templatesById}
                lotVerdictById={lotVerdictById}
                nowMs={targetMs}
              />
              {/* 🚨🚨 2026-09-05(検証で出た穴): この2行が抜けていた。
                  nowMs が渡らないと LotDetail の横位置は記録(0.3日刻みの写し)の値へ落ち、
                  すぐ上の SelectedCardFacts(つまみの時刻)と、同じ引き出しの中で
                  「45% の所です」「41% の所です」と数字だけ食い違う。
                  causeTiers が渡らないと「なぜ遅れるか」1行が必ず
                  「理由は計算から返ってきていません」になる(遅れの大半がこの形)。 */}
              {/* 🚗 2026-09-12 清水さんの依頼。この仕事の 品目コード×テンプレ を触る口。
                  🚨 削除は取り消せないので、何が消えるかは押した後の窓が名指しで出す(App 側)。
                  🚨 押す物は 44px 以上・文字は 12px の床(.fi-tap-text)。 */}
              {selectedLot && selectedLot.model && selectedLot.templateId && (onEditModelTemplate || onRemoveModelTemplate) ? (
                <div className="mt-2 rounded-lg border border-slate-300 bg-slate-50 p-2"
                  title={`品目コード ${selectedLot.model}｜テンプレ ${tplNameOf(templatesById, selectedLot.templateId) || 'テンプレ名なし'}`}
                  data-opsim-model-tpl={String(selectedLot.model)}
                  data-opsim-model-tpl-id={String(selectedLot.templateId)}>
                  <div className="fi-tap-text font-bold text-slate-700">
                    品目コード <b className="text-slate-900">{selectedLot.model}</b>
                    <ItemNameTag model={selectedLot.model} modelText={selectedLot.modelText} />
                    <span className="mx-1 text-slate-400">｜</span>
                    テンプレ <b className="text-slate-900">{tplNameOf(templatesById, selectedLot.templateId) || 'テンプレ名なし'}</b>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {onEditModelTemplate ? (
                      <button type="button" data-opsim-model-tpl-edit="1"
                        onClick={() => onEditModelTemplate(selectedLot.model, selectedLot.templateId)}
                        style={{ minHeight: 'max(2.75rem, 44px)' }}
                        className="fi-tap-text rounded-lg border-2 border-indigo-600 bg-indigo-600 px-3 font-black text-white">
                        ✏ 品目コードマスタで編集
                      </button>
                    ) : null}
                    {onRevertModelTemplate && findModelTemplate(modelTemplates, selectedLot.model, selectedLot.templateId) ? (
                      <button type="button" data-opsim-model-tpl-revert="1"
                        onClick={() => onRevertModelTemplate(selectedLot.model, selectedLot.templateId)}
                        style={{ minHeight: 'max(2.75rem, 44px)' }}
                        className="fi-tap-text rounded-lg border-2 border-orange-300 bg-white px-3 font-black text-orange-700">
                        🗑 共通の工程に戻す（この品目コードだけの編集を消す）
                      </button>
                    ) : null}
                    {onRemoveModelTemplate ? (
                      <button type="button" data-opsim-model-tpl-remove="1"
                        onClick={() => onRemoveModelTemplate(selectedLot.model, selectedLot.templateId)}
                        style={{ minHeight: 'max(2.75rem, 44px)' }}
                        className="fi-tap-text rounded-lg border-2 border-rose-300 bg-white px-3 font-black text-rose-700">
                        🗑 この品目コードからこのテンプレを外す
                      </button>
                    ) : null}
                  </div>
                  <div className="fi-tap-text mt-1 text-slate-500">
                    すでに作ってあるロットの工程は変わりません（焼き付け済み）。次に作るロットからの話です。
                  </div>
                </div>
              ) : null}

              <LotDetail
                lot={selectedLot}
                lotResult={selectedLotResult}
                snapshotLot={selectedSnapshotLot}
                eligibility={eligibility}
                audit={audit}
                unresolved={unresolved}
                normalized={normalized}
                templatesById={templatesById}
                nowMs={targetMs}
                causeTiers={result ? result.causeTiers : null}
              />
            </LotDrawer>
          </div>
          )}

          {/* ── 改善・教育(元は札が1つ在った): 案A(2026-09-18)で **[月] の画面の3枚目** へ移した。
              教育のリードタイムは「一月前に分かれば準備が間に合う」＝月の話なので、月に居るのが正しい。
              🚨 中身(WhatIfDiffStrip / ImproveDeck)は1文字も変えていない。
              🚨 条件くらべ(ScenarioCompare)だけは 🧰 道具箱 の「🕒 納期を守る手」へ移した
                （残業・土曜・はしご と同じ「手を打つ道具」なので、そちらの箱が正しい置き場）。
                同じ部品を2つに増やしてはいない（描く所は道具箱の中 ただ1か所）。 ── */}
          {opsimTab !== 'month' ? null : (
          <>
            {/* 追記(2026-08-29 契約C4): what-ifの引き直し差分。同じ土俵の「通常」が
                保管庫に居る時だけ出る(条件は whatifResampleDiff が全部絞る。土俵が違えば帯ごと出ない)。 */}
            <WhatIfDiffStrip diff={whatifResampleDiff} lotMetaById={lotMetaById} />
            <ImproveDeck improvements={improvements} education={result ? result.education : null} />
          </>
          )}

          {/* ══ ⑤ 🧰 道具箱(2026-09-18 案A・絵 Toolbox.dc.html) ═════════════════════
              清水さん「いろんなところに機能が散らばりすぎてる、整理整頓しないとダメ」
              🚨🚨 **1つも消していません**。下の6つの箱の中は、今まで画面に居たのと
                **同じ部品・同じ props** です（コピーを2つ作っていません）。
              🚨 描く場所を移しただけで、数字も文言も 1文字も変えていません。
              🚨 開いても盤の場所を1pxも取らないし、1回も計算しません。 */}
          <Toolbox
            open={toolboxOpen}
            onClose={() => setToolboxOpen(false)}
            note={`散らばっていた道具を全部ここへ。開いただけでは1回も計算しません（読み書き ${fmtInt(Number(diagnostics?.reads) || 0)}／${fmtInt(Number(diagnostics?.writes) || 0)}件）`}
            sections={{
              /* ⏱ 時間を進める。拡大の時に盤の上へ残すのと **同じ部品**(BoardFullStrip)。
                 🚨 見せ方の切替は渡さない(渡すと同じ札が画面に2つ出る)。
                 🚨 刻み・速さ・基準時刻の決め方・シナリオは この帯の「ほか ▾」の中にそのまま居る。 */
              clock: (
                <BoardFullStrip
                  day={elapsedDays}
                  maxDay={horizonDays}
                  onDay={handleDay}
                  playing={playing}
                  onTogglePlay={togglePlay}
                  onReset={resetClock}
                  playStep={playStep}
                  onPlayStep={setPlayStep}
                  playMs={playMs}
                  onPlayMs={setPlayMs}
                  dayCapMs={timeline ? timeline.capMs : null}
                  baseNow={result && result.metrics ? result.metrics.baseNow : null}
                  baseNowWanted={baseNowMs}
                  baseMode={baseMode}
                  onBaseMode={setBaseMode}
                  viewMode={viewMode}
                  onViewMode={setViewMode}
                  viewItems={null}
                  scenarioKey={scenarioKey}
                  onScenario={handleScenario}
                  enabledScenarios={ENABLED_SCENARIOS}
                  onClose={() => setToolboxOpen(false)}
                />
              ),
              /* 🧷 決めた物を守る(2026-09-18 案A 5-2)。
                 🚨 「いまの担当で全部固定」の札は **納期一覧の並べ方の行** と
                   **今日の指示の右上** に出ています(口は onPinAll ただ1つ)。
                   ここで3つ目の同じ札を作ると「いまの担当」を二重に数える事になるので作らない。
                   外す方(固定を全部外す)は設定に入っている数そのままなので、ここにも置く。 */
              keep: (
                <div className="flex flex-col gap-1.5" data-opsim-keep-decided={keepDecided ? 'on' : 'off'}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[{ k: true, label: '固定が既定 ON' }, { k: false, label: 'OFF' }].map((o) => (
                      <button
                        key={String(o.k)}
                        type="button"
                        data-opsim-keep-pick={o.k ? 'on' : 'off'}
                        aria-pressed={keepDecided === o.k}
                        disabled={!canEdit}
                        onClick={() => onKeepDecided(o.k)}
                        title={o.k
                          ? '現場で手が付いているロットを、記録の実際の担当のまま出します（手で決めた固定の方が強い）。押すと設定に保存して盤を引き直します。'
                          : '記録の担当を渡しません（今までと同じ計算）。手で決めた固定だけが残ります。'}
                        className={`inline-flex min-h-11 items-center rounded-lg border-2 px-2.5 text-2xs font-black ${keepDecided === o.k
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-300 bg-white text-slate-600'} ${canEdit ? '' : 'opacity-50'}`}
                      >
                        {o.label}
                      </button>
                    ))}
                    <span className="text-2xs text-slate-600">{`${actualPinsText(actualPins)}・手で決めた固定 ${fmtInt(Object.keys(pinsCfg).length)}件`}</span>
                  </div>
                  {canEdit && Object.keys(pinsCfg).length > 0 ? (
                    <button
                      type="button"
                      data-opsim-toolbox-unpin-all={String(Object.keys(pinsCfg).length)}
                      onClick={() => onUnpinAll(Object.keys(pinsCfg))}
                      title="この工場の固定を全部外して、計算に任せます（いま一覧に出ていない行の固定も含みます）。"
                      className="inline-flex min-h-11 w-fit items-center rounded-lg border-2 border-slate-300 bg-white px-2.5 text-2xs font-black text-slate-700 hover:bg-slate-50"
                    >
                      {`固定を全部外す（${fmtInt(Object.keys(pinsCfg).length)}件）`}
                    </button>
                  ) : null}
                  <span className="text-2xs leading-snug text-slate-500">
                    📌 いまの担当で全部固定したい時は、上の「今日の指示」の右上か、納期一覧の並べ方の行の札を押してください（同じ口です）
                  </span>
                </div>
              ),
              /* 👥 両方の工場で働ける人。今までと **同じ部品・同じ props**。 */
              shared: (
                <div className="flex flex-col gap-2">
                {/* 👥 両方の工場で働ける人（決まり30）。押しどころは **同じ箱の中**。
                    押した時だけ 日ごとの配置を描く。🚨 中身（SharedWorkerPlan）は1文字も変えていません。
                    🚨 押しただけでは1回も計算しません（その中の札で引き直します）。 */}
                <button
                  type="button"
                  data-opsim-shared-toggle="1"
                  aria-expanded={sharedOpen}
                  onClick={() => setSharedOpen((v) => !v)}
                  title="両方の工場の名簿に居る人を、どちらに置くかで引き直す1行を、この下に出します。押しただけでは計算しません（その中の「どちらに置くかで引き直す（2通り）」で引き直します）。"
                  className={`inline-flex min-h-11 w-fit items-center gap-1 rounded-lg border px-2.5 text-2xs font-bold ${sharedOpen
                    ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-cyan-400 hover:text-cyan-700'}`}
                >
                  {`👥 両方の工場で働ける人 ${sharedOpen ? '▴' : '▾'}`}
                </button>
                {!sharedOpen ? null : (
                <SharedWorkerPlan
                  hereWorkers={workerList}
                  thereNames={otherAppWorkerNames}
                  hereLabel="製品検査"
                  thereLabel="最終検査"
                  hereDoc={hereDailyLoad}
                  thereDoc={otherAppDailyLoad}
                  hereApp="parts"
                  thereApp="final"
                  mode={sharedPlanSetting.mode}
                  priority={sharedPlanSetting.priority}
                  minBlockDays={sharedPlanSetting.minBlockDays}
                  onChangeMode={onChangeSharedPlanMode}
                  onChangePriority={onChangeSharedPlanPriority}
                  onChangeMinBlockDays={onChangeSharedPlanMinBlockDays}
                  nowMs={baseNowMs}
                  horizonDays={resultDays || horizonDays}
                  untilMs={normalized ? normalized.horizonEnd : null}
                  worksOnDay={worksOnDay}
                  baseRun={result && result.base ? { normalized, simResult: result.base } : null}
                  runRung={ladderRun}
                  disposeRun={disposeLadderWorker}
                  disabled={loading || !normalized}
                  /* 🚨 いま盤が回した入力の指紋(groundKey)。ロット・名簿・設定・工数モードが
                       変わればここが変わり、畳んだ「期間まるごと2通り」の古い件数が消える。 */
                  inputKey={groundKey || ''}
                  /* 📦 2026-09-12 決めた配置。押すと盤に効き、書類に載って相手の盤にも効く。 */
                  decidedPlacement={decidedPlacement}
                  onDecide={(placement) => setDecidedPlacement(placement)}
                  /* 🚨 2026-09-14 外す事も決定として書類に載せる(null にすると相手の古い配置が開き直しで復活する) */
                  onClearDecision={() => setDecidedPlacement((prev) => (prev ? clearPlacement({ name: prev.name, hereApp: 'parts', nowMs: Date.now() }) : null))}
                  /* 📅 曜日の配置(毎週・共有棚)。書くのは親(savePlacementRule) */
                  weeklyRules={placementRules}
                  onSaveWeekly={(rule) => { if (typeof savePlacementRule === 'function') savePlacementRule(rule); }}
                  /* 📋 相手の納期一覧(件数だけ帯に出す。表は下の納期一覧の下) */
                  thereDueList={otherAppDailyLoad}
                />
                )}
                </div>
              ),
              /* 🕒 納期を守る手。🪜 はしご(RescueLadder)・条件くらべ(ScenarioCompare)。
                 🚨 条件くらべは 元「改善・教育」の札からここへ移した物(中身は1文字も変えていない)。
                 🚨 残業・土曜の必要分(OvertimePlanCard)は ⚙ の引き出しの中にそのまま居る。 */
              remedy: (
                <div className="flex flex-col gap-2">
                {/* 🪜 効く手のはしご（決まり23）。押しどころは **同じ箱の中**。
                    押した時だけ はしごを描く（常設に戻すと、開いた瞬間に重い1行が出る）。
                    🚨 中身（RescueLadder）は1文字も変えていません。
                    🚨 押しただけでは1回も計算しません（その中の「4通りを試す」で引き直します）。 */}
                <button
                  type="button"
                  data-opsim-ladder-toggle="1"
                  aria-expanded={ladderOpen}
                  onClick={() => setLadderOpen((v) => !v)}
                  title="残業や土曜出勤で納期の遅れが何件消えるかを見る1行を、この下に出します。押しただけでは計算しません（その中の「4通りを試す」で引き直します）。"
                  className={`inline-flex min-h-11 w-fit items-center gap-1 rounded-lg border px-2.5 text-2xs font-bold ${ladderOpen
                    ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-cyan-400 hover:text-cyan-700'}`}
                >
                  {`🪜 効く手のはしご ${ladderOpen ? '▴' : '▾'}`}
                </button>
                {!ladderOpen ? null : (
                <RescueLadder
                  nowMs={baseNowMs}
                  windowEndMs={normalized ? normalized.horizonEnd : null}
                  baseCalendar={factoryCalendar}
                  lotsById={ladderLotsById}
                  subOf={ladderSubOf}
                  runRung={ladderRun}
                  disposeRun={disposeLadderWorker}
                  disabled={loading || !normalized}
                  disabledNote={loading ? 'いまの割付を計算しています。終わってから押せます。' : 'いまの割付が出てから押せます。'}
                />
                )}
                  <ScenarioCompare
                    store={scenarioStoreRef.current}
                    currentKey={scenarioKey}
                    onPick={handleScenario}
                    overtimeStep={overtimeExtra}
                    swapReady={swapPlan.ready}
                  />
                </div>
              ),
              /* ⚙ 設定と根拠。⚙ の引き出しを開く口・🧾 根拠・？ 数字の意味(7つ)。
                 🚨 読み書きの札だけは **盤の上に常設のまま** にしてある
                   (この画面が本番のデータを触らない事の、唯一の見える証拠なので引き出しの中へ畳まない)。 */
              gear: (
                <div className="flex flex-wrap items-center gap-1.5">
                {/* ⚙ 設定 … 元「条件・根拠」の **上半分**（見ている範囲・工数の見方・仮の入荷日・仮定）。
                    素で開くので、どこも光りません。 */}
                <GearButton onOpen={() => openGear(null)} />

                {/* 🚨 2026-09-05: 元「条件・根拠」の **下半分**（分かっていない事・工場の暦・力量の注記・
                    根拠のデータ）は、札を外した事で **名前で呼べる入口が無くなって** いました。
                    ⚙ の中には在るのに、名前を知らないと辿り着けない＝実質「消えた」と同じ。
                    だから名前のまま入口を残し、押すと ⚙ が開いて **その場所が光る**。
                    （新しい画面は作っていません。開く先は同じ ⚙ の中です） */}
                <button
                  type="button"
                  data-opsim-goto-gear="evidence"
                  onClick={() => openGear('evidence')}
                  /* 🚨 画面に出る文字に「条件・根拠」と書かない（その札はもう無い＝行き先の無い案内になる）。
                     見張り scripts/opsim-basis-move-guard.mjs が、注意書きを外した上で数えて赤にします。 */
                  title="分かっていない事・工場の暦・力量の注記・根拠のデータを、⚙ の中で光らせて開きます。"
                  className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 text-2xs font-bold text-slate-600 hover:border-cyan-400 hover:text-cyan-700"
                >
                  🧾 根拠
                </button>

                {/* ① ？×7 を **1つのボタン** に畳む（2026-09-05 決まり31）。
                    🚨 7つとも1つも消していません。押した時だけ、今までの7つがそのまま この行に出ます。 */}
                <button
                  type="button"
                  data-opsim-why-toggle="1"
                  aria-expanded={whyOpen}
                  onClick={() => setWhyOpen((v) => !v)}
                  title="手が空く／働ける時間／工数／仮の入荷日／対象外／終わる見込み／担当と力量 の7つの「？」を出します。押した数字1つの根拠だけが出ます。"
                  className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-2.5 text-2xs font-bold ${whyOpen
                    ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-cyan-400 hover:text-cyan-700'}`}
                >
                  {`？ 数字の意味 ${whyOpen ? '▴' : '▾'}`}
                </button>
                {whyOpen ? (
                  <>
                {/* 🚨 それぞれ **1つの数字の根拠だけ** を出します。live の数字はここで数え直さず、
                      すでに画面が持っている物(inputQuality / duePartition / factoryCalendarNote)を渡すだけ。 */}
                <span className="inline-flex items-center text-3xs text-slate-500">手が空く<Why
                  topic="idleMinutes"
                  value={snapshot ? `作業中 ${(snapshot.workers || []).filter((w) => w.state === 'working').length}人` : null}
                /></span>
                <span className="inline-flex items-center text-3xs text-slate-500">働ける時間<Why
                  topic="capacity"
                  detail={factoryCalendarNote
                    ? `工場の暦：${Number(factoryCalendarNote.count) > 0
                      ? `${fmtInt(factoryCalendarNote.count)}日分を引いて数えています`
                      : '🚨 まだ1日も登録がありません（祝日を引いていません）'}`
                    : null}
                /></span>
                <span className="inline-flex items-center text-3xs text-slate-500">工数<Why
                  topic="estimate"
                  value={estimateMode}
                  detail={normalized && normalized.inputQuality
                    ? `工数が分からない ${fmtInt(normalized.inputQuality.missingEstimateCount || 0)}工程 ／ 信頼度が低い ${fmtInt(normalized.inputQuality.lowConfidenceEstimateCount || 0)}工程`
                    : null}
                /></span>
                <span className="inline-flex items-center text-3xs text-slate-500">仮の入荷日<Why
                  topic="arrivalAssumed"
                  detail={normalized && normalized.inputQuality
                    ? `到着日時が分からない ${fmtInt(normalized.inputQuality.arrivalUnknownCount || 0)}ロット ／ 到着予定を過ぎたまま現物未確認 ${fmtInt(normalized.inputQuality.arrivalOverdueCount || 0)}ロット`
                    : null}
                /></span>
                <span className="inline-flex items-center text-3xs text-slate-500">対象外<Why
                  topic="stale"
                  value={`${fmtInt((duePartition && duePartition.stale ? duePartition.stale.length : 0))}件`}
                /></span>
                <span className="inline-flex items-center text-3xs text-slate-500">終わる見込み<Why topic="finish" /></span>
                <span className="inline-flex items-center text-3xs text-slate-500">担当と力量<Why topic="worker" /></span>
                  </>
                ) : null}

                </div>
              ),
              /* ▶ ロットの流れ。見せ方の1つ。札を押すと 主役が盤に変わる(消していない)。 */
              flow: (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-opsim-view-pick="board"
                    aria-pressed={viewMode === 'board'}
                    onClick={() => { setViewMode('board'); setToolboxOpen(false); }}
                    title={(VIEW_MODES.find((m) => m.key === 'board') || {}).hint || ''}
                    className={`inline-flex min-h-11 items-center rounded-lg border-2 px-2.5 text-2xs font-black ${viewMode === 'board'
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
                  >
                    {viewMode === 'board' ? 'いま ロットの流れを見ています' : '開く'}
                  </button>
                  {viewMode === 'board' ? (
                    <button
                      type="button"
                      data-opsim-view-pick="calendar"
                      onClick={() => { setViewMode('calendar'); setToolboxOpen(false); }}
                      title={(VIEW_MODES.find((m) => m.key === 'calendar') || {}).hint || ''}
                      className="inline-flex min-h-11 items-center rounded-lg border-2 border-slate-300 bg-white px-2.5 text-2xs font-black text-slate-700 hover:bg-slate-50"
                    >
                      納期一覧へ戻る
                    </button>
                  ) : null}
                </div>
              ),
            }}
          />

          {/* ══ 決まり19C(2026-09-04): 元「条件・根拠」タブの中身 ═══════════════════
              清水さん「条件根拠も全くわからん何のためにあるの？何を伝えたいの？」
              → **画面(タブ)としては無くしました**。中身は1行も消していません。
                ・設定 … この ⚙ の引き出しの中（下にそのまま入っています）
                ・数字の意味 … 盤面の上の帯の「？」（押した数字1つの根拠だけ）
                ・技術の物 … ⚙ の一番下の畳み
                ・読み書き0件 … 盤面の上に常設
              🚨 「⚙ を開いた時だけ」中を作ります（閉じている間は1文字も描きません）。 */}
          <GearDrawer
            open={gearOpen}
            /* 🚨 閉じたら「光らせる場所」も忘れる。次に素で開いた時に、前に押した所が
               勝手に光っていると、光っている事に意味が無くなる（2026-09-05）。 */
            onClose={() => { setGearOpen(false); setGearFocus(null); }}
            slots={{
              controls: (
          <>
          {/* 🚨 「見ている範囲を広げてください」から飛んで来た時だけ、ここが光ります。 */}
          <GearFocusBox id="scope" focus={gearFocus} title="見ている範囲・何日先まで・工数の見方・仮の入荷日">
          <BasisControls
            scope={scopeKey}
            onScope={handleScope}
            horizonDays={horizonDays}
            /* 🚨 2026-09-04 決まり19A: 「30日」という **届く日が言えない数字** はやめた。
               ここは盤の上の期間の切替（5営業日 / 今月 / 来月）と **同じ1つの状態**を差し替える
               ＝ 同じ物を2つの状態で持たない。 */
            rangeKey={rangeKey}
            rangeItems={OPSIM_RANGES}
            rangeInfo={rangeInfo}
            onRange={handleRange}
            onHorizonDays={(d) => handleRange(Number(d) > HORIZON_DAYS ? 'thisMonth' : 'd5')}
            estimateMode={estimateMode}
            onEstimateMode={setEstimateMode}
            assumeArrivalDays={assumeArrivalDays}
            onAssumeArrivalDays={setAssumeArrivalDays}
          />
          </GearFocusBox>

          {/* 👥 分担の区切り の根拠（2026-09-10）。
              🚨 いまの計算が どの区切りで走っているかを、条件・根拠として画面で言う。
                まだ誰も選んでいない時は「既定（清水さんの指定）」まで出す＝**黙って既定を効かせない**。
              🚨 文は realism.js の handoffBasisLine ただ1本（言葉は handoff.js の物）。 */}
          <div
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-600"
            data-opsim-handoff-basis="1"
          >
            {handoffBasisLine(settings)}
          </div>
          {/* 🧵🚩 ロットは持ったら最後まで／優先度の区分 の根拠（2026-09-10 23:30）。
              🚨 いまの計算が この2つで走っているかを、条件・根拠として画面で言う。未登録なら「既定（清水さんの指定）」まで。
              🚨 文は realism.js の lotFocusBasisLine / priorityClassBasisLine ただ1本。 */}
          <div
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-600"
            data-opsim-lot-focus-basis="1"
          >
            {lotFocusBasisLine(settings)}
          </div>
          <div
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-600"
            data-opsim-priority-class-basis="1"
          >
            {priorityClassBasisLine(settings)}
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-600" data-opsim-rules-basis="1">
            {rulesBasisLines(settings).map((l) => <div key={l}>{l}</div>)}
          </div>

          {/* 下＝戦力（作業者は全員常に出す。勤務時間と人数＝この見立ての入力条件）＋ 仮定の入力。 */}
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(260px,0.75fr)] gap-3 items-start">
            {/* 🚨 T024: 「終わった時刻」と「次に始める時刻」の差を画面で確かめられる様にする。
                これを渡すまで assignments は src/opsim/ のどこにも届いていなかった。
                ⚠ JSX の開始タグの中にコメントは置けない（構文エラーになる）。必ず外に書く。 */}
            <WorkerList
              snapshot={snapshot}
              calendarSpec={normalized && normalized.calendarSpec}
              effectiveWorkerCount={normalized && normalized.effectiveWorkerCount}
              assignments={result && result.base ? result.base.assignments : null}
              templatesById={templatesById}
            />
            <AssumptionCard
              soloMode={opsimCfg.oneWorkerPerModel === true}
              twoPersonKeys={Array.isArray(opsimCfg.twoPersonProcessKeys) ? opsimCfg.twoPersonProcessKeys : []}
              onSoloMode={(v) => saveOpsim({ oneWorkerPerModel: !!v })}
              onTwoPersonKeys={(v) => saveOpsim({ twoPersonProcessKeys: v })}
              zoneRows={zoneRows}
              onZoneCap={(zoneId, n) => {
                // 🏭 区画ごとの定員。⚠ **配列** で保存する(表だと merge:true で消せない)。
                //   いま決まっている物を全部書き直し、この区画の分だけ差し替える／外す。
                const cur = { ...(zoneManual || {}) };
                if (n == null) delete cur[zoneId]; else cur[zoneId] = n;
                saveOpsim({ zoneCapacity: Object.entries(cur).map(([id, cap]) => ({ zoneId: id, cap })) });
              }}
              /* 🎛 本物に近づける設定。⚠ 保存先は settings.opsim.realism（新しい入れ物を作らない）。 */
              realism={realismCfg}
              realismOpen={realismOpen}
              onRealismToggle={() => setRealismOpen((v) => !v)}
              onRealism={(patch) => saveOpsim({ [REALISM_KEY]: { ...realismCfg, ...patch } })}
              /* 👥 分担の区切り。⚠ 保存先は settings.opsim.handoff（字1つだけ・新しい入れ物を作らない）。 */
              handoff={handoffCfg}
              onHandoff={(v) => saveOpsim({ [HANDOFF_KEY]: v })}
              /* 🧵🚩 ロットは持ったら最後まで／優先度の区分。⚠ 保存先は settings.opsim.lotFocus / settings.opsim.priorityClass
                 （true/false 1つずつ・新しい入れ物を作らない）。 */
              lotFocus={lotFocusCfg}
              onLotFocus={(v) => saveOpsim({ [LOT_FOCUS_KEY]: v === true })}
              templatePrefMode={tplPrefModeCfg}
              onTemplatePrefMode={(v) => saveOpsim({ [TEMPLATE_PREF_MODE_KEY]: v === 'reserve' ? 'reserve' : 'order' })}
              priorityClass={priorityClassCfg}
              onPriorityClass={(v) => saveOpsim({ [PRIORITY_CLASS_KEY]: v === true })}
              rules={rulesCfg}
              onRule={(key, value) => { saveOpsim({ [key]: value }); if (key === 'assumeArrivalDays') setAssumeArrivalDays(Number(value) || 0); }}
              realismFacts={realismFacts}
              equipRows={equipRows}
              onEquipCap={(equipmentId, n) => {
                // 🔧 設備ごとの定員。⚠ **配列** で保存する(表だと merge:true で1件消しても消えない)。
                const cur = { ...(readManualEquipmentCaps(settings) || {}) };
                if (n == null) delete cur[equipmentId]; else cur[equipmentId] = n;
                saveOpsim({ equipmentCapacity: Object.entries(cur).map(([id, cap]) => ({ equipmentId: id, cap })) });
              }}
              saving={opsimSaving}
              saveError={opsimSaveError}
              canEdit={!!canEdit}
              workerNames={workerNames}
              processOptions={processOptions}
              scenarioKey={scenarioKey}
              absenceName={absenceName}
              absenceDays={absenceDays}
              ojtName={ojtName}
              ojtProcess={ojtProcess}
              onAbsenceName={setAbsenceName}
              onAbsenceDays={setAbsenceDays}
              onOjtName={setOjtName}
              onOjtProcess={setOjtProcess}
              onRerun={handleRerun}
              stepHoursText={stepHoursText}
              overtimeExtra={overtimeExtra}
              onOvertimeExtra={setOvertimeExtra}
              swapFrom={swapFrom}
              swapTo={swapTo}
              onSwapFrom={setSwapFrom}
              onSwapTo={setSwapTo}
              swapNote={swapNote}
            />
          </div>

          {/* 過去納期のため対象外の帯。今日の判断からここへ移した(清水さん指示 2026-08-30)。文言は変えていない。 */}
          <StaleStrip stale={duePartition.stale} templatesById={templatesById} />

          {/* 🕒 納期対応の残業・土曜(必要分)(2026-09-16 清水さん)。押した時だけ計算し、作業者に見せ、全員できるなら「これでいく」。
              ⚠ 保存先は settings.opsim.overtimePlan(新しい入れ物を作らない)。adopted:true の案だけ scenario に載る。 */}
          <OvertimePlanCard
            plan={overtimePlanCfg}
            canEdit={!!canEdit}
            nowMs={baseNowMs}
            onCompute={overtimePlanRun}
            onSave={(v) => saveOpsim({ overtimePlan: v })}
            disabled={loading || !normalized}
            saving={opsimSaving}
            saveError={opsimSaveError}
          />

          </>
              ),
              /* 🚨 ここから下は「⚙ の下の方」。**1行も消していません**。
                 分かっていない事・工場の暦・力量の注記・基準時刻・根拠を見る・
                 読み書き数・かかった時間・段ごとの時間 が、元のまま入っています。 */
              evidence: (
              <>
          {/* 🚨 「根拠を見る」「分かっていない事」から飛んで来た時だけ、ここが光ります。 */}
          <GearFocusBox id="evidence" focus={gearFocus} title="分かっていない事・工場の暦・力量の注記・根拠のデータ">
          {/* 入力条件・分かっていない事・力量の注記・基準時刻・根拠を見る・読み書き数・かかった時間 */}
          <BasisNotes
            inputQuality={result && result.normalized ? result.normalized.inputQuality : null}
            baseNow={result && result.metrics ? result.metrics.baseNow : null}
            /* 端末の時計から動かした時は、動かした事と 端末の時計 の両方を残す。
               🚨 2026-08-30 あら探しで直した: ここに「これから使う決め方」(baseShifted)を
                 渡していた。切り替えてから計算が終わるまでの間、**前の基準時刻の数字**の横に
                 **新しい決め方の名前**が並び、「8/30 23:10 時点の見立て（次の勤務開始から）」
                 という有り得ない行が出ていた(逆向きに戻した時は、朝の時刻なのに但し書きが
                 消えて、なぜ夜なのに朝の話なのかが読めなくなっていた)。
                 → 出ている数字そのものから決める。端末の時計より後ろなら、動かした物。
                 「次の勤務開始から」以外に後ろへ動かす道は無いので、これで一致する。 */
            baseShifted={!!(result && result.metrics && isNum(result.metrics.baseNow) && result.metrics.baseNow > panelNow)}
            /* 上の帯(全タブ常設)が同じ基準時刻を出しているので、ここでは繰り返さない
               (2026-08-30「重複文言を整理」)。この画面では上の帯が必ず出る。 */
            baseNowShownAbove
            wallNow={panelNow}
            onOpenEvidence={handleOpenEvidence}
            /* 📅 祝日を引いた営業日。登録が0件なら「引いていません」と出る。 */
            factoryCalendar={factoryCalendarNote}
            diagnostics={diagnostics}
            elapsedMs={elapsedMs}
            verdictLoading={loading}
            /* 段ごとの所要時間(2026-08-30 追記)。計算側が実測した物をそのまま渡す。
               🚨 ここで足し算も丸めもしない。画面が「重い段」を作らない為。
               usedCachedHistory / usedCachedNormalize は「初回か再計算か」の唯一の根拠。
                 どちらの計算の数字かを言わないと、速い値と遅い値が混ざって読めなくなる。 */
            perf={perfInfo}
          />

          <EvidenceCard
            innerRef={evidenceRef}
            open={evidenceOpen}
            onToggle={() => setEvidenceOpen((v) => !v)}
            lots={lotList}
            templates={templateList}
            workers={workerList}
          />
          </GearFocusBox>
          </>
              ),
            }}
          />

          {/* T027: 件数を押した時の一覧。🚨 engine が返したロットIDをそのまま出す（数え直さない）。
              どのタブからでも開ける(今日の判断のカードの件数から呼ばれる)のでタブの外に置く。 */}
          {listReq ? (
            <LotListDialog
              req={listReq}
              lots={lotList}
              templatesById={templatesById}
              onClose={() => setListReq(null)}
              /* 一覧の注記が「押すと、そのロットを盤で選びます」と言っているので、盤面タブへも移す */
              onPick={(id) => { setSelectedLotId(id); setListReq(null); setOpsimTab('board'); }}
            />
          ) : null}

          <div className="text-2xs leading-snug text-slate-400">
            この画面は、いまアプリが読み込んでいる配列だけを使って計算しています。新しい読み取り・書き込み・保存は1件もしません。
            力量は過去の作業記録から作った仮の物で、正式な認定ではありません。記録が無い工程は「分かりません」であって、その人に向かないという意味ではありません。
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 追記(2026-08-29 あら探し係): what-ifの引き直し差分の帯 ──────────────────
//   🚨 盤面係が <WhatIfDiffStrip> を使う所まで書いて **定義を書かずに** 終えていた。
//     未定義のまま描くと ReferenceError で ErrorBoundary が盤全体を覆う(白画面と同種)。
//     このリポジトリの eslint は JSX の未定義部品を見張らない(実測済み)ので、ここに実体を置く。
//   材料は buildResampleDiff の戻り値({rows, summary})だけ。null なら何も描かない
//   (「同じ土俵の通常が居るか」等の絞りは呼ぶ側 whatifResampleDiff が全部済ませている)。
//   🚨 契約§5: 差が0の物は「変わらない」に数えるだけで、良し悪しの言葉を付けない。
function WhatIfDiffStrip({ diff = null, lotMetaById = null }) {
  if (!diff || !diff.summary) return null;
  const rows = Array.isArray(diff.rows) ? diff.rows : [];
  const s = diff.summary;
  if (!s.judgedBoth) {
    return (
      <div className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-1.5 text-[12px] font-bold text-slate-600">
        🎲 通常との引き直し差分: 通常とこのシナリオの両方に判定の材料が揃ったロットが0件のため、差は出せません（片側だけの物は数えません）。
      </div>
    );
  }
  // 決まり12: 品目コード｜テンプレ。差分の行は orderNo/model しか運ばないので、テンプレ名は lotMetaById から引く。
  const nameOf = (r) => {
    const meta = (lotMetaById && lotMetaById.get(String(r.lotId))) || {};
    return `${r.orderNo || r.lotId} ${r.model || ''}｜${meta.tplName || 'テンプレ名なし'}`.trim();
  };
  const chipTone = (d) => (d < 0 ? 'bg-rose-50 border-rose-300 text-rose-700'
    : d > 0 ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
      : 'bg-white border-slate-300 text-slate-500');
  const PROV_NOTE = '仮の数字: この見立ての材料の過半が、本人ではなく全員の実測からの借り物です。幅は広めに見てください';
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2">
      <div className="text-[12.5px] font-black text-violet-800">
        🎲 通常との引き直し差分（納期までに収まった回数・10回中◯回）
        <span className="ml-2 text-[11.5px] font-bold text-slate-600">
          判定 {s.judgedBoth}件 ｜ <span className="text-rose-700">下がる {s.down}件</span> ｜ <span className="text-emerald-700">上がる {s.up}件</span> ｜ 変わらない {s.same}件
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {rows.slice(0, 14).map((r) => (
          <span
            key={r.lotId}
            title={`通常 ${r.baseHit}/${r.baseDraws}回 → このシナリオ ${r.scnHit}/${r.scnDraws}回${r.provisional ? `。${PROV_NOTE}` : ''}`}
            className={`text-[11.5px] font-black rounded px-1.5 py-0.5 border ${chipTone(r.delta)}`}
          >
            {nameOf(r)} 10回中{r.baseOf10}回→{r.scnOf10}回{r.delta !== 0 ? `（${r.delta > 0 ? '+' : ''}${r.delta}）` : ''}{r.provisional ? '※仮' : ''}
          </span>
        ))}
        {rows.length > 14 && <span className="fi-tap-text text-slate-500 self-center">…ほか{rows.length - 14}件（下がる物から順）</span>}
      </div>
      <div className="mt-1 fi-tap-text leading-snug text-slate-500">
        同じ土俵（同じ入力・基準時刻・範囲・日数・工数モード）で計算した「通常」との差だけを出しています。両方に判定の材料が揃ったロットだけ数え、片側だけの物は数えません。※仮＝材料の過半が全員の実測からの借り物です。
      </div>
    </div>
  );
}

/**
 * 分析タブの5枚目「操業シミュレーション」。
 *
 * @param {object} props
 * @param {Array}  props.lots      アプリが既に読み込んでいるロット（🚨 全部渡す。完了分も要る）
 * @param {Array}  props.templates 検査表
 * @param {Array}  props.workers   作業者名簿
 * @param {object} props.settings  設定1件
 * @param {boolean} props.canEdit  仮定の入力を触れるか（データへは1件も書きません）
 */
// ── 🎲📋 旧S2の帯(2026-08-28)を3つに割った(2026-08-30 画面4分割・文言は変えていない) ──
//   ①⚠納期の更新が必要(入荷が納期より後) … DueConflictStrip。タブの外・常に上(清水さん指示)。
//   ②対象外(過去納期・到着予定なし) … StaleStrip。条件・根拠タブへ(todayから外す=清水さん指示)。
//   ③納期の確からしさ(実測の引き直し) … ResampleFoldStrip。今日の判断タブで1行に畳む。
//   🚨数字には出どころ: チップの title に 実測件数・段の内訳・試行回数を必ず書く(そのまま維持)。

/**
 * ⚠仮の入荷日の帯（2026-08-31 清水さん「シミュレーションで入庫日時間がないから計算できないって
 *   言われた。仮日をとりあえず入れて後から本当のやつ入れるってことだから、そこはわかりやすくして」）。
 *   タブの外＝どのタブでも Header のすぐ下に出す。開いた直後(既定ON)から必ず見える。
 * 🚨 件数は engine(normalizeInput)が返した unknowns.arrivalAssumed をそのまま数える（画面で数え直さない）。
 * 🚨 これは **仮定の白状**。この帯を消すと、仮の日で出した結果が事実の顔をする。
 * 🚨 納期も無い物は起点が無いので仮にも置けない。黙って混ぜず、**別の数** で言う。
 * 🚨 本当の入荷日が入っているロットには仮を当てない（normalizeInput が本物を先に読む。試験
 *   assumed-arrival.test.mjs で押さえた）。だから「後から本当のやつを入れれば、そちらで計算し直す」。
 * ⚠ ここで確定する物は何も無い。開閉と切替だけ（背景タップの焼き付きの形を作らない）。
 */
export function AssumedArrivalStrip({
  on = false, days = 2, info = null, onAssume = null, baseNowMs = null, baseShifted = false,
  // 一覧を開いた姿で描き始めるか。🚨 見張り(assumed-arrival-two-kinds.test.mjs)が
  //   **本物の行**を描いて札と title を確かめる為に要る。画面は既定(false)のまま。
  openListInitially = false,
}) {
  const [openList, setOpenList] = useState(openListInitially);
  const [openNoAnchor, setOpenNoAnchor] = useState(false);
  if (!info) return null;
  const rows = Array.isArray(info.rows) ? info.rows : [];
  const noAnchor = Array.isArray(info.noAnchor) ? info.noAnchor : [];
  const offCandidates = Number(info.offCandidates) || 0;
  /**
   * 🚨🚨 2026-09-04 清水さん「納期の2日前に着くって話なのに 添付で見たら全然違うからいいかげんにして」。
   *   実測(2026-08-30 の控え・基準 9/7 08:30): 仮 38件のうち **14件は納期の2日前ではない**。
   *   2日前(9/5土・9/6日)がもう過ぎていたので、基準時刻 9/7 08:30 へ丸めていた。
   *   なのに帯は38件ぜんぶを「納期の2日前に着く」と言っていた。**2つの数に割って両方言う**。
   * 🚨 件数は engine の1つの計算(arrivalAccounting)から。ここで rows を数え直さない。
   */
  const split = info.split || null;
  if (on && rows.length === 0 && noAnchor.length === 0) return null;
  if (!on && offCandidates === 0 && noAnchor.length === 0) return null;
  const WDAY = ['日', '月', '火', '水', '木', '金', '土'];
  const fmtDay = (ms) => {
    if (!isNum(ms)) return '—';
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}(${WDAY[d.getDay()]})`;
  };
  const fmtDayTime = (ms) => {
    if (!isNum(ms)) return '—';
    const d = new Date(ms);
    return `${fmtDay(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const canToggle = typeof onAssume === 'function';
  return (
    <div className={`rounded-lg border-2 px-3 py-2 ${on ? 'border-amber-400 bg-amber-50' : 'border-slate-300 bg-slate-100'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {on ? (
          /* 🚨 2通りを **必ず両方** 書く。片方が0件でも「0件」と書く（書かないと嘘に戻る）。
             丸めた方は色を変える（橙 → 赤寄り）＝ 2026-08-28 の「入荷登録との逆転＝矛盾アラーム」そのもの。 */
          <span
            className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-black leading-snug text-amber-900"
            data-testid="assumed-arrival-band"
            data-assumed-total={split ? split.total : rows.length}
            data-assumed-beforedue={split ? split.beforeDue : ''}
            data-assumed-clamped={split ? split.clamped : ''}
          >
            <span>⚠ 入荷日が無い {split ? split.total : rows.length}件:</span>
            <span className="rounded border border-amber-400 bg-white px-1.5 py-0.5 text-amber-900">
              納期の{days}日前に置いた {split ? split.beforeDue : '—'}件
            </span>
            <span className="text-amber-700">／</span>
            <span
              className="rounded border border-red-500 bg-red-50 px-1.5 py-0.5 text-red-800"
              data-testid="assumed-arrival-clamped-chip"
              title={`納期の${days}日前が、計算の基準時刻より前になっているロットです。`
                + '納期が来ているのに入荷の登録がありません。'}
            >
              {days}日前がもう過ぎているので{baseShifted ? '次の勤務開始' : '基準時刻'}
              （{fmtDayTime(baseNowMs)}）に置いた {split ? split.clamped : '—'}件
              <span className="ml-1 font-black">← 納期が来ているのに入荷の登録がありません</span>
            </span>
            {split && split.kindUnknown > 0 ? (
              <span className="rounded border border-slate-400 bg-white px-1.5 py-0.5 text-slate-700">
                どちらか分かりません {split.kindUnknown}件
              </span>
            ) : null}
            <span className="font-bold text-amber-800">本当の入荷日を入力すると、そちらで計算し直します。</span>
          </span>
        ) : (
          <span className="text-xs font-black leading-snug text-slate-700">
            入荷日を仮に置いていません（実データだけで計算しています）。
            入荷日が無い {offCandidates}件は到着未確認のままなので、判定がつきません。
          </span>
        )}
        {on && rows.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpenList((v) => !v)}
            aria-expanded={openList}
            className="min-h-11 rounded-lg border border-amber-400 bg-white px-2.5 text-2xs font-black text-amber-800 hover:bg-amber-100"
          >
            仮で置いた {rows.length}件の一覧{openList ? 'を畳む' : 'を見る'}
          </button>
        ) : null}
        {noAnchor.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpenNoAnchor((v) => !v)}
            aria-expanded={openNoAnchor}
            className="min-h-11 rounded-lg border border-slate-400 bg-white px-2.5 text-2xs font-black text-slate-600 hover:bg-slate-50"
          >
            入荷日も納期も無いので仮にも置けません: {noAnchor.length}件
          </button>
        ) : null}
        {!on && canToggle ? (
          <button
            type="button"
            onClick={() => onAssume(2)}
            className="min-h-11 rounded-lg border border-amber-400 bg-white px-2.5 text-2xs font-black text-amber-800 hover:bg-amber-50"
            title={'入荷日が無い物を「納期の2日前に着く」と仮に置いて計算し直します。'
              + 'その2日前がもう過ぎている物は、計算の基準時刻に置きます（件数は別に数えて帯に出します）。'
              + '元のデータは1文字も変えません。'}
          >
            仮に置く（納期の2日前）に戻す
          </button>
        ) : null}
      </div>
      {on && openList ? (
        <div className="mt-1.5 overflow-x-auto rounded-lg border border-amber-200 bg-white px-2.5 py-2">
          {/* 🚨 2026-09-04: 列を「なぜその日か」と「置いた日」に割る。
              前は「仮に置いた日」1列だったので、38行が同じ 9/7 08:30 に並んでいても
              それが『納期の2日前』なのか『2日前が過ぎたので基準時刻』なのか読めなかった。 */}
          {/* 🚨 2026-09-05 清水さん「仮の日を入れる詳細の画面もう壊れてて何もわからない」: 品目コード｜テンプレ の列が minmax(0,1fr) で 0 幅に潰れ、
              見出しが縦書き・中身が空(truncate)になっていた。列に最低幅を持たせ、狭い時は横に流す。 */}
          <div className="grid min-w-[44rem] grid-cols-[minmax(4.5rem,auto)_minmax(12rem,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-0.5" data-assumed-list-grid="1">
            <span className="text-2xs font-black text-slate-500">指図</span>
            <span className="text-2xs font-black text-slate-500">品目コード｜テンプレ</span>
            <span className="text-2xs font-black text-slate-500">なぜその日か</span>
            <span className="text-2xs font-black text-slate-500">仮に置いた日</span>
            <span className="text-2xs font-black text-slate-500">納期</span>
            {rows.map((r) => {
              const clamped = r.assumedKind === 'clampedToNow';
              const known = r.assumedKind === 'beforeDue' || clamped;
              // 行の title は **日付の式** をそのまま書く（読めば自分で検算できる）。
              const why = !known
                ? 'この行がどちらの置き方か、計算から返ってきていません。'
                : (clamped
                  ? `納期 ${fmtDay(r.dueMs)} → その${days}日前は ${fmtDay(r.wantMs)} で、計算の基準時刻 ${fmtDayTime(baseNowMs)} より前 `
                    + `→ ${baseShifted ? '次の勤務開始' : '基準時刻'} ${fmtDayTime(r.arrivalMs)} に置いた。`
                    + '納期が来ているのに入荷の登録がありません。'
                  : `納期 ${fmtDay(r.dueMs)} → その${days}日前 ${fmtDayTime(r.wantMs)} に置いた。`);
              return (
                <React.Fragment key={r.lotId}>
                  <span className="text-2xs font-bold text-slate-700 tabular-nums">{r.orderNo || r.lotId}</span>
                  <span className="min-w-0 break-words text-2xs font-bold text-slate-800" data-assumed-row-model={r.model || ''}>{r.model || '（品目コードの記録がありません）'}{r.model ? <ItemNameTag model={r.model} /> : null}<span className="font-bold text-slate-500">{`｜${r.tplName || 'テンプレ名なし'}`}</span></span>
                  <span
                    title={why}
                    data-testid="assumed-arrival-row-kind"
                    data-assumed-kind={r.assumedKind || 'unknown'}
                    className={`rounded border px-1.5 py-0.5 text-2xs font-black ${clamped
                      ? 'border-red-500 bg-red-50 text-red-800'
                      : (known ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-slate-400 bg-white text-slate-700')}`}
                  >
                    {clamped ? `仮（${days}日前は過ぎ→${baseShifted ? '次の勤務' : '基準時刻'}）` : (known ? `仮（${days}日前）` : '仮（どちらか分かりません）')}
                  </span>
                  <span title={why} className={`text-2xs font-bold tabular-nums ${clamped ? 'text-red-800' : 'text-amber-800'}`}>{fmtDayTime(r.arrivalMs)}</span>
                  <span className="text-2xs text-slate-600 tabular-nums">{fmtDay(r.dueMs)}</span>
                </React.Fragment>
              );
            })}
          </div>
          <div className="mt-1.5 border-t border-dashed border-amber-200 pt-1 text-2xs leading-snug text-slate-600">
            本当の入荷日は、ポータルの「到着予定を登録」から入れられます。入力すると、仮の日ではなく本当の日で計算し直します。
            <span className="font-black text-red-800">赤い行は、納期の{days}日前がもう過ぎている物です</span>
            （納期が来ているのに入荷の登録がありません）。元のデータには1文字も書き戻していません。
          </div>
        </div>
      ) : null}
      {openNoAnchor && noAnchor.length > 0 ? (
        <div className="mt-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-2">
          <div className="flex flex-wrap gap-1.5">
            {noAnchor.map((r) => (
              <span key={r.lotId} className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-2xs font-bold text-slate-600">
                {r.orderNo || r.lotId} {r.model}<ItemNameTag model={r.model} />{`｜${r.tplName || 'テンプレ名なし'}`}
              </span>
            ))}
          </div>
          <div className="mt-1.5 border-t border-dashed border-slate-200 pt-1 text-2xs leading-snug text-slate-600">
            起点になる日が1つも無いので、仮の入荷日も置けません（判定がつきません）。
            納期を入力すると「納期の{days}日前」で仮に置けます（その日がもう過ぎていれば、計算の基準時刻に置きます）。
            本当の入荷日はポータルの「到着予定を登録」から入れられます。
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** ①矛盾アラーム。入荷登録されたら納期も直す決まり(2026-08-28)。全タブで上に出す。 */
/**
 * 盤面タブで上の警告2本（納期の更新が必要／仮の入荷日）を **件数だけの1行** に畳む（2026-09-04 決まり6）。
 * 🚨 消さない。件数を1行で言い、「開く」で元の2本（children）がそのまま出る。fold=false なら children をそのまま出す。
 * ⚠ 何を1行に書くかは、元の2本が「出る条件」と同じ式（出ない物を件数で言わない・出る物を黙らない）。
 *   ⚠ 開閉は端末の中の見た目だけ。何も確定しない・何も書かない。
 */
export function BoardWarningsFold({
  fold = false, conflictCount = 0, assumedOn = false, assumedCount = 0, offCandidates = 0, noAnchorCount = 0,
  assumedDays = 2, assumedBeforeDue = null, assumedClamped = null,
  /* 🚨 2026-09-17 清水さんの言葉「いろんなところに機能が散らばりすぎてる、整理整頓しないとダメ」
     入力の健康状態(手が付かない・工数が分からない)を、盤面で最初に目に入るこの1行にも出す。
     ⚠ 新しい集計は作らない。呼ぶ側が **もう画面が持っている数** をそのまま渡す。 */
  noHandCount = 0, missingEstimateCount = 0, alwaysSkipped = null,
  /* 🧰 2026-09-18 案A: 帯の3行目「この答えの土台」の札を押すと **ここが開く**。
     その為に開閉を親からも持てる形にする(渡されなければ今までどおり自分で持つ)。
     ⚠ 開閉は端末の中の見た目だけ。何も確定しない・何も書かない。 */
  open: openProp = null, onOpenChange = null, children,
  /* 📐 閉じている間の1行を出さない(帯の土台の札が同じ数を出している時)。開けば今までどおり全部出る。 */
  hideClosedLine = false,
}) {
  const [openSelf, setOpenSelf] = useState(false);
  const open = typeof openProp === 'boolean' ? openProp : openSelf;
  const setOpen = (next) => {
    const v = typeof next === 'function' ? next(open) : next;
    if (typeof onOpenChange === 'function') onOpenChange(v);
    else setOpenSelf(v);
  };
  if (!fold) return children;
  const parts = [];
  if (conflictCount > 0) parts.push({ key: 'conflict', text: `⚠ 納期の更新が必要 ${conflictCount}件（入荷が納期より後）`, tone: 'text-rose-700' });
  if (assumedOn && assumedCount > 0) {
    // 🚨🚨 2026-09-04: 畳んだ1行でも **2通りを分けて言う**。ここが盤面タブで最初に目に入る行で、
    //   前は 38件ぜんぶを「納期の2日前に着く仮定」と言っていた（実測 14件は2日前ではない）。
    const hasSplit = Number.isFinite(Number(assumedBeforeDue)) && Number.isFinite(Number(assumedClamped));
    parts.push({
      key: 'assumed',
      text: hasSplit
        ? `⚠ 入荷日を仮に置いた ${assumedCount}件（納期の${assumedDays}日前 ${assumedBeforeDue}件／${assumedDays}日前が過ぎていて基準時刻 ${assumedClamped}件）`
        : `⚠ 入荷日を仮に置いた ${assumedCount}件（内訳が計算から返ってきていません）`,
      tone: Number(assumedClamped) > 0 ? 'text-red-800' : 'text-amber-900',
    });
  }
  if (!assumedOn && offCandidates > 0) parts.push({ key: 'off', text: `入荷日が無い ${offCandidates}件（仮に置いていません＝判定がつきません）`, tone: 'text-slate-700' });
  if (noAnchorCount > 0) parts.push({ key: 'noAnchor', text: `入荷日も納期も無い ${noAnchorCount}件`, tone: 'text-slate-600' });
  // 🚨 2026-09-17: 「手が付かない」=出来る人が居ない等で **始められないロット**。理由は納期一覧の行に出ている。
  if (Number(noHandCount) > 0) parts.push({ key: 'noHand', text: `⚠ 手が付かない ${Number(noHandCount).toLocaleString('ja-JP')}件（理由は納期一覧の行に）`, tone: 'text-rose-700' });
  if (Number(missingEstimateCount) > 0) parts.push({ key: 'missEst', text: `工数が分からない ${Number(missingEstimateCount).toLocaleString('ja-JP')}工程`, tone: 'text-slate-700' });
  // 🚫 2026-09-18 記録でほぼ毎回飛ばす工程(該当なし)。数は normalizeInput の inputQuality.alwaysSkipped そのまま。積んだ時(countAlwaysSkipped)は出さない。
  if (alwaysSkipped && alwaysSkipped.applied && Number(alwaysSkipped.stepCount) > 0) {
    parts.push({ key: 'skip', text: `記録で飛ばす工程 ${Number(alwaysSkipped.stepCount).toLocaleString('ja-JP')}件（${Number(alwaysSkipped.lotCount).toLocaleString('ja-JP')}ロット・該当なしとして0分）`, tone: 'text-slate-700', title: skipHistoryText(alwaysSkipped.rows || []) });
  }
  if (!parts.length) return null;
  if (!open && hideClosedLine) return null;
  return (
    <div className="flex flex-col gap-2" data-opsim-warnings-fold={open ? 'open' : 'closed'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1">
        {parts.map((p) => <span key={p.key} className={`text-2xs font-black leading-none ${p.tone}`} title={p.title || undefined} data-opsim-warn={p.key}>{p.text}</span>)}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="ml-auto min-h-11 rounded-lg border border-amber-400 bg-white px-2.5 text-2xs font-black text-amber-800 hover:bg-amber-100"
          title="畳んである警告の帯（顔ぶれの一覧と、仮に置く／置かない の切替）をそのまま出します。"
        >
          {open ? '畳む' : '開く'}
        </button>
      </div>
      {open ? children : null}
    </div>
  );
}

function DueConflictStrip({ conflicts = [], templatesById = null }) {
  if (!conflicts.length) return null;
  return (
    <details className="rounded-lg border-2 border-rose-300 bg-rose-50 px-3 py-1.5">
      <summary className="flex min-h-11 cursor-pointer items-center fi-tap-text font-black text-rose-700">⚠ 納期の更新が必要 {conflicts.length}件 — 入荷が納期より後(矛盾)。入荷登録されたら納期も直す決まり(2026-08-28)</summary>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {conflicts.map((c) => (
          <span key={c.id} className="fi-tap-text font-bold bg-white border border-rose-300 text-rose-700 rounded px-1.5 py-0.5">{c.orderNo} {c.model}<ItemNameTag model={c.model} className="font-normal" />{`｜${tplNameOf(templatesById, c.templateId) || 'テンプレ名なし'}`}</span>
        ))}
      </div>
    </details>
  );
}

/** ②過去納期のため対象外。条件・根拠タブに出す(件数は正直に出す。決定2026-08-28)。 */
function StaleStrip({ stale = [], templatesById = null }) {
  if (!stale.length) return null;
  return (
    <details className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-1.5">
      <summary className="flex min-h-11 cursor-pointer items-center fi-tap-text font-bold text-slate-600">過去納期のため対象外 {stale.length}件(処理済みか登録間違いの可能性。入荷登録が付けば自動で対象に戻ります)</summary>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {stale.map((c) => (
          <span key={c.id} className="fi-tap-text bg-white border border-slate-300 text-slate-500 rounded px-1.5 py-0.5">{c.orderNo} {c.model}<ItemNameTag model={c.model} className="font-normal" />{`｜${tplNameOf(templatesById, c.templateId) || 'テンプレ名なし'}`}</span>
        ))}
      </div>
    </details>
  );
}

/**
 * ③🎲納期の確からしさ。今日の判断タブでは1行に畳み、押すと今までのチップ一覧がそのまま展開する。
 *   1行の数字(判定N件・10/10がM件)は rows という実数から組む(飾りの数字を作らない)。
 *   開閉はこのコンポーネントの中の state(見せ方だけ。計算には関わらない)。
 */
function ResampleFoldStrip({ resample = null, lotById = null, templatesById = null }) {
  const [open, setOpen] = useState(false);
  const by = (resample && resample.byLot) || {};
  const rows = Object.keys(by)
    .map((id) => ({ id, r: by[id], lot: lotById ? lotById.get(String(id)) : null }))
    .filter((x) => x.r && x.r.ok !== false && x.r.onTime && Number(x.r.onTime.draws) > 0)
    .map((x) => ({ ...x, rate: x.r.onTime.hit / x.r.onTime.draws }))
    .sort((a, b) => a.rate - b.rate);
  const of10 = (x) => Math.round(x.rate * 10);
  const danger = rows.filter((x) => of10(x) <= 6);
  const warn = rows.filter((x) => of10(x) >= 7 && of10(x) <= 8);
  if (!rows.length) return null;
  const perfect = rows.filter((x) => of10(x) === 10).length;
  const nameOf = (x) => {
    const l = x.lot || {};
    return `${l.orderNo || x.id} ${l.model || ''}｜${tplNameOf(templatesById, l.templateId) || 'テンプレ名なし'}`.trim();
  };
  const provOf = (x) => {
    const p = (x.r && x.r.provenance) || {};
    const tc = p.tierCounts || {};
    return `実測から${x.r.onTime.draws}回試した(割付はS1の1本のまま・時間だけ引き直す近似)。材料の段: 本人×工程×品目コード${tc.tier1 || 0}件/本人×工程${tc.tier2 || 0}件/工程×品目コードの全員${tc.tier3 || 0}件/工程の全員${tc.tier4 || 0}件${p.usedRecentN ? `・各セル直近${p.usedRecentN}件まで` : ''}`;
  };
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        /* 🚨 2026-09-18 写しの実測: この1行は案A で **主役のすぐ下** へ移ったので、
           押す所が 32px・字が 11.5px だと決まり(44px・12px)を破る。rem の段へ直す。
           ⚠ 文言は1文字も変えていない。 */
        className="min-h-11 w-full text-left rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-1.5 text-2xs font-black text-indigo-800 hover:bg-indigo-50"
      >
        🎲 工数ばらつき試算: 判定{rows.length}件中{perfect}件が10/10
        <span className="ml-2 text-2xs font-bold text-cyan-700">{open ? '畳む' : '詳細を見る'}</span>
      </button>
      {open ? (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2">
          <div className="text-[12.5px] font-black text-indigo-800">
            🎲 納期の確からしさ(実測の引き直し・{resample.draws}回)
            <span className="ml-2 text-[11.5px] font-bold text-slate-600">判定 {rows.length}件 ｜ <span className="text-rose-700">10回中6回以下 {danger.length}件</span> ｜ <span className="text-amber-700">7〜8回 {warn.length}件</span></span>
            {resample && resample.skipped && resample.skipped.capped > 0 && (
              <span className="ml-2 fi-tap-text text-slate-500">※納期の遠い{resample.skipped.capped}件は今回は計算していません</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {rows.slice(0, 14).map((x) => (
              <span key={x.id}
                title={provOf(x)}
                className={`text-[11.5px] font-black rounded px-1.5 py-0.5 border ${of10(x) <= 6 ? 'bg-rose-50 border-rose-300 text-rose-700' : of10(x) <= 8 ? 'bg-amber-50 border-amber-300 text-amber-800' : 'bg-white border-emerald-300 text-emerald-700'}`}>
                {nameOf(x)} 10回中{of10(x)}回
              </span>
            ))}
            {rows.length > 14 && <span className="fi-tap-text text-slate-500 self-center">…ほか{rows.length - 14}件(危ない順)</span>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function OperationsSimulationPanel({ planShelf = null, publishOnly = false, isAdmin = false, readOverviewMap = null, lots, templates, workers, settings, saveSettings = null, canEdit, arrivalByLot = {}, factoryCalendar = null, otherAppWorkerNames = null, otherAppDailyLoad = null, ownDailyLoad = null, publishDailyLoad = null, capacityShelfLoaded = false, arrivalActuals = null, contactRequests = null, onEditModelTemplate = null, onRemoveModelTemplate = null, onRevertModelTemplate = null, modelTemplates = null, placementRules = null, savePlacementRule = null, onEditLot = null, onDeleteLot = null, onChangeLotPriority = null }) {
  return (
    <ErrorBoundary compact where="操業シミュレーション">
      <ItemNameProvider lots={lots} itemMaster={settings && settings.itemMaster}>
      <OperationsSimulationBody
        /* 📋 2026-09-22 保存計画の共有棚の口 { readHead, readVersion, listVersions, commitVersion }。
     🚨 渡されなければ 計画の保存・読み込みをしない(端末の中へ逃がさない)。
     端末ローカルに置くと 承認した計画も担当の固定も端末ごとに別物になり、
     同じ日に同じ画面を開いても答えが変わる(決まり 2026-07-17: 人の判断を端末に置かない)。 */
        planShelf={planShelf}
        arrivalByLot={arrivalByLot}
        arrivalActuals={arrivalActuals}
        contactRequests={contactRequests} placementRules={placementRules} savePlacementRule={savePlacementRule} onEditLot={onEditLot} onDeleteLot={onDeleteLot} onChangeLotPriority={onChangeLotPriority}
        factoryCalendar={factoryCalendar}
        otherAppWorkerNames={otherAppWorkerNames}
        otherAppDailyLoad={otherAppDailyLoad}
        ownDailyLoad={ownDailyLoad}
        publishOnly={publishOnly}
        publishDailyLoad={publishDailyLoad}
        capacityShelfLoaded={capacityShelfLoaded}
        lots={lots}
        templates={templates}
        workers={workers}
        settings={settings}
        saveSettings={saveSettings}
        canEdit={canEdit}
        isAdmin={isAdmin}
        readOverviewMap={readOverviewMap}
        onEditModelTemplate={onEditModelTemplate}
        onRemoveModelTemplate={onRemoveModelTemplate}
        onRevertModelTemplate={onRevertModelTemplate}
        modelTemplates={modelTemplates}
      />
      </ItemNameProvider>
    </ErrorBoundary>
  );
}

export default OperationsSimulationPanel;
