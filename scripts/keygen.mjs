// Prints a new MARKET_SIGNING_KEY (Ed25519 seed) and its public key.
// Store the seed with: npx wrangler secret put MARKET_SIGNING_KEY
import { webcrypto as crypto } from "node:crypto";

const seed = crypto.getRandomValues(new Uint8Array(32));
const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
const { x } = await crypto.subtle.exportKey("jwk", key);
console.log(`MARKET_SIGNING_KEY=${Buffer.from(seed).toString("base64url")}`);
console.log(`public key (nodes pin this on first check-in): ${x}`);
