import Button from "sap/m/Button";
import Dialog from "sap/m/Dialog";
import Input from "sap/m/Input";
import Label from "sap/m/Label";
import MessageBox from "sap/m/MessageBox";
import Select, { Select$ChangeEvent } from "sap/m/Select";
import Text from "sap/m/Text";
import VBox from "sap/m/VBox";
import Item from "sap/ui/core/Item";
import { defaultSlotsFor, presetSinkName } from "../model/sinkDefaults";
import { sinkNameClash } from "../model/validateSection";

/** A sink, as far as this module cares: a `name`, a `type` and some `*_env` slot names. */
type Sink = Record<string, unknown>;

/** What the sink editor needs from the form that hosts it. */
export interface SinkEditorOptions {
    /** Resolves an i18n key. */
    text: (key: string) => string;
    /** Attaches a dialog to the view so it is destroyed with it. */
    addDependent: (dialog: Dialog) => void;
    /** The sink array of the in-memory document; empty when it has none. */
    readSinks: () => Sink[];
    /** Replaces the sink array in the in-memory document and re-renders. */
    writeSinks: (sinks: Sink[], messageKey: string, subject: string) => void;
    /** Slot names this configuration holds a stored credential for. Names only, never values. */
    storedSlots: () => string[];
}

/**
 * Reads the sink `type` enum out of the shipped schema, so the add dialog offers exactly the types
 * the backend will accept and a seventh type added to the schema needs no edit here.
 */
export function sinkTypes(schema: Record<string, unknown>): string[] {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const items = (properties.sinks?.items ?? {}) as Record<string, unknown>;
    const itemProperties = (items.properties ?? {}) as Record<string, Record<string, unknown>>;
    const values = itemProperties.type?.enum;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

/**
 * Why a sink may not be created with this name, or "" when it may.
 *
 * Uniqueness is not cosmetic. `name` is the key for a sink's delivery rows (`SiemDelivery.sinkName`)
 * and for the dispatcher's backoff state, so two sinks sharing a name share delivery rows and one
 * marks the other's events delivered - events that are then never exported and never reported
 * missing. JSON Schema cannot express this (`uniqueItems` compares whole objects, and two sinks
 * that differ anywhere else are distinct objects), so it is enforced here and, for a collision
 * introduced through the JSON editor, by the form's gate.
 *
 * The collision itself is decided by `sinkNameClash`, the same function the gate uses, so the
 * dialog cannot come to accept something the gate would then reject.
 */
export function sinkNameProblem(name: string, existing: Sink[], text: (key: string) => string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        return text("formSinkNameRequired");
    }
    // The schema's own bound, enforced here so the form cannot produce something the backend
    // would reject on save.
    if (trimmed.length > 40) {
        return text("formSinkNameTooLong");
    }
    const clash = sinkNameClash(trimmed, existing);
    if (clash !== -1) {
        const other = existing[clash];
        return text("formSinkNameDuplicate")
            .replace("{0}", trimmed)
            .replace("{1}", typeof other.type === "string" ? other.type : "?");
    }
    return "";
}

/**
 * Adding and removing sinks.
 *
 * The type is chosen once, when the sink is created, and is read-only afterwards. That is what
 * guarantees a panel's fields always belong to the type its panel shows: the alternative - a
 * settable type on an existing panel - would leave the previous type's controls on screen holding
 * values the new type does not declare, which is the bug this replaces.
 */
export default class SinkEditor {

    private _options: SinkEditorOptions;
    private _types: string[];
    private _schema: Record<string, unknown>;

    constructor(options: SinkEditorOptions, types: string[], schema: Record<string, unknown>) {
        this._options = options;
        this._types = types;
        this._schema = schema;
    }

