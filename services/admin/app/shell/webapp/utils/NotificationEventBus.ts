import EventBus from "sap/ui/core/EventBus";
import Log from "sap/base/Log";

/**
 * Shared notification event bus for real-time updates across shell and apps
 * Provides a centralized pub/sub mechanism for notification state changes
 */
class NotificationEventBus {
	private static instance: NotificationEventBus;
	private eventBus: EventBus;
	private throttleTimeouts: Map<string, number>;
	private sseConnection?: EventSource;
	private reconnectAttempts: number = 0;
	private maxReconnectAttempts: number = 5;

	private constructor() {
		this.eventBus = new EventBus();
		this.throttleTimeouts = new Map();
		this.initializeSSE();
	}

	public static getInstance(): NotificationEventBus {
		if (!NotificationEventBus.instance) {
			NotificationEventBus.instance = new NotificationEventBus();
		}
		return NotificationEventBus.instance;
	}

	/**
	 * Publish notification change event
	 */
	public publishNotificationChange(data: {
		action: "marked_seen" | "marked_unseen" | "dismissed" | "snoozed" | "pinned" | "deleted" | "bulk_action";
		notificationIds: string[];
		source: string;
		userId?: string;
	}): void {
		Log.info(`Publishing notification change: ${data.action}, IDs: ${data.notificationIds?.length || 0}, source: ${data.source}`, "", "NotificationEventBus");
		
		this.eventBus.publish("notifications", "changed", data);
	}

	/**
	 * Subscribe to notification changes with optional throttling
	 */
	public subscribeToNotificationChanges(
		callback: (data: any) => void,
		context: any,
		throttleMs: number = 300
	): void {
		if (throttleMs > 0) {
			// Throttled version
			const throttledCallback = (channelId: string, eventId: string, data: any) => {
				const key = `${context.getId ? context.getId() : 'unknown'}_notification_refresh`;
				
				// Clear existing timeout
				if (this.throttleTimeouts.has(key)) {
					clearTimeout(this.throttleTimeouts.get(key)!);
				}
				
				// Set new timeout
				const timeoutId = setTimeout(() => {
					callback.call(context, data);
					this.throttleTimeouts.delete(key);
				}, throttleMs);
				
				this.throttleTimeouts.set(key, timeoutId);
			};
			
			this.eventBus.subscribe("notifications", "changed", throttledCallback, context);
		} else {
			// Direct callback
			this.eventBus.subscribe("notifications", "changed", callback, context);
		}

		Log.info(`Subscribed to notification changes with ${throttleMs}ms throttle`, "", "NotificationEventBus");
	}

	/**
	 * Unsubscribe from notification changes
	 */
	public unsubscribeFromNotificationChanges(callback: (data: any) => void, context: any): void {
		this.eventBus.unsubscribe("notifications", "changed", callback, context);
		
		// Clean up any pending throttled callbacks for this context
		const key = `${context.getId ? context.getId() : 'unknown'}_notification_refresh`;
		if (this.throttleTimeouts.has(key)) {
			clearTimeout(this.throttleTimeouts.get(key)!);
			this.throttleTimeouts.delete(key);
		}

		Log.info("Unsubscribed from notification changes", "", "NotificationEventBus");
	}

	/**
	 * Publish bulk operation completion
	 */
	public publishBulkOperation(data: {
		action: "bulk_mark_seen" | "bulk_delete";
		count: number;
		source: string;
	}): void {
		Log.info(`Publishing bulk operation: ${data.action}, count: ${data.count}, source: ${data.source}`, "", "NotificationEventBus");
		
		this.eventBus.publish("notifications", "bulk_changed", data);
	}

	/**
	 * Subscribe to bulk operations
	 */
	public subscribeToBulkOperations(
		callback: (data: any) => void,
		context: any,
		throttleMs: number = 500
	): void {
		if (throttleMs > 0) {
			const throttledCallback = (channelId: string, eventId: string, data: any) => {
				const key = `${context.getId ? context.getId() : 'unknown'}_bulk_refresh`;
				
				if (this.throttleTimeouts.has(key)) {
					clearTimeout(this.throttleTimeouts.get(key)!);
				}
				
				const timeoutId = setTimeout(() => {
					callback.call(context, data);
					this.throttleTimeouts.delete(key);
				}, throttleMs);
				
				this.throttleTimeouts.set(key, timeoutId);
			};
			
			this.eventBus.subscribe("notifications", "bulk_changed", throttledCallback, context);
		} else {
			this.eventBus.subscribe("notifications", "bulk_changed", callback, context);
		}

		Log.info(`Subscribed to bulk operations with ${throttleMs}ms throttle`, "", "NotificationEventBus");
	}

