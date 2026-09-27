// ============================================================================
// 🎯 historyEligibility.js — 「この工程は誰に頼めるか」の候補を作る（操業シミュレーター S1）
// ----------------------------------------------------------------------------
// 出典: 是正指示書 4章「正式力量が0件でもシミュレーションを止めない方法」
//       CONTRACT.md の historyEligibility.js の節
//
// なぜ別ファイルにするか:
//   soloDependency.js は「過去に誰がその工程をやったか」を数えた**根拠の表**であって、
//   配置の道具ではない。配置が使う形（工程 → 頼める人の一覧）へ変換する所を分けておくと、
//   数え方を直しても配置側が壊れず、配置の都合が数え方へ逆流する事も無い。
//   🚨 soloDependency.js をこのフォルダへ複製しない。import して使う（是正指示書7章）。
//
// 4区分（是正指示書 4章の表そのまま）:
//   certified        正式にレベル3・単独可と設定されている
//   provisional_id   過去タスクの workerId で本人が特定できる
//   provisional_name 一意な作業者名だけが残っている（確かさは1段低い）
//   unknown          誰がやったか分からない、または履歴が無い → 担当すると決めない
//
// 🚨 守る事:
//   ・実績が**1件でも**あれば、その人は候補。件数で足切りしない。
//     件数は「誰に先に頼むか」の**並び順**にだけ使う。
//     （足切りを1行足すと、実績を持っている人が候補から消え、その仕事が二度と回らない。
//       覚える機会も消える = 実害。だから可否の判定に件数を渡す経路を作らない）
//   ・履歴が無い＝「分かりません」。やれない、という意味ではない。返す文もそう書く。
//   ・正式認定へ**書き戻さない**。返す物は読み取り専用（Object.freeze）にして、
//     うっかり書き換えたらその場で落ちるようにしてある。
//   ・現在時刻を関数の中で取らない（時刻を使う所が1つも無い）。同じ入力なら毎回同じ結果（S23）。
//   ・React / Firebase を import しない（node --test で単体で動く）。
//   ・禁じ語（dispatchWords.js の FORBIDDEN_WORDS）を、返す文にも註釈にも1語も書かない。
//     この見張りは、ファイルの中身を丸ごと走査される前提で書いてある（註釈も対象）。
//
// ⚠ processKey の作り方は soloDependency.js の processKeyOf(templateId, step.id) ただ1つ。
//   normalizeInput 側の steps[].processKey も同じ関数で作った物である事が前提。
//   別の作り方で作った鍵を渡すと、どの工程にも当たらず「分かりません」になる。
// ============================================================================

import { BUCKET, docIdOf, parseProcessKey } from '../soloDependency.js';

// ── 小道具 ───────────────────────────────────────────────────────────────────
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
/**
 * 文字列の並べ替え。🚨 localeCompare を使わない。
 * 端末の ICU の版で並びが変わると、同じ入力で結果が変わる（S23 が環境で割れる）。
 */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── 区分 ─────────────────────────────────────────────────────────────────────
export const EVIDENCE = Object.freeze({
  CERTIFIED: 'certified',
  PROV_ID: 'provisional_id',
  PROV_NAME: 'provisional_name',
  UNKNOWN: 'unknown',
});

/** 画面にそのまま出せる短い言い方。🚨 言い換えはここ1箇所に閉じ込める。 */
export const EVIDENCE_LABEL = Object.freeze({
  certified: 'スキルとして登録されています（管理者の登録）',
  provisional_id: '過去の作業記録にIDが残っています（実績からの仮定）',
  provisional_name: '一意な作業者名だけが残っています（実績からの仮定・確かさは1段低い）',
  unknown: '分かりません（この工程の記録が無い、または誰がやったか分からない）',
});

/** 並び順だけに使う序列。🚨 これは足切りの段ではない。下の段の人を候補から消さない。 */
const EVIDENCE_RANK = Object.freeze({ certified: 0, provisional_id: 1, provisional_name: 2, unknown: 3 });

/** mode:'all' … 全員が全工程を担当する仮定（是正指示書 4-1 の総量確認シナリオ）。 */
export const MODE_ALL = 'all';

/** 既定の見方。是正指示書 4章「既定の初期モードは provisional_id + provisional_name」。 */
export const DEFAULT_MODE = Object.freeze([EVIDENCE.PROV_ID, EVIDENCE.PROV_NAME]);

/**
 * 正式に「単独可」と見なすレベル。
 * 是正指示書 4章の「レベル3・単独可」と、SkillMap.jsx の SKILL_LEVELS（3=熟練）から取った。
 * 🚨 式の中へ数字を直書きしない。skillConfig.certifiedLevel で外から変えられる。
 */
export const CERTIFIED_LEVEL = 3;

// ── mode の読み取り ──────────────────────────────────────────────────────────
/**
 * mode を正規化する。
 * 受け付ける形: 'all' / 'provisional_id' などの1語 / それらの配列。
 * 🚨 知らない語は**投げる**。綴りを間違えたまま黙って進むと、候補が静かに減って
 *    「技能が足りない」という嘘の結論が出る（見張りが黙って通るのが一番危ない）。
 */
