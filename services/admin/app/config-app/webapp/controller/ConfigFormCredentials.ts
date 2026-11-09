import Button from "sap/m/Button";
import Dialog from "sap/m/Dialog";
import Input from "sap/m/Input";
import Label from "sap/m/Label";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import ObjectStatus from "sap/m/ObjectStatus";
import Text from "sap/m/Text";
import VBox from "sap/m/VBox";
import Control from "sap/ui/core/Control";

/**
 * Metadata about a stored credential. Never carries a value: `listSiemCredentials` cannot
 * return one, and nothing here ever asks for one.
 */
export interface CredentialInfo {
    name: string;
    updatedAt?: string;
    updatedBy?: string;
    maskedHint?: string;
}

/** What the credential section needs from the form that hosts it. */
export interface CredentialSectionOptions {
    /** Resolves an i18n key. */
    text: (key: string) => string;
    /** Executes an unbound OData V4 action and returns its result object. */
    callAction: (path: string, parameters: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    /** Attaches a dialog to the view so it is destroyed with it. */
    addDependent: (dialog: Dialog) => void;
    /** Called after a credential was stored or cleared, so the form can re-render. */
    onChanged: () => void;
}

/**
 * The credential plugin/exit: the control rendered for a `/api_config/observability/siem/sinks/*​/*_env`
 * pointer instead of a text input, plus the Set and Clear actions behind it.
 *
 * Two rules shape all of it. A credential *value* never touches a model, a binding or the
 * configuration document - it exists only inside the dialog's own Input and is cleared as soon
 * as it has been handed to the action. And Set/Clear stay available to an admin even on an
 * active configuration, because rotating a compromised key cannot wait for a configuration
 * version; every JSON-backed field of an active configuration stays read-only regardless.
 */
export default class CredentialSection {

    private _options: CredentialSectionOptions;
    private _list: CredentialInfo[] = [];
    private _loaded = false;

    constructor(options: CredentialSectionOptions) {
        this._options = options;
    }

    /** Forgets what was loaded, so the next form render re-reads it for the new configuration. */
    public reset(): void {
        this._list = [];
        this._loaded = false;
    }

    /**
     * Loads credential metadata for one configuration. `listSiemCredentials` is admin-only, so
     * a non-admin never calls it and is never told what is stored.
     */
    public async ensureLoaded(configurationId: string | null, isAdmin: boolean): Promise<void> {
        if (this._loaded || !configurationId || !isAdmin) {
            return;
        }
        try {
            const result = await this._options.callAction("/listSiemCredentials(...)", { configurationId });
            const list = Array.isArray(result) ? result : (result?.value as CredentialInfo[]);
            this._list = (list as CredentialInfo[]) || [];
        } catch (error) {
            this._list = [];
            console.warn("ConfigForm: could not list credentials", error);
        }
        this._loaded = true;
    }

    /** Slot names this configuration holds a stored value for. Names only; never a value. */
    public storedSlotNames(): string[] {
        return this._list.map(credential => credential.name);
    }

