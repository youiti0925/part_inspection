import React from 'react';
import { defaultHours } from '../../domain/fullPair/fieldPlan.mjs';

export default function WorkingHoursFields({ value, onChange, registeredSchedule }) {
  const set = (key, next) => onChange({ ...value, [key]: next });
  const breaks = value.breaks ?? (value.breakStart || value.breakEnd ? [{ start: value.breakStart, end: value.breakEnd }] : []);
  return <details className="fp-calendar"><summary>勤務日・休憩を入れて時刻で比較する</summary>
    <label className="fp-check-label"><input type="checkbox" checked={value.enabled} onChange={e => set('enabled', e.target.checked)} />指定した勤務時間を使う（未指定は時間の相性だけの試算）</label>
    {value.enabled && <>
      <p>勤務日を明示してください。休日・個人休暇・他部署への応援は自動取得しません。記載した日だけで最後まで終わらなければ、完了時刻を出しません。</p>
      <label>勤務日（YYYY-MM-DD、複数日は改行またはカンマ）<textarea rows="2" value={value.dates} onChange={e => set('dates', e.target.value)} /></label>
      <button type="button" onClick={() => onChange({ ...defaultHours(registeredSchedule), dates: value.dates, enabled: true, allowAfterHoursAuto: value.allowAfterHoursAuto })}>登録の定時・休憩を読み直す</button>
      <div className="fp-hours-grid">{[['start', '始業（日本時間）'], ['end', '終業']].map(([key, label]) => <label key={key}>{label}<input type="time" value={value[key]} onChange={e => set(key, e.target.value)} /></label>)}</div>
      {breaks.map((b, i) => <div className="fp-hours-grid" key={i}>
        {['start', 'end'].map(key => <label key={key}>休憩{i + 1} {key === 'start' ? '開始' : '終了'}<input type="time" value={b[key]} onChange={e => set('breaks', breaks.map((v, k) => k === i ? { ...v, [key]: e.target.value } : v))} /></label>)}
        <button type="button" onClick={() => set('breaks', breaks.filter((_, k) => k !== i))}>休憩{i + 1}を外す</button>
      </div>)}
      <button type="button" onClick={() => set('breaks', [...breaks, { start: '', end: '' }])}>休憩を追加する</button>
      <label className="fp-check-label"><input type="checkbox" checked={!!value.allowAfterHoursAuto} onChange={e => set('allowAfterHoursAuto', e.target.checked)} />休憩・終業中も自動運転を続けてよいことを確認した</label>
      <p>変更はこの試算だけに使います。残業は自動で足しません。残業を試す時は終業を変更し、残業前の休憩も追加してください。勤務外の自動継続は、日中の離席可否とは別の条件です。</p>
    </>}
  </details>;
}
