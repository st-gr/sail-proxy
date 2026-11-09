import Ajv from 'ajv';
import apiConfigSchema from '../webapp/model/apiConfigSchema';
import { ApiConfigGroup, groupSections } from '../webapp/model/apiConfigGroups';
import { evaluateApiConfigDocument } from '../webapp/model/documentGate';
import { buildDescriptors, Descriptor } from '../webapp/model/schemaForm';
import { fieldErrorOf } from '../webapp/model/validateSection';
import { formatSchemaError } from '../../../src/srv/schemaErrors';

const shippedConfig = require('../../../api_config.json');

const clone = (value: unknown): any => JSON.parse(JSON.stringify(value));

describe('evaluateApiConfigDocument (the whole-document gate)', () => {
    it('enables for the shipped configuration, valid across every group', () => {
        const result = evaluateApiConfigDocument(apiConfigSchema, shippedConfig);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
    });

    it('disables for a document whose platform.timeouts.default is the wrong type, naming that pointer', () => {
        // platformGroup carries no $ref of its own - this is the case a naive fix that only
        // resolves the *group's* own top-level $ref, and nothing deeper, would still catch. It is
        // the baseline proof that group resolution works at all.
        const broken = clone(shippedConfig);
        broken.api_config.platform.timeouts.default = 'not-a-number';

        const result = evaluateApiConfigDocument(apiConfigSchema, broken);

        expect(result.valid).toBe(false);
        expect(result.errors.some(message => message.includes("/api_config/platform/timeouts/default"))).toBe(true);
    });

    it('disables for a document shaped like the pre-restructure flat api_config (20 top-level sections)', () => {
        // Before `694ca48` (refactor(config): flip api_config.json and the gateway to the
        // six-group shape), api_config.json's own top-level carried ~20 sections
        // (timeouts, siem, anthropic, hookDefinitions, ...) directly, not nested under the six
        // groups this schema now declares. None of those names are one of the six groups, so
        // api_config's own `additionalProperties: false` must reject every one of them.
        const oldFlatShape = {
            api_config: {
                timeouts: { default: 600000, streaming: 600000 },
                siem: { enabled: false },
                anthropic: { anthropic_bedrock_version: 'bedrock-2023-05-31' },
                hookDefinitions: {},
                defaultHooks: {}
            }
        };

        const result = evaluateApiConfigDocument(apiConfigSchema, oldFlatShape);

        expect(result.valid).toBe(false);
        expect(result.errors.every(message => message.includes("/api_config"))).toBe(true);
        // Four unrecognized keys (siem, anthropic, hookDefinitions, defaultHooks - "timeouts" is
        // also unrecognized, api_config's own group is "platform") must each be named in their own
        // message, not just four identical "additional properties" strings with no way to tell
        // which key any one of them is about.
        for (const key of ['timeouts', 'siem', 'anthropic', 'hookDefinitions', 'defaultHooks']) {
            expect(result.errors.some(message => message.includes(`'${key}'`))).toBe(true);
        }
    });

    it('is fine with a document that has no api_config yet - nothing to represent', () => {
        expect(evaluateApiConfigDocument(apiConfigSchema, {})).toEqual({ valid: true, errors: [] });
    });

    it('is fine with a document missing some groups entirely - every group is optional', () => {
        const partial = { api_config: { platform: shippedConfig.api_config.platform } };
        expect(evaluateApiConfigDocument(apiConfigSchema, partial)).toEqual({ valid: true, errors: [] });
    });

    it('rejects a document that is not an object', () => {
        expect(evaluateApiConfigDocument(apiConfigSchema, 'not an object').valid).toBe(false);
        expect(evaluateApiConfigDocument(apiConfigSchema, null).valid).toBe(false);
        expect(evaluateApiConfigDocument(apiConfigSchema, [1, 2, 3]).valid).toBe(false);
    });

    it('rejects a document whose api_config is not an object', () => {
        const result = evaluateApiConfigDocument(apiConfigSchema, { api_config: 'nope' });
        expect(result.valid).toBe(false);
        expect(result.errors.some(message => message.includes("/api_config"))).toBe(true);
    });

    // The other groups are not siem-shaped, and several nest a $ref inside `properties` rather
    // than only at the group's own top level (observability.pseudonymization -> $defs/pseudonymizationConfig).
    // A gate that only resolved the group's own outer $ref and nothing nested inside it would
    // silently accept this.
    it('catches an invalid observability.pseudonymization, nested one level past the group ref', () => {
        const broken = clone(shippedConfig);
        broken.api_config.observability.pseudonymization.enabled = 'yes';

        const result = evaluateApiConfigDocument(apiConfigSchema, broken);

        expect(result.valid).toBe(false);
        expect(result.errors.some(message => message.includes("/api_config/observability/pseudonymization/enabled"))).toBe(true);
    });

    // providers.openai carries the `$defs/providerCommon` $ref inside an `allOf` branch, not at
    // the property's own top level either.
    it('catches an invalid providers.openai field declared only through the providerCommon $ref', () => {
        const broken = clone(shippedConfig);
        broken.api_config.providers.openai = { supports_prompt_caching: 123 };

        const result = evaluateApiConfigDocument(apiConfigSchema, broken);

        expect(result.valid).toBe(false);
        expect(result.errors.some(message => message.includes("/api_config/providers/openai/supports_prompt_caching"))).toBe(true);
    });

    // The measured fail-open this gate shipped with: `additionalProperties` was read only as the
    // boolean `false`, so a key reached through the *schema* form of it was validated against
    // nothing at all. Every dynamically-keyed map in the document is reached that way, and
    // `providers` is the one this task renders - so a provider entry that is not even an object
    // passed the gate and went on to `buildDescriptors`. Both halves matter: `anthropic` is now
    // named in `providersGroup.properties`, while `mistral` is not and can only be caught by
    // `additionalProperties` itself.
    it('rejects a provider entry that is not an object, named or not', () => {
        const broken = clone(shippedConfig);
        broken.api_config.providers.anthropic = 'not-even-an-object';
        broken.api_config.providers.mistral = 'not-even-an-object';

        const result = evaluateApiConfigDocument(apiConfigSchema, broken);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Schema validation error at '/api_config/providers/anthropic': must be object");
        expect(result.errors).toContain("Schema validation error at '/api_config/providers/mistral': must be object");
    });

    // Same blind spot, one level deeper and in the two other maps it blinded: these keys are
    // matched by neither `properties` nor `patternProperties`, so before this every one of the 24
    // models.overrides entries and 3 hooks.defaults entries was unvalidated.
    it('validates the value of a key declared only by a schema-valued additionalProperties', () => {
        const broken = clone(shippedConfig);
        const someModel = Object.keys(broken.api_config.models.overrides)[0];
        broken.api_config.models.overrides[someModel].supports_responses_api = 'yes';
        const someEndpoint = Object.keys(broken.api_config.hooks.defaults)[0];
        broken.api_config.hooks.defaults[someEndpoint].pseudonymization = { enabled: 'yes' };

        const result = evaluateApiConfigDocument(apiConfigSchema, broken);

        expect(result.valid).toBe(false);
        expect(result.errors.some(message =>
            message.includes(`/api_config/models/overrides/${someModel}/supports_responses_api`))).toBe(true);
        expect(result.errors.some(message =>
            message.includes(`/api_config/hooks/defaults/${someEndpoint}/pseudonymization/enabled`))).toBe(true);
    });

    // A schema-valued `additionalProperties` is where `$defs/providerCommon` and
    // `$defs/modelOverride` are actually reached from, so the deep resolver has to walk into it:
    // left unexpanded, `validateSection` would read a bare `{"$ref": ...}` as an empty schema and
    // accept anything - the same fail-open, moved one step earlier.
    it('resolves a $ref living under a schema-valued additionalProperties', () => {
        const broken = clone(shippedConfig);
        // `perplexity` reaches providerCommon through its own `allOf`; `mistral` - a provider the
        // gateway does not read - reaches the same $ref through providersGroup's own
        // additionalProperties. Both must report the type violation.
        broken.api_config.providers.perplexity.supports_prompt_caching = 'yes';
        broken.api_config.providers.mistral = { supports_prompt_caching: 'yes' };

        const result = evaluateApiConfigDocument(apiConfigSchema, broken);

        expect(result.valid).toBe(false);
        expect(result.errors.some(message =>
            message.includes('/api_config/providers/perplexity/supports_prompt_caching'))).toBe(true);
        expect(result.errors.some(message =>
            message.includes('/api_config/providers/mistral/supports_prompt_caching'))).toBe(true);
    });

    // platform.logging.components and platform.rate_limit_handling's two delay maps are declared
    // with `patternProperties`, not `properties` - a gate that does not read patternProperties
    // would reject the shipped configuration's own component log levels as "additional
    // properties" (see the passing "enables for the shipped configuration" case above, which would
    // fail without this), and would fail to validate a bad value placed there.
    it('validates a patternProperties-declared key s value, not just waves it through', () => {
        const broken = clone(shippedConfig);
        broken.api_config.platform.logging.components.ConfigService = 'NOT_A_LEVEL';

        const result = evaluateApiConfigDocument(apiConfigSchema, broken);

        expect(result.valid).toBe(false);
        expect(result.errors.some(message => message.includes("/api_config/platform/logging/components/ConfigService"))).toBe(true);
    });

    // No `$ref` lives under a `patternProperties` entry in the shipped schema today, so this is
    // synthetic: a schema shaped like a future `$defs/hookDefinition` extraction under
    // `hooks.definitions` (or any other patternProperties-declared map), to prove the walk that
    // resolves it exists and works, not just that today's schema happens not to need it.
    it('resolves a $ref living under patternProperties, not only under properties', () => {
        const syntheticSchema = {
            $defs: {
                level: { type: 'string', enum: ['INFO', 'WARN'] }
            },
            properties: {
                api_config: {
                    type: 'object',
                    properties: {
                        platform: {
                            type: 'object',
                            properties: {
                                levels: {
                                    type: 'object',
                                    patternProperties: {
                                        '^[a-zA-Z0-9_-]+$': { $ref: '#/$defs/level' }
                                    },
                                    additionalProperties: false
                                }
                            },
                            additionalProperties: false
                        }
                    },
                    additionalProperties: false
                }
            }
        };

        const valid = { api_config: { platform: { levels: { foo: 'INFO' } } } };
        const invalid = { api_config: { platform: { levels: { foo: 'NOT_A_LEVEL' } } } };

        expect(evaluateApiConfigDocument(syntheticSchema, valid)).toEqual({ valid: true, errors: [] });

        const result = evaluateApiConfigDocument(syntheticSchema, invalid);
        expect(result.valid).toBe(false);
        expect(result.errors.some(message => message.includes('/api_config/platform/levels/foo'))).toBe(true);
    });

    it('disables for two siem sinks sharing a name, the rule the schema itself cannot express', () => {
        const broken = clone(shippedConfig);
        broken.api_config.observability.siem.sinks[1].name = broken.api_config.observability.siem.sinks[0].name;

        const result = evaluateApiConfigDocument(apiConfigSchema, broken);

        expect(result.valid).toBe(false);
        expect(result.errors.some(message => message.includes("/api_config/observability/siem/sinks/1/name"))).toBe(true);
    });
});

