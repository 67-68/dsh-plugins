#!/bin/bash
# verify-architecture.sh — ARCHITECTURE.md 的可执行护栏（只读检查，不写文件）。
# 用法：./scripts/verify-architecture.sh（仓库根下运行，exit 0=全过）。
HERE="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
bad() { echo "FAIL: $1"; fail=1; }
ok() { echo "ok: $1"; }

# 规则1：包骨架
for pkg in "$HERE"/packages/*/; do
  name="$(basename "$pkg")"
  [ -f "$pkg/package.json" ] || { bad "$name 缺 package.json"; continue; }
  [ -d "$pkg/lib" ] || { bad "$name 缺 lib/"; continue; }
  node -e "const m=require('$pkg/package.json');if(!m.main||!m.main.startsWith('lib/')){process.exit(1)}" \
    || { bad "$name main 未指向 lib/"; continue; }
  roots="$(find "$pkg" -maxdepth 1 -name '*.js' | head -3)"
  [ -z "$roots" ] || { bad "$name 包根散落 js: $roots"; continue; }
  ok "$name 骨架"
done

# 规则2：mode-gate 分层
top="$(ls "$HERE"/packages/dsh-mode-gate/lib/*.js 2>/dev/null | xargs -n1 basename | sort | tr '\n' ' ')"
[ "$top" = "client.js index.js " ] || bad "mode-gate 顶层应仅 index+client，实为: $top"
for d in stores engine services tools gateway shared; do
  [ -d "$HERE/packages/dsh-mode-gate/lib/$d" ] || bad "mode-gate 缺 $d/"
done
# 子目录白名单：超出即散落
subdirs="$(ls "$HERE/packages/dsh-mode-gate/lib" | sort | tr '\n' ' ')"
[ "$subdirs" = "client.js engine gateway index.js services shared stores tools " ] || bad "mode-gate lib 子目录越界，实为: $subdirs"
[ -d "$HERE/packages/dsh-mode-gate/workflows" ] || bad "mode-gate 缺 workflows/"
ok "mode-gate 分层"

# 规则3：无跨包引用、无逃逸引用
viol="$(grep -rn --include='*.js' --include='*.mjs' -E "from ['\"]\.\./(dsh-|packages)" "$HERE/packages" "$HERE/plugins" || true)"
[ -z "$viol" ] || bad "跨包/逃逸引用:\n$viol"
esc="$(cd "$HERE" && node -e '
const {execSync}=require("child_process"),fs=require("fs"),path=require("path");
const files=execSync("find packages plugins -name \x27*.js\x27 -o -name \x27*.mjs\x27").toString().trim().split("\n");
let bad=[];
for(const f of files){const d=path.dirname(path.resolve(f));
for(const m of fs.readFileSync(f,"utf8").matchAll(/from\s+["\x27](\.[^"\x27]+)["\x27]/g)){
const t=path.resolve(d,m[1]);
const pkg=f.startsWith("packages/")?path.resolve(f.split("/").slice(0,2).join("/")):path.resolve("plugins");
if(!t.startsWith(pkg))bad.push(f+" -> "+m[1]);}}
if(bad.length){console.log(bad.join("\n"));process.exit(1);}' || true)"
[ -z "$esc" ] || bad "逃逸引用:\n$esc"
ok "依赖方向"

# 规则4：无本机绝对路径
abs="$(grep -rn -E '/Users/|/home/[a-z]' profile/ install/ plugins/ packages/ presets/ preset-actions/ extensions/ 2>/dev/null | grep -v node_modules || true)"
[ -z "$abs" ] || bad "本机绝对路径:\n$abs"
ok "路径可移植"

# 规则5：document/ 与 docs/plans/ 无同名
dup="$(comm -12 <(ls "$HERE/document" | sort) <(ls "$HERE/docs/plans" | sort) || true)"
[ -z "$dup" ] || bad "文档同名碰撞: $dup"
ok "文档边界"

# 规则6：构建与归档
[ -d "$HERE/temp" ] || bad "缺 temp/ 构建缓存目录（gitignored）"
top_scripts="$(ls "$HERE/scripts" | sort | tr '\n' ' ')"
[ "$top_scripts" = "archive build-mermaid.mjs verify-architecture.sh " ] || bad "scripts/ 顶层应仅 archive+build+护栏，实为: $top_scripts"
ver_ext="$(find "$HERE/extensions" -maxdepth 1 -name '*-[0-9]*' | head -3)"
[ -z "$ver_ext" ] || bad "extensions/ 带版本号目录: $ver_ext"
[ -f "$HERE/docs/INDEX.md" ] || bad "缺 docs/INDEX.md 意图索引"
ok "构建与归档"

# 规则7：containment（上级目录必然包含下级模块）
MG="$HERE/packages/dsh-mode-gate/lib"
# 7a. tools/gateway 只许被 index 引用（下层 stores/engine/services 不得反向引用）
rev="$(grep -rn --include='*.js' -E "from '\.\./(tools|gateway)/" "$MG/stores" "$MG/engine" "$MG/services" || true)"
[ -z "$rev" ] || bad "反向引用（下层→tools/gateway）:\n$rev"
# 7b. tools/gateway 下每个模块都必须被 index 引用（无孤儿散落）
orphan=""
for f in "$MG"/tools/*.js "$MG"/gateway/*.js; do
  base="$(basename "$f" .js)"
  grep -q "$base" "$MG/index.js" || orphan="$orphan $f"
done
[ -z "$orphan" ] || bad "孤儿模块（index 未引用）:$orphan"
# 7c. gateway markRemoteMethods 名单与类方法对齐（防漂移）
drift="$(cd "$HERE" && node -e '
const fs=require("fs");
const src=fs.readFileSync("packages/dsh-mode-gate/lib/gateway/gateway.js","utf8");
const block=src.match(/markRemoteMethods\(ModeGateGateway, \[([\s\S]*?)\]\);/)[1];
const listed=[...block.matchAll(/\x27([\w$]+)\x27/g)].map(m=>m[1]);
const methods=new Set([...src.matchAll(/async (\w+)\s*\(/g)].map(m=>m[1]));
const missing=listed.filter(n=>!methods.has(n));
if(missing.length){console.log(missing.join(","));process.exit(1);}' || true)"
[ -z "$drift" ] || bad "gateway 名单漂移（无对应方法）: $drift"
# 7d. shared 为叶模块：不得引用 lib 内兄弟模块（只许 node: 内建），被依赖方向单向
leaf="$(grep -rn --include='*.js' -E "from '\.\./(stores|engine|services|tools|gateway)/" "$MG/shared" || true)"
[ -z "$leaf" ] || bad "shared 越层引用兄弟模块:\n$leaf"
# 7e. shared 下每个模块都必须被 tools/gateway/index 引用（无孤儿散落）
sorphan=""
for f in "$MG"/shared/*.js; do
  base="$(basename "$f" .js)"
  grep -rq "$base" "$MG/tools" "$MG/gateway" "$MG/index.js" || sorphan="$sorphan $f"
done
[ -z "$sorphan" ] || bad "shared 孤儿模块（无人引用）:$sorphan"
ok "containment 归位"

[ "$fail" = 0 ] && echo "ALL ARCHITECTURE CHECKS PASSED" || echo "ARCHITECTURE CHECKS FAILED"
exit "$fail"
