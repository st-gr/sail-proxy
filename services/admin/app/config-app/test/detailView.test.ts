import * as fs from 'fs';
import * as path from 'path';
import { storedValidationMessages } from '../webapp/model/storedValidation';
import { LatestRequest } from '../webapp/model/latestRequest';

const webapp = (...parts: string[]) => path.join(__dirname, '..', 'webapp', ...parts);
const read = (...parts: string[]) => fs.readFileSync(webapp(...parts), 'utf8');

/** One XML start/end tag as the view spells it, comments already removed. */
interface Tag {
  name: string;
  attributes: string;
  closing: boolean;
  selfClosing: boolean;
  index: number;
  end: number;
}

function tags(xml: string): Tag[] {
  return Array.from(xml.matchAll(/<(\/?)([A-Za-z][\w:.]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g)).map(m => ({
    name: m[2],
    attributes: m[3],
    closing: m[1] === '/',
    selfClosing: m[4] === '/',
    index: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length
  }));
}

/** The source of the element that starts at `start` (an opening tag), up to its matching end tag. */
function elementAt(xml: string, start: Tag): string {
  if (start.selfClosing) return xml.slice(start.index, start.end);
  let depth = 0;
  for (const tag of tags(xml.slice(start.index))) {
    if (tag.selfClosing) continue;
    depth += tag.closing ? -1 : 1;
    if (depth === 0) return xml.slice(start.index, start.index + tag.end);
  }
  throw new Error(`<${start.name}> is never closed`);
}

/** The elements directly inside `element` (which must be a single element's source). */
function children(element: string): Tag[] {
  const inner = tags(element);
  const result: Tag[] = [];
  let depth = 0;
  for (const tag of inner.slice(1, -1)) {
    if (tag.closing) { depth--; continue; }
    if (depth === 0) result.push(tag);
    if (!tag.selfClosing) depth++;
  }
  return result;
}

const view = () => read('view', 'Main.view.xml').replace(/<!--[\s\S]*?-->/g, '');

/** The detail column's DynamicPage, and the one control its 0..1 `content` aggregation can hold. */
function detailPage(): string {
  const xml = view();
  const start = tags(xml).find(t => !t.closing && t.name === 'f:DynamicPage' && /\sid="detailDynamicPage"/.test(t.attributes));
  if (!start) throw new Error('detailDynamicPage not found');
  return elementAt(xml, start);
}

/** One of the detail page's own aggregations (`f:title`, `f:header`, `f:content`). */
function detailAggregation(name: string): string {
  const page = detailPage();
  const start = children(page).find(t => t.name === name);
  if (!start) throw new Error(`detailDynamicPage has no ${name}`);
  return elementAt(page, start);
}

const detailContent = () => detailAggregation('f:content');

// sap.f.DynamicPage's `content` is 0..1. The XML template processor keeps only the last child of a
// 0..1 aggregation, so a second child silently orphans the first: that is how Configuration Info,
// Validation Results and the JSON editor came to be created but never rendered (7991f091), and how a
// programmatic replacement editor came to be built on top of the orphan.
describe('the configuration detail page', () => {
  it('has exactly one control in f:content', () => {
    expect(children(detailContent()).map(t => t.name)).toHaveLength(1);
  });

  it('declares the JSON editor inside that content', () => {
    expect(detailContent()).toMatch(/<codeeditor:CodeEditor\s[^>]*id="jsonEditor"/);
  });

  // An editable Input two-way bound to the OData V4 row context PATCHes on every change, bypassing
  // validation, the active-configuration guard and Save. The fields are shown, not edited, here.
  it('binds name, version and description to nothing editable', () => {
    const page = detailPage();
    for (const tag of tags(page).filter(t => !t.closing)) {
      if (/\{(name|version|description)\}/.test(tag.attributes)) {
        expect([tag.name, /\beditable="false"/.test(tag.attributes) || !/^(Input|TextArea)$/.test(tag.name)])
          .toEqual([tag.name, true]);
      }
    }
    expect(page).toMatch(/\{description\}/);
  });

  // The form view hides f:content (ConfigForm._setJsonVisible) and in the JSON view the form panel
  // inside f:header hides (the header itself stays, so DynamicPage keeps measuring it): only the
  // title is on screen in both. The configuration's info and
  // its stored validation messages therefore live there, once, and nowhere else.
  it('shows the configuration info and validation messages in the title, in both views', () => {
    const title = detailAggregation('f:title');
    const shown = [/\{checksum\}/, /\{description\}/, /'modifiedAt'/, /'isActive'/, /'isValid'/, /viewModel>\/selectedValidationMessages/];
    for (const pattern of shown) {
      expect([String(pattern), pattern.test(title)]).toEqual([String(pattern), true]);
      for (const other of ['f:header', 'f:content']) {
        expect([other, String(pattern), pattern.test(detailAggregation(other))]).toEqual([other, String(pattern), false]);
      }
    }
  });

  // DynamicPage ignores preserveHeaderStateOnScroll while its header is taller than 60% of the page,
  // and re-measures that only when the header's own box resizes. A header hidden with `visible`
  // keeps the open form's verdict in the JSON view, whose title then snaps away on scroll - info
  // and validation messages with it. The form panel inside hides instead; the header stays.
  it('keeps the detail header visible in both views', () => {
    const header = tags(detailAggregation('f:header')).find(t => !t.closing && t.name === 'f:DynamicPageHeader');
    expect(header?.attributes).toBeDefined();
    expect(header?.attributes).not.toMatch(/\svisible=/);
  });

  it('names no i18n key that is missing from any of the bundles', () => {
    const keys = Array.from(new Set(Array.from(detailPage().matchAll(/['{]i18n>([A-Za-z0-9_.]+)['}]/g)).map(m => m[1])));
    expect(keys).toEqual(expect.arrayContaining(['status', 'validation', 'lastModified', 'checksum', 'configDataJson', 'formActiveReadOnly']));
    const bundles = fs.readdirSync(webapp('i18n')).filter(f => f.endsWith('.properties'));
    expect(bundles).toHaveLength(8);
    for (const bundle of bundles) {
      const text = read('i18n', bundle);
      const missing = keys.filter(key => !new RegExp(`^${key.replace(/\./g, '\\.')}=.+$`, 'm').test(text));
      expect([bundle, missing]).toEqual([bundle, []]);
    }
  });
});

