import MessageToast from "sap/m/MessageToast";
import Context from "sap/ui/model/odata/v4/Context";

/**
 * Custom action handlers for AWS credentials copy functionality
 */
export default {
  // Keep it simple: visible in both display and edit (adjust if you want)
  isVisible: function (_ctx: Context): boolean {
    return true;
  },

  // Header action handler for copying full AWS credentials as JSON
  onCopyCredentials: async function (oBindingContext: Context): Promise<void> {
    try {
      const accessKeyId = oBindingContext?.getProperty("accessKeyId") as string | undefined;
      const secretAccessKey = oBindingContext?.getProperty("secretAccessKey") as string | undefined;
      const region = oBindingContext?.getProperty("region") as string | undefined;
      
      if (!accessKeyId || !secretAccessKey || !region) {
        MessageToast.show("AWS credentials not available.");
        return;
      }

      // Create pretty-printed JSON credentials
      const credentials = {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
        region: region
      };
      
      const credentialsJson = JSON.stringify(credentials, null, 2);

      try {
        await navigator.clipboard.writeText(credentialsJson);
      } catch {
        // Fallback for environments without Clipboard API (older browsers, http)
        const ta = document.createElement("textarea");
        ta.value = credentialsJson;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      MessageToast.show("AWS credentials copied to clipboard.");
    } catch {
      MessageToast.show("Copy failed.");
    }
  }
};