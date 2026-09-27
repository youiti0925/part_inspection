// 📅 P149/P160 工場の暦を共通の棚(contact-shared-v1/settings/config.factoryCalendar)へ書く口。
/** 共通の棚へ書く口。製品 saveFactoryCalendar(45115)と同じ形。消す印を必ず一緒に送る。 */
export const makeSaveFactoryCalendar = (saveContactShared, currentUserName = '') => async ({ days, deleteKeys }) => {
  if (!saveContactShared) return;
  await saveContactShared({
    factoryCalendar: { days: days || {}, updatedBy: currentUserName || '' },
    ...(deleteKeys && deleteKeys.length ? { __deleteMapKeys: deleteKeys } : {}),
  });
};
