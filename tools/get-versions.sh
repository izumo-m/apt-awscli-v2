#!/bin/bash
set -euo pipefail

# List versions of AWS CLI v2 and Session Manager Plugin from GitHub tag pages.
# Args: [aws-cli | session-manager-plugin] (both when omitted)
# --all also includes aws-cli v1.x versions.
#
# Output format: <tool>\t<version>\t<datetime>
#
# Implementation mirrors lambda/src/version.rs:
#   - capture every release-tag URL broadly, plus every datetime attribute
#   - walk in document order; a tag that passes the version filter becomes
#     the candidate, one that fails clears the candidate (so a 1.x entry
#     interleaved with 2.x tags won't get its datetime mis-attributed)
#   - the first datetime that follows a candidate is emitted and consumed

target="both"
all=false

for arg in "$@"; do
    case "$arg" in
        --all) all=true ;;
        aws-cli) target="aws-cli" ;;
        session-manager-plugin) target="session-manager-plugin" ;;
    esac
done

# Walk the captured token stream, pair each accepted tag with the very next
# datetime, and print (tool, tag, datetime) tab-separated.
#
# Args:
#   $1 = tool name (printed as-is)
#   $2 = ERE matching tag-like tokens (vs. datetime tokens)
#   $3 = ERE that a tag must match to qualify
emit_pairs() {
    local tool="$1" tag_pattern="$2" accept_pattern="$3"
    local tag=""
    while read -r line; do
        if [[ "$line" =~ $tag_pattern ]]; then
            if [[ "$line" =~ $accept_pattern ]]; then
                tag="$line"
            else
                tag=""
            fi
        elif [[ -n "$tag" ]]; then
            printf '%s\t%s\t%s\n' "$tool" "$tag" "$line"
            tag=""
        fi
    done
}

get_awscli_versions() {
    local accept='^2\.[0-9]+\.[0-9]+$'
    if $all; then
        accept='^[0-9]+\.[0-9]+\.[0-9]+$'
    fi
    curl -s "https://github.com/aws/aws-cli/tags" \
        | grep -Po '(/aws/aws-cli/releases/tag/\K[\w.+\-]+)|datetime="\K[^"]+' \
        | emit_pairs "aws-cli" '^[0-9]+\.' "$accept"
}

get_session_manager_plugin_versions() {
    curl -s "https://github.com/aws/session-manager-plugin/tags" \
        | grep -Po '(/aws/session-manager-plugin/releases/tag/\K[\w.+\-]+)|datetime="\K[^"]+' \
        | emit_pairs "session-manager-plugin" '^[0-9]+\.' '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
}

case "$target" in
    aws-cli)
        get_awscli_versions
        ;;
    session-manager-plugin)
        get_session_manager_plugin_versions
        ;;
    both)
        cat <(get_awscli_versions) <(get_session_manager_plugin_versions)
        ;;
esac
