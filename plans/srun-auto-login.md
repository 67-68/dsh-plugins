# 校网自动登录（SRUN）— 实现计划

## 目标
开机后一键（Raycast）完成深澜 SRUN 校园网认证，纯 Python 标准库，无第三方依赖。

## 架构决策
- **触发**：Raycast Script Command（手动/快捷键触发），贴合「开机才连」场景。
- **运行平台**：这台 Mac（macOS）。
- **凭据**：`~/.config/srun-login/config.ini`，chmod 600。
- **协议**：已逆向 `Portal.js`（v2.00.20231026），常量 `ac_id=4 / enc_ver=srun_bx1 / n=200 / type=1`。

## 文件结构
```
~/.config/srun-login/config.ini       # 凭据 + ac_id + 门户地址（chmod 600）
~/.config/srun-login/srun.py          # 核心库：协议实现（纯 stdlib）
<raycast-scripts-dir>/srun-login.py   # Raycast Script Command（@raycast 头 + 调核心）
```

## 协议流程（已确认到代码行）
```
Step 0 协议同意（best-effort，可跳过）
  GET  /v1/srun_portal_agrees?user_name=<u>          → 已同意协议 id 列表
  POST /v1/srun_portal_agree_bind  agree_id=<id>&user_name=<u>   （未同意最新协议时）

Step 1 取挑战
  GET  /cgi-bin/get_challenge?username=<u>&ip=<ip>   → JSONP 里取 challenge(token)

Step 2 计算
  hmd5   = HMAC-MD5(key=token, msg=password).hexdigest()
  info   = "{SRBX1}" + b64'( xEncode( JSON{username,password,ip,acid,enc_ver:"srun_bx1"}, token ) )
  chksum = SHA1( token+username + token+hmd5 + token+ac_id + token+ip + token+n + token+type + token+info )

Step 3 认证（JSONP = GET）
  GET /cgi-bin/srun_portal
      ?action=login&username=<u>&password={MD5}<hmd5>
      &os=<device>&name=<platform>&double_stack=0
      &chksum=<chksum>&info=<info>&ac_id=4&ip=<ip>&n=200&type=1

Step 4 确认在线
  GET /cgi-bin/rad_user_info?ip=<ip>   → 在线则成功
```

## 核心算法要点（从 JS 直译，Python 必须 & 0xFFFFFFFF）
- **HMAC-MD5**：`hmac.new(key=token.encode(), msg=password.encode(), digestmod=hashlib.md5).hexdigest()`
  （js-md5 签名 `md5(message, key)`，即 key=token、msg=password）
- **xEncode（TEA 变种）**，常量：
  - `delta = 0x9E3779B9`（源码写成 `0x86014019 | 0x183639A0`）
  - 每次加法后 `& 0xFFFFFFFF`（源码写成 `| 0xEFB8D130 | 0x10472ECF` 等，均为 0xFFFFFFFF 混淆）
  - `q = 6 + 52 // (n+1)`，`e = (d >> 2) & 3`
  - 小端打包 uint32 / 拆包
- **自定义 base64**：标准 base64 + 字母表
  `LVoJPiCN2R8G90yg+hmFHuacZ1OWMnrsSTXkYpUq/3dlbfKwv6xztjI7DeBE45QA`
- **JSONP**：GET 带 `callback` 参数，响应为 `cb({...})`，需剥离回调包裹再 `json.loads`

## 安全
- config.ini 明文存密码，chmod 600；脚本不打印密码。
- 登录成功后仅提示「已上线」，不泄露凭据。

## 验收标准
1. 首次运行：能完成 同意协议 → 取 token → 计算 → 认证 → 确认在线。
2. 再次运行（已同意协议/已在线）：幂等，不报错。
3. Raycast 输入关键词触发，compact 模式 toast 显示「✅ 已登录」或失败原因。

## 部署注意事项
- 脚本写到 `~/.config/` 与 Raycast 目录，均在 session workspace 之外，
  落地时需授权（sandbox 提权）或由用户在 code 模式确认后执行。

## 可选 backlog
- 第二个 Command「Srun Status」查在线状态/流量。
- 以后若要自动重连，复用同一 srun.py 核心，加 launchd 定时即可（零成本）。
