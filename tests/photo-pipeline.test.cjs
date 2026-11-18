const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const capture = fs.readFileSync(path.join(root, 'chup-hinh.html'), 'utf8');
const storage = values => ({ getItem: k => values[k] ?? null, setItem: (k, v) => { values[k] = v; }, removeItem: k => { delete values[k]; }, length: 0 });

test('each capture clears previous selections and requests a fresh order, including retakes', async () => {
    const session = { photos: '["old.png"]', layout: '[0]', layoutFit: '[{}]',
        hoaloOrderId: 'OLD_ORDER', hoaloQrUrl: 'old-qr', payMethod: 'free' };
    let requests = 0;
    const context = vm.createContext({
        window: {}, sessionStorage: storage(session),
        fetch: async () => { requests++; return { ok: true, json: async () => ({ orderId: 'NEW_' + requests, qrUrl: 'qr-' + requests }) }; },
    });
    const cloud = fs.readFileSync(path.join(root, 'js/booth-cloud.js'), 'utf8');
    vm.runInContext(cloud.slice(cloud.indexOf('    window.hoaloEnsureDownloadOrder ='), cloud.indexOf('    function moneyOr(')), context);
    const reset = capture.slice(capture.indexOf('        function startCaptureSession()'), capture.indexOf("        var qShots = ''"));
    for (let batch = 1; batch <= 2; batch++) {
        vm.runInContext(reset, context);
        for (const key of ['photos', 'layout', 'layoutFit', 'hoaloOrderId', 'hoaloQrUrl']) assert.equal(session[key], undefined);
        assert.equal(session.payMethod, 'free');
        const order = await context.window.hoaloEnsureDownloadOrderAsync();
        assert.equal(order.orderId, 'NEW_' + batch);
        session.photos = '["current.png"]';
        session.layout = '[0]';
    }
    assert.equal(requests, 2);
});

test('two and four frame slots produce four and six shots with sync and async metadata', () => {
    for (const slots of [2, 4]) {
        const context = vm.createContext({
            URLSearchParams, location: { search: '?shots=' + slots }, window: {},
            localStorage: storage({ frameShots: String(slots), frameFile: 'Templates/frame_1.png' }),
            sessionStorage: storage({ 'hoaloFrameMetaJson:Templates/frame_1-thumb.json': JSON.stringify({ cameraRects: Array(slots).fill({ w: 100, h: 80 }) }) }),
        });
        vm.runInContext(capture.slice(capture.indexOf("        var qShots = ''"), capture.indexOf('        var CAM_W')), context);
        assert.equal(context.SHOT_COUNT, slots + 2);
        assert.equal(context.localStorage.getItem('frameShots'), String(slots));
        vm.runInContext('var shooting = false, busy = false, photos = [], current = 0; function mountSlots() {} function placeHole() {}', context);
        vm.runInContext(capture.slice(capture.indexOf('        function adoptHoles('), capture.indexOf('        if (window.hoaloGetSelectedFrameMeta)')), context);
        context.adoptHoles(Array(slots + 1).fill({ w: 100, h: 80 }));
        assert.equal(context.SHOT_COUNT, slots + 3);
        assert.equal(context.localStorage.getItem('frameShots'), String(slots + 1));
    }
});

test('capture save uses composition photo URLs and supports retry', async () => {
    let succeed = false;
    let navigated = false;
    const session = {};
    const context = vm.createContext({
        countdownEl: {}, btnShutter: {}, document: { getElementById: () => ({}) },
        busy: true, photos: ['png1', 'png2', 'png3', 'png4'],
        window: { hoaloEnsureDownloadOrderAsync: async () => ({ orderId: 'ORDER' }) },
        sessionStorage: storage(session), location: { replace: () => { navigated = true; } },
        fetch: async (url, opts) => {
            assert.equal(url, '/api/v1/capture-photos');
            assert.equal(JSON.parse(opts.body).photos.length, 4);
            return { ok: succeed, json: async () => ({ ok: true,
                photos: [1, 2, 3, 4].map(i => '/public/anh-le-2/ORDER/' + i + '.png'),
                composePhotos: [1, 2, 3, 4].map(i => '/public/anh-le-2/ORDER/' + i + '.png') }) };
        },
    });
    vm.runInContext(capture.slice(capture.indexOf('        function saveCapturedPhotos()'), capture.indexOf('        function afterShot(')), context);
    context.saveCapturedPhotos();
    await new Promise(setImmediate);
    assert.equal(navigated, false);
    assert.equal(context.busy, false);
    succeed = true;
    context.saveCapturedPhotos();
    await new Promise(setImmediate);
    assert.equal(navigated, true);
    assert.deepEqual(JSON.parse(session.photos), [1, 2, 3, 4].map(i => '/public/anh-le-2/ORDER/' + i + '.png'));
    assert.ok(JSON.parse(session.photos).every(photo => !photo.includes('/public/anh-le/')));
});

