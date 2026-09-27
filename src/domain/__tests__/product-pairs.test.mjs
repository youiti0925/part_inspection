// 🧷 製品検査から **1バイトも変えずに** 写した純関数の「md5の対」(部品検査・2026-09-26)。
// -----------------------------------------------------------------------------
//  決まり: 純関数は製品検査(C:\Users\anrw3\product-inspection-app)から **そのまま** 写す。
//          画面(App.jsx)の側を部品に合わせる。純関数の中身を部品だけで直すと、片方だけ古くなる。
//  ここは、写した物の中身が製品の写した時点と同じか(改行を LF に揃えた md5)を見張る。
//  ⚠ 赤になったら: 部品側で純関数を直した → 製品側でも直して両方を同じにし、この表の md5 を両方で揃える。
//                   製品側が直った → 製品の新しい物を写し直し、この表の md5 を更新する(画面側の呼び方も確かめる)。
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');

const md5Lf = (p) => crypto.createHash('md5')
  .update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
  .digest('hex');

// { file: 部品の src/ からの道, product: 製品の写し元, md5: LF に揃えた md5 }
const PAIRS = [
  { file: 'domain/batchLiveTime.js', product: 'product-inspection-app/src/domain/batchLiveTime.js', md5: '2aec8b81656561a403b6ebd8d9cbef94' },
  { file: 'domain/workExecution.js', product: 'product-inspection-app/src/domain/workExecution.js', md5: 'eecf1fc35e7711da656012987b76387e' },
  // juggleGuide.js: 製品 ea16d6a で 2分の決まり(MIN_TRIP_WORK_MIN)を lotPair.js から移し、import 無しにしてから写した
  { file: 'domain/juggleGuide.js', product: 'product-inspection-app/src/domain/juggleGuide.js', md5: '8429300b801f9ed5fd663f18e874fbe8' },
  { file: 'domain/skipKeepingRecord.js', product: 'product-inspection-app/src/domain/skipKeepingRecord.js', md5: 'f80de283e4253445aede8de510a04506' },
  { file: 'domain/seqScreen.js', product: 'product-inspection-app/src/domain/seqScreen.js', md5: '6934e5bdb509b3f41dcd24e395a8ef14' },
  { file: 'domain/lotStartGuard.js', product: 'product-inspection-app/src/domain/lotStartGuard.js', md5: '2b9f3cd0a88768187d443ab3cd6439ee' },
  { file: 'workscreen/JuggleGuide.jsx', product: 'product-inspection-app/src/workscreen/JuggleGuide.jsx', md5: 'cb31c826b0e678527c8343bdab167e0a' },
  // 2026-09-27 土台: 他の区画が使う製品の純関数を先にまとめて写した(src/opsim は除く・usageRollup は部品の readBudget が別物なので P101 で)
  { file: 'domain/appFeedback.js', product: 'product-inspection-app/src/domain/appFeedback.js', md5: 'b571e66b4d2b45d2da493dd8d06db336' },
  { file: 'domain/appNotices.js', product: 'product-inspection-app/src/domain/appNotices.js', md5: '7d902fa95bfa54afda2fbb6d6cfe00d5' },
  { file: 'domain/arrivalActual.js', product: 'product-inspection-app/src/domain/arrivalActual.js', md5: '21a3bdfa635f8a4090bddab4273c0561' },
  { file: 'domain/arrivalSplits.js', product: 'product-inspection-app/src/domain/arrivalSplits.js', md5: '6e92853720d04ee1922b02f3dc5c16a6' },
  { file: 'domain/completeSplit.js', product: 'product-inspection-app/src/domain/completeSplit.js', md5: '379f1fbe7f753972f254859cd843c109' },
  { file: 'domain/contactBoard.js', product: 'product-inspection-app/src/domain/contactBoard.js', md5: 'e481dccf297dedb4e103e28422043ccc' },
  { file: 'domain/dailyWork.js', product: 'product-inspection-app/src/domain/dailyWork.js', md5: '9b7a8345c294337d7b5818d48ddc4252' },
  { file: 'domain/diagramOffload.js', product: 'product-inspection-app/src/domain/diagramOffload.js', md5: '7a89bbb10934294a761274be46291c68' },
  { file: 'domain/dispatchWords.js', product: 'product-inspection-app/src/domain/dispatchWords.js', md5: '10d0d8fc7ac71f49a71a7bd7f8404ff0' },
  { file: 'domain/dueConflict.js', product: 'product-inspection-app/src/domain/dueConflict.js', md5: 'c454363b15316bd7136c9fd8f09c0ad5' },
  { file: 'domain/dueDefense.js', product: 'product-inspection-app/src/domain/dueDefense.js', md5: 'fec221f65ada211b4e956025685bfa37' },
  { file: 'domain/educationEvents.js', product: 'product-inspection-app/src/domain/educationEvents.js', md5: '441ebbba610c576033361addd7838b84' },
  { file: 'domain/factoryCalendar.js', product: 'product-inspection-app/src/domain/factoryCalendar.js', md5: '660727bd8c8932af8400d082e152a672' },
  { file: 'domain/fileOffload.js', product: 'product-inspection-app/src/domain/fileOffload.js', md5: '746ebb1c608ecd35776c0f429a043a3e' },
  { file: 'domain/finishEta.js', product: 'product-inspection-app/src/domain/finishEta.js', md5: 'd3f8086c578bbd33b08540aaa2486846' },
  { file: 'domain/goal/effectiveGate.js', product: 'product-inspection-app/src/domain/goal/effectiveGate.js', md5: '5db9bef7fcdf17ae118a5eea935c2c2a' },
  { file: 'domain/goal/fiscalMath.js', product: 'product-inspection-app/src/domain/goal/fiscalMath.js', md5: '1317f4fd92a476ba2560c300bd370130' },
  { file: 'domain/goal/occurrence.js', product: 'product-inspection-app/src/domain/goal/occurrence.js', md5: '85adf6827f4d9b91db4ec9f4f1031506' },
  { file: 'domain/goal/pager.js', product: 'product-inspection-app/src/domain/goal/pager.js', md5: '40bbee05b6be2ff31e2eee9355c490cb' },
  { file: 'domain/goal/portfolioPlanner.js', product: 'product-inspection-app/src/domain/goal/portfolioPlanner.js', md5: '4ecf9d4c17d33b23bc78612fd0b0fbd7' },
  { file: 'domain/goal/verdictEngine.js', product: 'product-inspection-app/src/domain/goal/verdictEngine.js', md5: 'e811f643fd555d761ad7090a1e600ae3' },
  { file: 'domain/imageBudget.js', product: 'product-inspection-app/src/domain/imageBudget.js', md5: '1a9d716ab13f87c00a0c814b7aedd19a' },
  { file: 'domain/importExistingCheck.js', product: 'product-inspection-app/src/domain/importExistingCheck.js', md5: '2e00837eacaa6746f4e79fdbf020a693' },
  { file: 'domain/importMarkBackfill.js', product: 'product-inspection-app/src/domain/importMarkBackfill.js', md5: '0a86622297e35e0f87b84a49c35d9fd2' },
  { file: 'domain/importPlan.js', product: 'product-inspection-app/src/domain/importPlan.js', md5: '949b505eb94d2e4f7c824b388544c16f' },
  { file: 'domain/incomingWork.js', product: 'product-inspection-app/src/domain/incomingWork.js', md5: '7d1b902a8f4e674df1a8940e302160c9' },
  { file: 'domain/interruptionLog.js', product: 'product-inspection-app/src/domain/interruptionLog.js', md5: '9e1e4021360b01689c1ecb4dda0ed535' },
  { file: 'domain/knowledgeCourses.js', product: 'product-inspection-app/src/domain/knowledgeCourses.js', md5: '805601ff324c5f2866b29563f0fad6f6' },
  { file: 'domain/layoutMode.js', product: 'product-inspection-app/src/domain/layoutMode.js', md5: '929fd4ecc325b94d921ab446cd6faa40' },
  { file: 'domain/liveDataUsage.js', product: 'product-inspection-app/src/domain/liveDataUsage.js', md5: 'a0239a32e7da92388502dc95a5cb6437' },
  { file: 'domain/liveRecording.js', product: 'product-inspection-app/src/domain/liveRecording.js', md5: 'b88cc88c64a10b8f7bb12066cdaaa2d6' },
  { file: 'domain/liveSession.js', product: 'product-inspection-app/src/domain/liveSession.js', md5: 'eefc51b0de3b6df9c97a08032555afe9' },
  { file: 'domain/lotDuplicates.js', product: 'product-inspection-app/src/domain/lotDuplicates.js', md5: '18d8ccf47f4bc816d2aee11465994278' },
  { file: 'domain/lotPriority.js', product: 'product-inspection-app/src/domain/lotPriority.js', md5: 'e31a642b681ade87e0717fdaa7e0fe80' },
  { file: 'domain/lotRemaining.js', product: 'product-inspection-app/src/domain/lotRemaining.js', md5: 'fa9008989a3721ab69f258237d89a660' },
  { file: 'domain/lotSavePipeline.js', product: 'product-inspection-app/src/domain/lotSavePipeline.js', md5: '6687ad7331fb8209f9d4bdeaaa4ecd0a' },
  { file: 'domain/machineRuns.js', product: 'product-inspection-app/src/domain/machineRuns.js', md5: 'd095a60f6a676332a23cb0650b29334d' },
  { file: 'domain/modelMaster.js', product: 'product-inspection-app/src/domain/modelMaster.js', md5: '0037cba396a7cb74716a50beaae1c1cd' },
  { file: 'domain/modelMasterPropagate.js', product: 'product-inspection-app/src/domain/modelMasterPropagate.js', md5: 'cf9a4e675d5ea024a322a2039082ff83' },
  { file: 'domain/noticeDrafts.js', product: 'product-inspection-app/src/domain/noticeDrafts.js', md5: 'ff78d0300cef17d6c192b41a0f0a64a2' },
  { file: 'domain/operationsSimulation/actualPins.js', product: 'product-inspection-app/src/domain/operationsSimulation/actualPins.js', md5: '8a2d41a4848f502768a672ea437de3fe' },
  { file: 'domain/operationsSimulation/arrivalAccounting.js', product: 'product-inspection-app/src/domain/operationsSimulation/arrivalAccounting.js', md5: 'f60d659a60ca89561e42b854b2bb14f7' },
  { file: 'domain/operationsSimulation/arrivalHabit.js', product: 'product-inspection-app/src/domain/operationsSimulation/arrivalHabit.js', md5: '0fa8e9d9b799538b87cbd9379993818f' },
  { file: 'domain/operationsSimulation/atRisk.js', product: 'product-inspection-app/src/domain/operationsSimulation/atRisk.js', md5: '6b52f1d61ed1952a2e26329b9bb7ab32' },
  { file: 'domain/operationsSimulation/buildJobs.js', product: 'product-inspection-app/src/domain/operationsSimulation/buildJobs.js', md5: '1a8a94d669f463456b0c423c461cb757' },
  { file: 'domain/operationsSimulation/calendar.js', product: 'product-inspection-app/src/domain/operationsSimulation/calendar.js', md5: 'd85964f24285ecbd8356144902306b62' },
  { file: 'domain/operationsSimulation/decisionBoard.js', product: 'product-inspection-app/src/domain/operationsSimulation/decisionBoard.js', md5: 'd0de4d38e8c4e1b050cb26bc95667402' },
  { file: 'domain/operationsSimulation/dueListOrder.js', product: 'product-inspection-app/src/domain/operationsSimulation/dueListOrder.js', md5: '8c1f70025ad0c35b891b879e7724832e' },
  { file: 'domain/operationsSimulation/dueRowFacts.js', product: 'product-inspection-app/src/domain/operationsSimulation/dueRowFacts.js', md5: '6ed165a9a2f565294f9d00d1b2576d14' },
  { file: 'domain/operationsSimulation/education.js', product: 'product-inspection-app/src/domain/operationsSimulation/education.js', md5: '7aea19fc2d9b7233c26b3f74c5c97513' },
  { file: 'domain/operationsSimulation/educationLeadTime.js', product: 'product-inspection-app/src/domain/operationsSimulation/educationLeadTime.js', md5: '9a2cf4bc1845d146b97708a20be37afb' },
  { file: 'domain/operationsSimulation/equipmentCapacity.js', product: 'product-inspection-app/src/domain/operationsSimulation/equipmentCapacity.js', md5: 'f1fc2508e882674d595355d8eaed9045' },
  { file: 'domain/operationsSimulation/estimate.js', product: 'product-inspection-app/src/domain/operationsSimulation/estimate.js', md5: '353f7d1cdab3ff8e70f342beb8336cbf' },
  { file: 'domain/operationsSimulation/explain.js', product: 'product-inspection-app/src/domain/operationsSimulation/explain.js', md5: 'af2ba3d369a1cb652794de05140904e2' },
  { file: 'domain/operationsSimulation/forecast.js', product: 'product-inspection-app/src/domain/operationsSimulation/forecast.js', md5: '74cf85b15ebd6e237e2acaf3d42db3ef' },
  { file: 'domain/operationsSimulation/handoff.js', product: 'product-inspection-app/src/domain/operationsSimulation/handoff.js', md5: '0a156fe0a0a7d2ad2b7e0707ee3b129c' },
  { file: 'domain/operationsSimulation/historyEligibility.js', product: 'product-inspection-app/src/domain/operationsSimulation/historyEligibility.js', md5: '29b2d581315730779c24d1b396c90de2' },
  { file: 'domain/operationsSimulation/idleReason.js', product: 'product-inspection-app/src/domain/operationsSimulation/idleReason.js', md5: 'e4644bcef76fb9b35e606600447a14b0' },
  { file: 'domain/operationsSimulation/interruptionRate.js', product: 'product-inspection-app/src/domain/operationsSimulation/interruptionRate.js', md5: '8dbb5d45cb9ca60bf7fb3dc61e4a0cc4' },
  { file: 'domain/operationsSimulation/lateDone.js', product: 'product-inspection-app/src/domain/operationsSimulation/lateDone.js', md5: '9b4a19b2ab107147caf1ff1fc23dd8dd' },
  { file: 'domain/operationsSimulation/lateForecast.js', product: 'product-inspection-app/src/domain/operationsSimulation/lateForecast.js', md5: 'e9246457bfb4387770cbea3bd238b9ca' },
  { file: 'domain/operationsSimulation/lotFocus.js', product: 'product-inspection-app/src/domain/operationsSimulation/lotFocus.js', md5: 'c2a5378e3666821dbde5f7098467deac' },
  { file: 'domain/operationsSimulation/lotPins.js', product: 'product-inspection-app/src/domain/operationsSimulation/lotPins.js', md5: '363d5b6aea671f7cfba1cff237fec29a' },
  { file: 'domain/operationsSimulation/monthly.js', product: 'product-inspection-app/src/domain/operationsSimulation/monthly.js', md5: '70958d705f98c5c057dd508195faf1c6' },
  { file: 'domain/operationsSimulation/normalizeInput.js', product: 'product-inspection-app/src/domain/operationsSimulation/normalizeInput.js', md5: 'bc339612985cf4d2d516baa91458f107' },
  { file: 'domain/operationsSimulation/overtimePlan.js', product: 'product-inspection-app/src/domain/operationsSimulation/overtimePlan.js', md5: '7f393ff5037f689711b38ecd91d3e1b6' },
  { file: 'domain/operationsSimulation/personDay.js', product: 'product-inspection-app/src/domain/operationsSimulation/personDay.js', md5: '37f2986e732c50b7418ae60e7aef9b76' },
  { file: 'domain/operationsSimulation/policy.js', product: 'product-inspection-app/src/domain/operationsSimulation/policy.js', md5: '2c32adc4719d44815fb460240add37db' },
  { file: 'domain/operationsSimulation/priority.js', product: 'product-inspection-app/src/domain/operationsSimulation/priority.js', md5: '6d5e9fd11af3e93f4d1e62510dc63769' },
  { file: 'domain/operationsSimulation/remedyRank.js', product: 'product-inspection-app/src/domain/operationsSimulation/remedyRank.js', md5: '66763f58cbe3fbd47bb36951b566d340' },
  { file: 'domain/operationsSimulation/resample.js', product: 'product-inspection-app/src/domain/operationsSimulation/resample.js', md5: '7ac6c167f42b46ea7f289d54b5b62644' },
  { file: 'domain/operationsSimulation/rescueLadder.js', product: 'product-inspection-app/src/domain/operationsSimulation/rescueLadder.js', md5: 'fd2d6038669c73e0e4488a218f9c3bb5' },
  { file: 'domain/operationsSimulation/reworkRate.js', product: 'product-inspection-app/src/domain/operationsSimulation/reworkRate.js', md5: 'd0f5fe329e30b75197bf20558ab90f8a' },
  { file: 'domain/operationsSimulation/scenarios.js', product: 'product-inspection-app/src/domain/operationsSimulation/scenarios.js', md5: '0555b294094cd6da129a96a8dfa2cdf0' },
  { file: 'domain/operationsSimulation/setupChange.js', product: 'product-inspection-app/src/domain/operationsSimulation/setupChange.js', md5: 'e58e85814380ac829fac17d41e9e2e2b' },
  { file: 'domain/operationsSimulation/sharedWorker.js', product: 'product-inspection-app/src/domain/operationsSimulation/sharedWorker.js', md5: '39cf72a7199573934848d263d02bbaf8' },
  { file: 'domain/operationsSimulation/sharedWorkerPlan.js', product: 'product-inspection-app/src/domain/operationsSimulation/sharedWorkerPlan.js', md5: 'c2e75714e9813dd880b8ea9bbc5c10a0' },
  { file: 'domain/operationsSimulation/shipDeadline.js', product: 'product-inspection-app/src/domain/operationsSimulation/shipDeadline.js', md5: 'c49b92d4db4144a14a6c28ec1c793340' },
  { file: 'domain/operationsSimulation/simInputDoc.js', product: 'product-inspection-app/src/domain/operationsSimulation/simInputDoc.js', md5: '2a29ee6b2093a9f3bd9b8f104db78d1d' },
  { file: 'domain/operationsSimulation/simulate.js', product: 'product-inspection-app/src/domain/operationsSimulation/simulate.js', md5: '3ec7365d324e27036c962fb6cdaa2130' },
  { file: 'domain/operationsSimulation/skipHistory.js', product: 'product-inspection-app/src/domain/operationsSimulation/skipHistory.js', md5: '2d17aef31949de561c3f47cebf62eabd' },
  { file: 'domain/operationsSimulation/splitArrivalLoad.js', product: 'product-inspection-app/src/domain/operationsSimulation/splitArrivalLoad.js', md5: '4d7f22ceb0ed883fef7641e6a9dda36c' },
  { file: 'domain/operationsSimulation/templatePrefStats.js', product: 'product-inspection-app/src/domain/operationsSimulation/templatePrefStats.js', md5: '58e81f5d22e9e0a3103efeb4e04e4903' },
  { file: 'domain/operationsSimulation/untouchedPile.js', product: 'product-inspection-app/src/domain/operationsSimulation/untouchedPile.js', md5: '32f61fb36e78f43dc9b469a164bfe907' },
  { file: 'domain/operationsSimulation/whatifDiff.js', product: 'product-inspection-app/src/domain/operationsSimulation/whatifDiff.js', md5: '702e83e5c56f0f9ca2d75236ba619fae' },
  { file: 'domain/operationsSimulation/workerAvailability.js', product: 'product-inspection-app/src/domain/operationsSimulation/workerAvailability.js', md5: 'a03e5b4335e3e79fd1a1c97d63fa6a9b' },
  { file: 'domain/operationsSimulation/workerLoad.js', product: 'product-inspection-app/src/domain/operationsSimulation/workerLoad.js', md5: 'ce6d4104006aedb8614eb185ca6781f5' },
  { file: 'domain/operationsSimulation/workerSpeed.js', product: 'product-inspection-app/src/domain/operationsSimulation/workerSpeed.js', md5: '49d8127aa8ea7101c4425a5b0f4d5d69' },
  { file: 'domain/operationsSimulation/zoneCapacity.js', product: 'product-inspection-app/src/domain/operationsSimulation/zoneCapacity.js', md5: '2ad66a72759556393dee097da0a52257' },
  { file: 'domain/opsimBaseNow.js', product: 'product-inspection-app/src/domain/opsimBaseNow.js', md5: '3522c4bed65e24e3a2c0dd952c40ec52' },
  { file: 'domain/planControl/engineLocks.js', product: 'product-inspection-app/src/domain/planControl/engineLocks.js', md5: '5514d9e69e1c46ac57925e4b9bad1314' },
  { file: 'domain/planControl/planControl.js', product: 'product-inspection-app/src/domain/planControl/planControl.js', md5: '06b35a6ebcc18d6dc5403961917edf0e' },
  { file: 'domain/portalBridge.js', product: 'product-inspection-app/src/domain/portalBridge.js', md5: '075a61a0403d8574dbd3ce3c7a3f5228' },
  { file: 'domain/processTimes.js', product: 'product-inspection-app/src/domain/processTimes.js', md5: '8883d916d900103e61928230fd48b0d6' },
  { file: 'domain/progressSheet.js', product: 'product-inspection-app/src/domain/progressSheet.js', md5: 'f6ca702780847d639ffb4bf6584b46fa' },
  { file: 'domain/progressSheetAudit.js', product: 'product-inspection-app/src/domain/progressSheetAudit.js', md5: '1ca77521b804f1d51c65296ab9d3f933' },
  { file: 'domain/qualitySources.js', product: 'product-inspection-app/src/domain/qualitySources.js', md5: 'cc9234a286384e959321483e3b0b068b' },
  { file: 'domain/quotaMeter.js', product: 'product-inspection-app/src/domain/quotaMeter.js', md5: 'c9675844bb1b72d3bf2780487e88e26b' },
  { file: 'domain/reworkAnalysis.js', product: 'product-inspection-app/src/domain/reworkAnalysis.js', md5: '3949e25f4036608511ef3a8683b50709' },
  { file: 'domain/skillRegistry.js', product: 'product-inspection-app/src/domain/skillRegistry.js', md5: '0ce4618ca50823c5b35282ecc9f5842a' },
  { file: 'domain/soloDependency.js', product: 'product-inspection-app/src/domain/soloDependency.js', md5: 'b7ac8c5e40dd5ffaf74820fb471dda82' },
  { file: 'domain/starChart.js', product: 'product-inspection-app/src/domain/starChart.js', md5: '07e6081e2e44c7bdbf9d019ca60ef33b' },
  { file: 'domain/taskTimeQuality.js', product: 'product-inspection-app/src/domain/taskTimeQuality.js', md5: '5e9ae0e3d6a186f43084e05dbe379078' },
  { file: 'domain/teachingQueue.js', product: 'product-inspection-app/src/domain/teachingQueue.js', md5: 'c60e99e049738a4aca3172fc7777076c' },
  { file: 'domain/templateSync.js', product: 'product-inspection-app/src/domain/templateSync.js', md5: '3b88abf6ea082da577cd7fd83265a421' },
  { file: 'domain/timelineLayout.js', product: 'product-inspection-app/src/domain/timelineLayout.js', md5: 'cca19e93cbc65ee7a1c763dec5bcbec3' },
  { file: 'domain/unreadBadge.js', product: 'product-inspection-app/src/domain/unreadBadge.js', md5: 'aa2f4e4df975f7476bdeafe3fd602be9' },
  { file: 'domain/videoBox.js', product: 'product-inspection-app/src/domain/videoBox.js', md5: '444df845ea57a6ab3d7c9f11db40dc26' },
  { file: 'domain/videoMarks.js', product: 'product-inspection-app/src/domain/videoMarks.js', md5: 'ec7c07de0509d307379988289c74de7f' },
  { file: 'domain/workClock.js', product: 'product-inspection-app/src/domain/workClock.js', md5: '67253d9ef3e0b53325ca6f146cf89049' },
  { file: 'domain/workSessions.js', product: 'product-inspection-app/src/domain/workSessions.js', md5: 'e03d0ca73c84520b58f4760bbc2dd192' },
  { file: 'domain/workerDailyActual.js', product: 'product-inspection-app/src/domain/workerDailyActual.js', md5: 'c2f19376c2a6608a1e4e1eb87ca091ea' },
  { file: 'domain/workerPlan.js', product: 'product-inspection-app/src/domain/workerPlan.js', md5: '813226cf8606115a270a27cf07181b5f' },
  // 2026-09-27 opsim-engine: 製品の操業シミュレーション「エンジン(画面につながない計算)」だけを部品へ先に写した(.jsx画面は除く)
  { file: 'domain/planControl/submissionEvidence.js', product: 'product-inspection-app/src/domain/planControl/submissionEvidence.js', md5: '549adbb062dc7d11e94d70d06b020834' },
  { file: 'opsim/mainWorker.js', product: 'product-inspection-app/src/opsim/mainWorker.js', md5: '05e95de27cb6c88c15055cfeb5cb995d' },
  { file: 'opsim/arrivalLine.js', product: 'product-inspection-app/src/opsim/arrivalLine.js', md5: 'e954b484145a1bdf760fbd2c3e0a64a4' },
  { file: 'opsim/basisRegistry.js', product: 'product-inspection-app/src/opsim/basisRegistry.js', md5: '55b600fe720b26eec0de45d011523a92' },
  { file: 'opsim/boardDims.js', product: 'product-inspection-app/src/opsim/boardDims.js', md5: 'b71c167cf00f5b76636fec505aee606e' },
  { file: 'opsim/dueAxis.js', product: 'product-inspection-app/src/opsim/dueAxis.js', md5: '5f76353526d5f4daa4775a2760b6445f' },
  { file: 'opsim/fmtNum.js', product: 'product-inspection-app/src/opsim/fmtNum.js', md5: '65119aaa87376034169520e9740241e8' },
  { file: 'opsim/fullBoard.js', product: 'product-inspection-app/src/opsim/fullBoard.js', md5: '190f78a0f2e0fdf8ab98dae8af65e00e' },
  { file: 'opsim/horizonRange.js', product: 'product-inspection-app/src/opsim/horizonRange.js', md5: '28d7d4d88a91758ea2963bfa3af15604' },
  { file: 'opsim/idleTone.js', product: 'product-inspection-app/src/opsim/idleTone.js', md5: 'dbf0cac2986233260059fe4b1384abde' },
  { file: 'opsim/ladderRunner.js', product: 'product-inspection-app/src/opsim/ladderRunner.js', md5: 'e2ab1bb0e30ce2ff50e3a141d4515313' },
  { file: 'opsim/lateTone.js', product: 'product-inspection-app/src/opsim/lateTone.js', md5: 'df1660970b56c8f5cfd84e4942d5b70f' },
  { file: 'opsim/lotSwitchWhy.js', product: 'product-inspection-app/src/opsim/lotSwitchWhy.js', md5: '6cfdd537cbc19a94d9b7343d96a663da' },
  { file: 'opsim/nextJob.js', product: 'product-inspection-app/src/opsim/nextJob.js', md5: '9a1abf7a2a4a67d7ff9a761c7cbed15a' },
  { file: 'opsim/nextMonth/model.js', product: 'product-inspection-app/src/opsim/nextMonth/model.js', md5: '8128e99e4037ff8f4aa286109d315bc4' },
  { file: 'opsim/opsimPresentation.js', product: 'product-inspection-app/src/opsim/opsimPresentation.js', md5: 'a3fcf889dffb13499b720aef153d3555' },
  { file: 'opsim/planControl/submissionReport.js', product: 'product-inspection-app/src/opsim/planControl/submissionReport.js', md5: '72ff718b682bb2f96903c81315f4a341' },
  { file: 'opsim/planningReview/engine.js', product: 'product-inspection-app/src/opsim/planningReview/engine.js', md5: '5ff17888d5e79eab8227676597cf0efc' },
  { file: 'opsim/playPace.js', product: 'product-inspection-app/src/opsim/playPace.js', md5: '2d1e896dc9ab3b8af66c654bcfa0d4f2' },
  { file: 'opsim/realism.js', product: 'product-inspection-app/src/opsim/realism.js', md5: 'f75fcb9e0c442d349a917f09ad5cc472' },
  { file: 'opsim/skillGrid/model.js', product: 'product-inspection-app/src/opsim/skillGrid/model.js', md5: 'e1ae06daba5a0fafe6e734a42f431781' },
  { file: 'opsim/subLabel.js', product: 'product-inspection-app/src/opsim/subLabel.js', md5: 'fe782620f156ac48e382c8d7caaa1d29' },
  { file: 'opsim/todayDecisions.js', product: 'product-inspection-app/src/opsim/todayDecisions.js', md5: 'bb6fff495ced0ae84451346263304688' },
  { file: 'opsim/workerColors.js', product: 'product-inspection-app/src/opsim/workerColors.js', md5: '696de0aa786fa1bbf3c27d5ba1304348' },
  { file: 'opsim/workloadMeter.js', product: 'product-inspection-app/src/opsim/workloadMeter.js', md5: '6140214a2e71cb9af59498e5ac0d520e' },
  { file: 'workers/operationsSimulation.worker.js', product: 'product-inspection-app/src/workers/operationsSimulation.worker.js', md5: '7e0476da4ac2ca259c501a0163b20bc1' },
  // 2026-09-27 操業シミュの画面が使う純関数(中身を変えずに写した物だけ。「型式」を「品目コード」に変えた画面 .jsx は対にしない)
  { file: 'domain/fullPair/arrivalExecution.mjs', product: 'product-inspection-app/src/domain/fullPair/arrivalExecution.mjs', md5: '90c8754f956023eb4d0ecf5171bdf71f' },
  { file: 'domain/fullPair/fieldPlan.mjs', product: 'product-inspection-app/src/domain/fullPair/fieldPlan.mjs', md5: '1ef4df209a7bd209babc978d91826eea' },
  { file: 'domain/fullPair/fixture.mjs', product: 'product-inspection-app/src/domain/fullPair/fixture.mjs', md5: 'f7f267b5cf840d1dde2f9d47d432699a' },
  { file: 'domain/fullPair/input.mjs', product: 'product-inspection-app/src/domain/fullPair/input.mjs', md5: 'ce84dde739891d6cdb1a2e2c6505c091' },
  { file: 'domain/fullPair/scheduler.mjs', product: 'product-inspection-app/src/domain/fullPair/scheduler.mjs', md5: '0e2bbaf8779196bf2b5b9b57528f7ce1' },
  { file: 'domain/fullPair/workSurface.mjs', product: 'product-inspection-app/src/domain/fullPair/workSurface.mjs', md5: '45d7f37521e9bc8609132ac7c6464c60' },
  { file: 'domain/opsimRules.js', product: 'product-inspection-app/src/domain/opsimRules.js', md5: '6d9424352af9ae67c914da2c2b3589a7' },
  { file: 'domain/parallelLab/adoption.js', product: 'product-inspection-app/src/domain/parallelLab/adoption.js', md5: '1131091501252fdb0bd065feb00eba15' },
  { file: 'domain/parallelLab/compareThree.js', product: 'product-inspection-app/src/domain/parallelLab/compareThree.js', md5: 'f056bed519f4c82d91142b511835bf56' },
  { file: 'domain/parallelLab/fullPairInput.js', product: 'product-inspection-app/src/domain/parallelLab/fullPairInput.js', md5: '64c1a796c0ef0941e863ad3065a39c60' },
  { file: 'domain/parallelLab/juggling.js', product: 'product-inspection-app/src/domain/parallelLab/juggling.js', md5: 'ed8d2f146fd1982b75e753604ad866eb' },
  { file: 'domain/parallelLab/lotPair.js', product: 'product-inspection-app/src/domain/parallelLab/lotPair.js', md5: 'a451ef8fb476d08b407dc4870d7ed9ee' },
  { file: 'domain/parallelLab/lotParallel.js', product: 'product-inspection-app/src/domain/parallelLab/lotParallel.js', md5: '23486f8922cc8508cbcf57cca050fed9' },
  { file: 'domain/parallelLab/phaseProfile.js', product: 'product-inspection-app/src/domain/parallelLab/phaseProfile.js', md5: 'fa647daae0c6afaf282c5cb390ff7d69' },
  { file: 'domain/parallelLab/wholePlan.js', product: 'product-inspection-app/src/domain/parallelLab/wholePlan.js', md5: '9a6f5af875ffddbd97f2875a83169419' },
  { file: 'domain/planControl/fieldOrders.js', product: 'product-inspection-app/src/domain/planControl/fieldOrders.js', md5: 'd9353b94d6d034ca7b4e355c8cfb172c' },
  { file: 'domain/planControl/localPlanStore.js', product: 'product-inspection-app/src/domain/planControl/localPlanStore.js', md5: '45ff9d04f873ce5e019b040c9d3f3944' },
  { file: 'domain/planControl/planActuals.js', product: 'product-inspection-app/src/domain/planControl/planActuals.js', md5: 'd0be0b94bb4f03cdaa939559cc425c04' },
  { file: 'domain/planControl/planConditions.js', product: 'product-inspection-app/src/domain/planControl/planConditions.js', md5: '6246c7efcf8d77655d76dabc79cdc0e8' },
  { file: 'domain/planControl/planReview.js', product: 'product-inspection-app/src/domain/planControl/planReview.js', md5: '229edd06c98d7a674fa55400667fff1e' },
  { file: 'domain/planControl/resultAdapter.js', product: 'product-inspection-app/src/domain/planControl/resultAdapter.js', md5: '2c9fddacb2736441764d5a50f26925bb' },
  { file: 'domain/planControl/sharedPlanStore.js', product: 'product-inspection-app/src/domain/planControl/sharedPlanStore.js', md5: 'c1273f26b833579df381c057c5dbc94b' },
  { file: 'domain/planningReview/excelAudit.js', product: 'product-inspection-app/src/domain/planningReview/excelAudit.js', md5: '9584eb59dac7570cb0ef3f358d57b992' },
  { file: 'domain/planningReview/placement.js', product: 'product-inspection-app/src/domain/planningReview/placement.js', md5: 'f1d536cf28f1eb5d9da9e1d4b8eb3e22' },
  { file: 'domain/workRouting/routeInputs.js', product: 'product-inspection-app/src/domain/workRouting/routeInputs.js', md5: '7dd195f96e65ad7eef752207812b8feb' },
  { file: 'domain/workRouting/routeShelf.js', product: 'product-inspection-app/src/domain/workRouting/routeShelf.js', md5: '208c13f21c1a535c3d975f29b167da15' },
  { file: 'domain/workRouting/workRouting.js', product: 'product-inspection-app/src/domain/workRouting/workRouting.js', md5: '9e7d9aab55a5663e06bf278671877382' },
  { file: 'opsim/nextMonth/index.js', product: 'product-inspection-app/src/opsim/nextMonth/index.js', md5: 'efe8753b2a2ee109554f8c33f3529ae5' },
  { file: 'opsim/parallelLab/engine.mjs', product: 'product-inspection-app/src/opsim/parallelLab/engine.mjs', md5: 'bed92da1de3257efbb2d6551ceaf64ab' },
  { file: 'opsim/parallelLab/fieldMode.mjs', product: 'product-inspection-app/src/opsim/parallelLab/fieldMode.mjs', md5: '71ea4982676fd190d79f5a896920c735' },
  { file: 'opsim/parallelLab/inspectionInput.mjs', product: 'product-inspection-app/src/opsim/parallelLab/inspectionInput.mjs', md5: '1b50df4bea55654327375c36aafda4d5' },
  { file: 'opsim/skillGrid/index.js', product: 'product-inspection-app/src/opsim/skillGrid/index.js', md5: '472953be8e6617627d5b6c2102072eac' },
];

for (const p of PAIRS) {
  test(`PAIR ${p.file} は製品(${p.product})と同じ中身`, () => {
    assert.equal(md5Lf(path.join(SRC, p.file)), p.md5,
      `${p.file} の中身が製品の写しから変わった(部品だけで直さない。製品と揃えて md5 を更新する)`);
  });
}

// 製品の checkout が隣にある時だけ、今の製品とも比べる(CI には無いので飛ばす)。
const PRODUCT_ROOT = path.resolve(SRC, '..', '..', 'product-inspection-app');
test('PAIR 隣の製品検査の今の中身とも同じ(製品が手元にある時だけ)', { skip: !fs.existsSync(PRODUCT_ROOT) && '製品検査の checkout が無い' }, () => {
  const drift = PAIRS.filter(p => {
    const pp = path.resolve(SRC, '..', '..', p.product);
    return fs.existsSync(pp) && md5Lf(pp) !== md5Lf(path.join(SRC, p.file));
  }).map(p => p.file);
  assert.deepEqual(drift, [], `製品側が先に直っている: ${drift.join(', ')} (写し直して md5 を更新する)`);
});
