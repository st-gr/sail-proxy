import AppComponent from "sap/fe/core/AppComponent";
// The list report focuses the first filter field on page ready; the field's delegate must already be loaded or UI5 throws
import "sap/fe/macros/field/FieldBaseDelegate";

/**
 * @namespace admin.toolpolicies
 */
export default class Component extends AppComponent {
    public static readonly metadata = {
        manifest: "json"
    };
}
