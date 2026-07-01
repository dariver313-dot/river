(function () {
    'use strict';

    var cfg = window.SITE_CONFIG || {};

    var REMINDER_TIPS = cfg.reminderTips || [];
    var CHANNELS = cfg.channels || {};

    var channelIndex = {};

    function pickUrl(urls, indexKey) {
        if (!urls || !urls.length) return null;
        var startIdx = channelIndex[indexKey] || 0;
        return urls[startIdx % urls.length];
    }

    function advanceIndex(indexKey, urls) {
        if (!urls || !urls.length) return;
        channelIndex[indexKey] = ((channelIndex[indexKey] || 0) + 1) % urls.length;
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

    function initAnimationCleanup() {
        document.addEventListener('animationend', function (e) {
            if (e.target.classList.contains('animate-in')) {
                e.target.style.willChange = 'auto';
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
            }
        });
    }

    function init() {
        initReminder();
        initAnimationCleanup();
        initEvents();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
