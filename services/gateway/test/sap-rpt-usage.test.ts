/**
 * SAP-RPT usage is folded from the RESPONSE, never the request: the metadata block SAP returns
 * counts every cell sent (rows × columns, index and target columns included) and every
 * prediction made (query rows × target columns). Measured 2026-09-22 on sap-rpt-1-small and
 * sap-rpt-1.6: 12 context rows + 2 query rows × 5 columns → num_rows 14, num_columns 5;
 * two targets → num_predictions 4, one target → 2. A rejected call has no metadata and
 * therefore bills nothing; a Parquet call, whose request the gateway cannot read, still bills.
 */
import { cellsFromResponse, accountedModel, DEEP_CONTEXT_SUFFIX } from '../src/sapRpt/usage';
import { rptError } from '../src/sapRpt/errors';

describe('cellsFromResponse', () => {
  it('multiplies rows by columns for input cells and takes num_predictions for predict cells', () => {
    const body = { id: 'x', metadata: { num_columns: 5, num_predictions: 4, num_query_rows: 2, num_rows: 14 }, predictions: [], status: { code: 0, message: 'ok' } };
    expect(cellsFromResponse(body)).toEqual({ inputCells: 70, predictCells: 4, contextMode: null });
  });
  it('reads the context mode 1.6 reports, and reports null where 1-small omits it', () => {
    const body = { metadata: { context_mode: 'deep', num_columns: 3, num_predictions: 1, num_query_rows: 1, num_rows: 3 } };
    expect(cellsFromResponse(body)).toEqual({ inputCells: 9, predictCells: 1, contextMode: 'deep' });
  });
  it('returns null for an error body, a body without metadata, or no body', () => {
    expect(cellsFromResponse({ detail: [{ loc: [], msg: 'Too many query rows provided. Maximum is 128.', type: 'value_error' }], status: { code: 2, message: 'Invalid input' } })).toBeNull();
    expect(cellsFromResponse({ metadata: { num_rows: 'x' } })).toBeNull();
    expect(cellsFromResponse(undefined)).toBeNull();
    expect(cellsFromResponse('not json')).toBeNull();
  });
});

describe('accountedModel', () => {
  it('appends the deep-context suffix only when the response says the deep tier ran', () => {
    expect(accountedModel('sap-rpt-1.6-large', 'deep')).toBe('sap-rpt-1.6-large' + DEEP_CONTEXT_SUFFIX);
    expect(accountedModel('sap-rpt-1.6-large', 'default')).toBe('sap-rpt-1.6-large');
    expect(accountedModel('sap-rpt-1-small', null)).toBe('sap-rpt-1-small');
  });
  it('strips a --deployed twin id to its bare model before appending the deep-context suffix', () => {
    expect(accountedModel('sap-rpt-1.6-large--deployed', 'deep')).toBe('sap-rpt-1.6-large' + DEEP_CONTEXT_SUFFIX);
  });
  it('leaves a --deployed twin id unchanged for a non-deep call', () => {
    expect(accountedModel('sap-rpt-1.6--deployed', 'default')).toBe('sap-rpt-1.6--deployed');
  });
});

describe('rptError', () => {
  it('produces the same envelope shape SAP uses, so a client parses one shape', () => {
    expect(rptError(403, 'model_not_entitled', 'Model sap-rpt-1.6 is not in your entitlement catalog "Default"')).toEqual({
      status: 403,
      body: { detail: [{ loc: [], msg: 'Model sap-rpt-1.6 is not in your entitlement catalog "Default"', type: 'model_not_entitled' }], status: { code: 2, message: 'Invalid input' } }
    });
    expect(rptError(503, 'upstream_unavailable', 'x').body.status).toEqual({ code: 3, message: 'Unavailable' });
    expect(rptError(401, 'gateway_auth', 'x').body.status).toEqual({ code: 1, message: 'Unauthorized' });
  });
});
