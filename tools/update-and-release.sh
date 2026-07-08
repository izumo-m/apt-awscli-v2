#!/bin/bash
set -euo pipefail

# Orchestrate a full maintenance release:
#   0. Check required host tools (git/node/npm/pulumi/cargo/cargo-make/docker)
#      and that the docker daemon is running.
#   1. Verify preconditions: clean tree, on develop (auto-switch from main),
#      develop/main in sync with origin, pulumi logged in and a stack selected.
#   2. Confirm the pulumi stack with the operator.
#   3. Run tools/update-packages.sh to bump deps and commit per subproject.
#      If nothing changed and no release is pending, stop (nothing to release).
#   4. Bump the patch version in pulumi/package.json and commit.
#   5. Push develop.
#   6. Deploy: pulumi up --yes; npm run invoke '{}'.
#   7. Merge develop into main with --no-ff, push main.
#   8. Tag the release via tools/tag-version.sh.
#   9. Fast-forward develop to main and push.
#  10. Verify develop and main converged (local + origin).
#
# Failure policy: on any non-zero exit we stop in place. No rollback.
# The error message states what was already done so the operator can finish
# the release manually.
#
# Resumable: if a previous run committed and pushed the version bump on
# develop but then failed during deploy/merge/tag, simply re-run this script.
# It detects that develop is ahead of main (a pending release), skips the
# dependency-update and version-bump steps (already done), and continues from
# the deploy step. Steps 5-9 are idempotent, so resuming is safe.
#
# Usage: tools/update-and-release.sh [--dry-run] [--yes]

cd "$(git rev-parse --show-toplevel)"

dry_run=false
assume_yes=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) dry_run=true ;;
        --yes|-y)  assume_yes=true ;;
        -h|--help)
            cat <<'EOF'
Usage: tools/update-and-release.sh [--dry-run] [--yes]

  Run the full dependency-update + release flow. Run from develop (or from
  main, in which case it switches to develop) with a clean working tree,
  develop and main in sync with origin, and a pulumi stack already selected
  in pulumi/. Exits without releasing if there are no dependency updates.

Options:
  --dry-run   Show what would happen without modifying any state.
              Calls update-packages.sh --dry-run, runs `pulumi preview`
              instead of `pulumi up`, and echoes (without running) all
              git push/tag/merge commands.
  --yes, -y   Skip all interactive confirmations (stack-name prompt,
              tag-push prompt). Use for unattended runs.
EOF
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

step() {
    echo
    echo "==> $*"
}

# In dry-run, prefix destructive commands with `echo` so the intent is
# visible but nothing happens.
run() {
    if $dry_run; then
        echo "DRY-RUN: $*"
    else
        "$@"
    fi
}

# Fail early with an actionable message if any required executable is missing.
require_tools() {
    local missing=()
    local tool
    for tool in "$@"; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            missing+=("$tool")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "Error: required tool(s) not found on PATH: ${missing[*]}" >&2
        echo "Install them before running a release." >&2
        exit 1
    fi
}

# Return to the branch the operator started on. Used to keep dry-runs and
# no-op runs side-effect free (a real release intentionally ends on main).
restore_start_branch() {
    if [[ -n "${START_BRANCH:-}" ]] \
        && [[ "$(git symbolic-ref --short HEAD)" != "$START_BRANCH" ]]; then
        git checkout --quiet "$START_BRANCH"
    fi
}

# 0. Tooling ------------------------------------------------------------------

step "Checking required tools"
# Host-side executables the release flow shells out to (directly or via the
# helper scripts / pulumi program). The lambda bootstrap is cross-compiled
# inside Docker via `cargo make`, so cargo-make and docker are required too.
require_tools git node npm pulumi cargo cargo-make docker
echo "Tools present: git node npm pulumi cargo cargo-make docker"

# Docker must be running: `pulumi up` builds the lambda bootstrap in a
# container (lambda/Makefile.toml).
if ! docker info >/dev/null 2>&1; then
    echo "Error: docker daemon is not running or not reachable." >&2
    echo "Start Docker; the lambda bootstrap is built in a container during 'pulumi up'." >&2
    exit 1
fi

# Helper scripts this orchestrator drives must exist and be executable.
for helper in tools/update-packages.sh tools/tag-version.sh; do
    if [[ ! -x "$helper" ]]; then
        echo "Error: required helper not found or not executable: $helper" >&2
        exit 1
    fi
done

# 1. Preconditions ------------------------------------------------------------

step "Preconditions"

