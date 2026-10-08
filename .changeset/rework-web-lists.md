---
'@sideline/domain': patch
'@sideline/server': patch
'@sideline/web': patch
---

Search, filter and sort on the team lists

The roles, rosters, training-types and members lists each gained a toolbar: a search box, filter chips and a sort control. On a desktop screen the table body now scrolls under a pinned header rather than pushing the rest of the page down; on a phone the page scrolls as it did, since a fixed-height box inside an already-scrolling page is worse than letting it run. The members list also shows each member's groups beside their roles.

Three of these lists could not offer a "show all vs only active" filter before, because archived and departed rows never left the server. Archived groups and roles, and members who have left the team, are now sent to the pages that offer that toggle — and only to those. Every other reader is unchanged by design: the assistant's group and roster tools, the member-groups view, the player-rating endpoints and bank reconciliation all still see live groups and current members only, so a departed member's variable symbol stays out of the payment suggestions.

Two empty states were wrong and are fixed: a rosters list whose every roster is inactive said "No rosters yet", sending the reader off to create one they already had, and the members list said the team had no players when a search simply matched nothing.

`FinancesOverviewPage`'s by-member search and status filter were the model for the shared toolbar and now render through it, with the same five filters and the same semantics.
