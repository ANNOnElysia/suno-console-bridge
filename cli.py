#!/usr/bin/env python3
"""
Suno Console Bridge - CLI 终端工具
支持在命令行查看凭据状态、测试连通性，以及在同步凭据后直接在终端执行上传。
零第三方依赖，纯标准库。
"""

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'auth_cache.json')

class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'

def load_auth():
    if not os.path.exists(DATA_FILE):
        return None
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None

def cmd_status(args):
    auth_data = load_auth()
    print("\n" + "=" * 50)
    print(f"{Colors.BOLD}{Colors.CYAN}🎵 Suno Console Bridge - 凭据状态{Colors.ENDC}")
    print("=" * 50)

    if not auth_data or not auth_data.get("headers"):
        print(f"\n{Colors.WARNING}⚠ 状态: 未检测到有效的 Suno 登录凭据{Colors.ENDC}")
        print("请按以下步骤操作：")
        print(" 1. 运行 python server.py 启动本地服务")
        print(" 2. 在浏览器打开 http://localhost:3000 并安装油猴脚本")
        print(" 3. 打开并在 suno.com 登录，凭据将自动同步到本机\n")
        return

    user = auth_data.get("user") or {}
    user_id = user.get("sub") or user.get("suno.com/claims/user_id") or "未知"
    exp = user.get("exp")
    captured_at = auth_data.get("capturedAt", 0)

    print(f"用户 ID   : {Colors.GREEN}{user_id}{Colors.ENDC}")
    if user.get("email"):
        print(f"绑定邮箱 : {user.get('email')}")
    if captured_at:
        cap_time = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(captured_at / 1000))
        print(f"同步时间 : {cap_time}")
    if exp:
        exp_time = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(exp))
        is_expired = time.time() > exp
        status_text = f"{Colors.FAIL}已过期{Colors.ENDC}" if is_expired else f"{Colors.GREEN}有效中{Colors.ENDC}"
        print(f"Token过期: {exp_time} ({status_text})")

    headers = auth_data.get("headers", {})
    print(f"关联设备 : {headers.get('device-id', '未上报')[:16]}...")
    print(f"\n{Colors.GREEN}✔ 凭据已就绪，可随时使用 WebUI 或 CLI 进行操作。{Colors.ENDC}\n")

def call_suno_api(path, method='GET', body=None):
    auth_data = load_auth()
    if not auth_data or not auth_data.get("headers"):
        raise RuntimeError("本地未保存有效的 Suno 凭据，请先在网页端同步！")

    headers = dict(auth_data["headers"])
    # 动态补充 browser-token
    bt_payload = json.dumps({"timestamp": int(time.time() * 1000)})
    browser_token = base64.b64encode(bt_payload.encode()).decode()
    headers['browser-token'] = json.dumps({"token": browser_token})
    headers['Content-Type'] = 'application/json'

    url = f"https://studio-api-prod.suno.com{path}"
    data = json.dumps(body).encode('utf-8') if body is not None else None

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read().decode('utf-8')
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode('utf-8')
        raise RuntimeError(f"Suno 接口返回 HTTP {e.code}: {err_msg}")
    except Exception as e:
        raise RuntimeError(f"连接 Suno 失败: {str(e)}")

