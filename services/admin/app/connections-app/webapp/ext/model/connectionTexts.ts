/** What AdminService.testConnection returns (admin-service.cds: ConnectionTestResult). */
export type ConnectionTestResult = { ok: boolean; reason?: string | null; status?: number | null; code?: string | null };

export type SecretField = "secret" | "sessionToken";

const REASONS = ["no_credential", "unauthorized", "forbidden", "not_found", "unreachable", "timeout", "upstream_error", "gateway_unreachable", "inactive", "not_supported"];

/** The reasons whose text has the status as {0}; the other texts take no arguments, so UI5 does not format them (a straight apostrophe would be read as a quote). */
const WITH_STATUS = ["unauthorized", "forbidden", "not_found", "upstream_error"];

/** The i18n key (in the app bundle) and the message arguments ({0} = status, {1} = code) for a test result. */
export function testResultText(r: ConnectionTestResult): { key: string; args: string[] } {
    if (r.ok) {
        return { key: "test.ok", args: [] };
    }
    const key = r.reason && REASONS.includes(r.reason) ? `test.${r.reason}` : "test.unknown";
    return { key, args: WITH_STATUS.includes(r.reason ?? "") ? [r.status == null ? "" : String(r.status), r.code ?? ""] : [] };
}

/** Bedrock with access keys has a secret access key and a session token; every other credential is one secret. */
export function secretFields(providerType: string, authMode: string | null): SecretField[] {
    return providerType === "bedrock" && authMode === "access-key" ? ["secret", "sessionToken"] : ["secret"];
}

/** The i18n key of the secret field's label. */
export function secretLabelKey(providerType: string, authMode: string | null): string {
    if (providerType === "azure-openai" && authMode === "entra-client-secret") {
        return "credential.clientSecret";
    }
    if (providerType === "bedrock") {
        return authMode === "access-key" ? "credential.secretAccessKey" : "credential.bedrockApiKey";
    }
    return "credential.apiKey";
}

/** The model family a new model of this provider type starts with (A's default per type). */
export function defaultFamily(providerType: string): "openai" | "claude" {
    return providerType === "azure-openai" || providerType === "openai" ? "openai" : "claude";
}

/** The setCredential refusals the dialog shows in its own words (server code → app bundle key); others keep the server text. */
export const CREDENTIAL_ERROR_KEYS: Readonly<Record<string, string>> = {
    credential_key_missing: "credential.error.keyMissing",
    secret_required: "credential.required",
    session_token_not_applicable: "credential.error.sessionTokenNotApplicable",
    connection_not_found: "credential.error.notFound",
    // sap-ai-core: the server's parser message (it names a field, never a value) is shown as the detail
    service_key_invalid: "serviceKey.error.invalid",
    // sap-ai-core: the active connection takes a rotated key of its own tenant only
    tenant_mismatch: "serviceKey.error.tenantMismatch"
};

/** The activate/deactivate refusals shown in the app's words; others keep the server text. */
export const ACTIVATION_ERROR_KEYS: Readonly<Record<string, string>> = {
    test_required: "activation.error.testRequired",
    no_credential: "activation.error.noCredential",
    connection_not_found: "credential.error.notFound"
};

/** The bundle key of a server code in `keys` (the OData V4 error carries the code in `error.code`), or null. */
function errorKey(e: unknown, keys: Readonly<Record<string, string>>): string | null {
    const code = (e as { error?: { code?: unknown } } | null | undefined)?.error?.code;
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(keys, code) ? keys[code] : null;
}

/** The bundle key for a failed setCredential call, or null. */
export function credentialErrorKey(e: unknown): string | null {
    return errorKey(e, CREDENTIAL_ERROR_KEYS);
}

/** The bundle key for a failed activate or deactivate call, or null. */
export function activationErrorKey(e: unknown): string | null {
    return errorKey(e, ACTIVATION_ERROR_KEYS);
}

/** The longest service key the setCredential action takes (its secret parameter is a String(8000)). */
export const SERVICE_KEY_MAX_LENGTH = 8000;

/** The service key to send: the pasted text, else the file's, trimmed; null when there is none. */
export function serviceKeyText(fileText: string | null, pasted: string): string | null {
    const text = pasted.trim() || (fileText ?? "").trim();
    return text || null;
}

/** The bundle key of what keeps a service key from being sent, or null when it can be. */
export function serviceKeyProblem(text: string | null): string | null {
    if (!text) {
        return "serviceKey.required";
    }
    return text.length > SERVICE_KEY_MAX_LENGTH ? "serviceKey.error.tooLarge" : null;
}

/** The model families of the Add Model dialog: the codes stay the keys, the label is a bundle text. */
export function familyOptions(): { key: "openai" | "claude"; textKey: string }[] {
    return (["openai", "claude"] as const).map((key) => ({ key, textKey: `addModel.family.${key}` }));
}
