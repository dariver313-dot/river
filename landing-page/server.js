var express = require('express');
var path = require('path');
var cryptoNode = require('crypto');
var fs = require('fs');
var compression = require('compression');

var ROOT = __dirname;

function loadEnv() {
    var envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(function (line) {
        line = line.trim();
        if (!line || line[0] === '#') return;
        var idx = line.indexOf('=');
        if (idx < 1) return;
        process.env[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
    });
}
loadEnv();

var configJson = null;

function loadConfig() {
    var configPath = path.join(ROOT, 'config.json');
    if (!fs.existsSync(configPath)) {
        console.warn('[landing] config.json not found, using empty config');
        configJson = {};
        return;
    }
    try {
        configJson = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        console.log('[landing] config.json loaded');
    } catch (e) {
        console.error('[landing] failed to parse config.json:', e.message);
        configJson = {};
    }
}

function buildConfigScript() {
    return '<script>var SITE_CONFIG = ' + JSON.stringify(configJson) + ';</script>';
}

function buildPageWithConfig() {
    var configScript = buildConfigScript();
    return pageHtmlContent.replace('<body>', '<body>\n' + configScript);
}

loadConfig();

var PORT = parseInt(process.env.PORT || '3001', 10);

var app = express();
app.use(compression());
app.use(express.json({ limit: '8kb' }));

app.use(function (req, res, next) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    next();
});

// ---------------------------------------------------------------------------
// AES helpers
// ---------------------------------------------------------------------------

function generateAESPassword() {
    return cryptoNode.randomBytes(30).toString('base64')
        .replace(/[^a-zA-Z0-9]/g, '').substring(0, 40);
}

function encryptPageHTML(html, password) {
    var hash = cryptoNode.createHash('sha256').update(password).digest();
    var iv = cryptoNode.randomBytes(16);
    var cipher = cryptoNode.createCipheriv('aes-256-cbc', hash, iv);
    var encrypted = Buffer.concat([cipher.update(html, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, encrypted]).toString('base64');
}

// ---------------------------------------------------------------------------
// Key store  (kid -> AES password, keeps last 2 entries)
// ---------------------------------------------------------------------------

var keyStore = new Map();
var MAX_KEY_STORE = 2;

// ---------------------------------------------------------------------------
// Page HTML & shell cache
// ---------------------------------------------------------------------------

var pageHtmlContent = fs.readFileSync(path.join(ROOT, 'page.html'), 'utf8');

var SHELL_CACHE_TTL = 300000;
var shellCache = { html: null, time: 0, kid: null };

function buildShellHtml() {
    var password = generateAESPassword();
    var pageWithConfig = buildPageWithConfig();
    var encrypted = encryptPageHTML(pageWithConfig, password);
    var kid = cryptoNode.randomBytes(16).toString('hex');

    keyStore.set(kid, password);
    var keys = Array.from(keyStore.keys());
    for (var i = 0; i < keys.length - MAX_KEY_STORE; i++) {
        keyStore.delete(keys[i]);
    }

    return {
        html: [
            '<!doctype html><html><head>',
            '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width,minimum-scale=1.0,maximum-scale=1.0,user-scalable=no" />',
            '<title>Loading...</title>',
            '<style>',
            '*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%;background:#D1E7FC}',
            '.loader-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:999999;background:#D1E7FC;font-family:sans-serif;transition:opacity 200ms ease-out}',
            '.loader-spinner{width:36px;height:36px;border:3px solid #bfdbfe;border-top-color:#1e5fd4;border-radius:50%;animation:spin .8s linear infinite}',
            '@keyframes spin{to{transform:rotate(360deg)}}',
            '.loader-text{margin-top:16px;color:#475569;font-size:14px}',
            '</style>',
            '</head><body>',
            '<div class="loader-wrap"><div class="loader-spinner"></div><div class="loader-text">加载中...</div></div>',
            '<script src="./js/keyexchange.js"></script>',
            '<script>',
            'var _d="' + encrypted + '";',
            'var _kid="' + kid + '";',
            '</script>',
            '<script>',
            '(function(){',
            '  var _done=false;',
            '  function hideLoader(){var l=document.querySelector(".loader-wrap");if(l){l.style.opacity="0";setTimeout(function(){if(l.parentNode)l.parentNode.removeChild(l);},200);}}',
            '  function showError(msg){if(_done)return;_done=true;hideLoader();document.body.innerHTML=\'<div class="loader-wrap"><div class="loader-text" style="color:#ef4444">\'+(msg||\'\\u52A0\\u8F7D\\u5931\\u8D25\')+\'</div></div>\';}',
            '  function injectScripts(c,cb){var s=c.querySelectorAll("script");var i=0;function next(){if(i>=s.length){if(cb)cb();return;}var old=s[i++];var n=document.createElement("script");if(old.src){n.src=old.src;n.onload=next;n.onerror=next;}else{n.textContent=old.textContent;}old.parentNode.replaceChild(n,old);if(!old.src)next();}next();}',
            '  function waitCSSLink(){return new Promise(function(r){var links=document.querySelectorAll(\'link[rel="stylesheet"]\');if(!links.length){r();return;}var pending=0;for(var i=0;i<links.length;i++){if(links[i].sheet)continue;pending++;links[i].onload=function(){pending--;if(pending<=0)r();};}if(pending<=0)r();});}',
            '  setTimeout(function(){if(!_done)showError("\\u52A0\\u8F7D\\u8D85\\u65F6");},20000);',
            '  try{',
            '    if(typeof crypto==="undefined"||typeof crypto.subtle==="undefined"){showError("\\u8BF7\\u4F7F\\u7528\\u73B0\\u4EE3\\u6D4F\\u89C8\\u5668\\u8BBF\\u95EE");return;}',
            '    doKeyExchange(_kid).then(function(password){',
            '      return aesDecrypt(_d,password);',
            '    }).then(function(html){',
            '      if(!html)throw new Error("D");',
            '      _done=true;',
            '      var hm=html.match(/<head[^>]*>([\\s\\S]*?)<\\/head>/i);',
            '      var bm=html.match(/<body[^>]*>([\\s\\S]*?)<\\/body>/i);',
            '      if(hm)document.head.innerHTML=hm[1];',
            '      waitCSSLink().then(function(){',
            '        if(bm){document.body.innerHTML=bm[1];injectScripts(document.body,function(){hideLoader();});}else{hideLoader();}',
            '      });',
            '    }).catch(function(e){console.error("[i]",e);showError();});',
            '  }catch(e){console.error("[i]",e);showError();}',
            '})();',
            '</script>',
            '</body></html>'
        ].join('\n'),
        kid: kid
    };
}

function getShellHtml() {
    var now = Date.now();
    if (shellCache.html && (now - shellCache.time) < SHELL_CACHE_TTL) {
        return shellCache.html;
    }
    var result = buildShellHtml();
    shellCache.html = result.html;
    shellCache.kid = result.kid;
    shellCache.time = now;
    return shellCache.html;
}

function invalidateCache() {
    shellCache.html = null;
    shellCache.time = 0;
}

fs.watch(path.join(ROOT, 'page.html'), function (event) {
    if (event === 'change') {
        try {
            pageHtmlContent = fs.readFileSync(path.join(ROOT, 'page.html'), 'utf8');
            invalidateCache();
            console.log('[landing] page.html changed, cache invalidated');
        } catch (e) {
            console.error('[landing] failed to reload page.html:', e.message);
        }
    }
});

fs.watch(path.join(ROOT, 'config.json'), function (event) {
    if (event === 'change') {
        try {
            loadConfig();
            invalidateCache();
            console.log('[landing] config.json changed, cache invalidated');
        } catch (e) {
            console.error('[landing] failed to reload config.json:', e.message);
        }
    }
});

// ---------------------------------------------------------------------------
// Rate limiter for POST /key (sliding window: 5 req/min per IP)
// ---------------------------------------------------------------------------

var RATE_MAX = 5;
var RATE_WINDOW = 60000;
var rateMap = new Map();

function checkRate(ip) {
    var now = Date.now();
    var entry = rateMap.get(ip);
    if (!entry || now > entry.reset) {
        entry = { count: 0, reset: now + RATE_WINDOW };
        rateMap.set(ip, entry);
    }
    entry.count++;
    return entry.count <= RATE_MAX;
}

setInterval(function () {
    var now = Date.now();
    rateMap.forEach(function (v, k) {
        if (now > v.reset) rateMap.delete(k);
    });
}, 60000);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', function (req, res) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(getShellHtml());
});

