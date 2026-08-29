import ResourceBundle from "sap/base/i18n/ResourceBundle";
import Dialog from "sap/m/Dialog";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Panel from "sap/m/Panel";
import VBox from "sap/m/VBox";
import DynamicPage from "sap/f/DynamicPage";
import CodeEditor from "sap/ui/codeeditor/CodeEditor";
import Component from "sap/ui/core/Component";
import Control from "sap/ui/core/Control";
import UI5Element from "sap/ui/core/Element";
import Model from "sap/ui/model/Model";
import View from "sap/ui/core/mvc/View";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import ResourceModel from "sap/ui/model/resource/ResourceModel";
import apiConfigSchema, { siemSchemaDef } from "../model/apiConfigSchema";
import {
    AddRequest,
    MapSpec,
    RemoveRequest,
    ancestorEntryPointers,
    containerPointerOf,
    interpolate,
    lastSegmentOf,
    mapEntryPointer,
    mapSpecOf,
    newArrayElement,
    sectionSeed,
    withArrayElement
} from "../model/formContainers";
import { FieldControl, scrollControlIntoTabView } from "../model/descriptorControls";
import { ScrollAncestorNode, tabScrollAncestor } from "../model/formViewport";
import { evaluateApiConfigDocument } from "../model/documentGate";
import { pluginFor, registerPlugin } from "../model/formPlugins";
import { applyDescriptor, removeAt } from "../model/schemaForm";
import { fieldErrorOf } from "../model/validateSection";
import CredentialSection from "./ConfigFormCredentials";
import MapEditor from "./ConfigFormMaps";
import { attachTabSelection, buildTabs } from "./ConfigFormTabs";
import SinkEditor, { sinkTypes } from "./ConfigFormSinks";

/** JSON pointer of the section this form renders. */
const SIEM_POINTER = "/api_config/observability/siem";

/** JSON pointer of the sink array, the one array this form can add to and remove from. */
const SINKS_POINTER = SIEM_POINTER + "/sinks";

/** Every `*_env` property of a sink names a credential slot and must never be a text input. */
const CREDENTIAL_PATTERN = "/api_config/observability/siem/sinks/*/*_env";

/**
 * How long to keep reading a configuration back after a save before calling it not persisted.
 * Cumulative ~5s; a save that landed usually answers on the first or second read.
 */
const SAVE_POLL_DELAYS_MS = [150, 250, 400, 600, 900, 1200, 1500];

/**
 * A key-order-independent serialisation, used to compare what was sent with what came back.
 * Whether the service stores the string verbatim or re-serialises it is not this form's
 * business; whether the same data is in there is.
 */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return "[" + value.map(canonicalJson).join(",") + "]";
    }
    if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        return "{" + Object.keys(source).sort()
            .map(key => JSON.stringify(key) + ":" + canonicalJson(source[key]))
            .join(",") + "}";
    }
    return JSON.stringify(value) ?? "null";
}

/** A JSON object, as opposed to an array, null, or a scalar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * What this form needs from the controller that hosts it. Declared structurally so ConfigForm
 * does not import MainController (which imports ConfigForm) and so the one existing method it
 * calls into - the unchanged save path - is explicit rather than reached through `any`.
 */
export interface ConfigFormHost {
    getView(): View | undefined;
    getOwnerComponent(): Component | undefined;
    byId(id: string): UI5Element | undefined;
    onSaveConfiguration(): void;
}

/**
 * The form view of a configuration's `siem` section: a schema-driven set of controls rendered
 * beside the JSON editor, toggled from the detail page's title bar.
 *
 * It owns three things the rest of the controller does not: the gate (a document that fails Ajv
 * validation cannot be represented faithfully, so the toggle is disabled), the two independent
 * read-only gates from the design (inactive AND admin to edit JSON-backed fields; admin alone for
 * credential rotation), and resetting itself on every selection - nothing else clears it.
 *
 * It writes back through the existing save path (`onSaveConfiguration`) and never saves directly.
 */
export default class ConfigForm {

    private _host: ConfigFormHost;
    private _bundle: ResourceBundle | null = null;
    private _configId: string | null = null;
    /** Parsed configData of the selected configuration. Edits are applied to this copy. */
    private _document: Record<string, unknown> | null = null;
    private _credentials: CredentialSection;
    private _sinks: SinkEditor;
    private _maps: MapEditor;
    /** Guards against a slow response for a configuration the user has already navigated away from. */
    private _selectionToken = 0;
    /** Resolves once the user's role is known; the gate depends on it and must not race it. */
    private _rolePromise: Promise<void> | null = null;
    /**
     * The document as it stood when the form was last opened or saved. Anything else means the
     * form holds edits that are not in the database yet, which decides whether leaving the form
     * has to ask first - see onViewModeChange.
     */
    private _documentBaseline: string | null = null;
    /** True while a save is in flight, so a second Save cannot start one beside it. */
    private _saveInFlight = false;
    /**
     * The control rendering each field, by JSON pointer. Rebuilt on every render, because the
     * controls are: this is how a schema error is put on the field it is about.
     */
    private _fieldControls: Record<string, FieldControl> = {};
    /** Pointers this form has put an error on, so it never clears a state it did not set. */
    private _markedFields: string[] = [];
    /**
     * True once a save has been refused for a schema error. From then on every edit re-checks, so
     * a corrected field clears itself; without that the form is unusable after one mistake.
     */
    private _showFieldErrors = false;
    /**
     * The pointers of the map entry panels currently expanded, remembered across the rebuild every
     * edit triggers so an override the operator opened does not snap shut the moment they add a
     * section inside it - the whole of this defect. A pointer here means "known expanded"; a pointer
     * ABSENT means the form has no decision for it and the entry follows its map's collapse default,
     * which is what keeps a fresh entry of a small map open and a fresh entry of a >3 map closed. Per
     * configuration - cleared when the selection changes (`_clearContent`).
     */
    private _expandedEntries = new Set<string>();
    /**
     * Every container panel of the LAST build, by its own pointer, and the pointers of the maps that
     * build rendered. Rebuilt on every `_render` (the controls are), and read straight after to
     * reveal what an add just created - expand its ancestor entries, open it, scroll to it.
     */
    private _panelsByPointer = new Map<string, Panel>();
    private _mapNodePointers = new Set<string>();

