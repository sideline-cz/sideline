cd "/data/shipmonk/worktrees/sideline/feat-command-palette-menu-and-full-search"
direnv allow && pnpm install
claude --dangerously-skip-permissions --append-system-prompt "$(cat /home/majksa/.claude/plugins/cache/majksa/worktree/0.3.0/skills/worktree/agent-system-prompt.md)" "$(cat /data/shipmonk/worktrees/sideline/feat-command-palette-menu-and-full-search/.herdr-prompt.txt)"
cd "/data/sideline/sideline" && herdr worktree remove --workspace w4J --force
