# Managing cloud skills

Use this skill only for Skills stored in OpenCode's managed cloud Git repositories.
Repositories are writable checkouts shared by the Skills dialog and the
`opencode skill cloud` CLI. Multiple cloud repositories are supported.

## Inspect repositories

List all configured cloud skill repositories:

```bash
opencode skill cloud list
```

Inspect a specific repository or the default one:

```bash
opencode skill cloud status [--name <repo-name>]
```

The command returns JSON containing:

- `name`: repository name/identifier.
- `configured`: whether a Git remote is configured.
- `repository`: the configured remote URL.
- `directory`: the checkout directory managed by this skill.
- `branch`, `head`, `changes`, `ahead`, and `behind`: the current Git state.

If a repository is not configured and the user supplied a Git URL, configure
or add it with:

```bash
opencode skill cloud configure <git-url> [--name <repo-name>]
```

If the user did not supply a URL, ask for one. Do not invent a repository.

## Update before editing

Pull remote changes with safe fast-forward updates:

```bash
# Update all repositories
opencode skill cloud update

# Or update a specific repository
opencode skill cloud update --name <repo-name>
```

If the command reports local modifications or a divergent history, stop and
explain the conflict. Do not run `git reset`, `git clean`, or another destructive
command to bypass it.

## Create or edit a cloud skill

Work only under the `directory` of the target repository returned by status or list.
Each Skill should use the standard layout:

```text
<directory>/<skill-name>/SKILL.md
```

Use lowercase letters, numbers, and hyphens for `<skill-name>`. `SKILL.md` must
start with YAML frontmatter containing a matching `name` and a concise
`description`, followed by stable instructions for an agent. Keep scripts and
references inside the same Skill directory and reference them with relative
paths.

Read the existing Skill before editing it. Preserve useful instructions and
supporting files, and avoid broad rewrites unrelated to the user's request.

## Publish changes

Inspect the files you changed, then commit, rebase, and push through the managed
sync command:

```bash
opencode skill cloud sync [--name <repo-name>] --message "feat(skills): describe the change"
```

The sync command stages only the target cloud checkout. If authentication or
rebase fails, report the exact error and leave the local commit intact for a
later retry.
