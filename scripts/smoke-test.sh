#!/bin/bash
# 烟雾测试：本地启动 cc-switch，用 curl 验证非流式路径
# 用法: ./scripts/smoke-test.sh

set -e

PORT="${PORT:-17823}"
URL="http://127.0.0.1:${PORT}/v1/messages"

cleanup() {
    if [ -n "${SERVER_PID:-}" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

echo "==> Creating test DB"
TEST_DIR=$(mktemp -d)
TEST_DB="$TEST_DIR/cc-switch.db"
TEST_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

export CC_SWITCH_DB="$TEST_DB"
export CC_SWITCH_MASTER_KEY="$TEST_KEY"

echo "==> Inserting test provider"
# 直接用 bun 插入（用 CLI 子命令更友好但会触发更多依赖）
bun -e "
import { saveProvider, setCurrentProvider, openDatabase, _resetForTests } from './src/store/db.ts';
openDatabase('$TEST_DB');
await saveProvider({
  id: 'mock',
  name: 'Mock Provider',
  vendor: 'openai-compatible',
  base_url: 'http://127.0.0.1:9999',
  api_key: 'test-key',
  models: { sonnet: 'test-model' },
});
setCurrentProvider('mock');
console.log('Provider inserted');
"

echo "==> Starting cc-switch serve"
bun run src/cli.ts serve --listen-port "$PORT" &
SERVER_PID=$!
sleep 2

echo "==> Checking /health"
HEALTH=$(curl -sf "http://127.0.0.1:${PORT}/health")
echo "Response: $HEALTH"
echo "$HEALTH" | grep -q '"status":"ok"' || { echo "Health check failed"; exit 1; }

echo "==> Checking /v1/models"
MODELS=$(curl -sf "http://127.0.0.1:${PORT}/v1/models")
echo "Response: $MODELS"
echo "$MODELS" | grep -q '"type":"model"' || { echo "Models endpoint failed"; exit 1; }

echo "==> Sending test request (expecting upstream error since mock URL)"
RESPONSE=$(curl -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "anthropic-version: 2023-06-01" \
    -d '{
        "model": "sonnet",
        "max_tokens": 50,
        "messages": [{"role": "user", "content": "Hello"}]
    }' \
    -w "\nHTTP_CODE:%{http_code}")
HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)
echo "HTTP code: $HTTP_CODE"

if [ "$HTTP_CODE" = "502" ] || [ "$HTTP_CODE" = "503" ]; then
    echo "OK: Got expected upstream/network error ($HTTP_CODE) - protocol layer is working"
elif [ "$HTTP_CODE" = "200" ]; then
    echo "Unexpected success - mock provider is actually reachable?"
else
    echo "Unexpected status code: $HTTP_CODE"
    echo "$RESPONSE"
    exit 1
fi

rm -rf "$TEST_DIR"

echo ""
echo "==> All smoke tests passed"