/** The route the shell's Back button returns to from an object page; undefined when there is none. */
const BY_APP_KEY: Record<string, string> = {
	apiKeys: "ApiKeysList",
	awsCredentials: "AwsCredentialsList",
	sapRates: "SapCapacityUnitPriceList",
	securityEvents: "MySecurityNotificationsList",
	usage: "overview",
	config: "main",
	modelLibrary: "library",
	catalogs: "catalogs",
	groundingStores: "groundingStores",
	teams: "TeamsList",
	users: "UsersList",
	toolPolicies: "ToolPoliciesList",
	connections: "ConnectionsList"
};

/**
 * The Grounding detail routes decide by the route itself: one component serves several nav
 * entries (a job opens a store and back), so the entry that loaded it says nothing about
 * where the user came from. Every other app decides by its nav entry.
 */
export function backTargetRoute(routeName: string, appKey: string): string | undefined {
	if (routeName === "groundingJobDetail") return "groundingJobs";
	if (routeName === "groundingStoreDetail") return "groundingStores";
	return BY_APP_KEY[appKey];
}
