import Dialog from "sap/m/Dialog";
import Button from "sap/m/Button";
import Label from "sap/m/Label";
import Text from "sap/m/Text";
import Title from "sap/m/Title";
import VBox from "sap/m/VBox";
import Select from "sap/m/Select";
import StepInput from "sap/m/StepInput";
import Switch from "sap/m/Switch";
import MessageStrip from "sap/m/MessageStrip";
import Item from "sap/ui/core/Item";
import Form from "sap/ui/layout/form/Form";
import FormContainer from "sap/ui/layout/form/FormContainer";
import FormElement from "sap/ui/layout/form/FormElement";
import ColumnLayout from "sap/ui/layout/form/ColumnLayout";
import View from "sap/ui/core/mvc/View";
import { ButtonType } from "sap/m/library";
import { MIN_MAX_TOKENS, MAX_MAX_TOKENS, VISION_MODES } from "../model/chunking";
import type { ChunkingFlow } from "./chunkingFlow";

/** The controls of the chunking dialogs, bound to /chunking of the view's "view" model; the logic is chunkingFlow.ts. */

type TextOf = (key: string, args?: any[]) => Promise<string>;

/**
 * The strategy, max tokens, overlap tokens, the Contextual switch (enabled only for Structure), the vision mode
 * (shown where the gateway allows vision or the store has a mode, with the unmasked-images warning), and the
 * strip that names a problem or a refusal. `id` makes the view-scoped ids the OPA journeys find.
 */
export async function chunkingFields(text: TextOf, id: (local: string) => string, flow: ChunkingFlow): Promise<VBox> {
    const changed = (): void => { flow.changed(); };
    const type = new Select({
        id: id("chunkingTypeSelect"),
        selectedKey: "{view>/chunking/form/type}",
        items: [
            new Item({ key: "static", text: await text("chunkingType_static") }),
            new Item({ key: "structure", text: await text("chunkingType_structure") })
        ],
        change: changed
    });
    const max = new StepInput({ id: id("chunkingMaxInput"), value: "{view>/chunking/form/maxTokens}", min: MIN_MAX_TOKENS, max: MAX_MAX_TOKENS, step: 50, change: changed });
    // The bound follows max tokens (chunkingFlow keeps /chunking/overlapMax at half of it); formToSetting checks it too.
    const overlap = new StepInput({ id: id("chunkingOverlapInput"), value: "{view>/chunking/form/overlapTokens}", min: 0, max: "{view>/chunking/overlapMax}", step: 50, change: changed });
    const contextual = new Switch({
        id: id("chunkingContextualSwitch"),
        state: "{view>/chunking/form/contextual}",
        enabled: "{= ${view>/chunking/form/type} === 'structure' }",
        change: changed
    });
    const visionItems: Item[] = [];
    for (const mode of VISION_MODES) visionItems.push(new Item({ key: mode, text: await text(`chunkingVision_${mode}`) }));
    const vision = new Select({
        id: id("chunkingVisionSelect"),
        selectedKey: "{view>/chunking/form/vision}",
        items: visionItems,
        visible: "{view>/chunking/visionShown}",
        change: changed
    });
    const visionShown = "{view>/chunking/visionShown}";
    return new VBox({
        items: [
            new Label({ text: await text("chunkingStrategy"), labelFor: type }), type,
            new Text({ text: await text("chunkingStrategyHint") }).addStyleClass("sapUiTinyMarginBottom"),
            new Label({ text: await text("chunkingMaxTokens"), labelFor: max }), max,
            new Label({ text: await text("chunkingOverlapTokens"), labelFor: overlap }), overlap,
            new Label({ text: await text("chunkingContextual"), labelFor: contextual }), contextual,
            new Text({ text: await text("chunkingContextualHint") }),
            new Label({ text: await text("chunkingVision"), labelFor: vision, visible: visionShown }).addStyleClass("sapUiSmallMarginTop"), vision,
            new Text({ text: await text("chunkingVisionHint"), visible: visionShown }),
            new MessageStrip({
                id: id("chunkingVisionUnmaskedStrip"),
                text: await text("chunkingVisionUnmaskedWarning"),
                type: "Warning",
                showIcon: true,
                visible: "{= ${view>/chunking/visionShown} === true && ${view>/chunking/unmaskedWarning} === true && ${view>/chunking/form/vision} !== 'off' }"
            }).addStyleClass("sapUiSmallMarginTop"),
            new MessageStrip({
                id: id("chunkingMessageStrip"),
                text: { path: "view>/chunking/message" },
                type: "{view>/chunking/messageType}",
                visible: "{= !!${view>/chunking/message} }",
                showIcon: true
            }).addStyleClass("sapUiSmallMarginTop")
        ]
    });
}

function figure(label: string, path: string, localId?: string): FormElement {
    return new FormElement({ label, fields: [new Text(localId ? { id: localId, text: { path: `view>${path}` } } : { text: { path: `view>${path}` } })] });
}

