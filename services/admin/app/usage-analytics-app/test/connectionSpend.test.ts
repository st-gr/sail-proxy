import { costByCurrency, connectionChartState, sapRequestCount, avgCostPerRequest, ConnectionUsageRow } from '../webapp/model/connectionSpend';

const row = (connection: string, currency: string | null, totalListCost: number, unpricedRequests = 0): ConnectionUsageRow => ({
  connection, provider: 'openai', currency, totalRequests: 1, totalTokens: 10, totalListCost, unpricedRequests
});

describe('costByCurrency', () => {
  it('sums the list cost per currency and never across currencies', () => {
    expect(costByCurrency([row('oa', 'USD', 0.5), row('az', 'EUR', 2), row('mi', 'USD', 0.25)]))
      .toEqual([{ currency: 'EUR', cost: 2 }, { currency: 'USD', cost: 0.75 }]);
  });
  it('rows without a currency (unpriced requests) add no figure', () => {
    expect(costByCurrency([row('oa', null, 0, 3), row('oa', 'USD', 1)])).toEqual([{ currency: 'USD', cost: 1 }]);
    expect(costByCurrency([row('oa', null, 0, 3)])).toEqual([]);
  });
  it('no rows give no figures', () => {
    expect(costByCurrency([])).toEqual([]);
  });
});

describe('connectionChartState', () => {
  it('rows present: the rows, one figure per currency and the visibility flag', () => {
    const rows = [row('oa', 'USD', 0.5), row('az', 'EUR', 2)];
    expect(connectionChartState(rows)).toEqual({
      connectionUsage: rows,
      connectionCost: [{ currency: 'EUR', cost: 2 }, { currency: 'USD', cost: 0.5 }],
      hasConnectionUsage: true
    });
  });
  it('no rows or undefined: empty and not visible', () => {
    const empty = { connectionUsage: [], connectionCost: [], hasConnectionUsage: false };
    expect(connectionChartState([])).toEqual(empty);
    expect(connectionChartState(undefined)).toEqual(empty);
  });
});

describe('sapRequestCount', () => {
  it('avg cost per request counts SAP requests only', () => {
    const rows = [{ ...row('oa', 'USD', 1), totalRequests: 3 }, { ...row('az', 'EUR', 1), totalRequests: 2 }];
    expect(sapRequestCount(10, rows)).toBe(5);
  });
  it('missing connectionUsage leaves the total', () => {
    expect(sapRequestCount(10, undefined)).toBe(10);
  });
  it('never goes negative', () => {
    expect(sapRequestCount(1, [{ ...row('oa', 'USD', 1), totalRequests: 4 }])).toBe(0);
  });
});

describe('avgCostPerRequest', () => {
  it('admin branch: the cost is spread over the SAP requests only', () => {
    expect(avgCostPerRequest(10, 10, [{ ...row('oa', 'USD', 1), totalRequests: 3 }, { ...row('az', 'EUR', 1), totalRequests: 2 }])).toBe(2);
  });
  it('user branch: the user own Connection rows are left out too', () => {
    expect(avgCostPerRequest(3, 5, [{ ...row('oa', 'USD', 1), totalRequests: 2 }])).toBe(1);
  });
  it('no Connection rows leaves the plain average', () => {
    expect(avgCostPerRequest(10, 4, [])).toBe(2.5);
    expect(avgCostPerRequest(10, 4, undefined)).toBe(2.5);
  });
  it('only Connection requests give 0, not a division by zero', () => {
    expect(avgCostPerRequest(0, 2, [{ ...row('oa', 'USD', 1), totalRequests: 2 }])).toBe(0);
  });
});