    constructor(host: ConfigFormHost) {
        this._host = host;
        this._credentials = new CredentialSection({
            text: (key: string) => this._text(key),
            callAction: (path: string, parameters: Record<string, unknown>) => this._callAction(path, parameters),
            addDependent: (dialog: Dialog) => this._view()?.addDependent(dialog),
            onChanged: () => {
                if (this._getProperty("/formViewActive") === true) {
                    this._render();
                }
            }
        });
        this._sinks = new SinkEditor({
            text: (key: string) => this._text(key),
            addDependent: (dialog: Dialog) => this._view()?.addDependent(dialog),
            readSinks: () => this._readSinks(),
            writeSinks: (sinks, messageKey, subject) => this._writeSinks(sinks, messageKey, subject),
            storedSlots: () => this._credentials.storedSlotNames()
        }, sinkTypes(siemSchemaDef), siemSchemaDef);
        this._maps = new MapEditor({
            text: (key: string) => this._text(key),
            addDependent: (dialog: Dialog) => this._view()?.addDependent(dialog),
            readKeys: (pointer: string) => this._readMapKeys(pointer),
            addEntry: (spec, key, value) => this._addMapEntry(spec, key, value),
            removeEntry: (spec, key) => this._removeMapEntry(spec, key)
        });
        // Registered once, before any buildDescriptors call, so a *_env slot can never be
        // resolved as a plain text field.
        registerPlugin(CREDENTIAL_PATTERN, "credential");
    }

    /** Resolves the i18n bundle and the user's role. Never throws; the role defaults to false. */
    public init(): void {
        // Reloading or closing the tab is the one route out of the form the app cannot intercept
        // itself. The browser's own prompt is the only way to ask there, and it is asked for the
        // same condition every other route uses.
        window.addEventListener("beforeunload", (event: BeforeUnloadEvent) => {
            if (this._isFormDirty()) {
                event.preventDefault();
                event.returnValue = "";
            }
        });

        const resourceModel = this._model("i18n") as ResourceModel;
        if (resourceModel) {
            Promise.resolve(resourceModel.getResourceBundle())
                .then((bundle: ResourceBundle) => {
                    this._bundle = bundle;
                })
                .catch(() => {
                    this._bundle = null;
                });
        }

        this._rolePromise = this._callAction("/whoami(...)", {})
            .then((result: Record<string, unknown> | null) => {
                this._setProperty("/isAdmin", result?.isAdmin === true);
                this._recomputeEditable();
            })
            .catch((error: Error) => {
                // Role resolution failed -> view-only, per the design's error handling.
                console.warn("ConfigForm: could not resolve the user's role, staying view-only", error);
                this._setProperty("/isAdmin", false);
                this._recomputeEditable();
            });
    }

    /**
     * Called for every selection. Clears the form, returns the detail column to the JSON editor
     * and re-evaluates the gate for the newly selected configuration.
     */
    public onConfigurationSelected(configId: string): void {
        try {
            const token = ++this._selectionToken;
            this._configId = configId;
            this._document = null;
            this._documentBaseline = null;
            this._credentials.reset();

            this._clearContent();
            this._setProperty("/configViewMode", "json");
            this._setProperty("/formViewActive", false);
            this._setProperty("/formNotice", "");
            this._setProperty("/formGateEnabled", false);
            this._setProperty("/formGateReason", this._text("formGateChecking"));
            this._setJsonVisible(true);
            // Editability is decided once the configuration's own isActive is known, below.
            this._setProperty("/formEditable", false);

            void this._loadAndGate(configId, token);
        } catch (error) {
            // Nothing here may break opening a configuration's details.
            console.error("ConfigForm: selection handling failed", error);
        }
    }

    /** Called when the detail column is closed. */
    public reset(): void {
        this._selectionToken++;
        this._configId = null;
        this._document = null;
        this._documentBaseline = null;
        this._credentials.reset();
        this._clearContent();
        this._setProperty("/configViewMode", "json");
        this._setProperty("/formViewActive", false);
        this._setProperty("/formNotice", "");
        this._setProperty("/formGateEnabled", false);
        this._setProperty("/formGateReason", "");
    }

    /** Switches the detail column between the JSON editor and the form. */
    public onViewModeChange(key: string): void {
        if (key !== "form") {
            this._leaveFormView();
            return;
        }

        // The form must render what the JSON editor currently shows, not only what was loaded:
        // otherwise unsaved edits made in the editor would be silently overwritten the moment
        // the form saves its own copy of the document.
        if (!this._adoptEditorDocument()) {
            MessageToast.show(this._text("formEditorUnparsable"));
            this._setProperty("/configViewMode", "json");
            return;
        }

        // Re-check the gate against what the editor now holds: the document may have been
        // edited as JSON into something the form cannot represent faithfully.
        this._evaluateGate();
        if (this._getProperty("/formGateEnabled") !== true) {
            MessageToast.show(this._text("formGateInvalid"));
            this._setProperty("/configViewMode", "json");
            return;
        }

        this._documentBaseline = JSON.stringify(this._document);

        void this._credentials
            .ensureLoaded(this._configId, this._getProperty("/isAdmin") === true)
            .then(() => {
                // The form is built into the detail DynamicPageHeader, whose `visible` is bound to
                // /formViewActive (view/Main.view.xml). While that is false the header is not in the
                // DOM at all - an invisible UI5 control renders no box - so building the form here,
                // BEFORE the header is shown, lays every ColumnLayout out against nothing:
                // sap.ui.layout.form.ColumnLayout measures its own width in `onAfterRendering` and
                // bails the moment the form is not `:visible`, setting no media class, so the labels
                // fall back to the narrow, column-less rendering instead of the wide right-aligned
                // column. It was left to a ResizeObserver to re-measure once the header appeared, and
                // that recovery is not reliable across browsers: a scalar run after an EMPTY map
                // (a Panel with only a toolbar, so nothing below it forced a second layout pass) was
                // the one left narrow, and only adding a map entry put it right - because that is a
                // second _render, by then with the header already visible.
                //
                // So the header is made visible FIRST, and the form is built only once that header
                // is actually on screen (`_renderWhenHeaderVisible`). Every ColumnLayout then measures
                // a real width on its first layout pass and picks its column media deterministically,
                // with no dependence on a later resize. Subsequent rebuilds (Add section / entry,
                // remove, save) already run with the header visible, which is why only this first
                // render needed it.
                this._setProperty("/configViewMode", "form");
                this._setProperty("/formViewActive", true);
                this._setJsonVisible(false);
                this._renderWhenHeaderVisible();
            });
    }

