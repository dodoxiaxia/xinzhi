'use strict';
// Test-only. Workers' crypto.subtle.digest supports MD5 (non-standard, for legacy formats such as PDF encryption keys):
// https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ (footnote 3). Node's Web Crypto does not, so Node
// test runs give the Worker code the same capability from node:crypto. Everything else is Node's own Web Crypto.
const {createHash, webcrypto} = require('crypto');
function withMd5(base = webcrypto) {
  const subtle = {};
  for (const name of ['decrypt', 'deriveBits', 'deriveKey', 'digest', 'encrypt', 'exportKey', 'generateKey', 'importKey', 'sign', 'unwrapKey', 'verify', 'wrapKey']) subtle[name] = base.subtle[name].bind(base.subtle);
  subtle.digest = (algorithm, data) => {
    if (String(algorithm && algorithm.name || algorithm).toUpperCase() !== 'MD5') return base.subtle.digest(algorithm, data);
    const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    return Promise.resolve(new Uint8Array(createHash('md5').update(view).digest()).buffer);
  };
  return {subtle, getRandomValues:base.getRandomValues.bind(base), randomUUID:base.randomUUID.bind(base)};
}
module.exports = {withMd5};
