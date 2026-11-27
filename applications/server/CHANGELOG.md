# Changelog

## 0.91.0

### 🚀 Features
- move all LLM calls from OpenAI onto ai-sessions (#849)

## 0.90.0

### 🚀 Features
- chat with the AI assistant in a Discord thread via /assistant (#848)

## 0.89.1

### 🐛 Fixes
- refuse plan-side changes that re-price paid members into another currency (#847)

## 0.89.0

### 🚀 Features
- team setting to make activity notes visible to teammates (#844)

### 🐛 Fixes
- refuse moving a paid member to a fee plan in another currency (#845)

## 0.88.0

### 🚀 Features
- AI assistant proposes payments, expenses and membership plan changes (#842)

## 0.87.1

### 🐛 Fixes
- weekly workout summary 500s on any week with activity; log activity from the workout header (#841)

## 0.87.0

### 🚀 Features
- AI assistant proposes group and roster changes (#833)

## 0.86.0

### 🚀 Features
- AI assistant proposes event updates, cancellations, attendance and your own RSVP (#829)
- editable dot color on activity types (#828)
- choose which RSVP answers feed the event roster (#834)

### 🐛 Fixes
- scope roster and event-roster lookups to the team in the URL (#835)
- late-RSVP notice says which answer the member changed from (#825)

## 0.85.1

### 🐛 Fixes
- list group and roster channels as managed by Sideline (#815)

## 0.85.0

### 🚀 Features
- assistant reads Discord messages live (#814)

## 0.84.1

_No notable changes._

## 0.84.0

### 🚀 Features
- Discord write actions in the AI assistant (#809)
- server-to-bot RPC transport (#810)

## 0.83.0

### 🚀 Features
- bulk fee import from CSV (#808)
- read-only Discord tools in the AI assistant (#807)

## 0.82.0

### 🚀 Features
- season-scoped workout tracking, shared member logs, team activity matrix (#801)

## 0.81.0

### 🚀 Features
- recurring series of any event type (#798)

## 0.80.0

### 🚀 Features
- monthly recurring series (by day of month or nth weekday) (#795)

## 0.72.0

### 🚀 Features
- make the command palette a menu, and search roles and expenses (#767)
- richer Overview tab — collection rate, monthly trend, season window (#766)

## 0.47.0

### 🚀 Features
- purge forwarded email bodies and attachments 90 days after a message is handled (#613)

## 0.46.1

### 🐛 Fixes
- scheduled rules quizzes are actually delivered — the outbox rows never encoded (#602)
- a quiz is no longer lost when no cron tick lands on the configured minute (#602)

## 0.46.0

### 🚀 Features
- private /rules, and a scheduled rules quiz per team (#588)

### 🐛 Fixes
- declare @sideline/rules so the pruned production image can start (#587)

## 0.45.0

### 🚀 Features
- a rules quiz in Discord — public question, private chain (#584)

## 0.42.0

### 🚀 Features
- rename "maybe" to "coming later" with a required reason (#549)

## 0.41.0

### 🚀 Features
- remove the global events board (Release A) (#547)

## 0.40.3

### 🐛 Fixes
- drop per-event-type channel columns (Release B) (#543)

## 0.40.2

### 🐛 Fixes
- make BotInfoStore.set resolve to void (#542)

## 0.40.1

### 🐛 Fixes
- remove finished events from personal channels (#540)

## 0.40.0

### 🚀 Features
- MajNet standard /healthz and /info endpoints on all apps (#538)

## 0.39.0

### 🚀 Features
- driver route notes on cars (#531)
