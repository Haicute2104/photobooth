/* Nhận lệnh configptb: chụp miễn phí và restart máy. */
(function () {
    try {
        var proto = (location && location.protocol) || '';
        var host = (location && location.hostname) || '';
        if (/^https?:$/i.test(proto) && host && host !== '127.0.0.1') {
            var port = location.port ? (':' + location.port) : '';
            location.replace('http://127.0.0.1' + port + (location.pathname || '/') + (location.search || '') + (location.hash || ''));
            return;
        }
    } catch (e0) {}

    var POLL_MS = 15000;
    var seen = {};
    var skipping = false;

    /** Chan vuot trai/phai (va nut Back) thanh browser Next/Back. */
    (function blockSwipeHistoryNav() {
        function trap() {
            try { history.pushState({ hoaloNoSwipe: 1 }, '', location.href); } catch (e) {}
        }
        trap();
        window.addEventListener('popstate', function () { trap(); });
        window.addEventListener('keydown', function (e) {
            if (e.key === 'BrowserBack' || e.key === 'BrowserForward') e.preventDefault();
            if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) e.preventDefault();
        });
        function blockMouseNav(e) {
            if (e.button === 3 || e.button === 4) e.preventDefault();
        }
        window.addEventListener('mouseup', blockMouseNav);
        window.addEventListener('mousedown', blockMouseNav);
        window.addEventListener('auxclick', blockMouseNav);
    })();

    var lastGoodBase = null; // null=chua co; ''=same-origin relative

    function bases(cfg) {
        // Chi same-origin / origin: mapp.py proxy sang configptb (tranh Chrome PNA / CORS cong la).
        var list = [];
        function add(b) {
            if (b === null || b === undefined) return;
            b = b === '' ? '' : String(b).replace(/\/$/, '');
            if (b && !/^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(b)) return;
            if (list.indexOf(b) >= 0) return;
            list.push(b);
        }
        if (lastGoodBase !== null) add(lastGoodBase);
        add('');
        try {
            var port = (location && location.port) ? (':' + location.port) : '';
            add('http://127.0.0.1' + port);
        } catch (e) {}
        return list;
    }

    function baseLabel(b) {
        return (b === '' || b === null || b === undefined) ? '(same-origin)' : String(b);
    }

    function apiUrl(base, pathQuery) {
        if (!base) return pathQuery;
        return String(base).replace(/\/$/, '') + pathQuery;
    }

    function pageName() {
        var name = (location.pathname || '').split('/').pop() || 'index.html';
        return 'hoalo-html/' + name;
    }

    function post(cfg, path, body, signal) {
        var list = bases(cfg);
        function attempt(i) {
            if (i >= list.length) return Promise.reject(new Error('unreachable'));
            if (signal && signal.aborted) return Promise.reject(new Error('aborted'));
            return fetch(list[i] + path, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Device-Id': cfg.deviceId,
                    'X-Device-Token': cfg.cloudConfigToken
                },
                body: JSON.stringify(body || {}),
                signal: signal
            }).then(function (r) {
                if (!r.ok) throw new Error('http');
                return r.json();
            }).catch(function (err) {
                if (signal && signal.aborted) return Promise.reject(err);
                return attempt(i + 1);
            });
        }
        return attempt(0);
    }

    function withTimeout(ms) {
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
        return {
            signal: ctrl ? ctrl.signal : undefined,
            done: function () { clearTimeout(timer); }
        };
    }

    function freeRemain() {
        var n = 0;
        try { n = parseInt(sessionStorage.getItem('hoaloFreeRemain') || '0', 10) || 0; } catch (e) {}
        return n > 0 ? n : 0;
    }

    function setFreeRemain(n) {
        try { sessionStorage.setItem('hoaloFreeRemain', String(Math.max(0, n))); } catch (e) {}
    }

    window.hoaloFreeRemain = freeRemain;

    window.hoaloConsumeFree = function () {
        var n = freeRemain();
        if (n < 1) return false;
        setFreeRemain(n - 1);
        return true;
    };

    /** Một lượt miễn phí áp dụng cho toàn bộ số bản khách đã chọn. */
    window.hoaloTakeFreePrints = function (maxQty) {
        var cap = parseInt(maxQty, 10);
        if (!(cap >= 1)) cap = 10;
        if (cap > 20) cap = 20;
        if (freeRemain() < 1) return 0;
        var n = 1;
        try { n = parseInt(localStorage.getItem('printQty'), 10) || 1; } catch (eQty) {}
        if (n < 1) n = 1;
        if (n > cap) n = cap;
        setFreeRemain(freeRemain() - 1);
        try { sessionStorage.setItem('payMethod', 'free'); } catch (e2) {}
        return n;
    };

    var FREE_IDS_KEY = 'hoaloFreeIds';
    var PAY_SEEN_KEY = 'hoaloPaySeen';
    var freeCheckInflight = false;

    function grantedFreeIds() {
        try {
            var raw = JSON.parse(sessionStorage.getItem(FREE_IDS_KEY) || '[]');
            return Array.isArray(raw) ? raw.map(String) : [];
        } catch (e) { return []; }
    }

    function alreadyGranted(id) {
        return grantedFreeIds().indexOf(String(id)) >= 0;
    }

    function rememberGrant(id) {
        var ids = grantedFreeIds();
        id = String(id);
        if (ids.indexOf(id) >= 0) return;
        ids.push(id);
        try { sessionStorage.setItem(FREE_IDS_KEY, JSON.stringify(ids.slice(-80))); } catch (e) {}
    }

    function payAlreadyMoving() {
        try {
            if (sessionStorage.getItem('transaction')) return true;
            if (sessionStorage.getItem(PAY_SEEN_KEY) === '1') return true;
        } catch (e) {}
        return false;
    }

    function onPaymentPage() {
        var name = ((location.pathname || '').split('/').pop() || '').toLowerCase();
        return name === 'thanh-toan.html' || name === 'thanh-toan-qr.html' || name === 'thanh-toan-tien-mat.html';
    }

    function freeNextPage() {
        try {
            if (sessionStorage.getItem('hoaloPhoneSend') === '1') return 'gui-anh-qr.html';
        } catch (ePhone) {}
        return 'hoan-thanh.html';
    }

    function maybeSkipPayment() {
        if (skipping || freeCheckInflight || !onPaymentPage()) return;
        var method = '';
        try { method = sessionStorage.getItem('payMethod') || ''; } catch (e) {}
        if (method === 'free') {
            skipping = true;
            location.replace(freeNextPage());
            return;
        }
        // Đã có tiền trong quỹ hoặc đã chốt giao dịch: giữ suất miễn phí cho khách sau.
        if (payAlreadyMoving()) return;
        if (freeRemain() < 1) return;
        freeCheckInflight = true;
        fetch('/api/v1/payments', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                freeCheckInflight = false;
                if (skipping || !onPaymentPage()) return;
                var n = parseInt(data && data.tientichluy, 10) || 0;
                if (n > 0) {
                    try { sessionStorage.setItem(PAY_SEEN_KEY, '1'); } catch (e) {}
                    return;
                }
                if (payAlreadyMoving()) return;
                if (!window.hoaloTakeFreePrints(10)) return;
                skipping = true;
                location.replace(freeNextPage());
            })
            .catch(function () { freeCheckInflight = false; });
    }

    function armFree(qty) {
        var add = parseInt(qty, 10);
        if (!(add > 0)) add = 1;
        if (add > 20) add = 20;
        setFreeRemain(freeRemain() + add);
        try { window.dispatchEvent(new Event('hoalo-free')); } catch (eFree) {}
        maybeSkipPayment();
    }

    function showPaperOut(deviceId) {
        var id = String(deviceId || '').replace(/[^\w-]/g, '');
        var el = document.getElementById('hoaloPaperOut');
        if (!el) {
            el = document.createElement('div');
            el.id = 'hoaloPaperOut';
            el.setAttribute('role', 'alert');
            el.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#160d22;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:8vw;font:700 3.4vw/1.45 "Be Vietnam Pro",sans-serif';
            document.body.appendChild(el);
        }
        el.textContent = '';
        ['Giấy đang hết', 'Vui lòng liên hệ hotline 0378657777', 'và đọc id máy là ' + id].forEach(function (line) {
            var p = document.createElement('p');
            p.textContent = line;
            p.style.margin = '0 0 .35em';
            el.appendChild(p);
        });
    }

    function hidePaperOut() {
        var el = document.getElementById('hoaloPaperOut');
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function checkPaper() {
        return fetch('/api/v1/paper', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (data && data.paperOut) showPaperOut(data.deviceId);
                else hidePaperOut();
            })
            .catch(function () {});
    }

    function showRestartNotice() {
        var el = document.createElement('div');
        el.textContent = 'Máy sẽ khởi động lại...';
        el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#160d22;color:#fff;display:flex;align-items:center;justify-content:center;font:700 4vw/1.3 "Be Vietnam Pro",sans-serif;text-align:center;padding:8vw';
        document.body.appendChild(el);
    }

    function requestRestart() {
        var timed = withTimeout(5000);
        return fetch('/local/restart', { method: 'POST', signal: timed.signal }).then(function (r) {
            if (!r.ok) throw new Error('restart');
            return r.json();
        }).then(function (res) {
            timed.done();
            return res;
        }, function (err) {
            timed.done();
            throw err;
        });
    }

    function handlePending(cfg, pending) {
        if (!pending || !pending.id || !pending.type) return;
        var id = String(pending.id);
        if (seen[id]) return;
        var type = String(pending.type).toLowerCase().replace(/-/g, '_');
        if (type !== 'free_capture' && type !== 'restart') return;
        seen[id] = true;

        if (type === 'restart') {
            try {
                if (sessionStorage.getItem('hoaloRestartId') === id) return;
            } catch (e) {}
            showRestartNotice();
            requestRestart().then(function () {
                try { sessionStorage.setItem('hoaloRestartId', id); } catch (e) {}
                return post(cfg, '/api/commands/ack', { id: id, command: 'restart' });
            }).catch(function () { delete seen[id]; });
            return;
        }

        if (alreadyGranted(id)) {
            post(cfg, '/api/commands/ack', { id: id, command: 'free_capture', qty: pending.qty || 1 })
                .catch(function () { delete seen[id]; });
            return;
        }

        post(cfg, '/api/commands/ack', { id: id, command: 'free_capture', qty: pending.qty || 1 })
            .then(function (res) {
                if (!res || res.acked === false) { delete seen[id]; return; }
                if (alreadyGranted(id)) return;
                rememberGrant(id);
                armFree(pending.qty);
            })
            .catch(function () { delete seen[id]; });
    }

    var polling = false;
    function poll(cfg) {
        if (polling) return;
        polling = true;
        var timed = withTimeout(5000);
        var beat = { page: pageName(), appVersion: 'hoalo-html' };
        try {
            var printed = JSON.parse(sessionStorage.getItem('hoaloPrinted') || 'null');
            if (printed && printed.id && parseInt(printed.qty, 10) > 0) {
                beat.printedCopies = parseInt(printed.qty, 10);
                beat.printEventId = String(printed.id);
            }
        } catch (e) {}
        post(cfg, '/api/heartbeat', beat, timed.signal)
            .then(function (res) {
                if (beat.printEventId) {
                    try { sessionStorage.removeItem('hoaloPrinted'); } catch (e) {}
                }
                if (res) handlePending(cfg, res.pendingCommand);
                return checkPaper();
            })
            .catch(function () {})
            .then(function () { timed.done(); polling = false; checkPaper(); });
    }

    var bootPage = ((location.pathname || '').split('/').pop() || '').toLowerCase();
    if (bootPage === 'index.html' || bootPage === '') {
        try {
            ['photos', 'layout', 'layoutFit', 'hoaloOrderId', 'hoaloQrUrl', 'payMethod', 'transaction', PAY_SEEN_KEY, 'hoaloPhoneSend', 'hoaloPhoneTicket'].forEach(function (k) { sessionStorage.removeItem(k); });
        } catch (e) {}
    }
    maybeSkipPayment();
    checkPaper();

    function clampTimeout(n) {
        n = parseInt(n, 10);
        if (!(n >= 5)) return 60;
        if (n > 3600) return 3600;
        return n;
    }

    function readTimeoutSeconds(key, legacyKey) {
        function timeoutValue(cfg) {
            var value = cfg && cfg[key];
            if (!(parseInt(value, 10) >= 5) && legacyKey) value = cfg && cfg[legacyKey];
            return value;
        }
        return fetch('config.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; })
            .then(function (local) {
                local = local || {};
                var localSec = clampTimeout(timeoutValue(local));
                // Cloud is authoritative; use its last cached value, then local config when offline.
                return loadCachedEssentialConfig().then(function (cached) {
                    var cachedValue = cached && cached[key];
                    // Old caches do not have the shared background/payment timeout yet.
                    if (!(parseInt(cachedValue, 10) >= 5) && !(parseInt(local[key], 10) >= 5)) {
                        cachedValue = timeoutValue(cached);
                    }
                    var cachedSec = parseInt(cachedValue, 10) >= 5 ? clampTimeout(cachedValue) : localSec;
                    if (!local.deviceId || !local.cloudConfigToken) return cachedSec;
                    var timed = withTimeout(4000);
                    var list = bases(local);
                    function attempt(i) {
                        if (i >= list.length || (timed.signal && timed.signal.aborted)) return Promise.reject(new Error('sync'));
                        return fetch(apiUrl(list[i], '/api/sync'), {
                            headers: {
                                'X-Device-Id': local.deviceId,
                                'X-Device-Token': local.cloudConfigToken
                            },
                            cache: 'no-store',
                            signal: timed.signal
                        }).then(function (r) {
                            if (!r.ok) throw new Error('http');
                            return r.json();
                        }).then(function (res) {
                            var n = timeoutValue(res && res.config);
                            if (parseInt(n, 10) >= 5) {
                                cacheEssentialConfigAfterFrames(res.config).catch(function () {});
                                return clampTimeout(n);
                            }
                            throw new Error('missing');
                        }).catch(function () { return attempt(i + 1); });
                    }
                    return new Promise(function (resolve) {
                        var done = false;
                        function finish(n) {
                            if (done) return;
                            done = true;
                            timed.done();
                            resolve(clampTimeout(n));
                        }
                        setTimeout(function () { finish(cachedSec); }, 4500);
                        attempt(0).then(finish, function () { finish(cachedSec); });
                    });
                });
            })
            .catch(function () { return 60; });
    }

    // Payment wait shares the cloud's "Timeout thay nền" setting.
    window.hoaloGetPaymentTimeout = function () { return readTimeoutSeconds('previewReplaceTimeoutSeconds', 'paymentTimeoutSeconds'); };
    window.hoaloGetCaptureTimeout = function () { return readTimeoutSeconds('captureTimeoutSeconds'); };
    window.hoaloGetLayoutTimeout = function () { return readTimeoutSeconds('layoutTimeoutSeconds'); };

    window.hoaloCmsBase = function () {
        var cfg = window.HOALO_CONFIG || {};
        var base = String(cfg.urlBase || '').trim().replace(/\/$/, '');
        if (!base) base = 'https://moments-memories.lumina-x.info';
        return base;
    };

    /** Giống Form1.BuildQrUrlForOrder: {urlBase}/qrcode/{orderId} (+ .vn→.info). */
    window.hoaloQrUrlForOrder = function (orderId) {
        orderId = String(orderId || '').trim();
        if (!orderId) return '';
        var base = String(window.hoaloCmsBase() || '').replace(/\.vn/gi, '.info').replace(/\/$/, '');
        return base + '/qrcode/' + orderId;
    };

    /** Đồng bộ: lấy order đã có hoặc placeholder; tạo thật qua hoaloEnsureDownloadOrderAsync. */
    window.hoaloEnsureDownloadOrder = function () {
        try {
            var existing = sessionStorage.getItem('hoaloOrderId');
            var qr = sessionStorage.getItem('hoaloQrUrl');
            if (existing && qr) return { orderId: existing, qrUrl: qr };
        } catch (e) {}
        return { orderId: '', qrUrl: '' };
    };

    /** Tạo orderId giống PTB.exe + URL QR CMS (Wasabi 7 ngày sau khi PtbHtmlPrint upload). */
    window.hoaloEnsureDownloadOrderAsync = function () {
        var cur = window.hoaloEnsureDownloadOrder();
        if (cur.orderId && cur.qrUrl) return Promise.resolve(cur);
        return fetch('/api/v1/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('order')); })
            .then(function (res) {
                var orderId = String((res && res.orderId) || '').trim();
                var qrUrl = String((res && res.qrUrl) || '').trim();
                if (!orderId) throw new Error('order');
                if (!qrUrl) qrUrl = window.hoaloQrUrlForOrder(orderId);
                try {
                    sessionStorage.setItem('hoaloOrderId', orderId);
                    sessionStorage.setItem('hoaloQrUrl', qrUrl);
                } catch (e2) {}
                return { orderId: orderId, qrUrl: qrUrl };
            })
            .catch(function () {
                var cfg = window.HOALO_CONFIG || {};
                var deviceId = String(cfg.deviceId || 'DEVICE').trim() || 'DEVICE';
                var d = new Date();
                function p(n) { return (n < 10 ? '0' : '') + n; }
                var plain = p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + p(d.getDate()) + p(d.getMonth() + 1) + String(d.getFullYear());
                var orderId = deviceId + plain;
                var qrUrl = window.hoaloQrUrlForOrder(orderId);
                try {
                    sessionStorage.setItem('hoaloOrderId', orderId);
                    sessionStorage.setItem('hoaloQrUrl', qrUrl);
                } catch (e3) {}
                return { orderId: orderId, qrUrl: qrUrl };
            });
    };

    function moneyOr(n, fallback) {
        n = parseInt(n, 10);
        return n >= 0 ? n : fallback;
    }

    function pricePair(src, fallback) {
        fallback = fallback || { takePhotoPrice: 20000, printPrice: 20000 };
        src = src || {};
        return {
            takePhotoPrice: moneyOr(src.takePhotoPrice, fallback.takePhotoPrice),
            printPrice: moneyOr(src.printPrice, fallback.printPrice)
        };
    }

    var ESSENTIAL_CONFIG_KEYS = [
        'takePhotoPrice', 'printPrice', 'onlinePhotoPrice', 'webPrintPrice', 'webSendPrintPrice',
        'printMin', 'printMax',
        'paymentTimeoutSeconds', 'captureTimeoutSeconds', 'layoutTimeoutSeconds', 'maxTimeWait',
        'previewReplaceTimeoutSeconds',
        'cameraNameKeyword', 'cameraExcludeKeyword', 'cameraCaptureWidth', 'cameraCaptureHeight',
        'cameraIndex', 'cameraProfile', 'urlBase', 'hideWebPrintQr', 'deviceID', 'deviceId',
        'printPaperSize'
    ];
    var CLOUD_CONFIG_LS_KEY = 'hoaloCloudConfig';
    var CONFIG_IDB_KEY = '__config__/essential.json';

    function pickEssentialConfig(src) {
        src = src || {};
        var out = {};
        ESSENTIAL_CONFIG_KEYS.forEach(function (k) {
            if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
        });
        if (out.deviceId == null && out.deviceID != null) out.deviceId = out.deviceID;
        return out;
    }

    function applyEssentialConfig(essential) {
        if (!essential) return;
        window.HOALO_CONFIG = window.HOALO_CONFIG || {};
        Object.keys(essential).forEach(function (k) {
            window.HOALO_CONFIG[k] = essential[k];
        });
        rememberCloudPrices(pricePair(essential, {
            takePhotoPrice: window.HOALO_CONFIG.takePhotoPrice,
            printPrice: window.HOALO_CONFIG.printPrice
        }));
    }

    function rememberCloudPrices(prices) {
        if (!prices) return;
        try {
            localStorage.setItem('hoaloCloudPrices', JSON.stringify({
                takePhotoPrice: prices.takePhotoPrice,
                printPrice: prices.printPrice,
                at: Date.now()
            }));
        } catch (e) {}
        window.HOALO_CONFIG = window.HOALO_CONFIG || {};
        window.HOALO_CONFIG.takePhotoPrice = prices.takePhotoPrice;
        window.HOALO_CONFIG.printPrice = prices.printPrice;
    }

    function cachedCloudPrices(fallback) {
        try {
            var raw = localStorage.getItem('hoaloCloudPrices');
            if (!raw) return null;
            var o = JSON.parse(raw);
            if (!o || Date.now() - (parseInt(o.at, 10) || 0) > 7 * 24 * 60 * 60 * 1000) return null;
            return pricePair(o, fallback);
        } catch (e) { return null; }
    }

    /** Doc cau hinh da cache (localStorage / disk mapp / IndexedDB). */
    function loadCachedEssentialConfig() {
        function fromLs() {
            try {
                var raw = localStorage.getItem(CLOUD_CONFIG_LS_KEY);
                if (!raw) return null;
                var o = JSON.parse(raw);
                var cfg = o && (o.config || o);
                return cfg && typeof cfg === 'object' ? pickEssentialConfig(cfg) : null;
            } catch (e) { return null; }
        }
        var ls = fromLs();
        if (ls && Object.keys(ls).length) {
            applyEssentialConfig(ls);
            return Promise.resolve(ls);
        }
        return fetch('/local/cloud-config', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (res) {
                var cfg = res && res.config ? pickEssentialConfig(res.config) : null;
                if (cfg && Object.keys(cfg).length) {
                    try {
                        localStorage.setItem(CLOUD_CONFIG_LS_KEY, JSON.stringify({
                            at: Date.now(),
                            savedAt: res.savedAt || null,
                            config: cfg
                        }));
                    } catch (e) {}
                    applyEssentialConfig(cfg);
                    return cfg;
                }
                return null;
            })
            .catch(function () { return null; })
            .then(function (cfg) {
                if (cfg) return cfg;
                return idbGetAsset(CONFIG_IDB_KEY).then(function (blob) {
                    if (!blob) return null;
                    return blob.text().then(function (t) {
                        var o = JSON.parse(t);
                        var c = pickEssentialConfig(o && (o.config || o));
                        if (c && Object.keys(c).length) {
                            applyEssentialConfig(c);
                            return c;
                        }
                        return null;
                    });
                }).catch(function () { return null; });
            });
    }

    /**
     * Sau khi cache khung xong: luu cau hinh can thiet (gia, timeout, camera, print...)
     * vao localStorage + IndexedDB + disk mapp (web/data/cloud-config.json).
     */
    function cacheEssentialConfigAfterFrames(cloudCfg) {
        var essential = pickEssentialConfig(cloudCfg);
        if (!essential || !Object.keys(essential).length) {
            return Promise.resolve(null);
        }
        applyEssentialConfig(essential);
        var payload = { at: Date.now(), config: essential };
        try {
            localStorage.setItem(CLOUD_CONFIG_LS_KEY, JSON.stringify(payload));
        } catch (e) {}
        var bodyText = JSON.stringify(payload);
        var tasks = [];
        tasks.push(
            idbPutAsset(CONFIG_IDB_KEY, new Blob([bodyText], { type: 'application/json' }))
                .catch(function () {})
        );
        tasks.push(
            fetch('/local/cloud-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: essential })
            }).then(function (r) {
                if (!r.ok) throw new Error('cloud-config HTTP ' + r.status);
                return r.json();
            }).catch(function (err) {
                try { console.warn('[hoalo] cache config disk fail', err && err.message); } catch (e2) {}
                return null;
            })
        );
        return Promise.all(tasks).then(function () { return essential; });
    }

    function readPrices() {
        return fetch('config.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; })
            .then(function (local) {
                local = local || {};
                var localPrices = pricePair(local, { takePhotoPrice: 20000, printPrice: 20000 });
                return loadCachedEssentialConfig().then(function (cached) {
                    var remembered = pricePair(cached || {}, cachedCloudPrices(localPrices) || localPrices);
                    if (!local.deviceId || !local.cloudConfigToken) return remembered;
                    var timed = withTimeout(12000);
                    var list = bases(local);
                    function attempt(i) {
                        if (i >= list.length || (timed.signal && timed.signal.aborted)) return Promise.reject(new Error('sync'));
                        return fetch(apiUrl(list[i], '/api/sync'), {
                            headers: {
                                'X-Device-Id': local.deviceId,
                                'X-Device-Token': local.cloudConfigToken
                            },
                            cache: 'no-store',
                            signal: timed.signal
                        }).then(function (r) {
                            if (!r.ok) throw new Error('http');
                            return r.json();
                        }).then(function (res) {
                            if (!res || !res.config) throw new Error('missing');
                            var p = pricePair(res.config, remembered);
                            rememberCloudPrices(p);
                            // Cap nhat cache cau hinh neu sync online (khong doi boot).
                            cacheEssentialConfigAfterFrames(res.config).catch(function () {});
                            return p;
                        }).catch(function () { return attempt(i + 1); });
                    }
                    return new Promise(function (resolve) {
                        var done = false;
                        function finish(p) {
                            if (done) return;
                            done = true;
                            timed.done();
                            resolve(p);
                        }
                        setTimeout(function () { finish(remembered); }, 13000);
                        attempt(0).then(finish, function () { finish(remembered); });
                    });
                });
            })
            .catch(function () { return { takePhotoPrice: 20000, printPrice: 20000 }; });
    }

    function readPrintQty() {
        var qty = 1;
        try { qty = parseInt(localStorage.getItem('printQty'), 10) || 1; } catch (e) {}
        return qty >= 1 ? qty : 1;
    }

    function orderAmount(qty, prices) {
        qty = parseInt(qty, 10);
        if (!(qty >= 1)) qty = 1;
        prices = prices || {};
        return moneyOr(prices.takePhotoPrice, 0) + (qty - 1) * moneyOr(prices.printPrice, 0);
    }

    window.hoaloGetPrices = readPrices;

    window.hoaloCalcOrderTotal = function (qty, prices) {
        return orderAmount(qty, prices);
    };

    function printSpecFromSources(print, local) {
        local = local || {};
        var paper = String((print && (print.paper_size || print.paperSize)) || local.printPaperSize || local.paper_size || '6x8');
        var four = paper.indexOf('4x6') >= 0;
        var spec = {
            pageW: four ? 1200 : 1800,
            pageH: four ? 1800 : 2400,
            paperSize: four ? '4x6' : '6x8',
            paperWidthInch: four ? 4 : 6,
            paperHeightInch: four ? 6 : 8,
            dpi: parseInt(local.printDpi, 10) > 0 ? parseInt(local.printDpi, 10) : 300
        };
        if (parseInt(local.pageW, 10) >= 100) spec.pageW = parseInt(local.pageW, 10);
        if (parseInt(local.pageH, 10) >= 100) spec.pageH = parseInt(local.pageH, 10);
        if (!print) return spec;
        var pageW = parseInt(print.pageW, 10);
        var pageH = parseInt(print.pageH, 10);
        var wIn = parseFloat(print.paper_width_inch);
        var hIn = parseFloat(print.paper_height_inch);
        var dpi = parseInt(print.print_dpi, 10);
        if (pageW >= 100) spec.pageW = pageW;
        if (pageH >= 100) spec.pageH = pageH;
        if (paper) spec.paperSize = four ? '4x6' : (paper.indexOf('6x8') >= 0 ? '6x8' : paper);
        if (wIn > 0) spec.paperWidthInch = wIn;
        if (hIn > 0) spec.paperHeightInch = hIn;
        if (dpi > 0) spec.dpi = dpi;
        return spec;
    }

    function rememberPrintSpec(spec) {
        if (!spec || !(spec.pageW >= 100)) return;
        try { localStorage.setItem('hoaloPrintSpec', JSON.stringify(spec)); } catch (e) {}
    }

    function rememberedPrintSpec() {
        try {
            var spec = JSON.parse(localStorage.getItem('hoaloPrintSpec') || 'null');
            if (spec && spec.pageW >= 100 && spec.pageH >= 100 && spec.paperSize) return spec;
        } catch (e) {}
        return null;
    }

    window.hoaloGetPrintSpec = function () {
        return fetch('config.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; })
            .then(function (local) {
                local = local || {};
                var localSpec = printSpecFromSources(null, local);
                if (!local.printPaperSize) {
                    var remembered = rememberedPrintSpec();
                    if (remembered) localSpec = remembered;
                }
                if (!local.deviceId || !local.cloudConfigToken) return localSpec;
                var timed = withTimeout(4000);
                var list = bases(local);
                function attempt(i) {
                    if (i >= list.length || (timed.signal && timed.signal.aborted)) return Promise.reject(new Error('sync'));
                    return fetch(list[i] + '/api/sync', {
                        headers: {
                            'X-Device-Id': local.deviceId,
                            'X-Device-Token': local.cloudConfigToken
                        },
                        cache: 'no-store',
                        signal: timed.signal
                    }).then(function (r) {
                        if (!r.ok) throw new Error('http');
                        return r.json();
                    }).then(function (res) {
                        var print = res && res.print;
                        if (!print) throw new Error('missing');
                        var spec = printSpecFromSources(print, local);
                        rememberPrintSpec(spec);
                        return spec;
                    }).catch(function () { return attempt(i + 1); });
                }
                return new Promise(function (resolve) {
                    var done = false;
                    function finish(spec) {
                        if (done) return;
                        done = true;
                        timed.done();
                        resolve(spec);
                    }
                    setTimeout(function () { finish(localSpec); }, 4500);
                    attempt(0).then(finish, function () { finish(localSpec); });
                });
            })
            .catch(function () { return rememberedPrintSpec() || printSpecFromSources(null, null); });
    };

    /**
     * Cache khung + QR Tingee:
     * - Bat may: thu tai lai cloud (toi da 15 phut).
     * - Co mang: cap nhat khung + QR moi.
     * - Qua 15 phut khong mang: giu khung cu, XOA het QR -> bat buoc tien mat.
     * - Trong phien: doc IndexedDB.
     */
    var ASSET_DB = 'hoalo-assets-v1';
    var ASSET_STORE = 'files';
    var ASSET_READY_KEY = 'hoaloAssetsReady-v2';
    var FORCE_CASH_KEY = 'hoaloForceCash';
    // Tong thoi gian boot thu tai khung/QR (truoc khi force cash).
    var BOOT_NET_WAIT_MS = 15 * 60 * 1000;
    // Timeout 1 file khung/QR (file thumb co the ~4MB).
    var FILE_FETCH_MS = 3 * 60 * 1000;
    var SYNC_LIST_MS = 60 * 1000;
    var liveObjectUrls = {};
    var assetsWarmPromise = null;

    function openAssetDb() {
        return new Promise(function (resolve, reject) {
            if (!window.indexedDB) {
                reject(new Error('no-idb'));
                return;
            }
            var req = indexedDB.open(ASSET_DB, 1);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(ASSET_STORE)) {
                    db.createObjectStore(ASSET_STORE);
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('idb')); };
        });
    }

    function idbPutAsset(rel, blob) {
        return openAssetDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(ASSET_STORE, 'readwrite');
                tx.objectStore(ASSET_STORE).put(blob, rel);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    function idbGetAsset(rel) {
        return openAssetDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(ASSET_STORE, 'readonly');
                var req = tx.objectStore(ASSET_STORE).get(rel);
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function idbListKeys() {
        return openAssetDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(ASSET_STORE, 'readonly');
                var req = tx.objectStore(ASSET_STORE).getAllKeys();
                req.onsuccess = function () { resolve(req.result || []); };
                req.onerror = function () { reject(req.error); };
            });
        }).catch(function () { return []; });
    }

    /** Xoa moi key bat dau bang prefix (vd QrCode/). */
    function idbDeleteByPrefix(prefix) {
        prefix = String(prefix || '');
        return idbListKeys().then(function (keys) {
            var doomed = keys.filter(function (k) {
                return String(k).indexOf(prefix) === 0;
            });
            doomed.forEach(function (k) { revokeLiveUrl(String(k)); });
            if (!doomed.length) return;
            return openAssetDb().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx = db.transaction(ASSET_STORE, 'readwrite');
                    var store = tx.objectStore(ASSET_STORE);
                    doomed.forEach(function (k) { store.delete(k); });
                    tx.oncomplete = function () { resolve(); };
                    tx.onerror = function () { reject(tx.error); };
                });
            });
        }).catch(function () {});
    }

    function isForceCash() {
        try { return sessionStorage.getItem(FORCE_CASH_KEY) === '1'; } catch (e) { return false; }
    }

    function setForceCash(on) {
        try {
            if (on) sessionStorage.setItem(FORCE_CASH_KEY, '1');
            else sessionStorage.removeItem(FORCE_CASH_KEY);
        } catch (e) {}
    }

    function revokeLiveUrl(rel) {
        try {
            if (liveObjectUrls[rel]) {
                URL.revokeObjectURL(liveObjectUrls[rel]);
                delete liveObjectUrls[rel];
            }
        } catch (e) {}
    }

    function blobToObjectUrl(rel, blob) {
        revokeLiveUrl(rel);
        var url = URL.createObjectURL(blob);
        liveObjectUrls[rel] = url;
        return url;
    }

    function fetchCloudFile(local, rel) {
        // 1) /local/cloud-file: Python tai giup (tranh Chrome Failed to fetch)
        // 2) /api/sync/file qua cac bases
        var errors = [];
        var fileBases = [''].concat(bases(local));
        // unique keep order
        var seen = {};
        fileBases = fileBases.filter(function (b) {
            var k = b === '' ? '(rel)' : b;
            if (seen[k]) return false;
            seen[k] = true;
            return true;
        });

        function tryLocalPythonCache() {
            var url = '/local/cloud-file?rel=' + encodeURIComponent(rel);
            return fetch(url, { cache: 'no-store' }).then(function (r) {
                if (!r.ok) {
                    return r.text().then(function (t) {
                        throw new Error('local-cloud-file HTTP ' + r.status + ' ' + String(t || '').slice(0, 160));
                    });
                }
                return r.blob();
            }).then(function (blob) {
                if (!blob || blob.size < 32) throw new Error('local-cloud-file empty');
                lastGoodBase = '';
                return blob;
            });
        }

        function attempt(i) {
            if (i >= fileBases.length) {
                return Promise.reject(new Error('file-fail:' + rel + ' | ' + (errors.join(' ; ') || 'het-nguon')));
            }
            var base = fileBases[i];
            var url = apiUrl(base, '/api/sync/file?rel=' + encodeURIComponent(rel));
            var timed = withTimeout(FILE_FETCH_MS);
            var opts = {
                headers: {
                    'X-Device-Id': local.deviceId,
                    'X-Device-Token': local.cloudConfigToken
                },
                cache: 'no-store'
            };
            // Chi gan AbortSignal cho cross-origin (mot so Chrome kiosk loi Abort + Failed to fetch).
            if (base) opts.signal = timed.signal;
            return fetch(url, opts).then(function (r) {
                timed.done();
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.blob();
            }).then(function (blob) {
                if (!blob || blob.size < 32) throw new Error('empty');
                lastGoodBase = base;
                return blob;
            }).catch(function (err) {
                timed.done();
                var msg = (err && err.message) ? String(err.message) : String(err || 'loi');
                if (/abort/i.test(msg)) msg = 'timeout ' + (FILE_FETCH_MS / 1000) + 's';
                errors.push(baseLabel(base) + '=' + msg);
                return attempt(i + 1);
            });
        }

        return tryLocalPythonCache().catch(function (err) {
            var msg = (err && err.message) ? String(err.message) : String(err || 'loi');
            errors.push('/local/cloud-file=' + msg);
            return attempt(0);
        });
    }

    var pendingFileUrls = {};
    function syncFileUrl(local, rel) {
        rel = String(rel || '').replace(/\\/g, '/');
        if (pendingFileUrls[rel]) return pendingFileUrls[rel];
        var pending = syncFileUrlUncached(local, rel);
        pendingFileUrls[rel] = pending;
        function clear() {
            if (pendingFileUrls[rel] === pending) delete pendingFileUrls[rel];
        }
        pending.then(clear, clear);
        return pending;
    }

    function syncFileUrlUncached(local, rel) {
        rel = String(rel || '').replace(/\\/g, '/');
        if (!rel) return Promise.reject(new Error('rel'));
        // Offline/boot timeout: khong dung QR cloud -> bat buoc tien mat.
        if (/^QrCode\//i.test(rel) && isForceCash()) {
            return Promise.reject(new Error('force-cash'));
        }
        if (liveObjectUrls[rel]) return Promise.resolve(liveObjectUrls[rel]);
        // Khung lay ban tren configptb truoc. IDB chi dung khi may dang offline.
        if (/^(tmp2|Templates)\//i.test(rel)) {
            return fetchCloudFile(local, rel).then(function (blob) {
                return idbPutAsset(rel, blob).catch(function () {}).then(function () {
                    return blobToObjectUrl(rel, blob);
                });
            }).catch(function () {
                return idbGetAsset(rel).then(function (cached) {
                    if (cached) return blobToObjectUrl(rel, cached);
                    throw new Error('no-frame');
                });
            });
        }
        return idbGetAsset(rel).then(function (cached) {
            if (cached) return blobToObjectUrl(rel, cached);
            return fetchCloudFile(local, rel).then(function (blob) {
                return idbPutAsset(rel, blob).catch(function () {}).then(function () {
                    return blobToObjectUrl(rel, blob);
                });
            });
        }).catch(function () {
            return fetchCloudFile(local, rel).then(function (blob) {
                return idbPutAsset(rel, blob).catch(function () {}).then(function () {
                    return blobToObjectUrl(rel, blob);
                });
            });
        });
    }

    function listSyncFiles(local) {
        var list = bases(local);
        var errors = [];
        function attempt(i) {
            if (i >= list.length) {
                return Promise.reject(new Error('sync-fail | ' + (errors.join(' ; ') || 'het-nguon')));
            }
            var base = list[i];
            var timed = withTimeout(SYNC_LIST_MS);
            var opts = {
                headers: {
                    'X-Device-Id': local.deviceId,
                    'X-Device-Token': local.cloudConfigToken
                },
                cache: 'no-store'
            };
            if (base) opts.signal = timed.signal;
            return fetch(apiUrl(base, '/api/sync'), opts).then(function (r) {
                timed.done();
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            }).then(function (res) {
                lastGoodBase = base;
                return res;
            }).catch(function (err) {
                timed.done();
                var msg = (err && err.message) ? String(err.message) : String(err || 'loi');
                if (/abort/i.test(msg)) msg = 'timeout ' + (SYNC_LIST_MS / 1000) + 's';
                errors.push(baseLabel(base) + '=' + msg);
                return attempt(i + 1);
            });
        }
        return attempt(0);
    }

    /**
     * Boot chi warm thumb nho nhat (nhieu "thumb" tren cloud ~3-4MB).
     * Full frame / thumb nang: syncFileUrl luc chon-thiet-ke.
     */
    function collectFrameRels(filesMap) {
        var items = [];
        Object.keys(filesMap).forEach(function (rel) {
            var thumb = /^(tmp2|Templates)\/frame_\d+-thumb\.(png|webp)$/i.test(rel);
            var full = /^(tmp2|Templates)\/frame_\d+\.png$/i.test(rel);
            if (!thumb && !full) return;
            var meta = filesMap[rel];
            var size = meta && typeof meta === 'object' ? (parseInt(meta.size, 10) || 0) : 0;
            items.push({ rel: rel, size: size, thumb: thumb });
        });
        if (!items.length) return [];
        // Uu tien thumb; trong do uu tien file nho.
        items.sort(function (a, b) {
            if (a.thumb !== b.thumb) return a.thumb ? -1 : 1;
            if (a.size && b.size && a.size !== b.size) return a.size - b.size;
            return a.rel.localeCompare(b.rel);
        });
        // Chi warm toi da 8 file nho nhat — du hien thi, tranh treo boot.
        var picked = [];
        var seenFrame = {};
        items.forEach(function (it) {
            if (picked.length >= 8) return;
            var m = /^(tmp2|Templates)\/frame_(\d+)/i.exec(it.rel);
            var key = m ? (m[1].toLowerCase() + ':' + m[2]) : it.rel;
            // 1 file / frame (uu tien thumb nho).
            if (seenFrame[key]) return;
            // Bo thumb/full qua nang o buoc boot (>1.5MB) neu da co file nho khac.
            if (it.size > 1500000 && picked.length > 0) return;
            seenFrame[key] = true;
            picked.push(it.rel);
        });
        if (!picked.length && items.length) picked.push(items[0].rel);
        return picked;
    }

    function collectQrRels(local, filesMap, cloudCfg) {
        var src = cloudCfg || local || {};
        var take = parseInt(src.takePhotoPrice, 10);
        if (!(take >= 0)) take = parseInt(local && local.takePhotoPrice, 10);
        if (!(take >= 0)) take = 20000;
        var extra = parseInt(src.printPrice, 10);
        if (!(extra >= 0)) extra = parseInt(local && local.printPrice, 10);
        if (!(extra >= 0)) extra = 20000;
        var max = parseInt((cloudCfg && cloudCfg.printMax) || (local && local.printMax), 10);
        if (!(max >= 1)) max = 10;
        var amounts = {};
        var q;
        for (q = 1; q <= max; q++) amounts[take + (q - 1) * extra] = true;
        var deviceId = String((local && local.deviceId) || '').trim();
        var rels = [];
        var seen = {};
        function add(rel) {
            if (!rel || seen[rel]) return;
            // Chi warm QR co trong manifest (tranh 404).
            if (filesMap && !filesMap[rel]) return;
            seen[rel] = true;
            rels.push(rel);
        }
        Object.keys(amounts).forEach(function (a) {
            var n = parseInt(a, 10) || 0;
            if (n < 1000 || !deviceId) return;
            add('QrCode/' + deviceId + Math.floor(n / 1000) + '.png');
        });
        // Warm moi QR Tingee cua device trong manifest (tranh lech gia local vs cloud).
        if (filesMap && deviceId) {
            var prefix = 'QrCode/' + deviceId;
            Object.keys(filesMap).forEach(function (rel) {
                if (rel.indexOf(prefix) === 0 && /\.png$/i.test(rel)) add(rel);
            });
        }
        return rels;
    }

    var lastBootError = '';

    function explainBootError(raw) {
        var s = String(raw || 'loi-khong-ro');
        var tip = '';
        if (/sync-timeout|sync-fail|sync\b/i.test(s)) {
            tip = 'Khong goi duoc /api/sync (proxy mapp.py hoac configptb).';
        } else if (/frames-fail|file-fail|download-empty/i.test(s)) {
            tip = 'Liet ke duoc file nhung tai khung that bai (HTTP/timeout/file rong).';
        } else if (/empty-manifest/i.test(s)) {
            tip = 'configptb khong co file Templates|tmp2/frame_*.png cho may nay.';
        } else if (/no-frame-cache/i.test(s)) {
            tip = 'Tai xong nhung khong con khung trong bo nho/IndexedDB.';
        } else if (/force-cash/i.test(s)) {
            tip = 'Dang bat che do chi tien mat (QR da xoa).';
        } else if (/HTTP 401|HTTP 403/i.test(s)) {
            tip = 'Sai deviceId / cloudConfigToken trong web\\config.json.';
        } else if (/HTTP 404/i.test(s)) {
            tip = 'URL sync/file khong ton tai (mapp.py cu?).';
        } else if (/timeout/i.test(s)) {
            tip = 'Mang cham / file khung qua nang — da qua thoi gian cho.';
        } else {
            tip = 'Loi tai khung/QR tu configptb.';
        }
        return { tip: tip, detail: s };
    }

    function setBootOverlay(text, detail) {
        var page = ((location.pathname || '').split('/').pop() || '').toLowerCase();
        if (page && page !== 'index.html' && page !== '') return;
        var el = document.getElementById('hoaloBootAssets');
        if (!el) {
            el = document.createElement('div');
            el.id = 'hoaloBootAssets';
            el.setAttribute('style', 'position:fixed;inset:0;z-index:99999;background:rgba(20,16,12,.92);color:#f5efe6;display:flex;align-items:center;justify-content:center;text-align:center;padding:28px;font:600 20px/1.45 Be Vietnam Pro,Segoe UI,sans-serif;');
            var box = document.createElement('div');
            box.id = 'hoaloBootAssetsInner';
            box.setAttribute('style', 'max-width:92vw;');
            el.appendChild(box);
            document.body.appendChild(el);
        }
        var box = document.getElementById('hoaloBootAssetsInner') || el;
        el.style.display = 'flex';
        var main = text || 'Dang tai khung va QR...';
        var extra = detail ? String(detail) : '';
        if (extra) {
            box.innerHTML = '<div style="font-size:22px;margin-bottom:12px">' + escapeHtml(main) + '</div>'
                + '<div style="font:500 14px/1.45 Consolas,monospace;opacity:.95;word-break:break-word;white-space:pre-wrap;background:rgba(0,0,0,.35);padding:12px 14px;border-radius:8px;text-align:left">'
                + escapeHtml(extra) + '</div>';
        } else {
            box.textContent = main;
        }
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function hideBootOverlay() {
        var el = document.getElementById('hoaloBootAssets');
        if (el) el.style.display = 'none';
    }

    function warmDownloadRels(local, rels, onProgress) {
        var i = 0;
        var ok = 0;
        var fails = [];
        function next() {
            if (i >= rels.length) {
                if (!ok && fails.length) {
                    lastBootError = fails.slice(0, 3).join(' || ');
                }
                return Promise.resolve(ok);
            }
            var rel = rels[i++];
            if (onProgress) onProgress(i, rels.length, rel);
            return fetchCloudFile(local, rel).then(function (blob) {
                // Dem OK theo fetch; IDB fail van dung duoc object URL trong phien.
                blobToObjectUrl(rel, blob);
                ok += 1;
                return idbPutAsset(rel, blob).catch(function () {});
            }).catch(function (err) {
                var msg = (err && err.message) ? String(err.message) : ('fail:' + rel);
                fails.push(msg);
                lastBootError = msg;
                try { console.error('[hoalo] tai file loi', rel, msg); } catch (e) {}
            }).then(next);
        }
        return next();
    }

    function markAssetsReady() {
        try { sessionStorage.setItem(ASSET_READY_KEY, '1'); } catch (e) {}
        hideBootOverlay();
    }

    function formatRemain(ms) {
        var s = Math.max(0, Math.ceil(ms / 1000));
        var m = Math.floor(s / 60);
        var r = s % 60;
        return m + ':' + (r < 10 ? '0' : '') + r;
    }

    /** Co mang: cap nhat khung + QR moi (khong xoa khung cu truoc khi tai xong). */
    function downloadFreshAssets(cfg) {
        var baseList = bases(cfg).join(' | ');
        setBootOverlay('Dang goi /api/sync...', 'device=' + (cfg.deviceId || '?') + '\nbases:\n' + baseList);
            return listSyncFiles(cfg).then(function (res) {
            var cloudCfg = (res && res.config) || {};
            if (res && res.print) rememberPrintSpec(printSpecFromSources(res.print, cfg));
            var syncedPrices = pricePair(cloudCfg, pricePair(cfg, { takePhotoPrice: 20000, printPrice: 20000 }));
            rememberCloudPrices(syncedPrices);
            var filesMap = {};
            ((res && res.files) || []).forEach(function (item) {
                if (!item || !item.rel) return;
                filesMap[String(item.rel).replace(/\\/g, '/')] = item;
            });
            var frameRels = collectFrameRels(filesMap);
            var qrRels = collectQrRels(cfg, filesMap, cloudCfg);
            if (!frameRels.length && !qrRels.length) {
                throw new Error('empty-manifest | files=' + Object.keys(filesMap).length + ' | khong co Templates|tmp2/frame_*.png');
            }
            setBootOverlay(
                'Tim thay ' + frameRels.length + ' khung, ' + qrRels.length + ' QR. Gia chup=' + syncedPrices.takePhotoPrice + '. Dang tai...',
                'frames:\n' + frameRels.join('\n') + (qrRels.length ? ('\nqr:\n' + qrRels.join('\n')) : '')
            );
            return warmDownloadRels(cfg, frameRels, function (n, total, rel) {
                setBootOverlay('Tai khung ' + n + '/' + total + '...', rel || '');
            }).then(function (frameOk) {
                if (frameRels.length && !(frameOk > 0)) {
                    throw new Error('frames-fail | ok=0/' + frameRels.length + ' | ' + (lastBootError || 'khong tai duoc file nao'));
                }
                // Sau khi cache khung: luon cache cau hinh can thiet tu configptb.
                setBootOverlay('Da cache khung. Dang luu cau hinh (gia/timeout/camera)...');
                return refreshFrameMetadata(cfg, filesMap).then(function () {
                    return cacheEssentialConfigAfterFrames(cloudCfg);
                }).then(function (savedCfg) {
                    var priceNote = savedCfg
                        ? ('gia=' + savedCfg.takePhotoPrice + '/' + savedCfg.printPrice)
                        : 'config-empty';
                    return idbDeleteByPrefix('QrCode/').then(function () {
                        return warmDownloadRels(cfg, qrRels, function (n, total, rel) {
                            setBootOverlay('Tai QR ' + n + '/' + total + '...', rel || '');
                        }).then(function (qrOk) {
                            setBootOverlay(
                                'Cache xong khung + cau hinh' + (qrOk > 0 ? ' + QR' : ''),
                                priceNote
                            );
                            if (frameRels.length && frameOk > 0) {
                                return pruneStaleFrames(filesMap).then(function () { return frameOk; });
                            }
                            if (qrOk > 0) return qrOk;
                            throw new Error('download-empty | ' + (lastBootError || 'khong tai duoc khung/QR'));
                        });
                    });
                });
            });
        });
    }

    /** Qua 15 phut khong mang: giu khung cu + cau hinh cache, xoa het QR -> bat buoc tien mat. */
    function applyOfflineBootFallback() {
        var info = explainBootError(lastBootError || 'het-thoi-gian-15-phut');
        setBootOverlay(
            'HET THOI GIAN TAI KHUNG/QR',
            info.tip + '\n\nChi tiet: ' + info.detail + '\n\n→ Dung khung + cau hinh cache (neu co), chi thanh toan TIEN MAT.\n→ Kiem tra mapp.py :80 + configptb + mang.'
        );
        return loadCachedEssentialConfig().then(function (cached) {
            return idbDeleteByPrefix('QrCode/').then(function () {
                setForceCash(true);
                var note = cached
                    ? ('Dung gia cache ' + cached.takePhotoPrice + '/' + cached.printPrice)
                    : 'Khong co cau hinh cache';
                setBootOverlay(
                    'HET THOI GIAN TAI KHUNG/QR',
                    info.tip + '\n\n' + note + '\n\nChi tiet: ' + info.detail
                );
                // De ky thuat vien doc loi ~8s roi moi vao booth.
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        markAssetsReady();
                        resolve(false);
                    }, 8000);
                });
            });
        });
    }

    /**
     * Goi 1 lan moi phien Chrome (bat may).
     * Thu mang toi da 15 phut; thanh cong thi tai khung+QR moi;
     * timeout thi khung cu + xoa QR (force cash).
     */
    function hasCachedFrames() {
        var live = Object.keys(liveObjectUrls || {}).some(function (k) {
            return /^(tmp2|Templates)\/frame_\d+/i.test(k);
        });
        if (live) return Promise.resolve(true);
        return idbListKeys().then(function (keys) {
            return (keys || []).some(function (k) {
                return /^(tmp2|Templates)\/frame_\d+/i.test(String(k));
            });
        }).catch(function () { return false; });
    }

    function hasCachedQr() {
        var live = Object.keys(liveObjectUrls || {}).some(function (k) {
            return /^QrCode\//i.test(k);
        });
        if (live) return Promise.resolve(true);
        return idbListKeys().then(function (keys) {
            return (keys || []).some(function (k) { return /^QrCode\//i.test(String(k)); });
        }).catch(function () { return false; });
    }

    function refreshAssetsOnBoot(cfg) {
        if (assetsWarmPromise) return assetsWarmPromise;
        var already = '';
        try { already = sessionStorage.getItem(ASSET_READY_KEY) || ''; } catch (e) {}
        if (already === '1') {
            // Force-cash hoac chua co khung cache: thu sync lai configptb.
            assetsWarmPromise = hasCachedFrames().then(function (hasFrames) {
                if (!isForceCash() && hasFrames) return true;
                try { sessionStorage.removeItem(ASSET_READY_KEY); } catch (e) {}
                assetsWarmPromise = null;
                return refreshAssetsOnBoot(cfg);
            });
            return assetsWarmPromise;
        }
        setForceCash(false);
        var deadline = Date.now() + BOOT_NET_WAIT_MS;
        setBootOverlay('Dang tai khung/QR tu configptb (toi da 15 phut)...');

        function sleep(ms) {
            return new Promise(function (resolve) { setTimeout(resolve, ms); });
        }

        function attemptLoop() {
            var left = deadline - Date.now();
            if (left <= 0) return applyOfflineBootFallback();
            setBootOverlay('Dang tai khung/QR... con ' + formatRemain(left), 'device=' + (cfg.deviceId || '?') + '\nbases:\n' + bases(cfg).join('\n'));
            return downloadFreshAssets(cfg).then(function () {
                return Promise.all([hasCachedFrames(), hasCachedQr()]).then(function (pair) {
                    var hasFrames = pair[0];
                    var hasQr = pair[1];
                    if (!hasFrames) throw new Error('no-frame-cache | live+idb khong co frame_*.png');
                    // Chi bat force-cash khi offline timeout. Co mang: van cho phep tai QR luc thanh toan.
                    setForceCash(false);
                    setBootOverlay(hasQr ? 'Tai xong khung + QR' : 'Tai xong khung (QR se tai luc thanh toan)');
                    markAssetsReady();
                    return hasQr;
                });
            }).catch(function (err) {
                left = deadline - Date.now();
                var why = (err && err.message) ? String(err.message) : 'loi';
                lastBootError = why;
                try { console.error('[hoalo] boot assets fail', why); } catch (e) {}
                if (left <= 0) return applyOfflineBootFallback();
                var info = explainBootError(why);
                setBootOverlay(
                    'LOI TAI KHUNG/QR — thu lai... con ' + formatRemain(left),
                    info.tip + '\n\nChi tiet:\n' + info.detail
                );
                return sleep(Math.min(4000, left)).then(attemptLoop);
            });
        }

        assetsWarmPromise = attemptLoop();
        return assetsWarmPromise;
    }

    window.hoaloRefreshAssetsOnBoot = refreshAssetsOnBoot;
    window.hoaloWhenAssetsReady = function () {
        return assetsWarmPromise || Promise.resolve(true);
    };
    window.hoaloIsForceCash = isForceCash;

    /** Meta JSON frame_N-thumb.json: so shot + preview. Doc dong bo tu store truoc. */
    // Khung full (Templates) toa do theo he 1800x2400, khung small (tmp2) theo he
    // 1200x1800. Gan san frameW/frameH vao meta de cac man chia dung he toa do.
    function withFrameDims(meta, jsonRel) {
        if (!meta || typeof meta !== 'object') return meta;
        if (!meta.frameW || !meta.frameH) {
            var rel = String(jsonRel || meta.frame || '');
            if (/^tmp2\//i.test(rel)) { meta.frameW = 1200; meta.frameH = 1800; }
            else { meta.frameW = 1800; meta.frameH = 2400; }
        }
        return meta;
    }
    function storeFrameMeta(jsonRel, deviceId, meta) {
        if (!meta || typeof meta !== 'object') return meta;
        withFrameDims(meta, jsonRel);
        try {
            var text = JSON.stringify(meta);
            try { sessionStorage.setItem('hoaloFrameMetaJson:' + jsonRel, text); } catch (e) {}
            if (deviceId) {
                try { localStorage.setItem('hoaloFrameJson:' + deviceId + ':' + jsonRel, text); } catch (e2) {}
            }
        } catch (e3) {}
        return meta;
    }

    function readStoredFrameMeta(jsonRel, deviceId) {
        try {
            var raw = sessionStorage.getItem('hoaloFrameMetaJson:' + jsonRel);
            if (raw) {
                var m0 = JSON.parse(raw);
                if (m0 && typeof m0 === 'object') return m0;
            }
        } catch (e) {}
        try {
            if (deviceId) {
                var direct = localStorage.getItem('hoaloFrameJson:' + deviceId + ':' + jsonRel);
                if (direct) {
                    var m1 = JSON.parse(direct);
                    if (m1 && typeof m1 === 'object') return m1;
                }
            }
            for (var k = 0; k < localStorage.length; k++) {
                var key = localStorage.key(k);
                if (key && key.indexOf('hoaloFrameJson:') === 0 &&
                    key.slice(-(jsonRel.length + 1)) === ':' + jsonRel) {
                    var rawL = localStorage.getItem(key);
                    if (rawL) {
                        var m2 = JSON.parse(rawL);
                        if (m2 && typeof m2 === 'object') return m2;
                    }
                }
            }
        } catch (e2) {}
        return null;
    }

    function metaShots(meta) {
        if (meta && meta.cameraRects && meta.cameraRects.length) return meta.cameraRects.length;
        if (meta && meta.cameraRect) return 1;
        return 3;
    }

    function fetchFrameMetaNetwork(local, jsonRel) {
        // Go through the sync proxy, bypassing Python's persistent disk cache.
            var list = bases(local);
            function attempt(i) {
                if (i >= list.length) return Promise.reject(new Error('meta-fail:' + jsonRel));
                var timed = withTimeout(FILE_FETCH_MS);
                var opts = { headers: { 'X-Device-Id': local.deviceId, 'X-Device-Token': local.cloudConfigToken }, cache: 'no-store' };
                if (list[i]) opts.signal = timed.signal;
                return fetch(apiUrl(list[i], '/api/sync/file?rel=' + encodeURIComponent(jsonRel)), opts).then(function (r) {
                    timed.done();
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                }).catch(function () { timed.done(); return attempt(i + 1); });
            }
            return attempt(0);
    }

    // Refresh once at boot, preserving cached metadata if the network fails.
    function refreshFrameMetadata(local, filesMap) {
        var rels = Object.keys(filesMap).filter(function (rel) {
            return /^(tmp2|Templates)\/frame_\d+-thumb\.json$/i.test(rel);
        });
        return rels.reduce(function (pending, rel) {
            return pending.then(function () {
                return fetchFrameMetaNetwork(local, rel).then(function (meta) {
                    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('bad-meta');
                    storeFrameMeta(rel, String(local.deviceId || '').trim(), meta);
                    return idbPutAsset(rel, new Blob([JSON.stringify(meta)], { type: 'application/json' })).catch(function () {});
                }).catch(function (err) {
                    console.warn('[hoalo] metadata refresh failed; keeping cache', rel, err);
                });
            });
        }, Promise.resolve());
    }

    /** Cache-first: store dong bo -> IndexedDB -> mang (luu lai 3 noi). */
    function getFrameMeta(local, jsonRel) {
        local = local || {};
        var deviceId = String(local.deviceId || '').trim();
        var stored = readStoredFrameMeta(jsonRel, deviceId);
        if (stored) return Promise.resolve(withFrameDims(stored, jsonRel));
        return idbGetAsset(jsonRel).then(function (blob) {
            if (!blob) throw new Error('no-idb');
            return blob.text();
        }).then(function (t) {
            var meta = JSON.parse(t);
            if (!meta || typeof meta !== 'object') throw new Error('bad-idb');
            return storeFrameMeta(jsonRel, deviceId, withFrameDims(meta, jsonRel));
        }).catch(function () {
            return fetchFrameMetaNetwork(local, jsonRel).then(function (meta) {
                if (!meta || typeof meta !== 'object') throw new Error('bad-meta');
                try { idbPutAsset(jsonRel, new Blob([JSON.stringify(meta)], { type: 'application/json' })).catch(function () {}); } catch (e) {}
                return storeFrameMeta(jsonRel, deviceId, meta);
            }).catch(function () { return null; });
        });
    }

    /** Bo khung cu trong IndexedDB khi configptb da xoa hoac doi file. */
    function pruneStaleFrames(filesMap) {
        return idbListKeys().then(function (keys) {
            var doomed = [];
            var checks = [];
            keys.forEach(function (k) {
                var rel = String(k).replace(/\\/g, '/');
                if (!/^(tmp2|Templates)\//i.test(rel)) return;
                var meta = filesMap[rel];
                if (!meta) {
                    doomed.push(rel);
                    return;
                }
                var expect = parseInt(meta.size, 10) || 0;
                if (!expect) return;
                checks.push(idbGetAsset(rel).then(function (blob) {
                    if (blob && blob.size && blob.size !== expect) doomed.push(rel);
                }).catch(function () {}));
            });
            return Promise.all(checks).then(function () {
                doomed.forEach(function (rel) { revokeLiveUrl(rel); });
                if (!doomed.length) return;
                return openAssetDb().then(function (db) {
                    return new Promise(function (resolve, reject) {
                        var tx = db.transaction(ASSET_STORE, 'readwrite');
                        var store = tx.objectStore(ASSET_STORE);
                        doomed.forEach(function (rel) { store.delete(rel); });
                        tx.oncomplete = function () { resolve(); };
                        tx.onerror = function () { reject(tx.error); };
                    });
                });
            });
        }).catch(function () {});
    }

    function framesFromKeyMap(local, folder, files) {
        var found = [];
        var seenN = {};
        Object.keys(files).forEach(function (rel) {
            var m = new RegExp('^' + folder + '/frame_(\\d+)-thumb\\.(png|webp)$', 'i').exec(rel);
            if (m) {
                var tn = parseInt(m[1], 10);
                if (!seenN[tn]) { seenN[tn] = true; found.push({ n: tn, rel: rel }); }
            }
        });
        // Frame chi co frame_N.png (khong thumb): them tung frame thieu, khong doi fallback toan cuc.
        if (true) {
            Object.keys(files).forEach(function (rel) {
                var m = new RegExp('^' + folder + '/frame_(\\d+)\\.png$', 'i').exec(rel);
                if (m) {
                    var n = parseInt(m[1], 10);
                    if (!seenN[n]) { seenN[n] = true; found.push({ n: n, rel: rel }); }
                }
            });
        }
        found.sort(function (a, b) { return a.n - b.n; });
        return Promise.all(found.map(function (item) {
            var png = folder + '/frame_' + item.n + '.png';
            var thumb = folder + '/frame_' + item.n + '-thumb.png';
            var webp = folder + '/frame_' + item.n + '-thumb.webp';
            var jsonRel = folder + '/frame_' + item.n + '-thumb.json';
            var frameRel = files[png] ? png : item.rel;
            // Avatar ưu tiên webp nhẹ (~200KB) thay vì thumb.png (3-4MB).
            var thumbRel = files[webp] ? webp : (files[thumb] ? thumb : item.rel);
            var previewRel = frameRel;
            var base = {
                id: folder + '/frame_' + item.n,
                jsonRel: jsonRel,
                frameRel: frameRel,
                shots: 3,
                loadThumb: function () {
                    return syncFileUrl(local, thumbRel);
                },
                loadPreview: function () {
                    return files[previewRel]
                        ? syncFileUrl(local, previewRel) : Promise.resolve(previewRel);
                }
            };
            if (!files[jsonRel]) return base;
            return getFrameMeta(local, jsonRel).then(function (meta) {
                if (!meta) return base;
                base.shots = metaShots(meta);
                if (meta.preview) previewRel = String(meta.preview).replace(/\\/g, '/');
                return base;
            }).catch(function () { return base; });
        })).then(function (items) {
            return items.filter(Boolean);
        });
    }

    /** Offline: liet ke khung da cache trong IndexedDB. */
    function framesFromIdb(local, folder) {
        return idbListKeys().then(function (keys) {
            var files = {};
            keys.forEach(function (k) {
                var rel = String(k).replace(/\\/g, '/');
                if (new RegExp('^' + folder + '/frame_', 'i').test(rel)) files[rel] = true;
            });
            return framesFromKeyMap(local, folder, files);
        }).catch(function () { return []; });
    }

    window.hoaloListSizeFrames = function (size, onUpdate) {
        var folder = size === 'small' ? 'tmp2' : 'Templates';
        return fetch('config.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; })
            .then(function (local) {
                local = local || {};
                if (!local.deviceId || !local.cloudConfigToken) return framesFromIdb(local, folder);
                function fetchNetwork() {
                    var timed = withTimeout(SYNC_LIST_MS);
                    var list = bases(local);
                    function attempt(i) {
                        if (i >= list.length || (timed.signal && timed.signal.aborted)) return Promise.reject(new Error('sync'));
                        return fetch(list[i] + '/api/sync', {
                            headers: {
                                'X-Device-Id': local.deviceId,
                                'X-Device-Token': local.cloudConfigToken
                            },
                            cache: 'no-store',
                            signal: timed.signal
                        }).then(function (r) {
                            if (!r.ok) throw new Error('http');
                            return r.json();
                        }).catch(function () { return attempt(i + 1); });
                    }
                    return attempt(0).then(function (res) {
                        timed.done();
                        var files = {};
                        ((res && res.files) || []).forEach(function (item) {
                            if (item && item.rel) files[String(item.rel).replace(/\\/g, '/')] = item;
                        });
                        return pruneStaleFrames(files).then(function () {
                            return framesFromKeyMap(local, folder, files);
                        });
                    }, function (err) {
                        timed.done();
                        throw err;
                    });
                }
                // Network-first co gioi han khi co onUpdate: doi mang toi da
                // NET_FIRST_MS de tranh hien khung cu roi nhay hinh.
                // Qua han thi tra cache ngay, mang ve sau thi goi onUpdate.
                if (typeof onUpdate === 'function') {
                    var NET_FIRST_MS = 5000;
                    var freshPromise = fetchNetwork();
                    freshPromise.catch(function () {});
                    function sigOf(list) {
                        return (list || []).map(function (x) {
                            return x.id + '#' + (x.frameRel || '') + '#' + (x.shots || '');
                        }).join('|');
                    }
                    return Promise.race([
                        freshPromise.then(function (f) { return { fresh: f }; },
                            function () { return { failed: true }; }),
                        new Promise(function (res) {
                            setTimeout(function () { res({ timeout: true }); }, NET_FIRST_MS);
                        })
                    ]).then(function (race) {
                        if (race && race.fresh) return race.fresh;
                        return framesFromIdb(local, folder).then(function (cached) {
                            freshPromise.then(function (fresh) {
                                try {
                                    var fs = sigOf(fresh);
                                    if (fs && fs !== sigOf(cached)) onUpdate(fresh);
                                } catch (e) {}
                            }).catch(function () {});
                            if (cached && cached.length) return cached;
                            return freshPromise.catch(function () { return cached || []; });
                        });
                    });
                }
                return fetchNetwork().catch(function () {
                    // Het mang / boot timeout: dung khung cu tu IndexedDB.
                    return framesFromIdb(local, folder);
                });
            })
            .catch(function () { return []; });
    };

    /** So shot cua khung da chon (frameShots -> map design cu -> 3). */
    window.hoaloGetSelectedShots = function () {
        var n = 0;
        try { n = parseInt(localStorage.getItem('frameShots'), 10); } catch (e) {}
        if (n > 0) return n;
        var design = '';
        try { design = String(localStorage.getItem('frameDesign') || ''); } catch (e2) {}
        var m = /(\d+)$/.exec(design);
        if (m) {
            var map = { '1': 3, '2': 4, '3': 5, '4': 6, '5': 7 };
            if (map[m[1]]) return map[m[1]];
        }
        return 3;
    };

    /** Meta JSON cua frame da chon (vi tri lo anh cameraRects...). null neu khong co. */
    window.hoaloGetSelectedFrameMeta = function () {
        var frameRel = '';
        var design = '';
        try {
            frameRel = String(localStorage.getItem('frameFile') || '').trim();
            design = String(localStorage.getItem('frameDesign') || '').trim();
        } catch (e) {}
        var src = frameRel || design;
        var m = /(Templates|tmp2)\/frame_(\d+)/i.exec(src);
        if (!m) return Promise.resolve(null);
        var jsonRel = m[1] + '/frame_' + parseInt(m[2], 10) + '-thumb.json';
        return fetch('config.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; })
            .then(function (local) {
                local = local || {};
                return getFrameMeta(local, jsonRel).then(function (meta) {
                    if (meta) return withFrameDims(meta, jsonRel);
                    var stored = readStoredFrameMeta(jsonRel, String(local.deviceId || '').trim());
                    return withFrameDims(stored, jsonRel) || null;
                });
            })
            .catch(function () { return null; });
    };

    /** Ảnh khung PNG đã chọn (đặt trên ảnh khi ghép/in). null = khung HTML mặc định. */
    window.hoaloGetSelectedFrameOverlay = function () {
        var frameRel = '';
        var design = '';
        try {
            frameRel = String(localStorage.getItem('frameFile') || '').trim();
            design = String(localStorage.getItem('frameDesign') || '').trim();
        } catch (e) {}

        function localStatic() {
            var n = 0;
            var m = /frame_(\d+)/i.exec(design) || /^(\d+)$/.exec(design);
            if (m) n = parseInt(m[1], 10);
            if (n >= 2 && n <= 5) {
                return { url: 'images/Frame-' + n + '-thumb.png', frameRel: 'images/Frame-' + n + '-thumb.png', design: design };
            }
            if (frameRel && /^images\//i.test(frameRel)) {
                return { url: frameRel, frameRel: frameRel, design: design };
            }
            return null;
        }

        if (frameRel && /^images\//i.test(frameRel)) {
            return Promise.resolve({ url: frameRel, frameRel: frameRel, design: design });
        }
        if (!frameRel) {
            return Promise.resolve(localStatic());
        }

        return fetch('config.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; })
            .then(function (local) {
                local = local || {};
                if (!local.deviceId || !local.cloudConfigToken) return localStatic();
                return syncFileUrl(local, frameRel).then(function (url) {
                    return { url: url, frameRel: frameRel, design: design };
                }).catch(function () { return localStatic(); });
            });
    };

    window.hoaloApplyFrameOverlay = function (paperEl) {
        if (!paperEl) return Promise.resolve(null);
        var old = paperEl.querySelector('.paper-frame-overlay');
        if (old) old.remove();
        return (window.hoaloGetSelectedFrameOverlay ? window.hoaloGetSelectedFrameOverlay() : Promise.resolve(null))
            .then(function (frame) {
                if (!frame || !frame.url) {
                    paperEl.classList.remove('has-frame-overlay');
                    return null;
                }
                var img = document.createElement('img');
                img.className = 'paper-frame-overlay';
                img.alt = '';
                img.draggable = false;
                img.src = frame.url;
                paperEl.appendChild(img);
                paperEl.classList.add('has-frame-overlay');
                return frame;
            })
            .catch(function () {
                paperEl.classList.remove('has-frame-overlay');
                return null;
            });
    };

    window.hoaloGetPayQr = function (amount) {
        var n = parseInt(amount, 10) || 0;
        if (n < 1000) return Promise.resolve(null);
        // Boot timeout khong mang: QR da xoa -> bat buoc tien mat.
        if (isForceCash()) return Promise.resolve(null);
        var thousands = Math.floor(n / 1000);
        return fetch('config.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; })
            .then(function (local) {
                local = local || {};
                if (!local.deviceId || !local.cloudConfigToken) return null;
                var rel = 'QrCode/' + local.deviceId + thousands + '.png';
                return syncFileUrl(local, rel).then(function (url) {
                    return url || null;
                }).catch(function () { return null; });
            })
            .catch(function () { return null; });
    };

    window.hoaloPrepareOrderTotal = function () {
        return readPrices().then(function (prices) {
            try {
                if (sessionStorage.getItem('hoaloPhoneSend') === '1') {
                    prices = { takePhotoPrice: 50000, printPrice: 20000 };
                }
            } catch (ePhone) {}
            var n = orderAmount(readPrintQty(), prices);
            try { localStorage.setItem('orderTotal', String(n)); } catch (e) {}
            window.HOALO_CONFIG = window.HOALO_CONFIG || {};
            window.HOALO_CONFIG.takePhotoPrice = prices.takePhotoPrice;
            window.HOALO_CONFIG.printPrice = prices.printPrice;
            return n;
        });
    };

    window.hoaloGoHome = function () {
        try {
            if (sessionStorage.getItem('payMethod') === 'free') return;
        } catch (e) {}
        var leave = function () {
            try {
                ['photos', 'layout', 'layoutFit', 'payMethod', 'transaction', 'hoaloOrderId', 'hoaloQrUrl', 'hoaloPrinted', 'hoaloPhoneSend', 'hoaloPhoneTicket', PAY_SEEN_KEY].forEach(function (k) { sessionStorage.removeItem(k); });
                ['frameSize', 'frameDesign', 'frameFile', 'printQty', 'orderTotal'].forEach(function (k) { localStorage.removeItem(k); });
            } catch (e2) {}
            location.replace('index.html');
        };
        // Hết giờ / bỏ phiên: xóa quỹ để khách sau không hưởng tiền khách trước.
        settleAccumulated().then(leave, leave);
    };

    function armTimeout(getSeconds, opts) {
        opts = opts || {};
        var stopped = false;
        var iv = null;
        var seconds = 60;
        var ready = false;
        function notify(left) {
            if (opts.onTick) { try { opts.onTick(left); } catch (e) {} }
        }
        function run() {
            if (stopped || !ready) return;
            if (iv) clearInterval(iv);
            var left = seconds;
            notify(left);
            iv = setInterval(function () {
                if (stopped) { clearInterval(iv); return; }
                left--;
                if (left <= 0) {
                    stopped = true;
                    clearInterval(iv);
                    notify(0);
                    window.hoaloGoHome();
                    return;
                }
                notify(left);
            }, 1000);
        }
        getSeconds().then(function (n) {
            seconds = clampTimeout(n);
            ready = true;
            if (!stopped) run();
        }).catch(function () { ready = true; if (!stopped) run(); });
        return {
            cancel: function () { stopped = true; if (iv) clearInterval(iv); },
            restart: function () { if (!stopped) run(); }
        };
    }

    window.hoaloArmPaymentTimeout = function (opts) {
        return armTimeout(window.hoaloGetPaymentTimeout, opts);
    };

    window.hoaloArmCaptureTimeout = function (opts) {
        return armTimeout(window.hoaloGetCaptureTimeout, opts);
    };

    window.hoaloArmLayoutTimeout = function (opts) {
        return armTimeout(window.hoaloGetLayoutTimeout, opts);
    };

    function settleAccumulated() {
        return fetch('/api/v1/payments/settle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            cache: 'no-store'
        }).catch(function () {});
    }

    window.hoaloSettlePayments = settleAccumulated;

    (function resetMoneyOnPrintScreen() {
        var page = ((location.pathname || '').split('/').pop() || '').toLowerCase();
        if (page === 'hoan-thanh.html') settleAccumulated();
    })();

    /** Một lần in: tiền mặt/QR đã có giao dịch, hoặc suất chụp miễn phí. */
    window.hoaloClaimPrint = function () {
        var method = '';
        var tx = '';
        try {
            method = sessionStorage.getItem('payMethod') || '';
            tx = sessionStorage.getItem('transaction') || '';
        } catch (e) { return false; }
        var paid = (method === 'cash' || method === 'qr') && !!tx;
        var free = method === 'free';
        if (!paid && !free) return false;
        try {
            sessionStorage.removeItem('payMethod');
            sessionStorage.removeItem('transaction');
            sessionStorage.removeItem(PAY_SEEN_KEY);
        } catch (e2) {}
        return true;
    };

    window.hoaloWatchPayment = function (total, hooks) {
        hooks = hooks || {};
        var stopped = false;
        var done = false;
        var inflight = false;
        var need = parseInt(total, 10) || 0;
        function freeNow() {
            try { return sessionStorage.getItem('payMethod') === 'free'; } catch (e) { return false; }
        }
        function tick() {
            if (stopped || done || inflight || freeNow()) return;
            inflight = true;
            fetch('/api/v1/payments', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    inflight = false;
                    if (stopped || done || freeNow()) return;
                    var n = parseInt(data && data.tientichluy, 10) || 0;
                    if (n > 0) {
                        try { sessionStorage.setItem(PAY_SEEN_KEY, '1'); } catch (e) {}
                    }
                    if (hooks.onUpdate) { try { hooks.onUpdate(n); } catch (e2) {} }
                    if (n >= need) {
                        done = true;
                        if (!stopped && hooks.onEnough) hooks.onEnough(n);
                    }
                })
                .catch(function () { inflight = false; });
        }
        tick();
        var iv = setInterval(tick, 1000);
        return { cancel: function () { stopped = true; clearInterval(iv); } };
    };

    // Màn chờ: tiền nhét vào rồi bỏ đi sẽ bị xóa sau đúng hạn thanh toán.
    // Bấm bắt đầu thì trang đổi, timer mất, tiền vẫn giữ cho phiên đang chụp.
    (function watchIdleTill() {
        var page = ((location.pathname || '').split('/').pop() || '').toLowerCase();
        if (page !== 'index.html' && page !== '') return;
        var timer = null;
        var last = -1;
        function tick() {
            fetch('/api/v1/payments', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    var n = parseInt(data && data.tientichluy, 10) || 0;
                    if (n > 0 && n !== last) {
                        last = n;
                        if (timer) clearTimeout(timer);
                        var wait = window.hoaloGetPaymentTimeout ? window.hoaloGetPaymentTimeout() : Promise.resolve(60);
                        wait.then(function (sec) {
                            sec = parseInt(sec, 10);
                            if (!(sec >= 5)) sec = 60;
                            timer = setTimeout(function () {
                                timer = null;
                                last = 0;
                                settleAccumulated();
                            }, sec * 1000);
                        }).catch(function () {});
                    } else if (n <= 0) {
                        last = 0;
                        if (timer) { clearTimeout(timer); timer = null; }
                    }
                })
                .catch(function () {});
        }
        tick();
        setInterval(tick, 2000);
    })();

    fetch('config.json', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('config HTTP ' + r.status); return r.json(); })
        .then(function (cfg) {
            window.HOALO_CONFIG = cfg || {};
            if (!cfg || !cfg.deviceId || !cfg.cloudConfigToken) {
                setBootOverlay(
                    'LOI CONFIG WEB',
                    'Thieu deviceId hoac cloudConfigToken trong web\\config.json.\nKhong the tai khung/QR tu configptb.'
                );
                try { sessionStorage.setItem(ASSET_READY_KEY, '1'); } catch (e) {}
                return;
            }
            // Nap cau hinh cache (neu co) truoc boot — gia/timeout hien dung ngay.
            return loadCachedEssentialConfig().then(function () {
                // Bat may: thu mang <=15 phut tai khung+QR; sau khung luon cache cau hinh.
                return refreshAssetsOnBoot(cfg).finally(function () {
                    poll(cfg);
                    setInterval(function () { poll(cfg); }, POLL_MS);
                });
            });
        })
        .catch(function (err) {
            setBootOverlay(
                'LOI DOC config.json',
                ((err && err.message) || String(err || 'unknown')) + '\nKiem tra file HoaLoBooth\\web\\config.json'
            );
            try { sessionStorage.setItem(ASSET_READY_KEY, '1'); } catch (e) {}
        });
})();

/* Ghi quá trình chụp (nhẹ) rồi ghép vào từng lỗ khung. Không đụng HTML/CSS. (đã tắt).
(function () {
    var page = ((location.pathname || '').split('/').pop() || '').toLowerCase();
    var READY_KEY = 'hoaloClipReady';
    var DB_NAME = 'hoalo-shot-clips';
    var STORE = 'clips';
    var CLIP_FPS_MS = 125;
    var CLIP_LONG = 416;
    var OUT_LONG = 640;

    function pageName() {
        return ((location.pathname || '').split('/').pop() || '').toLowerCase();
    }

    function mimeType() {
        if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return '';
        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) return 'video/webm;codecs=vp8';
        if (MediaRecorder.isTypeSupported('video/webm')) return 'video/webm';
        return '';
    }

    function openDb() {
        return new Promise(function (resolve, reject) {
            if (!window.indexedDB) { reject(new Error('idb')); return; }
            var req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function clearClips() {
        return openDb().then(function (db) {
            return new Promise(function (resolve) {
                var tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).clear();
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { resolve(); };
            });
        }).catch(function () {});
    }

    function putClip(index, blob, ms) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put({ blob: blob, ms: ms }, index);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        }).catch(function () {});
    }

    function allClips() {
        return openDb().then(function (db) {
            return new Promise(function (resolve) {
                var tx = db.transaction(STORE, 'readonly');
                var out = [];
                var req = tx.objectStore(STORE).openCursor();
                req.onsuccess = function () {
                    var cur = req.result;
                    if (!cur) {
                        out.sort(function (a, b) { return a.index - b.index; });
                        resolve(out);
                        return;
                    }
                    var index = +cur.key;
                    if (index >= 0 && cur.value && cur.value.blob) {
                        out.push({ index: index, blob: cur.value.blob, ms: cur.value.ms || 0 });
                    }
                    cur.continue();
                };
                req.onerror = function () { resolve(out); };
            });
        }).catch(function () { return []; });
    }

    function holesOf(meta) {
        var src = [];
        if (meta && meta.cameraRects && meta.cameraRects.length) src = meta.cameraRects;
        else if (meta && meta.cameraRect) src = [meta.cameraRect];
        var out = [];
        for (var i = 0; i < src.length; i++) {
            var w = src[i] && +src[i].w;
            var h = src[i] && +src[i].h;
            var x = src[i] && +src[i].x;
            var y = src[i] && +src[i].y;
            if (w > 1 && h > 1) out.push({ x: x || 0, y: y || 0, w: w, h: h });
        }
        return out;
    }

    function loadImage(src) {
        return new Promise(function (resolve) {
            if (!src) { resolve(null); return; }
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { resolve(null); };
            img.src = src;
        });
    }

    function drawCover(ctx, src, dx, dy, dw, dh) {
        var sw = src.videoWidth || src.naturalWidth || 0;
        var sh = src.videoHeight || src.naturalHeight || 0;
        if ((!sw || !sh) && src.getContext) {
            sw = src.width;
            sh = src.height;
        }
        if (!sw || !sh || dw < 2 || dh < 2) return;
        var scale = Math.max(dw / sw, dh / sh);
        var w = sw * scale;
        var h = sh * scale;
        ctx.drawImage(src, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
    }

    if (page === 'index.html' || page === '') {
        try { sessionStorage.removeItem(READY_KEY); } catch (e0) {}
        try { sessionStorage.removeItem('hoaloPhoneSend'); } catch (ePhone) {}
        clearClips();
        return;
    }

    if (page === 'gan-anh.html') {
        setTimeout(composeIfReady, 800);
        return;
    }

    if (page !== 'chup-hinh.html') return;
    if (!mimeType()) return;

    var rec = null;
    var chunks = [];
    var recordingIndex = -1;
    var recStarted = 0;
    var flushP = null;
    var drawTimer = null;
    var capTimer = null;
    var canvas = null;
    var ctx = null;
    var seenBg = [];

    function stopDraw() {
        if (drawTimer) { clearTimeout(drawTimer); drawTimer = null; }
        if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    }

    function paintLive() {
        var video = document.getElementById('video');
        var area = document.getElementById('shotArea');
        if (!ctx || !canvas || !video || !area) return;
        var sw = video.videoWidth;
        var sh = video.videoHeight;
        var box = area.getBoundingClientRect();
        if (!sw || !sh || box.width < 2 || box.height < 2) return;
        var scale = Math.max(box.width / sw, box.height / sh);
        var offX = (box.width - sw * scale) / 2;
        var offY = (box.height - sh * scale) / 2;
        var cx = -offX / scale;
        var cy = -offY / scale;
        var cw = box.width / scale;
        var ch = box.height / scale;
        if (cx < 0) { cw += cx; cx = 0; }
        if (cy < 0) { ch += cy; cy = 0; }
        if (cx + cw > sw) cw = sw - cx;
        if (cy + ch > sh) ch = sh - cy;
        if (cw < 2 || ch < 2) return;
        cx = sw - cx - cw;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height);
        ctx.restore();
    }

    function loopDraw() {
        if (!rec) return;
        try { paintLive(); } catch (e) {}
        if (!rec) return;
        drawTimer = setTimeout(loopDraw, CLIP_FPS_MS);
    }

    function stopCurrent(save) {
        if (save) {
            try { sessionStorage.setItem(READY_KEY, '1'); } catch (eFlag) {}
        }
        if (flushP) return flushP;
        if (!rec || rec.state === 'inactive') return Promise.resolve();
        var wait = 450 - (Date.now() - recStarted);
        if (wait > 0) {
            flushP = new Promise(function (resolve) {
                setTimeout(function () {
                    flushP = null;
                    stopCurrent(save).then(resolve, resolve);
                }, wait);
            });
            return flushP;
        }
        var index = recordingIndex;
        var started = recStarted;
        var current = rec;
        stopDraw();
        flushP = new Promise(function (resolve) {
            try {
                current.onstop = function () {
                    var blob = new Blob(chunks, { type: current.mimeType || 'video/webm' });
                    chunks = [];
                    if (rec === current) rec = null;
                    recordingIndex = -1;
                    flushP = null;
                    try {
                        if (current.stream) current.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e2) {} });
                    } catch (e3) {}
                    if (save && blob.size > 400) putClip(index, blob, Math.max(300, Date.now() - started)).then(resolve, resolve);
                    else resolve();
                };
                try { if (current.requestData) current.requestData(); } catch (eReq) {}
                current.stop();
            } catch (e) {
                if (rec === current) rec = null;
                recordingIndex = -1;
                flushP = null;
                resolve();
            }
        });
        return flushP;
    }

    function sizeCanvas(area) {
        var box = area.getBoundingClientRect();
        var ratio = box.width / box.height;
        if (!(ratio > 0.05)) ratio = 16 / 9;
        var dw;
        var dh;
        if (ratio >= 1) {
            dw = CLIP_LONG;
            dh = Math.max(2, Math.round(CLIP_LONG / ratio));
        } else {
            dh = CLIP_LONG;
            dw = Math.max(2, Math.round(CLIP_LONG * ratio));
        }
        canvas = document.createElement('canvas');
        canvas.width = dw;
        canvas.height = dh;
        ctx = canvas.getContext('2d', { alpha: false });
    }

    function startClip(index) {
        var type = mimeType();
        var video = document.getElementById('video');
        var area = document.getElementById('shotArea');
        if (!type || !video || !area || !video.videoWidth || rec) return;
        try {
            sizeCanvas(area);
            if (!ctx) return;
            paintLive();
            var stream = canvas.captureStream(8);
            chunks = [];
            rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 220000 });
            recordingIndex = index;
            recStarted = Date.now();
            rec.ondataavailable = function (ev) {
                if (ev.data && ev.data.size) chunks.push(ev.data);
            };
            rec.start(1000);
            loopDraw();
            capTimer = setTimeout(function () { stopCurrent(true); }, 20000);
        } catch (e) {
            rec = null;
            recordingIndex = -1;
            stopDraw();
        }
    }

    function activeEmpty() {
        var slots = document.querySelectorAll('#slots .slot');
        for (var i = 0; i < slots.length; i++) {
            if (!slots[i].classList.contains('active')) continue;
            var bg = slots[i].style.backgroundImage || '';
            if (bg.indexOf('url(') < 0) return i;
        }
        return -1;
    }

    function onFilled(index) {
        if (recordingIndex !== index) return;
        stopCurrent(true).then(function () {
            var next = activeEmpty();
            if (next >= 0) startClip(next);
        });
    }

    function watchSlots() {
        var root = document.getElementById('slots');
        if (!root || root.__hoaloClipWatch) return;
        root.__hoaloClipWatch = 1;
        var obs = new MutationObserver(function () {
            var slots = root.querySelectorAll('.slot');
            for (var i = 0; i < slots.length; i++) {
                var bg = slots[i].style.backgroundImage || '';
                var has = bg.indexOf('url(') >= 0;
                if (has && seenBg[i] !== bg) {
                    var prev = seenBg[i];
                    seenBg[i] = bg;
                    if (prev !== undefined || recordingIndex === i) onFilled(i);
                } else if (!has) {
                    seenBg[i] = '';
                }
            }
        });
        obs.observe(root, { subtree: true, attributes: true, attributeFilter: ['style'], childList: true });
    }

    function watchShutter() {
        var shutter = document.getElementById('btnShutter');
        if (!shutter) return;
        shutter.addEventListener('click', function () {
            if (shutter.disabled || rec) return;
            var active = document.querySelector('#slots .slot.active');
            var index = active ? +active.dataset.index : 0;
            if (!(index >= 0)) index = 0;
            startClip(index);
        }, true);
        var obs = new MutationObserver(function () {
            if (shutter.disabled || recordingIndex < 0 || !rec) return;
            var slot = document.querySelector('#slots .slot[data-index="' + recordingIndex + '"]');
            var bg = slot && slot.style.backgroundImage || '';
            if (bg.indexOf('url(') < 0) stopCurrent(false);
        });
        obs.observe(shutter, { attributes: true, attributeFilter: ['disabled'] });
    }

    function beforeLeave(url) {
        var keep = /gan-anh\.html/i.test(String(url || ''));
        if (keep) {
            try { sessionStorage.setItem(READY_KEY, '1'); } catch (e) {}
        }
        return new Promise(function (resolve) {
            var done = false;
            function finish() { if (!done) { done = true; resolve(); } }
            setTimeout(function () {
                setTimeout(finish, 1500);
                stopCurrent(keep).then(function () {
                    if (!keep) {
                        try { sessionStorage.removeItem(READY_KEY); } catch (e) {}
                        return clearClips();
                    }
                }).then(finish, finish);
            }, 40);
        });
    }

    try {
        var proto = window.Location && window.Location.prototype;
        if (proto && !proto.__hoaloLeaveHook) {
            var origReplace = proto.replace;
            proto.replace = function (url) {
                var self = this;
                var next = function () {
                    try { origReplace.call(self, url); } catch (e) {}
                };
                if (pageName() !== 'chup-hinh.html') { next(); return; }
                try {
                    var pending = beforeLeave(url);
                    if (pending && pending.then) { pending.then(next, next); return; }
                } catch (e2) {}
                next();
            };
            proto.__hoaloLeaveHook = 1;
        }
    } catch (e3) {}

    try { sessionStorage.removeItem(READY_KEY); } catch (e4) {}
    clearClips().then(function () {
        watchSlots();
        watchShutter();
    }, function () {
        watchSlots();
        watchShutter();
    });

    function composeIfReady() {
        var ready = '';
        try { ready = sessionStorage.getItem(READY_KEY) || ''; } catch (e) {}
        if (ready !== '1' || window.__hoaloComposing) return;
        if (!mimeType()) return;
        window.__hoaloComposing = 1;
        var orderWait = window.hoaloEnsureDownloadOrderAsync
            ? window.hoaloEnsureDownloadOrderAsync()
            : Promise.resolve(null);

        var metaWait = window.hoaloGetSelectedFrameMeta ? window.hoaloGetSelectedFrameMeta() : Promise.resolve(null);
        var frameWait = window.hoaloGetSelectedFrameOverlay ? window.hoaloGetSelectedFrameOverlay() : Promise.resolve(null);
        Promise.all([allClips(), metaWait, frameWait]).then(function (pack) {
            var clips = pack[0] || [];
            var meta = pack[1];
            var frame = pack[2];
            var rects = holesOf(meta);
            if (!clips.length) {
                window.__hoaloComposing = 0;
                try { sessionStorage.removeItem(READY_KEY); } catch (eNo) {}
                return;
            }
            if (!rects.length) {
                window.__hoaloComposing = 0;
                if (!window.__hoaloComposeRetried) {
                    window.__hoaloComposeRetried = 1;
                    setTimeout(composeIfReady, 1500);
                }
                return;
            }
            var dimsW = (meta && +meta.frameW) || 1800;
            var dimsH = (meta && +meta.frameH) || 2400;
            var long = Math.max(dimsW, dimsH);
            var sc = long > OUT_LONG ? OUT_LONG / long : 1;
            var cw = Math.max(2, Math.round(dimsW * sc));
            var ch = Math.max(2, Math.round(dimsH * sc));
            var map = {};
            clips.forEach(function (c) { map[c.index] = c; });
            var photos = [];
            try { photos = JSON.parse(sessionStorage.getItem('photos') || '[]') || []; } catch (e2) {}
            var stillWait = rects.map(function (r, i) { return loadImage(photos[i] || ''); });
            var overlayWait = frame && frame.url ? loadImage(frame.url) : Promise.resolve(null);
            return Promise.all([Promise.all(stillWait), overlayWait]).then(function (pair) {
                var job = encodeFrame(rects, map, pair[0], pair[1], sc, cw, ch);
                pair[0] = null;
                pair[1] = null;
                return job;
            });
        }).then(function (blob) {
            if (!blob || blob.size < 400) {
                window.__hoaloComposing = 0;
                return;
            }
            return orderWait.then(function (order) {
                var orderId = order && order.orderId ? String(order.orderId) : '';
                if (!orderId) throw new Error('order');
                return fetch('/api/v1/capture-video', {
                    method: 'POST',
                    headers: { 'Content-Type': 'video/webm', 'X-Order-Id': orderId },
                    body: blob
                });
            }).then(function (r) {
                if (!r.ok) throw new Error('save');
                try { sessionStorage.removeItem(READY_KEY); } catch (e3) {}
                return clearClips();
            }).then(function () {
                window.__hoaloComposing = 0;
            });
        }).catch(function () {
            window.__hoaloComposing = 0;
            if (!window.__hoaloComposeRetried) {
                window.__hoaloComposeRetried = 1;
                setTimeout(composeIfReady, 2000);
            }
        });
    }

    function encodeFrame(rects, map, stills, overlayImg, sc, cw, ch) {
        var type = mimeType();
        var board = document.createElement('canvas');
        board.width = cw;
        board.height = ch;
        var bctx = board.getContext('2d', { alpha: false });
        if (!bctx || !type) return Promise.resolve(null);

        function raster(img, w, h, alpha) {
            if (!img) return null;
            var c = document.createElement('canvas');
            c.width = Math.max(2, Math.round(w));
            c.height = Math.max(2, Math.round(h));
            var x = c.getContext('2d', { alpha: !!alpha });
            if (!x) return null;
            try { x.drawImage(img, 0, 0, c.width, c.height); } catch (e) { return null; }
            return c;
        }

        var boxes = [];
        var stillBit = [];
        for (var b = 0; b < rects.length; b++) {
            var hole = rects[b];
            var box = {
                x: hole.x * sc,
                y: hole.y * sc,
                w: Math.max(2, hole.w * sc),
                h: Math.max(2, hole.h * sc)
            };
            boxes.push(box);
            stillBit.push(raster(stills[b], box.w, box.h, false));
        }
        var frameBit = raster(overlayImg, cw, ch, true);
        stills = null;
        overlayImg = null;

        function paint(active, vid) {
            bctx.setTransform(1, 0, 0, 1, 0, 0);
            bctx.fillStyle = '#0e0a20';
            bctx.fillRect(0, 0, cw, ch);
            for (var i = 0; i < boxes.length; i++) {
                var slot = boxes[i];
                var src = null;
                if (i < active) src = stillBit[i];
                else if (i === active) src = vid || stillBit[i];
                if (!src) continue;
                bctx.save();
                bctx.beginPath();
                bctx.rect(slot.x, slot.y, slot.w, slot.h);
                bctx.clip();
                drawCover(bctx, src, slot.x, slot.y, slot.w, slot.h);
                bctx.restore();
            }
            if (frameBit) bctx.drawImage(frameBit, 0, 0);
        }

        function hold(active, frames) {
            return new Promise(function (resolve) {
                var n = 0;
                function tick() {
                    paint(active, null);
                    n++;
                    if (n >= frames) resolve();
                    else setTimeout(tick, CLIP_FPS_MS);
                }
                tick();
            });
        }

        function playClip(index) {
            var item = map[index];
            if (!item || !item.blob) return hold(index, 6);
            return new Promise(function (resolve) {
                var url = URL.createObjectURL(item.blob);
                var v = document.createElement('video');
                var settled = false;
                var quit = false;
                v.muted = true;
                v.defaultMuted = true;
                v.playsInline = true;
                v.setAttribute('playsinline', '');
                v.preload = 'auto';
                v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
                v.src = url;
                document.body.appendChild(v);
                var limit = item.ms > 0 ? item.ms : 8000;
                if (limit > 12000) limit = 12000;
                var t0 = Date.now();
                function dropVideo() {
                    try { v.pause(); } catch (e) {}
                    if (v.parentNode) v.parentNode.removeChild(v);
                    try { URL.revokeObjectURL(url); } catch (e2) {}
                }
                function finish() {
                    if (settled) return;
                    settled = true;
                    quit = true;
                    dropVideo();
                    resolve();
                }
                function fail() {
                    if (quit || settled) return;
                    quit = true;
                    dropVideo();
                    hold(index, 6).then(finish);
                }
                function step() {
                    if (quit || settled) return;
                    var played = 0;
                    try { played = v.currentTime * 1000; } catch (e) {}
                    var wall = Date.now() - t0;
                    if (v.readyState >= 2) {
                        try { paint(index, v); } catch (e2) {}
                    } else {
                        paint(index, null);
                    }
                    if (v.ended || played >= limit || wall >= limit + 500) { finish(); return; }
                    if (played < 40 && wall > 900) { fail(); return; }
                    setTimeout(step, CLIP_FPS_MS);
                }
                v.onended = function () { if (!quit) finish(); };
                v.onerror = fail;
                v.play().then(step, fail);
            });
        }

        paint(0, null);
        var stream;
        try { stream = board.captureStream(8); } catch (e) { return Promise.resolve(null); }
        var parts = [];
        var recOut;
        try {
            recOut = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 500000 });
        } catch (e2) {
            try { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e3) {} }); } catch (e4) {}
            return Promise.resolve(null);
        }
        recOut.ondataavailable = function (ev) {
            if (ev.data && ev.data.size) parts.push(ev.data);
        };
        try { recOut.start(1000); } catch (e5) {
            try { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e6) {} }); } catch (e7) {}
            return Promise.resolve(null);
        }
        var chain = Promise.resolve();
        for (var i = 0; i < rects.length; i++) {
            (function (index) {
                chain = chain.then(function () { return playClip(index); });
            })(i);
        }
        function finishRec() {
            return new Promise(function (resolve) {
                function stopTracks() {
                    try { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); } catch (e2) {}
                }
                if (!recOut || recOut.state === 'inactive') {
                    stopTracks();
                    resolve(parts.length ? new Blob(parts, { type: 'video/webm' }) : null);
                    return;
                }
                recOut.onstop = function () {
                    stopTracks();
                    resolve(parts.length ? new Blob(parts, { type: 'video/webm' }) : null);
                };
                try { recOut.stop(); } catch (e3) {
                    stopTracks();
                    resolve(null);
                }
            });
        }

        return chain.then(function () {
            return hold(rects.length, 8);
        }).then(finishRec, finishRec);
    }
})();
*/
