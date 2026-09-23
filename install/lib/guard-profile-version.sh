# install/lib/guard-profile-version.sh — 0) profile 根 package.json 缺 version 补写。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# DSH 官方 bug：initProfile 只写 name/private/dependencies/dsh，而官方
# plugin-package-inventory-deepseek 扫描相对路径 entry（如
# ./mode-experience.mjs）时会 nearestManifest 命中该 manifest，因缺
# version 抛 "must declare non-empty name and version"，最终被包成
# "DeepSeek request extension preparation failed"（REQUEST_EXTENSION）。
# 幂等补写 version=0.0.0。
MANIFEST="$WEB_DIR/package.json"
if [ -f "$MANIFEST" ]; then
  python3 - "$MANIFEST" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
if isinstance(data.get("version"), str) and data["version"]:
    print("    profile  package.json version already set")
else:
    data["version"] = "0.0.0"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("    profile  package.json version -> 0.0.0 (DSH bug guard)")
PY
fi
