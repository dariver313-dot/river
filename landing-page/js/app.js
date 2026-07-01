(function () {
    'use strict';

    var cfg = window.SITE_CONFIG || {};

    var URL_ROTATION_CHARS = cfg.urlRotationChars || ['a', 'b', 'c', 'd', 'e', 'f'];
    var URL_ROTATION_INTERVAL = cfg.urlRotationInterval || 1400;
    var URL_FLASH_DURATION = cfg.urlFlashDuration || 200;
    var DOWNLOAD_POPUP_DELAY = cfg.downloadPopupDelay || 5000;
    var REMINDER_TIPS = cfg.reminderTips || [];
    var CHANNELS = cfg.channels || {};
    var DOWNLOADS = cfg.downloads || {};
    var BANNER = cfg.banner || [];

    var FAIL_COOLDOWN = 600000;
    var bannerIndex = 0;
    var channelIndex = {};
    var failedUrls = {};

    function isFailed(url) {
        if (!failedUrls[url]) return false;
        if (Date.now() - failedUrls[url] > FAIL_COOLDOWN) {
            delete failedUrls[url];
            return false;
        }
        return true;
    }

    function markFailed(url) {
        failedUrls[url] = Date.now();
    }

    function pickUrl(urls, indexKey) {
        if (!urls || !urls.length) return null;
        var startIdx = (indexKey === '_banner') ? bannerIndex : (channelIndex[indexKey] || 0);

        for (var offset = 0; offset < urls.length; offset++) {
            var idx = (startIdx + offset) % urls.length;
            if (!isFailed(urls[idx])) return urls[idx];
        }

        return urls[startIdx];
    }

    function advanceIndex(indexKey, urls) {
        if (indexKey === '_banner') {
            bannerIndex = (bannerIndex + 1) % urls.length;
        } else {
            channelIndex[indexKey] = ((channelIndex[indexKey] || 0) + 1) % urls.length;
        }
    }

    function navigateTo(url) {
        var win = window.open(url, '_blank');
        if (!win || win.closed || typeof win.closed === 'undefined') {
            window.location.href = url;
        }
    }

    function openChannel(channelKey) {
        var urls = CHANNELS[channelKey];
        if (!urls || !urls.length) return;
        var url = pickUrl(urls, channelKey);
        if (url) {
            navigateTo(url);
            advanceIndex(channelKey, urls);
        }
    }

    function openBanner() {
        if (!BANNER.length) return;
        var url = pickUrl(BANNER, '_banner');
        if (url) {
            navigateTo(url);
            advanceIndex('_banner', BANNER);
        }
    }

    function openChannelWithFallback(channelKey) {
        var urls = CHANNELS[channelKey];
        if (!urls || !urls.length) return;
        var url = pickUrl(urls, channelKey);
        if (!url) return;
        markFailed(url);
        advanceIndex(channelKey, urls);
        var nextUrl = pickUrl(urls, channelKey);
        if (nextUrl) {
            navigateTo(nextUrl);
            advanceIndex(channelKey, urls);
        }
    }

    function openBannerWithFallback() {
        if (!BANNER.length) return;
        var url = pickUrl(BANNER, '_banner');
        if (!url) return;
        markFailed(url);
        advanceIndex('_banner', BANNER);
        var nextUrl = pickUrl(BANNER, '_banner');
        if (nextUrl) {
            navigateTo(nextUrl);
            advanceIndex('_banner', BANNER);
        }
    }

    function removeEl(el) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function createMask() {
        var mask = document.createElement('div');
        mask.className = 'dl-popup-mask';
        return mask;
    }

    function createPopup() {
        var popup = document.createElement('div');
        popup.className = 'dl-popup';
        return popup;
    }

    function showDownloadLoading() {
        var mask = createMask();
        var popup = createPopup();

        var spinner = document.createElement('div');
        spinner.className = 'dl-popup-spinner';

        var msg = document.createElement('div');
        msg.className = 'dl-popup-msg';
        msg.textContent = '\u6B63\u5728\u51C6\u5907\u4E0B\u8F7D...';

        var desc = document.createElement('div');
        desc.className = 'dl-popup-desc';
        desc.textContent = '\u8BF7\u7A0D\u5019\uFF0C\u5373\u5C06\u8DF3\u8F6C\u5230\u4E0B\u8F7D\u9875\u9762';

        popup.appendChild(spinner);
        popup.appendChild(msg);
        popup.appendChild(desc);
        mask.appendChild(popup);
        document.body.appendChild(mask);
        return mask;
    }

    function showDownloadFail() {
        var mask = createMask();
        var popup = createPopup();

        var iconWrap = document.createElement('div');
        iconWrap.className = 'dl-popup-icon-wrap';
        var icon = document.createElement('div');
        icon.className = 'dl-popup-icon';
        icon.textContent = '!';
        iconWrap.appendChild(icon);

        var msg = document.createElement('div');
        msg.className = 'dl-popup-msg';
        msg.textContent = '\u4E0B\u8F7D\u94FE\u63A5\u6682\u65F6\u4E0D\u53EF\u7528';

        var desc = document.createElement('div');
        desc.className = 'dl-popup-desc';

        var p1 = document.createElement('p');
        p1.textContent = '\u53EF\u80FD\u539F\u56E0\uFF1A\u94FE\u63A5\u5DF2\u8FC7\u671F\u6216\u670D\u52A1\u5668\u7EF4\u62A4\u4E2D';
        desc.appendChild(p1);

        var p2 = document.createElement('p');
        p2.style.marginTop = '0.5rem';
        p2.textContent = '\u5EFA\u8BAE\u60A8\uFF1A';
        desc.appendChild(p2);

        var ul = document.createElement('ul');
        ul.style.paddingLeft = '1rem';
        ul.style.marginTop = '0.2rem';
        var li1 = document.createElement('li');
        li1.textContent = '\u8054\u7CFB\u5728\u7EBF\u5BA2\u670D\u83B7\u53D6\u6700\u65B0\u94FE\u63A5';
        var li2 = document.createElement('li');
        li2.textContent = '\u7A0D\u540E\u518D\u8BD5';
        ul.appendChild(li1);
        ul.appendChild(li2);
        desc.appendChild(ul);

        var btnWrap = document.createElement('div');
        btnWrap.className = 'dl-popup-btns';

        var btnOk = document.createElement('button');
        btnOk.className = 'dl-popup-btn dl-popup-btn--primary';
        btnOk.textContent = '\u8054\u7CFB\u5BA2\u670D';
        btnOk.addEventListener('click', function () {
            removeEl(mask);
            openChannel('kefu');
        });

        var btnCancel = document.createElement('button');
        btnCancel.className = 'dl-popup-btn dl-popup-btn--secondary';
        btnCancel.textContent = '\u6211\u77E5\u9053\u4E86';
        btnCancel.addEventListener('click', function () { removeEl(mask); });

        btnWrap.appendChild(btnOk);
        btnWrap.appendChild(btnCancel);

        popup.appendChild(iconWrap);
        popup.appendChild(msg);
        popup.appendChild(desc);
        popup.appendChild(btnWrap);
        mask.appendChild(popup);
        document.body.appendChild(mask);
    }

    function downloadApp() {
        var loadingMask = showDownloadLoading();

        var ua = navigator.userAgent || '';
        var isIOS = /iPad|iPhone|iPod/i.test(ua);
        var platform = isIOS ? 'ios' : 'android';
        var urls = DOWNLOADS[platform];

        if (!urls || !urls.length) {
            removeEl(loadingMask);
            showDownloadFail();
            return;
        }

        var url = pickUrl(urls, '_dl_' + platform);
        advanceIndex('_dl_' + platform, urls);

        setTimeout(function () {
            removeEl(loadingMask);
            window.location.href = url;
        }, 600);
    }

    function showInstallGuide() {
        var mask = createMask();
        var popup = createPopup();

        var iconWrap = document.createElement('div');
        iconWrap.className = 'dl-popup-icon-wrap';
        var icon = document.createElement('div');
        icon.className = 'dl-popup-icon dl-popup-icon--info';
        icon.textContent = 'i';
        iconWrap.appendChild(icon);

        var msg = document.createElement('div');
        msg.className = 'dl-popup-msg';
        msg.textContent = '\u5B89\u88C5\u5F15\u5BFC';

        var desc = document.createElement('div');
        desc.className = 'dl-popup-desc';
        desc.textContent = '\u70B9\u51FB[\u5141\u8BB8]\u540E \u2192 \u8FD4\u56DE\u624B\u673A\u684C\u9762 \u2192 \u901A\u7528 \u2192 VPN\u4E0E\u8BBE\u5907\u7BA1\u7406 \u2192 \u70B9\u51FB[970\u4FEE\u590D\u5DE5\u5177] \u2192 \u70B9\u51FB\u53F3\u4E0A\u89D2[\u5B89\u88C5] \u2192 \u8F93\u5165\u9501\u5C4F\u5BC6\u7801 \u2192 \u53F3\u4E0A\u89D2\u201C\u5B89\u88C5\u201D \u2192 \u5B8C\u6210';

        var btnWrap = document.createElement('div');
        btnWrap.className = 'dl-popup-btns';
        var btn = document.createElement('button');
        btn.className = 'dl-popup-btn dl-popup-btn--primary';
        btn.textContent = '\u6211\u77E5\u9053\u4E86';
        btn.addEventListener('click', function () { removeEl(mask); });
        btnWrap.appendChild(btn);

        popup.appendChild(iconWrap);
        popup.appendChild(msg);
        popup.appendChild(desc);
        popup.appendChild(btnWrap);
        mask.appendChild(popup);
        document.body.appendChild(mask);
    }

    function initTutorialPopup() {
        var popup = document.getElementById('popup');
        var overlay = document.getElementById('fullbg');
        if (!popup || !overlay) return;

        function position() {
            popup.style.bottom = -popup.offsetHeight + 'px';
            popup.style.top = 'auto';
        }

        function close() {
            popup.style.transition = 'bottom 300ms ease-out';
            popup.style.bottom = -popup.offsetHeight + 'px';
            setTimeout(function () {
                popup.style.display = 'none';
                overlay.style.display = 'none';
                popup.style.transition = '';
            }, 300);
        }

        position();

        var closeBtn = popup.querySelector('.popup__close');
        if (closeBtn) closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', close);

        var resizeTimer;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(position, 150);
        });
    }

    function initUrlRotation() {
        var chars = document.querySelectorAll('.url-banner__char');
        if (!chars.length) return;

        var index = 0;
        var timer = null;

        function update() {
            for (var i = 0; i < chars.length; i++) {
                chars[i].textContent = URL_ROTATION_CHARS[index];
                chars[i].classList.add('url-banner__char--flash');
            }
            setTimeout(function () {
                for (var i = 0; i < chars.length; i++) {
                    chars[i].classList.remove('url-banner__char--flash');
                }
            }, URL_FLASH_DURATION);
            index = (index + 1) % URL_ROTATION_CHARS.length;
        }

        function start() { stop(); update(); timer = setInterval(update, URL_ROTATION_INTERVAL); }
        function stop() { if (timer) { clearInterval(timer); timer = null; } }

        start();
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) stop(); else start();
        });
    }

    function initReminder() {
        var container = document.getElementById('reminder-container');
        if (!container) return;
        var ul = document.createElement('ul');
        for (var i = 0; i < REMINDER_TIPS.length; i++) {
            var li = document.createElement('li');
            li.textContent = REMINDER_TIPS[i];
            ul.appendChild(li);
        }
        container.appendChild(ul);
    }

    function showDownloadPopup() {
        var mask = createMask();
        var popup = createPopup();

        var iconWrap = document.createElement('div');
        iconWrap.className = 'dl-popup-icon-wrap';
        var icon = document.createElement('div');
        icon.className = 'dl-popup-icon dl-popup-icon--gift';
        icon.textContent = '\uD83C\uDF81';
        iconWrap.appendChild(icon);

        var msg = document.createElement('div');
        msg.className = 'dl-popup-msg';
        msg.textContent = '\u9886\u53D6\u4E13\u5C5E\u8C6A\u793C';

        var desc = document.createElement('div');
        desc.className = 'dl-popup-desc';
        desc.textContent = '\u7ACB\u5373\u4E0B\u8F7D App\uFF0C\u5F00\u542F\u60A8\u7684\u7CBE\u5F69\u4F53\u9A8C';

        var btnWrap = document.createElement('div');
        btnWrap.className = 'dl-popup-btns';

        var btnOk = document.createElement('button');
        btnOk.className = 'dl-popup-btn dl-popup-btn--primary';
        btnOk.textContent = '\u7ACB\u5373\u4E0B\u8F7D';
        btnOk.addEventListener('click', function () { removeEl(mask); downloadApp(); });

        var btnCancel = document.createElement('button');
        btnCancel.className = 'dl-popup-btn dl-popup-btn--secondary';
        btnCancel.textContent = '\u7A0D\u540E\u518D\u8BF4';
        btnCancel.addEventListener('click', function () { removeEl(mask); });

        btnWrap.appendChild(btnOk);
        btnWrap.appendChild(btnCancel);

        popup.appendChild(iconWrap);
        popup.appendChild(msg);
        popup.appendChild(desc);
        popup.appendChild(btnWrap);
        mask.appendChild(popup);
        document.body.appendChild(mask);
    }

    function initAnimationCleanup() {
        document.addEventListener('animationend', function (e) {
            if (e.target.classList.contains('animate-in')) {
                e.target.style.willChange = 'auto';
            }
        });
    }

    function initCtaGlowPause() {
        var ctaEls = document.querySelectorAll('.channel-row__cta');
        if (!ctaEls.length) return;
        document.addEventListener('visibilitychange', function () {
            for (var i = 0; i < ctaEls.length; i++) {
                ctaEls[i].style.animationPlayState = document.hidden ? 'paused' : 'running';
            }
        });
    }

    function initEvents() {
        document.addEventListener('click', function (e) {
            var el = e.target.closest('[data-action]');
            if (!el) return;
            e.preventDefault();
            var action = el.dataset.action;
            if (action === 'channel') {
                var key = el.dataset.channel;
                if (key) openChannel(key);
            } else if (action === 'download') {
                downloadApp();
            } else if (action === 'banner') {
                openBanner();
            } else if (action === 'close-guide') {
                showInstallGuide();
            }
        });
    }

    function init() {
        initTutorialPopup();
        initUrlRotation();
        initReminder();
        initAnimationCleanup();
        initCtaGlowPause();
        initEvents();
        setTimeout(showDownloadPopup, DOWNLOAD_POPUP_DELAY);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
