---
'@sideline/domain': patch
---

Remove the redundant `/api` segment from the Translations API endpoint paths. Translations was the only API group whose endpoint paths embedded `/api/...` (e.g. `/api/translations`), so combined with the server's global `.prefix(API_PREFIX)` (`/api`) it was mounted at `/api/api/translations` — a double prefix inconsistent with every other group (which use bare paths like `/teams` under the `/api` prefix). The endpoint paths are now `/translations`, `/translations/:key`, `/translations/import`, and `/translations/export.json`, so the group mounts at the expected `/api/translations`. The externally-observed URLs are unchanged for the list/upsert/import endpoints (they were already documented as `/api/translations`), and this fixes the CSV/JSON export route, which previously 404'd because the client/proxy hit `/api/translations/export.json` while the server served `/api/api/translations/export.json`.
