import { messagesOf } from "./api";
import type { ApiResult } from "./api";

/** What settling an action needs from the screen: reading the list again and the three ways to tell the user. */
export interface SettleUi {
    reload(): Promise<void>;
    error(message: string): void;
    warning(message: string): void;
    success(message: string, dialog: boolean): void;
}

/**
 * After an upload, enable, disable or removal. A refusal is shown at once and the list follows.
 * A success is announced only after the list was read again, so the message never sits above a
 * table that still shows the previous state.
 */
export async function settleAction(result: ApiResult, success: string, ui: SettleUi, fallbackError: string, alwaysDialog = false): Promise<void> {
    if (!result.ok) {
        ui.error(result.error?.message ?? fallbackError);
        await ui.reload();
        return;
    }
    await ui.reload();
    const warnings = messagesOf(result.body);
    if (warnings.length) ui.warning([success, ...warnings].join("\n\n"));
    else ui.success(success, alwaysDialog);
}