for (const frameDims of [{ w: 1200, h: 1800 }, { w: 1800, h: 2400 }]) {
test('composing exports PNG and scaled QR placement for frame ' + frameDims.w + 'x' + frameDims.h, async () => {
    const exported = [];
    const drawn = [];
    let qrCalls = 0;
    let dateCalls = 0;
    class Image {
        constructor() { this.width = this.naturalWidth = 1920; this.height = this.naturalHeight = 1080; }
        set src(value) { this.source = value; this.onload(); }
    }
    const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {},
        fillText() { dateCalls++; }, drawImage(img) { drawn.push(img.source); } };
    const context = vm.createContext({
        window: {
            QRCode: function () { qrCalls++; },
            hoaloGetSelectedFrameMeta: async () => ({ frameW: frameDims.w, frameH: frameDims.h,
                frame: 'tmp2/frame_7.png',
                QrCodeRect: { x: 900, y: 1500, w: 180, h: 180 },
                lblDatePos: { x: 900, y: 1690, w: 180, h: 40 },
                cameraRects: [{ x: 0, y: 0, w: 500, h: 500 }, { x: 0, y: 500, w: 500, h: 500 }] }),
        }, Image,
        sessionStorage: storage({ photos: JSON.stringify(['1.png', '2.png', '3.png', '4.png']), layout: '[3,0]' }),
        localStorage: storage({}), fetch: async () => ({ json: async () => ({}) }),
        document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx,
            toDataURL(type, quality) { exported.push([type, quality, this.width, this.height]); return 'png-result'; } }) },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/print-sheet.js'), 'utf8'), context);
    assert.equal(await context.window.composePrintPng(1200, 1800), 'png-result');
    assert.deepEqual(exported, [['image/png', undefined, 1200, 1800]]);
    assert.deepEqual(drawn.slice(0, 2), ['4.png', '1.png']);
    assert.equal(qrCalls, 0);
    assert.equal(dateCalls, 0);
    const marks = JSON.parse(JSON.stringify(context.window.HOALO_PRINT_MARKS));
    assert.equal(marks.frameRel, 'tmp2/frame_7.png');
    assert.deepEqual([marks.pageW, marks.pageH], [1200, 1800]);
    assert.deepEqual(marks.qrRect, { x: Math.round(900 / frameDims.w * 1200), y: Math.round(1500 / frameDims.h * 1800),
        w: Math.round(180 / frameDims.w * 1200), h: Math.round(180 / frameDims.h * 1800) });
    assert.deepEqual(marks.dateRect, { x: Math.round(900 / frameDims.w * 1200), y: Math.round(1690 / frameDims.h * 1800),
        w: Math.round(180 / frameDims.w * 1200), h: Math.round(40 / frameDims.h * 1800) });
    assert.match(marks.dateText, /^\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/);
    context.window.hoaloGetSelectedFrameMeta = async () => null;
    await assert.rejects(context.window.composePrintPng(1200, 1800), /Chưa đủ ảnh/);
    assert.equal(context.window.HOALO_PRINT_MARKS, null);
});
}

test('finish page sends composed QR coordinates with the print job', async () => {
    const finish = fs.readFileSync(path.join(root, 'hoan-thanh.html'), 'utf8');
    let payload;
    const marks = { frameRel: 'tmp2/frame_7.png', qrRect: { x: 535, y: 1561, w: 200, h: 200 },
        dateRect: { x: 534, y: 1726, w: 200, h: 28 }, dateText: '17:22 10/11/2026' };
    const context = vm.createContext({
        window: { HOALO_PRINT_MARKS: marks }, qty: 1,
        sessionStorage: storage({ layout: '[0,1]' }), setTimeout, clearTimeout,
        fetch: async (url, options) => {
            assert.equal(url, '/api/v1/prints');
            payload = JSON.parse(options.body);
            return { ok: true, json: async () => ({ ok: true, id: 'JOB' }) };
        },
    });
    vm.runInContext(finish.slice(finish.indexOf('        function saveJob('), finish.indexOf('        var orderWait =')), context);
    await context.saveJob({ pageW: 1200, pageH: 1800, dpi: 600 }, 'png', 'ORDER', 0);
    for (const key of Object.keys(marks)) assert.deepEqual(payload[key], marks[key]);
});

