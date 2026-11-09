/**
 * The capability/modality chips: the card footer tooltips and the Detail page's chip texts read the
 * filter pane's own names, in the cockpit's language.
 */
import { capabilityIcons, capabilityName, glyphFor } from '../webapp/model/capabilityIcons';

const de = Object.fromEntries(require('fs').readFileSync(require('path').join(__dirname, '../webapp/i18n/i18n_de.properties'), 'utf8')
  .split('\n').filter((l: string) => /^[A-Za-z]/.test(l)).map((l: string) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const t = (key: string) => String(de[key] ?? key);

describe('capabilityIcons', () => {
  it('lists capability glyphs first, then modality glyphs, with their English names', () => {
    expect(capabilityIcons('["text-generation","reasoning"]', '["text","image"]')).toEqual([
      { icon: 'sap-icon://write-new', tooltip: 'Text Generation' },
      { icon: 'sap-icon://org-chart', tooltip: 'Reasoning' },
      { icon: 'sap-icon://text', tooltip: 'Text' },
      { icon: 'sap-icon://image-viewer', tooltip: 'Image' }
    ]);
  });
  it('skips unknown flags and unreadable JSON', () => {
    expect(capabilityIcons('["teleportation"]', 'not json')).toEqual([]);
    expect(capabilityIcons(null, null)).toEqual([]);
  });
  it('names the chips in the cockpit language through the translator', () => {
    expect(capabilityIcons('["image-recognition","speech-to-text"]', '["audio"]', t).map((i) => i.tooltip))
      .toEqual([de.capImageRecognition, de.capSpeechToText, de.inAudio]);
    expect(de.capImageRecognition).toBe('Bilderkennung');
  });
  it('falls back to English while the bundle has not loaded (the translator returns the key)', () => {
    expect(capabilityIcons('["embedding"]', null, (key) => key)[0].tooltip).toBe('Embedding');
  });
  it('keeps the glyph lookup for the radio labels', () => {
    expect(glyphFor('speech-to-text')).toBe('sap-icon://microphone');
    expect(glyphFor('nope')).toBeUndefined();
  });
});

describe('capabilityName', () => {
  it('reads the Detail page chips as before in English, title-casing a flag it does not know', () => {
    expect(capabilityName('text-generation')).toBe('Text Generation');
    expect(capabilityName('speech-to-text')).toBe('Speech To Text');
    expect(capabilityName('video')).toBe('Video');
    expect(capabilityName('function-calling')).toBe('Function Calling');
  });
  it('translates the known flags', () => {
    expect(capabilityName('text-generation', t)).toBe(de.capText);
    expect(capabilityName('text', t)).toBe(de.inText);
    expect(capabilityName('function-calling', t)).toBe('Function Calling');
  });
});
