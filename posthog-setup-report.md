<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog into the LeadCheck Node.js/Express application. The `posthog-node` SDK was installed and configured in `server.js` with full event tracking, user identification, and error capture across both API routes.

## Changes made

**`server.js`**
- Imported and initialized `PostHog` client using `POSTHOG_API_KEY` and `POSTHOG_HOST` environment variables, with `enableExceptionAutocapture: true`
- Added graceful shutdown handlers (`SIGINT`/`SIGTERM`) to flush all queued events before exit
- **`POST /api/analyze`**: captures `website analyzed` (with `url` and `score`) on success, and `website analysis failed` (with `url` and error message) on failure. Uses `X-PostHog-Distinct-ID` and `X-PostHog-Session-ID` headers to correlate with client-side sessions.
- **`POST /api/lead-capture`**: calls `posthog.identify()` with the lead's email as `distinctId` (plus name, phone, business name, website) on every request. Captures `lead captured` (with `website`, `score`, and `lead_only` flag) on success, and `lead capture failed` with exception capture on failure.

**`.env`**
- Created with `POSTHOG_API_KEY` and `POSTHOG_HOST`

## Events instrumented

| Event name | Description | File |
|---|---|---|
| `website analyzed` | Fired when a website is successfully analyzed via `/api/analyze`. Includes `url` and `score`. | `server.js` |
| `website analysis failed` | Fired when website analysis throws an error. Includes `url` and `error` message. | `server.js` |
| `lead captured` | Core conversion event. Fired when a lead is successfully submitted. Includes `website`, `score`, and `lead_only` flag. | `server.js` |
| `lead capture failed` | Fired when the GHL webhook or analysis step fails during lead capture. Includes `website` and `error`. | `server.js` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics dashboard](/dashboard/1588957)
- [Website Analyses Over Time](/insights/FK2v0z0B) — daily count of website analyses run
- [Lead Captures Over Time](/insights/Hr1gye2Y) — daily count of successful lead captures
- [Analysis to Lead Conversion Funnel](/insights/uVCuyyeC) — conversion rate from analysis to lead capture
- [Errors & Failures Over Time](/insights/rgTV4KTG) — analysis and lead capture failures per day
- [Total Leads Captured](/insights/ABA8YTwZ) — bold number: total leads in last 30 days

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
