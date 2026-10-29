/**
 * Whether SAP serves a model through a deployment of its own (a `--deployed` model) rather than
 * through orchestration. Only a deployment has an inference URL of its own; the /aws-bedrock route
 * sends orchestration models to the /anthropic flow.
 */
export function isDeployedModel(modelDetails: Record<string, any> | null | undefined): boolean {
  return !!(modelDetails && (
    modelDetails.accessType === "deployment" ||
    (modelDetails.deploymentUrl && modelDetails.deploymentUrl.length > 0) ||
    (modelDetails.internal_id && modelDetails.internal_id.endsWith('--deployed'))
  ));
}
