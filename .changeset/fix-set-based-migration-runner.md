---
"@sideline/migrations": patch
---

Replace watermark-based migration runner with set-based approach. The Effect SQL migrator previously only ran migrations with ID greater than the highest already-applied migration ID, silently skipping any migration file added with a past timestamp. The new implementation fetches the full set of applied migration IDs and runs any file not present in that set, regardless of its position relative to the maximum.
