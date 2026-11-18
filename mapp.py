# Static server for the Hoa Lo HTML booth, local restart, and incoming payments.
# Tuned for an Intel NUC (8GB RAM, 10th-gen i5, 256GB disk): one bad request
# must not kill the process, and heavy files are cached so the disk is not re-read.
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime
import hashlib
import base64
import re
import json
import math
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
NO_STORE_EXT = (".html", ".js", ".css", ".json")
# Proxy same-origin -> configptb (tranh CORS / firewall Chrome kiosk).
CONFIGPTB_GET = ("/api/sync", "/api/sync/file")
CONFIGPTB_POST = ("/api/heartbeat", "/api/commands/ack")
MAX_PROXY_BODY = 2 * 1024 * 1024
MAX_PROXY_FILE = 20 * 1024 * 1024


def booth_data_dir():
    """Chi dung data trong web\ (khong D:\\PTBConfig / khong thu muc cha)."""
    local = os.path.join(ROOT, "data")
    try:
        os.makedirs(local, exist_ok=True)
        return local
    except Exception:
        return ROOT


DATA_DIR = booth_data_dir()
PAY_FILE = os.path.join(DATA_DIR, "hoalo-payments.json")
PAY_LOCK = threading.Lock()
MAX_PAYMENT_IDS = 2000
# Một lần cộng tiền (tờ hoặc gói máy đọc gửi lên). Chặn số rác làm phình quỹ.
MAX_BILL_VND = 10000000
# Web booth chỉ lắng nghe loopback — không mở LAN/WAN.
BIND_HOST = "127.0.0.1"
DEVICES_FILE = os.path.join(DATA_DIR, "devices.json")
CLOUD_CACHE_DIR = os.path.join(DATA_DIR, "cloud-cache")
CLOUD_CACHE_LOCK = threading.Lock()
CLOUD_CONFIG_FILE = os.path.join(DATA_DIR, "cloud-config.json")
CLOUD_CONFIG_LOCK = threading.Lock()
# Cau hinh booth can giu sau khi cache khung (offline dung lai duoc).
ESSENTIAL_CONFIG_KEYS = (
    "takePhotoPrice",
    "printPrice",
    "onlinePhotoPrice",
    "webPrintPrice",
    "webSendPrintPrice",
    "printMin",
    "printMax",
    "paymentTimeoutSeconds",
    "previewReplaceTimeoutSeconds",
    "captureTimeoutSeconds",
    "layoutTimeoutSeconds",
    "maxTimeWait",
    "cameraNameKeyword",
    "cameraExcludeKeyword",
    "cameraCaptureWidth",
    "cameraCaptureHeight",
    "cameraIndex",
    "cameraProfile",
    "urlBase",
    "hideWebPrintQr",
    "deviceID",
    "deviceId",
    "printPaperSize",
)
# Chỉ ghi job vào cho-cdn. PtbHtmlPrint.exe upload CDN (Wasabi+CMS) + stamp QR rồi chuyển sang in.
STAGING_DIR = os.path.join(ROOT, "public", "cho-cdn")
PRINT_DIR = os.path.join(ROOT, "public", "in")
PRINTING_DIR = os.path.join(ROOT, "public", "dang-in")
PRINTED_DIR = os.path.join(ROOT, "public", "da-in")
PRINT_LOCK = threading.Lock()
MAX_PRINT_JOBS = 40
MAX_PRINT_BODY = 128 * 1024 * 1024
COMPOSE_PHOTO_DIR = os.path.join(ROOT, "public", "anh-le-2")
MAX_CAPTURE_BODY = 256 * 1024 * 1024
# Video quá trình chụp đã ghép vào lỗ khung. Giữ ít file để khỏi đầy ổ NUC.
VIDEO_DIR = os.path.join(ROOT, "public", "videos")
VIDEO_LOCK = threading.Lock()
MAX_VIDEO_BODY = 96 * 1024 * 1024
MAX_VIDEO_FILES = 30


