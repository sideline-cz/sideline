# @sideline/rules

## 0.1.0

### Minor Changes

- Initial release: WFDF Rules of Ultimate trainer content (109 scenarios / 367 steps / 1182 options / 197 rule quotes across 9 packages), typed content entry points behind three subpaths (`.`, `/content`, `/reference`), and the pure DOM-free engine — the `animLimit` spoiler gate, monotone-cubic-Hermite motion (`pathTangents`/`ipos`/`createAnimator`), the `chainView` reveal decision, the answer/exam state transitions, level-stratified exam selection, and `scoreAttempt`.
- Content fixes carried in the port: removed 6 fx authored `type:"zone"` that rendered nothing, 23 dead pre-chain `options` arrays, and 57 dead `r` values on non-zone marks; normalised scenario topics to exactly one per level, which fixes an exam bug that made level 9 unreachable.
