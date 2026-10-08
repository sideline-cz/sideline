cd "/data/shipmonk/worktrees/sideline/feat-rework-web-lists"
direnv allow && pnpm install
claude --dangerously-skip-permissions --append-system-prompt "$(cat /home/majksa/.claude/plugins/cache/majksa/worktree/0.3.0/skills/worktree/agent-system-prompt.md)" "$(cat /data/shipmonk/worktrees/sideline/feat-rework-web-lists/.herdr-prompt.txt)"
cd "/data/sideline/sideline" && herdr worktree remove --workspace w4E --force
