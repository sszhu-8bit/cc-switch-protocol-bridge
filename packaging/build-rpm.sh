#!/bin/bash
# 构建 .rpm 包
# 假设当前在项目根目录，运行在 GitHub Actions ubuntu-latest runner 上
# 用 Docker 容器跑 rpmbuild 避免污染主机

set -euo pipefail

VERSION="${VERSION:-0.1.0}"
PACKAGE_NAME="cc-switch"
ARCH="x86_64"

echo "==> Building Linux x64 binary with bun"
bun build src/cli.ts \
    --compile \
    --target=bun-linux-x64 \
    --outfile="dist/${PACKAGE_NAME}"

echo "==> Setting up rpmbuild directories"
RPMBUILD="$PWD/.rpmbuild"
mkdir -p "$RPMBUILD"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# 准备源码包（spec 文件需要的 SOURCES）
cp "dist/${PACKAGE_NAME}" "$RPMBUILD/SOURCES/${PACKAGE_NAME}"
cp "config/config.example.yaml" "$RPMBUILD/SOURCES/config.example.yaml"
cp "packaging/systemd/cc-switch.service" "$RPMBUILD/SOURCES/cc-switch.service"
cp "packaging/postinstall.sh" "$RPMBUILD/SOURCES/postinstall.sh"
cp "packaging/preremove.sh" "$RPMBUILD/SOURCES/preremove.sh"
cp "packaging/postremove.sh" "$RPMBUILD/SOURCES/postremove.sh"
cp "packaging/cc-switch.spec" "$RPMBUILD/SPECS/cc-switch.spec"

# 替换 spec 里的版本号
sed -i "s/%{version}/${VERSION}/g" "$RPMBUILD/SPECS/cc-switch.spec"

echo "==> Running rpmbuild in AlmaLinux 9 container"
docker run --rm \
    --platform linux/amd64 \
    -v "$RPMBUILD:/root/rpmbuild" \
    -v "$PWD/dist:/dist" \
    almalinux:9 \
    bash -c '
        set -e
        dnf install -y rpm-build rpmdevtools systemd
        rpmbuild -ba /root/rpmbuild/SPECS/cc-switch.spec
        # 复制到挂载点
        mkdir -p /dist
        cp /root/rpmbuild/RPMS/x86_64/*.rpm /dist/ || true
    '

echo "==> RPM package built:"
ls -la "$PWD/dist/"*.rpm 2>/dev/null || echo "RPM not found in dist/"