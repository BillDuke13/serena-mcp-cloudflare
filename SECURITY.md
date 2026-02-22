# Security Policy

## Supported Versions

This repository is an operational deployment wrapper. Security fixes are applied
to the latest published revision on the `main` branch.

## Reporting a Vulnerability

Please do not open a public issue for suspected credential leaks, auth bypasses,
or container escape risks.

Report privately by:

1. Opening a private security advisory on GitHub (preferred).
2. If that is not available, opening an issue with minimal details and asking
   for a private contact channel.

## What to Include

- Affected component (for example, `cloudflare/src/index.ts` or `Dockerfile.cloudflare`)
- Reproduction steps
- Impact assessment
- Whether credentials or tokens may have been exposed

## Response Expectations

- Initial acknowledgement: best effort within 72 hours
- Triage and severity assessment: best effort within 7 days
- Fix timeline: depends on impact and reproducibility

## Secrets and Operational Hygiene

Never commit:

- `API_TOKEN` or `API_TOKENS_JSON` values
- Cloudflare API tokens
- R2 access keys (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- Account-specific IDs that should remain private for your deployment

Rotate any credentials immediately if they are exposed in logs, screenshots, or
chat transcripts.
