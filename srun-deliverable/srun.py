#!/usr/bin/env python3
"""SRUN campus network login library (pure Python standard library).

Implements the SRUN (深澜) portal login protocol flow:
  1. fetch the portal-assigned IP from the portal page
  2. agreement binding (failures are logged, not fatal)
  3. get_challenge
  4. compute hmd5 (HMAC-MD5), info ({SRBX1}+custom-base64(xencode)), chksum (SHA1)
  5. srun_portal login (GET / JSONP)
  6. rad_user_info online confirmation
"""

import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time
import traceback
import urllib.parse
import urllib.request

_STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
_CUSTOM_ALPHABET = "LVoJPiCN2R8G90yg+hmFHuacZ1OWMnrsSTXkYpUq/3dlbfKwv6xztjI7DeBE45QA"

_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
_OS = "Windows 10"
_NAME = "Windows"
_N = "200"
_TYPE = "1"
_CALLBACK = "cb"

_LOG_PATH = os.path.join(os.path.expanduser("~"), ".config", "srun-login", "srun.log")


def _log(msg):
    """Append a timestamped diagnostic line to the log file (best-effort)."""
    try:
        with open(_LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def _log_exc(context):
    _log("%s raised:\n%s" % (context, traceback.format_exc()))


def xencode(msg, key):
    """SRUN TEA variant (little-endian uint32)."""
    if not msg:
        return ""

    def pack(s, append_len):
        v = []
        n = len(s)
        for i in range(0, n, 4):
            a = ord(s[i])
            b = ord(s[i + 1]) if i + 1 < n else 0
            c = ord(s[i + 2]) if i + 2 < n else 0
            d = ord(s[i + 3]) if i + 3 < n else 0
            v.append(a | (b << 8) | (c << 16) | (d << 24))
        if append_len:
            idx = n >> 2
            if idx < len(v):
                v[idx] = n
            else:
                v.append(n)
        return v

    def unpack(v):
        out = []
        for x in v:
            out.append(chr(x & 0xFF))
            out.append(chr((x >> 8) & 0xFF))
            out.append(chr((x >> 16) & 0xFF))
            out.append(chr((x >> 24) & 0xFF))
        return "".join(out)

    v = pack(msg, True)
    k = pack(key, False)
    while len(k) < 4:
        k.append(0)
    n = len(v) - 1
    z = v[n]
    c = 0x9E3779B9  # delta
    q = 6 + 52 // (n + 1)
    d = 0
    while q > 0:
        q -= 1
        d = (d + c) & 0xFFFFFFFF
        e = (d >> 2) & 3
        for p in range(n):
            y = v[p + 1]
            m = (z >> 5) ^ ((y << 2) & 0xFFFFFFFF)
            m = (m + ((y >> 3) ^ ((z << 4) & 0xFFFFFFFF) ^ (d ^ y))) & 0xFFFFFFFF
            m = (m + (k[(p & 3) ^ e] ^ z)) & 0xFFFFFFFF
            z = v[p] = (v[p] + m) & 0xFFFFFFFF
        y = v[0]
        m = (z >> 5) ^ ((y << 2) & 0xFFFFFFFF)
        m = (m + ((y >> 3) ^ ((z << 4) & 0xFFFFFFFF) ^ (d ^ y))) & 0xFFFFFFFF
        m = (m + (k[(n & 3) ^ e] ^ z)) & 0xFFFFFFFF
        z = v[n] = (v[n] + m) & 0xFFFFFFFF
    return unpack(v)


def _srun_b64(s):
    """standard base64 -> SRUN custom alphabet (padding '=' kept, matches jquery-base64)."""
    std = base64.b64encode(s.encode("latin-1")).decode("ascii")
    table = str.maketrans(_STD_ALPHABET, _CUSTOM_ALPHABET)
    return std.translate(table)


def _compute_hmd5(token, password):
    return hmac.new(key=token.encode(), msg=password.encode(), digestmod=hashlib.md5).hexdigest()


def _compute_info(token, username, password, ip, ac_id):
    json_str = json.dumps(
        {"username": username, "password": password, "ip": ip, "acid": ac_id, "enc_ver": "srun_bx1"},
        separators=(",", ":"),
    )
    return "{SRBX1}" + _srun_b64(xencode(json_str, token))


def _compute_chksum(token, username, hmd5, ac_id, ip, info):
    payload = (
        token + username
        + token + hmd5
        + token + ac_id
        + token + ip
        + token + _N
        + token + _TYPE
        + token + info
    )
    return hashlib.sha1(payload.encode()).hexdigest()


def _http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _parse_jsonp(text):
    start = text.find("(")
    end = text.rfind(")")
    if start != -1 and end != -1 and end > start:
        text = text[start + 1:end]
    return json.loads(text)


def _get_jsonp(url):
    return _parse_jsonp(_http_get(url))


def get_ip(host, ac_id):
    """Fetch the portal-assigned IP from the portal page (not the local NIC IP)."""
    url = host + "/srun_portal_pc?" + urllib.parse.urlencode({"ac_id": ac_id, "theme": "pro"})
    html = _http_get(url)
    cfg = re.search(r"var\s+CONFIG\s*=\s*(\{.*?\})\s*;", html, re.S)
    if not cfg:
        raise RuntimeError("portal page has no CONFIG block")
    m = re.search(r'(?<![\w])ip\s*:\s*"([0-9.]+)"', cfg.group(1))
    if not m:
        raise RuntimeError("could not extract ip from portal CONFIG")
    return m.group(1)


def _get_challenge(host, username, ip):
    url = host + "/cgi-bin/get_challenge?" + urllib.parse.urlencode({"callback": _CALLBACK, "username": username, "ip": ip})
    data = _get_jsonp(url)
    return data.get("challenge")


def _post_form(host, path, data):
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(
        host + path,
        data=body,
        headers={"User-Agent": _USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read()


def _agree(host, username):
    """Bind the latest agreement before login. Non-blocking; failures are logged."""
    try:
        url = host + "/v1/srun_portal_agree_new?" + urllib.parse.urlencode({"agree_type": "1"})
        latest_id = json.loads(_http_get(url))["data"]["id"]
    except Exception:
        _log_exc("agree: fetch latest agreement (agree_new)")
        return
    try:
        url = host + "/v1/srun_portal_agrees?" + urllib.parse.urlencode({"user_name": username})
        items = json.loads(_http_get(url))["data"]
        agreed = set()
        for it in items:
            if isinstance(it, dict):
                it = it.get("id")
            if it is not None:
                agreed.add(str(it))
    except Exception:
        _log_exc("agree: fetch agreed list (agrees)")
        return
    if str(latest_id) in agreed:
        return
    try:
        raw = _post_form(host, "/v1/srun_portal_agree_bind", {"agree_id": latest_id, "user_name": username})
        data = json.loads(raw.decode("utf-8", errors="replace"))
        if data.get("code") != 0:
            _log("agree: bind failed, response=%s" % data)
    except Exception:
        _log_exc("agree: bind")


def _build_login_params(username, hmd5, ip, ac_id, chksum, info):
    return {
        "callback": _CALLBACK,
        "action": "login",
        "username": username,
        "password": "{MD5}" + hmd5,
        "os": _OS,
        "name": _NAME,
        "double_stack": "0",
        "chksum": chksum,
        "info": info,
        "ac_id": ac_id,
        "ip": ip,
        "n": _N,
        "type": _TYPE,
    }


_ERROR_MSGS = {
    "auth_info_error": "账号或密码错误",
    "check_sum_error": "校验和(checksum)错误",
    "ip_already_online_error": "该 IP 已在线",
    "not_online_error": "设备未上线",
    "user_must_modify_password": "需要修改密码",
    "missing_required_parameters_error": "缺少必要参数",
}


def _extract_error(data):
    if not isinstance(data, dict):
        return str(data)
    raw = None
    for key in ("error_msg", "error", "msg", "message"):
        val = data.get(key)
        if isinstance(val, str) and val and val.lower() not in ("ok", "0", "success"):
            raw = val
            break
    if raw is None:
        ecode = data.get("ecode")
        if ecode not in (None, 0, "0"):
            raw = "ecode=%s" % ecode
        else:
            raw = json.dumps(data, ensure_ascii=False)
    return _ERROR_MSGS.get(raw, raw)


def check_online(host, ip):
    host = host.rstrip("/")
    url = host + "/cgi-bin/rad_user_info?" + urllib.parse.urlencode({"callback": _CALLBACK, "ip": ip})
    try:
        data = _get_jsonp(url)
    except Exception:
        _log_exc("check_online")
        return False
    return data.get("error") == "ok" or bool(data.get("user_name")) or bool(data.get("online_ip"))


_CONNECTIVITY_URLS = (
    "http://captive.apple.com",
    "http://www.baidu.com",
)


def check_connectivity(host, timeout=3):
    """True if real internet access works (ignores stale RADIUS sessions).

    When unauthenticated, the SRUN gateway redirects HTTP to the portal, so a
    fetch whose final host is the portal means we are offline.
    """
    portal_host = urllib.parse.urlparse(host).hostname
    for url in _CONNECTIVITY_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp.read(64)
                final = resp.geturl()
            if urllib.parse.urlparse(final).hostname == portal_host:
                continue  # redirected to the portal -> offline
            return True  # reached a real external host -> online
        except Exception:
            continue
    return False


def wait_online(host, tries=3, delay=2.0):
    """Poll connectivity briefly to absorb SRUN session propagation delay."""
    for _ in range(tries):
        if check_connectivity(host):
            return True
        time.sleep(delay)
    return check_connectivity(host)


def login(host, ac_id, username, password):
    host = host.rstrip("/")
    try:
        ip = get_ip(host, ac_id)
    except Exception as exc:
        _log_exc("login: get_ip")
        return {"ok": False, "msg": "获取 IP 失败: %s" % exc}
    _log("login start: ip=%s username=%s" % (ip, username))
    _agree(host, username)
    try:
        token = _get_challenge(host, username, ip)
    except Exception as exc:
        _log_exc("login: get_challenge")
        return {"ok": False, "msg": "获取 challenge 失败: %s" % exc}
    if not token:
        _log("login: empty challenge (ip=%s)" % ip)
        return {"ok": False, "msg": "challenge 为空"}
    hmd5 = _compute_hmd5(token, password)
    info = _compute_info(token, username, password, ip, ac_id)
    chksum = _compute_chksum(token, username, hmd5, ac_id, ip, info)
    params = _build_login_params(username, hmd5, ip, ac_id, chksum, info)
    url = host + "/cgi-bin/srun_portal?" + urllib.parse.urlencode(params)
    try:
        raw = _http_get(url)
    except Exception as exc:
        _log_exc("login: srun_portal request")
        return {"ok": False, "msg": "认证接口请求失败: %s" % exc}
    _log("login: srun_portal response: %s" % raw)
    try:
        resp = _parse_jsonp(raw)
    except Exception as exc:
        _log_exc("login: parse srun_portal response")
        return {"ok": False, "msg": "认证接口响应解析失败: %s" % exc}
    if not isinstance(resp, dict):
        _log("login: unexpected srun_portal response: %r" % (resp,))
        return {"ok": False, "msg": "认证接口返回异常: %r" % (resp,)}
    if resp.get("error") == "ok" or resp.get("res") == "ok":
        if wait_online(host):
            return {"ok": True, "msg": "ok"}
        _log("login: srun_portal returned ok but connectivity not confirmed")
        return {"ok": False, "msg": "认证成功但未检测到联网（会话可能延迟，稍后重试）"}
    return {"ok": False, "msg": _extract_error(resp)}


def _test():
    host = "http://10.0.0.9"
    ac_id = "4"
    username = "testuser"
    password = "testpass"
    print("[1/4] fetching portal ip ...")
    ip = get_ip(host, ac_id)
    print("      ip        =", ip)
    print("[2/4] fetching challenge ...")
    token = _get_challenge(host, username, ip)
    print("      challenge =", token)
    if not token:
        print("ERROR: empty challenge")
        return 1
    print("[3/4] computing hmd5/info/chksum ...")
    hmd5 = _compute_hmd5(token, password)
    info = _compute_info(token, username, password, ip, ac_id)
    chksum = _compute_chksum(token, username, hmd5, ac_id, ip, info)
    print("      hmd5      =", hmd5)
    print("      info      =", info)
    print("      chksum    =", chksum)
    params = _build_login_params(username, hmd5, ip, ac_id, chksum, info)
    url = host + "/cgi-bin/srun_portal?" + urllib.parse.urlencode(params)
    print("[4/4] calling srun_portal ...")
    raw = _http_get(url)
    print("----- srun_portal raw response -----")
    print(raw)
    print("-------------------------------------")
    return 0


def main(argv):
    if "--test" in argv:
        return _test()
    print("usage: python3 srun.py --test")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