def load_booth_cfg():
    try:
        with open(os.path.join(ROOT, "config.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def pick_essential_config(src):
    src = src if isinstance(src, dict) else {}
    out = {}
    for key in ESSENTIAL_CONFIG_KEYS:
        if key in src and src[key] is not None:
            out[key] = src[key]
    if "deviceId" not in out and out.get("deviceID"):
        out["deviceId"] = out["deviceID"]
    return out


def load_cloud_config_cache():
    try:
        with open(CLOUD_CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_cloud_config_cache(config):
    essential = pick_essential_config(config)
    if not essential:
        return False, "empty"
    payload = {
        "ok": True,
        "savedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "config": essential,
    }
    with CLOUD_CONFIG_LOCK:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            tmp = CLOUD_CONFIG_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            os.replace(tmp, CLOUD_CONFIG_FILE)
            return True, ""
        except Exception as e:
            return False, str(e) or "save-fail"


def configptb_upstreams():
    """Uu tien cloudConfigUrl, roi local :18191 (agent cu). Thu lan luot den khi ok."""
    out = []
    cfg = load_booth_cfg()
    url = str(cfg.get("cloudConfigUrl") or "").strip().rstrip("/")
    if url:
        out.append(url)
    local = "http://127.0.0.1:18191"
    if local not in out:
        out.append(local)
    return out


def sanitize_cloud_rel(rel):
    rel = str(rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/"):
        return ""
    if not rel.lower().startswith(("templates/", "tmp2/", "qrcode/")):
        return ""
    return rel


def guess_ctype(path):
    lower = path.lower()
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        return "image/jpeg"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".json"):
        return "application/json"
    return "application/octet-stream"


def ensure_cloud_cached(rel):
    """
    Tai file tu configptb bang Python (on dinh), cache vao web\\data\\cloud-cache.
    Tra path local hoac None.
    """
    rel = sanitize_cloud_rel(rel)
    if not rel:
        return None, "rel-invalid"
    dest = os.path.join(CLOUD_CACHE_DIR, *rel.split("/"))
    with CLOUD_CACHE_LOCK:
        try:
            if os.path.isfile(dest) and os.path.getsize(dest) >= 32:
                return dest, ""
        except Exception:
            pass
        cfg = load_booth_cfg()
        device_id = str(cfg.get("deviceId") or "").strip()
        token = str(cfg.get("cloudConfigToken") or "").strip()
        if not device_id or not token:
            return None, "missing-device-token"
        last_err = "upstream"
        # configptb doi rel=Templates%2Fframe_1-thumb.png
        query = "/api/sync/file?rel=" + urllib.parse.quote(rel, safe="")
        for base in configptb_upstreams():
            url = base.rstrip("/") + query
            try:
                req = urllib.request.Request(url, method="GET")
                req.add_header("X-Device-Id", device_id)
                req.add_header("X-Device-Token", token)
                req.add_header("User-Agent", "HoaLoBooth-mapp/1.0")
                req.add_header("Accept", "*/*")
                with urllib.request.urlopen(req, timeout=90) as resp:
                    data = resp.read(MAX_PROXY_FILE + 1)
                if len(data) > MAX_PROXY_FILE:
                    last_err = "too-large"
                    continue
                if len(data) < 32:
                    last_err = "empty"
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                tmp = dest + ".tmp"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, dest)
                return dest, ""
            except Exception as e:
                last_err = str(e) or "upstream"
                continue
        return None, last_err


def prune_frame_cache(files):
    """Xoa khung local khong con tren configptb, hoac file lech sha1."""
    wanted = {}
    if isinstance(files, list):
        for item in files:
            if not isinstance(item, dict):
                continue
            rel = sanitize_cloud_rel(item.get("rel"))
            if not rel or not rel.lower().startswith(("templates/", "tmp2/")):
                continue
            wanted[rel] = str(item.get("sha1") or "").strip().lower()
    roots = (
        CLOUD_CACHE_DIR,
        os.path.join(ROOT, "public", "cloud-cache"),
    )
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _, names in os.walk(root):
            for name in names:
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, root).replace("\\", "/")
                if not rel.lower().startswith(("templates/", "tmp2/")):
                    continue
                sha = wanted.get(rel)
                if sha is None:
                    try:
                        os.remove(path)
                    except Exception:
                        pass
                    continue
                if not sha:
                    continue
                try:
                    digest = hashlib.sha1()
                    with open(path, "rb") as f:
                        while True:
                            chunk = f.read(1024 * 1024)
                            if not chunk:
                                break
                            digest.update(chunk)
                    if digest.hexdigest() != sha:
                        os.remove(path)
                except Exception:
                    pass


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _read_job_json(folder):
    try:
        with open(os.path.join(folder, "job.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def find_print_job_dir(job_id):
    job_id = str(job_id or "").strip()
    if not job_id or ".." in job_id or "/" in job_id or "\\" in job_id:
        return None, ""
    roots = (
        (PRINTED_DIR, "done"),
        (PRINTING_DIR, "printing"),
        (PRINT_DIR, "queued"),
        (STAGING_DIR, "uploading"),
    )
    # The worker moves jobs forward while this lookup scans in reverse.
    # Scan again before reporting missing if a move crossed the first scan.
    for _ in range(2):
        for root, stage in roots:
            if not os.path.isdir(root):
                continue
            exact = os.path.join(root, job_id)
            if os.path.isdir(exact):
                return exact, stage
            try:
                for name in os.listdir(root):
                    if name == job_id or name.startswith(job_id + "-"):
                        path = os.path.join(root, name)
                        if os.path.isdir(path):
                            return path, stage
            except OSError:
                pass
    return None, ""


def mark_order_printed(order_id):
    folder = photo_order_folder(order_id, COMPOSE_PHOTO_DIR)
    path = os.path.join(folder, "done.txt")
    with PRINT_LOCK:
        if _read_text(path) == "done":
            return
        os.makedirs(folder, exist_ok=True)
        temp = path + ".tmp"
        with open(temp, "w", encoding="utf-8") as f:
            f.write("done")
        os.replace(temp, path)


def print_job_status(job_id):
    folder, stage = find_print_job_dir(job_id)
    if not folder:
        return {"ok": False, "id": job_id, "status": "missing", "cdnLink": "", "error": "not_found"}
    job = _read_job_json(folder)
    cdn = str(job.get("cdnLink") or job.get("qrUrl") or "").strip()
    if not cdn:
        cdn = _read_text(os.path.join(folder, "upload.done"))
    err = _read_text(os.path.join(folder, "print.failed")) or _read_text(os.path.join(folder, "error.txt"))
    skipped = os.path.isfile(os.path.join(folder, "skip.txt"))
    try:
        qty = int(job.get("qty") or 1)
    except Exception:
        qty = 1
    if qty < 1:
        qty = 1
    try:
        printed = int(_read_text(os.path.join(folder, "printed.txt")) or "0")
    except Exception:
        printed = 0
    status = stage
    if skipped:
        status = "failed"
        if not err:
            err = _read_text(os.path.join(folder, "skip.txt")) or "skip"
    elif stage == "done" or printed >= qty:
        status = "done"
    elif os.path.isfile(os.path.join(folder, "print.failed")):
        status = "failed"
    elif stage == "uploading" and cdn:
        status = "uploading"
    elif cdn and err and stage in ("printing", "queued", "uploading"):
        # Đã upload CDN nhưng stamp/in lỗi / hết giấy / không thấy máy in
        status = "failed"
    if status == "done":
        try:
            mark_order_printed(str(job.get("orderId") or "").strip())
        except (ValueError, OSError):
            # A later status check / background scan retries failed writes.
            pass
    return {
        "ok": True,
        "id": job_id,
        "status": status,
        "cdnLink": cdn,
        "error": err,
        "orderId": str(job.get("orderId") or "").strip(),
        "qty": qty,
        "printed": printed,
        "uploaded": bool(cdn) or os.path.isfile(os.path.join(folder, "upload.done")),
    }


def sync_print_completions():
    for root in (PRINTED_DIR, PRINTING_DIR, PRINT_DIR, STAGING_DIR):
        try:
            names = os.listdir(root)
        except OSError:
            continue
        for name in names:
            if os.path.isdir(os.path.join(root, name)):
                print_job_status(name)


def watch_print_completions():
    # Independent of the browser, including after the customer leaves the page.
    while True:
        try:
            sync_print_completions()
        except Exception as ex:
            print("print completion scan failed: %s" % ex, flush=True)
        time.sleep(5)


def load_payments():
    data = {"ids": [], "tientichluy": 0}
    try:
        with open(PAY_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            ids = raw.get("ids") or []
            if isinstance(ids, list):
                data["ids"] = [str(x) for x in ids if str(x).strip()][-MAX_PAYMENT_IDS:]
            total = int(raw.get("tientichluy") or 0)
            data["tientichluy"] = total if total > 0 else 0
    except Exception:
        pass
    return data


def save_payments(data):
    folder = os.path.dirname(PAY_FILE)
    if folder and not os.path.isdir(folder):
        os.makedirs(folder)
    tmp = PAY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"ids": data["ids"][-MAX_PAYMENT_IDS:], "tientichluy": int(data["tientichluy"])}, f, ensure_ascii=False)
    os.replace(tmp, PAY_FILE)


def parse_amount(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        if value != value or value <= 0:
            return None
        n = int(value)
        if abs(value - n) > 0.001:
            return None
        return n if n > 0 else None
    text = str(value).strip().replace(",", "")
    if text.isdigit():
        n = int(text)
        return n if n > 0 else None
    return None


def record_payment(pay_id, amount):
    with PAY_LOCK:
        data = load_payments()
        if pay_id in data["ids"]:
            return 2, data["tientichluy"]
        data["ids"].append(pay_id)
        data["tientichluy"] = int(data["tientichluy"]) + int(amount)
        save_payments(data)
        return 1, data["tientichluy"]


def payment_total():
    with PAY_LOCK:
        return load_payments()["tientichluy"]


def is_loopback(host):
    host = str(host or "").split("%", 1)[0].strip().lower()
    if host.startswith("::ffff:"):
        host = host[7:]
    return host in ("127.0.0.1", "::1")


def booth_device_id():
    try:
        with open(os.path.join(ROOT, "config.json"), "r", encoding="utf-8") as f:
            return str(json.load(f).get("deviceId") or "").strip()
    except Exception:
        return ""


def paper_status():
    device_id = booth_device_id()
    remaining = None
    printer_out = False
    try:
        with open(DEVICES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        devices = data.get("devices") if isinstance(data, dict) else None
        if isinstance(devices, list):
            for item in devices:
                if not isinstance(item, dict):
                    continue
                if str(item.get("id") or "").strip().lower() != device_id.lower():
                    continue
                if item.get("paperRemaining") is not None:
                    remaining = int(item.get("paperRemaining"))
                printer_out = bool(item.get("printerPaperOut"))
                break
    except Exception:
        pass
    return {
        "deviceId": device_id,
        "paperRemaining": remaining if isinstance(remaining, int) else -1,
        "paperOut": printer_out or remaining == 0,
    }


def booth_url_base():
    try:
        with open(os.path.join(ROOT, "config.json"), "r", encoding="utf-8") as f:
            cfg = json.load(f)
        base = str(cfg.get("urlBase") or "").strip().rstrip("/")
        if base:
            return base
    except Exception:
        pass
    return "https://moments-memories.lumina-x.info"


def machine_cms_base(device_id=None):
    # Chi doc web\config.json (khong D:\PTBConfig\devices\...).
    return booth_url_base()


def make_order_id(device_id=None):
    """Cùng công thức PTB.exe: deviceId + md5(deviceId+truong+plain)[:14] + HHmmssddMMyyyy."""
    device_id = (device_id or booth_device_id() or "DEVICE").strip() or "DEVICE"
    plain = datetime.now().strftime("%H%M%S%d%m%Y")
    digest = hashlib.md5((device_id + "truong" + plain).encode("utf-8")).hexdigest()[:14]
    return device_id + digest + plain


def _prune_jobs(root):
    if not os.path.isdir(root):
        return
    names = [n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))]
    names.sort()
    while len(names) > MAX_PRINT_JOBS:
        old = names.pop(0)
        target = os.path.join(root, old)
        for name in os.listdir(target):
            try:
                os.remove(os.path.join(target, name))
            except Exception:
                pass
        try:
            os.rmdir(target)
        except Exception:
            pass


def photo_order_folder(order_id, root):
    # The order ID is a directory name, so reject separators and traversal.
    if not isinstance(order_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", order_id):
        raise ValueError("invalid orderId")
    return os.path.join(root, order_id)


def write_photo_manifest(folder, manifest):
    temp = os.path.join(folder, "job.json.tmp")
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    os.replace(temp, os.path.join(folder, "job.json"))


def decode_png_data_url(photo):
    if not isinstance(photo, str) or not photo.startswith("data:image/png;base64,"):
        raise ValueError("expected PNG image")
    try:
        png = base64.b64decode(photo.split(",", 1)[1], validate=True)
    except Exception:
        raise ValueError("invalid PNG encoding")
    if (len(png) < 45 or not png.startswith(b"\x89PNG\r\n\x1a\n")
            or not png.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82")):
        raise ValueError("invalid PNG image")
    return png


def save_capture_photos(order_id, photos):
    compose_folder = photo_order_folder(order_id, COMPOSE_PHOTO_DIR)
    if not isinstance(photos, list) or not 1 <= len(photos) <= 32:
        raise ValueError("invalid photos")
    decoded = []
    for photo in photos:
        decoded.append(decode_png_data_url(photo))
    names = [str(i + 1) + ".png" for i in range(len(decoded))]
    with PRINT_LOCK:
        os.makedirs(compose_folder, exist_ok=True)
        for name, png in zip(names, decoded):
            temp = os.path.join(compose_folder, name + ".tmp")
            with open(temp, "wb") as f:
                f.write(png)
            os.replace(temp, os.path.join(compose_folder, name))
        write_photo_manifest(compose_folder, {
            "deviceId": booth_device_id(),
            "orderId": order_id, "status": "captured", "photoCount": len(names),
            "photos": names, "createdAt": datetime.utcnow().isoformat() + "Z",
        })
    # Changed content must have a new URL, including for retries on an old order.
    return ["/public/anh-le-2/" + order_id + "/" + name + "?v=" + hashlib.sha256(png).hexdigest()[:16]
            for name, png in zip(names, decoded)]


def save_print_job(meta, png):
    """
    Chỉ ghi vào cho-cdn và trả ngay (không treo HTML / không upload Python).
    PtbHtmlPrint.exe sẽ upload CDN + stamp QR rồi chuyển sang thư mục in.
    Trả (job_id, order_id, "", "").
    """
    stamp = time.strftime("%Y%m%d-%H%M%S") + "-%03d" % (int(time.time() * 1000) % 1000)
    device_id = booth_device_id()
    order_id = str(meta.get("orderId") or "").strip() or make_order_id(device_id)
    photo_folder = photo_order_folder(order_id, COMPOSE_PHOTO_DIR)
    job = {
        "image": "print.png",
        "deviceId": device_id,
        "orderId": order_id,
        "pageW": int(meta["pageW"]),
        "pageH": int(meta["pageH"]),
        "paperSize": meta["paperSize"],
        "paperWidthInch": meta["paperWidthInch"],
        "paperHeightInch": meta["paperHeightInch"],
        "dpi": meta["dpi"],
        "qty": int(meta["qty"]),
        "status": "uploading",
    }
    # The input PNG has no QR. The CDN worker reads these output-pixel
    # coordinates from qr-place.json before stamping and queuing the print.
    marks = {"frameRel": str(meta.get("frameRel") or "")[:256]}
    for key, source in (("qr", "qrRect"), ("date", "dateRect")):
        rect = meta.get(source)
        if not isinstance(rect, dict):
            continue
        try:
            rect = {axis: float(rect[axis]) for axis in ("x", "y", "w", "h")}
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if (all(math.isfinite(value) for value in rect.values())
                and rect["x"] >= 0 and rect["y"] >= 0
                and rect["w"] > 0 and rect["h"] > 0
                and rect["x"] + rect["w"] <= job["pageW"]
                and rect["y"] + rect["h"] <= job["pageH"]):
            marks[key] = {axis: int(value + 0.5) for axis, value in rect.items()}
    marks["dateText"] = str(meta.get("dateText") or datetime.now().strftime("%H:%M %d/%m/%Y"))[:64]
    with PRINT_LOCK:
        manifest_path = os.path.join(photo_folder, "job.json")
        if os.path.isfile(manifest_path):
            try:
                with open(manifest_path, "r", encoding="utf-8") as f:
                    manifest = json.load(f)
                if not isinstance(manifest, dict):
                    raise ValueError("invalid composition manifest")
                manifest.update({"deviceId": device_id,
                                 "printJobId": stamp, "status": "composed", "print": job,
                                 "layout": meta.get("layout") or []})
                write_photo_manifest(photo_folder, manifest)
            except (OSError, ValueError):
                # A damaged composition manifest must not prevent publishing the print job.
                print("could not update composition manifest for order %s" % order_id, flush=True)
        os.makedirs(STAGING_DIR, exist_ok=True)
        os.makedirs(PRINT_DIR, exist_ok=True)
        folder = os.path.join(STAGING_DIR, stamp)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "print.png"), "wb") as f:
            f.write(png)
        if "qr" in marks:
            with open(os.path.join(folder, "qr-place.json"), "w", encoding="utf-8") as f:
                json.dump(marks, f, ensure_ascii=False)
        # Publish the job last, after both the image and QR placement are ready.
        with open(os.path.join(folder, "job.json"), "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False)
        _prune_jobs(STAGING_DIR)
    return stamp, order_id, "", ""


def video_filename(order_id):
    """Cùng tên ảnh in trên CDN ({orderId}.jpg) nhưng đuôi .webm."""
    name = str(order_id or "").strip()
    if not name or len(name) > 96:
        return ""
    for ch in name:
        if not (ch.isalnum() or ch in "-_"):
            return ""
    return name + ".webm"


def _prune_videos():
    if not os.path.isdir(VIDEO_DIR):
        return
    paths = []
    for n in os.listdir(VIDEO_DIR):
        if not n.lower().endswith(".webm"):
            continue
        path = os.path.join(VIDEO_DIR, n)
        try:
            paths.append((os.path.getmtime(path), path))
        except Exception:
            pass
    paths.sort()
    while len(paths) > MAX_VIDEO_FILES:
        _, old = paths.pop(0)
        try:
            os.remove(old)
        except Exception:
            pass


def save_capture_video(blob, order_id=""):
    """Ghi webm đã ghép, tên trùng ảnh in. Trả tên file hoặc chuỗi rỗng."""
    if not blob or len(blob) < 256 or blob[:4] != b"\x1a\x45\xdf\xa3":
        return ""
    name = video_filename(order_id)
    if not name:
        return ""
    with VIDEO_LOCK:
        os.makedirs(VIDEO_DIR, exist_ok=True)
        path = os.path.join(VIDEO_DIR, name)
        with open(path, "wb") as f:
            f.write(blob)
        _prune_videos()
    return name


def phone_frame_ok(frame):
    frame = str(frame or "").replace("\\", "/").strip()
    parts = frame.split("/")
    if len(parts) != 2 or parts[0] not in ("Templates", "tmp2"):
        return ""
    name = parts[1]
    if not name.startswith("frame_") or not name.endswith(".png"):
        return ""
    mid = name[len("frame_"):-len(".png")]
    if not mid.isdigit():
        return ""
    return parts[0] + "/frame_" + str(int(mid)) + ".png"


def phone_kiosk_key():
    path = os.path.join(ROOT, "phoneweb", "data", "secret.key")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def phone_web_settings():
    """Web điện thoại public (phoneWebUrl). Key lấy từ config, không có thì file local."""
    url = "https://hoalo.gamegiaoduc.co"
    key = ""
    try:
        with open(os.path.join(ROOT, "config.json"), "r", encoding="utf-8") as f:
            cfg = json.load(f)
        cfg_url = str(cfg.get("phoneWebUrl") or "").strip().rstrip("/")
        cfg_key = str(cfg.get("phoneKioskKey") or "").strip()
        if cfg_url.startswith(("http://", "https://")):
            url = cfg_url
        if cfg_key:
            key = cfg_key
    except Exception:
        pass
    if not key:
        key = phone_kiosk_key()
    return url, key


def request_phone_token(device_id, frame, qty):
    """Máy kiosk đã thu tiền thì mới xin token. Khách internet không gọi được route này."""
    base, key = phone_web_settings()
    if not key:
        return 503, {"ok": False, "message": "phone-web-off"}
    frame = phone_frame_ok(frame)
    try:
        qty = int(qty)
    except Exception:
        qty = 0
    if not frame or qty < 1 or qty > 10:
        return 400, {"ok": False, "message": "frame-or-qty"}
    payload = json.dumps({
        "deviceId": device_id,
        "frame": frame,
        "qty": qty,
        "amount": 50000 + (qty - 1) * 20000,
    }).encode("utf-8")
    endpoints = [base + "/api/tokens"]
    local = "http://127.0.0.1:18220/api/tokens"
    if local != endpoints[0]:
        endpoints.append(local)
    last = (503, {"ok": False, "message": "phone-web-off"})
    for endpoint in endpoints:
        req = urllib.request.Request(
            endpoint,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Kiosk-Key": key,
                "User-Agent": "hoalo-booth/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                raw = resp.read(65536)
                code = getattr(resp, "status", 200) or 200
        except Exception as e:
            read = getattr(e, "read", None)
            code = getattr(e, "code", 0) or 0
            if not read or not code:
                continue
            try:
                raw = read(65536)
            except Exception:
                continue
        try:
            out = json.loads(raw.decode("utf-8"))
        except Exception:
            last = (502, {"ok": False, "message": "phone-web-bad"})
            continue
        if not isinstance(out, dict):
            last = (502, {"ok": False, "message": "phone-web-bad"})
            continue
        if out.get("url"):
            return code, out
        last = (code or 502, out)
        if code and code != 503:
            return last
    return last


def settle_payments():
    with PAY_LOCK:
        data = load_payments()
        paid = int(data["tientichluy"])
        data["tientichluy"] = 0
        save_payments(data)
        return paid


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def handle(self):
        try:
            # Proxy khung/QR co the >4MB.
            self.connection.settimeout(300)
        except Exception:
            pass
        try:
            super().handle()
        except Exception:
            pass

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        path = self.path.split("?", 1)[0].lower()
        if (path.endswith("/") or path.startswith("/api/") or path.endswith(NO_STORE_EXT)
                or path.startswith(("/public/anh-le/", "/public/anh-le-2/", "/public/cho-cdn/"))):
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "public, max-age=86400")
        super().end_headers()

    def client_host(self):
        return self.client_address[0] if self.client_address else ""

    def ensure_loopback(self):
        if is_loopback(self.client_host()):
            return True
        self.close_connection = True
        try:
            self.send_error(403)
        except Exception:
            pass
        return False

    def write_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self, limit=65536):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except Exception:
            length = 0
        if length < 0 or length > limit:
            self.close_connection = True
            return None
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            return None
        return data if isinstance(data, dict) else None

    def do_OPTIONS(self):
        if not self.ensure_loopback():
            return
        try:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type, X-Device-Id, X-Device-Token, X-Admin-Token",
            )
            self.end_headers()
        except Exception:
            pass

    def proxy_configptb(self, method, body=None):
        """Chuyen /api/sync|/api/sync/file|/api/heartbeat|/api/commands/ack toi configptb."""
        path_only = self.path.split("?", 1)[0]
        allowed = CONFIGPTB_GET if method == "GET" else CONFIGPTB_POST
        if path_only not in allowed:
            return False

        cfg = load_booth_cfg()
        device_id = (self.headers.get("X-Device-Id") or cfg.get("deviceId") or "").strip()
        token = (self.headers.get("X-Device-Token") or cfg.get("cloudConfigToken") or "").strip()
        if not device_id or not token:
            self.write_json(500, {"ok": False, "message": "missing deviceId/token in web/config.json"})
            return True

        path_q = self.path if self.path.startswith("/") else "/" + self.path
        last_err = "upstream"
        for base in configptb_upstreams():
            url = base.rstrip("/") + path_q
            try:
                req = urllib.request.Request(url, data=body, method=method)
                req.add_header("X-Device-Id", device_id)
                req.add_header("X-Device-Token", token)
                req.add_header("User-Agent", "HoaLoBooth-mapp/1.0")
                req.add_header("Accept", "application/json, */*")
                if body is not None:
                    req.add_header(
                        "Content-Type",
                        self.headers.get("Content-Type") or "application/json; charset=utf-8",
                    )
                with urllib.request.urlopen(req, timeout=45) as resp:
                    data = resp.read(MAX_PROXY_FILE + 1)
                    if len(data) > MAX_PROXY_FILE:
                        self.send_error(502, "upstream too large")
                        return True
                    ctype = resp.headers.get("Content-Type") or "application/octet-stream"
                    code = getattr(resp, "status", None) or resp.getcode() or 200
                    if method == "GET" and path_only == "/api/sync" and int(code) == 200:
                        try:
                            payload = json.loads(data.decode("utf-8"))
                            manifest = payload.get("files") if isinstance(payload, dict) else None
                            if isinstance(manifest, list):
                                prune_frame_cache(manifest)
                        except Exception:
                            pass
                    self.send_response(int(code))
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return True
            except urllib.error.HTTPError as e:
                try:
                    err_body = e.read()
                except Exception:
                    err_body = b""
                # Thu upstream tiep (cloud vs 18191); chi tra loi khi het danh sach.
                last_err = "http %s" % e.code
                continue
            except Exception as e:
                last_err = str(e) or "upstream"
                continue
        try:
            self.send_error(502, "configptb proxy failed: " + str(last_err)[:120])
        except Exception:
            pass
        return True

    def do_GET(self):
        if not self.ensure_loopback():
            return
        path = self.path.split("?", 1)[0]
        # Vào màn hiệu ứng in: quỹ tiền lũy kế về 0 trước khi trả trang.
        if path.lower() in ("/hoan-thanh.html", "/hoan-thanh"):
            try:
                settle_payments()
            except Exception:
                pass
        # Chrome kiosk hay "Failed to fetch" cross-origin: tai file bang Python roi tra local.
        if path == "/local/cloud-file":
            try:
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query or "")
                rel = (qs.get("rel") or [""])[0].strip()
                dest, err = ensure_cloud_cached(rel)
                if not dest:
                    self.write_json(502, {"ok": False, "message": "cloud-file-fail", "rel": rel, "error": err})
                    return
                with open(dest, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", guess_ctype(dest))
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                try:
                    self.write_json(500, {"ok": False, "message": str(e)[:200]})
                except Exception:
                    pass
            return
        if path == "/local/cloud-config":
            try:
                cached = load_cloud_config_cache()
                if not cached:
                    self.write_json(404, {"ok": False, "message": "no-cloud-config-cache"})
                    return
                self.write_json(200, cached)
            except Exception as e:
                try:
                    self.write_json(500, {"ok": False, "message": str(e)[:200]})
                except Exception:
                    pass
            return
        if path in CONFIGPTB_GET:
            try:
                self.proxy_configptb("GET")
            except Exception:
                try:
                    self.send_error(500)
                except Exception:
                    pass
            return
        if path == "/api/v1/paper":
            try:
                self.write_json(200, paper_status())
            except Exception:
                try:
                    self.send_error(500)
                except Exception:
                    pass
            return
        if path == "/api/v1/payments":
            try:
                if self.client_host() not in ("127.0.0.1", "::1"):
                    self.send_error(403)
                    return
                self.write_json(200, {"tientichluy": payment_total()})
            except Exception:
                try:
                    self.send_error(500)
                except Exception:
                    pass
            return
        if path == "/api/v1/prints":
            try:
                from urllib.parse import parse_qs, urlparse
                qs = parse_qs(urlparse(self.path).query or "")
                job_id = (qs.get("id") or [""])[0].strip()
                if not job_id:
                    self.write_json(400, {"ok": False, "message": "missing id"})
                    return
                self.write_json(200, print_job_status(job_id))
            except Exception:
                try:
                    self.send_error(500)
                except Exception:
                    pass
            return
        try:
            super().do_GET()
        except Exception:
            pass

    def discard_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except Exception:
            length = 0
        if 0 < length <= 65536:
            self.rfile.read(length)

    def do_POST(self):
        try:
            if not self.ensure_loopback():
                return
            path = self.path.split("?", 1)[0]
            host = self.client_host()
            if path in CONFIGPTB_POST:
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                except Exception:
                    length = 0
                if length < 0 or length > MAX_PROXY_BODY:
                    self.send_error(400)
                    return
                body = self.rfile.read(length) if length else b"{}"
                self.proxy_configptb("POST", body)
                return
            if path == "/api/v1/payments":
                self.handle_payment()
                return
            if path == "/api/v1/prints":
                self.handle_print()
                return
            if path == "/api/v1/capture-photos":
                self.handle_capture_photos()
                return
            if path == "/api/v1/order":
                self.discard_body()
                self.handle_order()
                return
            if path == "/api/v1/phone-token":
                self.handle_phone_token()
                return
            if path == "/api/v1/capture-video":
                self.handle_capture_video()
                return
            if path == "/local/cloud-config":
                if host not in ("127.0.0.1", "::1"):
                    self.send_error(403)
                    return
                body = self.read_json_body()
                if not body:
                    self.write_json(400, {"ok": False, "message": "invalid_json"})
                    return
                cfg = body.get("config") if isinstance(body.get("config"), dict) else body
                ok, err = save_cloud_config_cache(cfg)
                if not ok:
                    self.write_json(400, {"ok": False, "message": err or "save-fail"})
                    return
                saved = load_cloud_config_cache()
                self.write_json(200, {"ok": True, "savedAt": saved.get("savedAt"), "config": saved.get("config") or {}})
                return
            self.discard_body()
            if path == "/api/v1/payments/settle":
                if host not in ("127.0.0.1", "::1"):
                    self.send_error(403)
                    return
                paid = settle_payments()
                self.write_json(200, {"result": 1, "tientichluy": 0, "settled": paid})
                return
            if path != "/local/restart":
                self.send_error(404)
                return
            if host not in ("127.0.0.1", "::1"):
                self.send_error(403)
                return
            subprocess.Popen(
                ["shutdown", "/r", "/t", "5", "/f", "/c", "Hoa Lo remote restart"],
                close_fds=False,
            )
            self.write_json(200, {"ok": True})
        except Exception:
            try:
                self.send_error(500)
            except Exception:
                pass

    def handle_payment(self):
        body = self.read_json_body()
        if not body:
            self.write_json(400, {"result": 0, "message": "invalid_json"})
            return
        pay_id = str(body.get("id") if body.get("id") is not None else "").strip()
        timestamp = body.get("timestamp")
        timestamp_text = str(timestamp).strip() if timestamp is not None else ""
        amount = parse_amount(body.get("amount"))
        if (
            not pay_id
            or len(pay_id) > 128
            or any(ch in pay_id for ch in ("\r", "\n", "\x00"))
            or not timestamp_text
            or len(timestamp_text) > 64
            or amount is None
            or amount > MAX_BILL_VND
        ):
            self.write_json(400, {"result": 0, "message": "missing id, timestamp or amount"})
            return
        result, total = record_payment(pay_id, amount)
        self.write_json(200, {"result": result, "tientichluy": total})

    def handle_capture_photos(self):
        body = self.read_json_body(MAX_CAPTURE_BODY)
        if not isinstance(body, dict):
            self.write_json(400, {"ok": False, "message": "invalid_json"})
            return
        try:
            photos = save_capture_photos(body.get("orderId"), body.get("photos"))
        except ValueError as e:
            self.write_json(400, {"ok": False, "message": str(e)})
            return
        self.write_json(200, {"ok": True, "orderId": body["orderId"],
                              "photos": photos, "composePhotos": photos})

    def handle_print(self):
        body = self.read_json_body(MAX_PRINT_BODY)
        if not body:
            self.write_json(400, {"ok": False, "message": "invalid_json"})
            return
        try:
            page_w = int(body.get("pageW"))
            page_h = int(body.get("pageH"))
            qty = int(body.get("qty"))
        except Exception:
            self.write_json(400, {"ok": False, "message": "missing print size or qty"})
            return
        if page_w < 100 or page_h < 100 or page_w > 8000 or page_h > 8000 or qty < 1 or qty > 20:
            self.write_json(400, {"ok": False, "message": "invalid print size or qty"})
            return
        try:
            png = decode_png_data_url(body.get("image"))
        except ValueError as e:
            self.write_json(400, {"ok": False, "message": str(e)})
            return
        paper = str(body.get("paperSize") or "6x8").strip()[:32]
        order_id = str(body.get("orderId") or "").strip()
        try:
            photo_order_folder(order_id or "generated", COMPOSE_PHOTO_DIR)
        except ValueError:
            self.write_json(400, {"ok": False, "message": "invalid orderId"})
            return
        job_id, order_id, cdn_link, err = save_print_job({
            "pageW": page_w,
            "pageH": page_h,
            "paperSize": paper,
            "paperWidthInch": body.get("paperWidthInch"),
            "paperHeightInch": body.get("paperHeightInch"),
            "dpi": body.get("dpi"),
            "qty": qty,
            "orderId": order_id,
            "layout": body.get("layout"),
            "frameRel": body.get("frameRel"),
            "qrRect": body.get("qrRect"),
            "dateRect": body.get("dateRect"),
            "dateText": body.get("dateText"),
        }, png)
        # Trả ngay — upload CDN chạy nền trong lúc HTML diễn hiệu ứng in.
        self.write_json(200, {
            "ok": True,
            "id": job_id,
            "orderId": order_id or None,
            "cdnLink": cdn_link or None,
            "status": "uploading",
            "qty": qty,
            "pageW": page_w,
            "pageH": page_h,
            "paperSize": paper,
            "message": err or None,
        })

    def handle_capture_video(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except Exception:
            length = 0
        if length < 256 or length > MAX_VIDEO_BODY:
            self.close_connection = True
            self.write_json(400, {"ok": False, "message": "invalid video size"})
            return
        blob = self.rfile.read(length) if length else b""
        order_id = str(self.headers.get("X-Order-Id") or "").strip()
        name = save_capture_video(blob, order_id)
        if not name:
            self.write_json(400, {"ok": False, "message": "invalid video"})
            return
        self.write_json(200, {"ok": True, "file": name, "url": "/public/videos/" + name})

    def handle_phone_token(self):
        body = self.read_json_body()
        if not isinstance(body, dict):
            self.write_json(400, {"ok": False, "message": "invalid_json"})
            return
        code, out = request_phone_token(booth_device_id(), body.get("frame"), body.get("qty"))
        self.write_json(code, out)

    def handle_order(self):
        order_id = make_order_id()
        # Giống Form1.BuildQrUrlForOrder
        base = (booth_url_base() or "").strip().rstrip("/").replace(".vn", ".info")
        if not base:
            base = "https://moments-memories.lumina-x.info"
        qr_url = base + "/qrcode/" + order_id
        self.write_json(200, {"ok": True, "orderId": order_id, "qrUrl": qr_url, "expiresDays": 7})


class Server(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 8

    def handle_error(self, request, client_address):
        return


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    print("hoalo-html starting port=%s cwd=%s" % (port, os.getcwd()), flush=True)
    server = None
    fails = 0
    while server is None:
        try:
            server = Server((BIND_HOST, port), Handler)
        except OSError as ex:
            fails += 1
            print("hoalo-html bind fail #%s: %s" % (fails, ex), flush=True)
            time.sleep(2)
    print("hoalo-html http://%s:%s/" % (BIND_HOST, port), flush=True)
    threading.Thread(target=watch_print_completions, daemon=True).start()
    while True:
        try:
            server.serve_forever(poll_interval=0.5)
            break
        except KeyboardInterrupt:
            break
        except Exception:
            time.sleep(1)


if __name__ == "__main__":
    main()
