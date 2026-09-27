import { buildPairInput } from './input.mjs';
export function exampleInput({ travelMin = 3, quantityA = 5, quantityB = 3, autoA = 30, autoB = 20, manualA = 4, manualB = 8, dueMin = 1000 } = {}) {
  const lot = (id, quantity, load, auto) => ({ id, label: `${id}・${quantity}台`, location: id, quantity, dueMin, releaseMin: 0,
    steps: [
      { id: 'load', label: '載せ替え・測定準備', kind: 'manual', durationMin: load, qualified: true, resourceId: `machine-${id}`, holdForNext: true, evidence: '架空の検証値' },
      { id: 'measure', label: '自動測定', kind: 'auto', durationMin: auto, unattended: true, resourceId: `machine-${id}`, holdForNext: true, evidence: '架空の検証値' },
      { id: 'unload', label: '終了対応・取外し', kind: 'manual', durationMin: 2, qualified: true, resourceId: `machine-${id}`, evidence: '架空の検証値' },
    ] });
  return buildPairInput({ lots: [lot('A', quantityA, manualA, autoA), lot('B', quantityB, manualB, autoB)], travel: { A: { B: travelMin }, B: { A: travelMin } }, startLocation: 'A', workerWindows: [[0, 2000]], resources: { 'machine-A': 0, 'machine-B': 0 }, origin: '同じ開始時点からの経過分', maxLotDelay: { A: 0, B: 0 } }).input;
}
