// W3 Task 1: `file_search.parsing.ocr.languages`. The codes become a tesseract argument
// (`-l eng+deu`), so anything that is not a plain language code must never get through.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDefaultLogger } from '@libs/logger';
import { ocrLanguagesConfig, OCR_LANGUAGE_CODE, getFileSearchConfig } from '../../src/services/configService';

const logger = getDefaultLogger();

describe('ocrLanguagesConfig', () => {
  afterEach(() => jest.restoreAllMocks());

  it('passes valid codes through in order, without duplicates, and says nothing', () => {
    const warn = jest.spyOn(logger, 'warn');
    expect(ocrLanguagesConfig(['eng'], ['eng'])).toEqual(['eng']);
    expect(ocrLanguagesConfig(['deu', 'eng', 'chi_sim', 'jpn_vert', 'deu_latf', 'deu'], ['eng'])).toEqual([
      'deu', 'eng', 'chi_sim', 'jpn_vert', 'deu_latf',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the default when the key is absent', () => {
    expect(ocrLanguagesConfig(undefined, ['eng'])).toEqual(['eng']);
    expect(ocrLanguagesConfig(null, ['eng'])).toEqual(['eng']);
  });

  it('drops anything that is not a language code, with a warning', () => {
    const warn = jest.spyOn(logger, 'warn');
    const hostile = ['eng+osd', '../etc/passwd', '-c', 'tessedit_ocr_engine_mode=0', 'ENG', 'en', 'script/Latin', 'deu ', '', 7, null, {}, 'a'.repeat(3) + '_' + 'b'.repeat(40)];
    expect(ocrLanguagesConfig(['eng', ...hostile], ['eng'])).toEqual(['eng']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatch(/ignoring invalid language codes/);
  });

  it('warns once for the same invalid list, again when it changes', () => {
    const warn = jest.spyOn(logger, 'warn');
    for (let i = 0; i < 5; i++) expect(ocrLanguagesConfig(['eng', 'EN'], ['eng'])).toEqual(['eng']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(ocrLanguagesConfig(['eng', 'DE'], ['eng'])).toEqual(['eng']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default, with a warning, when nothing valid remains or the value is not a list', () => {
    const warn = jest.spyOn(logger, 'warn');
    expect(ocrLanguagesConfig([], ['eng'])).toEqual(['eng']);
    expect(ocrLanguagesConfig(['-l'], ['eng'])).toEqual(['eng']);
    expect(ocrLanguagesConfig('eng+deu', ['eng'])).toEqual(['eng']);
    expect(warn).toHaveBeenCalled();
  });

  it('matches the schema pattern', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../../admin/src/schemas/api-config-schema.json'), 'utf8')
    );
    const languages = schema.$defs.capabilitiesGroup.properties.file_search.properties.parsing.properties.ocr.properties.languages;
    expect(languages.items.pattern).toBe(OCR_LANGUAGE_CODE.source);
    expect(languages.default).toEqual(['eng']);
  });
});

describe('getFileSearchConfig().parsing', () => {
  let tmpDir: string;
  const parsingWith = (parsing: unknown): any => {
    fs.writeFileSync(path.join(tmpDir, 'api_config.json'), JSON.stringify({ api_config: { capabilities: { file_search: { parsing } } } }));
    jest.resetModules();
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    return require('../../src/services/configService').getFileSearchConfig().parsing;
  };
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsing-config-'));
    process.env.CONFIG_FILE_PATH = path.join(tmpDir, 'api_config.json');
  });
  afterEach(() => {
    delete process.env.CONFIG_FILE_PATH;
    jest.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ships eng', () => {
    delete process.env.CONFIG_FILE_PATH;
    expect(getFileSearchConfig().parsing.ocr).toEqual({ languages: ['eng'] });
  });

  it('reads the configured languages and defaults an absent block', () => {
    expect(parsingWith({ ocr: { languages: ['eng', 'deu'] } }).ocr).toEqual({ languages: ['eng', 'deu'] });
    expect(parsingWith({ ocr: {} }).ocr).toEqual({ languages: ['eng'] });
    expect(parsingWith(undefined).ocr).toEqual({ languages: ['eng'] });
  });
});
