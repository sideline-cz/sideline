---
'@sideline/web': patch
---

Stop phone-width pages scrolling sideways

Several pages rendered wider than the viewport on a phone, parking their row actions off-screen. Every `<table>` now sits in a horizontal scroll container, so a long member or group name grows the table instead of the page — ten list and detail views were missing one. The event-types rows now wrap, replacing a layout where a long name was squeezed to a single character per line beneath four action buttons, and the settings tab strip wraps onto a second row instead of being clipped at the screen edge. The variable-symbol banner on the members page and the roster buttons on the event detail page also wrap rather than overflowing their card.

`e2e/tests/responsive.spec.ts` asserts the document does not scroll horizontally at 360px on the pages that broke this way.
