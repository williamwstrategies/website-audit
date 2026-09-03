# PitchProof Reactivation A/B Test

Experiment key: `pitchproof_reactivation_2026_09`

This experiment is for existing accounts that are not subscribed. It excludes active subscribers, trialing users, unsubscribed users, internal/test users, duplicates, suppressions, and users already enrolled in this exact experiment.

## Variants

Variant A: `reactivation_free_scans`

- Grants 10 one-time promotional prospect scans.
- No card required.
- Promotional scans are tracked separately from monthly subscription credits.
- The grant is idempotent: each eligible user can receive this offer once.

Variant B: `reactivation_discount_month`

- Sends users to Professional checkout.
- Applies the configured Stripe discount for a $10 first month.
- No trial.
- Stripe charges immediately.
- The discount is only available to users enrolled in this variant.

## Required Setup

1. Run `supabase/reactivation-ab-test.sql` in the Supabase SQL Editor.
2. Add these Render variables:

```bash
REACTIVATION_AB_TEST_ENABLED=false
REACTIVATION_AB_TEST_DRY_RUN=true
REACTIVATION_AB_TEST_EXCLUDED_EMAILS=
REACTIVATION_AB_TEST_INCOMPATIBLE_CAMPAIGNS=
STRIPE_REACTIVATION_10_PROMOTION_CODE_ID=
STRIPE_REACTIVATION_10_COUPON_ID=
STRIPE_REACTIVATION_10_PROMOTION_CODE=
```

For Variant B, configure either a Stripe promotion code ID, coupon ID, or active promotion code that makes the first Professional invoice $10.

## Internal Endpoints

All internal endpoints require the existing `x-email-test-secret` header.

Dry-run phase 1 enrollment, 10 users per variant:

```bash
curl -X POST "https://pitchproof.ca/api/internal/reactivation/enroll" \
  -H "Content-Type: application/json" \
  -H "x-email-test-secret: YOUR_EMAIL_TEST_SECRET" \
  --data '{"dryRun":true,"phase":1}'
```

Live phase 1 enrollment after enabling the flag:

```bash
curl -X POST "https://pitchproof.ca/api/internal/reactivation/enroll" \
  -H "Content-Type: application/json" \
  -H "x-email-test-secret: YOUR_EMAIL_TEST_SECRET" \
  --data '{"dryRun":false,"phase":1,"confirm":"enroll-reactivation-users"}'
```

Force-enroll a specific test user into Variant A:

```bash
curl -X POST "https://pitchproof.ca/api/internal/reactivation/enroll" \
  -H "Content-Type: application/json" \
  -H "x-email-test-secret: YOUR_EMAIL_TEST_SECRET" \
  --data '{"dryRun":false,"email":"test@example.com","forceVariant":"reactivation_free_scans","allowInternal":true}'
```

Force-enroll a specific test user into Variant B:

```bash
curl -X POST "https://pitchproof.ca/api/internal/reactivation/enroll" \
  -H "Content-Type: application/json" \
  -H "x-email-test-secret: YOUR_EMAIL_TEST_SECRET" \
  --data '{"dryRun":false,"email":"test@example.com","forceVariant":"reactivation_discount_month","allowInternal":true}'
```

Dry-run due reactivation emails:

```bash
curl -X POST "https://pitchproof.ca/api/internal/reactivation/emails/run" \
  -H "Content-Type: application/json" \
  -H "x-email-test-secret: YOUR_EMAIL_TEST_SECRET" \
  --data '{"dryRun":true,"limit":20}'
```

Send due reactivation emails:

```bash
curl -X POST "https://pitchproof.ca/api/internal/reactivation/emails/run" \
  -H "Content-Type: application/json" \
  -H "x-email-test-secret: YOUR_EMAIL_TEST_SECRET" \
  --data '{"dryRun":false,"limit":20,"confirm":"send-reactivation-email-sequence"}'
```

Inspect one user:

```bash
curl "https://pitchproof.ca/api/internal/reactivation/state?email=test@example.com" \
  -H "x-email-test-secret: YOUR_EMAIL_TEST_SECRET"
```

View experiment summary:

```bash
curl "https://pitchproof.ca/api/internal/reactivation/summary" \
  -H "x-email-test-secret: YOUR_EMAIL_TEST_SECRET"
```

## Rollout

Phase 1:

- Enroll 20 users total.
- Use `phase: 1` for 10 users in Variant A and 10 users in Variant B.
- Send only after reviewing the dry run.

Phase 2:

- Enroll 100 users total.
- Use `phase: 2` for 50 users per variant.

Phase 3:

- Enroll the remaining eligible users after confirming no delivery, support, billing, or scanner issues.

## Tracked Events

- `reactivation_email_sent`
- `reactivation_email_clicked`
- `reactivation_offer_viewed`
- `reactivation_scan_started`
- `reactivation_scan_completed`
- `reactivation_checkout_started`
- `reactivation_subscription_started`
- `reactivation_cancelled`

All events include `experiment_key` and `variant` when available.
