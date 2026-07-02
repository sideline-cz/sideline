---
"@sideline/server": patch
"@sideline/docs": patch
---

Fix personal channel provisioning permanently skipping members after a failed first attempt. The reservation query used `INSERT ... ON CONFLICT DO NOTHING`, so a stale NULL reservation left behind by a failed attempt made every subsequent reserve return `reserved=false`, permanently skipping the member. Reservation is now a lease-based conditional re-claim that re-claims a stale NULL reservation older than 15 minutes while preserving cross-replica mutual exclusion for in-flight reservations and never touching already-provisioned rows.
