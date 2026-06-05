import Button from "sap/m/Button";
import MessageToast from "sap/m/MessageToast";
import FormElement from "sap/ui/layout/form/FormElement";
import Control from "sap/ui/core/Control";

/**
 * Adds a small "copy to clipboard" button next to the API Key (Full) field
 * on the Object Page. It finds the sap.ui.mdc.Field bound to 'key' and
 * appends a transparent icon button into the same FormElement.
 */
export default {
  overrides: {
    view: {
      onAfterRendering: function () {
        console.log("[CopyKey Extension] onAfterRendering called");
        // Add a short delay to ensure the view is fully rendered
        setTimeout(() => {
          this._addCopyButton();
        }, 100);
      },
      
      _addCopyButton: function () {
        console.log("[CopyKey Extension] _addCopyButton called");
        const view = this.base.getView();
        const btnId = view.createId("copyKeyBtn");

        // Prevent duplicates across re-renders or edit/display toggles
        if (view.byId(btnId)) {
          return;
        }

        // Find the MDC Field that is bound to property 'key'
        const keyField = view.findAggregatedObjects(true, function (c: Control) {
          // We're interested in sap.ui.mdc.Field with a binding to 'key'
          // Field may bind either 'value' (simple) or 'conditions' (advanced)
          const isMdcField = (c as any).isA?.("sap.ui.mdc.Field");
          if (!isMdcField) return false;

          const bi: any = (c as any).getBindingInfo?.("value") || (c as any).getBindingInfo?.("conditions");
          if (!bi) return false;

          // Try to resolve a path == 'key'
          const path =
            (bi.path as string) ||
            (Array.isArray(bi.parts) && bi.parts[0] && (bi.parts[0].path as string));

          return path === "key";
        })[0] as Control | undefined;

        if (!keyField) {
          // Could not find the field yet; try again on the next tick
          setTimeout(() => this.onAfterRendering(), 0);
          return;
        }

        // Insert the copy button into the same FormElement (same row)
        const formElement = keyField.getParent?.() as FormElement;
        if (!formElement || !formElement.isA?.("sap.ui.layout.form.FormElement")) return;

        const copyBtn = new Button(btnId, {
          icon: "sap-icon://copy",
          type: "Transparent",
          tooltip: "Copy API Key",
          press: async () => {
            try {
              const ctx = (keyField as any).getBindingContext?.();
              const fullKey: string | undefined = ctx?.getProperty("key");
              if (!fullKey) {
                MessageToast.show("No API key to copy.");
                return;
              }

              // Try modern Clipboard API first
              try {
                await navigator.clipboard.writeText(fullKey);
                MessageToast.show("API key copied.");
                return;
              } catch {
                // Fallback for environments without Clipboard API
                const ta = document.createElement("textarea");
                ta.value = fullKey;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
                MessageToast.show("API key copied.");
              }
            } catch (e) {
              MessageToast.show("Copy failed.");
            }
          }
        });

        // Add the button as an additional field in the same row
        // Insert at index 1 so it sits to the right of the value control
        const currentFields = formElement.getFields?.() || [];
        const insertIndex = Math.min(1, currentFields.length);
        formElement.insertField(copyBtn, insertIndex);
      }
    }
  }
};