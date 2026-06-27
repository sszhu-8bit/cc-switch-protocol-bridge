# RPM spec file for cc-switch-protocol-bridge
# Build on AlmaLinux 9 / RHEL 9 / Rocky Linux 9

Name:           cc-switch
Version:        %{version}
Release:        1%{?dist}
Summary:        Lightweight Anthropic to OpenAI protocol bridge for Linux servers
License:        MIT
URL:            https://github.com/yourname/cc-switch-protocol-bridge
BuildArch:      x86_64

Requires:       systemd

%description
cc-switch-protocol-bridge is a lightweight HTTP proxy that translates
Anthropic Messages API requests (used by Claude Code) into OpenAI Chat
Completions API requests, enabling Claude Code to work with domestic
LLM providers that only expose OpenAI-compatible endpoints
(MiniMax, Alibaba DashScope, Volcengine Ark, etc.).

%pre
# nothing to do before install

%post
/bin/bash /usr/share/cc-switch/postinstall.sh

%preun
/bin/bash /usr/share/cc-switch/preremove.sh

%postun
/bin/bash /usr/share/cc-switch/postremove.sh "$1"

%install
mkdir -p %{buildroot}/usr/bin
mkdir -p %{buildroot}/usr/share/cc-switch
mkdir -p %{buildroot}/etc/cc-switch
mkdir -p %{buildroot}/var/log/cc-switch
mkdir -p %{buildroot}/usr/lib/systemd/system

# 二进制文件（由构建脚本传入 BINARY_PATH）
install -m 0755 %{SOURCE0} %{buildroot}/usr/bin/cc-switch

# 配置示例（不覆盖用户配置）
install -m 0644 %{SOURCE1} %{buildroot}/usr/share/cc-switch/config.example.yaml

# systemd 服务文件
install -m 0644 %{SOURCE2} %{buildroot}/usr/lib/systemd/system/cc-switch.service

# 安装/卸载钩子
install -m 0755 %{SOURCE3} %{buildroot}/usr/share/cc-switch/postinstall.sh
install -m 0755 %{SOURCE4} %{buildroot}/usr/share/cc-switch/preremove.sh
install -m 0755 %{SOURCE5} %{buildroot}/usr/share/cc-switch/postremove.sh

%files
%attr(0755, root, root) /usr/bin/cc-switch
%dir /etc/cc-switch
%dir /var/log/cc-switch
%attr(0644, root, root) /usr/lib/systemd/system/cc-switch.service
%attr(0755, root, root) /usr/share/cc-switch/postinstall.sh
%attr(0755, root, root) /usr/share/cc-switch/preremove.sh
%attr(0755, root, root) /usr/share/cc-switch/postremove.sh
%attr(0644, root, root) /usr/share/cc-switch/config.example.yaml

%changelog
* Thu Jan 01 2026 cc-switch contributors <noreply@example.com> - 0.1.0-1
- Initial RPM release
- Anthropic to OpenAI protocol conversion (single + streaming)
- MiniMax, OpenAI-compatible providers
- systemd system service integration