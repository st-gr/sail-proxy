import Dialog from "sap/m/Dialog";
import Button from "sap/m/Button";
import VBox from "sap/m/VBox";
import Label from "sap/m/Label";
import Text from "sap/m/Text";
import Log from "sap/base/Log";

/**
 * Custom Object Page header action: "Field Help".
 *
 * Opens a dialog listing every field on the page and its explanation. The help
 * texts live on the entity properties as @Common.QuickInfo (annotations.cds) and
 * are served in the OData metadata, but Fiori Elements V4 does not surface
 * QuickInfo anywhere on the form (confirmed against the live $metadata; see also
 * the SAP Community note that QuickInfo does not render for CAP OData V4 apps).
 * Earlier attempts to inject a per-field info icon inline fought FE's generated
 * ColumnLayout (halved the input, clipped the icon, or wiped labels), so the help
 * is surfaced from one reliable header button instead. The metadata stays the
 * single source of truth: labels and texts are read back from @Common.Label and
 * @Common.QuickInfo.
 *
 * Wired as a custom header action in manifest.json (content.header.actions),
 * which invokes this with the page's binding context - the same mechanism the
 * aws-credentials-app CopyCredentials action uses.
 */

const QUICK_INFO_TERM = "@com.sap.vocabularies.Common.v1.QuickInfo";
const LABEL_TERM = "@com.sap.vocabularies.Common.v1.Label";

export default {
	onFieldHelp(oBindingContext: any): void {
		try {
			const model = oBindingContext && oBindingContext.getModel && oBindingContext.getModel();
			const metaModel = model && model.getMetaModel && model.getMetaModel();
			if (!metaModel || !oBindingContext.getPath) {
				return;
			}
			const entityMetaPath = metaModel.getMetaPath(oBindingContext.getPath());
			const entityType = metaModel.getObject(entityMetaPath + "/") || {};

			const rows: VBox[] = [];
			for (const key of Object.keys(entityType)) {
				if (key.startsWith("$")) continue;
				if (metaModel.getObject(entityMetaPath + "/" + key + "/$kind") !== "Property") continue;
				const quick = metaModel.getObject(entityMetaPath + "/" + key + QUICK_INFO_TERM);
				if (!quick) continue;
				const label = metaModel.getObject(entityMetaPath + "/" + key + LABEL_TERM) || key;
				rows.push(
					new VBox({
						items: [
							new Label({ text: String(label), design: "Bold" }),
							new Text({ text: String(quick) })
						]
					}).addStyleClass("sapUiSmallMarginBottom")
				);
			}

			if (!rows.length) {
				return;
			}

			const dialog = new Dialog({
				title: "Field Help",
				contentWidth: "34rem",
				content: [new VBox({ items: rows })],
				endButton: new Button({ text: "Close", press: () => dialog.close() }),
				afterClose: () => dialog.destroy()
			});
			// Padding belongs on the dialog's content area, not the inner VBox, so the
			// text keeps a margin from the bubble border.
			dialog.addStyleClass("sapUiContentPadding");
			dialog.open();
		} catch (e) {
			Log.error("[FieldHelp] onFieldHelp failed: " + (e as Error).message);
		}
	}
};
