# Seven-Day Trial Broadcast

This one-time broadcast is prepared but should not send until explicitly triggered.

Regular outbound emails remain paused with:

```bash
OUTBOUND_EMAILS_PAUSED=true
```

The broadcast can bypass that pause only when the protected send command includes the required confirmation phrase.

## Campaign

- Campaign: `seven_day_trial_broadcast`
- Step: `seven_day_trial_offer_2026_08`
- Subject: `7 Days to Close Your Next Website Project`
- CTA URL: `/app/billing?trial=7-day`
- Recipient source: Supabase Auth users with valid email addresses
- Skips: deleted users, duplicate emails, unsubscribed emails, and users already sent this campaign

## Copy

```text
Hi {{first_name}},

We've unlocked a 7-day free trial on your Website Strategy Scan account.

For the next seven days, you'll have full access to everything the platform offers--so you can use it exactly as you would with a paid subscription.

Here's my recommendation:

Don't test it on your own website.

Pick a real prospect you're actively trying to close this week.

That's where Website Strategy Scan delivers the most value.

start your free 7 day free trial
```

## Dry Run

Use this first. It does not send email.

```bash
curl -X POST "https://scanner.wstrategiescanada.ca/api/email/broadcast/seven-day-trial/run" \
  -H "Content-Type: application/json" \
  -H "x-email-test-secret: YOUR_EMAIL_TEST_OR_LIFECYCLE_SECRET" \
  --data '{"dryRun":true,"limit":500}'
```

Check `eligible`, `would_send`, `skipped`, and `sample_recipients`.

## Send

Only run this when the trial offer is ready to go live.

```bash
curl -X POST "https://scanner.wstrategiescanada.ca/api/email/broadcast/seven-day-trial/run" \
  -H "Content-Type: application/json" \
  -H "x-email-test-secret: YOUR_EMAIL_TEST_OR_LIFECYCLE_SECRET" \
  --data '{"send":true,"confirm":"send-seven-day-trial","limit":500}'
```

Successful sends are recorded in `lifecycle_email_events`, so rerunning the command skips anyone who already received the email.

## Before Sending

Confirm the product and billing flow actually enables the promised 7-day full-access trial before sending this campaign.
