import { countText, emptyListText } from '../webapp/model/listTexts';

const t = (key: string, args?: (string | number)[]) => (args && args.length ? `${key}(${args.join('|')})` : key);
const format = (n: number) => `#${n}`;

describe('countText', () => {
  it('takes the singular key for exactly one, with the formatted number', () => {
    expect(countText(1, 'tracesShownOne', 'tracesShown', t, format)).toBe('tracesShownOne(#1)');
  });

  it('takes the plural key for none and for more than one', () => {
    expect(countText(0, 'tracesShownOne', 'tracesShown', t, format)).toBe('tracesShown(#0)');
    expect(countText(1234, 'tracesShownOne', 'tracesShown', t, format)).toBe('tracesShown(#1234)');
  });

  it('passes further arguments after the number', () => {
    expect(countText(1, 'startedOne', 'started', t, format, ['15:04'])).toBe('startedOne(#1|15:04)');
  });
});

describe('emptyListText', () => {
  it('says the time range is empty when no filter is applied', () => {
    expect(emptyListText(false, 'tracesNone', 'tracesNoneFiltered', t)).toBe('tracesNone');
  });

  it('says nothing matches the filter when one is applied', () => {
    expect(emptyListText(true, 'tracesNone', 'tracesNoneFiltered', t)).toBe('tracesNoneFiltered');
  });
});
