import Fragment from "sap/ui/core/Fragment";
import JSONModel from "sap/ui/model/json/JSONModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import ResourceBundle from "sap/base/i18n/ResourceBundle";
import { ValueState } from "sap/ui/core/library";
import type ExtensionAPI from "sap/fe/core/ExtensionAPI";
import type Dialog from "sap/m/Dialog";
import type Input from "sap/m/Input";
import type ComboBox from "sap/m/ComboBox";
import type FileUploader from "sap/ui/unified/FileUploader";
import type Element from "sap/ui/core/Element";
import type ODataContextBinding from "sap/ui/model/odata/v4/ODataContextBinding";
import type Context from "sap/ui/model/odata/v4/Context";
import {
    type ConnectionTestResult, activationErrorKey, credentialErrorKey, defaultFamily, familyOptions, secretFields, secretLabelKey,
    serviceKeyProblem, serviceKeyText, SERVICE_KEY_MAX_LENGTH, testResultText
} from "../model/connectionTexts";
import { guarded } from "../model/actionGuard";

let bundlePromise: Promise<ResourceBundle> | undefined;
/** An action that is running or has its dialog loading or open: a second press of it does nothing. */
const opening = new Set<string>();

/** The app's i18n bundle, loaded once for the user's language; a failed load is tried again on the next press. */
function getBundle(): Promise<ResourceBundle> {
    if (!bundlePromise) {
        bundlePromise = ResourceBundle.create({
            bundleName: "admin.connections.i18n.i18n",
            async: true,
            supportedLocales: ["", "de", "es", "fr", "it", "nl", "pt"],
            fallbackLocale: ""
        }) as Promise<ResourceBundle>;
        const pending = bundlePromise;
        pending.catch(() => {
            if (bundlePromise === pending) bundlePromise = undefined;
        });
    }
    return bundlePromise;
}

/** A control of a loaded fragment by the id it has in the fragment file. */
function part<T extends Element>(dialog: Dialog, id: string): T {
    return dialog.findAggregatedObjects(true, (e) => e.getId().endsWith(`--${id}`))[0] as T;
}

/** The refresh after an action: the named properties/navigation of the page context, else the whole context. */
async function refresh(context: Context, paths: any[]): Promise<void> {
    try {
        await context.requestSideEffects(paths);
    } catch (e) {
        context.refresh();
    }
}

/**
 * Custom header actions of the connection object page. FE calls them with the page's ExtensionAPI
 * as `this`, which gives the edit flow (the generic way to invoke a bound action, with FE's busy
 * handling and error messages).
 */
export default {
    /** Test: the result's reason code becomes a translated text. */
    onTestConnection: async function (this: ExtensionAPI, context: Context): Promise<void> {
        await guarded(opening, "test", async () => {
            const bundle = await getBundle();
            let returned: Context | undefined;
            try {
                returned = (await this.getEditFlow().invokeAction("AdminService.testConnection", {
                    contexts: context,
                    skipParameterDialog: true
                })) as Context;
            } catch (e) {
                // The call itself failed: FE has shown the server's message, nothing to add
            }
            if (returned) {
                const result = returned.getObject() as ConnectionTestResult;
                const { key, args } = testResultText(result);
                const text = (args.length > 0 ? bundle.getText(key, args) : bundle.getText(key)) as string;
                if (result.ok) {
                    MessageToast.show(text);
                } else {
                    MessageBox.error(text);
                }
            }
            await refresh(context, [{ $PropertyPath: "lastTestAt" }, { $PropertyPath: "lastTestResult" }]);
            return false;
        });
    },

    /** Set credential: masked inputs; the secret goes from the control into the action and nowhere else. */
    onSetCredential: async function (this: ExtensionAPI, context: Context): Promise<void> {
        await guarded(opening, "credential", () => openCredentialDialog(this, context));
    },

    /** Add model: the provider's model names are offered; the box stays free text if the list cannot be fetched. */
    onAddModel: async function (this: ExtensionAPI, context: Context): Promise<void> {
        await guarded(opening, "addModel", () => openAddModelDialog(this, context));
    },

    /** SAP AI Core: the service key from a file or pasted; like the credential, it goes into the action and nowhere else. */
    onSetServiceKey: async function (this: ExtensionAPI, context: Context): Promise<void> {
        await guarded(opening, "serviceKey", () => openServiceKeyDialog(this, context));
    },

    /** SAP AI Core: makes this connection the installation's SAP target, after a confirmation (every gateway switches). */
    onActivate: async function (this: ExtensionAPI, context: Context): Promise<void> {
        await guarded(opening, "activation", () => switchTarget(context, "activate"));
    },

    /** SAP AI Core: the gateways return to the environment's key. */
    onDeactivate: async function (this: ExtensionAPI, context: Context): Promise<void> {
        await guarded(opening, "activation", () => switchTarget(context, "deactivate"));
    }
};

