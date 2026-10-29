/**
 * The entries of the Field Help dialog (FieldHelp.ts), pure and without UI5 imports so jest tests it.
 * Fields whose help text is identical become one entry that names them together - "Spend per Day,
 * Spend per Week, Spend per Month" - instead of repeating the text once per field. A label shared by
 * several fields ("Default" under every limit) is told apart by the field it belongs to: a
 * `<field>DefaultText` property takes `<field>`'s label, giving "Default (Requests per Minute, …)".
 *
 * Byte-identical copies live in teams-app, users-app and sap-rates-app (each UI5 app is built and
 * served on its own); test/unit/ui/field-help-groups.test.ts holds them together.
 */
export interface HelpField { key: string; label: string; text?: string | null; }
export interface HelpEntry { title: string; text: string; }

const DEFAULT_TEXT_SUFFIX = "DefaultText";

export function groupFieldHelp(fields: HelpField[]): HelpEntry[] {
	const labelOf = new Map<string, string>(fields.map((f) => [f.key, f.label]));
	const labelCount = new Map<string, number>();
	for (const f of fields) labelCount.set(f.label, (labelCount.get(f.label) ?? 0) + 1);
	const qualifierOf = (f: HelpField): string | undefined =>
		f.key.endsWith(DEFAULT_TEXT_SUFFIX) ? labelOf.get(f.key.slice(0, -DEFAULT_TEXT_SUFFIX.length)) : undefined;

	// help text -> label -> the qualifiers of the fields carrying that label, all in first-seen order
	const groups = new Map<string, Map<string, string[]>>();
	for (const f of fields) {
		if (!f.text) continue;
		const labels = groups.get(f.text) ?? groups.set(f.text, new Map()).get(f.text)!;
		const qualifiers = labels.get(f.label) ?? labels.set(f.label, []).get(f.label)!;
		const q = qualifierOf(f);
		if (q && (labelCount.get(f.label) ?? 0) > 1 && !qualifiers.includes(q)) qualifiers.push(q);
	}
	return [...groups].map(([text, labels]) => ({
		text,
		title: [...labels].map(([label, qualifiers]) => (qualifiers.length ? `${label} (${qualifiers.join(", ")})` : label)).join(", ")
	}));
}
