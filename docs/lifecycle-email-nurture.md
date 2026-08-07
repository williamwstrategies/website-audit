# Lifecycle Email Nurture

The abandoned signup lifecycle engine runs the `abandoned_signup` campaign for users who created an account, have not subscribed, and have not generated their complimentary report preview.

## Sequence

| Step | Delay | Purpose |
| --- | ---: | --- |
| `finish_setup_15m` | 15 minutes | Bring distracted users back quickly |
| `finish_setup_24h` | 24 hours | Teach the show-not-tell product idea |
| `finish_setup_3d` | 3 days | Help users visualize the sales call workflow |
| `finish_setup_5d` | 5 days | Build curiosity around common website problems |
| `finish_setup_7d` | 7 days | Show common agency use cases |
| `finish_setup_10d` | 10 days | Reframe design selling around business outcomes |
| `finish_setup_14d` | 14 days | Ask for feedback and re-engage |
| `finish_setup_21d` | 21 days | Differentiate from generic audit tools |
| `finish_setup_30d` | 30 days | Final low-pressure reminder |

## Endpoint

The existing lifecycle endpoint remains:

```bash
curl -X POST "https://scanner.wstrategiescanada.ca/api/lifecycle/abandoned-signups/run" \
  -H "Content-Type: application/json" \
  -H "x-lifecycle-secret: $LIFECYCLE_EMAIL_SECRET" \
  -d '{"dryRun":true}'
```

Dry runs scan users and return who would receive which step without calling Resend or writing delivery history.

## Automatic Scheduling

The app has an internal scheduler. Enable it in Render with:

```text
LIFECYCLE_EMAILS_ENABLED=true
LIFECYCLE_EMAIL_INTERVAL_MINUTES=15
```

If you prefer a Render Cron Job instead, keep the web service scheduler disabled and create a cron job that runs every 15 minutes:

```bash
curl -fsS -X POST "https://scanner.wstrategiescanada.ca/api/lifecycle/abandoned-signups/run" \
  -H "Content-Type: application/json" \
  -H "x-lifecycle-secret: $LIFECYCLE_EMAIL_SECRET" \
  -d '{"dryRun":false}'
```

## Test Timing

Production timings are never shortened globally. To test without waiting 30 days, explicitly allowlist test accounts:

```text
LIFECYCLE_EMAIL_TEST_RECIPIENTS=you@example.com,auth-user-id
LIFECYCLE_EMAIL_TEST_DELAYS_MINUTES=1,2,3,4,5,6,7,8,9
```

Only emails or user IDs listed in `LIFECYCLE_EMAIL_TEST_RECIPIENTS` use the accelerated delays. Everyone else uses the production timing.

## Stop Rules

The campaign stops before every send if:

- the user is subscribed or has an active/trialing Stripe subscription
- the user generated the complimentary report preview
- the user unsubscribed from lifecycle emails
- the exact campaign step has already been sent

Failures are recorded in `lifecycle_email_events` as `status = failed`, but only `status = sent` prevents future retries.