/**
 * `ConfigForm._validateEdits` - the check in front of every save - is this same function, over the
 * whole document, since Task 10. It used to validate `observability.siem` alone, which was right
 * only while `siem` was the only section the form rendered: every section has been editable since
 * the tab shell landed, so an edit on any other tab was sent without the client-side refusal the
 * design promises and came back as a backend rejection naming a pointer rather than as a field
 * marked on screen.
 *
 * These cases are that promise, measured where it can be measured: the error is produced, and the
 * pointer it names is the pointer of a control the form actually renders - which is precisely the
 * condition `_applyFieldErrors` needs to put the message on that control (`fieldErrorOf` parses
 * the pointer, `_fieldControls` is keyed by it). `ConfigForm` itself imports `sap/*` and cannot be
 * loaded here; the marking is verified in the container.
 */
describe('the same gate, used as the refusal in front of a save', () => {
    /** Every pointer `buildDescriptors` emits for a section, container pointers included. */
    const pointersOf = (descriptors: Descriptor[]): string[] =>
        descriptors.reduce<string[]>((all, descriptor) => all
            .concat([descriptor.pointer])
            .concat(descriptor.kind === 'section' ? pointersOf(descriptor.children) : []), []);

    /** The pointers the form renders a control at for one section, exactly as the tab shell builds it. */
    const renderedPointers = (group: ApiConfigGroup, key: string, data: unknown): string[] => {
        const section = groupSections(apiConfigSchema, group).filter(candidate => candidate.key === key)[0];
        return pointersOf(buildDescriptors(section.schema, data, section.pointer, () => undefined));
    };

    it('refuses a platform.timeouts value below the schema\'s own minimum, at a pointer the form renders', () => {
        const broken = clone(shippedConfig);
        // 500ms: an integer of the right type, so this is the bound - not the type - being checked,
        // and it is a value the StepInput's own min would have stopped had it been typed rather
        // than pasted through the JSON editor.
        broken.api_config.platform.timeouts.default = 500;

        const errors = evaluateApiConfigDocument(apiConfigSchema, broken).errors;
        const field = errors.map(fieldErrorOf).filter(Boolean)
            .filter(error => error!.pointer === '/api_config/platform/timeouts/default')[0];

        expect(field).toBeDefined();
        expect(field!.reason).toContain('>= 1000');
        expect(renderedPointers('platform', 'timeouts', broken.api_config.platform.timeouts))
            .toContain('/api_config/platform/timeouts/default');
    });

    it('refuses a providers field that does not match its pattern, at a pointer the form renders', () => {
        const broken = clone(shippedConfig);
        broken.api_config.providers.anthropic.anthropic_bedrock_version = 'not-a-version';

        const errors = evaluateApiConfigDocument(apiConfigSchema, broken).errors;
        const field = errors.map(fieldErrorOf).filter(Boolean)
            .filter(error => error!.pointer === '/api_config/providers/anthropic/anthropic_bedrock_version')[0];

        expect(field).toBeDefined();
        expect(field!.missing).toBe(false);
        expect(renderedPointers('providers', 'anthropic', broken.api_config.providers.anthropic))
            .toContain('/api_config/providers/anthropic/anthropic_bedrock_version');
    });

    it('still refuses the siem cases the siem-only check refused, and no others on a good document', () => {
        // Unchanged behaviour, both ways round: what was refused before is still refused ...
        const broken = clone(shippedConfig);
        delete broken.api_config.observability.siem.sinks[0].name;
        const missing = evaluateApiConfigDocument(apiConfigSchema, broken).errors
            .map(fieldErrorOf).filter(Boolean)
            .filter(error => error!.pointer === '/api_config/observability/siem/sinks/0/name')[0];
        expect(missing).toBeDefined();
        expect(missing!.missing).toBe(true);

        // ... and the shipped configuration, which the siem-only check passed, still passes. A
        // whole-document check that refused a document the form can already open would make the
        // form unusable, since the gate that opened it is this same function.
        expect(evaluateApiConfigDocument(apiConfigSchema, shippedConfig).errors).toEqual([]);
    });
});