function normalizeMode(mode) {
  const raw = Array.isArray(mode) ? mode : [mode];
  const given = raw.map((m) => trimmed(m)).filter((m) => m);
  // 🚨 空（null / undefined / '' / []）は「見方を指定していない」＝既定の見方。
  //   関数の既定引数は **undefined にしか効かない**。null を渡す呼び方が実在する
  //   （OperationsSimulationPanel.jsx の mode = scenarioKey==='allSkills' ? MODE_ALL : null）。
  //   ここで null を「certified だけ」と読むと、正式な力量の設定が0件の本番で
  //   候補が全部消え、実績がある人まで「分かりません」に化ける（実測で確認）。
  //   Worker 側（operationsSimulation.worker.js）は同じ null を DEFAULT_MODE へ直している。
  //   2か所で見方が割れないよう、ここで一本化する。
  const list = given.length ? given : [...DEFAULT_MODE];
  if (list.includes(MODE_ALL)) {
    return {
      all: true,
      accepted: null,
      value: MODE_ALL,
      label: '全員が全工程を担当する仮定（総量の確認）',
    };
  }
  const known = new Set([EVIDENCE.CERTIFIED, EVIDENCE.PROV_ID, EVIDENCE.PROV_NAME]);
  const bad = list.filter((m) => !known.has(m));
  if (bad.length) {
    throw new Error(
      `historyEligibility: 知らない mode があります: ${bad.join(' / ')}。`
      + ` 使えるのは '${MODE_ALL}' / '${EVIDENCE.CERTIFIED}' / '${EVIDENCE.PROV_ID}' / '${EVIDENCE.PROV_NAME}' です。`,
    );
  }
  // 🚨 certified は常に受け入れる。
  //   正式に設定された力量は、実績からの仮定より強い根拠である。
  //   これを mode の綴り次第で外すと、既定の見方（provisional 2種）で
  //   正式認定の人と、S21 の「仮に単独可とした後継者」が候補から消えてしまう。
  const accepted = new Set(list);
  accepted.add(EVIDENCE.CERTIFIED);
  const ordered = [EVIDENCE.CERTIFIED, EVIDENCE.PROV_ID, EVIDENCE.PROV_NAME].filter((e) => accepted.has(e));
  const label = ordered.length === 1
    ? '正式に設定された力量だけで確認'
    : '実績から作った仮定の候補で確認（正式認定ではありません）';
  return { all: false, accepted, value: ordered, label };
}

// ── 正式な力量の設定（実データには今のところ1件も無い） ──────────────────────
/**
 * skillConfig から「正式にレベル3・単独可」を読む。
 *
 * 受け付ける形は2通りだけ。どちらも無ければ certified は0件になる（それで正常。
 * 実測で template.requiredSkills も settings.workerSkills も本番に無い）。
 *
 *  (A) 明示の一覧 … skillConfig.byProcess = { [processKey]: ['尾田', ...] }
 *      ⚠ 同じ意味の別名として skillConfig.certified も受ける。
 *        呼ぶ側から見て「この工程はこの人が正式に単独で任せられる」を渡す口は
 *        1つで足りるのに、名前を byProcess ただ1つに縛ると、読んだとおりに
 *        `certified:{...}` と書いた呼び方が **黙って0件** になる。0件は
 *        「正式認定が無い」と同じ見た目で返るので、間違いに気付けないまま
 *        「技能が足りない」という嘘の結論が出る。だから両方の綴りを受ける。
 *  (B) アプリが今持っている形 … skillConfig.workerSkills = { 作業者名: { skillId: レベル } }
 *      ＋ skillConfig.templates = [{ id, requiredSkills:[ 'sk_x' | {skillId, level} ] }]
 *      → その検査表が使うスキルを**全部**レベル3以上で持つ人を、その検査表の全工程で certified とする。
 *
 * 🚨 requiredSkills が空の検査表では、誰も certified にしない。
 *    「必要なスキルが0件だから全員が条件を満たす」と数えると、設定が無いだけの検査表で
 *    全員に正式認定が付いてしまう。設定が無い＝「分かりません」である。
 *
 * @returns {{byProcess: Map<string, Set<string>>, source: string, pairs: number, templatesWithSkills: number}}
 */
