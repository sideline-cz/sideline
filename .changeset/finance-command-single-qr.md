---
"@sideline/bot": minor
"@sideline/server": minor
"@sideline/domain": minor
"@sideline/i18n": minor
---

`/finance status` is now just `/finance`, and it always shows a payment QR code.

The command had exactly one subcommand, so `status` was pure typing with nothing to disambiguate. The old `/finance status` (and its Czech `stav` alias) disappears from Discord at the next command registration.

The embed now carries one standing QR code instead of none. It encodes the member's **net** outstanding total in the club's bank-account currency — outstanding fees minus the credit they already hold, so a member with 100 CZK credit against a 100 CZK fee is not asked to pay twice. When that nets to zero the very same code is sent with no amount at all, which makes it the "send any amount, any time" top-up code the web's My payments page already offers. The two states get different wording, and the per-fee amounts in the embed stay gross — credit belongs to the member, not to any one fee.

`Finance/GetMyStatus` grew a `qr` field and a per-currency `credit_minor`. Fees in a currency other than the bank account's are left out of the QR amount (a code carries one amount in one currency) and remain in the embed's per-currency total. A club with no bank configuration, or a member with no variable symbol, gets the embed exactly as it rendered before — the QR never fails the command.
