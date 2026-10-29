import { originText, originLabel } from '../webapp/model/origin';

describe('originText', () => {
  it('a SAP model reads SAP AI Core', () => {
    expect(originText('sap', null)).toEqual({ key: 'originSap', args: [] });
  });
  it('a Connection model names its connection', () => {
    expect(originText('external', 'work-openai')).toEqual({ key: 'originConnection', args: ['work-openai'] });
  });
  it('an external model without a name still reads as a Connection', () => {
    expect(originText('external', null)).toEqual({ key: 'originConnectionUnnamed', args: [] });
  });
  it('a missing origin is a SAP model', () => {
    expect(originText(null, null)).toEqual({ key: 'originSap', args: [] });
  });
});

describe('originLabel', () => {
  const texts = ['SAP AI Core', 'Connection {0}', 'Connection'] as const;
  it('fills the connection name literally, also when it contains replacement patterns', () => {
    expect(originLabel('external', 'a$&b', ...texts)).toBe('Connection a$&b');
    expect(originLabel('external', "x$'y", ...texts)).toBe("Connection x$'y");
  });
  it('picks the SAP and unnamed texts', () => {
    expect(originLabel('sap', null, ...texts)).toBe('SAP AI Core');
    expect(originLabel('external', null, ...texts)).toBe('Connection');
  });
});
