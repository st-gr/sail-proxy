import MessageBox from "sap/m/MessageBox";
import EventBus from "sap/ui/core/EventBus";
import type JSONModel from "sap/ui/model/json/JSONModel";
import type { LogsApi, Translator } from "../model/api";
import { deleteOutcome, type DeleteWhat } from "../model/deleteNow";

/**
 * Published after a delete succeeded, with { what, source } (source: the DeleteNow that deleted), so
 * that the other tab's list reads again (PayloadTraces.controller.ts, GatewayLog.controller.ts).
 */
export const STORED_LOGS_DELETED = { channel: "admin.logs", event: "storedDeleted" };

/**
 * "Delete now": asks what to delete (the stored log, the payload traces, or both; Cancel is the
 * default), then has the service delete it. While the question is open or the call runs, a second
 * press does nothing; the button is disabled and the table shows busy until the answer is there. A
 * success reloads the list (Live keeps its state); a failure shows the service's message and leaves
 * the list as it is. The Gateway log and the Payload Traces tab each have one.
 */
export default class DeleteNow {
    private open = false;

    constructor(
        private readonly api: () => LogsApi | null,
        private readonly translate: () => Translator,
        private readonly model: () => JSONModel,
        private readonly locale: () => string,
        private readonly reload: () => Promise<void>
    ) {}

    public ask(): void {
        if (this.open || !this.api()) return;
        this.open = true;
        const t = this.translate();
        const choices: [string, DeleteWhat][] = [[t("deleteChoiceLog"), "log"], [t("deleteChoiceTraces"), "traces"], [t("deleteChoiceAll"), "all"]];
        MessageBox.warning(t("deleteConfirmText"), {
            title: t("deleteConfirmTitle"),
            actions: [...choices.map(([text]) => text), MessageBox.Action.CANCEL],
            emphasizedAction: MessageBox.Action.CANCEL,
            initialFocus: MessageBox.Action.CANCEL,
            onClose: (chosen: unknown) => {
                const what = choices.find(([text]) => text === chosen)?.[1];
                if (what) void this.run(what);
                else this.open = false;
            }
        });
    }

    private async run(what: DeleteWhat): Promise<void> {
        const model = this.model();
        model.setProperty("/deleting", true);
        model.setProperty("/busy", true);
        model.setProperty("/deleteResult", "");
        const number = new Intl.NumberFormat(this.locale());
        const outcome = deleteOutcome(await this.api()!.deleteStoredLogs(what), what, this.translate(), (n) => number.format(n));
        model.setProperty("/deleting", false);
        model.setProperty("/busy", false);
        this.open = false;
        if (!outcome.ok) {
            MessageBox.error(outcome.text);
            return;
        }
        model.setProperty("/deleteResult", outcome.text);
        EventBus.getInstance().publish(STORED_LOGS_DELETED.channel, STORED_LOGS_DELETED.event, { what, source: this });
        await this.reload();
    }
}
