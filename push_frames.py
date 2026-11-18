# Push Hoa Lo HTML frames to configptb: punch photo holes, sample from web photos.
import base64
import io
import json
import os
import urllib.request

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(ROOT, "images")
TARGET = (1800, 2400)
DEVICE = "LUMINAXHOALO"
FOLDER = "Templates"
API = "http://127.0.0.1:18191/api/frames"
# Token admin chi doc trong web\ (config.json hoac portal.json cung thu muc).
CONFIG = os.path.join(ROOT, "config.json")
PORTAL = os.path.join(ROOT, "portal.json")
FRAMES = [
    "Frame-1-thumb.png",
    "Frame-2-thumb.png",
    "Frame-3-thumb.png",
    "Frame-4-thumb.png",
    "Frame-5-thumb.png",
]
PHOTO_URLS = [
    "https://picsum.photos/id/1011/900/700",
    "https://picsum.photos/id/1012/900/700",
    "https://picsum.photos/id/1027/900/700",
    "https://picsum.photos/id/1062/900/700",
    "https://picsum.photos/id/1074/900/700",
    "https://picsum.photos/id/1005/900/700",
    "https://picsum.photos/id/1035/900/700",
    "https://picsum.photos/id/1066/900/700",
]


def fit_sheet(im):
    im = im.convert("RGBA")
    scale = min(TARGET[0] / im.width, TARGET[1] / im.height)
    nw, nh = max(1, int(round(im.width * scale))), max(1, int(round(im.height * scale)))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", TARGET, (255, 255, 255, 255))
    ox, oy = (TARGET[0] - nw) // 2, (TARGET[1] - nh) // 2
    canvas.paste(im, (ox, oy), im)
    return canvas, (ox, oy, ox + nw, oy + nh)


def slot_mask(arr, box, kind):
    r = arr[:, :, 0].astype(np.int16)
    g = arr[:, :, 1].astype(np.int16)
    b = arr[:, :, 2].astype(np.int16)
    x0, y0, x1, y1 = box
    region = np.zeros(arr.shape[:2], dtype=bool)
    view = region[y0:y1, x0:x1]
    rr, gg, bb = r[y0:y1, x0:x1], g[y0:y1, x0:x1], b[y0:y1, x0:x1]
    flat = (np.abs(rr - gg) < 18) & (np.abs(gg - bb) < 18) & (np.abs(rr - bb) < 18)
    if kind == "white":
        view[:] = flat & (rr > 232) & (gg > 232) & (bb > 232)
    else:
        view[:] = flat & (rr > 55) & (rr < 175)
    return region


def components(mask, step=4):
    small = mask[::step, ::step]
    h, w = small.shape
    seen = np.zeros_like(small, dtype=bool)
    boxes = []
    ys, xs = np.where(small)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if seen[y, x] or not small[y, x]:
            continue
        stack = [(y, x)]
        seen[y, x] = True
        minx = maxx = x
        miny = maxy = y
        count = 0
        while stack:
            cy, cx = stack.pop()
            count += 1
            if cx < minx: minx = cx
            if cx > maxx: maxx = cx
            if cy < miny: miny = cy
            if cy > maxy: maxy = cy
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if ny < 0 or nx < 0 or ny >= h or nx >= w or seen[ny, nx] or not small[ny, nx]:
                    continue
                seen[ny, nx] = True
                stack.append((ny, nx))
        bw = (maxx - minx + 1) * step
        bh = (maxy - miny + 1) * step
        if bw < 80 or bh < 40 or count * step * step < 4000:
            continue
        boxes.append([minx * step, miny * step, bw, bh, count * step * step])
    return boxes


def tighten(mask, box):
    x, y, w, h = box[:4]
    x1, y1 = min(mask.shape[1], x + w), min(mask.shape[0], y + h)
    sub = mask[y:y1, x:x1]
    if sub.size == 0 or not sub.any():
        return None
    rows = np.where(sub.any(axis=1))[0]
    cols = np.where(sub.any(axis=0))[0]
    if len(rows) == 0 or len(cols) == 0:
        return None
    nx, ny = x + int(cols[0]), y + int(rows[0])
    nw, nh = int(cols[-1] - cols[0] + 1), int(rows[-1] - rows[0] + 1)
    fill = float(sub[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1].mean())
    if fill < 0.72 or nw < 80 or nh < 40:
        return None
    return [nx, ny, nw, nh]