    /**
     * Builds the controls for one credential slot. `slotName` is the value the configuration holds
     * at the pointer - a slot *name*, constrained by the schema to ^[A-Z][A-Z0-9_]*$, never a
     * credential, and since the environment fallback was removed no longer an environment variable
     * either.
     *
     * The slot name is a *tooltip* on every control of the row, not visible text. It is
     * administrative detail: the `name` column of `SiemCredentials`, half of the unique key
     * `(configuration, name)`, and derived automatically since the [+] dialog seeds it - so nobody
     * types it and nobody acts on it, while a long one (`SIEM_WEBHOOK_20260822_141530_TOKEN`)
     * overflows the row it sits in. It stays in the document, in the descriptor and in the actions
     * below unchanged; only the visible text is gone, and an operator correlating a form row with a
     * database row or a log line still gets the name by hovering it.
     *
     * Several controls rather than one container: a Form's ColumnLayout accepts only
     * sap.ui.core.IFormContent, so a container here would sit outside the grid (and, handed to the
     * layout anyway, would throw). Every control returned here is IFormContent - Text, ObjectStatus
     * and Button all implement it - so they can become the `fields` of a single FormElement and the
     * credential row lines up with every other row.
     */
    public buildControl(slotName: string, configurationId: string | null, isAdmin: boolean): Control[] {
        // The document has no such slot - typically a property that belongs to a different sink
        // type. There is nothing to show and nothing to set; adding one is a JSON-editor job.
        if (!slotName) {
            return [new Text({ text: "–", tooltip: this._options.text("formCredentialNoSlot") })];
        }

        const slotTooltip = this._options.text("formCredentialSlot") + " " + slotName;

        // A non-admin is not told whether a value is stored: saying "none stored" would assert
        // something this client cannot know, because it may not call listSiemCredentials. The dash
        // is the same "nothing to act on here" the no-slot case shows; the tooltip says why, and
        // still carries the slot name for anyone correlating with the database.
        if (!isAdmin) {
            return [new Text({
                text: "–",
                tooltip: this._options.text("formCredentialAdminOnly") + " " + slotTooltip
            })];
        }

        const info = this._list.filter(credential => credential.name === slotName)[0];
        const status = info
            ? new ObjectStatus({
                text: this._options.text("formCredentialStored") +
                    (info.maskedHint ? " (" + info.maskedHint + ")" : ""),
                state: "Success"
            })
            : new ObjectStatus({ text: this._options.text("formCredentialMissing"), state: "Warning" });

        // Who set it and when goes on the status rather than into a field of its own: the row is one
        // row of a grid, and a fourth control in it would squeeze the three that carry the action.
        // The slot name leads, so the one tooltip answers both "which slot is this" and "who set it".
        status.setTooltip(info && (info.updatedBy || info.updatedAt)
            ? slotTooltip + "\n" + this._options.text("formCredentialSetBy") + " " +
                (info.updatedBy || "?") + " " + (info.updatedAt || "")
            : slotTooltip);

        return [
            status,
            new Button({
                text: this._options.text("formCredentialSet"),
                tooltip: slotTooltip,
                press: () => this._openDialog(slotName, configurationId)
            }),
            new Button({
                text: this._options.text("formCredentialClear"),
                tooltip: slotTooltip,
                enabled: !!info,
                press: () => this._clear(slotName, configurationId)
            })
        ];
    }

    private _openDialog(slotName: string, configurationId: string | null): void {
        // The value lives in this Input and nowhere else: no model, no document, no descriptor.
        const input = new Input({ type: "Password", width: "100%" });
        const dialog = new Dialog({
            title: this._options.text("formCredentialSetTitle") + " " + slotName,
            contentWidth: "24rem",
            content: [
                new VBox({
                    items: [
                        new Label({ text: this._options.text("formCredentialValue") }),
                        input,
                        new Text({ text: this._options.text("formCredentialHint"), wrapping: true })
                            .addStyleClass("sapUiTinyMarginTop")
                    ]
                }).addStyleClass("sapUiSmallMargin")
            ],
            beginButton: new Button({
                text: this._options.text("formCredentialSave"),
                type: "Emphasized",
                press: () => {
                    const value = input.getValue();
                    input.setValue("");
                    dialog.close();
                    void this._store(slotName, configurationId, value);
                }
            }),
            endButton: new Button({
                text: this._options.text("cancel"),
                press: () => {
                    input.setValue("");
                    dialog.close();
                }
            })
        });
        dialog.attachAfterClose(() => dialog.destroy());
        this._options.addDependent(dialog);
        dialog.open();
    }

    private async _store(slotName: string, configurationId: string | null, value: string): Promise<void> {
        if (!configurationId || !value) {
            return;
        }
        await this._run("/setSiemCredential(...)",
            { configurationId, name: slotName, value },
            "formCredentialSaved");
    }

    private async _clear(slotName: string, configurationId: string | null): Promise<void> {
        if (!configurationId) {
            return;
        }
        await this._run("/deleteSiemCredential(...)",
            { configurationId, name: slotName },
            "formCredentialCleared");
    }

    private async _run(action: string, parameters: Record<string, unknown>, successKey: string): Promise<void> {
        try {
            const result = await this._options.callAction(action, parameters);
            if (result?.success === true) {
                MessageToast.show(this._options.text(successKey));
            } else {
                MessageBox.error(this._options.text("formCredentialFailed") + " " + (result?.error || ""));
            }
        } catch (error) {
            MessageBox.error(this._options.text("formCredentialFailed") + " " + (error as Error).message);
        }
        this._loaded = false;
        await this.ensureLoaded(parameters.configurationId as string, true);
        this._options.onChanged();
    }
}
