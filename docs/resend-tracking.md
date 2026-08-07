# Resend Open and Click Tracking

The app sends email through Resend in two places:

- lifecycle nurture emails in `lib/lifecycle-emails.js`
- support notifications in `server.js`

Resend tracks opens and clicks at the sending domain level, not with per-message fields on the `/emails` send request. The app now attempts to enable domain tracking before sending when these Render environment variables are configured:

```text
RESEND_DOMAIN_ID=<your Resend domain id>
RESEND_TRACKING_SUBDOMAIN=links
RESEND_TRACKING_AUTO_CONFIGURE=true
```

`RESEND_TRACKING_SUBDOMAIN` defaults to `links` if omitted. If `RESEND_DOMAIN_ID` is not configured, email sending continues unchanged and tracking setup is skipped.

After deploying:

1. Open Resend.
2. Go to Domains.
3. Open the sending domain used by `LIFECYCLE_EMAIL_FROM` or `SUPPORT_EMAIL_FROM`.
4. Confirm open tracking and click tracking are enabled.
5. Add and verify the Tracking CNAME shown by Resend, for example `links.yourdomain.com`.
6. Send a lifecycle or support email.
7. Open the email and click a CTA link.
8. In Resend, open the sent email/metrics area and confirm open and click events appear.

Tracking becomes active only after the tracking subdomain is verified in Resend.
