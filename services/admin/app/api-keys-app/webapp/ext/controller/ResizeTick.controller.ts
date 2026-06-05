import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Log from "sap/base/Log";
import type Context from "sap/ui/model/odata/v4/Context";

// Top-level log to confirm module loading
Log.info("[ResizeTick] Module loaded");

/**
 * Controller extension to fix floating footer positioning in embedded scenarios
 * Uses onAfterBinding hook to trigger resize after data binding completes
 */
export default ControllerExtension.extend("admin.app.ext.controller.ResizeTick", {
	// Must be "override", not "overrides" for FE V4
	override: {
		// Hook group corresponds to sap.fe.core.controllerextensions.Routing
		routing: {
			/**
			 * Called after route binding is complete but before full render
			 * This is the optimal time to trigger layout recalculation for floating footers
			 */
			onAfterBinding(this: any, _ctx?: Context) {
				// Trigger resize tick after binding to fix footer positioning
				setTimeout(() => {
					window.dispatchEvent(new Event("resize"));
					Log.info("[FE Extension] onAfterBinding resize tick sent");
				}, 0);
			}
		},

		// Nice fallback that fires once the OP content is ready
		onPageReady() {
			Log.info("[FE Extension] onPageReady");
		}
	}
});