	/**
	 * Unsubscribe from bulk operations
	 */
	public unsubscribeFromBulkOperations(callback: (data: any) => void, context: any): void {
		this.eventBus.unsubscribe("notifications", "bulk_changed", callback, context);
		
		// Clean up any pending throttled callbacks for this context
		const key = `${context.getId ? context.getId() : 'unknown'}_bulk_refresh`;
		if (this.throttleTimeouts.has(key)) {
			clearTimeout(this.throttleTimeouts.get(key)!);
			this.throttleTimeouts.delete(key);
		}

		Log.info("Unsubscribed from bulk operations", "", "NotificationEventBus");
	}

	/**
	 * Initialize Server-Sent Events connection for real-time backend push
	 */
	private initializeSSE(): void {
		try {
			// Connect to SSE endpoint
			this.sseConnection = new EventSource('/api/notifications/stream', {
				withCredentials: true
			});

			this.sseConnection.onopen = () => {
				Log.info("SSE connection established", "", "NotificationEventBus");
				this.reconnectAttempts = 0;
			};

			this.sseConnection.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					Log.info(`Received SSE message: ${event.type}`, JSON.stringify(data), "NotificationEventBus");
					
					// Publish to local event bus for components to pick up
					this.eventBus.publish("notifications", "sse_event", {
						type: event.type,
						data: data,
						source: "backend-sse"
					});
				} catch (error) {
					Log.error("Failed to process SSE message", error as string, "NotificationEventBus");
				}
			};

			// Handle specific SSE event types
			this.sseConnection.addEventListener('new-security-event', (event) => {
				try {
					const data = JSON.parse(event.data);
					Log.info("New security event received via SSE", JSON.stringify(data), "NotificationEventBus");
					
					// Publish as notification change to trigger refresh
					this.eventBus.publish("notifications", "changed", {
						action: "new_security_event",
						notificationIds: [], // New event, no specific IDs yet
						source: "backend-sse",
						eventData: data
					});
				} catch (error) {
					Log.error("Failed to process new security event", error as string, "NotificationEventBus");
				}
			});

			this.sseConnection.addEventListener('connected', (event) => {
				try {
					const data = JSON.parse(event.data);
					Log.info(`SSE connected for user: ${data.userId}`, "", "NotificationEventBus");
				} catch (error) {
					Log.warn("SSE connected but failed to parse data", error as string, "NotificationEventBus");
				}
			});

			this.sseConnection.onerror = (error) => {
				Log.error("SSE connection error", error as string, "NotificationEventBus");
				this.handleSSEReconnection();
			};

		} catch (error) {
			Log.error("Failed to initialize SSE connection", error as string, "NotificationEventBus");
			this.handleSSEReconnection();
		}
	}

	/**
	 * Handle SSE reconnection with exponential backoff
	 */
	private handleSSEReconnection(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			Log.error(`Max SSE reconnection attempts (${this.maxReconnectAttempts}) reached`, "", "NotificationEventBus");
			return;
		}

		this.reconnectAttempts++;
		const delay = Math.pow(2, this.reconnectAttempts) * 1000; // Exponential backoff

		Log.info(`Attempting SSE reconnection in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`, "", "NotificationEventBus");

		setTimeout(() => {
			if (this.sseConnection) {
				this.sseConnection.close();
			}
			this.initializeSSE();
		}, delay);
	}

	/**
	 * Get SSE connection status
	 */
	public getSSEStatus(): { connected: boolean; readyState: number } {
		return {
			connected: this.sseConnection?.readyState === EventSource.OPEN,
			readyState: this.sseConnection?.readyState || -1
		};
	}

	/**
	 * Cleanup on service shutdown
	 */
	public shutdown(): void {
		// Close SSE connection
		if (this.sseConnection) {
			this.sseConnection.close();
		}

		// Clear all throttle timeouts
		for (const timeoutId of this.throttleTimeouts.values()) {
			clearTimeout(timeoutId);
		}
		this.throttleTimeouts.clear();

		Log.info('NotificationEventBus shut down', "", "NotificationEventBus");
	}
}

export default NotificationEventBus;