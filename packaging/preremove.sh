#!/bin/bash
# pre-remove: 卸载前停止服务
set -e

if [ -d /run/systemd/system ]; then
    systemctl stop cc-switch.service || true
    systemctl disable cc-switch.service || true
fi

exit 0