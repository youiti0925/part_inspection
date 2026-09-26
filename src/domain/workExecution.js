// 作業実行の共通判定 (純関数・UI/Firebase非依存)。
// ⚠この2関数がアプリ全体の「唯一の正」。App.jsx内にローカル定義を作り直さないこと。
//   (実測 2026-07-20: 同種のローカル定義が10箇所に散在し、目標計算側とロジックが食い違っていた)

// 工程マスタの照合キー。targetTimeStepKey と同形 (`${category}_${title}`)。
export const stepMasterKey = (step) => `${step?.category || ''}_${step?.title || ''}`;

// 現行の工程マスタ(テンプレート群)から「工程名 → 明示 executionMode」の索引を作る。
//   案②(清水判断 2026-07-20): 古いロット(executionMode未設定)の判定は、名称推定より先に
//   「今のマスタで同名工程がどう決まっているか」を優先する。同じ工程名の判定が時期で割れるのを防ぐため。
//   同名工程がマスタ内で矛盾(manualとbatchが混在)する場合は索引に入れない=名称推定へ落とす(推測で決めない)。
export const buildStepMasterIndex = (templates) => {
  const acc = new Map(); // key -> Set(explicit modes)
  (templates || []).forEach(t => (t?.steps || []).forEach(s => {
    const em = s?.executionMode;
    if (em !== 'manual' && em !== 'batch' && em !== 'auto') return; // 明示設定だけを採る
    const k = stepMasterKey(s);
    if (!acc.has(k)) acc.set(k, new Set());
    acc.get(k).add(em);
  }));
  const idx = new Map();
  acc.forEach((modes, k) => {
    const autoish = modes.has('batch') || modes.has('auto');
    const manualish = modes.has('manual');
    if (autoish && manualish) return; // 矛盾 → マスタでは決めない
    idx.set(k, autoish ? 'auto' : 'manual');
  });
  return idx;
};

// 自動工程判定 (清水指示 2026-07-20):
//   ① executionMode の明示設定を最優先。'manual' は名称に「自動」が入っていても手動。
//   ② rotaryLink=true (分割測定アプリ連携=機械が動く) は自動。
//   ③ 未設定の旧データのみ、現行マスタの同名工程の明示設定を優先 (案②)。
//   ④ それも無ければ名称推定。当面 /自動測定|測定開始/ に限定する (「自動」を広く拾わない)。
export const isAutoStep = (step, masterIndex = null) => {
  if (!step) return false;
  const em = step.executionMode;
  if (em === 'manual') return false;
  if (em === 'batch' || em === 'auto') return true;
  if (step.rotaryLink === true) return true;
  if (em) return false; // その他の明示値(sequential等)は名称推定しない
  if (masterIndex && typeof masterIndex.get === 'function') {
    const m = masterIndex.get(stepMasterKey(step));
    if (m === 'manual') return false;
    if (m === 'auto') return true;
  }
  return /(自動測定|測定開始)/.test(step.title || '');
};
export const isManualStep = (step, masterIndex = null) => !isAutoStep(step, masterIndex);

// 開始可否 (書込み直前に必ず通す・UIのdisabledだけに頼らない)。
//   規則: 自動+手動=許可 / 同一作業者の手動+手動=禁止(自動が動いているかは無関係)。
//   runningTasks: [{ workerId, step }] 進行中(processing)のタスク。
export function canStartTask({ workerId, targetStep, runningTasks = [], masterIndex = null } = {}) {
  if (isAutoStep(targetStep, masterIndex)) return { ok: true };
  const manualAlreadyRunning = (runningTasks || []).some(t =>
    t && t.workerId === workerId && !isAutoStep(t.step, masterIndex)
  );
  if (manualAlreadyRunning) {
    return { ok: false, code: 'manual-already-running', message: '手動作業を同時に2件は開始できません（先の作業を完了か一時停止してください）' };
  }
  return { ok: true };
}

// 🚦全開始経路の共通入口 (A.1)。画面タップ/音声/サイン/まとめて開始/ロット1回 は必ずここを通す。
//   経路ごとに「自分自身を除外する/しない」が食い違っていたのを、除外もここへ集約した。
//   excludeKey: 再開(paused→processing)時に自分自身のタスクが runningTasks に残っている場合の除外キー。
export function startGuard({ workerId, targetStep, runningTasks = [], excludeKey = null, excludeLotId = null, masterIndex = null } = {}) {
  // 全ロットの呼出元はロットIDも渡す。同じ工程キーの別ロットまで除外しない。
  const others = (runningTasks || []).filter(t => t && !(excludeKey != null && t.key === excludeKey
    && (excludeLotId == null || t.lotId === excludeLotId)));
  return canStartTask({ workerId, targetStep, runningTasks: others, masterIndex });
}