/** Runs activate or deactivate (activate after the critical confirmation); false: the guard is released at once. */
async function switchTarget(context: Context, action: "activate" | "deactivate"): Promise<boolean> {
    const bundle = await getBundle();
    if (action === "activate") {
        const confirmed = await new Promise<boolean>((resolve) => {
            MessageBox.warning(bundle.getText("activate.confirm") as string, {
                title: bundle.getText("activate.confirmTitle") as string,
                actions: [bundle.getText("activate") as string, MessageBox.Action.CANCEL],
                emphasizedAction: bundle.getText("activate") as string,
                onClose: (choice: unknown) => resolve(choice === bundle.getText("activate"))
            });
        });
        if (!confirmed) {
            return false;
        }
    }
    const operation = context.getModel().bindContext(`AdminService.${action}(...)`, context) as ODataContextBinding;
    try {
        await operation.invoke();
        MessageToast.show(bundle.getText(`${action}.done`) as string);
    } catch (e) {
        const key = activationErrorKey(e);
        MessageBox.error(key ? (bundle.getText(key) as string) : (e as Error).message);
    } finally {
        operation.destroy();
    }
    // This page's flag first: the model refresh below rereads the list but not this page's context.
    // Activate deactivates the other connection, and the list shows both: every binding rereads, the list
    // included. A model with pending changes elsewhere refuses that; this page's flag is current anyway.
    await refresh(context, [{ $PropertyPath: "isActive" }]);
    try {
        context.getModel().refresh();
    } catch (e) {
        // pending changes elsewhere: only the list stays stale until its next read
    }
    return false;
}

/** Reads a chosen file as text, in the browser. */
function readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
    });
}

