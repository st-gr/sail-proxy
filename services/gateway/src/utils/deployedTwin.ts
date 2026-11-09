import { deployedSiblingName } from './responsesEligibility';

export interface DeployedTwin { id: string; baseModel: string; deploymentUrl: string }

/**
 * The gateway lists every SAP AI Core deployment twice: the bare model (orchestration entry, no
 * deploymentUrl) and its `<model>--deployed` twin (carries the URL). Resolves whichever of the
 * two actually has a deploymentUrl. Shared by the Gemini route and the realtime relay.
 */
export async function resolveDeployedTwin(model: string, getDetails: (id: string) => Promise<any>): Promise<DeployedTwin | null> {
  const baseModel = model.endsWith('--deployed') ? model.slice(0, -'--deployed'.length) : model;
  const direct = await getDetails(model);
  if (direct?.deploymentUrl) return { id: model, baseModel, deploymentUrl: direct.deploymentUrl };
  const twin = deployedSiblingName(model);
  if (twin) {
    const twinDetails = await getDetails(twin);
    if (twinDetails?.deploymentUrl) return { id: twin, baseModel, deploymentUrl: twinDetails.deploymentUrl };
  }
  return null;
}
