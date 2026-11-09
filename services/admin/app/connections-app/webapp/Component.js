sap.ui.define(
    // FieldBaseDelegate: the list report focuses the first filter field on page ready; the field's delegate must already be loaded or UI5 throws
    ["sap/fe/core/AppComponent", "sap/fe/macros/field/FieldBaseDelegate"],
    function (Component) {
        "use strict";

        return Component.extend("admin.connections.Component", {
            metadata: {
                manifest: "json"
            }
        });
    }
);
