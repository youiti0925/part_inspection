// =============================================================================
//  KnowledgeCourses.jsx — 📚知識標準(講座)
// -----------------------------------------------------------------------------
//  作業標準(手順書)とは**別**の、基礎知識を学ぶための教材を配る仕組み。
//  清水さん「作業前に勉強させたりする機能もほしい。確認テストもあってもいい。
//            これだったら通常作業者に啓蒙も含めて使える」
//
//  ⚠⚠ **主役は「そのまま公開」。** Driveのファイルを選んで題名を付ける → 公開。それだけ。
//     もう出来上がっている資料を、手間をかけずに流せることが最優先。
//     章立て・確認テスト(「組み立て」)は**後から足せる**。足しても そのまま公開の講座は壊れない。
//
//  ⚠ 画面の決めごと(過去に実害が出た項目):
//   ・帯や案内は**列に流し込む**。fixed/absolute で何かの上に浮かせない。
//   ・縦積みの中で全部 shrink-0 にしない(一番下が消える)。伸びる所は flex-1 min-h-0 overflow-y-auto。
//   ・ホバー前提のUIを作らない(タッチ端末で死ぬ)。押せる物は最小36px。
//   ・失敗は必ず画面に出す。黙って捨てない。
// =============================================================================
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  X, Plus, Trash2, ChevronUp, ChevronDown, ChevronRight, GraduationCap,
  Search, RefreshCw, Loader2, Pencil, Eye, Users,
} from 'lucide-react';
import { DRIVE_PROXY_URL, driveFmtSize, driveKindOf, DRIVE_KIND_ICON, driveListFolder } from './driveClient.js';
import { DriveFileViewer } from './DriveFileViewer.jsx';
import {
  KNOWLEDGE_COURSES_COL, KNOWLEDGE_RECORDS_COL, KNOWLEDGE_PRIVACY_TEXT,
  PASS_LABEL, FAIL_LABEL, QUIZ_PASS_RATIO,
  knowledgeFolderPath, newCourseId, newChapterId, newQuizId,
  workerKeyOf, knowledgeRecordDocId,
  normalizeCourse, normalizeAudience, audienceLabel, isRequiredCourse,
  isPublished, monthlyPickOf, sortCoursesForAdmin,
  courseQuestions, courseQuestionCount, passNeeded,
  gradeQuiz, answerText, buildRecordSave, learnerCourseList, isCourseDone, chapterTarget,
  courseAudienceStatus, courseDraftFromRework,
} from './domain/knowledgeCourses.js';

// 押せる物の最小の大きさ(36px)。タブレットで押せない、を作らないための下限。
const TAP = 'min-h-[36px]';

const fmtT = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const n = Math.floor(s);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};
const fmtDate = (ms) => (ms > 0 ? new Date(ms).toLocaleDateString('ja-JP') : '—');

/** 画面に常時出す約束。⚠管理画面と受講画面の両方に出す(片方だけだと約束として読まれない)。 */
export const KnowledgePrivacyNote = ({ className = '' }) => (
  <div className={`rounded-lg bg-emerald-50 border border-emerald-300 text-emerald-900 px-3 py-2 text-xs leading-relaxed ${className}`}>
    {KNOWLEDGE_PRIVACY_TEXT.map((t, i) => <div key={i}>{i === 0 ? '🤝 ' : '　 '}{t}</div>)}
  </div>
);