// The workaround built on the orphan: a second editor created in code and swapped into the page's
// content on every selection. With the declared editor rendered it has nothing left to do.
describe('the detail controller', () => {
  it('builds no editor of its own and never replaces the page content', () => {
    const controller = read('controller', 'Main.controller.ts');
    expect(controller.match(/programmaticJsonEditor|_programmaticEditor|\.setContent\(/g) ?? []).toEqual([]);
  });
});

// The service stores validationErrors / validationWarnings as JSON array strings (config-service
// createConfiguration). Bound as they are, a MessageStrip would show `["…","…"]`.
describe('storedValidationMessages', () => {
  it('turns both stored arrays into one message per entry, errors first', () => {
    expect(storedValidationMessages('["api_config is required","bad port"]', '["no sinks"]')).toEqual([
      { type: 'Error', text: 'api_config is required' },
      { type: 'Error', text: 'bad port' },
      { type: 'Warning', text: 'no sinks' }
    ]);
  });

  it('has nothing to show for a configuration that was never validated or passed cleanly', () => {
    expect(storedValidationMessages(null, null)).toEqual([]);
    expect(storedValidationMessages(undefined, '')).toEqual([]);
    expect(storedValidationMessages('[]', '[]')).toEqual([]);
  });

  it('shows a stored value that is not a JSON array as it is, rather than losing it', () => {
    expect(storedValidationMessages('Invalid JSON format in configData', null)).toEqual([
      { type: 'Error', text: 'Invalid JSON format in configData' }
    ]);
    expect(storedValidationMessages(null, '"just one"')).toEqual([{ type: 'Warning', text: 'just one' }]);
  });

  it('reads an entry that is an object by its message, and skips blank entries', () => {
    expect(storedValidationMessages('[{"message":"from an object"},{"path":"/a"},"  ",""]', null)).toEqual([
      { type: 'Error', text: 'from an object' },
      { type: 'Error', text: '{"path":"/a"}' }
    ]);
  });
});

// Pressing A then B fires two reads; nothing orders their answers. Only the last press may fill the
// detail page, or the editor and the info can end on A while the list shows B selected.
describe('LatestRequest', () => {
  it('lets only the last started request apply, whatever order the answers come in', async () => {
    const latest = new LatestRequest();
    const applied: string[] = [];
    const answer = (id: string, token: number, ms: number) =>
      new Promise<void>(resolve => setTimeout(() => {
        if (latest.isCurrent(token)) applied.push(id);
        resolve();
      }, ms));
    const a = latest.begin();
    const b = latest.begin();
    const a2 = latest.begin();
    await Promise.all([answer('A', a, 5), answer('B', b, 1), answer('A again', a2, 3)]);
    expect(applied).toEqual(['A again']);
  });

  it('applies nothing that was started before the detail was closed', () => {
    const latest = new LatestRequest();
    const token = latest.begin();
    latest.cancel();
    expect(latest.isCurrent(token)).toBe(false);
    expect(latest.isCurrent(latest.begin())).toBe(true);
  });
});

/** A controller method's source, from its signature up to the next member. */
function method(name: string): string {
  const source = read('controller', 'Main.controller.ts');
  const start = source.search(new RegExp(`\\n    (public|private) (async )?${name}\\(`));
  if (start < 0) throw new Error(`${name} not found`);
  const next = source.slice(start + 1).search(/\n    (public|private) /);
  const body = next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  // The next member's doc comment is not part of this one.
  const doc = body.lastIndexOf('\n    /**');
  return doc > 0 ? body.slice(0, doc) : body;
}

// Press and tick are two selections (plan Decision 2, 3A): the pressed row owns the detail, the
// ticked rows own the toolbar. Sharing one state made the toolbar act on a row nobody ticked
// (Delete of the pressed row, Activate of a ticked row while another is open, Duplicate of one row
// with another's editor text) and judged Save by a ticked row's state.
describe('the two selections', () => {
  it('lets a tick change only the toolbar, never the open configuration', () => {
    expect(method('onSelectionChange')).not.toMatch(/_selectedConfig\b|\/selectedConfigId\b|\/selectedConfigIsActive|onSelectionCleared/);
  });

  it('lets a press open the configuration without touching the toolbar', () => {
    expect(method('onItemPress')).not.toMatch(/selectedConfigIds|selectedConfigCan|\/toolbar/);
  });

  it('keeps no code path that writes the old shared selection', () => {
    expect(read('controller', 'Main.controller.ts')).not.toMatch(/selectedConfigIds|selectedConfigCan|onRowPress/);
    expect(view()).not.toMatch(/selectedConfigIds|selectedConfigCan/);
  });

  it('takes every toolbar action\'s target from the ticked rows', () => {
    for (const name of ['onDeleteConfiguration', 'onDuplicateConfiguration', 'onActivateConfiguration']) {
      const body = method(name);
      expect([name, /this\._selectionState\(\)/.test(body), /_selectedConfig\b/.test(body)]).toEqual([name, true, false]);
    }
    expect(read('controller', 'Main.controller.ts')).toMatch(/selectionState\(ticked, this\._openRow\(\)\)/);
  });

  it('judges Save by the open configuration alone', () => {
    expect(method('onSaveConfiguration')).toMatch(/canSave\(this\._openRow\(\)\)/);
  });

  it('marks the open row with the standard navigated indicator', () => {
    const item = tags(view()).find(t => !t.closing && t.name === 'ColumnListItem');
    // targetType any: an OData V4 part is otherwise formatted to the target property's type
    // (boolean) before the expression runs, and a Guid throws a FormatException.
    expect(item?.attributes).toMatch(/\snavigated="\{= \$\{path:'ID',targetType:'any'\} === \$\{viewModel>\/selectedConfigId\}\s*\}"/);
  });

  it('binds the toolbar\'s Delete, Duplicate and Activate to the ticked rows\' state', () => {
    const buttons = tags(view()).filter(t => !t.closing && t.name === 'Button');
    for (const [press, flag] of [['onDeleteConfiguration', 'canDelete'], ['onDuplicateConfiguration', 'canDuplicate'], ['onActivateConfiguration', 'canActivate']]) {
      const button = buttons.find(b => new RegExp(`press="${press}"`).test(b.attributes));
      expect([press, button?.attributes.match(/enabled="([^"]*)"/)?.[1]]).toEqual([press, `{viewModel>/toolbar/${flag}}`]);
    }
  });

  it('offers Activate and Duplicate for the open configuration in the detail title, with the toolbar\'s texts', () => {
    const actions = elementAt(detailAggregation('f:title'), tags(detailAggregation('f:title')).find(t => !t.closing && t.name === 'f:actions')!);
    const buttons = tags(actions).filter(t => !t.closing && t.name === 'Button');
    const activate = buttons.find(b => /press="\.?onActivateOpenConfiguration"/.test(b.attributes));
    const duplicate = buttons.find(b => /press="\.?onDuplicateOpenConfiguration"/.test(b.attributes));
    expect(activate?.attributes).toMatch(/text="\{i18n>activate\}"/);
    expect(duplicate?.attributes).toMatch(/text="\{i18n>duplicate\}"/);
    // Hidden while the open configuration is active: its own row state, not a ticked row's.
    expect(activate?.attributes).toMatch(/visible="\{= \$\{viewModel>\/selectedConfigId\} !== null &amp;&amp; !\$\{path:'isActive',targetType:'any'\}\}"/);
    expect(duplicate?.attributes).toMatch(/visible="\{= \$\{viewModel>\/selectedConfigId\} !== null\}"/);
  });

  // The title-bar Activate is shown by the detail page's live row context; a handler that judged
  // the copy taken at load (`_selectedConfig.isActive`) stayed a silent no-op after another row's
  // activation had made the open one inactive again.
  it('acts on the open configuration from the title-bar actions, judged by its live row context', () => {
    for (const name of ['onActivateOpenConfiguration', 'onDuplicateOpenConfiguration']) {
      const body = method(name);
      expect([name, /this\._openRowOrExplain\(\)/.test(body), /_selectedConfig\b|_selectionState/.test(body)]).toEqual([name, true, false]);
    }
    expect(method('_openRowOrExplain')).toMatch(/this\._openContextRow\(\)/);
    expect(method('_openContextRow')).toMatch(/byId\("detailDynamicPage"\)\?\.getBindingContext\(\)/);
  });

  // A filter can take the open row out of the list; the detail page then has no row context. The
  // title-bar actions did nothing and Save claimed the configuration was active.
  it('says so when the open configuration has left the list, instead of acting on a stale copy', () => {
    const explain = method('_openRowOrExplain');
    expect(explain).toMatch(/this\._selectedConfig/);
    expect(explain).toMatch(/openConfigNotInList/);
    const save = method('onSaveConfiguration');
    expect(save.search(/this\._openRowOrExplain\(\)/)).toBeGreaterThan(0);
    expect(save.search(/this\._openRowOrExplain\(\)/)).toBeLessThan(save.search(/canSave\(this\._openRow\(\)\)/));
  });

  it('forgets whose document the editor holds as soon as another row is pressed', () => {
    expect(method('onItemPress')).toMatch(/this\._selectedConfig = configData;\s*this\._editorConfigId = null;/);
  });

  it('brings unsaved form edits into the editor before duplicating from it', () => {
    expect(method('_duplicateConfiguration')).toMatch(/this\._configForm\.syncEditor\(\)/);
  });
});

// Activate and Rollback refreshed only the list; the detail kept the editability, strips and Save it
// was opened with (plan Finding 2), and `_selectedConfig.isActive` - a copy taken at load - judged
// Save. The open configuration's state now comes from its live row context, through one writer.
describe('the open configuration follows activation', () => {
  const controller = () => read('controller', 'Main.controller.ts');

  it('decides nothing by the copy taken at load', () => {
    expect(controller()).not.toMatch(/_selectedConfig\??\.isActive/);
    expect(method('_openRow')).toMatch(/this\._openContextRow\(\)/);
    expect(method('_openRow')).not.toMatch(/_selectedConfig\b/);
  });

  it('writes the read-only state only in _applyActiveState (and the reset of a closed detail)', () => {
    const writers = (property: string) => Array.from(controller().matchAll(new RegExp(`\\n    (?:public|private) (?:async )?(\\w+)\\([\\s\\S]*?(?=\\n    (?:public|private) |$)`, 'g')))
      .filter(m => new RegExp(`setProperty\\("${property}"`).test(m[0]))
      .map(m => m[1]);
    expect(writers('/selectedConfigIsActive').sort()).toEqual(['_applyActiveState', '_resetDetail']);
    // The press starts every configuration read-only until its document is in the editor.
    expect(writers('/isEditMode').sort()).toEqual(['_applyActiveState', '_resetDetail', 'onItemPress']);
  });

  it('derives that state from the activeState rule and hands it to the form', () => {
    const body = method('_applyActiveState');
    expect(body).toMatch(/activeState\(/);
    expect(body).toMatch(/this\._configForm\?\.onActiveStateChanged\(/);
  });

  it('applies it when the open configuration\'s document is loaded', () => {
    expect(method('_loadConfigurationDetails')).toMatch(/this\._applyActiveState\(/);
    expect(method('_loadConfigurationDetails')).not.toMatch(/setEditable\(/);
  });

  // Activate, Rollback, Save and Refresh all refresh the list; its rows (and the detail page's row
  // context with them) carry the new isActive once the list has updated.
  it('follows the open row after every list refresh, unless a newer press is still loading', () => {
    expect(method('onConfigListUpdateFinished')).toMatch(/this\._followOpenRowActiveState\(\)/);
    const follow = method('_followOpenRowActiveState');
    expect(follow).toMatch(/this\._openContextRow\(\)/);
    expect(follow).toMatch(/this\._detailLoad\.isCurrent\(/);
    expect(follow).toMatch(/this\._applyActiveState\(/);
    expect(method('_activateConfiguration')).toMatch(/this\._loadConfigurations\(\)/);
    expect(method('onConfirmRollback')).toMatch(/this\._refreshTable\(\)/);
    expect(method('onRefresh')).toMatch(/binding\.refresh\(\)/);
  });

  it('asks about unsaved edits before activating the open configuration', () => {
    expect(method('_confirmActivate')).toMatch(/this\._settleEditsBeforeActivate\(/);
    const settle = method('_settleEditsBeforeActivate');
    expect(settle).toMatch(/activateAsksFirst/);
    expect(settle).toMatch(/activateUnsavedMessage/);
  });

  it('lets the form rebuild its controls\' editability without losing its edits', () => {
    const body = formMethod('onActiveStateChanged');
    expect(body).toMatch(/this\._recomputeEditable\(isActive\)/);
    expect(body).toMatch(/this\._render\(\)/);
    // The edits live in _document against _documentBaseline; neither may be reset here.
    expect(body).not.toMatch(/_document\s*=|_documentBaseline\s*=/);
  });

  it('asks about unsaved edits whether or not the form exists, and calls the form only when it does', () => {
    const settle = method('_settleEditsBeforeActivate');
    expect(settle).not.toMatch(/!form\b/);
    expect(settle).toMatch(/form\?\.discardEdits\(\)/);
    expect(settle).toMatch(/if \(form\) \{\s*void form\.saveEdits\(\)/);
  });

  // JSON view: Save from the activation prompt goes through the host's Save, which says "no changes"
  // for a whitespace-only edit and leaves the editor marked dirty; and a read-back that never saw the
  // document stored dropped the activation without a word.
  it('Save from the activation prompt clears the editor\'s unsaved state once stored, and says so when it was not', () => {
    const body = formMethod('saveEdits');
    expect(body).toMatch(/await this\._awaitPersisted\(expected\)/);
    expect(body).toMatch(/this\._host\.markEditorSaved\(\)/);
    expect(body).toMatch(/formSaveNotPersisted/);
    expect(read('controller', 'ConfigForm.ts')).toMatch(/interface ConfigFormHost \{[^}]*markEditorSaved\(\): void;/);
    expect(method('markEditorSaved')).toMatch(/this\._resetDirtyState\(\)/);
  });
});

/** A ConfigForm method's source, from its signature up to the next member. */
function formMethod(name: string): string {
  const form = read('controller', 'ConfigForm.ts');
  const start = form.search(new RegExp(`\\n    (public|private) (async )?${name}\\(`));
  if (start < 0) throw new Error(`${name} not found`);
  const next = form.slice(start + 1).search(/\n    (public|private) /);
  const body = next < 0 ? form.slice(start) : form.slice(start, start + 1 + next);
  const doc = body.lastIndexOf('\n    /**');
  return doc > 0 ? body.slice(0, doc) : body;
}

// Duplicate from the form view copied edits that fail validation without marking them; the
// server's create then refused the copy. The form checks them as Save does, before the copy opens.
describe('duplicating from the form view', () => {
  it('validates the form\'s edits like Save, marks the fields, and refuses before writing the editor', () => {
    const body = formMethod('syncEditor');
    const validate = body.search(/this\._validateEdits\(\)/);
    expect(validate).toBeGreaterThan(0);
    expect(body).toMatch(/this\._applyFieldErrors\(errors\)/);
    expect(body).toMatch(/formInvalidBeforeDuplicate/);
    expect(validate).toBeLessThan(body.search(/this\._writeDocumentToEditor\(\)/));
  });
});

// There is no Deactivate action: a configuration stops being active only when another one is
// activated (or by Rollback). The messages about an active configuration said otherwise.
describe('messages about an active configuration', () => {
  const bundles = fs.readdirSync(webapp('i18n')).filter(f => /^i18n(_\w+)?\.properties$/.test(f));
  const deactivate = /deactiv|deaktiv|desactiv|desactív|désactiv|disattiv|desativ/i;

  it.each(['formActiveReadOnly', 'cannotSaveActive', 'deleteActiveForbidden'])('%s names no Deactivate action in any language', (key) => {
    expect(bundles).toHaveLength(8);
    for (const file of bundles) {
      const line = read('i18n', file).split(/\r?\n/).find(l => l.startsWith(key + '='));
      expect([file, line !== undefined && !deactivate.test(line)]).toEqual([file, true]);
    }
  });
});

describe('the master list and the fields the detail title binds', () => {
  it('selects description and modifiedBy itself, so no shell or model setup can leave them out', () => {
    const table = tags(view()).find(t => !t.closing && t.name === 'Table' && /\sid="configTable"/.test(t.attributes));
    expect(table?.attributes).toMatch(/\$select:\s*'description,modifiedBy'/);
  });

  it('shows the list\'s "by <user>" only when there is a user', () => {
    const cell = tags(view()).find(t => !t.closing && t.name === 'Text' && /byUser/.test(t.attributes));
    expect(cell?.attributes).toMatch(/visible="\{= !!\$\{path:'modifiedBy'/);
  });

  it('formats the title\'s modification line without "by" when nobody modified the row', () => {
    const source = read('controller', 'Main.controller.ts');
    expect(source).toMatch(/formatModifiedAtBy[\s\S]*?return user \? formatMessage\(pattern, \[when, user\]\) : when;/);
  });
});

// The server recomputes a saved configuration's checksum and validation result and refuses an
// invalid document or a change to the active configuration (400). Structural guards only: this
// jest cannot load sap/*.
describe('saving the open configuration', () => {
  it('reports the save from the PATCH\'s own outcome, not from submitBatch alone', () => {
    const body = method('_updateContextProperty');
    expect(body).toMatch(/patched = context\.setProperty\("configData", configData\)/);
    expect(body).toMatch(/Promise\.all\(\[patched, oModel\.submitBatch\(/);
  });

  it('reads the title\'s validation messages again after a successful save', () => {
    expect(method('_updateContextProperty')).toMatch(/configSaved[\s\S]*_refreshValidationMessages\(configId\)[\s\S]*\.catch\(/);
    const refresh = method('_refreshValidationMessages');
    expect(refresh).toMatch(/\/selectedValidationMessages/);
    expect(refresh).toMatch(/storedValidationMessages\(/);
    expect(refresh).toMatch(/_detailLoad\.isCurrent\(shownLoad\)/);
  });
});
