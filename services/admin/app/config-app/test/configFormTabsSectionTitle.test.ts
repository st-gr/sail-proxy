/**
 * The REAL `ConfigFormTabs.buildSectionPanel` header: with no bundle text for a section, the panel
 * header falls back to the schema's `title` before the label derived from the key - the same rule a
 * field label follows. `schemaTexts.test.ts` mirrors that expression; this pins the controller itself.
 *
 * The controller imports UI5 controls, whose types are not installed for jest, so its source is
 * transpiled here without a type check and run with stand-ins: the UI5 controls record their
 * settings, the descriptor controls and the credential exit build nothing. Every model module it
 * imports is the real one.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import apiConfigSchema from '../webapp/model/apiConfigSchema';

const CONTROLLER = path.join(__dirname, '..', 'webapp', 'controller', 'ConfigFormTabs.ts');

function recordingControl(record?: Array<Record<string, any>>) {
  return {
    __esModule: true,
    default: class {
      constructor(public settings: Record<string, any>) { record?.push(settings); }
      addEventDelegate(): void { /* rendering is not under test */ }
    }
  };
}

/** The controller module, with UI5 and the two control builders replaced. */
function loadController(panels: Array<Record<string, any>>): any {
  const stubs: Record<string, unknown> = {
    'sap/m/IconTabBar': recordingControl(),
    'sap/m/IconTabFilter': recordingControl(),
    'sap/m/ScrollContainer': recordingControl(),
    'sap/m/Panel': recordingControl(panels),
    'sap/ui/core/Control': recordingControl(),
    './ConfigFormCredentials': { __esModule: true, default: class {} },
    '../model/descriptorControls': {
      __esModule: true, buildAbsentContent: () => [], buildDescriptorControls: () => [], buildMapContent: () => []
    }
  };
  const source = fs.readFileSync(CONTROLLER, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  });
  const localRequire = (spec: string): unknown => {
    if (spec in stubs) return stubs[spec];
    if (spec.startsWith('.')) return require(path.resolve(path.dirname(CONTROLLER), spec));
    return require(spec);
  };
  const module = { exports: {} as any };
  // eslint-disable-next-line no-new-func
  new Function('require', 'exports', 'module', outputText)(localRequire, module.exports, module);
  return module.exports;
}

describe('ConfigFormTabs.buildSectionPanel header', () => {
  function headers(text: (key: string) => string): string[] {
    const panels: Array<Record<string, any>> = [];
    loadController(panels).buildTabs({
      document: { api_config: {} },
      schema: apiConfigSchema as unknown as Record<string, unknown>,
      editable: false,
      resolvePlugin: () => undefined,
      onChange: () => undefined,
      text,
      credentialSection: {},
      configurationId: null,
      isAdmin: true
    });
    return panels.map((p) => p.headerText);
  }

  it('falls back to the schema title for platform/toolGovernance when the bundle has no text', () => {
    const shown = headers((key) => key);
    expect(shown).toContain('Tool Governance');
    expect(shown).not.toContain('ToolGovernance');
  });

  it('shows the bundle text when there is one', () => {
    const shown = headers((key) => (key === 'schema.platform.toolGovernance.label' ? 'Tool-Nutzung' : key));
    expect(shown).toContain('Tool-Nutzung');
    expect(shown).not.toContain('Tool Governance');
  });
});
