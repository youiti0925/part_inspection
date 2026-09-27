// 🚶 掛け持ち案内(作業画面)を出すか。2026-09-27 清水さん「いきなり現場の作業画面で出てきたらびっくりするから ON/OFF つけて OFF にしておいて」。
//   置き場所: settings.juggleGuide.enabled。**書いていない(undefined)は OFF**。true の時だけ出す。
export const juggleGuideOn = (settings) => !!(settings && settings.juggleGuide && settings.juggleGuide.enabled === true);
