#!/usr/bin/env python3
"""
Suno Console Bridge - 本地轻量服务
提供与油猴脚本完全兼容的本地 API 接口，并托管前端 Web 控制台。
零第三方依赖，纯 Python 3 标准库实现。
"""

import http.server
import json
import mimetypes
import os
import sys
import time
import urllib.parse
from datetime import datetime

PORT = 3000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')
DATA_FILE = os.path.join(BASE_DIR, 'auth_cache.json')

class BridgeStateManager:
    """管理从油猴脚本同步过来的 Suno 认证凭据"""
    def __init__(self, file_path):
        self.file_path = file_path
        self.data = self._load()

    def _load(self):
        if os.path.exists(self.file_path):
            try:
                with open(self.file_path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        return {"headers": None, "capturedAt": 0, "user": None}

    def save(self, headers, user=None):
        self.data = {
            "headers": headers,
            "capturedAt": int(time.time() * 1000),
            "user": user or self._parse_jwt_claims(headers.get("authorization", ""))
        }
        with open(self.file_path, 'w', encoding='utf-8') as f:
            json.dump(self.data, f, indent=2, ensure_ascii=False)

    def clear(self):
        self.data = {"headers": None, "capturedAt": 0, "user": None}
        if os.path.exists(self.file_path):
            try:
                os.remove(self.file_path)
            except Exception:
                pass

    def get_auth(self):
        return self.data

    def _parse_jwt_claims(self, auth_header):
        if not auth_header or not auth_header.startswith("Bearer "):
            return None
        token = auth_header.replace("Bearer ", "").strip()
        parts = token.split(".")
        if len(parts) != 3:
            return None
        import base64
        try:
            padded = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
            payload = base64.urlsafe_b64decode(padded)
            return json.loads(payload)
        except Exception:
            return None

state_manager = BridgeStateManager(DATA_FILE)

class BridgeRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def _send_json(self, status_code, data):
        response_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()
        self.wfile.write(response_bytes)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 兼容脚本的 /api/session
        if path == '/api/session':
            auth_info = state_manager.get_auth()
            claims = auth_info.get("user") or {}
            user_id = claims.get("sub") or claims.get("suno.com/claims/user_id") or "Local Developer"
            email = claims.get("email") or claims.get("suno.com/claims/email") or ""
            exp = claims.get("exp", 0)

            user_data = {
                "user": {
                    "id": user_id,
                    "displayName": f"Suno User ({user_id[:8]}...)" if user_id != "Local Developer" else "本地工作台用户",
                    "email": email,
                    "isOnline": bool(auth_info.get("headers")),
                    "capturedAt": auth_info.get("capturedAt", 0),
                    "expiresAt": exp * 1000 if exp else None
                }
            }
            self._send_json(200, user_data)
            return

        # 凭据及状态查看接口
        if path == '/api/status':
            auth_info = state_manager.get_auth()
            has_auth = bool(auth_info.get("headers"))
            self._send_json(200, {
                "ok": True,
                "hasAuth": has_auth,
                "capturedAt": auth_info.get("capturedAt"),
                "user": auth_info.get("user")
            })
            return

        # 获取当前缓存的 Headers
        if path == '/api/auth-cache':
            self._send_json(200, state_manager.get_auth())
            return

        # 其它静态资源直接交给 SimpleHTTPRequestHandler
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 接收油猴脚本同步过来的 Token 凭证
        if path == '/api/auth':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body.decode('utf-8'))
                headers = payload.get('headers')
                if not headers:
                    self._send_json(400, {"error": "Missing headers payload"})
                    return

                state_manager.save(headers)
                claims = state_manager.get_auth().get("user") or {}
                user_id = claims.get("sub") or "authenticated_user"

                print(f"[{datetime.now().strftime('%H:%M:%S')}] \033[92m✔ 成功同步 Suno 凭证!\033[0m User: {user_id}")
                self._send_json(200, {
                    "ok": True,
                    "auth": {
                        "userId": user_id,
                        "syncedAt": int(time.time() * 1000)
                    }
                })
            except Exception as e:
                self._send_json(500, {"error": f"Failed to save credentials: {str(e)}"})
            return

        self._send_json(404, {"error": "Not Found"})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == '/api/auth':
            state_manager.clear()
            print(f"[{datetime.now().strftime('%H:%M:%S')}] \033[93m⚠ Suno 凭据已重置/标记过期\033[0m")
            self._send_json(200, {"ok": True, "message": "Auth cleared"})
            return

        self._send_json(404, {"error": "Not Found"})

def run_server():
    server_address = ('', PORT)
    httpd = http.server.ThreadingHTTPServer(server_address, BridgeRequestHandler)
    print("\n" + "=" * 55)
    print(f"\033[1;36m🎵 Suno Console Bridge 本地服务已启动\033[0m")
    print(f"🔗 本地 Web 控制台: \033[4;32mhttp://localhost:{PORT}\033[0m")
    print(f"📦 监听端口: {PORT}")
    print(f"💡 请确保已在浏览器中安装配套油猴脚本并打开 Suno 官网")
    print("=" * 55 + "\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
        httpd.server_close()

if __name__ == '__main__':
    run_server()
