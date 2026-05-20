#!/bin/bash
set -euo pipefail

# Orchestrate a full maintenance release:
#   1. Verify preconditions (branches in sync, pulumi stack selected).
#   2. Confirm the pulumi stack with the operator.
#   3. Run tools/update-packages.sh to bump deps and commit per subproject.
#   4. Bump the patch version in pulumi/package.json and commit.
#   5. Push develop.
#   6. Deploy: pulumi up --yes; npm run invoke '{}'.
#   7. Merge develop into main with --no-ff, push main.
#   8. Tag the release via tools/tag-version.sh.
#   9. Fast-forward develop to main and push.
#
# Failure policy: on any non-zero exit we stop in place. No rollback.
# The error message states what was already done so the operator can finish
# the release manually.
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

  Run the full dependency-update + release flow. Must be on develop with
  a clean working tree, develop and main in sync with origin, and a
  pulumi stack already selected in pulumi/.

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

# 1. Preconditions ------------------------------------------------------------

step "Preconditions"

branch=$(git symbolic-ref --short HEAD)
if [[ "$branch" != "develop" ]]; then
    echo "Error: must be on develop branch (current: $branch)" >&2
    exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "Error: working tree is not clean" >&2
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

if [[ "$HEAD_BEFORE" == "$HEAD_AFTER" ]] && ! $dry_run; then
    echo
    echo "No updates available. Nothing to release."
    exit 0
fi

# 4. Version bump -------------------------------------------------------------

step "Bumping patch version in pulumi/package.json"

if $dry_run; then
    current=$(node -p "require('./pulumi/package.json').version")
    echo "DRY-RUN: would bump pulumi/package.json version from $current"
    new_version="$current"
else
    # npm version patch updates package.json and package-lock.json and
    # prints "vX.Y.Z" on stdout. --no-git-tag-version skips the implicit
    # commit/tag so we control git ourselves.
    raw=$(cd pulumi && npm version patch --no-git-tag-version)
    new_version="${raw#v}"
    git add pulumi/package.json pulumi/package-lock.json
    git commit -m "chore: bump version to ${new_version}"
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

echo
if $dry_run; then
    echo "Dry run complete."
else
    echo "Release ${new_version} complete."
fi
