#!/bin/bash
# post-remove: 清理用户（仅 purge 时）
set -e

if [ "$1" = "0" ]; then
    # 仅在完全卸载（rpm -e，不含 --nodeps）时清理
    if id -u ccswitch >/dev/null 2>&1; then
        userdel ccswitch 2>/dev/null || true
    fi
fi

exit 0