/**
 * The one schema annotation this plan adds: `"default": "INFO"` on the value of
 * `platform.logging.components`, so a component override added through the form's [+] seeds at INFO
 * rather than at TRACE (the enum's first member - see `scalarSeed` in `schemaForm.ts`).
 *
 * `default` is an annotation, not an assertion: draft-07 gives it no validation meaning, and the
 * backend compiles this schema with Ajv WITHOUT `useDefaults`, so nothing anywhere fills a missing
 * value in from it. This proves that rather than asserting it - the verdict of the gate, which is
 * the same function the backend's own check mirrors, is compared with and without the annotation
 * over a probe set that reaches that node from every direction.
 */
describe('the "default": "INFO" annotation on platform.logging.components', () => {
    /** The same schema with that one annotation removed - what shipped before this plan. */
    const withoutDefault = (): any => {
        const stripped = clone(apiConfigSchema);
        delete stripped.$defs.platformGroup.properties.logging.properties.components
            .patternProperties['^[a-zA-Z0-9_-]+$'].default;
        return stripped;
    };

    const withComponents = (components: unknown): any => {
        const document = clone(shippedConfig);
        document.api_config.platform.logging.components = components;
        return document;
    };

    it('is present in the schema the form reads, on that value and nowhere else in logging', () => {
        const logging = (apiConfigSchema as any).$defs.platformGroup.properties.logging.properties;
        expect(logging.components.patternProperties['^[a-zA-Z0-9_-]+$'].default).toBe('INFO');
        // Not on `defaultLevel`: that field is the gateway's own fallback level and the operator
        // chooses it. Only the per-component override needed a seed.
        expect(logging.defaultLevel.default).toBeUndefined();
    });

    it('changes no verdict, on any document that reaches that node', () => {
        const probes: Array<[string, unknown]> = [
            ['the shipped configuration', shippedConfig],
            ['components absent entirely', (() => {
                const document = clone(shippedConfig);
                delete document.api_config.platform.logging.components;
                return document;
            })()],
            ['components present and empty', withComponents({})],
            ['one component at each level', withComponents({
                A: 'TRACE', B: 'DEBUG', C: 'INFO', D: 'WARN', E: 'ERROR'
            })],
            ['a component at a level the enum does not carry', withComponents({ A: 'VERBOSE' })],
            ['a component whose value is not a string', withComponents({ A: 3 })],
            ['a component key the pattern rejects', withComponents({ 'has space': 'INFO' })]
        ];

        for (const [what, document] of probes) {
            const before = evaluateApiConfigDocument(withoutDefault(), document);
            const after = evaluateApiConfigDocument(apiConfigSchema, document);
            expect([what, after]).toEqual([what, before]);
        }
    });

    it('in particular does not fill a missing value in: an absent component stays absent', () => {
        // `useDefaults` would have written INFO into the document being validated. Ajv is compiled
        // without it, and this is the assertion that would catch a future `useDefaults: true`.
        const document = withComponents({});
        evaluateApiConfigDocument(apiConfigSchema, document);
        expect(document.api_config.platform.logging.components).toEqual({});
    });
});

