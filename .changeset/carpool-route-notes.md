---
"@sideline/domain": patch
"@sideline/i18n": patch
"@sideline/server": patch
"@sideline/bot": patch
"@sideline/docs": patch
---

Carpool route notes: a driver can attach a free-text note (expected route, departure point, …) to their car — optionally when adding the car, or anytime via a new "Route note" button on the car thread that opens a modal prefilled with the current note (empty submit clears it). The note renders on the carpool board directly below the car's title row. Backed by new `Carpool/UpdateCarNote` (owner-only) and `Carpool/GetCarNote` RPCs reusing the existing `note` column; note length capped at 200 characters end to end.