# Check the tree is clean before touching branches: a dirty tree would be
# dragged along by the develop checkout below.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "Error: working tree is not clean" >&2
    exit 1
fi

# The release runs on develop. Sitting on main with develop pointing at the
# same commit is a normal ready-state, so switch to develop transparently.
# Any other branch is refused rather than guessed at.
START_BRANCH=$(git symbolic-ref --short HEAD)
branch="$START_BRANCH"
if [[ "$branch" == "main" ]]; then
    echo "On main; switching to develop for the release..."
    git checkout --quiet develop
    branch=$(git symbolic-ref --short HEAD)
fi
if [[ "$branch" != "develop" ]]; then
    echo "Error: must be on develop or main (current: $START_BRANCH)" >&2
    exit 1
fi

echo "Fetching origin..."
git fetch origin --quiet

# develop must equal origin/develop (no ahead, no behind).
if [[ "$(git rev-parse develop)" != "$(git rev-parse origin/develop)" ]]; then
    echo "Error: develop is out of sync with origin/develop" >&2
    echo "  local : $(git rev-parse develop)" >&2
    echo "  remote: $(git rev-parse origin/develop)" >&2
    exit 1
fi

# main must equal origin/main.
if [[ "$(git rev-parse main)" != "$(git rev-parse origin/main)" ]]; then
    echo "Error: main is out of sync with origin/main" >&2
    echo "  local : $(git rev-parse main)" >&2
    echo "  remote: $(git rev-parse origin/main)" >&2
    exit 1
fi

# Pulumi must be logged in (the `current` field in credentials.json is set
# by `pulumi login` and readable without contacting the backend).
creds_file="$HOME/.pulumi/credentials.json"
if [[ ! -f "$creds_file" ]]; then
    echo "Error: pulumi is not logged in (no $creds_file)." >&2
    echo "Run 'pulumi login <backend>' first." >&2
    exit 1
fi
backend=$(node -e "process.stdout.write(require('$creds_file').current || '')" 2>/dev/null || true)
if [[ -z "$backend" ]]; then
    echo "Error: pulumi is not logged in (credentials.current is empty)." >&2
    echo "Run 'pulumi login <backend>' first." >&2
    exit 1
fi

# Backend reachable + stack selected. `pulumi stack --show-name` exercises
# both, so a non-zero exit means one of them is broken; surface the raw
# error so the operator can tell which.
if ! stack=$(cd pulumi && pulumi stack --show-name 2>&1); then
    echo "Error: pulumi stack check failed (backend: $backend):" >&2
    echo "$stack" | sed 's/^/  /' >&2
    echo "Ensure the backend is reachable (e.g., AWS credentials for an S3" >&2
    echo "backend) and a stack is selected ('pulumi stack select <name>'" >&2
    echo "in pulumi/)." >&2
    exit 1
fi
if [[ -z "$stack" ]]; then
    echo "Error: no pulumi stack selected." >&2
    echo "Run 'pulumi stack select <name>' in pulumi/ first." >&2
    exit 1
fi

# 2. Stack confirmation -------------------------------------------------------

echo
if $assume_yes; then
    echo "Pulumi backend: $backend"
    echo "Pulumi stack:   $stack (auto-confirmed via --yes)"
else
    echo "Pulumi backend: $backend"
    echo "Pulumi stack:   $stack"
    read -rp "Proceed? [y/N] " answer
    if [[ "$answer" != [yY] ]]; then
        echo "Aborted."
        exit 1
    fi
fi

# 3. Dependency updates -------------------------------------------------------

step "Updating dependencies"
HEAD_BEFORE=$(git rev-parse HEAD)
if $dry_run; then
    ./tools/update-packages.sh --dry-run
else
    ./tools/update-packages.sh
fi
HEAD_AFTER=$(git rev-parse HEAD)

if [[ "$HEAD_BEFORE" != "$HEAD_AFTER" ]]; then
    updates_made=true
else
    updates_made=false
fi

# Detect a release left unfinished by an earlier run. If develop carries
# commits that are not yet on main (e.g. a prior run committed the version
# bump and pushed develop, but then failed at the deploy/merge/tag stage),
# there is a pending release to resume even when THIS run produced no new
# dependency commits. `git merge-base --is-ancestor develop main` is true
# (exit 0) only when every develop commit is already on main, i.e. nothing
# is pending.
#
# Note: this resumes runs that failed at or before the merge step (the common
# case). A run that failed *after* merging develop into main but before
# tagging is not auto-detected here; finish those manually with
# tools/tag-version.sh.
if git merge-base --is-ancestor develop main; then
    pending_release=false
