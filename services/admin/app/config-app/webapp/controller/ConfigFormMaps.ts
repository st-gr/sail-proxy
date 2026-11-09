import Button from "sap/m/Button";
import ComboBox from "sap/m/ComboBox";
import Dialog from "sap/m/Dialog";
import Input from "sap/m/Input";
import InputBase from "sap/m/InputBase";
import Label from "sap/m/Label";
import MessageBox from "sap/m/MessageBox";
import Text from "sap/m/Text";
import VBox from "sap/m/VBox";
import Control from "sap/ui/core/Control";
import Item from "sap/ui/core/Item";
import {
    MapSpec,
    interpolate,
    mapKeyProblem,
    newMapValue,
    remainingKeyChoices
} from "../model/formContainers";

/**
 * The UI5 half of the dynamically-keyed maps: the [+] dialog that asks for a key, and the
 * confirmation in front of a [-].
 *
 * Every rule it applies - whether a key is allowed, what a new entry holds, which message says why a
 * key was refused - comes from `../model/formContainers`, which imports no `sap/*` and is therefore
 * the half a unit test can call. Nothing is decided twice. The toolbar, the entry panels and the
 * filter are not here either: they are built by `../model/descriptorControls.ts` alongside every
 * other control, because a map entry is a descriptor like any other and only its affordances differ.
 *
 * This is deliberately the sink editor's pattern (`ConfigFormSinks.ts`) rather than a widening of
 * it: a sink is an array element identified by index and created with a type and a name, a map entry
 * is an object key identified by the key itself and created from its schema's own requirements. The
 * two share the shape - a dialog that refuses a duplicate without closing, a confirmation before
 * removal, a write that goes through the form's single `_applyChange`/`_removeAt` path and
 * re-renders - and none of the mechanics.
 *
 * Every string that carries document data (an entry key, a message with a key interpolated into it)
 * reaches its control through a setter, never through the constructor's settings object: UI5 runs a
 * "{"-leading settings string through the complex-binding parser. See
 * `../model/descriptorControls.ts`'s own header for the full reasoning.
 */

/** What the map editor needs from the form that hosts it. */
export interface MapEditorOptions {
    /** Resolves an i18n key. */
    text: (key: string) => string;
    /** Attaches a dialog to the view so it is destroyed with it. */
    addDependent: (dialog: Dialog) => void;
    /**
     * The keys the map container at `pointer` already carries, in document order. Empty for a
     * container the document does not carry - the [+] on one of those is **Add section**, which
     * creates it, so by the time this dialog opens there is always something to add a key to.
     */
    readKeys: (pointer: string) => string[];
    /** Writes one new entry into the in-memory document and re-renders. */
    addEntry: (spec: MapSpec, key: string, value: unknown) => void;
    /** Removes one entry from the in-memory document and re-renders. */
    removeEntry: (spec: MapSpec, key: string) => void;
}

/** Adding and removing entries of a dynamically-keyed map. */
export default class MapEditor {

    private _options: MapEditorOptions;

    constructor(options: MapEditorOptions) {
        this._options = options;
    }

