// Read-only scenario adapter. Never writes settings or infers a worker's skills.
const obj = x => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
const places = new Set(['product', 'final', 'off']);
export function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function placementOn(plan, name, date) {
  const d = parseDay(date);
  if (!d) throw new Error(`読めない配置日: ${date}`);
  const person = obj(plan[name]);
  const dates = obj(person.dates);
  const weekdays = obj(person.weekdays);
  const value = own(dates, date) ? dates[date] : weekdays[d.getDay()];
  if (value == null || value === '') return null;
  if (!places.has(value)) throw new Error(`${name}: 読めない配置 ${String(value)}`);
  return value;
}

// Dates must come from the actual normalized horizon, including holidays and year boundaries.
export function preparePlacement({ input, app, plan = {}, dates = [] }) {
  if (!['product', 'final'].includes(app)) throw new Error('対象アプリが分かりません');
  const names = new Set((input.workers || []).map(w => w.name));
  const absences = Object.fromEntries(Object.entries(obj(input.scenario?.absences)).map(([d, row]) => [d, { ...obj(row) }]));
  const expected = [], conflicts = [];
  for (const name of Object.keys(plan)) {
    if (!names.has(name)) throw new Error(`名簿にいない作業者: ${name}`);
    for (const date of [...new Set(dates)].sort()) {
      const place = placementOn(plan, name, date);
      if (!place) continue;
      const existing = own(obj(absences[date]), name) ? absences[date][name] : input.settings?.workerRoster?.[date]?.[name];
      // Leave/unknown restrictions win over a placement request. An explicit "here"
      // may replace "other", but must not silently cancel an absence.
      const locked = existing && !['present', 'other'].includes(existing);
      let status = place === 'off' ? 'off' : place === app ? 'present' : 'other';
      if (locked) {
        status = existing;
        if (place !== 'off') conflicts.push({ name, date, place, code: 'leave-conflict', message: '配置と休み等の登録が重なっています。休みの登録を優先しました。' });
      }
      // "present" is understood by calendar.js, but normalizeInput's capacity
      // summary treats every truthy roster entry as absent. Remove "other" from
      // a cloned settings row instead of introducing this inconsistent value.
      absences[date] = { ...obj(absences[date]), [name]: status };
      expected.push({ name, date, place, status });
    }
  }
  const roster = Object.fromEntries(Object.entries(obj(input.settings?.workerRoster)).map(([d, row]) => [d, { ...obj(row) }]));
  for (const e of expected) if (e.status === 'present') {
    if (roster[e.date]) { delete roster[e.date][e.name]; if (!Object.keys(roster[e.date]).length) delete roster[e.date]; }
    delete absences[e.date][e.name];
  }
  for (const d of Object.keys(absences)) if (!Object.keys(absences[d]).length) delete absences[d];
  return {
    input: { ...input, settings: { ...obj(input.settings), workerRoster: roster }, scenario: { ...obj(input.scenario), absences } },
    expected, conflicts,
  };
}

// Compare restrictions with the result, not with a "saved" flag in the UI.
export function auditPlacement({ expected = [], normalized, assignments = [] }) {
  const issues = [];
  for (const e of expected) {
    const worker = normalized?.workers?.find(w => w.name === e.name);
    const actual = worker?.availability?.find(d => d.date === e.date);
    const blocked = e.status !== 'present';
    const applied = normalized?.calendarSpec?.absences?.[e.date]?.[e.name];
    if (!actual) issues.push({ ...e, code: 'unverified', message: '計算結果にこの人・日の勤務情報がありません' });
    else if (blocked && (actual.availableDirectMinutes !== 0 || applied !== e.status)) issues.push({ ...e, code: 'not-applied', message: '配置制限が計算に反映されていません' });
    else if (!blocked && applied && applied !== 'present') issues.push({ ...e, code: 'not-applied', message: 'こちらに配置した日の他工場指定が計算に残っています' });
    // Check starts only: an automatic cycle or a job spanning a holiday does not
    // prove the worker was occupied throughout that interval.
    if (blocked) for (const a of assignments) {
      if ((a.worker === e.name || a.partner === e.name) && Number.isFinite(a.startMs) && dayKey(a.startMs) === e.date) {
        issues.push({ ...e, code: 'started-while-away', lotId: a.lotId, message: '配置されていない日に作業開始が割り付いています' });
      }
    }
  }
  return issues;
}

export function auditRegisteredSettings({ input, normalized }) {
  const issues = [];
  for (const w of normalized?.workers || []) {
    const profile = obj(input.settings?.workerProfiles?.[w.name]);
    if ((Object.keys(obj(profile.byWeekday)).length || (Array.isArray(profile.days) && profile.days.length)) && normalized.calendarSpec?.workerAvailability !== true) {
      issues.push({ name: w.name, code: 'registered-availability-not-used', message: '曜日・休みの個人設定が登録されていますが、この計算では有効になっていません' });
    }
    for (const d of w.availability || []) {
      const scenarioDay = obj(input.scenario?.absences?.[d.date]);
      const expected = own(scenarioDay, w.name) ? scenarioDay[w.name] : input.settings?.workerRoster?.[d.date]?.[w.name];
      if (expected && normalized.calendarSpec?.absences?.[d.date]?.[w.name] !== expected) {
        issues.push({ name: w.name, date: d.date, code: 'registered-roster-not-used', message: '登録または試算で指定した在席情報が、計算に渡っていません' });
      }
    }
  }
  return issues;
}

export async function runPlacementReview({ input, app, plan, runPipeline }) {
  // Fresh per-request caches: a changed roster must never reuse a former answer.
  const before = await runPipeline(input, { cache: {} });
  const dates = before.normalized.workers.flatMap(w => w.availability.map(d => d.date));
  const prepared = preparePlacement({ input, app, plan, dates });
  const after = await runPipeline(prepared.input, { cache: {} });
  const issues = [
    ...auditRegisteredSettings({ input: prepared.input, normalized: after.normalized }),
    ...auditPlacement({ expected: prepared.expected, normalized: after.normalized, assignments: after.base.assignments }),
  ];
  return { before, after, expected: prepared.expected, conflicts: prepared.conflicts, issues, appliedInput: prepared.input };
}
