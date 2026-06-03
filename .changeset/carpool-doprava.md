---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/bot': minor
'@sideline/migrations': minor
'@sideline/i18n': minor
---

Add Discord carpool board feature (`/doprava` / `/carpool`). Captains post a live-updating board; members add cars (capacity 1–8 including driver), reserve seats via buttons, and manage passengers in a per-car private thread. Introduces three new database tables (`carpools`, `carpool_cars`, `carpool_seats`), eight new `Carpool/*` RPC methods, and a new `carpool:manage` permission granted to Admin and Captain roles by default.