/** The estimate's figures, each labelled as an estimate, the context rows only for a contextual target. */
async function estimateBox(text: TextOf, id: (local: string) => string): Promise<VBox> {
    const context = (element: FormElement): FormElement => { element.bindProperty("visible", { path: "view>/chunking/estimate/contextual" }); return element; };
    const vision = (element: FormElement): FormElement => { element.bindProperty("visible", { path: "view>/chunking/estimate/vision" }); return element; };
    return new VBox({
        id: id("chunkingEstimateBox"),
        visible: "{= !!${view>/chunking/estimate} }",
        items: [
            new Title({ text: await text("chunkingEstimateTitle"), level: "H3" }),
            new Text({ text: await text("chunkingEstimateNote") }),
            new Form({
                editable: false,
                layout: new ColumnLayout(),
                formContainers: [new FormContainer({
                    formElements: [
                        figure(await text("columnFiles"), "/chunking/estimate/files", id("chunkingEstimateFiles")),
                        figure(await text("chunkingEstimateCurrentChunks"), "/chunking/estimate/currentChunks"),
                        figure(await text("chunkingEstimateChunks"), "/chunking/estimate/chunks"),
                        figure(await text("chunkingEstimateEmbeddingTokens"), "/chunking/estimate/embeddingTokens", id("chunkingEstimateEmbeddingTokens")),
                        context(figure(await text("chunkingEstimateContextModel"), "/chunking/estimate/contextModel")),
                        context(figure(await text("chunkingEstimateContextInput"), "/chunking/estimate/contextInputTokens")),
                        context(figure(await text("chunkingEstimateContextOutput"), "/chunking/estimate/contextOutputTokens")),
                        vision(figure(await text("chunkingEstimateVisionModel"), "/chunking/estimate/visionModel")),
                        vision(figure(await text("chunkingEstimateVisionFiles"), "/chunking/estimate/visionFiles")),
                        vision(figure(await text("chunkingEstimateVisionPages"), "/chunking/estimate/visionPages", id("chunkingEstimateVisionPages"))),
                        vision(figure(await text("chunkingEstimateVisionInput"), "/chunking/estimate/visionInputTokens")),
                        vision(figure(await text("chunkingEstimateVisionOutput"), "/chunking/estimate/visionOutputTokens")),
                        vision(figure(await text("chunkingEstimateVisionCost"), "/chunking/estimate/visionCost", id("chunkingEstimateVisionCost")))
                    ]
                })]
            }),
            new MessageStrip({
                text: await text("chunkingVisionUnmaskedWarning"),
                type: "Warning",
                showIcon: true,
                visible: "{= ${view>/chunking/estimate/visionUnmasked} === true }"
            }).addStyleClass("sapUiSmallMarginTop"),
            new MessageStrip({
                text: await text("chunkingModelUnavailableWarning"),
                type: "Warning",
                showIcon: true,
                visible: "{= ${view>/chunking/estimate/modelUnavailable} === true }"
            }).addStyleClass("sapUiSmallMarginTop"),
            new Text({ text: await text("chunkingStartNote"), visible: "{= ${view>/chunking/estimate/canStart} === true }" }).addStyleClass("sapUiSmallMarginTop")
        ]
    }).addStyleClass("sapUiSmallMarginTop");
}

/**
 * "Change Chunking" for the store the flow was prepared for (flow.prepareChange): the fields, then Show Estimate
 * (offered again at any time), then Start Re-chunk once the estimate allows it. `started` runs after the job started and the dialog closed.
 */
export async function openChangeChunkingDialog(view: View, text: TextOf, flow: ChunkingFlow, started: () => Promise<void>): Promise<void> {
    const id = (local: string): string => view.createId(local);
    const showEstimate = new Button({
        id: id("chunkingEstimateButton"),
        text: await text("reembedShowEstimate"),
        type: ButtonType.Emphasized,
        // Stays offered beside Start: an unchanged or running answer can be checked again without a field change.
        enabled: "{= !${view>/chunking/busy} }",
        press: () => { void flow.estimate(); }
    });
    const start = new Button({
        id: id("chunkingStartButton"),
        text: await text("chunkingStart"),
        type: ButtonType.Emphasized,
        visible: "{= !!${view>/chunking/estimate} }",
        enabled: "{= ${view>/chunking/estimate/canStart} === true && !${view>/chunking/busy} }",
        press: async () => {
            const job = await flow.start();
            if (!job) return;
            dialog.close();
            await started();
        }
    });
    const dialog = new Dialog({
        title: await text("changeChunking"),
        contentWidth: "32rem",
        busy: "{view>/chunking/busy}",
        busyIndicatorDelay: 0,
        content: [
            new VBox({
                items: [
                    new Label({ text: await text("columnStore") }),
                    new Text({ text: { path: "view>/chunking/storeName" } }),
                    new Label({ text: await text("columnOwner"), visible: "{= !!${view>/chunking/ownerEmail} }" }),
                    new Text({ text: { path: "view>/chunking/ownerEmail" }, visible: "{= !!${view>/chunking/ownerEmail} }" }),
                    new Label({ text: await text("chunkingCurrent") }),
                    new Text({ id: id("chunkingCurrentText"), text: { path: "view>/chunking/current" } }).addStyleClass("sapUiSmallMarginBottom"),
                    await chunkingFields(text, id, flow),
                    await estimateBox(text, id)
                ]
            }).addStyleClass("sapUiSmallMargin")
        ],
        buttons: [showEstimate, start, new Button({ text: await text("cancel"), press: () => dialog.close() })],
        afterClose: () => dialog.destroy()
    });
    view.addDependent(dialog);
    dialog.open();
}
