import InvisibleMessage from "sap/ui/core/InvisibleMessage";
import { InvisibleMessageMode } from "sap/ui/core/library";
import type JSONModel from "sap/ui/model/json/JSONModel";
import type { Translator } from "../model/api";
import { liveButton, liveStatusKey, type LiveState } from "../model/liveStatus";

/**
 * Puts what Live is doing into the view model: the button's icon, text and type, and the status line
 * in words. A change of the status line is announced to screen readers (polite), not every poll.
 */
export default class LiveStatusLine {
    private key = "";

    constructor(private readonly model: () => JSONModel, private readonly translate: () => Translator) {}

    public update(state: LiveState): void {
        const model = this.model();
        const t = this.translate();
        const button = liveButton(state.live);
        model.setProperty("/liveIcon", button.icon);
        model.setProperty("/liveText", t(button.textKey));
        model.setProperty("/liveType", button.type);
        const key = liveStatusKey(state);
        model.setProperty("/statusText", t(key));
        if (this.key !== "" && key !== this.key) InvisibleMessage.getInstance().announce(t(key), InvisibleMessageMode.Polite);
        this.key = key;
    }
}
