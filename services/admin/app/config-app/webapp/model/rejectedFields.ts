/**
 * The form's text fields check a value's pattern and length themselves, and on a failure show the error and
 * keep the value out of the document. These are the fields in that state: the document looks valid while the
 * screen shows text that would not be saved. `marked` are the fields the schema check already reported.
 */
interface StatefulControl {
    getValueState?: () => string;
    getValueStateText?: () => string;
}

export function rejectedFields(controls: Record<string, object>, marked: string[]): string[] {
    const stateful = controls as Record<string, StatefulControl>;
    return Object.keys(stateful)
        .filter(pointer => !marked.includes(pointer) && stateful[pointer].getValueState?.() === "Error")
        .map(pointer => {
            const reason = stateful[pointer].getValueStateText?.();
            return reason ? `${pointer}: ${reason}` : pointer;
        });
}
