'use strict';

const koffi = require('koffi');
const path = require('path');
const os = require('os');

const BUF_SIZE = 65536;

// ---------------------------------------------------------------------------
// Native library loader
// ---------------------------------------------------------------------------

function getLibPath() {
    const pkgName = `@arkenforge/core-${os.platform()}-${os.arch()}`;
    try {
        return require(pkgName);
    } catch (_) {}

    const ext = { win32: '.dll', darwin: '.dylib' }[os.platform()] ?? '.so';
    const prefix = os.platform() === 'win32' ? '' : 'lib';
    return path.join(__dirname, '..', 'bin', `${prefix}arken_core${ext}`);
}

class ArkenCore {
    constructor() {
        const libPath = getLibPath();
        try {
            const lib = koffi.load(libPath);
            this._generate      = lib.func('int generate_challenge_into(const char *statement, char *out, int cap)');
            this._verify        = lib.func('int verify_request_into(const char *header, char *out, int cap)');
            // BREAKING (v1): gains a second 'message' argument — the canonical signed message
            // built by the middleware from actual request fields.
            // Rust's verify_signature_only_into must be recompiled to match.
            this._verifySigOnly = lib.func('int verify_signature_only_into(const char *header, const char *message, char *out, int cap)');
        } catch (err) {
            throw new Error(
                `@arkenforge/core: could not load native library at ${libPath}.\n` +
                `Run 'cargo build --release' in the rust/ directory.\n` +
                `Requires Rust: https://rustup.rs\n\nOriginal error: ${err.message}`
            );
        }
    }

    _call(fn, ...args) {
        const buf = Buffer.alloc(BUF_SIZE);
        const len = fn(...args, buf, BUF_SIZE);
        if (len < 0) throw new Error('@arkenforge/core: output buffer too small');
        return JSON.parse(buf.slice(0, len).toString('utf8'));
    }

    generateChallenge(statement = 'Sign this message to prove you control this DID.') {
        return this._call(this._generate, statement);
    }

    verifyRequest(authHeader) {
        return this._call(this._verify, authHeader);
    }

    /**
     * Verify signature only — nonce lifecycle is managed by the caller.
     *
     * @param {string} authHeader  – "Signature did=...,nonce=...,signature=..."
     * @param {string} signedMessage – canonical message built by buildSignedMessage()
     *   from actual request fields (host, method, path, bodyHash, nonce, expires).
     *   Rust verifies the ECDSA signature against this exact string.
     * @returns {{ status: string, did: string, nonce: string }}
     */
    verifySignatureOnly(authHeader, signedMessage) {
        return this._call(this._verifySigOnly, authHeader, signedMessage);
    }
}

let _core = null;
function getCore() {
    if (!_core) _core = new ArkenCore();
    return _core;
}

// ---------------------------------------------------------------------------
// Nonce stores
// BREAKING (v1):
//   set(nonce)     → now returns number (expires, Unix seconds)
//   consume(nonce) → now returns {valid: boolean, expires: number|null}
//     so the middleware can rebuild the signed message using the stored expiry
//     rather than trusting a client-supplied value.
// ---------------------------------------------------------------------------

const NONCE_TTL_S = 60;

class MemoryNonceStore {
    constructor() {
        // Value stored: Unix-second expiry (number)
        this._store = new Map();
        // Sweep expired nonces every 30 s
        this._sweep = setInterval(() => {
            const now = Math.floor(Date.now() / 1000);
            for (const [nonce, exp] of this._store) {
                if (exp < now) this._store.delete(nonce);
            }
        }, 30_000).unref();
    }

    /**
     * Store a nonce and return its expiry as Unix seconds.
     * @param {string} nonce
     * @returns {Promise<number>} expires
     */
    async set(nonce) {
        const expires = Math.floor(Date.now() / 1000) + NONCE_TTL_S;
        this._store.set(nonce, expires);
        return expires;
    }

    /**
     * Consume a nonce atomically (single-use).
     * @param {string} nonce
     * @returns {Promise<{valid: boolean, expires: number|null}>}
     */
    async consume(nonce) {
        const expires = this._store.get(nonce);
        if (expires === undefined) return { valid: false, expires: null };
        this._store.delete(nonce);
        return { valid: Math.floor(Date.now() / 1000) < expires, expires };
    }
}

class RedisNonceStore {
    constructor(client, ttlSeconds = NONCE_TTL_S) {
        this._client = client;
        this._ttl = ttlSeconds;
    }

    /**
     * Store a nonce and return its expiry as Unix seconds.
     * @param {string} nonce
     * @returns {Promise<number>} expires
     */
    async set(nonce) {
        const expires = Math.floor(Date.now() / 1000) + this._ttl;
        // Store the expiry value so consume() can return it.
        await this._client.set(`arken:nonce:${nonce}`, String(expires), { EX: this._ttl });
        return expires;
    }

    /**
     * Consume a nonce atomically — requires Redis 6.2+ for getDel.
     * @param {string} nonce
     * @returns {Promise<{valid: boolean, expires: number|null}>}
     */
    async consume(nonce) {
        const key = `arken:nonce:${nonce}`;
        // getDel is atomic: get and delete in one round-trip.
        const val = await this._client.getDel(key);
        if (val === null) return { valid: false, expires: null };
        const expires = parseInt(val, 10);
        return { valid: Math.floor(Date.now() / 1000) < expires, expires };
    }
}

module.exports = { ArkenCore, MemoryNonceStore, RedisNonceStore, getCore };
