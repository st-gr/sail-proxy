import { liveButton, liveStatusKey } from '../webapp/model/liveStatus';

describe('liveStatusKey', () => {
  it('says what the view is doing', () => {
    expect(liveStatusKey({ live: true, range: false, order: 'newestLast', following: true })).toBe('statusFollowing');
    expect(liveStatusKey({ live: true, range: false, order: 'newestLast', following: false })).toBe('statusPaused');
    expect(liveStatusKey({ live: true, range: false, order: 'newestFirst', following: false })).toBe('statusNewestFirst');
    expect(liveStatusKey({ live: false, range: false, order: 'newestLast', following: true })).toBe('statusLiveOff');
    expect(liveStatusKey({ live: false, range: true, order: 'newestLast', following: true })).toBe('statusRange');
  });
});

describe('liveButton', () => {
  it('on: a pause icon, "Live: on" and the emphasized type; off: a play icon and "Live: off"', () => {
    expect(liveButton(true)).toEqual({ icon: 'sap-icon://pause', textKey: 'liveOn', type: 'Emphasized' });
    expect(liveButton(false)).toEqual({ icon: 'sap-icon://media-play', textKey: 'liveOff', type: 'Default' });
  });
});
