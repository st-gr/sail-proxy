import Dialog from "sap/m/Dialog";
import Button from "sap/m/Button";
import Label from "sap/m/Label";
import Text from "sap/m/Text";
import Title from "sap/m/Title";
import VBox from "sap/m/VBox";
import MessageStrip from "sap/m/MessageStrip";
import Form from "sap/ui/layout/form/Form";
import FormContainer from "sap/ui/layout/form/FormContainer";
import FormElement from "sap/ui/layout/form/FormElement";
import ColumnLayout from "sap/ui/layout/form/ColumnLayout";
import View from "sap/ui/core/mvc/View";
import { ButtonType } from "sap/m/library";
import type { ReextractFlow } from "./reextractFlow";

/** The controls of the "Re-read files" dialog, bound to /reextract of the view's "view" model; the logic is reextractFlow.ts. */

type TextOf = (key: string, args?: any[]) => Promise<string>;

function figure(label: string, path: string, visible?: string, localId?: string): FormElement {
    const element = new FormElement({ label, fields: [new Text(localId ? { id: localId, text: { path: `view>${path}` } } : { text: { path: `view>${path}` } })] });
    if (visible) element.bindProperty("visible", { path: `view>${visible}` });
    return element;
}

/** The estimate: files read again and kept, PDFs without text, the cost rows (contexts and vision only when they apply), the queued Office files. */
async function estimateBox(text: TextOf, id: (local: string) => string): Promise<VBox> {
    const e = "/reextract/estimate";
    return new VBox({
        id: id("reextractEstimateBox"),
        visible: "{= !!${view>/reextract/estimate} }",
        items: [
            new Title({ text: await text("chunkingEstimateTitle"), level: "H3" }),
            new Text({ text: await text("reextractEstimateNote") }),
            new Form({
                editable: false,
                layout: new ColumnLayout(),
                formContainers: [new FormContainer({
                    formElements: [
                        figure(await text("chunkingCurrent"), `${e}/setting`),
                        figure(await text("reextractFiles"), `${e}/files`, undefined, id("reextractEstimateFiles")),
                        figure(await text("reextractKeptFiles"), `${e}/keptFiles`),
                        figure(await text("reextractFilesWithoutText"), `${e}/filesWithoutText`, `${e}/hasFilesWithoutText`),
                        figure(await text("chunkingEstimateCurrentChunks"), `${e}/currentChunks`, `${e}/reads`),
                        figure(await text("chunkingEstimateChunks"), `${e}/chunks`, `${e}/reads`),
                        figure(await text("chunkingEstimateEmbeddingTokens"), `${e}/embeddingTokens`, `${e}/reads`),
                        figure(await text("chunkingEstimateContextModel"), `${e}/contextModel`, `${e}/contextual`),
                        figure(await text("chunkingEstimateContextInput"), `${e}/contextInputTokens`, `${e}/contextual`),
                        figure(await text("chunkingEstimateContextOutput"), `${e}/contextOutputTokens`, `${e}/contextual`),
                        figure(await text("chunkingEstimateVisionModel"), `${e}/visionModel`, `${e}/vision`),
                        figure(await text("chunkingEstimateVisionFiles"), `${e}/visionFiles`, `${e}/vision`),
                        figure(await text("chunkingEstimateVisionPages"), `${e}/visionPages`, `${e}/vision`),
                        figure(await text("chunkingEstimateVisionInput"), `${e}/visionInputTokens`, `${e}/vision`),
                        figure(await text("chunkingEstimateVisionOutput"), `${e}/visionOutputTokens`, `${e}/vision`),
                        figure(await text("chunkingEstimateVisionCost"), `${e}/visionCost`, `${e}/vision`),
                        figure(await text("reextractRetryFiles"), `${e}/retryFiles`, `${e}/hasRetryFiles`)
                    ]
                })]
            }),
            new MessageStrip({
                text: await text("reextractOcrUnavailable"),
                type: "Information",
                showIcon: true,
                visible: "{= ${view>/reextract/estimate/reads} === true && ${view>/reextract/estimate/ocrAvailable} !== true }"
            }).addStyleClass("sapUiSmallMarginTop"),
            new MessageStrip({
                text: await text("reextractRetryNote"),
                type: "Information",
                showIcon: true,
                visible: "{= ${view>/reextract/estimate/hasRetryFiles} === true }"
            }).addStyleClass("sapUiSmallMarginTop"),
            new MessageStrip({
                text: await text("chunkingVisionUnmaskedWarning"),
                type: "Warning",
                showIcon: true,
                visible: "{= ${view>/reextract/estimate/visionUnmasked} === true }"
            }).addStyleClass("sapUiSmallMarginTop"),
            new MessageStrip({
                text: await text("chunkingModelUnavailableWarning"),
                type: "Warning",
                showIcon: true,
                visible: "{= ${view>/reextract/estimate/modelUnavailable} === true }"
            }).addStyleClass("sapUiSmallMarginTop"),
            new Text({ text: await text("reextractStartNote"), visible: "{= ${view>/reextract/estimate/canStart} === true && ${view>/reextract/estimate/reads} === true }" })
                .addStyleClass("sapUiSmallMarginTop")
        ]
    }).addStyleClass("sapUiSmallMarginTop");
}

/**
 * "Re-read files" for the store the flow was prepared for (flow.prepare): what this version reads better, the estimate,
 * then Start once it allows one. `started` runs with the gateway's answer after the start, with the dialog closed.
 */
export async function openReextractDialog(view: View, text: TextOf, flow: ReextractFlow, started: (answer: any) => Promise<void>): Promise<void> {
    const id = (local: string): string => view.createId(local);
    const start = new Button({
        id: id("reextractStartButton"),
        text: await text("reextractStart"),
        type: ButtonType.Emphasized,
        enabled: "{= ${view>/reextract/estimate/canStart} === true && !${view>/reextract/busy} }",
        press: async () => {
            const answer = await flow.start();
            if (!answer) return;
            dialog.close();
            await started(answer);
        }
    });
    const dialog = new Dialog({
        title: await text("reextract"),
        contentWidth: "32rem",
        busy: "{view>/reextract/busy}",
        busyIndicatorDelay: 0,
        content: [
            new VBox({
                items: [
                    new Label({ text: await text("columnStore") }),
                    new Text({ text: { path: "view>/reextract/storeName" } }).addStyleClass("sapUiSmallMarginBottom"),
                    new Text({ text: await text("reextractIntro") }),
                    new MessageStrip({
                        id: id("reextractMessageStrip"),
                        text: { path: "view>/reextract/message" },
                        type: "{view>/reextract/messageType}",
                        visible: "{= !!${view>/reextract/message} }",
                        showIcon: true
                    }).addStyleClass("sapUiSmallMarginTop"),
                    await estimateBox(text, id)
                ]
            }).addStyleClass("sapUiSmallMargin")
        ],
        buttons: [start, new Button({ text: await text("cancel"), press: () => dialog.close() })],
        afterClose: () => dialog.destroy()
    });
    view.addDependent(dialog);
    dialog.open();
}