    /**
     * Asks for a key, then adds the entry its schema describes under it.
     *
     * The key is not preset the way a sink's name is: a provider key names a provider and a model id
     * names a model, so there is nothing to guess - a generated one would be a key nothing on the
     * wire ever matches. It is therefore validated rather than pre-filled, and a rejected key leaves
     * the dialog open with the reason on the field, so it is corrected here rather than re-entered
     * from the start.
     *
     * A map whose key rule ENUMERATES its keys (`MapSpec.keyChoices` - the masking category maps)
     * asks differently: the field is a `ComboBox` of the keys not yet in the map, and the rule is
     * never quoted at all. Its rule is a 511 character alternation of the 27 categories, and this
     * dialog is 30rem wide - shown as a regex it was truncated mid-alternative, which read as a
     * key ("profile-addres") that the rule then correctly refused. Everything else about the dialog
     * is unchanged, the free-text refusals included: the ComboBox still accepts typing, so an empty
     * or duplicate key reaches `mapKeyProblem` exactly as before.
     */
    public openAdd(spec: MapSpec): void {
        const text = (key: string): string => this._options.text(key);

        // Re-read at open time, for the same reason the confirm handler re-reads: another dialog or
        // a credential change may have added an entry while this map's panel stood on screen.
        const choices = spec.keyChoices
            ? remainingKeyChoices(spec, this._options.readKeys(spec.pointer))
            : undefined;
        // A non-restrictive suggestion list for an OPEN map (`spec.keySuggestions`, distinct from the
        // closed `keyChoices` above). The keys already in the map are subtracted, exactly as
        // `remainingKeyChoices` does for choices, so the field never offers a duplicate; re-read here
        // for the same reason the confirm handler re-reads. Undefined where the map has no suggestions
        // or a closed enumeration already, so the free-text Input path below is unchanged for them.
        const suggestions = (!choices && spec.keySuggestions && spec.keySuggestions.length > 0)
            ? spec.keySuggestions.filter(s => this._options.readKeys(spec.pointer).indexOf(s) === -1)
            : undefined;
        // The same free-typeable `choiceField` a closed map uses - a ComboBox whose `getValue()`
        // returns text, so `mapKeyProblem` still governs what may be created and a key not in the list
        // is accepted verbatim. Falls back to the plain Input when every suggestion is already present
        // (the filtered list is empty), so an exhausted list never leaves an empty dropdown.
        const keyField: InputBase = choices
            ? choiceField(choices)
            : suggestions && suggestions.length > 0
                ? choiceField(suggestions)
                : new Input({ width: "100%" });
        keyField.setPlaceholder(text(spec.keyPlaceholderText));

        const hint = new Text({ wrapping: true }).addStyleClass("sapUiTinyMarginTop");
        // Set, never constructed: a seeded number and a count are values, and a regex source
        // routinely carries "{" (a quantifier), which the settings object would hand to the
        // binding parser.
        const base = spec.valueKind === "scalar"
            ? interpolate(text(spec.addHintText), String(spec.scalarDefault))
            : text(spec.addHintText);
        // A closed map appends the "choose one of N" note; an open map with a suggestion list appends
        // its own "pick one or type your own" note, so the field's freedom is stated where the count
        // is. A map with neither shows the base hint alone, exactly as before.
        hint.setText(choices
            ? `${base} ${interpolate(text("formMapAddHintChoices"), String(choices.length))}`
            : suggestions && suggestions.length > 0
                ? `${base} ${interpolate(text("formMapAddHintSuggestions"), String(suggestions.length))}`
                : base);

        // The rule as written, on its own line and wrapping, for a map whose keys are a SHAPE
        // rather than a list. Appending it to the hint is what made it unreadable: a pattern is
        // the one string in this dialog that must not be broken across a sentence.
        const pattern = choices || !spec.entryPattern ? undefined : new Text({ wrapping: true });
        if (pattern) {
            pattern.addStyleClass("sapUiSmallMarginTop");
            pattern.setText(interpolate(text("formMapAddHintPattern"), spec.keyPatternSource));
        }

        const fields: Control[] = [
            new Label({ text: text(spec.keyLabelText), labelFor: keyField }),
            keyField,
            hint
        ];
        if (pattern) {
            fields.push(pattern);
        }

        // One handler, reached by the Add button and by Enter in the key field alike, and guarded
        // so the two cannot both run: a browser that delivers Enter to the field AND to the default
        // button would otherwise add the entry twice under the same key - the second write silently
        // discarding whatever the first one's panel already held. A REFUSED key leaves the guard
        // down, so the dialog stays open and the corrected key can be submitted the same two ways.
        let added = false;
        const confirm = (): void => {
            if (added) {
                return;
            }
            // Re-read rather than close over the keys: a credential change or another dialog
            // may have re-rendered the form while this one stood open.
            const problem = mapKeyProblem(
                keyField.getValue(),
                this._options.readKeys(spec.pointer),
                spec,
                text
            );
            if (problem) {
                keyField.setValueState("Error");
                keyField.setValueStateText(problem);
                return;
            }
            keyField.setValueState("None");
            added = true;
            const created = keyField.getValue().trim();
            this._options.addEntry(spec, created, newMapValue(spec));
            dialog.close();
        };

        // AFTER the field's own handler - which is what `addEventDelegate` means (`addDelegate`
        // with `bCallBefore` false) - so a ComboBox has already applied the entry Enter picked out
        // of its list by the time the key is read. Escape still cancels: that is the Dialog's own.
        keyField.addEventDelegate({ onsapenter: () => confirm() });

        const dialog = new Dialog({
            title: text(spec.addTitleText),
            contentWidth: "30rem",
            content: [
                new VBox({ items: fields }).addStyleClass("sapUiSmallMargin")
            ],
            beginButton: new Button({
                text: text("formMapAddConfirm"),
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
     * Confirms, then removes the entry under `key`.
     *
     * Removing a provider, an override or a hook endpoint drops every setting under it at once - a
     * panel's worth of fields, not one value - so it is asked about first, with the key named, and
     * Cancel is the emphasized action.
     */
    public confirmRemove(spec: MapSpec, key: string): void {
        if (this._options.readKeys(spec.pointer).indexOf(key) === -1) {
            return;
        }

        MessageBox.confirm(interpolate(this._options.text(spec.removeMessageText), key), {
            title: this._options.text(spec.removeTitleText),
            actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
            emphasizedAction: MessageBox.Action.CANCEL,
            onClose: (action: string) => {
                if (action !== MessageBox.Action.OK) {
                    return;
                }
                this._options.removeEntry(spec, key);
            }
        });
    }
}

/**
 * The key field of an enumerated map: one item per key still free, in the key rule's own order.
 *
 * A `ComboBox` rather than a `Select` because it stays an input - the operator can type to narrow
 * a 27 item list, and what `getValue()` hands back is text either way, so `mapKeyProblem` is the
 * same check on the same string it has always been. An item's key and text are the entity key the
 * schema spells, so both go on through setters rather than the settings object.
 */
function choiceField(choices: string[]): ComboBox {
    const box = new ComboBox({ width: "100%" });
    for (const choice of choices) {
        const item = new Item();
        item.setKey(choice);
        item.setText(choice);
        box.addItem(item);
    }
    return box;
}