    /**
     * Builds the form, but not before the detail `DynamicPageHeader` that hosts it is on screen.
     *
     * The header's `visible` is bound to /formViewActive, and an invisible UI5 control has no DOM at
     * all - so a `_render` that runs before the header appears lays its `ColumnLayout`s out against
     * nothing and they stay narrow (see `onViewModeChange`). The header's visibility is applied on the
     * next rendering, not synchronously with the property write, so this waits for the header's own
     * `onAfterRendering` and builds the form then - once, the delegate removing itself so a later
     * re-render of the header does not rebuild the form under the operator. If the header is already
     * rendered (its DOM exists), there is nothing to wait for and the form is built at once.
     */
    private _renderWhenHeaderVisible(): void {
        const header = this._host.byId("detailDynamicPageHeader");
        if (!header || header.getDomRef()) {
            this._render();
            return;
        }
        const delegate = {
            onAfterRendering: (): void => {
                header.removeEventDelegate(delegate);
                this._render();
            }
        };
        header.addEventDelegate(delegate);
    }

    /**
     * Leaving the form for the JSON editor.
     *
     * Unsaved form edits may not simply travel into the JSON view: the JSON editor's own Save
     * compares against a baseline captured when the configuration is loaded, so edits made in the
     * form before switching look like "no changes" and are dropped with a
     * message saying nothing needed saving. Rather than reach into that logic, the form settles
     * its own changes first - save them, or discard them - so the JSON view is only ever entered
     * with a document the editor's own dirty tracking can reason about.
     */
    private _leaveFormView(): void {
        if (!this._isFormDirty()) {
            this._showJsonView();
            return;
        }

        this._promptUnsaved("formLeaveMessage", (decision) => {
            if (decision === "save") {
                // save() leaves the form only once the save is confirmed landed; a rejected
                // save puts the toggle back to "form" itself.
                this.save();
            } else if (decision === "discard") {
                this._discardEdits();
                this._showJsonView();
            } else {
                // Cancel: stay in the form, and put the toggle back where it was.
                this._setProperty("/configViewMode", "form");
            }
        });
    }

