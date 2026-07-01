async function aesDecrypt(encrypted, pass) {
    var raw = atob(encrypted);
    var rawLen = raw.length;
    var bytes = new Uint8Array(rawLen);
    for (var i = 0; i < rawLen; i++) bytes[i] = raw.charCodeAt(i);

    var ivBytes = bytes.subarray(0, 16);
    var cipherBytes = bytes.subarray(16);

    var passBytes = new TextEncoder().encode(pass);
    var keyHash = await crypto.subtle.digest('SHA-256', passBytes);
    var key = await crypto.subtle.importKey('raw', keyHash, { name: 'AES-CBC' }, false, ['decrypt']);
    var decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, cipherBytes);
    return new TextDecoder().decode(decrypted);
}

async function generateRSAKeyPair() {
    return crypto.subtle.generateKey(
        {
            name: 'RSA-OAEP',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256'
        },
        true,
        ['encrypt', 'decrypt']
    );
}

async function exportPublicKey(keyPair) {
    var spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    var bytes = new Uint8Array(spki);
    var b64 = btoa(String.fromCharCode.apply(null, bytes));
    var pem = '-----BEGIN PUBLIC KEY-----\n';
    for (var i = 0; i < b64.length; i += 64) {
        pem += b64.substring(i, Math.min(i + 64, b64.length)) + '\n';
    }
    pem += '-----END PUBLIC KEY-----';
    return pem;
}

async function decryptAESKey(privateKey, encryptedBase64) {
    var raw = atob(encryptedBase64);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    var decrypted = await crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        privateKey,
        bytes
    );
    return new TextDecoder().decode(decrypted);
}

async function doKeyExchange(kid) {
    var lastErr = null;
    for (var attempt = 0; attempt < 3; attempt++) {
        try {
            var keyPair = await generateRSAKeyPair();
            var pubKeyPem = await exportPublicKey(keyPair);

            var resp = await fetch('/key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kid: kid, pubKey: pubKeyPem })
            });

            if (!resp.ok) {
                var txt = await resp.text();
                throw new Error('Server returned ' + resp.status + ': ' + txt);
            }

            var data = await resp.json();
            if (!data.ek) throw new Error('Missing ek in response');

            var password = await decryptAESKey(keyPair.privateKey, data.ek);
            return password;
        } catch (e) {
            lastErr = e;
            if (attempt < 2) {
                await new Promise(function (r) { setTimeout(r, 1000); });
            }
        }
    }
    throw lastErr || new Error('Key exchange failed after 3 attempts');
}
