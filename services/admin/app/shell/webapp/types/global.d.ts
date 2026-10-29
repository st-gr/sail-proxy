// Global type declarations for UShell mock services

declare global {
    /**
     * The part of sap.ushell the shell provides itself (Component.setupUShellServices) when no
     * launchpad is present. The UI5 types describe the real namespace, which this is not.
     */
    interface UShellStandIn {
        Container?: {
            getServiceAsync?: (serviceName: string) => Promise<unknown>;
            getService?: (serviceName: string) => any;
        };
    }

    interface Window {
        sap?: {
            ushell?: UShellStandIn;
        };
    }
}

export {};