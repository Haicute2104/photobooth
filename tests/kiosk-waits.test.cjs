const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const cloud = fs.readFileSync(path.join(root, 'js/booth-cloud.js'), 'utf8');
const finish = fs.readFileSync(path.join(root, 'hoan-thanh.html'), 'utf8');
const flush = () => new Promise(setImmediate);
const storage = values => ({
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = value; },
    removeItem: key => { delete values[key]; },
});

function clock() {
    let now = 0, next = 0;
    const timers = new Map();
    const add = (fn, ms, repeat) => {
        const id = ++next;
        timers.set(id, { fn, ms, repeat, at: now + ms });
        return id;
    };
    return {
        Date: class extends Date {
            constructor(...args) { super(...(args.length ? args : [now])); }
            static now() { return now; }
        },
        setTimeout: (fn, ms) => add(fn, ms, false),
        setInterval: (fn, ms) => add(fn, ms, true),
        clearTimeout: id => timers.delete(id),
        clearInterval: id => timers.delete(id),
        async advance(ms) {
            const end = now + ms;
            while (true) {
                const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                const [id, timer] = due;
                now = timer.at;
                if (timer.repeat) timer.at += timer.ms;
                else timers.delete(id);
                timer.fn();
                await flush();
            }
            now = end;
            await flush();
        },
    };
}

function paymentContext(extra = {}) {
    const time = clock();
    const context = vm.createContext({ window: {}, ...time, ...extra });
    vm.runInContext(cloud.slice(cloud.indexOf('    function clampTimeout('),
        cloud.indexOf('    window.hoaloCmsBase =')), context);
    vm.runInContext(cloud.slice(cloud.indexOf('    function armTimeout('),
        cloud.indexOf('    function settleAccumulated(')), context);
    return { context, time };
}

test('payment uses cloud background timeout, persists offline and follows later changes', async () => {
    let online = true, cloudSeconds = 180, cached = { paymentTimeoutSeconds: 60 };
    const { context, time } = paymentContext({
        bases: () => [''], apiUrl: (base, route) => base + route,
        withTimeout: () => ({ done() {} }),
        fetch: async (url, options) => {
            assert.equal(options.cache, 'no-store');
            if (url === 'config.json') return { ok: true, json: async () => ({
                deviceId: 'TEST', cloudConfigToken: 'test-token', paymentTimeoutSeconds: 240,
            }) };
            assert.equal(url, '/api/sync');
            if (!online) throw new Error('offline');
            return { ok: true, json: async () => ({ config: {
                paymentTimeoutSeconds: 60, previewReplaceTimeoutSeconds: cloudSeconds,
            } }) };
        },
        loadCachedEssentialConfig: async () => cached,
        cacheEssentialConfigAfterFrames: async config => {
            cached = config;
            context.applyEssentialConfig(config);
        },
        rememberCloudPrices() {}, pricePair: () => ({}),
    });
    vm.runInContext(cloud.slice(cloud.indexOf('    function applyEssentialConfig('),
        cloud.indexOf('    function rememberCloudPrices(')), context);
    assert.equal(await context.window.hoaloGetPaymentTimeout(), 180);
    assert.equal(cached.previewReplaceTimeoutSeconds, 180);
    assert.equal(context.window.HOALO_CONFIG.previewReplaceTimeoutSeconds, 180);
    assert.equal(context.window.HOALO_CONFIG.paymentTimeoutSeconds, 60);
    online = false;
    assert.equal(await context.window.hoaloGetPaymentTimeout(), 180);
    online = true;
    cloudSeconds = 210;
    assert.equal(await context.window.hoaloGetPaymentTimeout(), 210);
    await time.advance(5000);
    assert.equal(context.window.HOALO_CONFIG.previewReplaceTimeoutSeconds, 210);
});

test('timeout falls back to cached cloud config, then local when no cloud cache exists', async () => {
    let cached = { paymentTimeoutSeconds: 60, previewReplaceTimeoutSeconds: 180 };
    const { context } = paymentContext({
        fetch: async () => ({ ok: true, json: async () => ({ paymentTimeoutSeconds: 240 }) }),
        loadCachedEssentialConfig: async () => cached,
    });
    assert.equal(await context.window.hoaloGetPaymentTimeout(), 180);
    cached = {};
    assert.equal(await context.window.hoaloGetPaymentTimeout(), 240);
});

test('old cache cannot override the new shared local timeout with legacy 60 seconds', async () => {
    const { context } = paymentContext({
        fetch: async () => ({ ok: true, json: async () => ({
            previewReplaceTimeoutSeconds: 180, paymentTimeoutSeconds: 240,
            captureTimeoutSeconds: 30, layoutTimeoutSeconds: 45,
        }) }),
        loadCachedEssentialConfig: async () => ({ paymentTimeoutSeconds: 60 }),
    });
    assert.equal(await context.window.hoaloGetPaymentTimeout(), 180);
    assert.equal(await context.window.hoaloGetCaptureTimeout(), 30);
    assert.equal(await context.window.hoaloGetLayoutTimeout(), 45);
});

test('shared background timeout is retained by browser config cache', () => {
    const context = vm.createContext({});
    vm.runInContext(cloud.slice(cloud.indexOf('    var ESSENTIAL_CONFIG_KEYS ='),
        cloud.indexOf('    function applyEssentialConfig(')), context);
    assert.equal(context.pickEssentialConfig({ previewReplaceTimeoutSeconds: 180 }).previewReplaceTimeoutSeconds, 180);
});