function readFormalCertification(skillConfig, processes) {
  const out = { byProcess: new Map(), source: 'none', pairs: 0, templatesWithSkills: 0 };
  if (!isObj(skillConfig)) return out;

  const add = (processKey, name) => {
    const k = str(processKey);
    const n = trimmed(name);
    if (!k || !n) return;
    let s = out.byProcess.get(k);
    if (!s) { s = new Set(); out.byProcess.set(k, s); }
    if (!s.has(n)) { s.add(n); out.pairs += 1; }
  };

  // (A) 明示の一覧。byProcess と certified は同じ意味なので、両方読んで重ねる。
  //     ⚠ 並び順で結果が変わらないよう、鍵は必ず昇順で回す（S23）。
  const explicitMaps = [skillConfig.byProcess, skillConfig.certified].filter((m) => isObj(m));
  if (explicitMaps.length > 0) {
    out.source = 'byProcess';
    explicitMaps.forEach((map) => {
      Object.keys(map).sort(cmpStr).forEach((key) => {
        const names = map[key];
        const list = names instanceof Set ? [...names] : asArray(names);
        list.forEach((n) => add(key, typeof n === 'string' ? n : n?.name));
      });
    });
  }

  // (B) 検査表の必要スキル × 作業者のレベル
  const workerSkills = isObj(skillConfig.workerSkills) ? skillConfig.workerSkills : null;
  const templates = asArray(skillConfig.templates);
  if (workerSkills && templates.length) {
    out.source = out.source === 'byProcess' ? 'byProcess+workerSkills' : 'workerSkills';
    const soloLevel = Number.isFinite(Number(skillConfig.certifiedLevel))
      ? Number(skillConfig.certifiedLevel)
      : CERTIFIED_LEVEL;

    // 検査表 → 必要スキル [{skillId, level}]
    const needByTemplate = new Map();
    templates.forEach((t) => {
      const tid = docIdOf(t);
      if (!tid) return;
      // 2026-09-03 決まり17: { skillId, stepIds:[] } を受ける。stepIds 空＝全工程／入っていればその工程だけ。
      //   （skillRegistry.js normalizeRequiredSkills と同じ読み方。level は使わない＝配れる線は certifiedLevel ただ1つ）
      const need = asArray(t?.requiredSkills)
        .map((rs) => (typeof rs === 'string'
          ? { skillId: rs, level: soloLevel, stepIds: [] }
          // 検査表側が要求するレベルの方が高ければ、そちらを立てる（緩める方へは動かさない）
          : {
            skillId: str(rs?.skillId),
            level: Math.max(soloLevel, int(rs?.level)),
            stepIds: asArray(rs?.stepIds).map((x) => str(x)).filter((x) => x),
          }))
        .filter((x) => x.skillId);
      if (need.length) {
        needByTemplate.set(tid, need);
        out.templatesWithSkills += 1;
      }
    });

    if (needByTemplate.size) {
      const levelOf = (name, skillId) => int(workerSkills?.[name]?.[skillId]);
      const names = Object.keys(workerSkills).map((n) => trimmed(n)).filter((n) => n).sort(cmpStr);
      processes.forEach((p) => {
        const needAll = needByTemplate.get(str(p?.templateId));
        if (!needAll) return; // 必要スキルが未設定の検査表 → 誰にも正式認定を付けない
        // 🎯 工程ごとに絞る。★特注機のような「一部の工程だけに効くスキル」は、その工程でだけ要る。
        //   絞った結果 0件の工程（要るスキルが全部ほかの工程向け）は、設定が無いのと同じ＝誰にも付けない。
        const stepId = parseProcessKey(str(p?.key)).stepId;
        const need = needAll.filter((x) => x.stepIds.length === 0 || x.stepIds.includes(stepId));
        if (!need.length) return;
        names.forEach((n) => {
          if (need.every((x) => levelOf(n, x.skillId) >= x.level)) add(str(p?.key), n);
        });
      });
    }
  }

  return out;
}

// ── 名簿 ─────────────────────────────────────────────────────────────────────
/**
 * 候補になり得る人の名簿を作る。
 * 🚨 シミュレーションは人を**名前**で見分ける（休みの設定 settings.workerRoster も名前が鍵）。
 *    だから名簿の鍵は名前。名前が空の登録は、この画面では扱えないので別に数えて返す。
 *
 * 名簿に入れる人:
 *   ・workers（今いる人）
 *   ・soloResult に実績が残っている人（名簿から外れていても候補から黙って消さない）
 *   ・scenario.assumeCertified で名指しされた人（利用者が置いた仮定）
 */
