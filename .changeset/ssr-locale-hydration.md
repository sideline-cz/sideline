---
'@sideline/web': patch
'@sideline/i18n': patch
---

Render the server HTML in the user's language and show dates in the app language

Every full page load logged React hydration error #418 for Czech users: the server had no idea which language the request was in, so it rendered the loading screen in English and the browser then rendered it in Czech. The web server now resolves the language per request from the language cookie (written alongside the stored preference) or the browser's `Accept-Language`, the same sources the browser uses, so both sides render the same text.

Dates on the dashboard, events list, activity log, achievements, weekly summary, payments and balance chart now follow the app language instead of the browser's, and event-type badges on the dashboard and home page show the translated name ("Trénink") instead of the raw value ("training").
