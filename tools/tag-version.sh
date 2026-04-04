#!/bin/bash
set -euo pipefail

# Create and push a git tag based on the version in pulumi/package.json.
# Run on the main branch after a successful deploy.
#
# Usage: tools/tag-version.sh [--dry-run]

cd "$(git rev-parse --show-toplevel)"

dry_run=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) dry_run=true ;;
        -h|--help)
            echo "Usage: tools/tag-version.sh [--dry-run]"
            echo "  Create a version tag from pulumi/package.json and push it."
            echo "  Must be run on the main branch."
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

# Read version from package.json
version=$(node -p "require('./pulumi/package.json').version")
tag="v${version}"

# Verify we are on the main branch
branch=$(git symbolic-ref --short HEAD)
if [[ "$branch" != "main" ]]; then
    echo "Error: must be on main branch (current: $branch)" >&2
    exit 1
fi

# Verify working tree is clean
if [[ -n "$(git status --porcelain)" ]]; then
    echo "Error: working tree is not clean" >&2
    exit 1
fi

# Check tag does not already exist
if git rev-parse "$tag" >/dev/null 2>&1; then
    echo "Error: tag $tag already exists" >&2
    exit 1
fi

if $dry_run; then
    echo "$tag (dry-run)"
    exit 0
fi

read -rp "Push tag $tag? [y/N] " answer
if [[ "$answer" != [yY] ]]; then
    echo "Aborted."
    exit 1
fi

git tag "$tag"
git push origin "$tag"

echo "$tag pushed."
