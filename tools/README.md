# tools/

Repository maintenance scripts. All scripts are bash, use `set -euo pipefail`,
and run from anywhere in the repo (they `cd` to the git toplevel themselves).

## `update-and-release.sh`

Full dependency-update + release flow. Run from `develop` with a clean tree.

```bash
tools/update-and-release.sh           # interactive
tools/update-and-release.sh --dry-run # show what would happen
tools/update-and-release.sh --yes     # skip all confirmation prompts
```

Steps:

1. Verify `develop` and `main` are in sync with `origin`, and that a Pulumi
   stack is selected in `pulumi/`.
2. Prompt with the selected stack name (`Pulumi stack: <name>. Proceed? [y/N]`).
3. Run `update-packages.sh` to bump deps and create per-subproject commits.
   Exits cleanly if nothing to update.
4. Bump the patch version in `pulumi/package.json` (and `package-lock.json`),
   commit as `chore: bump version to X.Y.Z`.
5. Push `develop`.
6. `pulumi up --yes` then `npm run invoke '{}'` from `pulumi/`. The Lambda
   bootstrap is rebuilt automatically inside Docker when `lambda/Cargo.lock`
   changes (see `pulumi/src/check-and-build.ts`).
7. Merge `develop` into `main` with `--no-ff` and push `main`.
8. Tag the release via `tag-version.sh`.
9. Fast-forward `develop` to `main` and push.

**Failure policy:** on any error the script stops in place. No rollback. The
log indicates which step failed so you can finish the release manually (for
example, if `pulumi up` fails partway, fix the issue and run the remaining
steps by hand).

## `update-packages.sh`

The reusable dependency-update part of the release flow. Run from `develop`
with a clean tree.

```bash
tools/update-packages.sh                          # update + test + commit
tools/update-packages.sh --dry-run                # show what would change
tools/update-packages.sh --skip-tests             # skip per-project tests
```

For each of `cloudflare/`, `pulumi/`, `lambda/` (in that order), runs the
package-manager update, runs a sanity check if anything changed
(`wrangler --version`, `npm run build && npm test`, `cargo test`), then
commits the changed lockfiles/manifests as `chore(<project>): ...`.

Exits 0 with `"No updates available."` if no subproject changed.

## `tag-version.sh`

Create and push a git tag from `pulumi/package.json` version. Must be run on
`main`. Used by `update-and-release.sh` but can also be invoked directly.

```bash
tools/tag-version.sh           # creates vX.Y.Z and pushes to origin
tools/tag-version.sh --dry-run # show the tag name only
tools/tag-version.sh --yes     # skip the push confirmation prompt
```

## `get-versions.sh`

List upstream AWS CLI v2 / Session Manager Plugin release tags from GitHub.
Used by the Lambda's version logic and useful for manual lookup.

```bash
tools/get-versions.sh                          # both tools
tools/get-versions.sh aws-cli                  # AWS CLI only
tools/get-versions.sh session-manager-plugin   # SMP only
tools/get-versions.sh --all                    # include aws-cli v1.x
```

Output is tab-separated: `<tool>\t<version>\t<datetime>`.
