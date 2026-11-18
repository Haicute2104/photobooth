/* Popup "Thanh toán thành công" dùng chung (QR + tiền mặt). Cần bootstrap.bundle + print-sheet.js */
(function () {
    var AUTO_CLOSE = 10;              // giây tự đóng
    var NEXT_PAGE = 'hoan-thanh.html';
    try {
        if (sessionStorage.getItem('hoaloPhoneSend') === '1') NEXT_PAGE = 'gui-anh-qr.html';
    } catch (ePhone) {}

    var html =
        '<div class="modal fade pay-success" id="paySuccess" tabindex="-1" data-bs-backdrop="static" data-bs-keyboard="false" aria-labelledby="paySuccessTitle" aria-hidden="true">' +
        '  <div class="modal-dialog modal-dialog-centered">' +
        '    <div class="modal-content">' +
        '      <button type="button" class="ps-close" data-bs-dismiss="modal" aria-label="Đóng">' +
        '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>' +
        '      </button>' +
        '      <div class="ps-icon">' +
        '        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="20" /><path d="M15.5 24.5l6 6 11-12" /></svg>' +
        '      </div>' +
        '      <h2 class="ps-title" id="paySuccessTitle">THANH TOÁN THÀNH CÔNG</h2>' +
        '      <p class="ps-sub">Thanh toán của bạn đã được xử lý thành công.</p>' +
        '      <dl class="ps-detail">' +
        '        <div class="ps-row ps-total"><dt>Tổng cộng</dt><dd id="psTotal">0 VNĐ</dd></div>' +
        '        <div class="ps-row"><dt>ID</dt><dd id="psId">-</dd></div>' +
        '        <div class="ps-row"><dt>Thời gian</dt><dd id="psTime">-</dd></div>' +
        '        <div class="ps-row"><dt>Nội dung</dt><dd id="psNote">Photobooth HOA LO</dd></div>' +
        '      </dl>' +
        '      <p class="ps-foot">Thông báo tự động đóng sau <strong id="psCount">10s</strong></p>' +
        '    </div>' +
        '  </div>' +
        '</div>';

    var shown = false;

    function pad(n) { return String(n).padStart(2, '0'); }

    // tx = { id, amount, time?: Date }
    window.showPaySuccess = function (tx) {
        if (shown) return;
        shown = true;

        document.body.insertAdjacentHTML('beforeend', html);
        var modalEl = document.getElementById('paySuccess');
        var modal = new bootstrap.Modal(modalEl);

        var t = tx.time || new Date();
        document.getElementById('psTotal').textContent = formatVnd(tx.amount);
        document.getElementById('psId').textContent = tx.id;
        document.getElementById('psTime').textContent =
            pad(t.getDate()) + '/' + pad(t.getMonth() + 1) + '/' + t.getFullYear() + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
        try {
            sessionStorage.setItem('transaction', JSON.stringify({ id: tx.id, amount: tx.amount, time: t.toISOString() }));
        } catch (e) {}

        // Đóng popup (bấm X hoặc hết giờ) -> sang màn nhận bản in
        modalEl.addEventListener('hidden.bs.modal', function () { location.href = NEXT_PAGE; });

        modal.show();
        var n = AUTO_CLOSE, countEl = document.getElementById('psCount');
        countEl.textContent = n + 's';
        var cv = setInterval(function () {
            try {
                n--;
                if (countEl) countEl.textContent = Math.max(n, 0) + 's';
                if (n <= 0) { clearInterval(cv); modal.hide(); }
            } catch (e) {
                clearInterval(cv);
                try { location.href = NEXT_PAGE; } catch (e2) {}
            }
        }, 1000);
    };
})();
