---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/web': minor
'@sideline/i18n': minor
---

Add player-facing payment status view. Adds a new "My payments" page (`/teams/:teamId/my-payments`) with KPI cards (outstanding, overdue count, paid total, next due), filter chips, and per-fee tables with expandable payment history. Adds an outstanding-payments banner on the team dashboard that appears when the current player has pending or overdue fees. Introduces a new `myPaymentHistory` endpoint (`GET /teams/:teamId/finance/my-payments`) that lets any team member view their own payment history without the `finance:view` permission; the endpoint is membership-gated and hardcodes the caller's member id, so a player cannot read another member's payments.
