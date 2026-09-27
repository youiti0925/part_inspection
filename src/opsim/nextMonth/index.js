// 「来月の手当て」画面の入口。タブの枠から呼ぶのはここ1つ。
//   例) import { NextMonthPlan } from './opsim/nextMonth/index.js';
//       <NextMonthPlan monthly={result.monthly} decisionBoard={result.decisionBoard} />
export { NextMonthPlan, default } from './NextMonthPlan.jsx';
export {
  buildNextMonthView, NM_TONE, THIN_MONTH_RATIO, personDays, processTone, registrationThinness,
} from './model.js';
