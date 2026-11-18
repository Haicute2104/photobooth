/* Dùng chung cho các màn có tờ in (thanh toán, hoàn thành) */
(function () {
    var UNIT_PRICE = 10000;
    var SLOT_COUNT = 8;

    function read(storage, key, fallback) {
        try { return JSON.parse(storage.getItem(key)) || fallback; } catch (e) { return fallback; }
    }

    fetch('config.json', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (cfg) {
            window.HOALO_CONFIG = window.HOALO_CONFIG || cfg || {};
            if (cfg && window.HOALO_CONFIG.takePhotoPrice == null) window.HOALO_CONFIG.takePhotoPrice = cfg.takePhotoPrice;
            if (cfg && window.HOALO_CONFIG.printPrice == null) window.HOALO_CONFIG.printPrice = cfg.printPrice;
        })
        .catch(function () {});

    // Giá chụp tại máy + (số bản - 1) × giá mỗi bản in thêm. Ưu tiên số đã chốt lúc chọn số lượng.
    window.getOrderTotal = function () {
        try {
            var saved = localStorage.getItem('orderTotal');
            var n = parseInt(saved, 10);
            if (saved != null && saved !== '' && n >= 0) return n;
        } catch (e) {}
        var qty = 1;
        try { qty = parseInt(localStorage.getItem('printQty'), 10) || 1; } catch (e2) {}
        if (qty < 1) qty = 1;
        var cfg = window.HOALO_CONFIG || {};
        var take = parseInt(cfg.takePhotoPrice, 10);
        var extra = parseInt(cfg.printPrice, 10);
        if (!(take >= 0)) take = UNIT_PRICE;
        if (!(extra >= 0)) extra = UNIT_PRICE;
        return take + (qty - 1) * extra;
    };

    window.formatVnd = function (n) {
        return n.toLocaleString('vi-VN') + ' VNĐ';
    };

    // Ảnh phủ kín ô (ở dưới), khung giấy giữ nguyên phía trên. sx/sy là tỉ lệ theo kích thước ô.
    window.placeCoverPhoto = function (img, slot, fit) {
        var nW = img.naturalWidth, nH = img.naturalHeight;
        var r = slot.getBoundingClientRect();
        if (!nW || !nH || r.width < 2 || r.height < 2) return fit;
        var scale = +fit.scale || 1;
        if (scale < 1) scale = 1;
        if (scale > 4) scale = 4;
        var base = Math.max(r.width / nW, r.height / nH);
        var dw = nW * base * scale;
        var dh = nH * base * scale;
        var maxSx = ((dw - r.width) / 2) / r.width;
        var maxSy = ((dh - r.height) / 2) / r.height;
        var sx = +fit.sx || 0, sy = +fit.sy || 0;
        if (sx > maxSx) sx = maxSx;
        if (sx < -maxSx) sx = -maxSx;
        if (sy > maxSy) sy = maxSy;
        if (sy < -maxSy) sy = -maxSy;
        fit.scale = scale;
        fit.sx = sx;
        fit.sy = sy;
        img.style.width = dw + 'px';
        img.style.height = dh + 'px';
        img.style.left = ((r.width - dw) / 2 + sx * r.width) + 'px';
        img.style.top = ((r.height - dh) / 2 + sy * r.height) + 'px';
        return fit;
    };

    // Vẽ ô ảnh theo cameraRects của frame đã chọn (cùng tọa độ với màn gắn ảnh).
    // Không có meta thì giữ lưới 2 cột cũ để không vỡ các frame HTML mặc định.
    // Khung full (Templates) hệ 1800x2400, khung small (tmp2) hệ 1200x1800.
    function frameDimsOf(meta) {
        var w = meta && +meta.frameW, h = meta && +meta.frameH;
        if (w > 0 && h > 0) return { w: w, h: h };
        var rel = meta && meta.frame ? String(meta.frame) : '';
        if (/(^|\/)tmp2\//i.test(rel)) return { w: 1200, h: 1800 };
        return { w: 1800, h: 2400 };
    }

    function frameMetaWait() {
        if (window.hoaloGetSelectedFrameMeta) {
            try { return window.hoaloGetSelectedFrameMeta(); } catch (e) { }
        }
        return Promise.resolve(null);
    }

    function sheetSlots(slotsEl, count) {
        var boxes = [];
        if (slotsEl) {
            slotsEl.style.position = 'absolute';
            slotsEl.style.inset = '0';
            slotsEl.style.display = 'block';
        }
        for (var i = 0; i < count; i++) {
            var d = document.createElement('div');
            d.className = 'print-photo';
            d.style.position = 'absolute';
            d.style.aspectRatio = 'auto';
            if (slotsEl) slotsEl.appendChild(d);
            boxes.push(d);
        }
        return boxes;
    }

    function applySheetRects(boxes, rects, meta) {
        var dims = frameDimsOf(meta);
        rects.forEach(function (rect, i) {
            var d = boxes[i];
            if (!d || !rect) return;
            d.style.left = (rect.x / dims.w * 100) + '%';
            d.style.top = (rect.y / dims.h * 100) + '%';
            d.style.width = (rect.w / dims.w * 100) + '%';
            d.style.height = (rect.h / dims.h * 100) + '%';
        });
    }

    // Vẽ 8 ô ảnh theo layout đã gắn ở B5 + mã QR audio
    window.renderPrintSheet = function (slotsEl, qrEl) {
        var paper = slotsEl && slotsEl.closest ? slotsEl.closest('.paper') : null;
        if (!paper) return Promise.resolve();
        // Preview the same flattened PNG that is sent to the printer.
        // This also avoids measuring photo boxes while the paper is animating.
        return frameMetaWait().then(function (meta) {
            var dims = frameDimsOf(meta);
            return window.composePrintPng(dims.w, dims.h, true);
        }).then(function (src) {
            if (!src) throw new Error('Không tạo được ảnh xem trước.');
            var img = document.createElement('img');
            img.alt = 'Ảnh xem trước bản in';
            img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;z-index:7';
            img.src = src;
            paper.replaceChildren(img);
        }).catch(function (err) {
            var message = document.createElement('p');
            message.setAttribute('role', 'alert');
            message.style.cssText = 'margin:auto;padding:8%;color:#a21b1b;text-align:center';
            message.textContent = err.message || 'Không tải được ảnh xem trước. Vui lòng chọn lại ảnh.';
            paper.replaceChildren(message);
        });
    };

    function loadImage(src, required) {
        return new Promise(function (resolve, reject) {
            if (!src) { resolve(null); return; }
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () {
                if (required) reject(new Error('Không tải được ảnh hoặc khung đã chọn. Vui lòng thử lại.'));
                else resolve(null);
            };
            img.src = src;
        });
    }

    function drawCover(ctx, img, x, y, w, h, fit) {
        var nW = img.naturalWidth || img.width;
        var nH = img.naturalHeight || img.height;
        if (!nW || !nH) return;
        var scale = +fit.scale || 1;
        if (scale < 1) scale = 1;
        if (scale > 4) scale = 4;
        var base = Math.max(w / nW, h / nH);
        var dw = nW * base * scale;
        var dh = nH * base * scale;
        var maxSx = ((dw - w) / 2) / w;
        var maxSy = ((dh - h) / 2) / h;
        var sx = +fit.sx || 0;
        var sy = +fit.sy || 0;
        if (sx > maxSx) sx = maxSx;
        if (sx < -maxSx) sx = -maxSx;
        if (sy > maxSy) sy = maxSy;
        if (sy < -maxSy) sy = -maxSy;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.drawImage(img, x + (w - dw) / 2 + sx * w, y + (h - dh) / 2 + sy * h, dw, dh);
        ctx.restore();
    }

    window.composePrintPng = function (pageW, pageH, previewOnly) {
        // Reset before composing so a different frame cannot reuse old QR positions.
        if (!previewOnly) window.HOALO_PRINT_MARKS = null;
        pageW = parseInt(pageW, 10) || 1800;
        pageH = parseInt(pageH, 10) || 2400;
        if (pageW < 100) pageW = 1800;
        if (pageH < 100) pageH = 2400;
        if (pageW > 4000) pageW = 4000;
        if (pageH > 5000) pageH = 5000;
        var photos = read(sessionStorage, 'photos', []);
        var layout = read(sessionStorage, 'layout', []);
        var fits = read(sessionStorage, 'layoutFit', []);
        var frameWait = window.hoaloGetSelectedFrameOverlay
            ? window.hoaloGetSelectedFrameOverlay()
            : Promise.resolve(null);
        var metaWait = frameMetaWait();
        return Promise.all([frameWait, metaWait]).then(function (pair) {
            var frame = pair[0];
            var meta = pair[1];
            var rects = (meta && meta.cameraRects && meta.cameraRects.length) ? meta.cameraRects : (meta && meta.cameraRect ? [meta.cameraRect] : []);
            var useRects = rects.length > 0;
            var slotCount = useRects ? rects.length : SLOT_COUNT;
            var loads = [];
            for (var i = 0; i < slotCount; i++) {
                var index = layout[i];
                if (!Number.isInteger(index) || index < 0 || !photos[index]) {
                    throw new Error('Chưa đủ ảnh trong khung. Vui lòng quay lại chọn ảnh.');
                }
                loads.push(loadImage(photos[index], true));
            }
            loads.push(loadImage('images/logo-hoa-lo.png'));
            loads.push(loadImage(frame && frame.url ? frame.url : null, !!frame));
            return Promise.all(loads).then(function (images) {
                var logo = images[slotCount];
                var frameImg = images[slotCount + 1];
                var canvas = document.createElement('canvas');
                canvas.width = pageW;
                canvas.height = pageH;
                var ctx = canvas.getContext('2d');
                if (!ctx) return '';
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, pageW, pageH);
                var padX = pageW * 0.05;
                var padTop = pageW * 0.039;
                var gapX = pageW * 0.066;
                var gapY = pageW * 0.0205;
                var slotW = (pageW - padX * 2 - gapX) / 2;
                var slotH = slotW * (141 / 230);
                var gridH = 4 * slotH + 3 * gapY;
                var maxGrid = pageH * 0.78 - padTop;
                if (gridH > maxGrid && maxGrid > 0) {
                    var shrink = maxGrid / gridH;
                    slotW *= shrink;
                    slotH *= shrink;
                    gapX *= shrink;
                    gapY *= shrink;
                    gridH = maxGrid;
                }
                var originX = (pageW - (slotW * 2 + gapX)) / 2;
                // Tọa độ lỗ theo tỉ lệ trang in (meta mang sẵn hệ khung đúng).
                var dims = frameDimsOf(meta);
                function rectToPage(rect) {
                    return {
                        x: rect.x / dims.w * pageW,
                        y: rect.y / dims.h * pageH,
                        w: rect.w / dims.w * pageW,
                        h: rect.h / dims.h * pageH
                    };
                }
                // PtbHtmlPrint.exe stamps the CDN QR after upload. Pass positions
                // in output pixels; the frame metadata uses its own coordinate system.
                function markRect(rect) {
                    if (!rect || !isFinite(+rect.x) || !isFinite(+rect.y) ||
                        !isFinite(+rect.w) || !isFinite(+rect.h) ||
                        !(+rect.w > 0) || !(+rect.h > 0)) return null;
                    var mapped = rectToPage(rect);
                    Object.keys(mapped).forEach(function (key) { mapped[key] = Math.round(mapped[key]); });
                    return mapped;
                }
                var now = new Date();
                function pad(n) { return (n < 10 ? '0' : '') + n; }
                if (!previewOnly) window.HOALO_PRINT_MARKS = {
                    pageW: pageW,
                    pageH: pageH,
                    frameRel: (frame && frame.frameRel) || (meta && meta.frame) || '',
                    qrRect: markRect(meta && meta.QrCodeRect),
                    dateRect: markRect(meta && meta.lblDatePos),
                    dateText: pad(now.getHours()) + ':' + pad(now.getMinutes()) + ' ' +
                        pad(now.getDate()) + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear()
                };
                var gridBottom = padTop + gridH;
                if (useRects) {
                    rects.forEach(function (rect) {
                        var r = rectToPage(rect);
                        if (r.y + r.h > gridBottom) gridBottom = r.y + r.h;
                    });
                }
                for (var n = 0; n < slotCount; n++) {
                    var x, y, w, h;
                    if (useRects) {
                        var rp = rectToPage(rects[n]);
                        x = rp.x; y = rp.y; w = rp.w; h = rp.h;
                    } else {
                        x = originX + (n % 2) * (slotW + gapX);
                        y = padTop + Math.floor(n / 2) * (slotH + gapY);
                        w = slotW; h = slotH;
                    }
                    ctx.fillStyle = '#0e0a20';
                    ctx.fillRect(x, y, w, h);
                    var fit = fits[n] && typeof fits[n] === 'object' ? fits[n] : { sx: 0, sy: 0, scale: 1 };
                    if (images[n]) drawCover(ctx, images[n], x, y, w, h, fit);
                }
                var footerTop = gridBottom;
                var footerH = pageH - footerTop;
                if (!frameImg && logo && logo.width && footerH > 8) {
                    var lw = pageW * 0.16;
                    var lh = lw * (logo.height / logo.width);
                    if (lh > footerH * 0.7) {
                        lh = footerH * 0.7;
                        lw = lh * (logo.width / logo.height);
                    }
                    try {
                        ctx.save();
                        ctx.filter = 'brightness(0)';
                        ctx.drawImage(logo, pageW * 0.25 - lw / 2, footerTop + (footerH - lh) / 2, lw, lh);
                        ctx.restore();
                    } catch (e) {}
                }
                if (frameImg) {
                    try { ctx.drawImage(frameImg, 0, 0, pageW, pageH); } catch (ef) {}
                }
                // QR stamping is handled by PtbHtmlPrint.exe.
                var url = '';
                try { url = canvas.toDataURL('image/png'); } catch (e3) { url = ''; }
                canvas.width = 1;
                canvas.height = 1;
                return url;
            });
        });
    };
})();
