use std::collections::HashMap;
use std::ffi::CStr;
use std::sync::Mutex;
use std::time::{SystemTime, Duration};
use libc::c_char;
use rand::Rng;
use lazy_static::lazy_static;
use ethers::types::{Address, Signature};
use ethers::utils::{to_checksum, keccak256};
use ethers::core::k256::ecdsa::{VerifyingKey, signature::Verifier};
use serde_json::json;
use thiserror::Error;

// Multicodec for secp256k1-pub (compressed)
const SECP256K1_MULTICODEC: &[u8] = &[0xe7, 0x01];

// --- Custom Error Type ---
#[derive(Error, Debug)]
enum ArkenAuthError {
    #[error("Invalid Authorization header format")]
    InvalidHeaderFormat,
    #[error("Missing '{0}' in Authorization header")]
    MissingHeaderPart(&'static str),
    #[error("Invalid or expired nonce")]
    InvalidNonce,
    #[error("Invalid DID format: {0}")]
    InvalidDidFormat(String),
    #[error("Unsupported DID method: {0}")]
    UnsupportedDidMethod(String),
    #[error("Failed to decode did:key: {0}")]
    DidKeyDecodeError(String),
    #[error("Unsupported key type (multicodec): 0x{0:x}")]
    UnsupportedKeyType(u16),
    #[error("Invalid public key")]
    InvalidPublicKey,
    #[error("Invalid signature format")]
    InvalidSignatureFormat,
    #[error("Signature recovery failed")]
    SignatureRecoveryError,
    #[error("Signature is invalid")]
    SignatureMismatch,
}

// --- Global tokio runtime — created once, reused on every FFI call ---
lazy_static! {
    static ref RT: tokio::runtime::Runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime");
}

// --- Thread-Safe Nonce Store ---
// Used only by the legacy verify_request_into flow.
// The new verify_signature_only_into flow manages nonces externally (Node.js/Python).
lazy_static! {
    static ref NONCE_STORE: Mutex<HashMap<String, SystemTime>> = Mutex::new(HashMap::new());
}

fn add_nonce() -> String {
    let nonce: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    let mut store = NONCE_STORE.lock().expect("Nonce store mutex poisoned");
    // Sweep expired nonces on every insert so the store stays bounded.
    // This matters when generate_challenge_into is called but verify_request_into never is
    // (e.g. when the caller uses the external-nonce flow via verify_signature_only_into).
    let now = SystemTime::now();
    store.retain(|_, ts| now.duration_since(*ts).unwrap_or_default() < Duration::from_secs(60));
    store.insert(nonce.clone(), now);
    nonce
}

fn validate_nonce(nonce: &str) -> bool {
    let mut store = NONCE_STORE.lock().expect("Nonce store mutex poisoned");
    if let Some(timestamp) = store.get(nonce) {
        if SystemTime::now().duration_since(*timestamp).unwrap_or_default() < Duration::from_secs(60) {
            return store.remove(nonce).is_some();
        }
    }
    false
}

// --- DID Key Parsing ---

/// Parse a did:key identifier and extract the Ethereum address plus canonical DID string.
///
/// Only the canonical multibase form (`did:key:z...`, base58btc-encoded) is accepted.
/// The 0x Ethereum-address form is rejected: one key must map to exactly one DID.
///
/// Returns `(address, canonical_did)` where `canonical_did` is re-encoded from the
/// extracted public key bytes, guaranteeing a stable output regardless of how the
/// client encoded the input.
fn parse_did_key(did: &str) -> Result<(Address, String), ArkenAuthError> {
    let key_part = did.strip_prefix("did:key:")
        .ok_or_else(|| ArkenAuthError::InvalidDidFormat("Missing 'did:key:' prefix".to_string()))?;

    if key_part.starts_with('z') {
        parse_multibase_did_key(key_part)
    } else {
        Err(ArkenAuthError::InvalidDidFormat(
            "Only did:key:z... (multibase base58btc) is accepted; did:key:0x... is not supported".to_string()
        ))
    }
}

/// Parse a canonical did:key with multibase base58btc encoding.
///
/// Returns `(ethereum_address, canonical_did_string)`.
/// The canonical DID is re-encoded from the extracted compressed public key bytes,
/// so the output is always in the same form regardless of how the caller encoded
/// the input (guards against capitalisation or non-minimal encoding variants).
fn parse_multibase_did_key(encoded: &str) -> Result<(Address, String), ArkenAuthError> {
    // Decode base58btc — skip the 'z' multibase prefix
    let decoded = bs58::decode(&encoded[1..])
        .into_vec()
        .map_err(|e| ArkenAuthError::DidKeyDecodeError(format!("Base58 decode failed: {}", e)))?;

    if decoded.len() < 3 {
        return Err(ArkenAuthError::DidKeyDecodeError("Decoded data too short".to_string()));
    }

    // Verify multicodec prefix: 0xe7 0x01 = secp256k1-pub compressed
    if decoded.len() < SECP256K1_MULTICODEC.len() || &decoded[..SECP256K1_MULTICODEC.len()] != SECP256K1_MULTICODEC {
        let codec = if decoded.len() >= 2 {
            ((decoded[0] as u16) << 8) | (decoded[1] as u16)
        } else {
            decoded[0] as u16
        };
        return Err(ArkenAuthError::UnsupportedKeyType(codec));
    }

    // Extract the 33-byte compressed public key
    let key_bytes = &decoded[SECP256K1_MULTICODEC.len()..];
    if key_bytes.len() != 33 {
        return Err(ArkenAuthError::InvalidPublicKey);
    }

    // Derive Ethereum address: last 20 bytes of keccak256(uncompressed_key)
    let verifying_key = VerifyingKey::from_sec1_bytes(key_bytes)
        .map_err(|_| ArkenAuthError::InvalidPublicKey)?;

    let uncompressed       = verifying_key.to_encoded_point(false);
    let uncompressed_bytes = &uncompressed.as_bytes()[1..]; // skip 0x04 prefix
    let hash               = keccak256(uncompressed_bytes);
    let address_bytes: [u8; 20] = hash[12..].try_into().unwrap();
    let address = Address::from(address_bytes);

    // Re-encode to canonical DID — deterministic from key_bytes.
    // This normalises any non-canonical encoding the client may have sent.
    let mut canonical_payload = Vec::with_capacity(SECP256K1_MULTICODEC.len() + key_bytes.len());
    canonical_payload.extend_from_slice(SECP256K1_MULTICODEC);
    canonical_payload.extend_from_slice(key_bytes);
    let canonical_did = format!("did:key:z{}", bs58::encode(canonical_payload).into_string());

    Ok((address, canonical_did))
}

// --- Signature Verification ---

fn parse_auth_header(auth_header: &str) -> Result<(String, String, String), ArkenAuthError> {
    if !auth_header.starts_with("Signature ") {
        return Err(ArkenAuthError::InvalidHeaderFormat);
    }

    let parts: HashMap<&str, &str> = auth_header[10..].split(',')
        .filter_map(|s| {
            let mut split = s.trim().splitn(2, '=');
            let key = split.next()?;
            let value = split.next()?;
            Some((key, value.trim_matches('"')))
        })
        .collect();

    let did = parts.get("did").ok_or(ArkenAuthError::MissingHeaderPart("did"))?.to_string();
    let nonce = parts.get("nonce").ok_or(ArkenAuthError::MissingHeaderPart("nonce"))?.to_string();
    let signature_hex = parts.get("signature").ok_or(ArkenAuthError::MissingHeaderPart("signature"))?.to_string();

    Ok((did, nonce, signature_hex))
}

/// Verify an ECDSA signature against an arbitrary message.
///
/// Returns the canonical DID string on success (re-encoded from the public key).
/// `message` is the canonical signed message built by `buildSignedMessage()`.
fn verify_signature(did: &str, message: &str, signature_hex: &str) -> Result<String, ArkenAuthError> {
    let (expected_address, canonical_did) = parse_did_key(did)?;

    let sig: Signature = signature_hex.parse()
        .map_err(|_| ArkenAuthError::InvalidSignatureFormat)?;

    // Ethereum personal-sign: same scheme used by the client (eth_sign / signMessage).
    let recovered_address = sig.recover(message.as_bytes())
        .map_err(|_| ArkenAuthError::SignatureRecoveryError)?;

    if to_checksum(&recovered_address, None) != to_checksum(&expected_address, None) {
        return Err(ArkenAuthError::SignatureMismatch);
    }

    Ok(canonical_did)
}

async fn verify_logic(auth_header: &str) -> Result<String, ArkenAuthError> {
    let (did, nonce, signature_hex) = parse_auth_header(auth_header)?;

    if !validate_nonce(&nonce) {
        return Err(ArkenAuthError::InvalidNonce);
    }

    // Legacy path: sign just the nonce (no audience binding).
    // Kept for internal tooling only; prefer verify_signature_only_logic.
    let canonical_did = verify_signature(&did, &nonce, &signature_hex)?;

    Ok(canonical_did)
}

/// verify_signature_only: crypto verification without internal nonce check.
///
/// `signed_message` is the canonical message built by `buildSignedMessage()` in
/// the middleware/client — it already contains host, method, path, body hash,
/// nonce, and expiry.  Rust verifies the signature against that exact string.
///
/// Returns { status, did, nonce } on success so the caller can consume the nonce.
async fn verify_signature_only_logic(auth_header: &str, signed_message: &str) -> Result<(String, String), ArkenAuthError> {
    let (did, nonce, signature_hex) = parse_auth_header(auth_header)?;
    // verify_signature returns the canonical DID re-encoded from the public key bytes.
    let canonical_did = verify_signature(&did, signed_message, &signature_hex)?;
    Ok((canonical_did, nonce))
}

// --- FFI Layer ---
//
// Buffer-based API: caller provides an output buffer; we write the JSON result
// into it and return the byte count. Returns -1 if the buffer is too small.
// No heap allocation returned to the caller — no free_string needed.

unsafe fn write_to_buf(s: &str, out: *mut c_char, cap: usize) -> i32 {
    let bytes = s.as_bytes();
    if bytes.len() >= cap {
        return -1;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr() as *const c_char, out, bytes.len());
    *out.add(bytes.len()) = 0;
    bytes.len() as i32
}

#[no_mangle]
pub extern "C" fn generate_challenge_into(
    statement_ptr: *const c_char,
    out: *mut c_char,
    cap: usize,
) -> i32 {
    let statement = unsafe { CStr::from_ptr(statement_ptr).to_str().unwrap_or("") };
    let nonce = add_nonce();
    let response = json!({ "challenge": { "nonce": nonce, "statement": statement } });
    unsafe { write_to_buf(&response.to_string(), out, cap) }
}

#[no_mangle]
pub extern "C" fn verify_request_into(
    auth_header_ptr: *const c_char,
    out: *mut c_char,
    cap: usize,
) -> i32 {
    let auth_header = match unsafe { CStr::from_ptr(auth_header_ptr).to_str() } {
        Ok(s) => s,
        Err(_) => {
            let msg = json!({"status": "error", "message": "Invalid UTF-8 in header"}).to_string();
            return unsafe { write_to_buf(&msg, out, cap) };
        }
    };

    let result = RT.block_on(verify_logic(auth_header));

    let response = match result {
        Ok(did) => json!({"status": "success", "did": did}),
        Err(e) => json!({"status": "error", "message": e.to_string()}),
    };

    unsafe { write_to_buf(&response.to_string(), out, cap) }
}

/// Verify signature only — no internal nonce check.
///
/// BREAKING (v1): gains a second `message` parameter — the canonical signed
/// message built by the middleware from actual request fields.
/// Callers must recompile after this change.
///
/// Returns { status, did, nonce } so the caller can consume the nonce from its store.
#[no_mangle]
pub extern "C" fn verify_signature_only_into(
    auth_header_ptr: *const c_char,
    message_ptr: *const c_char,
    out: *mut c_char,
    cap: usize,
) -> i32 {
    let auth_header = match unsafe { CStr::from_ptr(auth_header_ptr).to_str() } {
        Ok(s) => s,
        Err(_) => {
            let msg = json!({"status": "error", "message": "Invalid UTF-8 in header"}).to_string();
            return unsafe { write_to_buf(&msg, out, cap) };
        }
    };

    let signed_message = match unsafe { CStr::from_ptr(message_ptr).to_str() } {
        Ok(s) => s,
        Err(_) => {
            let msg = json!({"status": "error", "message": "Invalid UTF-8 in message"}).to_string();
            return unsafe { write_to_buf(&msg, out, cap) };
        }
    };

    let result = RT.block_on(verify_signature_only_logic(auth_header, signed_message));

    let response = match result {
        Ok((did, nonce)) => json!({"status": "success", "did": did, "nonce": nonce}),
        Err(e) => json!({"status": "error", "message": e.to_string()}),
    };

    unsafe { write_to_buf(&response.to_string(), out, cap) }
}