/** Opens the service-key dialog; true once it is open (its afterClose releases the guard). */
async function openServiceKeyDialog(api: ExtensionAPI, context: Context): Promise<boolean> {
    const bundle = await getBundle();
    const state = new JSONModel({ busy: false });
    let dialog: Dialog;
    // The file's text lives here only, never in a model; reads that finish after a newer choice are dropped.
    let fileText: string | null = null;
    let reading = 0;
    const uploader = (): FileUploader => part<FileUploader>(dialog, "file");
    const paste = (): Input => part<Input>(dialog, "paste");
    const showProblem = (key: string): void => {
        const target = paste();
        target.setValueState(ValueState.Error);
        target.setValueStateText(bundle.getText(key) as string);
        target.focus();
    };
    const clearFile = (): void => {
        reading++;
        fileText = null;
        uploader()?.clear();
        uploader()?.setValueState(ValueState.None);
    };
    const clear = (): void => {
        clearFile();
        paste()?.setValue("");
    };
    const handlers = {
        onFileChange: async (event: { getParameter(name: string): unknown }): Promise<void> => {
            const file = ((event.getParameter("files") ?? []) as ArrayLike<File>)[0];
            const ticket = ++reading;
            fileText = null;
            paste().setValue("");
            paste().setValueState(ValueState.None);
            if (!file) {
                return;
            }
            // Bytes are at least as many as characters: a file within the limit is never refused here wrongly
            const tooLarge = file.size > SERVICE_KEY_MAX_LENGTH * 4;
            try {
                const text = tooLarge ? null : await readFile(file);
                if (ticket !== reading) {
                    return;
                }
                const problem = text === null ? "serviceKey.error.tooLarge" : serviceKeyProblem(text.trim() || null);
                if (problem) {
                    uploader().clear();
                    showProblem(problem);
                    return;
                }
                fileText = text;
            } catch (e) {
                if (ticket === reading) {
                    uploader().clear();
                    showProblem("serviceKey.error.unreadable");
                }
            }
        },
        onTypeMismatch: (): void => {
            clearFile();
            showProblem("serviceKey.error.notJson");
        },
        onPasteChange: (): void => {
            paste().setValueState(ValueState.None);
            if (paste().getValue()) {
                clearFile();
            }
        },
        onOk: async (): Promise<void> => {
            const secret = serviceKeyText(fileText, paste().getValue());
            const problem = serviceKeyProblem(secret);
            if (problem) {
                showProblem(problem);
                return;
            }
            // As in the credential dialog: our own binding, its parameter blanked and the binding destroyed afterwards
            const operation = context.getModel().bindContext("AdminService.setCredential(...)", context) as ODataContextBinding;
            state.setProperty("/busy", true);
            try {
                operation.setParameter("secret", secret);
                operation.setParameter("sessionToken", null);
                await operation.invoke();
                await refresh(context, [
                    { $PropertyPath: "credentialHint" }, { $PropertyPath: "credentialUpdatedAt" }, { $PropertyPath: "endpoint" },
                    { $PropertyPath: "region" }, { $PropertyPath: "clientId" }, { $PropertyPath: "tenantId" },
                    { $PropertyPath: "lastTestAt" }, { $PropertyPath: "lastTestResult" }
                ]);
                MessageToast.show(bundle.getText("serviceKey.saved") as string);
            } catch (e) {
                // service_key_invalid: the app's text, with the parser's message (a field name, never a value) as the detail
                const key = credentialErrorKey(e);
                const text = key ? (bundle.getText(key) as string) : (e as Error).message;
                MessageBox.error(text, key === "serviceKey.error.invalid" ? { details: (e as Error).message } : {});
            } finally {
                try {
                    operation.setParameter("secret", null);
                    operation.setParameter("sessionToken", null);
                    operation.destroy();
                } catch (e) {
                    // The binding is gone already: the inputs are cleared and the dialog closed all the same
                }
                clear();
                dialog.close();
            }
        },
        onCancel: (): void => {
            clear();
            dialog.close();
        },
        onAfterClose: (): void => {
            clear();
            dialog.destroy();
            opening.delete("serviceKey");
        }
    };
    dialog = (await Fragment.load({ id: "serviceKeyDialog", name: "admin.connections.ext.fragment.ServiceKeyDialog", controller: handlers })) as Dialog;
    dialog.setModel(state, "dlg");
    api.addDependent(dialog);
    dialog.open();
    return true;
}