function buildRoster({ workers, processes, assumeNames }) {
  const byName = new Map();
  const nameless = [];
  const duplicateNames = new Set();
  const put = (name, workerId, from) => {
    const n = trimmed(name);
    const id = str(workerId);
    if (!n) {
      if (id) nameless.push(id);
      return;
    }
    const cur = byName.get(n);
    if (!cur) {
      byName.set(n, { name: n, workerId: id, from: new Set([from]) });
      return;
    }
    cur.from.add(from);
    if (!cur.workerId && id) cur.workerId = id;
    // 同姓同名。🚨 どちらかへ寄せない。印だけ付けて、判断は人に返す。
    else if (id && cur.workerId !== id) duplicateNames.add(n);
  };

  // 並び順を安定させてから入れる（先に入った方の workerId が残るため）
  asArray(workers)
    .map((w) => ({ name: trimmed(w?.name), workerId: str(w?.workerId) || docIdOf(w) }))
    .sort((a, b) => cmpStr(a.name, b.name) || cmpStr(a.workerId, b.workerId))
    .forEach((w) => put(w.name, w.workerId, 'roster'));

  const fromHistory = new Set();
  processes.forEach((p) => {
    asArray(p?.people)
      .map((x) => ({ name: trimmed(x?.workerName), workerId: str(x?.workerId) }))
      .sort((a, b) => cmpStr(a.name, b.name) || cmpStr(a.workerId, b.workerId))
      .forEach((x) => {
        if (x.name && !byName.has(x.name)) fromHistory.add(x.name);
        put(x.name, x.workerId, 'history');
      });
  });

  const fromScenario = new Set();
  [...assumeNames].sort(cmpStr).forEach((n) => {
    if (!byName.has(n)) fromScenario.add(n);
    put(n, '', 'scenario');
  });

  const list = [...byName.values()].sort((a, b) => cmpStr(a.name, b.name));
  return {
    list,
    byName,
    namelessWorkerIds: [...new Set(nameless)].sort(cmpStr),
    duplicateNames: [...duplicateNames].sort(cmpStr),
    onlyInHistory: [...fromHistory].sort(cmpStr),
    onlyInScenario: [...fromScenario].sort(cmpStr),
  };
}

// ── シナリオの仮定（S21） ────────────────────────────────────────────────────
/**
 * scenario.assumeCertified = [{ name, processKey }] を読む。
 * 🚨 元データ（soloResult / skillConfig / 本番の設定）は1文字も変えない。
 *    ここで作った仮定は、この関数が返す物の中だけに生きる。
 * workerId で指定された時は、名簿の名前へ読み替える（名前が見つからなければ受け取れないので数えて返す）。
 */
function readAssumeCertified(scenario, workers) {
  const rows = asArray(scenario?.assumeCertified);
  const nameOfId = new Map();
  asArray(workers).forEach((w) => {
    const id = str(w?.workerId) || docIdOf(w);
    const n = trimmed(w?.name);
    if (id && n && !nameOfId.has(id)) nameOfId.set(id, n);
  });
  const applied = [];
  const ignored = [];
  rows.forEach((row) => {
    const processKey = str(row?.processKey);
    const name = trimmed(row?.name) || nameOfId.get(str(row?.workerId)) || '';
    if (!processKey || !name) {
      ignored.push({ name, processKey, reason: '名前と工程の両方が要ります' });
      return;
    }
    applied.push({ name, processKey });
  });
  applied.sort((a, b) => cmpStr(a.processKey, b.processKey) || cmpStr(a.name, b.name));
  ignored.sort((a, b) => cmpStr(a.processKey, b.processKey) || cmpStr(a.name, b.name));
  return { applied, ignored, names: new Set(applied.map((x) => x.name)) };
}

// ── 候補1人ぶん ──────────────────────────────────────────────────────────────
/**
 * 候補の並べ替え。
 * 🚨 ここに「件数がN件未満なら外す」を足さない。件数は**順番**にだけ効く（可否には効かない）。
 *    taskCount は同じ工程の中で比べる時だけ意味がある（工程をまたいで足すと台と回が混ざる）。
 */
// 🚨 決まり29（2026-09-05 清水さん「一回の人より100回の方に仕事任せる方が間違いないからね」）:
//   同じ区分の中では **完了ロットの回数(lotCount)が多い人を先に**、次に工程の回数(taskCount)。
//   区分(登録あり＞実績あり)は変えない（登録は清水さんの明示の判断）。可否には効かない＝順番だけ。
const compareCandidates = (a, b) => (
  (EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence])
  || (b.lotCount - a.lotCount)
  || (b.taskCount - a.taskCount)
  || cmpStr(a.name, b.name)
  || cmpStr(a.workerId, b.workerId)
);

const freezeCandidate = (c) => Object.freeze({
  name: c.name,
  evidence: c.evidence,
  workerId: c.workerId,
  taskCount: c.taskCount,
  lotCount: c.lotCount,
  assumed: c.assumed,
  label: EVIDENCE_LABEL[c.evidence],
});

// ── 本体 ─────────────────────────────────────────────────────────────────────
/**
 * 工程ごとの担当候補を作る。
 *
 * @param {object} args
 * @param {object} args.soloResult  computeSoloDependency() の戻り値（必須）
 * @param {Array}  args.workers     今いる人。[{workerId,name}] でも [{id,name}] でも可
 * @param {object|null} args.skillConfig 正式な力量の設定（無ければ null。実データは今0件）
 * @param {string|string[]} args.mode 既定 ['provisional_id','provisional_name'] / 'all' で総量シナリオ
 * @param {object} args.scenario    { assumeCertified: [{name, processKey}] } … S21 の仮定
 * @returns {{byProcess: object, eligibleFor: function, stats: object}}
 *
 * 🚨 返る物は読み取り専用。書き換えようとするとその場で落ちる（正式認定への書き戻し防止）。
 *    eligibleFor だけは毎回**新しい配列**を返すので、呼んだ側で並べ替えて良い。
 */
