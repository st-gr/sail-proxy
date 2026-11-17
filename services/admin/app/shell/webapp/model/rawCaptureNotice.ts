/**
 * Pure logic of the orange bar that shows on every cockpit page while a raw capture runs (spec 4.2):
 * from activeRawCapture() (AdminService, admin only), how many keys and addresses are captured, who
 * started the sessions and when the first one ends. No UI5 imports.
 */

export interface ActiveRawCapture { ID: string; endsAt: string; startedBy: string; keyCount: number; addressCount: number }
export type Translator = (key: string, args?: (string | number)[]) => string;

/** The function the shell polls, every minute, for administrators only. */
export const ACTIVE_RAW_CAPTURE_URL = '/odata/v4/admin/activeRawCapture()';

/** English defaults, byte-identical to the bundle: jest gets them, the controller injects the bundle. */
const EN_TEXTS: Record<string, string> = {
	'rawCapture.one': 'A raw capture is running (API keys: {0}, e-mail addresses: {1}), started by {2}. It ends at {3}.',
	'rawCapture.many': '{0} raw captures are running (API keys: {1}, e-mail addresses: {2}), started by {3}. The first ends at {4}.'
};
const defaultTranslate: Translator = (key, args) => {
	const pattern = EN_TEXTS[key] ?? key;
	return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

export function rawCaptureNotice(
	active: ActiveRawCapture[] | null | undefined,
	now: Date,
	t: Translator = defaultTranslate,
	formatTime: (iso: string) => string = (iso) => iso
): { visible: boolean; text: string } {
	const running = (Array.isArray(active) ? active : [])
		.filter((s) => s && Date.parse(s.endsAt) > now.getTime())
		.sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
	if (!running.length) return { visible: false, text: '' };
	const keys = running.reduce((sum, s) => sum + count(s.keyCount), 0);
	const addresses = running.reduce((sum, s) => sum + count(s.addressCount), 0);
	const who = [...new Set(running.map((s) => String(s.startedBy ?? '')).filter((w) => w !== ''))].join(', ');
	const end = formatTime(running[0].endsAt);
	const text = running.length === 1
		? t('rawCapture.one', [keys, addresses, who, end])
		: t('rawCapture.many', [running.length, keys, addresses, who, end]);
	return { visible: true, text };
}