// =============================================================================
//  Driveのファイルを選ぶ
// =============================================================================
// ⚠アプリは Drive の**フォルダIDを持たない**。「資料ルート → 製品 → 講座」という道順だけ。
//   だからフォルダを増やすのに、コードも Worker の設定も触らなくていい。
const DriveFilePicker = ({ folder = '', onFolderChange = null, selected = [], onToggle, onClose = null }) => {
  const [state, setState] = useState({ loading: true, error: '', found: false, missing: '', files: [] });
  const [q, setQ] = useState('');
  const path = knowledgeFolderPath(folder);

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: '' }));
    const r = await driveListFolder(path);
    setState({ loading: false, error: r.error || '', found: !!r.found, missing: r.missing || '', files: r.files || [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);
  useEffect(() => { load(); }, [load]);

  const shown = (state.files || []).filter(f => !q || String(f.name || '').toLowerCase().includes(q.toLowerCase()));
  const isSel = (id) => (selected || []).some(x => x.driveId === id);

  if (!DRIVE_PROXY_URL) {
    return (
      <div className="rounded-lg bg-amber-50 border border-amber-300 p-3 text-sm text-amber-900 space-y-1">
        <div className="font-bold">Drive連携が未設定です</div>
        <div>管理者が <code className="bg-white px-1 rounded">VITE_DRIVE_PROXY_URL</code> を設定して再デプロイすると、ここにDriveのファイルが並びます。
          （worker/README_セットアップ手順.md の「Google Drive 資料フォルダ」）</div>
        <div className="text-xs">設定が済むまで、この画面から資料を選ぶことはできません。</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0 gap-2">
      <div className="shrink-0 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 bg-white px-2 py-1.5 rounded border border-slate-300 flex-1 min-w-[10rem]">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="ファイル名で探す" className="flex-1 min-w-0 text-sm outline-none" />
        </div>
        {onFolderChange && (
          <input value={folder} onChange={e => onFolderChange(e.target.value)} placeholder="小分けフォルダ名（空欄=講座フォルダ直下）"
            className={`px-2 py-1.5 rounded border border-slate-300 text-sm ${TAP} w-56`}
            title="Driveの「製品/講座」の下にフォルダを作って分けたい時だけ入れます。空欄なら直下を見ます。" />
        )}
        <button onClick={load} className={`px-3 py-1.5 rounded bg-slate-600 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1 ${TAP}`}>
          <RefreshCw className="w-4 h-4" /> 更新
        </button>
        {onClose && <button onClick={onClose} className={`px-3 py-1.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold ${TAP}`}>閉じる</button>}
      </div>
      <div className="shrink-0 fi-tap-text text-slate-500 font-mono break-all">
        Driveの場所: 資料ルート / {path.join(' / ')}
        <span className="ml-2 font-sans text-slate-400">（Driveに置いた物がここに出るまで、最大1分かかります）</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto border border-slate-200 rounded-lg bg-white">
        {state.loading && <div className="p-3 text-sm text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> 読み込み中…</div>}
        {!state.loading && state.error && (
          <div className="m-2 p-2 rounded bg-rose-50 border border-rose-300 text-rose-700 text-sm">
            <b>読めませんでした:</b> {state.error}
          </div>
        )}
        {!state.loading && !state.error && !state.found && (
          <div className="p-3 text-sm text-slate-500">
            Driveにフォルダ「<b>{path.join(' / ')}</b>」がまだありません（{state.missing} が見つかりません）。
            <div className="text-xs text-slate-400 mt-1">Driveの資料フォルダにこの名前でフォルダを作り、PDFやパワポ動画を入れてください。作った直後は最大1分かかります。</div>
          </div>
        )}
        {!state.loading && !state.error && state.found && shown.length === 0 && (
          <div className="p-3 text-sm text-slate-500">{state.files.length === 0 ? 'フォルダはありますが、ファイルがまだ入っていません。' : '探した言葉に当てはまるファイルがありません。'}</div>
        )}
        {shown.map(f => {
          const kind = driveKindOf(f.mimeType, f.name);
          const on = isSel(f.id);
          return (
            <button key={f.id} onClick={() => onToggle({ driveId: f.id, name: f.name, mime: f.mimeType })}
              className={`w-full text-left flex items-center gap-2 px-2 py-2 border-b border-slate-100 last:border-b-0 ${TAP} ${on ? 'bg-emerald-50' : 'bg-white active:bg-slate-100'}`}>
              <span className={`w-5 h-5 rounded border-2 shrink-0 flex items-center justify-center ${on ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-300'}`}>
                {on ? '✓' : ''}
              </span>
              <span className="text-lg shrink-0">{DRIVE_KIND_ICON[kind]}</span>
              <span className="flex-1 min-w-0 text-sm font-bold text-slate-700 break-all">{f.name}</span>
              <span className="fi-tap-text text-slate-400 shrink-0">{driveFmtSize(f.size)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// =============================================================================
//  受講画面(作業者が見る側)
// =============================================================================

// 1問。⚠ホバーで色が変わるだけの作りにしない。押した物は枠と色ではっきり変える。
const QuizQuestion = ({ q, no, value, onChange }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
    <div className="text-sm font-bold text-slate-800">
      <span className="text-slate-400 mr-1">問{no}.</span>{q.q}
      {q.chapterTitle ? <span className="ml-2 fi-tap-text font-normal text-slate-400">（{q.chapterTitle}）</span> : null}
    </div>
    <div className="flex flex-col gap-1.5">
      {q.type === 'ox' ? (
        [true, false].map(v => (
          <button key={String(v)} onClick={() => onChange(v)}
            className={`text-left px-3 py-2 rounded-lg border-2 text-sm font-bold ${TAP} ${value === v ? 'border-sky-600 bg-sky-50 text-sky-800' : 'border-slate-200 bg-white text-slate-700 active:bg-slate-100'}`}>
            {v ? '○ 正しい' : '× まちがい'}
          </button>
        ))
      ) : (
        (q.choices || []).map((c, i) => (
          <button key={i} onClick={() => onChange(i)}
            className={`text-left px-3 py-2 rounded-lg border-2 text-sm font-bold ${TAP} ${value === i ? 'border-sky-600 bg-sky-50 text-sky-800' : 'border-slate-200 bg-white text-slate-700 active:bg-slate-100'}`}>
            <span className="text-slate-400 mr-1">{i + 1}.</span>{c}
          </button>
        ))
      )}
    </div>
  </div>
);

/**
 * 講座を1つ受ける画面。
 * ⚠「初回だけ早送り禁止」= まだ記録が無い人だけ。巻き戻しはいつでも自由。
 */
const CoursePlayer = ({ course, record, worker, saveData, onDone, onBack, previewMode = false }) => {
  const c = useMemo(() => normalizeCourse(course), [course]);
  const questions = useMemo(() => courseQuestions(c), [c]);
  const [phase, setPhase] = useState('material'); // material | quiz | result | done(テスト無しの講座を修了にした)
  const [viewer, setViewer] = useState(null);     // { file, kind, page, startSec, endSec, note }
  const [seen, setSeen] = useState({});           // 開いた資料(driveId → true)
  const [answers, setAnswers] = useState({});
  const [grade, setGrade] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const firstTime = !record; // 記録がまだ無い＝初回
  // すでに修了している(記録が入っている)か。⚠押しても意味の無いボタンは出さない。
  const alreadyDone = isCourseDone(c, record);

  const openFile = (f, extra = {}) => {
    if (!f || !f.driveId) { setErr('この章にはまだ資料がひも付いていません。管理者にお伝えください。'); return; }
    setErr('');
    setSeen(s => ({ ...s, [f.driveId]: true }));
    setViewer({ file: { id: f.driveId, name: f.name, mimeType: f.mime }, kind: driveKindOf(f.mime, f.name), ...extra });
  };

  /**
   * 受講の記録を書く。戻り値は 'saved' / 'preview' / 'error' の3つ。
   * ⚠⚠ **呼ぶ側は必ずこの戻り値を待ってから画面を進めること。**
   *   保存できていないのに「🎉取得」「修了しました」と出すのが一番まずい
   *   (本人の画面は修了・管理画面は未受講のまま = 後で必ずもめる)。
   */
  const save = async (g, { head = '', retry = 'もう一度押してください' } = {}) => {
    if (previewMode) { setErr('これは「作業者の見え方」の確認です。記録は保存されません。'); return 'preview'; }
    if (!worker || !workerKeyOf(worker)) { setErr('使用者が選ばれていません。画面いちばん上で自分の名前を選んでから、もう一度押してください。'); return 'error'; }
    if (!saveData) { setErr('保存の窓口がありません（アプリの不具合です）。管理者にお伝えください。'); return 'error'; }
    setSaving(true); setErr('');
    try {
      const body = buildRecordSave({ course: c, worker, prev: record, now: Date.now(), grade: g });
      await saveData(KNOWLEDGE_RECORDS_COL, knowledgeRecordDocId(c.id, workerKeyOf(worker)), body);
      if (onDone) onDone(body);
      return 'saved';
    } catch (e) {
      // ⚠黙って捨てない。保存できていないのに「修了しました」と出すのが一番まずい。
      setErr(head + '記録を保存できませんでした: ' + ((e && e.message) || e) + `（電波を確かめて、${retry}）`);
      return 'error';
    } finally {
      setSaving(false);
    }
  };

  // ⚠採点だけできても、記録が残らなければ「受けていない人」のまま。
  //   だから **保存できた時だけ** 判定の画面へ進める(preview は保存しないと画面に出しているので進める)。
  const submit = async () => {
    const g = gradeQuiz(c, answers);
    const st = await save(g, { head: '答え合わせはできましたが、', retry: 'もう一度「答え合わせ」を押してください' });
    if (st === 'error') { setGrade(null); return; }
    setGrade(g);
    setPhase('result');
  };

  // ⚠成功しても画面が変わらないと、押した人は「効かない」と思って何度も押す(そのたびに保存が飛ぶ)。
  const finishNoQuiz = async () => {
    const st = await save(null, { retry: 'もう一度「見終わりました」を押してください' });
    if (st === 'saved') setPhase('done');
  };

  const need = passNeeded(questions.length);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-slate-200 bg-white flex flex-wrap items-center gap-2">
        <button onClick={onBack} className={`px-3 py-1.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold ${TAP}`}>← 一覧へ</button>
        <div className="font-bold text-slate-800 min-w-0 break-all flex-1">{c.title || '(題名なし)'}</div>
        {c.estMin > 0 && <span className="text-xs text-slate-500 shrink-0">およそ {c.estMin}分</span>}
        {isRequiredCourse(c) && <span className="fi-tap-text font-bold bg-rose-100 text-rose-700 border border-rose-300 rounded px-1.5 py-0.5 shrink-0">必修</span>}
      </div>
      {err && (
        <div className="shrink-0 mx-3 mt-2 rounded-lg bg-rose-50 border border-rose-300 text-rose-800 px-3 py-2 text-sm font-bold">⚠ {err}</div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 bg-slate-50">
        {phase === 'material' && (<>
          {c.note && <div className="rounded-xl bg-white border border-slate-200 p-3 text-sm text-slate-700 whitespace-pre-wrap">{c.note}</div>}
          {firstTime && c.files.some(f => driveKindOf(f.mime, f.name) === 'video') && (
            <div className="rounded-lg bg-sky-50 border border-sky-300 text-sky-900 px-3 py-2 text-xs font-bold">
              ⏩ はじめの1回は動画を早送りできません（巻き戻しは自由です）。2回目からは自由に動かせます。
            </div>
          )}
          {c.chapters.length === 0 ? (
            /* ▼ そのまま公開(asis): 資料をそのまま並べるだけ。これが主役。 */
            <div className="space-y-2">
              <div className="text-xs font-bold text-slate-500">資料（{c.files.length}件）</div>
              {c.files.length === 0 && <div className="rounded-lg bg-amber-50 border border-amber-300 text-amber-900 px-3 py-2 text-sm">この講座にはまだ資料が入っていません。管理者にお伝えください。</div>}
              {c.files.map(f => {
                const kind = driveKindOf(f.mime, f.name);
                return (
                  <button key={f.driveId} onClick={() => openFile(f, { noSeekForward: firstTime && kind === 'video' })}
                    className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-xl border-2 bg-white active:bg-slate-100 ${TAP} ${seen[f.driveId] ? 'border-emerald-400' : 'border-slate-200'}`}>
                    <span className="text-xl shrink-0">{DRIVE_KIND_ICON[kind]}</span>
                    <span className="flex-1 min-w-0 text-sm font-bold text-slate-700 break-all">{f.name}</span>
                    {seen[f.driveId] && <span className="fi-tap-text font-bold text-emerald-700 shrink-0">開きました</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            /* ▼ 組み立て(built): 章ごとに「学ぶこと・急所・見る資料の場所」 */
            <div className="space-y-2">
              {c.chapters.map((ch, i) => {
                // ⚠ひも付けた資料が外されている時に c.files[0] へ落とさない(決めごとは domain 側)。
                const tgt = chapterTarget(c.files, ch);
                const f = tgt.file;
                const kind = f ? driveKindOf(f.mime, f.name) : 'other';
                return (
                  <div key={ch.id} className="rounded-xl bg-white border border-slate-200 p-3 space-y-2">
                    <div className="font-bold text-slate-800 text-sm">
                      <span className="text-slate-400 mr-1">第{i + 1}章</span>{ch.title || '(題名なし)'}
                      {ch.min > 0 && <span className="ml-2 fi-tap-text font-normal text-slate-500">{ch.min}分</span>}
                    </div>
                    {ch.body && <div className="text-sm text-slate-700 whitespace-pre-wrap">{ch.body}</div>}
                    {ch.keyPoints.length > 0 && (
                      <ul className="text-sm text-slate-700 list-disc pl-5 space-y-0.5">
                        {ch.keyPoints.map((k, j) => <li key={j}><b>{k}</b></li>)}
                      </ul>
                    )}
                    {f ? (
                      <button onClick={() => openFile(f, { page: tgt.page, startSec: tgt.startSec, endSec: tgt.endSec, noSeekForward: firstTime && kind === 'video' })}
                        className={`px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold flex items-center gap-1 ${TAP}`}>
                        {DRIVE_KIND_ICON[kind]} 資料を見る
                        {tgt.page > 0 ? ` （${tgt.page}ページ目）` : ''}
                        {tgt.startSec > 0 ? ` （${fmtT(tgt.startSec)}から）` : ''}
                      </button>
                    ) : tgt.dropped ? (
                      /* ⚠ここで c.files[0] を開かせない。別の資料に対して「Nページ目」と言うくらいなら、
                         **開かせずに、おかしいと分かる文字を出す**方がよい。 */
                      <div className="text-xs text-rose-800 bg-rose-50 border border-rose-300 rounded px-2 py-1.5 font-bold">
                        ⚠ この章にひも付いていた資料は、講座から外されています（管理者にお伝えください）。
                        <div className="font-normal mt-0.5">別の資料を開くと、ページや時間の案内が合わなくなるため、ここでは開けないようにしています。</div>
                      </div>
                    ) : (
                      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-300 rounded px-2 py-1">この章にひも付いた資料がありません。</div>
                    )}
                    {ch.quiz.length > 0 && <div className="fi-tap-text text-slate-400">この章の確認テスト {ch.quiz.length}問</div>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="pt-1">
            {questions.length > 0 ? (
              <button onClick={() => setPhase('quiz')} className={`w-full px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black ${TAP}`}>
                確認テストへ進む（全{questions.length}問・{need}問正解で{PASS_LABEL}）
              </button>
            ) : alreadyDone ? (
              /* ⚠もう記録が入っている人に「修了にする」を押させない(押しても同じ物を書くだけ)。 */
              <button disabled className={`w-full px-4 py-3 rounded-xl bg-emerald-100 border-2 border-emerald-300 text-emerald-800 font-black ${TAP}`}>
                ✅ 修了済みです（何度でも見返せます）
              </button>
            ) : (
              <button onClick={finishNoQuiz} disabled={saving} className={`w-full px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-black ${TAP}`}>
                {saving ? '保存中…' : '見終わりました（修了にする）'}
              </button>
            )}
          </div>
        </>)}

        {/* ✅ 確認テストの無い講座を修了にした直後。⚠成功を無音にしない(無音は「効かない」と読まれる)。 */}
        {phase === 'done' && (<>
          <div className="rounded-xl border-2 border-emerald-400 bg-emerald-50 p-4 text-center">
            <div className="text-2xl font-black text-emerald-700">✅ 修了にしました</div>
            <div className="text-sm text-slate-700 mt-1">記録を保存しました。この講座はいつでも見返せます。</div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={() => setPhase('material')} className={`px-4 py-3 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold ${TAP}`}>資料へ戻る</button>
            <button onClick={onBack} className={`flex-1 px-4 py-3 rounded-xl bg-sky-700 hover:bg-sky-800 text-white font-black ${TAP}`}>一覧へ戻る</button>
          </div>
        </>)}

        {phase === 'quiz' && (<>
          <div className="rounded-lg bg-white border border-slate-200 px-3 py-2 text-xs text-slate-600">
            全{questions.length}問。<b>{need}問</b>以上で{PASS_LABEL}です（合格ライン {Math.round(QUIZ_PASS_RATIO * 100)}% ＝ {questions.length}問 × 0.8 の切り上げ）。
            何回でも受け直せます。
          </div>
          {questions.map((q, i) => (
            <QuizQuestion key={q.qid} q={q} no={i + 1} value={answers[q.qid]} onChange={(v) => setAnswers(a => ({ ...a, [q.qid]: v }))} />
          ))}
          <div className="flex gap-2 pt-1">
            <button onClick={() => setPhase('material')} className={`px-4 py-3 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold ${TAP}`}>資料へ戻る</button>
            <button onClick={submit} disabled={saving} className={`flex-1 px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-black ${TAP}`}>
              {saving ? '保存中…' : '答え合わせ'}
            </button>
          </div>
        </>)}

        {phase === 'result' && grade && (<>
          <div className={`rounded-xl border-2 p-4 text-center ${grade.passed ? 'bg-emerald-50 border-emerald-400' : 'bg-amber-50 border-amber-400'}`}>
            <div className={`text-2xl font-black ${grade.passed ? 'text-emerald-700' : 'text-amber-700'}`}>
              {grade.passed ? `🎉 ${PASS_LABEL}` : `${FAIL_LABEL}`}
            </div>
            <div className="text-sm text-slate-700 mt-1">
              {grade.total}問中 <b>{grade.correct}問</b>正解（{PASS_LABEL}に必要なのは {grade.needed}問）
            </div>
            {!grade.passed && <div className="text-xs text-slate-600 mt-2">下の解説を読んでから、もう一度受けてみてください。何回受けても構いません。</div>}
          </div>
          {grade.wrong.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-bold text-slate-500">まちがえたところ（{grade.wrong.length}問）</div>
              {grade.wrong.map(w => (
                <div key={w.qid} className="rounded-xl bg-white border border-rose-200 p-3 space-y-1.5">
                  <div className="text-sm font-bold text-slate-800">{w.q}</div>
                  <div className="text-xs text-slate-600">あなたの答え: <b>{answerText(w, w.given)}</b></div>
                  <div className="text-xs text-emerald-800">正しい答え: <b>{answerText(w, w.answer)}</b></div>
                  {w.explain && <div className="text-sm text-slate-700 bg-slate-50 rounded p-2 whitespace-pre-wrap">{w.explain}</div>}
                  {w.sourceNote ? (
                    <div className="fi-tap-text text-slate-500">📖 出どころ: {w.sourceNote}</div>
                  ) : (
                    <div className="fi-tap-text text-slate-400">📖 出どころは書かれていません（管理者にお伝えください）</div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button onClick={() => { setPhase('quiz'); setGrade(null); }} className={`px-4 py-3 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold ${TAP}`}>もう一度受ける</button>
            <button onClick={onBack} className={`flex-1 px-4 py-3 rounded-xl bg-sky-700 hover:bg-sky-800 text-white font-black ${TAP}`}>一覧へ戻る</button>
          </div>
        </>)}
        <KnowledgePrivacyNote />
      </div>

      {viewer && (
        <DriveFileViewer key={`${viewer.file.id}#${viewer.page || 0}#${viewer.startSec || 0}`}
          file={viewer.file} kind={viewer.kind} page={viewer.page || 0}
          startSec={viewer.startSec || 0} endSec={viewer.endSec || 0}
          noSeekForward={!!viewer.noSeekForward} onClose={() => setViewer(null)} />
      )}
    </div>
  );
};

/** 作業者が見る講座の一覧＋受講画面。 */
export const KnowledgeLibraryModal = ({ courses = [], records = [], workers = [], currentUserName = '', saveData = null, previewMode = false, onClose }) => {
  const worker = useMemo(
    () => (currentUserName ? (workers || []).find(w => w.name === currentUserName) : null) || (currentUserName ? { name: currentUserName } : null),
    [workers, currentUserName]
  );
  const rows = useMemo(() => learnerCourseList({ courses, records, worker }), [courses, records, worker]);
  const [openId, setOpenId] = useState(null);
  const open = openId ? rows.find(r => r.course.id === openId) : null;

  return (
    <div className="fixed inset-0 z-[150] bg-black/60 flex items-center justify-center p-3">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl h-[92vh] flex flex-col overflow-hidden">
        <div className="shrink-0 bg-indigo-700 text-white px-4 py-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-bold flex items-center gap-2 min-w-0">
            <GraduationCap className="w-5 h-5 shrink-0" /> <span className="truncate">知識標準（講座）</span>
          </h2>
          <button onClick={onClose} className="p-2 rounded hover:bg-white/20 shrink-0" title="閉じる"><X className="w-6 h-6" /></button>
        </div>

        {previewMode && (
          <div className="shrink-0 m-3 rounded-lg bg-sky-50 border border-sky-300 text-sky-900 px-3 py-2 text-sm font-bold">
            👀 これは<b>作業者の見え方の確認</b>です。ここでの操作は記録に残りません。
          </div>
        )}
        {!previewMode && !currentUserName && (
          <div className="shrink-0 m-3 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 px-3 py-2 text-sm font-bold">
            ⚠ 使用者が選ばれていません。画面いちばん上で自分の名前を選ぶと、あなた向けの講座と受けた記録が出ます。
          </div>
        )}

        {open ? (
          <CoursePlayer course={open.course} record={open.record} worker={worker} saveData={saveData} previewMode={previewMode}
            onBack={() => setOpenId(null)} onDone={() => { /* 記録は購読で反映される。ここでは何もしない */ }} />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 bg-slate-50">
            <div className="text-xs text-slate-500">
              作業標準（手順書）とは別の、<b>基礎の知識</b>を学ぶための講座です。まだ受けていない物が上に出ます。
            </div>
            {rows.length === 0 && (
              <div className="rounded-xl bg-white border border-slate-200 p-6 text-center text-slate-400 text-sm">
                いま出ている講座はありません。
              </div>
            )}
            {rows.map(r => (
              <button key={r.course.id} onClick={() => setOpenId(r.course.id)}
                className={`w-full text-left rounded-xl border-2 p-3 bg-white active:bg-slate-100 ${TAP} ${r.pick && !r.done ? 'border-amber-400 ring-2 ring-amber-200' : r.done ? 'border-slate-200 opacity-70' : 'border-indigo-300'}`}>
                <div className="flex items-start gap-2">
                  <span className="text-2xl shrink-0">{r.done ? '✅' : r.pick ? '⭐' : '📚'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.pick && <span className="fi-tap-text font-black bg-amber-400 text-amber-950 rounded px-1.5 py-0.5">今月の1本</span>}
                      {r.required && <span className="fi-tap-text font-bold bg-rose-100 text-rose-700 border border-rose-300 rounded px-1.5 py-0.5">必修</span>}
                      {r.done && <span className="fi-tap-text font-bold bg-emerald-100 text-emerald-700 border border-emerald-300 rounded px-1.5 py-0.5">修了</span>}
                      {!r.done && <span className="fi-tap-text font-bold bg-slate-100 text-slate-600 border border-slate-300 rounded px-1.5 py-0.5">まだ</span>}
                    </div>
                    <div className="font-bold text-slate-800 text-sm mt-1 break-all">{r.course.title || '(題名なし)'}</div>
                    <div className="fi-tap-text text-slate-500 mt-0.5">
                      {r.course.estMin > 0 ? `およそ ${r.course.estMin}分 ・ ` : ''}
                      資料 {r.course.files.length}件
                      {courseQuestionCount(r.course) > 0 ? ` ・ 確認テスト ${courseQuestionCount(r.course)}問` : ' ・ 確認テストなし'}
                      {r.record && r.record.passedAt > 0 ? ` ・ ${PASS_LABEL} ${fmtDate(r.record.passedAt)}` : ''}
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-slate-300 shrink-0 mt-1" />
                </div>
              </button>
            ))}
            <KnowledgePrivacyNote />
          </div>
        )}
      </div>
    </div>
  );
};

// =============================================================================
//  工程開始のときの案内(新人向け)
// =============================================================================
/**
 * ⚠**押せない壁は作らない。**「先にこれを見ませんか」の案内まで。
 * ⚠帯として列に流し込む(fixed/absolute で何かの上に浮かせない)。呼ぶ側で shrink-0 の並びに置く。
 */
export const KnowledgeNudgeBand = ({ courses = [], onOpen, onDismiss }) => {
  if (!courses || courses.length === 0) return null;
  return (
    <div className="shrink-0 bg-amber-100 border-b-2 border-amber-400 text-amber-950 px-3 py-2 flex flex-wrap items-center gap-2">
      <span className="text-xl shrink-0">🎓</span>
      <div className="flex-1 min-w-[12rem] text-sm font-bold">
        まだ見ていない必修の講座が {courses.length}件あります
        <div className="text-xs font-normal break-all">{courses.slice(0, 3).map(c => c.title).join(' / ')}{courses.length > 3 ? ' ほか' : ''}</div>
      </div>
      <button onClick={onOpen} className={`px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-black shrink-0 ${TAP}`}>先に見る</button>
      <button onClick={onDismiss} className={`px-3 py-2 rounded-lg bg-white hover:bg-amber-50 border border-amber-400 text-amber-800 text-xs font-bold shrink-0 ${TAP}`}>あとで</button>
    </div>
  );
};

// =============================================================================
//  管理画面(マスタ設定 → 📚知識標準)
// =============================================================================

const ChapterEditor = ({ chapter, files, onChange, onRemove, index }) => {
  const ch = chapter;
  const set = (patch) => onChange({ ...ch, ...patch });
  const setQuiz = (qi, patch) => set({ quiz: ch.quiz.map((q, i) => (i === qi ? { ...q, ...patch } : q)) });
  const addQuiz = () => set({ quiz: [...ch.quiz, { id: newQuizId(), type: 'choice', q: '', choices: ['', ''], answer: 0, explain: '', sourceNote: '' }] });
  const boundFile = files.find(x => x.driveId === ch.driveId) || null;
  const kind = boundFile ? driveKindOf(boundFile.mime, boundFile.name) : '';
  // ⚠ひも付けた資料が講座から外されている状態。この時 kind が '' になるので
  //   ページ欄・開始秒欄が**画面から消え**、残った page/startSec を見ることも直すこともできなくなる。
  //   → 数字をそのまま見せて、その場で外せるようにする。
  const dropped = !!ch.driveId && !boundFile;

  return (
    <div className="rounded-xl border border-slate-300 bg-white p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-black text-slate-500 shrink-0">第{index + 1}章</span>
        <input value={ch.title} onChange={e => set({ title: e.target.value })} placeholder="章の題名"
          className={`flex-1 min-w-[10rem] px-2 py-1.5 border border-slate-300 rounded text-sm ${TAP}`} />
        <input type="number" min="0" value={ch.min || ''} onChange={e => set({ min: Number(e.target.value) || 0 })} placeholder="分"
          className={`w-20 px-2 py-1.5 border border-slate-300 rounded text-sm ${TAP}`} title="この章のおよその時間(分)" />
        <button onClick={onRemove} className={`px-2 py-1.5 rounded bg-rose-50 hover:bg-rose-100 border border-rose-300 text-rose-700 ${TAP}`} title="この章を消す"><Trash2 className="w-4 h-4" /></button>
      </div>
      <textarea value={ch.body} onChange={e => set({ body: e.target.value })} rows={2} placeholder="学ぶこと（本文）"
        className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
      <input value={ch.keyPoints.join(' / ')} onChange={e => set({ keyPoints: e.target.value.split('/').map(s => s.trim()).filter(Boolean) })}
        placeholder="急所（「 / 」で区切って複数）" className={`w-full px-2 py-1.5 border border-slate-300 rounded text-sm ${TAP}`} />
      <div className="flex flex-wrap items-center gap-2">
        {/* ⚠資料を差し替えたら、ページ・開始秒・終了秒は**その資料の物ではなくなる**ので一緒に消す。
            残すと受講画面が「別の資料のNページ目」を指示してしまう。 */}
        <select value={dropped ? '__gone__' : ch.driveId}
          onChange={e => { const v = e.target.value === '__gone__' ? ch.driveId : e.target.value; set(v === ch.driveId ? { driveId: v } : { driveId: v, page: 0, startSec: 0, endSec: 0 }); }}
          className={`px-2 py-1.5 border rounded text-sm bg-white ${TAP} max-w-full ${dropped ? 'border-rose-400 text-rose-700' : 'border-slate-300'}`}>
          <option value="">— 見せる資料（この講座に入れたファイルから）—</option>
          {dropped && <option value="__gone__">⚠ 講座から外された資料（選び直してください）</option>}
          {files.map(f => <option key={f.driveId} value={f.driveId}>{f.name}</option>)}
        </select>
        {kind === 'pdf' && (
          <label className="text-xs text-slate-600 flex items-center gap-1">ページ
            <input type="number" min="0" value={ch.page || ''} onChange={e => set({ page: Number(e.target.value) || 0 })} className={`w-20 px-2 py-1.5 border border-slate-300 rounded ${TAP}`} />
          </label>
        )}
        {kind === 'video' && (<>
          <label className="text-xs text-slate-600 flex items-center gap-1">開始秒
            <input type="number" min="0" value={ch.startSec || ''} onChange={e => set({ startSec: Number(e.target.value) || 0 })} className={`w-20 px-2 py-1.5 border border-slate-300 rounded ${TAP}`} />
          </label>
          <label className="text-xs text-slate-600 flex items-center gap-1">終了秒
            <input type="number" min="0" value={ch.endSec || ''} onChange={e => set({ endSec: Number(e.target.value) || 0 })} className={`w-20 px-2 py-1.5 border border-slate-300 rounded ${TAP}`} />
          </label>
        </>)}
      </div>
      {dropped && (
        <div className="rounded-lg bg-rose-50 border border-rose-300 text-rose-800 px-2 py-2 text-xs space-y-1.5">
          <div className="font-bold">⚠ この章がひも付けていた資料は、いまこの講座に入っていません。</div>
          <div>
            残っている指定: ページ <b>{ch.page || '—'}</b> ／ 開始秒 <b>{ch.startSec || '—'}</b> ／ 終了秒 <b>{ch.endSec || '—'}</b>
            <span className="ml-1">（この数字は外した資料に対する物です）</span>
          </div>
          <div>受講画面では、この章の「資料を見る」を<b>出していません</b>（別の資料の別のページを指示しないため）。上で資料を選び直すか、下で外してください。</div>
          <button onClick={() => set({ driveId: '', page: 0, startSec: 0, endSec: 0 })}
            className={`px-3 py-1.5 rounded bg-white border border-rose-400 text-rose-700 font-bold ${TAP}`}>ひも付けとページ・秒を外す</button>
        </div>
      )}
      {kind === 'pdf' && ch.page > 0 && (
        <div className="fi-tap-text text-slate-500">
          ⚠ ページ送りが効かない端末（Firefox・一部のAndroid）があります。受講画面には「{ch.page}ページ目を見てください」の文字も必ず出ます。
        </div>
      )}

      <div className="pt-1 border-t border-slate-200 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-500">確認テスト（{ch.quiz.length}問）</span>
          <button onClick={addQuiz} className={`px-2 py-1.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1 ${TAP}`}><Plus className="w-3 h-3" /> 問題を足す</button>
        </div>
        {ch.quiz.map((q, qi) => (
          <div key={q.id} className="rounded-lg border border-slate-200 bg-slate-50 p-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <select value={q.type} onChange={e => setQuiz(qi, { type: e.target.value, answer: e.target.value === 'ox' ? true : 0 })} className={`px-2 py-1.5 border border-slate-300 rounded text-xs bg-white ${TAP}`}>
                <option value="choice">選択</option>
                <option value="ox">○×</option>
              </select>
              <input value={q.q} onChange={e => setQuiz(qi, { q: e.target.value })} placeholder="問題文" className={`flex-1 min-w-[10rem] px-2 py-1.5 border border-slate-300 rounded text-sm ${TAP}`} />
              <button onClick={() => set({ quiz: ch.quiz.filter((_, i) => i !== qi) })} className={`px-2 py-1.5 rounded bg-rose-50 hover:bg-rose-100 border border-rose-300 text-rose-700 ${TAP}`}><Trash2 className="w-3 h-3" /></button>
            </div>
            {q.type === 'choice' ? (
              <div className="space-y-1">
                {(q.choices || []).map((ch2, ci) => (
                  <div key={ci} className="flex items-center gap-2">
                    <button onClick={() => setQuiz(qi, { answer: ci })} className={`w-8 h-8 rounded-full border-2 text-xs font-black shrink-0 ${q.answer === ci ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-300 text-slate-400'}`} title="これが正解">{ci + 1}</button>
                    <input value={ch2} onChange={e => setQuiz(qi, { choices: q.choices.map((x, i) => (i === ci ? e.target.value : x)) })} placeholder={`選択肢 ${ci + 1}`} className={`flex-1 min-w-0 px-2 py-1.5 border border-slate-300 rounded text-sm ${TAP}`} />
                    <button onClick={() => setQuiz(qi, { choices: q.choices.filter((_, i) => i !== ci), answer: q.answer > ci ? q.answer - 1 : q.answer })} className={`px-2 py-1.5 text-slate-400 hover:text-rose-600 ${TAP}`}>✕</button>
                  </div>
                ))}
                <button onClick={() => setQuiz(qi, { choices: [...(q.choices || []), ''] })} className={`px-2 py-1.5 rounded bg-white border border-slate-300 text-xs font-bold text-slate-600 ${TAP}`}>＋ 選択肢</button>
              </div>
            ) : (
              <div className="flex gap-2">
                {[true, false].map(v => (
                  <button key={String(v)} onClick={() => setQuiz(qi, { answer: v })} className={`px-4 py-2 rounded-lg border-2 text-sm font-bold ${TAP} ${q.answer === v ? 'border-emerald-600 bg-emerald-50 text-emerald-800' : 'border-slate-300 bg-white text-slate-600'}`}>{v ? '○ が正解' : '× が正解'}</button>
                ))}
              </div>
            )}
            <input value={q.explain} onChange={e => setQuiz(qi, { explain: e.target.value })} placeholder="解説（まちがえた人に出ます）" className={`w-full px-2 py-1.5 border border-slate-300 rounded text-sm ${TAP}`} />
            <input value={q.sourceNote} onChange={e => setQuiz(qi, { sourceNote: e.target.value })} placeholder="根拠の場所（例: 分割標準 シートA B12 / 図5）" className={`w-full px-2 py-1.5 border border-slate-300 rounded text-sm ${TAP}`} />
          </div>
        ))}
      </div>
    </div>
  );
};

const CourseEditor = ({ draft, workers, onChange, onSave, onCancel, saving, err }) => {
  const c = draft;
  const set = (patch) => onChange({ ...c, ...patch });
  // ⚠既定は**空**(=「製品/講座」の直下)。題名を初期値にすると、講座を直すたびに
  //   「製品/講座/<題名>」という**まだ無いフォルダ**を見に行き、毎回「フォルダがありません」が出る。
  //   小分けしたい人だけが下の欄に名前を入れる。
  const [folder, setFolder] = useState('');
  const [showPicker, setShowPicker] = useState(c.files.length === 0);
  const [fileWarn, setFileWarn] = useState('');
  const aud = normalizeAudience(c.audience);
  const audMode = Array.isArray(aud) ? 'names' : aud;

  // ⚠⚠資料を**外す**ときは、その資料を見せていた章のひも付け(driveId)とページ・秒も一緒に外す。
  //   残すと、受講画面がその章で別の資料を開いたうえで「Nページ目を見てください」と出す
  //   (= 別の資料の別のページを事実として指示する)。何をしたかは必ず画面に出す。
  const toggleFile = (f) => {
    const has = c.files.some(x => x.driveId === f.driveId);
    if (!has) { setFileWarn(''); set({ files: [...c.files, f] }); return; }
    const hit = (c.chapters || []).filter(ch => ch.driveId === f.driveId);
    setFileWarn(hit.length
      ? `「${f.name}」を外したので、この資料を見せていた章（${hit.length}件: ${hit.map(x => x.title || `第${c.chapters.indexOf(x) + 1}章`).join('、')}）のひも付け・ページ・開始秒も外しました。章ごとに資料を選び直してください。`
      : '');
    set({
      files: c.files.filter(x => x.driveId !== f.driveId),
      chapters: hit.length ? c.chapters.map(ch => (ch.driveId === f.driveId ? { ...ch, driveId: '', page: 0, startSec: 0, endSec: 0 } : ch)) : c.chapters,
    });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-slate-200 bg-white flex flex-wrap items-center gap-2">
        <button onClick={onCancel} className={`px-3 py-1.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold ${TAP}`}>← 一覧へ</button>
        <span className="font-bold text-slate-700 text-sm flex-1 min-w-0 truncate">{c.publishedAt > 0 ? '講座を直す' : '新しい講座'}</span>
        <button onClick={() => onSave(c, { publish: false })} disabled={saving} className={`px-3 py-1.5 rounded bg-slate-600 hover:bg-slate-700 disabled:opacity-50 text-white text-xs font-bold ${TAP}`}>下書きで保存</button>
        <button onClick={() => onSave(c, { publish: true })} disabled={saving} className={`px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-black ${TAP}`}>
          {saving ? '保存中…' : (c.publishedAt > 0 ? '保存して公開のまま' : '公開する')}
        </button>
      </div>
      {err && <div className="shrink-0 mx-3 mt-2 rounded-lg bg-rose-50 border border-rose-300 text-rose-800 px-3 py-2 text-sm font-bold">⚠ {err}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 bg-slate-50">
        {/* ▼ ①題名・対象者・時間 ------------------------------------------- */}
        <div className="rounded-xl bg-white border border-slate-200 p-3 space-y-2">
          <label className="block text-xs font-bold text-slate-500">題名</label>
          <input value={c.title} onChange={e => set({ title: e.target.value })} placeholder="例: 分割精度の基礎"
            className={`w-full px-3 py-2 border border-slate-300 rounded-lg text-sm ${TAP}`} />
          <div className="flex flex-wrap gap-3">
            <div className="min-w-[12rem] flex-1">
              <label className="block text-xs font-bold text-slate-500 mb-1">誰に出すか</label>
              <select value={audMode} onChange={e => set({ audience: e.target.value === 'names' ? [] : e.target.value })}
                className={`w-full px-2 py-2 border border-slate-300 rounded-lg text-sm bg-white ${TAP}`}>
                <option value="all">全員</option>
                <option value="trainee">教育中の人だけ（必修）</option>
                <option value="names">名前を選ぶ</option>
              </select>
            </div>
            <div className="w-28">
              <label className="block text-xs font-bold text-slate-500 mb-1">およその時間</label>
              <input type="number" min="0" value={c.estMin || ''} onChange={e => set({ estMin: Number(e.target.value) || 0 })}
                className={`w-full px-2 py-2 border border-slate-300 rounded-lg text-sm ${TAP}`} placeholder="分" />
            </div>
          </div>
          {audMode === 'names' && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {(workers || []).map(w => {
                const on = Array.isArray(aud) && aud.includes(w.name);
                return (
                  <button key={w.id || w.name} onClick={() => {
                    const cur = Array.isArray(aud) ? aud : [];
                    set({ audience: on ? cur.filter(x => x !== w.name) : [...cur, w.name] });
                  }} className={`px-3 py-1.5 rounded-full border-2 text-xs font-bold ${TAP} ${on ? 'bg-sky-600 border-sky-600 text-white' : 'bg-white border-slate-300 text-slate-600'}`}>
                    {w.name}{w.trainee ? ' 🎓' : ''}
                  </button>
                );
              })}
              {(workers || []).length === 0 && <span className="text-xs text-slate-400">作業者が登録されていません。</span>}
            </div>
          )}
          <textarea value={c.note} onChange={e => set({ note: e.target.value })} rows={2} placeholder="ひとこと説明（受講画面のいちばん上に出ます）"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
        </div>

        {/* ▼ ②Driveの資料を選ぶ = ここだけで「そのまま公開」が成立する -------- */}
        <div className="rounded-xl bg-white border-2 border-emerald-300 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-black text-sm text-emerald-800">① Driveの資料を選ぶ（選んで題名を付ければ、もう公開できます）</div>
            <button onClick={() => setShowPicker(v => !v)} className={`px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold ${TAP}`}>
              {showPicker ? '選ぶのをたたむ' : 'ファイルを選ぶ'}
            </button>
          </div>
          {c.files.length > 0 && (
            <div className="space-y-1">
              {c.files.map(f => (
                <div key={f.driveId} className="flex items-center gap-2 px-2 py-1.5 rounded bg-slate-50 border border-slate-200">
                  <span className="text-lg shrink-0">{DRIVE_KIND_ICON[driveKindOf(f.mime, f.name)]}</span>
                  <span className="flex-1 min-w-0 text-sm text-slate-700 break-all">{f.name}</span>
                  <button onClick={() => toggleFile(f)} className={`px-2 py-1.5 text-slate-400 hover:text-rose-600 ${TAP}`} title="この資料を外す">✕</button>
                </div>
              ))}
            </div>
          )}
          {/* 資料を外した時に章へ何をしたかの知らせ。⚠列に流し込む(浮かせない)。 */}
          {fileWarn && (
            <div className="rounded-lg bg-amber-50 border border-amber-400 text-amber-900 px-2 py-2 text-xs font-bold flex items-start gap-2">
              <span className="flex-1 min-w-0">⚠ {fileWarn}</span>
              <button onClick={() => setFileWarn('')} className={`px-2 py-1 rounded bg-white border border-amber-400 text-amber-800 shrink-0 ${TAP}`}>閉じる</button>
            </div>
          )}
          {c.files.length === 0 && <div className="text-xs text-amber-700 bg-amber-50 border border-amber-300 rounded px-2 py-1.5">資料がまだ1つも選ばれていません。</div>}
          {showPicker && (
            <div className="h-72 flex flex-col min-h-0">
              <DriveFilePicker folder={folder} onFolderChange={setFolder} selected={c.files} onToggle={toggleFile} />
            </div>
          )}
        </div>

        {/* ▼ ③章と確認テスト(あとから足せる) ------------------------------- */}
        <div className="rounded-xl bg-white border border-slate-200 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-bold text-sm text-slate-700">② 章と確認テスト（あとから足せます・無くても公開できます）</div>
            <button onClick={() => set({ kind: 'built', chapters: [...c.chapters, { id: newChapterId(), title: '', min: 0, body: '', keyPoints: [], driveId: c.files[0]?.driveId || '', page: 0, startSec: 0, endSec: 0, quiz: [] }] })}
              className={`px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold flex items-center gap-1 ${TAP}`}><Plus className="w-4 h-4" /> 章を足す</button>
          </div>
          {c.chapters.length === 0 ? (
            <div className="text-xs text-slate-500">
              章がないので、この講座は<b>「そのまま公開」</b>です。上で選んだ資料がそのまま並びます。<br />
              あとから章を足しても、資料と題名はそのまま残ります。
            </div>
          ) : (
            <div className="space-y-2">
              {c.chapters.map((ch, i) => (
                <ChapterEditor key={ch.id} chapter={ch} index={i} files={c.files}
                  onChange={(next) => set({ chapters: c.chapters.map((x, j) => (j === i ? next : x)) })}
                  onRemove={() => set({ chapters: c.chapters.filter((_, j) => j !== i), kind: c.chapters.length <= 1 ? 'asis' : 'built' })} />
              ))}
            </div>
          )}
        </div>
        <KnowledgePrivacyNote />
      </div>
    </div>
  );
};

/**
 * 管理画面。マスタ設定 → 📚知識標準。
 * ⚠受講状況は「まだ受けていないのは誰か」まで。個人の点数は並べない(清水さんへの約束)。
 */
export const KnowledgePanel = ({
  courses = [], records = [], workers = [], currentUserName = '',
  saveData = null, deleteData = null, reworkDraft = null, onReworkDraftUsed = null,
}) => {
  const list = useMemo(() => sortCoursesForAdmin(courses), [courses]);
  const pick = useMemo(() => monthlyPickOf(courses), [courses]);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [openStatus, setOpenStatus] = useState(null);
  const [preview, setPreview] = useState(false);

  // 🔁 再作業の原因ランキングから飛んできた下書きを受け取る(いちばん損している所から教材を作る導線)
  useEffect(() => {
    if (!reworkDraft) return;
    setDraft(reworkDraft);
    if (onReworkDraftUsed) onReworkDraftUsed();
  }, [reworkDraft, onReworkDraftUsed]);

  const save = async (c, { publish }) => {
    if (!saveData) { setErr('保存の窓口がありません（アプリの不具合です）。'); return; }
    const title = String(c.title || '').trim();
    if (!title) { setErr('題名を入れてください。'); return; }
    if (publish && (c.files || []).length === 0 && (c.chapters || []).length === 0) {
      setErr('公開するには、Driveの資料を1つ以上選ぶか、章を1つ以上作ってください。（中身の無い講座は出しません）');
      return;
    }
    setSaving(true); setErr('');
    try {
      const now = Date.now();
      const body = {
        ...normalizeCourse({ ...c, title }),
        kind: (c.chapters || []).length > 0 ? 'built' : 'asis',
        updatedAt: now,
        publishedAt: publish ? (c.publishedAt > 0 ? c.publishedAt : now) : 0,
      };
      await saveData(KNOWLEDGE_COURSES_COL, body.id, body);
      setDraft(null);
    } catch (e) {
      setErr('保存できませんでした: ' + ((e && e.message) || e));
    } finally {
      setSaving(false);
    }
  };

  const patch = async (course, body) => {
    if (!saveData) { setErr('保存の窓口がありません（アプリの不具合です）。'); return; }
    setErr('');
    try { await saveData(KNOWLEDGE_COURSES_COL, course.id, { ...body, updatedAt: Date.now() }); }
    catch (e) { setErr('保存できませんでした: ' + ((e && e.message) || e)); }
  };

  // ⭐今月の1本は必ず1つ。他に立っている印は全部おろす(2本出さない)。
  // ⚠ONにすると **公開日が今日になる** = 全員の画面に「新着」として届く（清水さんの「全員に未読で配信」）。
  //   新着の数え方は「前に開いた時より後に公開された物」なので、公開日を動かさないと誰にも届かない。
  const setMonthly = async (course) => {
    if (!saveData) { setErr('保存の窓口がありません（アプリの不具合です）。'); return; }
    const on = !course.monthlyPick;
    if (on && !window.confirm(`「${course.title}」を今月の1本にします。\n\n・全員の講座一覧のいちばん上に出ます\n・公開日が今日になり、対象の人に「新着」として届きます\n\nよろしいですか？`)) return;
    try {
      for (const c of list) {
        if (c.monthlyPick && c.id !== course.id) await saveData(KNOWLEDGE_COURSES_COL, c.id, { monthlyPick: false, updatedAt: Date.now() });
      }
      await patch(course, { monthlyPick: on, publishedAt: on ? Date.now() : course.publishedAt });
    } catch (e) { setErr('「今月の1本」を切り替えられませんでした: ' + ((e && e.message) || e)); }
  };

  const move = async (course, dir) => {
    const i = list.findIndex(c => c.id === course.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    try {
      await saveData(KNOWLEDGE_COURSES_COL, list[i].id, { order: j, updatedAt: Date.now() });
      await saveData(KNOWLEDGE_COURSES_COL, list[j].id, { order: i, updatedAt: Date.now() });
    } catch (e) { setErr('並べ替えできませんでした: ' + ((e && e.message) || e)); }
  };

  const remove = async (course) => {
    if (!deleteData) { setErr('削除の窓口がありません（アプリの不具合です）。'); return; }
    if (!window.confirm(`講座「${course.title}」を消します。よろしいですか？\n※受けた記録は残ります（消えません）。`)) return;
    try { await deleteData(KNOWLEDGE_COURSES_COL, course.id); }
    catch (e) { setErr('消せませんでした: ' + ((e && e.message) || e)); }
  };

  if (draft) {
    return (
      <div className="h-full flex flex-col min-h-0 bg-slate-50">
        <CourseEditor draft={draft} workers={workers} onChange={setDraft} onSave={save} onCancel={() => { setDraft(null); setErr(''); }} saving={saving} err={err} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 p-3 bg-white border-b border-slate-200 flex flex-wrap items-center gap-2">
        <h2 className="font-black text-slate-800 flex items-center gap-2 min-w-0"><GraduationCap className="w-5 h-5 text-indigo-600 shrink-0" /> 知識標準（講座）</h2>
        <span className="text-xs text-slate-500 flex-1 min-w-[10rem]">
          作業標準とは別の、基礎知識を学ぶ教材です。
          {pick ? <> 今月の1本: <b className="text-amber-700">{pick.title}</b></> : ' 今月の1本はまだ決まっていません。'}
        </span>
        <button onClick={() => setPreview(true)} className={`px-3 py-1.5 rounded bg-slate-600 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1 ${TAP}`}><Eye className="w-4 h-4" /> 作業者の見え方</button>
        <button onClick={() => setDraft({ ...normalizeCourse({ id: newCourseId(), kind: 'asis', audience: 'all', order: list.length }) })}
          className={`px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black flex items-center gap-1 ${TAP}`}><Plus className="w-4 h-4" /> 新しい講座</button>
      </div>

      {err && <div className="shrink-0 mx-3 mt-2 rounded-lg bg-rose-50 border border-rose-300 text-rose-800 px-3 py-2 text-sm font-bold">⚠ {err}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 bg-slate-50">
        <KnowledgePrivacyNote />
        {!DRIVE_PROXY_URL && (
          <div className="rounded-lg bg-amber-50 border border-amber-300 text-amber-900 px-3 py-2 text-sm">
            <b>Drive連携が未設定です。</b> 資料を選べないので、いまは講座を公開できません（<code className="bg-white px-1 rounded">VITE_DRIVE_PROXY_URL</code> の設定が要ります）。
          </div>
        )}
        <div className="text-xs text-slate-500">
          Driveの置き場所: <b>資料ルート / 製品 / 講座</b>（ここに入れたPDF・パワポ動画が「ファイルを選ぶ」に並びます。反映は最大1分後）
        </div>

        {list.length === 0 && (
          <div className="rounded-xl bg-white border border-slate-200 p-8 text-center text-slate-400">
            <GraduationCap className="w-12 h-12 mx-auto mb-2 opacity-30" />
            <div className="font-bold">まだ講座がありません</div>
            <div className="text-sm mt-1">「新しい講座」→ Driveの資料を選ぶ → 題名を入れる → 公開、の3手で出せます。</div>
          </div>
        )}

        {list.map((c, i) => {
          const st = courseAudienceStatus({ course: c, records, workers });
          const open = openStatus === c.id;
          const qn = courseQuestionCount(c);
          return (
            <div key={c.id} className={`rounded-xl bg-white border-2 ${c.monthlyPick ? 'border-amber-400' : 'border-slate-200'}`}>
              <div className="p-3 flex flex-wrap items-start gap-2">
                <div className="flex flex-col gap-1 shrink-0">
                  <button onClick={() => move(c, -1)} disabled={i === 0} className={`px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-30 ${TAP}`} title="上へ"><ChevronUp className="w-4 h-4" /></button>
                  <button onClick={() => move(c, 1)} disabled={i === list.length - 1} className={`px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-30 ${TAP}`} title="下へ"><ChevronDown className="w-4 h-4" /></button>
                </div>
                <div className="flex-1 min-w-[12rem]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {c.monthlyPick && <span className="fi-tap-text font-black bg-amber-400 text-amber-950 rounded px-1.5 py-0.5">今月の1本</span>}
                    <span className={`fi-tap-text font-bold rounded px-1.5 py-0.5 border ${c.kind === 'built' ? 'bg-sky-100 text-sky-700 border-sky-300' : 'bg-slate-100 text-slate-600 border-slate-300'}`}>
                      {c.kind === 'built' ? '組み立て' : 'そのまま公開'}
                    </span>
                    <span className={`fi-tap-text font-bold rounded px-1.5 py-0.5 border ${isPublished(c) ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-500 border-slate-300'}`}>
                      {isPublished(c) ? `公開中 ${fmtDate(c.publishedAt)}` : '下書き'}
                    </span>
                    <span className="fi-tap-text font-bold bg-white text-slate-600 border border-slate-300 rounded px-1.5 py-0.5">{audienceLabel(c.audience)}</span>
                  </div>
                  <div className="font-bold text-slate-800 mt-1 break-all">{c.title || '(題名なし)'}</div>
                  <div className="fi-tap-text text-slate-500">
                    資料 {c.files.length}件 ・ 章 {c.chapters.length} ・ 確認テスト {qn}問{c.estMin > 0 ? ` ・ およそ ${c.estMin}分` : ''}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 shrink-0">
                  <button onClick={() => setMonthly(c)} className={`px-3 py-1.5 rounded text-xs font-bold border-2 ${TAP} ${c.monthlyPick ? 'bg-amber-400 border-amber-400 text-amber-950' : 'bg-white border-slate-300 text-slate-600'}`} title="今月の1本にする（全員の一覧のいちばん上に出ます）">⭐ 今月の1本</button>
                  <button onClick={() => patch(c, { publishedAt: isPublished(c) ? 0 : Date.now() })} className={`px-3 py-1.5 rounded text-xs font-bold border-2 border-slate-300 bg-white text-slate-700 ${TAP}`}>{isPublished(c) ? '非公開にする' : '公開する'}</button>
                  <button onClick={() => setDraft(normalizeCourse(c))} className={`px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold flex items-center gap-1 ${TAP}`}><Pencil className="w-3 h-3" /> 直す</button>
                  <button onClick={() => remove(c)} className={`px-3 py-1.5 rounded bg-rose-50 hover:bg-rose-100 border border-rose-300 text-rose-700 ${TAP}`}><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
              <button onClick={() => setOpenStatus(open ? null : c.id)} className={`w-full text-left px-3 py-2 border-t border-slate-100 text-xs font-bold text-slate-600 flex items-center gap-1.5 active:bg-slate-50 ${TAP}`}>
                <ChevronRight className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} />
                <Users className="w-4 h-4 text-slate-400" />
                受講状況: {st.doneCount} / {st.targetCount} 人が修了
              </button>
              {open && (
                <div className="px-3 pb-3 space-y-2">
                  <div className="fi-tap-text text-slate-500">
                    数の出どころ: この講座の対象者（{audienceLabel(c.audience)} ＝ {st.targetCount}人）のうち、
                    {qn > 0 ? '確認テストに「取得」した人' : '資料を見た記録がある人'}を数えています。
                  </div>
                  <div>
                    <div className="text-xs font-bold text-emerald-700">修了した人（{st.doneNames.length}人）</div>
                    <div className="text-sm text-slate-700 break-all">{st.doneNames.length ? st.doneNames.join('、') : '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-amber-700">まだ受けていない人（{st.notDoneNames.length}人）</div>
                    <div className="text-sm text-slate-700 break-all">{st.notDoneNames.length ? st.notDoneNames.join('、') : '—'}</div>
                  </div>
                  {qn > 0 && st.scored > 0 && (
                    <div className="fi-tap-text text-slate-500 bg-slate-50 rounded p-2">
                      確認テストの平均正答率: <b>{Math.round((st.scoreSum / (st.scored * st.scoreMax)) * 100)}%</b>
                      <span className="ml-1">（式: 受けた人の正解数の合計 {st.scoreSum} ÷（受けた人数 {st.scored} × 問題数 {st.scoreMax}））</span>
                      <div className="mt-1">教材の直しどころを見るための数字です。<b>個人の点数は並べません。</b></div>
                    </div>
                  )}
                  {qn > 0 && st.scored === 0 && <div className="fi-tap-text text-slate-400">まだ誰も確認テストを受けていません。</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {preview && (
        <KnowledgeLibraryModal courses={courses} records={records} workers={workers} currentUserName={currentUserName} saveData={null} previewMode onClose={() => setPreview(false)} />
      )}
    </div>
  );
};

// 再作業の原因ランキングの行に置く「この原因で講座を作る」ボタン。
// ⚠c.unknown(原因が引けなかった分)には**出さない**。原因不明から教材は作れない。
export const KnowledgeFromReworkButton = ({ row, hours, onCreate }) => {
  if (!row || row.unknown === true) return null;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); const d = courseDraftFromRework(row, { hours }); if (d && onCreate) onCreate(d); }}
      className={`px-2 py-1.5 rounded bg-indigo-600 hover:bg-indigo-700 text-white fi-tap-text font-bold whitespace-nowrap ${TAP}`}
      title="この原因をなくすための講座（知識標準）の下書きを作ります">
      📚 講座を作る
    </button>
  );
};
