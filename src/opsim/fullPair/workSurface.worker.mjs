import { arrivalDecision } from '../../domain/fullPair/arrivalExecution.mjs';
import { offerFor } from '../../domain/fullPair/workSurface.mjs';

self.onmessage = ({ data }) => {
  const { key, input, observation, workerId, currentLotId } = data;
  try {
    const options = { beamWidth: 64, maxExpansions: 60000 };
    const decision = arrivalDecision(input, { ...observation, options });
    const offer = offerFor({ input, observation, decision, workerId });
    // An unadopted offer cannot change ordinary single-lot instructions.
    const local = { ...input, scope: 'available-work', lots: input.lots.filter(l => l.id === currentLotId), jobs: input.jobs.filter(j => j.lotId === currentLotId) };
    const single = arrivalDecision(local, { ...observation, options });
    self.postMessage({ key, decision, offer, single });
  } catch (e) { self.postMessage({ key, error: String(e.message || e) }); }
};
