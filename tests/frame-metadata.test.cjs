const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/booth-cloud.js'), 'utf8');
const section = source.slice(source.indexOf('    function fetchFrameMetaNetwork('), source.indexOf('    /** Cache-first:'));
test('boot refresh replaces old QR metadata and bypasses disk cache; offline preserves it', async () => {
    const rel = 'Templates/frame_11-thumb.json';
    const stores = { session: { x: 1592 }, local: { x: 1592 }, idb: { x: 1592 } };
    const urls = [];
    let offline = false;
    const context = vm.createContext({
        Promise, Object, Array, String, Error, JSON, Blob,
        console: { warn() {} },
        bases: () => [''], apiUrl: (base, path) => base + path,
        FILE_FETCH_MS: 100, withTimeout: () => ({ done() {} }),
        fetch: async (url, opts) => {
            urls.push(url);
            assert.equal(opts.cache, 'no-store');
            if (offline) throw new Error('offline');
            return { ok: true, json: async () => ({ QrCodeRect: { x: 100 } }) };
        },
        storeFrameMeta: (key, device, meta) => {
            assert.equal(key, rel); assert.equal(device, 'booth');
            stores.session = meta.QrCodeRect; stores.local = meta.QrCodeRect;
        },
        idbPutAsset: async (key, blob) => { stores.idb = JSON.parse(await blob.text()).QrCodeRect; },
    });
    vm.runInContext(section, context);
    await context.refreshFrameMetadata({ deviceId: 'booth' }, { [rel]: {}, 'Templates/frame_11.png': {} });
    assert.equal(urls.length, 1);
    assert.ok(urls[0].startsWith('/api/sync/file?rel='));
    for (const value of Object.values(stores)) assert.equal(value.x, 100);
    offline = true;
    await context.refreshFrameMetadata({ deviceId: 'booth' }, { [rel]: {} });
    for (const value of Object.values(stores)) assert.equal(value.x, 100);
});
