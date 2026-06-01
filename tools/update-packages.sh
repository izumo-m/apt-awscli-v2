#!/bin/bash
set -euo pipefail

# Update dependencies of cloudflare/, pulumi/, and lambda/ within their
# current semver ranges, run a sanity check for each, and create one
# chore commit per subproject that actually changed.
#
# Runs on develop with a clean tree. Does NOT bump the project version,
# push, merge, or tag — that orchestration belongs to update-and-release.sh.
#
# Order: cloudflare -> pulumi -> lambda. lambda is last because its
# musl bootstrap is rebuilt inside Docker during `pulumi up`; keeping it
# last shortens the recovery loop when an earlier project's tests fail.
#
# Usage: tools/update-packages.sh [--dry-run] [--skip-tests]
#
# Exit codes:
#   0  -- 1+ subprojects updated and committed, OR nothing to update
#   1  -- precondition or update/test failure

cd "$(git rev-parse --show-toplevel)"

dry_run=false
skip_tests=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) dry_run=true ;;
        --skip-tests) skip_tests=true ;;
        -h|--help)
            cat <<'EOF'
Usage: tools/update-packages.sh [--dry-run] [--skip-tests]

  Update dependencies in cloudflare/, pulumi/, and lambda/ within their
  current semver ranges. One chore commit is created per subproject that
  changed.

Options:
  --dry-run     Show what would change without modifying files or
                creating commits. Tests are skipped in this mode.
  --skip-tests  Skip per-subproject sanity tests (use sparingly).
EOF
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

# Preconditions ---------------------------------------------------------------

branch=$(git symbolic-ref --short HEAD)
if [[ "$branch" != "develop" ]]; then
    echo "Error: must be on develop branch (current: $branch)" >&2
    exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "Error: working tree is not clean" >&2
    exit 1
fi

# Helpers ---------------------------------------------------------------------

# True iff any of the given paths have unstaged or staged differences.
changed() {
    ! git diff --quiet -- "$@" || ! git diff --cached --quiet -- "$@"
}

commit_count=0

# Run a step description with a heading so the log is easy to scan.
step() {
    echo
    echo "==> $*"
}

# Subprojects -----------------------------------------------------------------

update_cloudflare() {
    step "cloudflare: npm update"
    (
        cd cloudflare
        if $dry_run; then
            npm update --save --dry-run
            return
        fi
        npm update --save
    )

    if $dry_run; then return; fi

    if ! changed cloudflare/package.json cloudflare/package-lock.json; then
        echo "cloudflare: no changes"
        return
    fi

    if ! $skip_tests; then
        step "cloudflare: sanity check (wrangler --version)"
        ( cd cloudflare && npx --no-install wrangler --version )
    fi

    git add cloudflare/package.json cloudflare/package-lock.json
    git commit -m "chore(cloudflare): npm update (within current ranges)"
    commit_count=$((commit_count + 1))
}

update_pulumi() {
    step "pulumi: npm update"
    (
        cd pulumi
        if $dry_run; then
            npm update --save --dry-run
            return
        fi
        npm update --save
    )

    if $dry_run; then return; fi

    if ! changed pulumi/package.json pulumi/package-lock.json; then
        echo "pulumi: no changes"
        return
    fi

    if ! $skip_tests; then
        step "pulumi: npm run build"
        ( cd pulumi && npm run build )
        step "pulumi: npm test"
        ( cd pulumi && npm test )
    fi

    git add pulumi/package.json pulumi/package-lock.json
    git commit -m "chore(pulumi): npm update (within current ranges)"
    commit_count=$((commit_count + 1))
}

update_lambda() {
    step "lambda: cargo update"
    (
        cd lambda
        if $dry_run; then
            cargo update --dry-run
            return
        fi
        cargo update
    )

    if $dry_run; then return; fi

    if ! changed lambda/Cargo.lock; then
        echo "lambda: no changes"
        return
    fi

    if ! $skip_tests; then
        step "lambda: cargo test"
        ( cd lambda && cargo test )
    fi

    git add lambda/Cargo.lock
    git commit -m "chore(lambda): cargo update (within current ranges)"
    commit_count=$((commit_count + 1))
}

# Main ------------------------------------------------------------------------

update_cloudflare
update_pulumi
update_lambda

echo
if $dry_run; then
    echo "Dry run complete. No commits created."
elif [[ "$commit_count" -eq 0 ]]; then
    echo "No updates available. Nothing committed."
else
    echo "$commit_count subproject(s) updated and committed."
fi