/** Opens the credential dialog; true once it is open (its afterClose releases the guard). */
async function openCredentialDialog(api: ExtensionAPI, context: Context): Promise<boolean> {
    const bundle = await getBundle();
    const providerType = context.getProperty("providerType") as string;
    const authMode = (context.getProperty("authMode") as string | null) ?? null;
    const fields = secretFields(providerType, authMode);
    const state = new JSONModel({
        busy: false,
        help: bundle.getText("credential.help"),
        secretLabel: bundle.getText(secretLabelKey(providerType, authMode)),
        hasSessionToken: fields.includes("sessionToken")
    });
    let dialog: Dialog;
    const clear = (): void => {
        part<Input>(dialog, "secret")?.setValue("");
        part<Input>(dialog, "sessionToken")?.setValue("");
    };
    const handlers = {
        onOk: async (): Promise<void> => {
            const secret = part<Input>(dialog, "secret");
            if (!secret.getValue()) {
                secret.setValueState(ValueState.Error);
                secret.setValueStateText(bundle.getText("credential.required") as string);
                secret.focus();
                return;
            }
            // Not editFlow.invokeAction: FE keeps the binding it creates, with the parameters, for the life of
            // the page. This binding is ours: the parameters are blanked and the binding destroyed afterwards.
            const operation = context.getModel().bindContext("AdminService.setCredential(...)", context) as ODataContextBinding;
            state.setProperty("/busy", true);
            try {
                operation.setParameter("secret", secret.getValue());
                operation.setParameter("sessionToken", fields.includes("sessionToken") ? part<Input>(dialog, "sessionToken").getValue() || null : null);
                await operation.invoke();
                await refresh(context, [{ $PropertyPath: "credentialHint" }, { $PropertyPath: "credentialUpdatedAt" }]);
                MessageToast.show(bundle.getText("credential.saved") as string);
            } catch (e) {
                // A known refusal in the app's words; anything else as the server put it
                const key = credentialErrorKey(e);
                MessageBox.error(key ? (bundle.getText(key) as string) : (e as Error).message);
            } finally {
                try {
                    operation.setParameter("secret", null);
                    operation.setParameter("sessionToken", null);
                    operation.destroy();
                } catch (e) {
                    // The binding is gone already: the inputs are cleared and the dialog closed all the same
                }
                clear();
                dialog.close();
            }
        },
        onCancel: (): void => {
            clear();
            dialog.close();
        },
        onAfterClose: (): void => {
            clear();
            dialog.destroy();
            opening.delete("credential");
        }
    };
    dialog = (await Fragment.load({ id: "credentialDialog", name: "admin.connections.ext.fragment.CredentialDialog", controller: handlers })) as Dialog;
    dialog.setModel(state, "dlg");
    api.addDependent(dialog);
    dialog.open();
    return true;
}

/** Opens the Add Model dialog and fills its model list; true once it is open (its afterClose releases the guard). */
async function openAddModelDialog(api: ExtensionAPI, context: Context): Promise<boolean> {
    const bundle = await getBundle();
    const editFlow = api.getEditFlow();
    const model = context.getModel();
    const state = new JSONModel({
        busy: false,
        loading: true,
        listError: "",
        models: [] as { name: string }[],
        families: familyOptions().map((f) => ({ key: f.key, text: bundle.getText(f.textKey) })),
        family: defaultFamily(context.getProperty("providerType") as string)
    });
    let dialog: Dialog;
    const handlers = {
        onOk: async (): Promise<void> => {
            const upstream = part<ComboBox>(dialog, "upstream");
            const upstreamModel = upstream.getValue().trim();
            if (!upstreamModel) {
                upstream.setValueState(ValueState.Error);
                upstream.setValueStateText(bundle.getText("addModel.required") as string);
                upstream.focus();
                return;
            }
            const displayName = part<Input>(dialog, "displayName").getValue().trim();
            state.setProperty("/busy", true);
            try {
                await editFlow.invokeAction("AdminService.addModel", {
                    contexts: context,
                    parameterValues: [
                        { name: "upstreamModel", value: upstreamModel },
                        { name: "displayName", value: displayName || null },
                        { name: "family", value: state.getProperty("/family") }
                    ],
                    skipParameterDialog: true
                });
                await refresh(context, [{ $NavigationPropertyPath: "models" }, { $PropertyPath: "publishedModels" }]);
                MessageToast.show(bundle.getText("addModel.added", [upstreamModel]) as string);
            } catch (e) {
                // FE has shown the server's message
            } finally {
                dialog.close();
            }
        },
        onCancel: (): void => {
            dialog.close();
        },
        onAfterClose: (): void => {
            dialog.destroy();
            opening.delete("addModel");
        }
    };
    dialog = (await Fragment.load({ id: "addModelDialog", name: "admin.connections.ext.fragment.AddModelDialog", controller: handlers })) as Dialog;
    dialog.setModel(state, "dlg");
    api.addDependent(dialog);
    dialog.open();
    let op: ODataContextBinding | undefined;
    try {
        op = model.bindContext(`${context.getPath()}/AdminService.fetchModels(...)`) as ODataContextBinding;
        await op.execute();
        const names = ((op.getBoundContext()?.getObject() as { value?: string[] })?.value ?? []).map((name) => ({ name }));
        state.setProperty("/models", names);
    } catch (e) {
        state.setProperty("/listError", bundle.getText("addModel.listFailed") as string);
    } finally {
        op?.destroy();
        state.setProperty("/loading", false);
    }
    return true;
}
