import Button from "sap/m/Button";
import Dialog from "sap/m/Dialog";
import GroupHeaderListItem from "sap/m/GroupHeaderListItem";
import List from "sap/m/List";
import MessageStrip from "sap/m/MessageStrip";
import StandardListItem from "sap/m/StandardListItem";
import Text from "sap/m/Text";
import VBox from "sap/m/VBox";
import type Control from "sap/ui/core/Control";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import type ODataModel from "sap/ui/model/odata/v4/ODataModel";
import {
    applyShippedEntries,
    displayPathOf,
    missingShippedEntries,
    previewOf,
    type ShippedEntry
} from "../model/shippedDefaults";

/** What the controller lends this helper; it owns no view and no model of its own. */
export interface ShippedDefaultsOptions {
    text: (key: string, args?: unknown[]) => string;
    model: () => ODataModel;
    addDependent: (control: Control) => void;
    /** Opens the create dialog on a new, not yet saved configuration holding this document. */
    openCreate: (draft: { name: string; version: string; description: string; configData: string }) => void;
}

/** One configuration against the shipped defaults. */
export interface ShippedComparison {
    /** 'noActive': nothing is active. 'unavailable': the server could not read the shipped file. */
    state: "ready" | "noActive" | "unavailable";
    name: string;
    version: string;
    /** The compared configuration's document. */
    document: unknown;
    entries: ShippedEntry[];
}

const NOTHING: Omit<ShippedComparison, "state"> = { name: "", version: "", document: null, entries: [] };

/**
 * "Compare with defaults": what the shipped api_config.json holds and a configuration - the
 * ticked one, else the active one - lacks, offered for a new configuration. An installation keeps its stored configuration across
 * upgrades, so settings that ship later never reach it by themselves. Which entries count as
 * missing and how they are added is `model/shippedDefaults.ts`; this builds the dialog around it.
 */
export default class ConfigShippedDefaults {
    private readonly _options: ShippedDefaultsOptions;

    constructor(options: ShippedDefaultsOptions) {
        this._options = options;
    }

    /** Reads the configuration - `configId`, or the active one without it - and the shipped file, and compares them. */
    public async compare(configId?: string): Promise<ShippedComparison> {
        const model = this._options.model();
        type Row = { name?: string; version?: string; configData?: string };
        let row: Row;
        if (configId) {
            row = await model.bindContext(`/ApiConfigurations(ID='${configId}')`).requestObject() as Row;
        } else {
            const [activeContext] = await model
                .bindList("/ApiConfigurations", undefined, undefined, [new Filter("isActive", FilterOperator.EQ, true)])
                .requestContexts(0, 1);
            if (!activeContext) {
                return { state: "noActive", ...NOTHING };
            }
            row = await activeContext.requestObject() as Row;
        }

        const shippedBinding = model.bindContext("/getShippedConfiguration(...)");
        await shippedBinding.execute();
        const shipped = shippedBinding.getBoundContext()?.getObject() as { available?: boolean; configData?: string | null } | undefined;
        if (!shipped?.available || !shipped.configData) {
            return { state: "unavailable", ...NOTHING };
        }

        const document = JSON.parse(row.configData || "{}");
        return {
            state: "ready",
            name: row.name ?? "",
            version: row.version ?? "",
            document,
            entries: missingShippedEntries(document, JSON.parse(shipped.configData))
        };
    }

    /** Compares, then shows the result: the entries to pick from, or why there are none. */
    public async open(configId?: string): Promise<void> {
        const text = this._options.text;
        const comparison = await this.compare(configId);

        const content: Control[] = [];
        let list: List | null = null;
        if (comparison.state !== "ready") {
            content.push(new MessageStrip({
                text: text(comparison.state === "noActive" ? "compareDefaultsNoActive" : "compareDefaultsUnavailable"),
                type: "Warning",
                showIcon: true
            }));
        } else if (comparison.entries.length === 0) {
            content.push(new MessageStrip({ type: "Success", showIcon: true })
                .setText(text("compareDefaultsNothing", [comparison.name, comparison.version])));
        } else {
            // setText, not the constructor: the configuration's name may hold braces.
            content.push(new Text()
                .setText(text("compareDefaultsIntro", [comparison.name, comparison.version, comparison.entries.length]))
                .addStyleClass("sapUiSmallMarginBottom"));
            list = this._entryList(comparison.entries);
            content.push(list);
        }

        const create = new Button({
            text: text("compareDefaultsCreate"),
            type: "Emphasized",
            visible: list !== null,
            press: () => {
                const picked = (list?.getSelectedItems() ?? [])
                    .map((item) => item.data("entry") as ShippedEntry);
                const merged = applyShippedEntries(comparison.document, picked);
                dialog.close();
                this._options.openCreate({
                    name: text("compareDefaultsNewName", [comparison.name]),
                    version: comparison.version,
                    description: text("compareDefaultsNewDescription", [comparison.name, comparison.version, picked.length]),
                    configData: JSON.stringify(merged, null, 2)
                });
            }
        });
        // Nothing ticked is nothing to create.
        list?.attachSelectionChange(() => create.setEnabled((list?.getSelectedItems().length ?? 0) > 0));

        const dialog = new Dialog({
            title: text("compareDefaultsTitle"),
            contentWidth: "50rem",
            resizable: true,
            draggable: true,
            content: [new VBox({ items: content }).addStyleClass("sapUiSmallMargin")],
            beginButton: create,
            endButton: new Button({ text: text("close"), press: () => dialog.close() })
        });
        dialog.attachAfterClose(() => dialog.destroy());
        this._options.addDependent(dialog);
        dialog.open();
    }

    /** The entries under their section's title, all ticked: the usual wish is "bring me up to date". */
    private _entryList(entries: ShippedEntry[]): List {
        const text = this._options.text;
        const list = new List({ mode: "MultiSelect", includeItemInSelection: true });
        let group: string | null = null;
        for (const entry of entries) {
            if (entry.group !== group) {
                group = entry.group;
                const key = `formTab${group.charAt(0).toUpperCase()}${group.slice(1)}`;
                const title = text(key);
                list.addItem(new GroupHeaderListItem({ title: title === key ? group : title }));
            }
            const path = displayPathOf(entry);
            const item = new StandardListItem({ wrapping: true, selected: true });
            // Through the setters, not the constructor: a constructor setting that starts with
            // "{" - as the preview of an object does - is read as a binding and shows nothing.
            item.setTitle(entry.kind === "listEntry" ? text("compareDefaultsListEntry", [path]) : path);
            item.setDescription(previewOf(entry.value));
            item.setTooltip(previewOf(entry.value));
            item.data("entry", entry);
            list.addItem(item);
        }
        return list;
    }
}
