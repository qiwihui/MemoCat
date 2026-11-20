#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p "parseInt(process.versions.node, 10) >= 24" 2>/dev/null)" != "true" ]; then
  for dir in "$HOME"/.nvm/versions/node/v24.*/bin; do
    if [ -x "$dir/node" ]; then
      export PATH="$dir:$PATH"
    fi
  done
fi
if [ -f node_modules/electron/path.txt ]; then
  exec npm run desktop
else
  echo '桌面运行时尚未安装，启动本机网页版本：http://127.0.0.1:3792'
  exec npm start
fi
