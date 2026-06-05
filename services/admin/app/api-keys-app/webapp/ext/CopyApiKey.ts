import MessageToast from "sap/m/MessageToast";
import Context from "sap/ui/model/odata/v4/Context";

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
    try {
      const key = oBindingContext?.getProperty("key") as string | undefined;
      if (!key) {
        MessageToast.show("No API key available.");
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
      MessageToast.show("API key copied.");
    } catch {
      MessageToast.show("Copy failed.");
    }
  }
};