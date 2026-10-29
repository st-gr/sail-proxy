/**
 * Which of several overlapping reads may still apply its answer.
 *
 * Pressing configuration A and then B starts two reads, and nothing orders their answers: A's can
 * arrive last and fill the detail page with A while B is the one selected. Each read takes a token
 * from `begin()` and applies its answer only while `isCurrent(token)` - so the last press wins,
 * whatever order the answers come in. `cancel()` retires every read in flight (the detail closed).
 *
 * It lives here rather than in the controller because this repo's jest cannot resolve `sap/*`,
 * and a rule written inside a module that imports it cannot be unit-tested.
 */
export class LatestRequest {
    private _current = 0;

    /** Starts a new read; every earlier one stops being current. */
    public begin(): number {
        return ++this._current;
    }

    /** Retires every read started so far. */
    public cancel(): void {
        this._current++;
    }

    /** Whether the read holding `token` is still the latest one. */
    public isCurrent(token: number): boolean {
        return token === this._current;
    }
}
