"use strict";

/* =========================================================
   PRIVATE TASK ENCRYPTION
   Client-side only, via the browser's native Web Crypto API —
   no external dependency. Per private task: PBKDF2-HMAC-SHA256
   derives key material from the user's key + a random salt;
   AES-GCM (with a fresh IV every encryption) protects the
   description; a separate SHA-256 hash of the derived bits acts
   as a verifier so a leaked verifier can never be used to
   reconstruct the actual AES key. The derived bits themselves
   are never persisted or logged — only ever held in a local
   variable for the duration of one operation.
   ========================================================= */
export var PBKDF2_ITERATIONS = 275000;

function b64FromBytes(bytes){
  var bin = '';
  var arr = new Uint8Array(bytes);
  for(var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}
function bytesFromB64(b64){
  var bin = atob(b64);
  var arr = new Uint8Array(bin.length);
  for(var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function utf8Bytes(str){
  return new TextEncoder().encode(str);
}
function utf8String(bytes){
  return new TextDecoder().decode(bytes);
}

export async function generateSalt(){
  return b64FromBytes(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveKeyMaterial(password, saltB64, iterations){
  var keyMaterial = await crypto.subtle.importKey('raw', utf8Bytes(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    {name: 'PBKDF2', salt: bytesFromB64(saltB64), iterations: iterations || PBKDF2_ITERATIONS, hash: 'SHA-256'},
    keyMaterial,
    256
  );
}

export async function computeVerifier(derivedBits){
  var digest = await crypto.subtle.digest('SHA-256', derivedBits);
  return b64FromBytes(digest);
}

async function importAesKey(derivedBits){
  return crypto.subtle.importKey('raw', derivedBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptText(plaintext, derivedBits){
  var key = await importAesKey(derivedBits);
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv: iv}, key, utf8Bytes(plaintext));
  return {ciphertext: b64FromBytes(ciphertext), iv: b64FromBytes(iv)};
}

export async function decryptText(ciphertextB64, ivB64, derivedBits){
  var key = await importAesKey(derivedBits);
  var plainBytes = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: bytesFromB64(ivB64)},
    key,
    bytesFromB64(ciphertextB64)
  );
  return utf8String(plainBytes);
}
