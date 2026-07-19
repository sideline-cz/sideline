---
"@sideline/bot": patch
"@sideline/i18n": patch
---

Reject invalid input in the carpool "change seats" modal instead of silently resetting the car to 4 seats. Unlike adding a car (where an unparseable value sensibly defaults to 4), an out-of-range entry such as `0` or `9` when *updating* an existing car now returns a validation error and leaves the car unchanged.
