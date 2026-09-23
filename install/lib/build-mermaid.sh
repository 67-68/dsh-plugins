# install/lib/build-mermaid.sh — 4b) 缺失时构建 mermaid 静态产物。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# Build the mermaid static asset if it is missing, so the cp -R below
# ships a ready-to-serve IIFE bundle. Idempotent: skip when already built.
MERMAID_ASSET="$HERE/packages/dsh-mermaid/lib/assets/mermaid.js"
if [ -f "$MERMAID_ASSET" ]; then
  echo "    asset    dsh-mermaid mermaid.js (already built)"
else
  echo "    asset    building dsh-mermaid mermaid.js"
  node "$HERE/scripts/build-mermaid.mjs"
fi