export function buildEligibility({
  soloResult,
  workers,
  skillConfig = null,
  mode = DEFAULT_MODE,   // ⚠ 既定値の直書きをやめ、DEFAULT_MODE ただ一つを源にする
  scenario = {},
} = {}) {
  if (!isObj(soloResult) || !Array.isArray(soloResult.processes)) {
    // 🚨 黙って「候補0人」を返さない。それは「技能が足りない」という嘘の結論になる。
    throw new Error('historyEligibility: soloResult（computeSoloDependency の戻り値）が要ります。');
  }
  const norm = normalizeMode(mode);
  const processes = asArray(soloResult.processes);

  const assume = readAssumeCertified(scenario, workers);
  const roster = buildRoster({ workers, processes, assumeNames: assume.names });
  const formal = readFormalCertification(skillConfig, processes);

  // 仮定で足す工程が soloResult に無い事もある（誰もまだやっていない工程を後継者に任せる仮定）
  const assumeByProcess = new Map();
  assume.applied.forEach(({ name, processKey }) => {
    let s = assumeByProcess.get(processKey);
    if (!s) { s = new Set(); assumeByProcess.set(processKey, s); }
    s.add(name);
  });

  const byProcess = {};
  const acceptedLists = new Map();   // processKey -> 読み取り専用の候補配列（mode 適用後）
  const allCandidates = new Map();   // processKey -> 区分に関係ない全候補（stats 用）
  const unknownProcesses = [];
  const lowConfidenceProcesses = [];
  const namesNotAttributed = new Map(); // 誰にも寄せなかった名前 -> 件数
  const byEvidence = { certified: 0, provisional_id: 0, provisional_name: 0, unknown: 0 };
  const candidateTotals = { certified: 0, provisional_id: 0, provisional_name: 0 };
  let candidatesWithoutName = 0;

  // mode:'all' で使う「実績が無い人」の札。仮定である事を assumed:true で残す。
  const assumedUnknownOf = (w) => ({
    name: w.name, workerId: w.workerId, evidence: EVIDENCE.UNKNOWN,
    taskCount: 0, lotCount: 0, assumed: true,
  });

  const keys = new Set(processes.map((p) => str(p?.key)).filter((k) => k));
  assumeByProcess.forEach((_v, k) => keys.add(k));
  // 🚨 2026-09-03 決まり17: スキルの登録で「まだ誰もやった事が無い工程」に人を付けた時、その工程も鍵に入れる。
  //   入れないと、登録した人が candidate に一度も載らず、実績0件の工程は永久に「分かりません」のまま
  //   （最終検査の写しで実測: 特注:チャック仕様 を登録しても 手が付かない仕事 5件が 5件のまま）。
  formal.byProcess.forEach((_v, k) => keys.add(k));

  const processByKey = new Map(processes.map((p) => [str(p?.key), p]));

  [...keys].sort(cmpStr).forEach((key) => {
    const p = processByKey.get(key) || null;
    const members = new Map(); // name -> 候補

    // ① 実績（soloDependency が「やった記録がある」と数えた人）
    asArray(p?.people).forEach((person) => {
      const name = trimmed(person?.workerName);
      if (!name) {
        // 名前が無い登録作業者。シミュレーションは名前で人を見分けるので扱えない。黙って捨てず数える。
        candidatesWithoutName += 1;
        return;
      }
      // person.evidence は soloDependency の言い方（'workerId' / 'name'）
      const evidence = person?.evidence === 'workerId' ? EVIDENCE.PROV_ID : EVIDENCE.PROV_NAME;
      members.set(name, {
        name,
        workerId: str(person?.workerId),
        evidence,
        taskCount: int(person?.taskCount),
        lotCount: int(person?.lotCount),
        assumed: false,
      });
    });

    // ② 正式な力量の設定（あれば実績より強い区分へ上げる。件数はそのまま残す）
    (formal.byProcess.get(key) || new Set()).forEach((name) => {
      const cur = members.get(name);
      if (cur) { cur.evidence = EVIDENCE.CERTIFIED; return; }
      const w = roster.byName.get(name);
      members.set(name, {
        name,
        workerId: w ? w.workerId : '',
        evidence: EVIDENCE.CERTIFIED,
        taskCount: 0,
        lotCount: 0,
        assumed: false,
      });
    });

    // ③ シナリオの仮定（S21）。元データは変えず、この結果の中だけで certified 扱いにする。
    (assumeByProcess.get(key) || new Set()).forEach((name) => {
      const cur = members.get(name);
      if (cur) { cur.evidence = EVIDENCE.CERTIFIED; cur.assumed = true; return; }
      const w = roster.byName.get(name);
      members.set(name, {
        name,
        workerId: w ? w.workerId : '',
        evidence: EVIDENCE.CERTIFIED,
        taskCount: 0,
        lotCount: 0,
        assumed: true,
      });
    });

    const all = [...members.values()].map(freezeCandidate).sort(compareCandidates);
    allCandidates.set(key, all);

    const pick = (ev) => all.filter((c) => c.evidence === ev).map((c) => c.name);
    const certified = pick(EVIDENCE.CERTIFIED);
    const provId = pick(EVIDENCE.PROV_ID);
    const provName = pick(EVIDENCE.PROV_NAME);
    byProcess[key] = Object.freeze({
      certified: Object.freeze(certified),
      provisional_id: Object.freeze(provId),
      provisional_name: Object.freeze(provName),
    });
    candidateTotals.certified += certified.length;
    candidateTotals.provisional_id += provId.length;
    candidateTotals.provisional_name += provName.length;

    // 工程1件を、一番強い根拠でちょうど1つに数える
    if (certified.length) byEvidence.certified += 1;
    else if (provId.length) byEvidence.provisional_id += 1;
    else if (provName.length) byEvidence.provisional_name += 1;
    else byEvidence.unknown += 1;

    // 確かさが1段低い工程（名前だけの記録しかない）。画面で低信頼として出す（S19）
    if (!certified.length && !provId.length && provName.length) lowConfidenceProcesses.push(key);

    // mode を当てた後の候補
    let accepted;
    if (norm.all) {
      // 総量シナリオ: 実績がある人はその区分のまま、残り全員は「仮定」として足す
      const rest = roster.list
        .filter((w) => !members.has(w.name))
        .map((w) => freezeCandidate(assumedUnknownOf(w)));
      accepted = [...all, ...rest].sort(compareCandidates);
    } else {
      accepted = all.filter((c) => norm.accepted.has(c.evidence));
    }
    acceptedLists.set(key, Object.freeze(accepted));

    // 誰も居ない工程は「分かりません」。🚨 やれない、とは書かない。
    if (accepted.length === 0) {
      let reason;
      let note;
      if (all.length > 0) {
        reason = 'not_accepted_by_mode';
        note = 'この工程の記録はありますが、いまの見方では候補に入れていません';
      } else if (p && p.bucket === BUCKET.UNCLEAR) {
        reason = 'doer_unknown';
        note = '記録はありますが、誰がやったか分かりません（名前が残っていない・同姓同名・登録に無い名前）';
      } else {
        reason = 'no_record';
        note = 'この工程をやった記録がまだ1件もありません。分かりません';
      }
      unknownProcesses.push(Object.freeze({
        processKey: key,
        stepTitle: trimmed(p?.stepTitle),
        templateName: trimmed(p?.templateName) || null,
        reason,
        note,
      }));
    }

    // 誰にも寄せなかった名前（S20）。自由入力の名前と同姓同名。
    asArray(p?.unregisteredNames).forEach((u) => {
      const n = trimmed(u?.name);
      if (!n) return;
      namesNotAttributed.set(n, (namesNotAttributed.get(n) || 0) + int(u?.taskCount));
    });
    asArray(p?.ambiguousNames).forEach((u) => {
      const n = trimmed(u?.name);
      if (!n) return;
      namesNotAttributed.set(n, (namesNotAttributed.get(n) || 0) + int(u?.taskCount));
    });
  });

  Object.freeze(byProcess);

  // mode:'all' で、soloResult に無い工程を聞かれた時に返す一覧
  const allWorkersAssumed = Object.freeze(
    roster.list.map((w) => freezeCandidate(assumedUnknownOf(w))).sort(compareCandidates),
  );

  /**
   * その工程を頼める人。
   * @param {string} processKey soloDependency の processKeyOf(templateId, step.id)
   * @returns {Array<{name:string, evidence:string}>} 先頭ほど先に頼む候補。毎回新しい配列を返す
   *
   * 🚨 空配列は「分かりません」であって、やれないという意味ではない。
   *    呼んだ側は理由を stats.unknownProcesses から取って、必ず理由付きで出す事。
   */
  function eligibleFor(processKey) {
    const hit = acceptedLists.get(str(processKey));
    if (hit) return hit.slice();
    // 知らない工程。総量シナリオは「全員が全工程」なので全員、それ以外は「分かりません」。
    return norm.all ? allWorkersAssumed.slice() : [];
  }

  // ── 確かさ（soloDependency が測った値をそのまま持ち出す。ここで作り直さない） ──
  const conf = isObj(soloResult.confidence) ? soloResult.confidence : {};
  const evidenceQuality = Object.freeze({
    tasksEvaluated: int(conf.tasksEvaluated),
    provenByWorkerId: int(conf.provenByWorkerId),
    byNameOnly: int(conf.byNameOnly),
    unattributedTasks: int(conf.unattributedTasks),
    ambiguousNameTasks: int(conf.ambiguousNameTasks),
    unregisteredNameTasks: int(conf.unregisteredNameTasks),
    provenByWorkerIdRatio: conf.provenByWorkerIdRatio ?? null,
  });

  // ── 画面にそのまま出せる文（禁じ語を1語も入れない） ──
  const sentences = [
    norm.all
      ? '全員が全工程を担当する仮定で試算しています（総量の確認）。実績の裏付けはありません。'
      : '暫定力量: 過去の担当履歴から試算。正式認定ではありません。',
    '実績が1件でもあれば、その人はその工程をやった記録があります。回数は「誰に先に頼むか」の順番にだけ使っています。',
    '実績なし＝「分かりません」。やれないという意味ではありません。1回でもやれば、その人の実績になります。',
  ];
  if (evidenceQuality.unattributedTasks > 0) {
    sentences.push(
      `誰がやったか記録が無い作業が ${evidenceQuality.unattributedTasks}件あります。`
      + 'その分だけ、頼める人が少なく見えています。',
    );
  }
  if (formal.pairs === 0) {
    sentences.push('正式な力量の設定は0件です。ここに出ている候補は全部、実績から作った仮定です。');
  }

  const notes = [
    '🚨 正式認定へ書き戻していません。この結果は試算の中だけに生きます。',
    '🚨 件数は並び順にだけ使っています。件数で候補を外していません。',
    '工程の身元は soloDependency の processKeyOf(templateId, step.id)。工程名では束ねていません。',
  ];
  if (roster.duplicateNames.length) {
    notes.push(`同姓同名の登録があります: ${roster.duplicateNames.join('・')}。名前だけの記録はどちらへも寄せていません。`);
  }
  if (roster.onlyInHistory.length) {
    notes.push(`実績はあるが今の作業者一覧に居ない人: ${roster.onlyInHistory.join('・')}。候補から黙って消さず、名簿に残しています。`);
  }
  if (candidatesWithoutName > 0) {
    notes.push(`名前が空の作業者の記録が ${candidatesWithoutName}件あります。この画面は人を名前で見分けるため、候補にしていません。`);
  }
  if (assume.ignored.length) {
    notes.push(`仮の単独可のうち、名前か工程が足りず受け取れなかった指定が ${assume.ignored.length}件あります。`);
  }

  const stats = Object.freeze({
    mode: norm.value,
    modeLabel: norm.label,
    acceptedEvidence: Object.freeze(norm.all ? [MODE_ALL] : [...norm.value]),
    processCount: keys.size,
    workerCount: roster.list.length,
    workerNames: Object.freeze(roster.list.map((w) => w.name)),
    byEvidence: Object.freeze(byEvidence),
    candidateTotals: Object.freeze(candidateTotals),
    unknownProcessCount: unknownProcesses.length,
    unknownProcesses: Object.freeze(unknownProcesses),
    lowConfidenceProcesses: Object.freeze(lowConfidenceProcesses.sort(cmpStr)),
    namesNotAttributed: Object.freeze(
      [...namesNotAttributed.entries()]
        .map(([name, taskCount]) => Object.freeze({ name, taskCount }))
        .sort((a, b) => (b.taskCount - a.taskCount) || cmpStr(a.name, b.name)),
    ),
    duplicateWorkerNames: Object.freeze(roster.duplicateNames),
    workersOnlyInHistory: Object.freeze(roster.onlyInHistory),
    workersOnlyInScenario: Object.freeze(roster.onlyInScenario),
    candidatesWithoutName,
    formalSkill: Object.freeze({
      source: formal.source,
      pairs: formal.pairs,
      templatesWithSkills: formal.templatesWithSkills,
      certifiedLevel: Number.isFinite(Number(skillConfig?.certifiedLevel))
        ? Number(skillConfig.certifiedLevel)
        : CERTIFIED_LEVEL,
    }),
    assumeCertified: Object.freeze({
      applied: Object.freeze(assume.applied.map((x) => Object.freeze({ ...x }))),
      ignored: Object.freeze(assume.ignored.map((x) => Object.freeze({ ...x }))),
      // soloResult に無い工程へ仮定を置いた分（まだ誰もやっていない工程を任せる仮定）
      processKeysAdded: Object.freeze(
        [...assumeByProcess.keys()].filter((k) => !processByKey.has(k)).sort(cmpStr),
      ),
    }),
    evidenceQuality,
    sentences: Object.freeze(sentences),
    notes: Object.freeze(notes),
  });

  return Object.freeze({ byProcess, eligibleFor, stats });
}

