/**
 * Convenience event-name constants for cross-service consistency.
 *
 * Events are still typed as `string` at the call site — `tracker.track()`
 * accepts any name. This map exists so the events that NEED to match
 * across services (auth correlation, bid lifecycle, etc.) have one source
 * of truth and IDE autocomplete.
 *
 * Usage:
 *   import { Events } from '@rw3iss/tracker';
 *   tracker.track(Events.Auth.LoggedIn, { userId });
 *   tracker.track('experiment.foo', { ... });   // also fine — strings still work
 *
 * Add new domains/events here when they're shared between two or more
 * services. App-specific events (one-off page views, modals, experiments)
 * should stay as raw strings inside the consuming app's code — don't
 * pollute the shared map with them.
 */
export const Events = {
	/** Application/process lifecycle. */
	App: {
		/** Process / SPA boot. Fires once per container start (server) or page load (client). */
		Started: 'app.started',
		/** Graceful shutdown. Server-side; fires from onApplicationShutdown. */
		Stopped: 'app.stopped'
	},
	/** Authentication / session events. Match across api-server + buyer + seller for cross-service joins. */
	Auth: {
		/** Successful login (Cognito or other provider). Should carry `userId` in payload. */
		LoggedIn: 'auth.user_logged_in',
		/** Successful logout. */
		LoggedOut: 'auth.user_logged_out',
		/** Login attempt that failed (wrong password, user not found, etc. -- expected error). */
		LoginFailed: 'auth.login_failed',
		/** Login flow threw an unexpected error (network, server 500, etc.). */
		LoginError: 'auth.login_error',
		/** Account registration completed. */
		Registered: 'auth.user_registered',
		/** Email/phone verification completed. */
		Verified: 'auth.user_verified'
	},
	/** Bid lifecycle. VEN-575 diagnostic surface — keep names stable. */
	Bid: {
		/** placeBid HTTP entry — captured before any validation. */
		PlaceStarted: 'bid.place_started',
		/** Bid successfully committed to the DB. */
		PlaceCommitted: 'bid.place_committed',
		/** Bid validation/insertion failed (BadRequest, low-bid, server error). */
		PlaceRejected: 'bid.place_rejected',
		/**
		 * One or more rows in a placeBid transaction were inserted with
		 * isReserved=true. Filtering on this event is the live equivalent
		 * of the audit query that surfaced the VEN-575 cohort.
		 */
		IsReservedSet: 'bid.is_reserved_set'
	},
	/** Auction-end / winner-selection lifecycle. */
	ProductWinner: {
		/** Webhook/scheduler entry: handleCheckProductWinner started. */
		CheckTriggered: 'product_winner.check_triggered',
		/** Winner row inserted successfully. */
		Selected: 'product_winner.selected',
		/** No bids existed for the product at close time. */
		NoBids: 'product_winner.no_bids',
		/** Top bid was below the auction's reserve price; no winner. */
		ReserveNotMet: 'product_winner.reserve_not_met'
	},
	/** Generic error capture. Auto-emitted by the tracker's autoCapture. */
	Error: {
		Unhandled: 'error.unhandled',
		UnhandledRejection: 'error.unhandled_rejection'
	}
} as const;

/** Union of every event name in the {@link Events} map. */
export type EventName =
	| typeof Events.App[keyof typeof Events.App]
	| typeof Events.Auth[keyof typeof Events.Auth]
	| typeof Events.Bid[keyof typeof Events.Bid]
	| typeof Events.ProductWinner[keyof typeof Events.ProductWinner]
	| typeof Events.Error[keyof typeof Events.Error];
