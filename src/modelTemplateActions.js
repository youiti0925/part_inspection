// 🗂 P067 / P119 / P157 品目コードマスタ・品目コード専用テンプレ(model_templates)の操作
// ----------------------------------------------------------------------------
// 製品 App.jsx の次の関数を写し、App の外(このファイル)に置いた。App は依存を渡すだけ。
//   handleSaveModelTemplate(49572〜) / applyTemplateSync(49611〜) / openTemplateSyncFor(49647〜)
//   undoTemplateSync(49655〜) / removeModelTemplateEntry(49679〜) / revertModelTemplate(49720〜)
//   openMasterPropagate / applyMasterPropagate(48700〜)
// 言葉は「型式」→「品目コード」。判定の式は写した純関数(modelMaster / templateSync / modelMasterPropagate)。
// ⚠ ロットへの焼き直し(未着手だけ・該当なしの付け外し)は App の rebakeLots に任せる(共通テンプレの保存と同じ道)。
import { modelTemplateDocId, findModelTemplate } from './domain/modelMaster.js';
import { syncPolicyOf as tsPolicy } from './domain/templateSync.js';
import { planMasterChangeUpdates } from './domain/modelMasterPropagate.js';

export const isUntouchedLot = (l) => !l.workStartTime && l.status !== 'completed' && l.location !== 'completed' && !Object.values(l.tasks || {}).some(t => t && t.firstStartTime);