test('early cash restart waits for config; UI errors cannot expire payment early', async () => {
    let resolve, homes = 0;
    const pending = new Promise(done => { resolve = done; });
    const { context, time } = paymentContext();
    context.window.hoaloGetPaymentTimeout = () => pending;
    context.window.hoaloGoHome = () => { homes++; };
    const ticks = [];
    const timer = context.window.hoaloArmPaymentTimeout({ onTick(n) {
        ticks.push(n);
        if (n === 179) throw new Error('countdown DOM unavailable');
    } });
    timer.restart();
    await time.advance(61000);
    assert.equal(homes, 0);
    assert.deepEqual(ticks, []);
    resolve(180);
    await flush();
    assert.equal(ticks[0], 180);
    await time.advance(60000);
    assert.equal(homes, 0);
    timer.restart();
    await time.advance(179000);
    assert.equal(homes, 0);
    await time.advance(1000);
    assert.equal(homes, 1);
});

test('successful payment cancels timer even before config resolves', async () => {
    let resolve, homes = 0;
    const { context, time } = paymentContext();
    context.window.hoaloGetPaymentTimeout = () => new Promise(done => { resolve = done; });
    context.window.hoaloGoHome = () => { homes++; };
    const timer = context.window.hoaloArmPaymentTimeout();
    timer.cancel();
    resolve(180);
    await flush();
    await time.advance(300000);
    assert.equal(homes, 0);
});

async function finishContext(qty = 1) {
    const time = clock();
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '',
            style: { setProperty(key, value) { this[key] = value; } },
            classList: { add() {} } });
        return elements.get(id);
    };
    const paper = element('paper');
    let state = { ok: true, status: 'uploading' }, homes = 0, posts = 0;
    let compose;
    const composed = new Promise(resolve => { compose = resolve; });
    const context = vm.createContext({
        ...time,
        window: {
            hoaloSettlePayments: async () => {},
            hoaloEnsureDownloadOrderAsync: async () => ({ orderId: 'ORDER' }),
            hoaloGetPrintSpec: async () => ({ pageW: 1200, pageH: 1800 }),
            composePrintPng: () => composed,
        },
        document: { getElementById: element, querySelector: () => paper },
        sessionStorage: storage({ layout: '[0,1]' }),
        localStorage: storage({ printQty: String(qty) }),
        location: { replace: () => { homes++; } },
        renderPrintSheet() {},
        fetch: async (url, options) => {
            if (options.method === 'POST') {
                posts++;
                return { ok: true, json: async () => ({ ok: true, id: 'JOB' }) };
            }
            return { ok: true, json: async () => state };
        },
    });
    vm.runInContext(finish.match(/<script>\s*([\s\S]*?)<\/script>/)[1], context);
    await flush();
    return { time, paper, element, compose,
        state: value => { state = value; },
        homes: () => homes, posts: () => posts };
}

test('slow preparation keeps polling and starts 2min animation only when print is ready', async () => {
    const page = await finishContext();
    assert.equal(page.paper.style['--print-ms'], undefined);
    assert.equal(page.posts(), 0);
    page.compose('png');
    await flush();
    assert.equal(page.posts(), 1);
    await page.time.advance(151000);
    assert.equal(page.homes(), 0);
    assert.equal(page.paper.style['--print-ms'], undefined);
    assert.equal(page.element('composeFailPopup').hidden, false);
    page.state({ ok: true, status: 'queued' });
    await page.time.advance(1500);
    assert.equal(page.paper.style['--print-ms'], '120000ms');
    assert.equal(page.element('composeFailPopup').hidden, true);
    page.state({ ok: true, status: 'done' });
    await page.time.advance(1500);
    await page.time.advance(132000);
    assert.equal(page.homes(), 0);
    await page.time.advance(1500);
    assert.equal(page.homes(), 1);
    assert.equal(page.posts(), 1, 'polling must not submit a duplicate print');
});

test('finishing animation without print confirmation never sends customer home', async () => {
    const page = await finishContext(10);
    page.state({ ok: true, status: 'printing' });
    page.compose('png');
    await flush();
    assert.equal(page.paper.style['--print-ms'], '200000ms');
    await page.time.advance(250000);
    assert.equal(page.homes(), 0);
    assert.equal(page.element('composeFailPopup').hidden, false);
    page.state({ ok: true, status: 'done' });
    await page.time.advance(1500);
    assert.equal(page.element('composeFailPopup').hidden, true);
    await page.time.advance(15000);
    assert.equal(page.homes(), 1);
});

test('printer failure after a long preparation replaces waiting popup with download QR', async () => {
    const page = await finishContext();
    page.compose('png');
    await flush();
    await page.time.advance(151000);
    assert.equal(page.element('composeFailPopup').hidden, false);
    page.state({ ok: true, status: 'failed', cdnLink: 'https://example.test/photo' });
    await page.time.advance(1500);
    assert.equal(page.element('composeFailPopup').hidden, true);
    assert.equal(page.element('printFailPopup').hidden, false);
    assert.equal(page.homes(), 0);
    assert.equal(page.posts(), 1);
    await page.time.advance(90000);
    assert.equal(page.homes(), 1);
});
