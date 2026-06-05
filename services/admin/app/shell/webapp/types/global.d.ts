// Global type declarations for UShell mock services

declare global {
    interface Window {
        sap?: {
            ushell?: {
                Container?: {
                    getService?: (serviceName: string) => any;
                };
            };
        };
    }
}

export {};