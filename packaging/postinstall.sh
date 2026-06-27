#!/bin/bash
# post-install: 创建系统用户、配置目录、启动服务
set -e

if ! id -u ccswitch >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /sbin/nologin ccswitch
fi

mkdir -p /etc/cc-switch
mkdir -p /var/log/cc-switch

# 默认配置（如果用户没有提供）
if [ ! -f /etc/cc-switch/config.yaml ]; then
    cat > /etc/cc-switch/config.yaml <<'EOF'
# cc-switch-protocol-bridge configuration
listen_address: 127.0.0.1
listen_port: 15721
current_provider: ""
providers: []
EOF
    echo "[cc-switch] Default config written to /etc/cc-switch/config.yaml"
    echo "[cc-switch] Run 'cc-switch provider add' to add a provider"
fi

# systemd 服务注册
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    systemctl enable cc-switch.service
    # 不要自动启动——用户还没配 provider
    echo "[cc-switch] Service installed. After configuring a provider, run:"
    echo "[cc-switch]   sudo systemctl start cc-switch"
fi

exit 0