// 👤 名簿から人の色を引く唯一の入口(製品 App.jsx の vizWorkerTone と同じ式・P084)。名簿に居ない名前は灰色。
//  🚨 名前から直に色を決めない。必ず名簿全体から配った対応表を引く。
import { buildWorkerColors, toneOf } from './opsim/workerColors.js';

export const workerToneOf = (workers, name) =>
  toneOf(buildWorkerColors((workers || []).map((w) => (w && w.name) || '')), name);
