import MessageToast from "sap/m/MessageToast";
import Context from "sap/ui/model/odata/v4/Context";
import ResourceBundle from "sap/base/i18n/ResourceBundle";

let bundlePromise: Promise<ResourceBundle> | undefined;

/** The app's i18n bundle, loaded once for the user's language. */
function getBundle(): Promise<ResourceBundle> {
  if (!bundlePromise) {
    bundlePromise = ResourceBundle.create({
      bundleName: "admin.app.i18n.i18n",
      async: true,
      supportedLocales: ["", "de", "es", "fr", "it", "nl", "pt"],
      fallbackLocale: ""
    }) as Promise<ResourceBundle>;
  }
  return bundlePromise;
}

/**
 * Custom action handlers for API key copy functionality
 */
export default {
  // Keep it simple: visible in both display and edit (adjust if you want)
  isVisible: function (_ctx: Context): boolean {
    return true;
  },

  // Header action handler (existing)
  onCopyApiKey: async function (oBindingContext: Context): Promise<void> {
    let loaded: ResourceBundle | undefined;
    try {
      const bundle = loaded = await getBundle();
      const key = oBindingContext?.getProperty("key") as string | undefined;
      if (!key) {
        MessageToast.show(bundle.getText("noApiKeyAvailable") as string);
        return;
      }

      try {
        await navigator.clipboard.writeText(key);
      } catch {
        // Fallback for environments without Clipboard API (older browsers, http)
        const ta = document.createElement("textarea");
        ta.value = key;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      MessageToast.show(bundle.getText("apiKeyCopied") as string);
    } catch (error) {
      MessageToast.show(loaded ? loaded.getText("copyFailed") as string : String(error));
    }
  }
};