    /**
     * Asks for a type and a name, then appends the sink.
     *
     * The name opens preset to `<type>_<YYYYMMDD>_<HHMMSS>` (see `presetSinkName`), unique by
     * construction rather than rejected after the fact. It stays editable, and the duplicate check
     * below is unchanged - the preset lowers the chance of a clash, it is not the guard.
     */
    public openAdd(): void {
        const text = (key: string): string => this._options.text(key);

        const initialType = this._types[0] ?? "";
        // What was last written into the field by this dialog. Choosing another type re-presets the
        // name only while the field still holds it: once the user has typed, the name is theirs.
        let preset = presetSinkName(initialType);

        const name = new Input({ width: "100%", value: preset });
        const type = new Select({
            width: "100%",
            selectedKey: initialType,
            items: this._types.map(value => new Item({ key: value, text: value })),
            change: (event: Select$ChangeEvent) => {
                if (name.getValue() !== preset) {
                    return;
                }
                const selected = event.getParameter("selectedItem");
                preset = presetSinkName(selected ? selected.getKey() : "");
                name.setValue(preset);
                name.setValueState("None");
            }
        });

        // One handler for the Add button and for Enter in the name field, guarded so the two
        // cannot both run - the same rule the map add dialog follows (`ConfigFormMaps.openAdd`),
        // and for the same reason: a double submit would append the sink twice. A refused name
        // leaves the guard down and the dialog open.
        let appended = false;
        const confirm = (): void => {
            if (appended) {
                return;
            }
            const existing = this._options.readSinks();
            const problem = sinkNameProblem(name.getValue(), existing, text);
            if (problem) {
                // The dialog stays open: a rejected name is corrected here, not re-entered
                // from the start.
                name.setValueState("Error");
                name.setValueStateText(problem);
                return;
            }
            name.setValueState("None");
            appended = true;
            const created = name.getValue().trim();
            const selectedType = type.getSelectedKey();
            // `name`, `type`, and a default slot name for every `*_env` field this type
            // declares. Nothing else is invented: a URL, a bucket, a site host are left
            // for the administrator and still render at their schema default. A `*_env`
            // field is different - it names a credential slot, not a secret, and the
            // credential control renders that name as read-only text with no way to type
            // one in, so a sink whose type requires one (datadog's `api_key_env`, s3's two
            // access-key fields, ...) could otherwise be created but never saved from the
            // form. See ../model/sinkDefaults for the naming convention.
            this._options.writeSinks(
                existing.concat([{
                    name: created,
                    type: selectedType,
                    ...defaultSlotsFor(this._schema, created, selectedType)
                }]),
                "formSinkAdded",
                created
            );
            dialog.close();
        };

        // The name is the field Enter belongs to; the type is a Select, where Enter opens the list.
        name.addEventDelegate({ onsapenter: () => confirm() });

        const dialog = new Dialog({
            title: text("formSinkAddTitle"),
            contentWidth: "26rem",
            content: [
                new VBox({
                    items: [
                        new Label({ text: text("formSinkType"), labelFor: type }),
                        type,
                        new Label({ text: text("formSinkName"), labelFor: name }).addStyleClass("sapUiTinyMarginTop"),
                        name,
                        new Text({ text: text("formSinkAddHint"), wrapping: true }).addStyleClass("sapUiTinyMarginTop")
                    ]
                }).addStyleClass("sapUiSmallMargin")
            ],
            beginButton: new Button({
                text: text("formSinkAddConfirm"),
                type: "Emphasized",
                press: () => confirm()
            }),
            endButton: new Button({
                text: text("cancel"),
                press: () => dialog.close()
            })
        });
        dialog.attachAfterClose(() => dialog.destroy());
        this._options.addDependent(dialog);
        dialog.open();
    }

    /**
     * Confirms, then removes the sink at `index`.
     *
     * A sink whose slots hold stored credentials is called out by name. Those rows are keyed by
     * `(configuration, slot name)`, so removing the sink does not remove them - it makes them
     * unreachable from the form, which is worth saying before rather than discovering after.
     */
    public confirmRemove(index: number): void {
        const sinks = this._options.readSinks();
        const sink = sinks[index];
        if (!sink) {
            return;
        }
        const label = typeof sink.name === "string" && sink.name.length > 0 ? sink.name : `#${index}`;

        const stored = this._options.storedSlots();
        const orphaned = Object.keys(sink)
            .filter(key => /_env$/.test(key))
            .map(key => sink[key])
            .filter((slot): slot is string => typeof slot === "string" && slot.length > 0)
            .filter(slot => stored.indexOf(slot) !== -1);

        let message = this._options.text("formSinkRemoveMessage").replace("{0}", label);
        if (orphaned.length > 0) {
            message += "\n\n" + this._options.text("formSinkRemoveCredentials").replace("{0}", orphaned.join(", "));
        }

        MessageBox.confirm(message, {
            title: this._options.text("formSinkRemoveTitle"),
            actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
            emphasizedAction: MessageBox.Action.CANCEL,
            onClose: (action: string) => {
                if (action !== MessageBox.Action.OK) {
                    return;
                }
                this._options.writeSinks(sinks.filter((_, position) => position !== index), "formSinkRemoved", label);
            }
        });
    }
}
