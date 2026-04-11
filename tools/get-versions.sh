#!/bin/bash
set -euo pipefail

# AWS CLI v2 および session-manager-plugin のバージョン一覧を取得する
# 引数: [aws-cli | session-manager-plugin] （省略時は両方）
# --all オプションを付けると aws-cli v1 も表示する
#
# 出力形式: <tool>\t<version>\t<datetime>

target="both"
all=false

for arg in "$@"; do
    case "$arg" in
        --all) all=true ;;
        aws-cli) target="aws-cli" ;;
        session-manager-plugin) target="session-manager-plugin" ;;
    esac
done

get_awscli_versions() {
    curl -s "https://github.com/aws/aws-cli/tags" | \
        grep -Po '(/aws/aws-cli/releases/tag/\K\d\.\d+\.\d+)|datetime="\K[^"]+' | \
        while read -r line; do
            if [[ "$line" =~ ^.\. ]]; then
                tag="$line"
            elif $all || [[ "$tag" =~ ^2\. ]]; then
                printf 'aws-cli\t%s\t%s\n' "$tag" "$line"
            fi
        done
}

get_session_manager_plugin_versions() {
    curl -s "https://github.com/aws/session-manager-plugin/tags" | \
        grep -Po '(/aws/session-manager-plugin/releases/tag/\K[\d.]+)|datetime="\K[^"]+' | \
        while read -r line; do
            if [[ "$line" =~ ^[0-9]+\. ]]; then
                tag="$line"
            else
                printf 'session-manager-plugin\t%s\t%s\n' "$tag" "$line"
            fi
        done
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