/**
 * 1つの工程について、画面に出す短い説明を作る。
 * 🚨 言い換えを1箇所に閉じ込めるための物。ここを通さずに勝手な言い方を書かない。
 */
export function eligibilitySentence(eligibility, processKey) {
  const list = eligibility?.eligibleFor ? eligibility.eligibleFor(processKey) : [];
  if (!list.length) {
    const why = (eligibility?.stats?.unknownProcesses || []).find((u) => u.processKey === str(processKey));
    return why ? `分かりません（${why.note}）` : '分かりません（この工程の記録がありません）';
  }
  const head = list[0];
  const rest = list.length - 1;
  const who = rest > 0 ? `${head.name}さん ほか${rest}人` : `${head.name}さん`;
  const mark = head.assumed ? '（仮の設定）' : '';
  return `${who}／${EVIDENCE_LABEL[head.evidence]}${mark}`;
}

// ============================================================================
// 決まり14-3・16（2026-09-03 清水さん「暇な理由が 仕事が全く無いのか スキルが無いのか」）の材料
// ----------------------------------------------------------------------------
//  人ごとに「いま配れる仕事」と「登録すると配れる対象になる仕事（テンプレ別・要るスキル付き）」を数える。
//  🚨 数えるだけ。割付をし直した結果ではない（引き直しは operationsSimulation/decisionBoard.js の仮付与）。
//  🚨 「登録すると配れる」は、そのテンプレに requiredSkills が付いている時だけ本当。
//     付いていないテンプレは needsTemplateSkills:true で返す（先にテンプレ編集画面で要るスキルを付ける）。
//  🚨 数字を作らない: jobs / lots は normalizeInput の戻り（normalized.jobs / normalized.lots）をそのまま数える。
// ============================================================================