test('preview and print preserve photo indices, reject missing assets, and support cameraRect', async () => {
    const values = { photos: JSON.stringify([null, 'selected.png']), layout: '[1]' };
    const drawn = [];
    let fail = '';
    let exports = 0;
    const marks = { pageW: 1200 };
    class Image {
        constructor() { this.naturalWidth = this.width = 100; this.naturalHeight = this.height = 100; }
        set src(value) { this.source = value; value === fail ? this.onerror() : this.onload(); }
    }
    const ctx = { fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, drawImage(img) { drawn.push(img.source); } };
    const paper = { replaceChildren(img) { this.child = img; } };
    const context = vm.createContext({
        window: { HOALO_PRINT_MARKS: marks,
            hoaloGetSelectedFrameMeta: async () => ({ frameW: 1200, frameH: 1800, cameraRect: { x: 0, y: 0, w: 400, h: 500 } }),
            hoaloGetSelectedFrameOverlay: async () => ({ url: 'frame.png' }) },
        sessionStorage: storage(values), localStorage: storage({}), Image,
        fetch: async () => ({ json: async () => ({}) }),
        document: { createElement: () => ({ style: {}, setAttribute() {}, getContext: () => ctx,
            toDataURL() { exports++; return 'composed-png'; } }) },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/print-sheet.js'), 'utf8'), context);
    await context.window.renderPrintSheet({ closest: () => paper });
    assert.equal(paper.child.src, 'composed-png');
    assert.deepEqual(drawn.slice(0, 2), ['selected.png', 'frame.png']);
    assert.equal(context.window.HOALO_PRINT_MARKS, marks);
    assert.equal(exports, 1);
    for (const source of ['selected.png', 'frame.png']) {
        fail = source;
        await assert.rejects(context.window.composePrintPng(1200, 1800));
        assert.equal(exports, 1, 'failed loads must never export a frame-only PNG');
    }
    fail = '';
    values.layout = '[null]';
    await assert.rejects(context.window.composePrintPng(1200, 1800));
    await context.window.renderPrintSheet({ closest: () => paper });
    assert.ok(paper.child.textContent);
    assert.equal(paper.child.src, undefined);
});

test('pending print jobs stay on screen and report stalled worker without submitting again', async () => {
    const finish = fs.readFileSync(path.join(root, 'hoan-thanh.html'), 'utf8');
    for (const cdnLink of ['', 'https://example.test/photo']) {
    for (const status of ['uploading', 'queued', 'printing', 'done', 'failed', 'missing', 'unreachable']) {
        let now = 0, tick, scheduled = 0, pending = 0;
        const context = vm.createContext({
            jobId: '', finished: false, started: false, effectEndsAt: 0,
            seconds: 20, HOLD_AFTER_MS: 15000, homeTimer: null, pollTimer: null,
            Date: { now: () => now },
            document: { getElementById: () => ({ hidden: true }) },
            startFeed() { context.started = true; context.effectEndsAt = now + 20000; },
            fetch: async () => ({ ok: status !== 'unreachable', json: async () => ({ ok: status !== 'missing', status, cdnLink }) }),
            setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
            scheduleGoHomeAfterHold() { scheduled++; },
            showPendingPrint() { pending++; }, showDownloadQr() { assert.equal(status, 'failed'); pending++; },
        });
        vm.runInContext(finish.slice(finish.indexOf('        function pollJob('), finish.indexOf('        function saveJob(')), context);
        context.pollJob('EXISTING_JOB');
        await new Promise(setImmediate);
        assert.equal(scheduled, status === 'done' ? 1 : 0);
        if (['uploading', 'queued', 'printing', 'missing', 'unreachable'].includes(status)) {
            assert.equal(pending, 0);
            now = 80000;
            tick();
            await new Promise(setImmediate);
            assert.equal(pending, 1);
            assert.equal(scheduled, 0);
        }
        if (status === 'failed') assert.equal(pending, 1);
    }
    }
});