app.get('/favicon.ico', function (req, res) {
    var faviconPath = path.join(ROOT, 'img', 'amylc-logo.png');
    if (fs.existsSync(faviconPath)) {
        res.set('Cache-Control', 'public, max-age=604800');
        res.sendFile(faviconPath);
    } else {
        res.status(404).send();
    }
});

app.post('/key', function (req, res) {
    var ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!checkRate(ip)) {
        return res.status(429).json({ error: 'too many requests' });
    }

    var kid = req.body && req.body.kid;
    var pubKey = req.body && req.body.pubKey;

    if (!kid || !pubKey) {
        return res.status(400).json({ error: 'missing kid or pubKey' });
    }

    var password = keyStore.get(kid);
    if (!password) {
        return res.status(400).json({ error: 'unknown or expired kid' });
    }

    try {
        var encrypted = cryptoNode.publicEncrypt(
            {
                key: pubKey,
                padding: cryptoNode.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            Buffer.from(password, 'utf8')
        );
        res.json({ ek: encrypted.toString('base64') });
    } catch (e) {
        console.error('[landing] RSA encrypt failed:', e.message);
        res.status(400).json({ error: 'invalid public key' });
    }
});

app.use(express.static(ROOT, {
    extensions: ['html'],
    setHeaders: function (res, filePath) {
        if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-store');
        else if (filePath.endsWith('.js') || filePath.endsWith('.css')) res.set('Cache-Control', 'public, max-age=86400');
        else if (filePath.endsWith('.webp') || filePath.endsWith('.png') || filePath.endsWith('.svg')) res.set('Cache-Control', 'public, max-age=604800');
    }
}));

app.use(function (req, res) {
    res.status(404).type('text/html').send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4f8;color:#333}.box{text-align:center}.box h1{font-size:3rem;margin:0;color:#3b82f6}.box p{margin:8px 0 20px;color:#666}a{color:#3b82f6;text-decoration:none}</style></head><body><div class="box"><h1>404</h1><p>页面不存在</p><a href="/">返回首页</a></div></body></html>'
    );
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

var server = app.listen(PORT, function () {
    console.log('[landing] v4.0.0 running on http://localhost:' + PORT);
});

function gracefulShutdown() { console.log('[landing] Shutting down...'); server.close(function () { process.exit(0); }); setTimeout(function () { process.exit(1); }, 5000); }
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