def cmd_upload(args):
    file_path = args.file
    if not os.path.exists(file_path):
        print(f"{Colors.FAIL}错误: 文件不存在: {file_path}{Colors.ENDC}")
        return

    title = args.title or os.path.splitext(os.path.basename(file_path))[0]
    file_size = os.path.getsize(file_path)
    mime_type, _ = mimetypes.guess_type(file_path)
    mime_type = mime_type or 'audio/mpeg'

    print(f"\n{Colors.BOLD}{Colors.CYAN}🚀 开始通过 CLI 直传音频至 Suno...{Colors.ENDC}")
    print(f"文件: {file_path} ({file_size / 1024 / 1024:.2f} MB)")
    print(f"标题: {title}")

    # 步骤 1：申请 S3 预签名直传链接
    print(f"\n{Colors.BLUE}[1/3] 正在向 Suno 申请预签名直传凭据...{Colors.ENDC}")
    try:
        init_payload = {
            "title": title,
            "filename": os.path.basename(file_path),
            "size": file_size,
            "mime_type": mime_type
        }
        res = call_suno_api('/api/uploads/audio/', 'POST', init_payload)
    except Exception as e:
        # 降级尝试备用路由
        try:
            res = call_suno_api('/api/c/clips/upload/', 'POST', init_payload)
        except Exception:
            print(f"{Colors.FAIL}申请上传预签名失败: {e}{Colors.ENDC}")
            return

    upload_url = res.get("url") or res.get("upload_url") or res.get("signed_url")
    clip_id = res.get("clip_id") or res.get("id")

    if not upload_url:
        print(f"{Colors.FAIL}未能取得预签名直传链接: {res}{Colors.ENDC}")
        return

    print(f"{Colors.GREEN}✔ 获得 S3 预签名地址!{Colors.ENDC}")

    # 步骤 2：直接 PUT 到 S3
    print(f"{Colors.BLUE}[2/3] 正在直传音频至 AWS S3...{Colors.ENDC}")
    try:
        with open(file_path, 'rb') as f:
            file_data = f.read()

        s3_req = urllib.request.Request(
            upload_url,
            data=file_data,
            headers={'Content-Type': mime_type},
            method='PUT'
        )
        with urllib.request.urlopen(s3_req, timeout=120) as s3_resp:
            if s3_resp.status not in (200, 204):
                raise RuntimeError(f"S3 响应异常状态: {s3_resp.status}")

        print(f"{Colors.GREEN}✔ S3 直传成功完成!{Colors.ENDC}")
    except Exception as e:
        print(f"{Colors.FAIL}S3 上传失败: {e}{Colors.ENDC}")
        return

    # 步骤 3：通知 Suno 保存确认
    print(f"{Colors.BLUE}[3/3] 正在向 Suno 确认上传并入库...{Colors.ENDC}")
    try:
        final_payload = {
            "clip_id": clip_id,
            "title": title,
            "tags": args.tags or "",
            "prompt": args.prompt or "",
            "instrumental": args.instrumental
        }
        try:
            final_res = call_suno_api(f'/api/uploads/audio/{clip_id}/complete/', 'POST', final_payload)
        except Exception:
            final_res = call_suno_api('/api/c/clips/upload/complete/', 'POST', final_payload)

        print(f"\n{Colors.GREEN}{Colors.BOLD}🎉 上传成功!{Colors.ENDC}")
        print(f"作品 Clip ID: {clip_id}")
        print(f"可在 Suno 官网查看并管理该音频作品。\n")
    except Exception as e:
        print(f"{Colors.WARNING}⚠ S3 已上传，但入库通知失败 ({e})，请在 Suno 官网确认。{Colors.ENDC}\n")

def main():
    parser = argparse.ArgumentParser(description="Suno Console Bridge CLI 工具")
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    # status 命令
    subparsers.add_parser("status", help="检查本地 Suno 凭据有效状态")

    # upload 命令
    upload_parser = subparsers.add_parser("upload", help="直接在终端上传音频到 Suno")
    upload_parser.add_argument("file", help="音频文件路径 (MP3/WAV/FLAC/M4A/OGG)")
    upload_parser.add_argument("--title", help="歌曲标题 (默认使用文件名)")
    upload_parser.add_argument("--tags", help="音乐风格/标签 (如 pop, rock)")
    upload_parser.add_argument("--prompt", help="歌词或 Prompt 描述")
    upload_parser.add_argument("--instrumental", action="store_true", help="是否为纯音乐")

    args = parser.parse_args()
    if args.command == "status":
        cmd_status(args)
    elif args.command == "upload":
        cmd_upload(args)
    else:
        parser.print_help()

if __name__ == '__main__':
    main()