export function makeModelTemplateActions(d) {
  const {
    settings, saveSettings, saveData, deleteData, templates, lots, modelTemplates, currentUserName,
    DATA_DELETE, rebakeLots, setTplSync, setModelTplEditing, setMasterPropagate, setMasterPropagateSaving,
    masterPropagate, calendar, defaultEntryDaysBefore, entryHHMM, defaultShipDaysBefore,
  } = d;

  // 専用テンプレの保存(共通テンプレ templates は一切触らない)。docId は mt_品目コード__テンプレID の決め打ち
  const handleSaveModelTemplate = async (model, templateId, templateData) => {
    const baseTpl = (templates || []).find(t => t.id === templateId);
    const docId = modelTemplateDocId(model, templateId);
    const docBody = {
      id: docId, model, templateId,
      baseName: baseTpl?.name || templateData.name || '',
      steps: templateData.steps || [],
      overview: templateData.overview ?? null,
      updatedAt: Date.now(),
    };
    try { await saveData('model_templates', docId, docBody); }
    catch (e) { alert(`🚨 品目コード専用テンプレを保存できませんでした。\n${(e && e.message) || e}\n\n通信を確かめて、もう一度「保存」を押してください。`); return; }
    setModelTplEditing(null);
    if (Array.isArray(docBody.steps) && docBody.steps.length > 0) {
      const targets = (lots || []).filter(l => l.model === model && l.templateId === templateId && isUntouchedLot(l));
      if (targets.length > 0 && confirm(`品目コード「${model}」の専用テンプレを保存しました。\nこの品目コード・テンプレを使う「未着手」の検査ロット ${targets.length}件 にも、専用の工程を反映しますか？\n\n・反映する＝各ロットの工程がこの専用テンプレに更新されます\n・作業中／完了のロットは実測データを守るため反映しません`)) {
        const ok = await rebakeLots(targets, docBody.steps, templateId);
        if (!ok) { alert('🚨 反映の保存が拒否されました。一部または全部のロットに反映できていません。\n通信を確かめて、専用テンプレをもう一度保存し「反映」をやり直してください。'); return; }
        alert(`✅ 未着手の ${targets.length}件 に専用テンプレを反映しました。`);
      }
    }
  };

  // 差分パネルの「反映する」。⚠反映前の steps を必ず1世代しまってから書く(prevSteps)
  const applyTemplateSync = async (target, result, fields, losses) => {
    const docId = modelTemplateDocId(target.model, target.templateId);
    const before = Array.isArray(target.doc?.steps) ? target.doc.steps : [];
    try {
      await saveData('model_templates', docId, {
        id: docId, model: target.model, templateId: target.templateId,
        baseName: target.doc?.baseName || '',
        steps: result.steps,
        overview: target.doc?.overview ?? null,
        prevSteps: before,
        prevAt: Date.now(),
        prevBy: currentUserName || '',
        syncPolicy: { ...tsPolicy(target.doc), fields, updatedAt: Date.now(), updatedBy: currentUserName || '' },
        lastSync: { at: Date.now(), by: currentUserName || '', ...result.applied, lost: losses.length },
        updatedAt: Date.now(),
      });
      alert(`✅ 品目コード「${target.model}」に反映しました。\n追加 ${result.applied.added} / 削除 ${result.applied.removed} / 変更 ${result.applied.changed}${losses.length ? `\n（${losses.length}件が上書き・削除されました）` : ''}\n\n※ 既存のロットは焼き付け済みなので変わりません。次に作るロットから効きます。\n※ 品目コードマスタの画面から「反映を取り消す」で1回だけ戻せます。`);
      setTplSync(s => (s ? { ...s, targets: s.targets.filter(t => t.model !== target.model) } : s));
    } catch (e) {
      alert(`反映できませんでした。\n${(e && e.message) || e}\n\n通信状態を確かめて、もう一度お試しください。`);
    }
  };

  const openTemplateSyncFor = (model, templateId) => {
    const tpl = (templates || []).find(t => t.id === templateId);
    const doc = findModelTemplate(modelTemplates, model, templateId);
    if (!tpl || !doc) return;
    setTplSync({ templateId, templateName: tpl.name || '', baseSteps: tpl.steps || [], targets: [{ model, templateId, doc }] });
  };

  const undoTemplateSync = async (model, templateId) => {
    const doc = findModelTemplate(modelTemplates, model, templateId);
    if (!doc || !Array.isArray(doc.prevSteps)) { alert('戻せる記録がありません。'); return; }
    const when = doc.prevAt ? new Date(doc.prevAt).toLocaleString('ja-JP') : '';
    if (!window.confirm(`品目コード「${model}」の専用テンプレを、${when} の反映を行う前の状態に戻します。\n工程 ${doc.steps?.length || 0}件 → ${doc.prevSteps.length}件。\n\n⚠戻せるのは1回だけです（戻すと、この控えは無くなります）。よろしいですか？`)) return;
    try {
      await saveData('model_templates', doc.id, { steps: doc.prevSteps, prevSteps: DATA_DELETE, prevAt: DATA_DELETE, prevBy: DATA_DELETE, updatedAt: Date.now() });
      alert('✅ 反映前の状態に戻しました。');
    } catch (e) {
      alert(`戻せませんでした。\n${(e && e.message) || e}`);
    }
  };

  const revertModelTemplate = async (model, templateId, opts = {}) => {
    const mtDoc = findModelTemplate(modelTemplates, model, templateId);
    if (!mtDoc) return;
    const tplName = (templates || []).find(t => t.id === templateId)?.name || mtDoc.baseName || templateId;
    if (!opts.skipConfirm && !confirm(`品目コード「${model}」の専用テンプレ（${tplName}）を削除して、共通の工程テンプレートに戻しますか？\n・既存ロットは焼き付け済みなので変わりません\n・次に作るロットから共通テンプレの工程が使われます`)) return;
    try {
      await deleteData('model_templates', mtDoc.id);
    } catch (e) {
      alert('専用テンプレの削除に失敗しました: ' + ((e && e.message) || e) + '\n通信状態を確認して、もう一度お試しください。');
    }
  };

  // 品目コードマスタから「この品目コードで このテンプレを使う」の登録を外す(取り消せない・消える物を名指しで見せる)
  const removeModelTemplateEntry = async (model, templateId, opts = {}) => {
    const m = String(model || '').trim();
    const tid = String(templateId || '').trim();
    if (!m || !tid) return false;
    const master = ((settings && settings.modelMasters) || {})[m];
    const list = (master && Array.isArray(master.templates)) ? master.templates : [];
    const idx = list.findIndex(e => e && String(e.templateId || '') === tid);
    if (idx < 0) { alert(`「${m}」の品目コードマスタに このテンプレの登録がありません。`); return false; }
    const tplName = (templates || []).find(t => t.id === tid)?.name || '(名前なし)';
    const e = list[idx] || {};
    const gone = [];
    if (e.standardNo) gone.push(`品質規格番号 ${e.standardNo}${e.revision ? ` Rev.${e.revision}` : ''}`);
    const naN = Object.values(e.stepProfile || {}).filter(v => v && v.enabled === false).length;
    if (naN) gone.push(`工程の「該当なし」${naN}件`);
    for (const [k, label] of [['shipDaysBefore', '出荷日の何日前'], ['dueDaysBefore', '納期のずらし'], ['entryDaysBefore', '入荷は納期の何日前'], ['daysBefore', '入荷の日からのずらし']]) {
      if (e[k] !== null && e[k] !== undefined && e[k] !== '') gone.push(`${label} ${e[k]}日`);
    }
    const dedicated = findModelTemplate(modelTemplates, m, tid);
    if (!opts.skipConfirm) {
      const lines = [
        `「${m}」から テンプレート「${tplName}」の登録を外します。`,
        '',
        gone.length ? `消えるもの:\n・${gone.join('\n・')}` : '消える中身はありません（登録だけの状態です）',
        '',
        '※ すでに作ってあるロットの工程は変わりません（焼き付け済み）。',
        '※ この操作は取り消せません。',
      ];
      if (!window.confirm(lines.join('\n'))) return false;
    }
    const next = list.filter((_, i) => i !== idx);
    await saveSettings({ modelMasters: { ...((settings && settings.modelMasters) || {}), [m]: { ...master, templates: next, updatedAt: Date.now() } } });
    if (dedicated) {
      if (window.confirm(`「${m}」には この品目コードだけの工程編集（専用テンプレ）も残っています。\nそちらも消して 共通の工程に戻しますか？\n\n※ 残すと、品目コードマスタに登録が無いのに 専用の工程が使われ続けます。`)) {
        await revertModelTemplate(m, tid, { skipConfirm: true });
      }
    }
    return true;
  };

  // 日数を打ち替えた → 検査リストの関係するロットも直すか。🚨 0件なら窓を出さない
  const openMasterPropagate = ({ model, templateId, before, after }) => {
    const plan = planMasterChangeUpdates({
      model, templateId, before, after, lots,
      calendar: calendar || null,
      defaultEntryDaysBefore, entryHHMM, defaultShipDaysBefore,
    });
    if (!plan.updates.length) return;
    setMasterPropagate({ model, templateId, ...plan });
  };
  const applyMasterPropagate = async () => {
    if (!masterPropagate) return;
    const list = masterPropagate.updates;
    setMasterPropagate(null);
    try {
      let done = 0;
      setMasterPropagateSaving(`検査リストを直しています… 0/${list.length}`);
      for (const u of list) {
        const patch = {};
        if (u.dueChange) patch.dueDate = u.newDueDate;
        if (u.entryChange && u.newEntryAt) patch.entryAt = u.newEntryAt;
        if (Object.keys(patch).length) await saveData('lots', u.lotId, patch);
        done++;
        setMasterPropagateSaving(`検査リストを直しています… ${done}/${list.length}`);
      }
      alert(`✓ 検査リストの ${done}件 を直しました`);
    } catch (err) {
      console.error(err);
      alert('検査リストの更新中にエラーが発生しました: ' + ((err && err.message) || err));
    } finally {
      setMasterPropagateSaving('');
    }
  };

  return { handleSaveModelTemplate, applyTemplateSync, openTemplateSyncFor, undoTemplateSync, revertModelTemplate, removeModelTemplateEntry, openMasterPropagate, applyMasterPropagate };
}