/**
 * The provider split closed each of the six named providers to the settings its own code path
 * reads, and closed the five composing ones with `propertyNames` - a keyword `validateSection` did not implement
 * before this round, and an unimplemented keyword there fails OPEN while the backend's Ajv still
 * enforces it on save. That is exactly the browser/backend disagreement the gate exists to
 * prevent, so the agreement is measured here rather than asserted: the same document, through this
 * gate and through an Ajv compiled the way `src/srv/config-service.ts:14` compiles it.
 */
describe('the closed providers: this gate and the backend Ajv agree', () => {
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const ajvValidate = ajv.compile(apiConfigSchema as object);

    const agreeOn = (what: string, document: unknown): boolean => {
        const ajvValid = ajvValidate(clone(document));
        const gate = evaluateApiConfigDocument(apiConfigSchema, clone(document));
        expect([what, gate.valid]).toEqual([what, ajvValid]);
        return ajvValid;
    };

    it('rejects an anthropic_bedrock_version under openai - in both, and with the same message', () => {
        const broken = clone(shippedConfig);
        broken.api_config.providers.openai.anthropic_bedrock_version = 'bedrock-2023-05-31';

        expect(agreeOn('anthropic_bedrock_version under openai', broken)).toBe(false);

        // Not merely the same verdict: the same sentence. Ajv reports this as two errors against
        // the provider OBJECT, saying only "must be equal to one of the allowed values" - which
        // names neither the key nor the allowed set and reads like a complaint about a value. Both
        // sides rewrite it, and if only one of them did, an operator would be told two different
        // things about one document depending on which check ran.
        ajvValidate(clone(broken));
        const backend = (ajvValidate.errors || []).map(formatSchemaError).filter(m => m !== null);
        const gate = evaluateApiConfigDocument(apiConfigSchema, broken).errors;

        expect(backend).toEqual([
            "Schema validation error at '/api_config/providers/openai/anthropic_bedrock_version': " +
            'property "anthropic_bedrock_version" is not one of the settings this provider reads ' +
            '(allowed: emulate_streaming_for_models, substitute_models, unsupported_params, ' +
            'param_renames, supports_responses_api, supports_prompt_caching, ' +
            'openai_deployment_api_version)'
        ]);
        expect(gate).toEqual(backend);
    });

    // The pointer is the whole point of the rewrite: one segment deeper than Ajv's, at the key
    // itself, because that is where the form renders a control for it. An undeclared key does get a
    // descriptor - a `raw` one, carrying the value the schema cannot type - so the message has
    // somewhere to land. Pointed at the provider instead, it would have marked the panel and left
    // the operator to find the offending setting inside it.
    it('marks the control the offending key is shown in, not the provider panel', () => {
        const broken = clone(shippedConfig);
        broken.api_config.providers.openai.anthropic_bedrock_version = 'bedrock-2023-05-31';
        const target = '/api_config/providers/openai/anthropic_bedrock_version';

        const field = evaluateApiConfigDocument(apiConfigSchema, broken).errors
            .map(fieldErrorOf).filter(Boolean)
            .filter(error => error!.pointer === target)[0];
        expect(field).toBeDefined();
        expect(field!.missing).toBe(false);
        expect(field!.reason).toContain('is not one of the settings this provider reads');

        const section = groupSections(apiConfigSchema, 'providers').filter(s => s.key === 'openai')[0];
        const rendered = buildDescriptors(
            section.schema, broken.api_config.providers.openai, section.pointer, () => undefined
        );
        const raw = rendered.filter(d => d.pointer === target)[0];
        expect(raw).toBeDefined();
        expect(raw.kind).toBe('raw');
    });

    it('agrees on every other placement of the Anthropic-only fields, accepted and rejected alike', () => {
        const withField = (provider: string, field: string, value: unknown) => {
            const document = clone(shippedConfig);
            document.api_config.providers[provider][field] = value;
            return document;
        };
        const fields: Array<[string, unknown]> = [
            ['anthropic_bedrock_version', 'bedrock-2023-05-31'],
            ['excluded_beta_headers', ['some-beta']],
            ['supported_beta_headers', ['some-beta']]
        ];

        for (const [field, value] of fields) {
            // Declared here: accepted by both.
            expect(agreeOn(`${field} on anthropic`, withField('anthropic', field, value))).toBe(true);
            expect(agreeOn(`${field} on aws-bedrock`, withField('aws-bedrock', field, value))).toBe(true);
            // Read by nothing here: rejected by both.
            for (const provider of ['openai', 'openrouter', 'perplexity']) {
                expect(agreeOn(`${field} on ${provider}`, withField(provider, field, value))).toBe(false);
            }
        }
    });

    // The other half of the closure decision: `providers` itself stays open, so a provider the
    // gateway does not read yet needs no schema change - and its keys are not judged by any
    // provider's `propertyNames`, because nothing declares one for it.
    it('still accepts a whole provider the gateway does not read, keys and all', () => {
        const document = clone(shippedConfig);
        document.api_config.providers.mistral = {
            substitute_models: [{ from: 'a', to: 'b' }],
            a_key_no_gateway_reads: true
        };
        expect(agreeOn('an undeclared provider', document)).toBe(true);
    });

    it('and the shipped configuration is valid in both, before and after the split', () => {
        expect(agreeOn('the shipped configuration', shippedConfig)).toBe(true);
    });
});