    /**
     * Asks about pending form edits before a path that would otherwise drop them silently.
     *
     * Selecting another configuration and closing the detail column both discard the form's
     * document, and the controller's own unsaved-changes guard cannot cover them: it fires on
     * the JSON editor's `change` event, which `CodeEditor#setValue` does not raise, so mirroring
     * form edits into the editor never marks it dirty. The form therefore guards those paths
     * itself, with the same Save / Discard / Cancel prompt the toggle uses.
     *
     * Resolves true when it is safe to proceed - nothing pending, saved and confirmed landed,
     * or explicitly discarded - and false to abort the navigation.
     */
    public confirmLeave(): Promise<boolean> {
        if (!this._isFormDirty()) {
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            this._promptUnsaved("formLeaveAwayMessage", (decision) => {
                if (decision === "save") {
                    void this._saveConfirmed().then(resolve);
                } else if (decision === "discard") {
                    this._discardEdits();
                    resolve(true);
                } else {
                    resolve(false);
                }
            });
        });
    }

    /**
     * The table selection was cleared while the detail column stayed open. The toggle is hidden
     * with the selection, so a form left open here is unreachable from the toggle.
     *
     * With nothing selected the existing save path refuses outright (`!this._selectedConfig`),
     * so offering to save would be offering something that cannot work. An untouched form is
     * simply closed. A form holding edits is kept - closing it would be the silent discard this
     * round is here to remove - with a notice saying how to get Save back; Close still asks.
     */
    public onSelectionCleared(): void {
        if (this._getProperty("/formViewActive") !== true) {
            return;
        }
        if (this._isFormDirty()) {
            this._setProperty("/formNotice", this._text("formNoSelection"));
            return;
        }
        this._showJsonView();
    }

    /** The Save / Discard / Cancel prompt, shared by every route out of the form. */
    private _promptUnsaved(messageKey: string, onDecision: (decision: "save" | "discard" | "cancel") => void): void {
        const saveAction = this._text("formLeaveSave");
        const discardAction = this._text("formLeaveDiscard");
        MessageBox.confirm(this._text(messageKey), {
            title: this._text("formLeaveTitle"),
            actions: [saveAction, discardAction, MessageBox.Action.CANCEL],
            emphasizedAction: saveAction,
            onClose: (action: string) => {
                if (action === saveAction) {
                    onDecision("save");
                } else if (action === discardAction) {
                    onDecision("discard");
                } else {
                    onDecision("cancel");
                }
            }
        });
    }

    /**
     * Cancel: abandon the edits and stay in the form, now showing the stored state.
     *
     * The same `_discardEdits` every other route out of the form uses, rather than a second discard
     * path - which also means the form is clean afterwards by the same measure the leave-prompt
     * asks (`_isFormDirty` compares against `_documentBaseline`, which `_discardEdits` restores the
     * document to), so the next navigation does not prompt.
     *
     * It asks first. Discarding is not undoable, and Cancel sits beside Save.
     */
    public cancel(): void {
        if (!this._isFormDirty()) {
            MessageToast.show(this._text("formCancelNothing"));
            return;
        }
        MessageBox.confirm(this._text("formCancelMessage"), {
            title: this._text("formCancelTitle"),
            actions: [this._text("formCancelConfirm"), MessageBox.Action.CANCEL],
            emphasizedAction: MessageBox.Action.CANCEL,
            onClose: (action: string) => {
                if (action !== this._text("formCancelConfirm")) {
                    return;
                }
                this._discardEdits();
                // The controls hold the discarded values until they are built again.
                this._render();
                MessageToast.show(this._text("formCancelDone"));
            }
        });
    }

    /**
     * Drops the pending edits and puts the last known-persisted document back, in the form's
     * copy and in the JSON editor the edits were mirrored into.
     */
    private _discardEdits(): void {
        if (this._documentBaseline === null) {
            return;
        }
        this._document = JSON.parse(this._documentBaseline) as Record<string, unknown>;
        this._writeDocumentToEditor();
        // The edits that were refused are gone, so the marks they earned go with them.
        this._clearFieldErrors();
    }

    /** Shows the JSON editor with the form's document in it, verified. */
    private _showJsonView(): void {
        this._setJsonVisible(true);
        const sync = this._writeDocumentToEditor();
        if (sync !== "ok") {
            MessageBox.error(this._text(sync === "no-editor" ? "formNoEditor" : "formSyncFailed"));
            this._setProperty("/configViewMode", "form");
            return;
        }
        this._setProperty("/configViewMode", "json");
        this._setProperty("/formViewActive", false);
    }

    private _isFormDirty(): boolean {
        return this._documentBaseline !== null && JSON.stringify(this._document) !== this._documentBaseline;
    }

    /**
     * Re-reads the JSON editor's current content into the form's document. Returns false when
     * the editor holds something that is not JSON, in which case the form must not open: it
     * would save a document the user cannot see.
     */
    private _adoptEditorDocument(): boolean {
        const value = this._findEditor()?.getValue();
        if (!value) {
            return true;
        }
        try {
            this._document = JSON.parse(value) as Record<string, unknown>;
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Hands the edited document to the existing save path. The JSON editor stays the single
     * source of truth for saving, so the form writes its result there and verifies it arrived
     * before delegating - a silent mismatch would save stale JSON.
     */
    public save(): void {
        void this._saveConfirmed();
    }

    /**
     * Saves, and does not treat the edit as saved until the stored document says so.
     *
     * The existing save path reports its outcome through toasts and dialogs raised deep inside
     * async callbacks and returns nothing; it can also report success for a batch whose PATCH
     * failed. So the form decides for itself, by reading the configuration back and comparing it
     * with what it sent. Only then does the dirty baseline advance and the column return to the
     * JSON editor. A rejected save leaves the form open, with the edit still in it and still
     * dirty, so no route out of here can lose it silently.
     *
     * Resolves true only when the edit is in the database.
     */
    private async _saveConfirmed(): Promise<boolean> {
        if (!this._document || this._saveInFlight) {
            return false;
        }

        // The cheap check first: an error the page can already see costs no round trip, and the
        // field it belongs to is named on the field itself rather than in a pointer in a dialog.
        const errors = this._validateEdits();
        this._showFieldErrors = errors.length > 0;
        this._applyFieldErrors(errors);
        if (errors.length > 0) {
            MessageBox.error(this._text("formInvalidBeforeSave") + "\n" + errors.join("\n"));
            // Save may have been pressed from the leave prompt, which has already moved the
            // toggle; the form is still what is on screen, so the toggle goes back with it.
            this._setProperty("/configViewMode", "form");
            return false;
        }

        const snapshot = JSON.stringify(this._document);
        const expected = canonicalJson(this._document);
        // The save path reads the editor, so put the form's document there first - verified,
        // because a silent mismatch would save stale JSON. The editor stays hidden: the form
        // may not be left before the outcome is known.
        const sync = this._writeDocumentToEditor();
        if (sync !== "ok") {
            MessageBox.error(this._text(sync === "no-editor" ? "formNoEditor" : "formSyncFailed"));
            this._setProperty("/configViewMode", "form");
            return false;
        }

        this._saveInFlight = true;
        try {
            this._host.onSaveConfiguration();
            const landed = await this._awaitPersisted(expected);
            if (!landed) {
                // The existing path has already said why. This says what it means for the edit.
                MessageBox.error(this._text("formSaveNotPersisted"));
                this._setProperty("/configViewMode", "form");
                return false;
            }
            this._documentBaseline = snapshot;
            this._showJsonView();
            return true;
        } finally {
            this._saveInFlight = false;
        }
    }

    /**
     * Reads the configuration back until it holds the document that was just sent, or until the
     * budget runs out. This is the only evidence the form accepts that a save landed.
     */
    private async _awaitPersisted(expected: string): Promise<boolean> {
        const configId = this._configId;
        if (!configId) {
            return false;
        }
        for (const delay of SAVE_POLL_DELAYS_MS) {
            await new Promise<void>(resolve => setTimeout(resolve, delay));
            if (configId !== this._configId) {
                return false;
            }
            if (await this._readStoredDocument(configId) === expected) {
                return true;
            }
        }
        return false;
    }

    /**
     * The stored configData, normalised the same way `expected` is, or null. A fresh context
     * binding is used on purpose: it carries its own cache, so this is a real read of what the
     * service holds now rather than a replay of what the model was told earlier.
     */
    private async _readStoredDocument(configId: string): Promise<string | null> {
        try {
            const model = this._model() as ODataModel;
            if (!model) {
                return null;
            }
            const context = model.bindContext(`/ApiConfigurations(ID='${configId}')`);
            const full = await context.requestObject() as Record<string, unknown>;
            const configData = full?.configData as string;
            return configData ? canonicalJson(JSON.parse(configData)) : null;
        } catch (error) {
            console.warn("ConfigForm: could not read the configuration back after saving", error);
            return null;
        }
    }

    /**
     * Writes the form's document into the JSON editor and confirms it arrived. The editor is
     * the single source of truth for saving, so this is the one place the two are reconciled.
     */
    private _writeDocumentToEditor(): "ok" | "no-editor" | "mismatch" {
        if (!this._document) {
            return "ok";
        }
        const json = JSON.stringify(this._document, null, 2);
        const editor = this._findEditor();
        if (!editor) {
            return "no-editor";
        }
        if (editor.getValue() === json) {
            return "ok";
        }
        editor.setValue(json);
        return editor.getValue() === json ? "ok" : "mismatch";
    }

    // --- gate ---------------------------------------------------------------

    private async _loadAndGate(configId: string, token: number): Promise<void> {
        try {
            const model = this._model() as ODataModel;
            if (!model) {
                return;
            }
            const context = model.bindContext(`/ApiConfigurations(ID='${configId}')`);
            const full = await context.requestObject() as Record<string, unknown>;
            if (token !== this._selectionToken) {
                return;
            }
            // Both editability and the gate depend on the role, so neither may race it.
            await this._rolePromise;
            if (token !== this._selectionToken) {
                return;
            }
            this._recomputeEditable(full?.isActive === true);

            const configData = full?.configData as string;
            if (!configData) {
                this._gate(false, this._text("formGateNoData"));
                return;
            }

            try {
                this._document = JSON.parse(configData) as Record<string, unknown>;
            } catch (error) {
                this._gate(false, this._text("formGateInvalidJson"));
                return;
            }

            this._evaluateGate();
        } catch (error) {
            if (token === this._selectionToken) {
                this._gate(false, this._text("formGateFailed"));
            }
            console.warn("ConfigForm: gate evaluation failed", error);
        }
    }

    /**
     * Decides whether the document can be saved, by validating every group of `api_config` the
     * document carries against the whole schema the app ships (`apiConfigSchema.ts`), in the
     * browser, for every role.
     *
     * The spec gated on the whole document validating through `validateConfiguration`. That
     * action is admin-only and answers 403 to everyone else, so the only role that could
     * re-check was the one that can already edit, and gating a non-admin on the verdict stored
     * at the last save made the two roles disagree about the same document - failing OPEN for
     * the role that could not re-check. This gate now matches the spec's scope - the whole
     * document, not only `siem` - while keeping the fix: it runs client-side, so both roles see
     * the same verdict, and an admin's save still runs the backend's whole-document check,
     * unchanged.
     *
     * Rendering is unchanged and still `siem`-only: a group other than `siem` can gate the
     * toggle off, but is not yet shown as a form when the gate passes.
     */
    private _evaluateGate(): void {
        const result = evaluateApiConfigDocument(apiConfigSchema, this._document);
        if (result.valid) {
            this._gate(true, this._text("formGateReady"));
        } else {
            this._gate(false, this._text("formGateInvalid") + "\n" + result.errors.join("\n"));
        }
    }

    private _gate(enabled: boolean, reason: string): void {
        this._setProperty("/formGateEnabled", enabled);
        this._setProperty("/formGateReason", reason);
    }

    // --- rendering ----------------------------------------------------------

    /**
     * Renders every group of `api_config` as a tab, `siem` among them at
     * `/api_config/observability/siem` - the pointer it has always had, since `siem` has always
     * lived under `observability` in the schema. See `ConfigFormTabs.buildTabs` for how a
     * section's controls are built; this method owns only what depends on the configuration being
     * edited - the document, the role, the credential exit, the sink add/remove affordances - and
     * the tab selection, which a rebuild (a sink added or removed, a credential changed) must not
     * silently reset.
     */
    private _render(reveal?: string): void {
        const container = this._host.byId("configFormContent") as VBox;
        if (!container || !this._document) {
            return;
        }
        container.destroyItems();
        // The controls the errors were on have just been destroyed; the registry is rebuilt below
        // and the marks re-applied at the end, so nothing points at a destroyed control.
        this._fieldControls = {};
        this._markedFields = [];
        // The panels and map nodes are the JUST-DESTROYED build's; the new build repopulates them
        // below. The expanded set is NOT reset - it is the memory this whole change exists to keep.
        this._panelsByPointer = new Map<string, Panel>();
        this._mapNodePointers = new Set<string>();
        this._setProperty("/formNotice", "");

        const tabBar = buildTabs({
            document: this._document,
            schema: apiConfigSchema,
            editable: this._getProperty("/formEditable") === true,
            resolvePlugin: pluginFor,
            onChange: (pointer: string, value: unknown) => this._applyChange(pointer, value),
            text: (key: string) => this._text(key),
            credentialSection: this._credentials,
            configurationId: this._configId,
            isAdmin: this._getProperty("/isAdmin") === true,
            selectedKey: this._getProperty("/formSelectedTab") as string | undefined,
            // One path, not a dispatch by named pointer. The control that drew the affordance had
            // the descriptor in hand, so the request says what kind of container the pointer is and
            // carries the marker the renderer derived from the schema; nothing here has to know
            // which pointers are maps. The sink array stays the one special case, because its [+]
            // opens a dialog that picks a type and names the sink rather than appending a skeleton.
            onAddItem: (request: AddRequest) => this._addItem(request),
            onRemoveItem: (request: RemoveRequest) => this._removeItem(request),
            onFieldControl: (pointer: string, control: FieldControl) => {
                this._fieldControls[pointer] = control;
            },
            // A map entry opens by what this remembers of it; the entry's own toggle, Expand all /
            // Collapse all, and a reveal all keep that memory current.
            isEntryExpanded: (pointer: string) => this._expandedEntries.has(pointer) ? true : undefined,
            onEntryToggle: (pointer: string, expanded: boolean) => {
                if (expanded) {
                    this._expandedEntries.add(pointer);
                } else {
                    this._expandedEntries.delete(pointer);
                }
            },
            onContainerPanel: (pointer: string, panel: Panel) => {
                this._panelsByPointer.set(pointer, panel);
            },
            onMapContainer: (pointer: string) => {
                this._mapNodePointers.add(pointer);
            }
        });
        attachTabSelection(tabBar, (key: string) => this._setProperty("/formSelectedTab", key));
        container.addItem(tabBar);

        // Adding or removing a sink rebuilds the form; an error the user has not fixed yet must
        // survive that, so it is put back on the newly built controls.
        if (this._showFieldErrors) {
            this._refreshFieldErrors();
        }

        if (reveal) {
            this._revealAfterRender(reveal);
        }
    }

    /**
     * After an add, brings the newly created container into view: opens every map entry on the path
     * to it (so a collapsed override, or one closed by the >3 rule, is open around it), opens the
     * thing itself when it is a panel, and scrolls it to the top of the tab's scrolling region.
     *
     * This touches panel `expanded` state and the scroll position of the tab's own scrolling region
     * only - never the document. The expansions are done synchronously so the fresh build renders in
     * the right state; the scroll waits for that render, because the target's DOM does not exist
     * until the rebuilt tree lays out. Shares the jump list's `scrollControlIntoTabView`, which
     * confines the scroll to the enclosing tab `sap.m.ScrollContainer`.
     */
    private _revealAfterRender(reveal: string): void {
        const ancestors = ancestorEntryPointers(reveal, Array.from(this._mapNodePointers));
        ancestors.forEach(pointer => {
            this._expandedEntries.add(pointer);
            this._panelsByPointer.get(pointer)?.setExpanded(true);
        });

        const target = this._panelsByPointer.get(reveal);
        if (target) {
            // A newly present section is open already; a new map entry of a >3 map would open closed
            // by default - opened here because the operator just created it to fill it in.
            target.setExpanded(true);
            this._scrollPanelIntoView(target);
        } else if (ancestors.length > 0) {
            // The target is not a panel of its own (a scalar map entry, a scalar array element):
            // scroll to the innermost entry that was opened around it.
            const innermost = this._panelsByPointer.get(ancestors[ancestors.length - 1]);
            if (innermost) {
                this._scrollPanelIntoView(innermost);
            }
        }
    }

    /**
     * Scrolls one panel to the top of its tab's scrolling region once it has rendered. The panel is
     * brand new this rebuild, so its `onAfterRendering` fires as part of the build's first layout
     * whether or not `setExpanded` scheduled one; the delegate removes itself so it fires exactly
     * once. The scroll is confined to the enclosing tab `sap.m.ScrollContainer`
     * (`scrollControlIntoTabView`), so the section comes into view within the form while the page
     * and the master list stay put - never `Element.scrollIntoView`, which moved the whole page.
     */
    private _scrollPanelIntoView(panel: Panel): void {
        // The reveal is hung on the tab's own `sap.m.ScrollContainer`, not on the panel. A panel
        // renders before its ScrollContainer ancestor (children first), so a scroll fired from the
        // panel's own `onAfterRendering` reaches `ScrollContainer.scrollToElement` while that freshly
        // rebuilt container's ScrollEnablement has not yet read its DOM - `_$Container` is undefined
        // and it throws. Worse, the throw escapes the render pass, so the ScrollContainer's OWN
        // `onAfterRendering` never runs: `sizeTabScroll` never sizes the region and the wheel/touch
        // wiring is left half-initialised, which is the "cannot scroll to the bottom after adding a
        // section" defect. Hanging the one-shot on the ScrollContainer means it fires after that
        // container's ScrollEnablement is initialised, so the scroll lands and nothing is aborted; the
        // panel, a descendant, is already rendered by then, so `scrollControlIntoTabView` still finds
        // it. If no tab region encloses the panel (which should never happen), the panel is the
        // fallback, preserving the previous behaviour.
        const container = tabScrollAncestor(panel as unknown as ScrollAncestorNode) as unknown as Control | null;
        const host: Control = container ?? panel;
        const delegate = {
            onAfterRendering: () => {
                host.removeEventDelegate(delegate);
                scrollControlIntoTabView(panel);
            }
        };
        host.addEventDelegate(delegate);
    }

    // --- client-side validation ---------------------------------------------

    /**
     * The same check the gate runs, over the WHOLE edited document, before anything is sent.
     *
     * It used to validate `observability.siem` alone, which was right while `siem` was the only
     * section the form rendered. Every section has been editable since the tab shell landed, so an
     * edit on any other tab - a `platform.timeouts` value below the schema's own minimum, a
     * `providers.anthropic` field that does not match its pattern - was sent without the
     * client-side refusal the design promises, and came back as a backend rejection naming a
     * pointer instead of a field marked on screen.
     *
     * `evaluateApiConfigDocument` is the gate's own function, not a second walk of the document:
     * the check that decides whether the form may OPEN and the check that decides whether it may
     * SAVE are now literally the same code over the same schema, so they cannot come to disagree.
     * It expands every `$ref` before validating (see its header - an unexpanded one validates
     * against an empty schema and fails open) and it already folds in `validateSinkNames`, so the
     * duplicate-sink-name rule this method used to add by hand is unchanged and still enforced.
     *
     * The backend's `validateConfiguration` remains the authority on save; what this removes is
     * the round trip for the errors the page can already see, and the silence about which field is
     * at fault - every message keeps the `Schema validation error at '<pointer>'` shape
     * `fieldErrorOf` reads, so an error whose pointer lands on a rendered control still marks it,
     * on whichever tab that control lives.
     */
    private _validateEdits(): string[] {
        return evaluateApiConfigDocument(apiConfigSchema, this._document).errors;
    }

    /** Re-checks and re-marks. Called after every edit once a save has been refused. */
    private _refreshFieldErrors(): void {
        this._applyFieldErrors(this._validateEdits());
    }

    /**
     * Puts each error on the control for the field it names, and takes the state off the fields
     * that are now correct.
     *
     * Only states this form set are cleared. A text field that rejected a value against the
     * schema's own `pattern` sets its own error and never applies the value, so the document
     * looks valid here; clearing indiscriminately would wipe that field's error while the bad
     * text is still in it.
     */
    private _applyFieldErrors(errors: string[]): void {
        const byPointer: Record<string, string> = {};
        errors.forEach(message => {
            const field = fieldErrorOf(message);
            if (!field || !this._fieldControls[field.pointer]) {
                return;
            }
            const text = field.missing ? this._text("formFieldRequired") : field.reason;
            byPointer[field.pointer] = byPointer[field.pointer] ? byPointer[field.pointer] + " " + text : text;
        });

        this._markedFields
            .filter(pointer => !byPointer[pointer])
            .forEach(pointer => {
                const control = this._fieldControls[pointer];
                if (control) {
                    control.setValueState("None");
                    control.setValueStateText("");
                }
            });

        Object.keys(byPointer).forEach(pointer => {
            const control = this._fieldControls[pointer];
            control.setValueState("Error");
            control.setValueStateText(byPointer[pointer]);
        });
        this._markedFields = Object.keys(byPointer);
    }

    /** Drops every error this form has put on a field, and stops re-checking on each edit. */
    private _clearFieldErrors(): void {
        this._showFieldErrors = false;
        this._applyFieldErrors([]);
    }

    /** The sink array of the in-memory document, or empty when it has none. */
    private _readSinks(): Array<Record<string, unknown>> {
        const sinks = this._readPointer(SINKS_POINTER);
        return Array.isArray(sinks) ? sinks as Array<Record<string, unknown>> : [];
    }

    /**
     * Replaces the sink array, then re-renders: the panels are built from the document, so the new
     * one only appears (and the removed one only disappears) once the form is built again.
     */
    private _writeSinks(sinks: Array<Record<string, unknown>>, messageKey: string, subject: string): void {
        if (!this._applyChange(SINKS_POINTER, sinks)) {
            return;
        }
        this._render();
        MessageToast.show(interpolate(this._text(messageKey), subject));
    }

    /**
     * Creates what an affordance asked for: one map entry, one array element, or the container of a
     * section the document does not carry.
     *
     * Every branch ends in exactly one `_applyChange` at exactly one pointer, and every one of those
     * pointers is the container's own - `applyDescriptor` creates the objects between the root and
     * it, so a section three levels below a document that carries none of them is written where it
     * belongs rather than at the root, which is what this whole round is about. The one branch that
     * does not write directly is the sink array's, whose dialog picks a type and names the sink
     * first; it writes through the same `_applyChange` afterwards (`_writeSinks`).
     */
    private _addItem(request: AddRequest): void {
        if (request.kind === "section") {
            if (!this._applyChange(request.pointer, sectionSeed(request))) {
                return;
            }
            // Reveal the section just made present - its ancestor override reopens around it.
            this._render(request.pointer);
            MessageToast.show(this._text("formSectionAdded"));
            return;
        }
        if (request.kind === "array") {
            if (request.pointer === SINKS_POINTER) {
                this._sinks.openAdd();
                return;
            }
            if (!request.arrayItems) {
                return;
            }
            const elements = this._readArray(request.pointer);
            const appended = withArrayElement(elements, newArrayElement(request.arrayItems));
            if (!this._applyChange(request.pointer, appended)) {
                return;
            }
            // The new element's own pointer is the array's pointer and its index, which is the old
            // length - the element was appended.
            this._render(`${request.pointer}/${elements.length}`);
            MessageToast.show(interpolate(this._text("formArrayAdded"), String(elements.length)));
            return;
        }
        if (request.mapEntries) {
            this._maps.openAdd(mapSpecOf(request.pointer, request.mapEntries));
        }
    }

    /** Removes what an affordance asked to remove: one map entry, or one array element by index. */
    private _removeItem(request: RemoveRequest): void {
        if (request.kind === "map") {
            if (!request.mapEntries) {
                return;
            }
            const spec = mapSpecOf(containerPointerOf(request.pointer), request.mapEntries);
            this._maps.confirmRemove(spec, lastSegmentOf(request.pointer));
            return;
        }
        // The sink array keeps its own confirmation: removing a sink also has to say what happens to
        // the credentials stored for its slots, which no other array element has.
        const index = this._sinkIndex(request.pointer);
        if (index !== null) {
            this._sinks.confirmRemove(index);
            return;
        }
        this._confirmRemoveElement(request.pointer);
    }

    /** The keys a map container carries in the in-memory document, in document order. */
    private _readMapKeys(pointer: string): string[] {
        const container = this._readPointer(pointer);
        return isPlainObject(container) ? Object.keys(container) : [];
    }

    /** The array at `pointer` in the in-memory document, or empty when it carries none. */
    private _readArray(pointer: string): unknown[] {
        const value = this._readPointer(pointer);
        return Array.isArray(value) ? value : [];
    }

    /**
     * Writes one new key into a map, then re-renders: the entry panels are built from the document,
     * so a new key only appears once the form is built again. One write, at the entry's own pointer,
     * rather than a replacement of the whole container - the other keys are not this edit's business
     * and are never rewritten.
     */
    private _addMapEntry(spec: MapSpec, key: string, value: unknown): void {
        const pointer = mapEntryPointer(spec.pointer, key);
        if (!this._applyChange(pointer, value)) {
            return;
        }
        // Reveal the new entry: any ancestor entry reopens around it, and it opens for filling in.
        this._render(pointer);
        MessageToast.show(interpolate(this._text(spec.addedText), key));
    }

    /** Removes one key from a map, then re-renders. */
    private _removeMapEntry(spec: MapSpec, key: string): void {
        if (!this._removeAt(mapEntryPointer(spec.pointer, key))) {
            return;
        }
        this._render();
        MessageToast.show(interpolate(this._text(spec.removedText), key));
    }

    /**
     * Confirms, then removes one element of a plain array by index.
     *
     * Named by its position, because that is all a hook entry has: its panel header is `#<index>`
     * (the design's own out-of-scope note about those labels still stands), and the confirmation has
     * to name the same thing the panel does or it would be asking about something else.
     */
    private _confirmRemoveElement(pointer: string): void {
        const index = lastSegmentOf(pointer);
        MessageBox.confirm(interpolate(this._text("formArrayRemoveConfirm"), index), {
            title: this._text("formArrayRemoveTitle"),
            actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
            emphasizedAction: MessageBox.Action.CANCEL,
            onClose: (action: string) => {
                if (action !== MessageBox.Action.OK) {
                    return;
                }
                if (!this._removeAt(pointer)) {
                    return;
                }
                this._render();
                MessageToast.show(interpolate(this._text("formArrayRemoved"), index));
            }
        });
    }

    /** The element index in `/api_config/observability/siem/sinks/<index>`, or null for anything else. */
    private _sinkIndex(pointer: string): number | null {
        if (pointer.indexOf(SINKS_POINTER + "/") !== 0) {
            return null;
        }
        const index = Number(pointer.slice((SINKS_POINTER + "/").length));
        return Number.isInteger(index) && index >= 0 ? index : null;
    }

    /**
     * The other half of the document's single mutation path: `_applyChange` puts a value at a
     * pointer, this takes what a pointer addresses away. Same error handling, same mirroring into
     * the JSON editor, same re-check of the marked fields - because a removal is an edit like any
     * other, and a form that removed through a second path would have a second set of ways to go
     * wrong. Returns false when nothing was removed, so a caller does not toast about it.
     */
    private _removeAt(pointer: string): boolean {
        if (!this._document) {
            return false;
        }
        try {
            this._document = removeAt(this._document, pointer) as Record<string, unknown>;
        } catch (error) {
            MessageBox.error(this._text("formApplyFailed") + " " + pointer);
            return false;
        }
        this._writeDocumentToEditor();
        if (this._showFieldErrors) {
            this._refreshFieldErrors();
        }
        return true;
    }

    /**
     * Returns false when nothing was written, so an add affordance does not go on to say it added
     * something. A field edit ignores the answer: the control it came from has already put the value
     * on screen, and the error dialog is what tells the user it did not land.
     */
    private _applyChange(pointer: string, value: unknown): boolean {
        if (!this._document) {
            return false;
        }
        try {
            this._document = applyDescriptor(this._document, pointer, value) as Record<string, unknown>;
        } catch (error) {
            MessageBox.error(this._text("formApplyFailed") + " " + pointer);
            return false;
        }
        // Mirror the edit into the hidden JSON editor straight away. Best effort on purpose:
        // the authoritative, verified reconciliation happens when the editor is shown again or
        // saved. This is what lets the controller's own "unsaved changes" guard fire if the
        // user closes the detail column with form edits pending.
        this._writeDocumentToEditor();
        // A field marked when a save was refused must clear as soon as it is corrected, or one
        // mistake leaves the form permanently red.
        if (this._showFieldErrors) {
            this._refreshFieldErrors();
        }
        return true;
    }

    // --- plumbing -----------------------------------------------------------

    private _view(): View | undefined {
        return this._host.getView();
    }

    /**
     * Models declared in the manifest live on the component and are only propagated to the view
     * once it is attached, which has not happened yet when onInit runs. Asking the view alone
     * silently yields undefined there - the reason the controller already carries the same
     * fallback for the OData model.
     */
    private _model(name?: string): Model | undefined {
        const fromView = name ? this._view()?.getModel(name) : this._view()?.getModel();
        if (fromView) {
            return fromView;
        }
        const component = this._host.getOwnerComponent();
        return name ? component?.getModel(name) : component?.getModel();
    }

    private _viewModel(): JSONModel | null {
        return (this._model("viewModel") as JSONModel) || null;
    }

    private _setProperty(path: string, value: unknown): void {
        this._viewModel()?.setProperty(path, value);
    }

    private _getProperty(path: string): unknown {
        return this._viewModel()?.getProperty(path);
    }

    /**
     * JSON-backed fields are editable only for an admin on an inactive configuration - the two
     * independent gates from the design. Credential Set/Clear is deliberately NOT gated on
     * isActive: rotation on the active configuration is the one exception.
     */
    private _recomputeEditable(isActiveOverride?: boolean): void {
        const isAdmin = this._getProperty("/isAdmin") === true;
        const isActive = isActiveOverride !== undefined
            ? isActiveOverride
            : this._getProperty("/selectedConfigIsActive") === true;
        this._setProperty("/formEditable", isAdmin && !isActive);
    }

    private _text(key: string): string {
        return (this._bundle ? this._bundle.getText(key) : undefined) ?? key;
    }

    private _clearContent(): void {
        (this._host.byId("configFormContent") as VBox)?.destroyItems();
        // The registry would otherwise hold destroyed controls into the next configuration.
        this._fieldControls = {};
        this._markedFields = [];
        this._showFieldErrors = false;
        // Expansion memory is per configuration: the next one's entries have not been seen, so they
        // must open by their own maps' defaults rather than inherit this one's opened overrides.
        this._expandedEntries.clear();
        this._panelsByPointer = new Map<string, Panel>();
        this._mapNodePointers = new Set<string>();
    }

    /** Reads a JSON pointer out of the in-memory document. */
    private _readPointer(pointer: string): unknown {
        let cursor: unknown = this._document;
        const segments = pointer.split("/").filter(segment => segment.length > 0)
            .map(segment => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
        for (const segment of segments) {
            if (cursor === null || typeof cursor !== "object") {
                return undefined;
            }
            cursor = (cursor as Record<string, unknown>)[segment];
        }
        return cursor;
    }

    /**
     * The JSON editor the user actually sees is built at runtime into the detail page's content
     * aggregation, so it is found by searching that page rather than by id.
     */
    private _findEditor(): CodeEditor | null {
        const detailPage = this._host.byId("detailDynamicPage");
        if (!detailPage) {
            return null;
        }
        const editors = detailPage.findAggregatedObjects(true)
            .filter(control => control.getMetadata().getName() === "sap.ui.codeeditor.CodeEditor") as CodeEditor[];
        if (editors.length === 0) {
            return null;
        }
        return editors.filter(editor => !!editor.getDomRef())[0] || editors[0];
    }

    /**
     * Shows or hides the JSON editor. Its container is the programmatic VBox that
     * _createDetailContentProgrammatically installs; it is replaced on every selection, which is
     * why the form itself lives in the page header instead.
     */
    private _setJsonVisible(visible: boolean): void {
        const detailPage = this._host.byId("detailDynamicPage") as DynamicPage;
        // The aggregation is 0..1, so this is a single control, not an array - see the task 4
        // findings; every existing `content.length` test in the controller is dead code for it.
        const content = detailPage ? detailPage.getContent() as unknown : null;
        const items = (Array.isArray(content) ? content : (content ? [content] : [])) as Control[];
        items.forEach(item => {
            if (typeof item.setVisible === "function") {
                item.setVisible(visible);
            }
        });
    }

    /** Executes an unbound OData V4 action and returns its result object, or null. */
    private async _callAction(path: string, parameters: Record<string, unknown>): Promise<Record<string, unknown> | null> {
        const model = this._model() as ODataModel;
        if (!model) {
            return null;
        }
        const binding = model.bindContext(path);
        Object.keys(parameters).forEach(key => binding.setParameter(key, parameters[key]));
        await binding.invoke();
        return (binding.getBoundContext()?.getObject() as Record<string, unknown>) || null;
    }
}
