import View from "sap/ui/core/mvc/View";
import type IconTabBar from "sap/m/IconTabBar";
import type ManagedObject from "sap/ui/base/ManagedObject";

/** The tabs of view/Logs.view.xml: their keys and the ids of the views they hold. */
const TAB_VIEWS = { log: "gatewayLogView", traces: "payloadTracesView" } as const;
export type LinkedTab = keyof typeof TAB_VIEWS;

/** The Logs view that holds a tab's view: its nearest enclosing view. */
function logsView(tabView: View): View | null {
    let parent: ManagedObject | null = tabView.getParent();
    while (parent && !(parent instanceof View)) parent = parent.getParent();
    return parent instanceof View ? parent : null;
}

/**
 * Shows another tab (the links between a request's log lines and its payload trace) and returns the
 * controller of the view it holds; null when the page is not built as expected.
 */
export function showTab<T>(fromView: View, tab: LinkedTab): T | null {
    const logs = logsView(fromView);
    const tabs = logs?.byId("logsTabs") as IconTabBar | undefined;
    const target = logs?.byId(TAB_VIEWS[tab]) as View | undefined;
    if (!tabs || !target) return null;
    tabs.setSelectedKey(tab);
    return target.getController() as unknown as T;
}