/**
 * `min_confidence` and `thresholds` (spec 2026-08-25-pseudonymization-precision, task 2).
 *
 * Both are numeric and BOUNDED, which is a shape the pseudonymization block did not have
 * before: every other key there is a boolean, an enum or a list of strings. A bound is only
 * worth declaring if both sides enforce it — a browser that accepts 1.5 and a backend that
 * rejects it on save is the disagreement this gate exists to prevent — so the agreement is
 * measured on the same document through both, not asserted.
 */
describe('the confidence thresholds: this gate and the backend Ajv agree', () => {
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const ajvValidate = ajv.compile(apiConfigSchema as object);

    const verdicts = (document: unknown) => {
        const ajvValid = ajvValidate(clone(document));
        const gate = evaluateApiConfigDocument(apiConfigSchema, clone(document));
        return { ajvValid, gate };
    };

    const withPseudonymization = (block: Record<string, unknown>) => {
        const document = clone(shippedConfig);
        document.api_config.observability.pseudonymization = {
            ...document.api_config.observability.pseudonymization,
            ...block,
        };
        return document;
    };

    it('accepts the shipped configuration, which sets neither key', () => {
        const shipped = clone(shippedConfig).api_config.observability.pseudonymization;
        expect(shipped.min_confidence).toBeUndefined();
        expect(shipped.thresholds).toBeUndefined();
        expect(evaluateApiConfigDocument(apiConfigSchema, clone(shippedConfig)).valid).toBe(true);
    });

    it('accepts both keys in range, in both', () => {
        const { ajvValid, gate } = verdicts(withPseudonymization({
            min_confidence: 0.65,
            thresholds: { 'profile-person': 0.7, 'profile-email': 0 },
        }));
        expect(gate.errors).toEqual([]);
        expect([gate.valid, ajvValid]).toEqual([true, true]);
    });

    it('rejects min_confidence: 1.5 in both, and names that pointer', () => {
        const { ajvValid, gate } = verdicts(withPseudonymization({ min_confidence: 1.5 }));
        expect([gate.valid, ajvValid]).toEqual([false, false]);
        expect(gate.errors.some(message =>
            message.includes('/api_config/observability/pseudonymization/min_confidence'))).toBe(true);
    });

    it('rejects a negative min_confidence and a non-numeric one in both', () => {
        for (const value of [-0.1, 'high', null]) {
            const { ajvValid, gate } = verdicts(withPseudonymization({ min_confidence: value }));
            expect([String(value), gate.valid, ajvValid]).toEqual([String(value), false, false]);
        }
    });

    it('rejects an out-of-range per-category threshold in both', () => {
        const { ajvValid, gate } = verdicts(withPseudonymization({
            thresholds: { 'profile-person': 1.5 },
        }));
        expect([gate.valid, ajvValid]).toEqual([false, false]);
    });

    it('rejects a threshold key that is not a known category in both', () => {
        const { ajvValid, gate } = verdicts(withPseudonymization({
            thresholds: { 'profile-not-a-category': 0.5 },
        }));
        expect([gate.valid, ajvValid]).toEqual([false, false]);
    });

    it('accepts both keys in a per-endpoint and a per-model block too', () => {
        const document = clone(shippedConfig);
        document.api_config.hooks.defaults.anthropic.pseudonymization = {
            ...document.api_config.hooks.defaults.anthropic.pseudonymization,
            min_confidence: 0.6,
        };
        document.api_config.models.overrides = {
            ...document.api_config.models.overrides,
            'example--model--deployed': { pseudonymization: { thresholds: { 'profile-person': 0.4 } } },
        };
        const { ajvValid, gate } = verdicts(document);
        expect(gate.errors).toEqual([]);
        expect([gate.valid, ajvValid]).toEqual([true, true]);
    });

    /**
     * `allowlist` and `saturation_warn` (spec 2026-08-25-pseudonymization-precision, task 3).
     *
     * Two more shapes the pseudonymization block did not have: a NESTED object with a closed
     * property set, and a bounded INTEGER. Both are places the two validators could disagree
     * silently - a browser that accepts `allowlist: []` or `saturation_warn: 0.5` and a backend
     * that rejects it on save is exactly the disagreement this gate exists to prevent - so the
     * agreement is measured on the same document through both rather than asserted.
     */
    it('accepts an allow-list of terms and patterns, and a saturation bar, in both', () => {
        const { ajvValid, gate } = verdicts(withPseudonymization({
            allowlist: { terms: ['Watson Studio'], patterns: ['Z[A-Z0-9_]+'] },
            saturation_warn: 25,
        }));
        expect(gate.errors).toEqual([]);
        expect([gate.valid, ajvValid]).toEqual([true, true]);
    });

    it('accepts either half of the allow-list on its own, and an empty block', () => {
        for (const allowlist of [{ terms: ['A'] }, { patterns: ['A'] }, {}]) {
            const { ajvValid, gate } = verdicts(withPseudonymization({ allowlist }));
            expect([JSON.stringify(allowlist), gate.valid, ajvValid])
                .toEqual([JSON.stringify(allowlist), true, true]);
        }
    });

    it('rejects an allow-list that is a list rather than an object, in both', () => {
        // The shape an operator reaches for first, and the one the older `allow_list` key has.
        const { ajvValid, gate } = verdicts(withPseudonymization({ allowlist: ['Watson Studio'] }));
        expect([gate.valid, ajvValid]).toEqual([false, false]);
        expect(gate.errors.some(message =>
            message.includes('/api_config/observability/pseudonymization/allowlist'))).toBe(true);
    });

    it('rejects a key the allow-list does not declare, and a non-string entry, in both', () => {
        for (const allowlist of [{ regexes: ['A'] }, { terms: [1] }, { patterns: [null] }]) {
            const { ajvValid, gate } = verdicts(withPseudonymization({ allowlist }));
            expect([JSON.stringify(allowlist), gate.valid, ajvValid])
                .toEqual([JSON.stringify(allowlist), false, false]);
        }
    });

    it('rejects a saturation bar that is not a whole number of at least 1, in both', () => {
        for (const value of [0, -1, 0.5, '40', null]) {
            const { ajvValid, gate } = verdicts(withPseudonymization({ saturation_warn: value }));
            expect([String(value), gate.valid, ajvValid]).toEqual([String(value), false, false]);
        }
    });

    it('accepts both keys in a per-endpoint and a per-model block too', () => {
        const document = clone(shippedConfig);
        document.api_config.hooks.defaults.anthropic.pseudonymization = {
            ...document.api_config.hooks.defaults.anthropic.pseudonymization,
            allowlist: { terms: ['Watson Studio'] },
        };
        document.api_config.models.overrides = {
            ...document.api_config.models.overrides,
            'example--model--deployed': { pseudonymization: { saturation_warn: 200 } },
        };
        const { ajvValid, gate } = verdicts(document);
        expect(gate.errors).toEqual([]);
        expect([gate.valid, ajvValid]).toEqual([true, true]);
    });

    it('and the shipped configuration still sets neither', () => {
        const shipped = clone(shippedConfig).api_config.observability.pseudonymization;
        expect(shipped.allowlist).toBeUndefined();
        expect(shipped.saturation_warn).toBeUndefined();
    });
});