else
    pending_release=true
fi

if ! $updates_made && ! $pending_release && ! $dry_run; then
    echo
    echo "No updates available and nothing pending. Nothing to release."
    restore_start_branch
    exit 0
fi

if ! $updates_made && $pending_release && ! $dry_run; then
    echo
    echo "No new dependency updates, but develop has unreleased commits"
    echo "ahead of main. Resuming the release of the existing develop state."
fi

# 4. Version bump -------------------------------------------------------------
#
# Only bump when this run created new dependency commits. When resuming a
# previously-bumped-but-undeployed develop, reuse the existing version so we
# do not bump twice for the same release.

if $dry_run; then
    step "Bumping patch version in pulumi/package.json"
    current=$(node -p "require('./pulumi/package.json').version")
    echo "DRY-RUN: would bump pulumi/package.json version from $current"
    new_version="$current"
elif $updates_made; then
    step "Bumping patch version in pulumi/package.json"
    # npm version patch updates package.json and package-lock.json and
    # prints "vX.Y.Z" on stdout. --no-git-tag-version skips the implicit
    # commit/tag so we control git ourselves.
    raw=$(cd pulumi && npm version patch --no-git-tag-version)
    new_version="${raw#v}"
    git add pulumi/package.json pulumi/package-lock.json
    git commit -m "chore: bump version to ${new_version}"
else
    # Resuming: develop was already bumped by the earlier (failed) run.
    new_version=$(node -p "require('./pulumi/package.json').version")
    step "Resuming release of existing version ${new_version} (no new bump)"
fi

# 5. Push develop -------------------------------------------------------------

step "Pushing develop"
run git push origin develop

# 6. Deploy -------------------------------------------------------------------

step "Deploying (pulumi up + invoke) on stack '$stack'"
if $dry_run; then
    ( cd pulumi && pulumi preview )
    echo "DRY-RUN: skipping npm run invoke"
else
    ( cd pulumi && pulumi up --yes )
    ( cd pulumi && npm run invoke '{}' )
fi

# 7. Merge develop into main (--no-ff) ----------------------------------------

step "Merging develop into main (--no-ff)"
run git checkout main
run git merge --no-ff develop -m "Merge branch 'develop'"
run git push origin main

# 8. Tag ----------------------------------------------------------------------

step "Tagging release"
tag_args=()
if $assume_yes; then
    tag_args+=(--yes)
fi
if $dry_run; then
    # tag-version.sh checks `branch == main`, but in dry-run we never
    # actually checked out main. Echo the intent instead.
    echo "DRY-RUN: would run tools/tag-version.sh ${tag_args[*]-} on main"
else
    ./tools/tag-version.sh "${tag_args[@]}"
fi

# 9. Sync develop to main -----------------------------------------------------

step "Fast-forwarding develop to main"
# main is develop + 1 merge commit, so develop's new tip is an ancestor
# of nothing on origin — but origin/develop is an ancestor of main, so
# this is a fast-forward push, not a force-push.
run git branch -f develop main
run git push origin develop

# 10. Post-release verification -----------------------------------------------
#
# The release only counts as done if develop and main converged: main holds
# the merge commit and develop was fast-forwarded onto it. Confirm locally and
# on origin so a silent divergence (e.g. a dropped final push) can't pass for
# success.

step "Verifying develop == main"
if $dry_run; then
    echo "DRY-RUN: skipping post-release develop/main convergence check"
else
    dev_sha=$(git rev-parse develop)
    main_sha=$(git rev-parse main)
    if [[ "$dev_sha" != "$main_sha" ]]; then
        echo "Error: post-release develop and main differ locally" >&2
        echo "  develop: $dev_sha" >&2
        echo "  main   : $main_sha" >&2
        exit 1
    fi
    git fetch origin --quiet
    if [[ "$(git rev-parse origin/develop)" != "$main_sha" \
        || "$(git rev-parse origin/main)" != "$main_sha" ]]; then
        echo "Error: origin develop/main are not both at the released commit" >&2
        echo "  released      : $main_sha" >&2
        echo "  origin/main   : $(git rev-parse origin/main)" >&2
        echo "  origin/develop: $(git rev-parse origin/develop)" >&2
        exit 1
    fi
    echo "OK: local & origin develop and main are all at $main_sha"
fi

echo
if $dry_run; then
    restore_start_branch
    echo "Dry run complete."
else
    echo "Release ${new_version} complete."
fi
