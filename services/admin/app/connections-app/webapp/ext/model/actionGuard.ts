/**
 * The press guard of the Connections custom actions: while an action is starting, running or has its
 * dialog open, a second press of it does nothing.
 *
 * `start` answers true when it opened a dialog that releases the key itself (afterClose); false, or a
 * throw, releases the key at once, so a failure before the dialog is open never leaves the action dead.
 */
export async function guarded(busy: Set<string>, key: string, start: () => Promise<boolean>): Promise<void> {
    if (busy.has(key)) {
        return;
    }
    busy.add(key);
    let keep = false;
    try {
        keep = await start();
    } finally {
        if (!keep) {
            busy.delete(key);
        }
    }
}
