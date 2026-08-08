"""Health Connect domain (H1): weight and activity from Android Health Connect.

Receives pushes from the Health Connect Webhook app (mcnaveen/health-connect-webhook),
which reads Google Health Connect on-device and POSTs to a tailnet-only endpoint.
A Withings scale writes weight to Health Connect; activity comes from the phone's
step counter and any paired workout app.

Types: weight_measurement, activity_summary.
Endpoint: POST /health-connect (shared-secret header; no JWT required from the app).
"""