def pick_holes(mask):
    found = []
    for box in components(mask):
        tight = tighten(mask, box)
        if tight:
            found.append(tight)
    found.sort(key=lambda r: r[2] * r[3], reverse=True)
    # Keep the slot-sized rectangles, drop the big page background if it was included.
    if not found:
        return []
    areas = [r[2] * r[3] for r in found]
    cutoff = max(areas) * 0.35
    slots = [r for r in found if r[2] * r[3] >= cutoff]
    if len(slots) > 8:
        slots = sorted(slots, key=lambda r: r[2] * r[3], reverse=True)[:8]
    slots.sort(key=lambda r: (r[1] // 40, r[0]))
    return slots


def punch(im, holes, inset=3):
    arr = np.array(im)
    for x, y, w, h in holes:
        x0, y0 = x + inset, y + inset
        x1, y1 = x + w - inset, y + h - inset
        if x1 <= x0 or y1 <= y0:
            continue
        arr[y0:y1, x0:x1, 3] = 0
    return Image.fromarray(arr)


def download_photos():
    photos = []
    for url in PHOTO_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "hoalo-html-frame-sample"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            im = Image.open(io.BytesIO(data)).convert("RGB")
            photos.append(im)
            print("photo", url, im.size)
        except Exception as ex:
            print("photo fail", url, ex)
    if len(photos) < 1:
        raise SystemExit("no sample photos downloaded")
    return photos


def cover_paste(dst, photo, hole):
    x, y, w, h = hole
    scale = max(w / photo.width, h / photo.height)
    nw, nh = int(photo.width * scale) + 1, int(photo.height * scale) + 1
    resized = photo.resize((nw, nh), Image.Resampling.LANCZOS)
    cx, cy = (nw - w) // 2, (nh - h) // 2
    crop = resized.crop((cx, cy, cx + w, cy + h))
    dst.paste(crop, (x, y))


def build_sample(holes, photos):
    sheet = Image.new("RGB", TARGET, (255, 255, 255))
    for i, hole in enumerate(holes):
        cover_paste(sheet, photos[i % len(photos)], hole)
    return sheet


def png_b64(im):
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def jpg_b64(im):
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=86)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def footer_qr(holes):
    if not holes:
        return None
    bottom = max(y + h for _, y, _, h in holes)
    gap = TARGET[1] - bottom
    size = 220
    if gap < size + 50:
        return None
    x = TARGET[0] - size - 90
    y = bottom + (gap - size) // 2
    return {"x": int(x), "y": int(y), "w": size, "h": size}


def upload(name, frame, holes, sample, token):
    body = {
        "deviceId": DEVICE,
        "folder": FOLDER,
        "name": name,
        "resizeToTarget": False,
        "imageBase64": png_b64(frame),
        "sampleBase64": jpg_b64(sample),
        "cameraRects": [{"x": int(x), "y": int(y), "w": int(w), "h": int(h)} for x, y, w, h in holes],
    }
    qr = footer_qr(holes)
    if qr:
        body["QrCodeRect"] = qr
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        API + "?deviceId=" + DEVICE,
        data=data,
        headers={"Content-Type": "application/json", "X-Admin-Token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_admin_token():
    for path in (CONFIG, PORTAL):
        try:
            with open(path, encoding="utf-8") as f:
                cfg = json.load(f)
            token = str(cfg.get("adminToken") or "").strip()
            if token:
                return token
        except Exception:
            pass
    raise SystemExit("Thieu adminToken trong web\\config.json (hoac web\\portal.json).")


def main():
    token = load_admin_token()
    photos = download_photos()
    for i, filename in enumerate(FRAMES, start=1):
        src = Image.open(os.path.join(IMG, filename))
        sheet, box = fit_sheet(src)
        arr = np.array(sheet)
        holes = []
        for kind in ("white", "gray"):
            holes = pick_holes(slot_mask(arr, box, kind))
            print(filename, kind, len(holes), holes)
            if len(holes) >= 6:
                break
        if len(holes) < 6:
            raise SystemExit("hole detect failed for " + filename)
        punched = punch(sheet, holes)
        sample = build_sample(holes, photos)
        preview = sample.convert("RGBA")
        preview.alpha_composite(punched)
        preview_path = os.path.join(ROOT, "_frame_preview_%d.png" % i)
        preview.resize((450, 600), Image.Resampling.LANCZOS).save(preview_path)
        result = upload("frame_%d" % i, punched, holes, sample, token)
        print("uploaded", result.get("name"), result.get("ok"), "holes", len(holes), result.get("thumbRel"))


if __name__ == "__main__":
    main()