/**
 * @param {object} args
 * @param {object} args.eligibility  buildEligibility の戻り（eligibleFor を使う）
 * @param {Array}  args.jobs         normalized.jobs（{ jobId, lotId, processKey }）
 * @param {Array}  args.lots         normalized.lots（{ lotId, templateId, model }）
 * @param {Array}  args.templates    元のテンプレ（name / requiredSkills を読む。書き換えない）
 * @param {string[]} args.workerNames 名簿
 * @returns {Object<string, {
 *   assignableJobs:number, totalJobs:number, assignableLots:number, totalLots:number,
 *   registrableJobs:number, registrableLots:number,
 *   byTemplate: Array<{ templateId, name, jobCount, lotCount, requiredSkills:string[], needsTemplateSkills:boolean,
 *                       nobodyJobs:number, othersJobs:number }>
 * }>}
 *   nobodyJobs … 誰にも記録も登録も無い仕事（画面は「分かりません」）
 *   othersJobs … 他の人には記録か登録があるが、この人には無い仕事
 */
export function registrableWorkByWorker({ eligibility, jobs, lots, templates, workerNames } = {}) {
  const out = {};
  const names = asArray(workerNames).map((n) => trimmed(n)).filter((n) => n);
  if (!names.length) return out;
  const canAsk = !!(eligibility && typeof eligibility.eligibleFor === 'function');
  const lotById = new Map();
  asArray(lots).forEach((l) => { const id = str(l?.lotId); if (id) lotById.set(id, l); });
  const tplById = new Map();
  asArray(templates).forEach((t) => { const id = docIdOf(t); if (id) tplById.set(id, t); });
  const reqOf = (t) => asArray(t?.requiredSkills)
    .map((rs) => (typeof rs === 'string' ? trimmed(rs) : trimmed(str(rs?.skillId))))
    .filter((x) => x);
  const cache = new Map();
  const namesFor = (pk) => {
    if (!canAsk) return [];
    let v = cache.get(pk);
    if (!v) {
      v = asArray(eligibility.eligibleFor(pk)).map((c) => (typeof c === 'string' ? c : trimmed(c?.name))).filter((x) => x);
      cache.set(pk, v);
    }
    return v;
  };
  const jobList = asArray(jobs).filter((j) => j && j.lotId != null && j.processKey != null);
  const totalLots = new Set(jobList.map((j) => str(j.lotId))).size;

  names.forEach((who) => {
    let assignableJobs = 0;
    const assignableLotSet = new Set();
    const registrableLotSet = new Set();
    const byTpl = new Map();
    jobList.forEach((j) => {
      const pk = str(j.processKey);
      const lotId = str(j.lotId);
      const who_ok = namesFor(pk).includes(who);
      if (who_ok) { assignableJobs += 1; assignableLotSet.add(lotId); return; }
      const lot = lotById.get(lotId) || null;
      const tid = str(lot?.templateId);
      const t = tplById.get(tid) || null;
      let row = byTpl.get(tid);
      if (!row) {
        const req = reqOf(t);
        row = { templateId: tid, name: str(t?.name) || tid, jobCount: 0, lotIds: new Set(), requiredSkills: req, needsTemplateSkills: req.length === 0, nobodyJobs: 0, othersJobs: 0 };
        byTpl.set(tid, row);
      }
      row.jobCount += 1;
      row.lotIds.add(lotId);
      registrableLotSet.add(lotId);
      if (namesFor(pk).length === 0) row.nobodyJobs += 1; else row.othersJobs += 1;
    });
    const byTemplate = [...byTpl.values()]
      .map((r) => ({ templateId: r.templateId, name: r.name, jobCount: r.jobCount, lotCount: r.lotIds.size, requiredSkills: r.requiredSkills, needsTemplateSkills: r.needsTemplateSkills, nobodyJobs: r.nobodyJobs, othersJobs: r.othersJobs }))
      .sort((a, b) => b.lotCount - a.lotCount || b.jobCount - a.jobCount || cmpStr(a.templateId, b.templateId));
    out[who] = {
      assignableJobs,
      totalJobs: jobList.length,
      assignableLots: assignableLotSet.size,
      totalLots,
      registrableJobs: jobList.length - assignableJobs,
      registrableLots: registrableLotSet.size,
      byTemplate,
    };
  });
  return out;
}
