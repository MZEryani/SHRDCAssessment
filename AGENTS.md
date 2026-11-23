## Agent skills

### Issue tracker

Issues and specs are tracked as GitHub Issues in `MZEryani/SHRDCAssessment` using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root, created lazily as needed). See `docs/agents/domain.md`.

### Local scratch artifacts

Store throwaway prototypes (`.scratch/prototypes/`) and architecture review HTML reports (`.scratch/architecture-reviews/`) inside the gitignored `.scratch/` directory at the repo root.

## Git commits

- Follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`) with concise imperative subjects.
- Keep commit messages self-contained and professional; never reference chat-only labels, prompts, or temporary option letters (e.g., `(Option A)`).
