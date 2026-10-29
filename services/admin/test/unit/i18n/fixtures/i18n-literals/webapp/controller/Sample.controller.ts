// Fixture for i18n-literals.test.ts: not compiled, only scanned.
export default class Sample {
    run(error: any, count: number) {
        // MessageToast.show("A commented-out toast");
        MessageToast.show("Saved");
        MessageToast.show(this.text("savedKey", [count]));
        MessageToast.show(`Loaded ${count} rows`);
        MessageBox.error(error?.message || "Request failed");
        MessageBox.confirm(this.getText(count > 1 ? "deleteMany" : "deleteOne"), {
            title: "Confirm deletion",
            styleClass: "sapUiSizeCompact usageDialog",
            onClose: (action: string) => {
                if (action === "OK") { void fetch("/odata/v4/admin/Things", { method: "DELETE" }); }
            }
        });
        this.byId("label").setText("Ready");
        const dialog = new Dialog({ title: "Settings", content: [new Text({ text: "Body text" })] });
        chart.setVizProperties({ title: { text: "Requests by Provider" }, valueAxis: { title: { text: "Requests" } } });
        const dataset = { name: "Provider", value: "{provider}" };
        const flag = count ? text : "fallback";
        const pattern = /"not a string"/g;
        console.log("Debug output is not user-facing");
        MessageBox.error(this.text("failed") + "\n" + (error.mode === "strict" ? error.detail : ""));
        const field = { placeholder: "formKeyPlaceholder" };
        MessageToast.show(count ? "Enabled" : "Disabled");
        MessageBox.error(error ? `Failed: ${error}` : "Failed");
        const state = new Text({ text: count ? `Yes ${count}` : "No" });
        return [dialog, dataset, flag, pattern, field, state];
    }
}
