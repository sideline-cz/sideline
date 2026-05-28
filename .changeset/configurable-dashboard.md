---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/web': minor
'@sideline/migrations': minor
'@sideline/i18n': patch
---

Team members can now customize their dashboard: show/hide and reorder the four non-urgent widgets (stats, upcoming events, activity, team management) per team. The layout is persisted server-side in a new `dashboard_layouts` table so it syncs across devices. The two urgency banners (awaiting RSVP, outstanding payments) stay pinned and are intentionally not user-hideable so members never silently miss alerts. New `GET`/`PUT /teams/:teamId/dashboard-layout` endpoints; the dashboard read endpoint is unchanged and the layout loads as a graceful-degradation arm so the dashboard never breaks if the config call fails.
