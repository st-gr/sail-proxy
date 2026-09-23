/**
 * Errors the gateway itself produces on the SAP-RPT route, in the shape SAP's service uses
 * (`detail[]` of {loc,msg,type} plus a `status` block) so a client parses one shape whether the
 * refusal came from the gateway or from SAP. SAP's own errors are relayed verbatim and never
 * pass through here.
 */
export type RptErrorType = 'gateway_auth' | 'model_not_entitled' | 'model_not_found' | 'quota_exceeded' | 'upstream_unavailable';

const STATUS: Record<number, { code: number; message: string }> = {
  401: { code: 1, message: 'Unauthorized' },
  403: { code: 2, message: 'Invalid input' },
  404: { code: 2, message: 'Invalid input' },
  429: { code: 4, message: 'Quota exceeded' },
  502: { code: 3, message: 'Unavailable' },
  503: { code: 3, message: 'Unavailable' }
};

export function rptError(status: number, type: RptErrorType, msg: string) {
  return {
    status,
    body: { detail: [{ loc: [] as never[], msg, type }], status: STATUS[status] ?? { code: 2, message: 'Invalid input' } }
  };
}
