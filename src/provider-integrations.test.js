// Plain-Node SRP math check (no framework). Run: node src/provider-integrations.test.js
// Exercises the exported __test SRP internals offline — no live Proton credentials needed.
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { __test } = require('./provider-integrations');
const { expandHash, bigIntFromLE, bigIntToLE, modExp, protonHashPassword, protonGenerateProofs } = __test;
const SRP_BYTES = 256;

// --- 1. expandHash: output length + known vector (SHA512(x||0..3), x empty) ---
const expEmpty = expandHash(Buffer.alloc(0));
assert.equal(expEmpty.length, 4 * 64, 'expandHash length');
const KNOWN_EMPTY =
  'b8244d028981d693af7b456af8efa4cad63d282e19ff14942c246e50d9351d22704a802a71c3580b6370de4ceb293c324a8423342557d4e5c38438f0e36910ee' +
  '7b54b66836c1fbdd13d2441d9e1434dc62ca677fb68f5fe66a464baadecdbd00576f8d6b5ac3bcc80844b7d50b1cc6603444bbe7cfcf8fc0aa1ee3c636d9e339' +
  'fab848c9b657a853ee37c09cbfdd149d0b3807b191dde9b623ccd95281dd18705b48c89b1503903845bba5753945351fe6b454852760f73529cf01ca8f69dcca' +
  'e45bf5817ddf94aa2f7a407071f0eedc6beb98f768b4cd33d1176d44d1563a45a5d7212290eb7670c6786b13591aedac86478993895e8b24e612014abaa6ba04';
assert.equal(expEmpty.toString('hex'), KNOWN_EMPTY, 'expandHash known vector');

// --- 2. bigIntFromLE / bigIntToLE round-trip ---
for (const n of [0n, 1n, 0x123456789abcdefn, (1n << 2047n) - 1n]) {
  assert.equal(bigIntFromLE(bigIntToLE(n, SRP_BYTES)), n, `LE round-trip ${n}`);
}

// --- 3. Full SRP proof round-trip vs a fabricated server (RFC 3526 group 14 prime) ---
// The prime literal is big-endian; the wire format is little-endian, so reverse before use.
const modulus = Buffer.from(
  'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f1437' +
  '4fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf05' +
  '98da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3b' +
  'e39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aacaa68ffffffffffffffff',
  'hex'
).reverse();
assert.equal(modulus.length, SRP_BYTES);
const xBytes = protonHashPassword('correct horse battery staple', 4, Buffer.from('0123456789').toString('base64'), modulus);

const N = bigIntFromLE(modulus);
const g = 2n;
const k = bigIntFromLE(expandHash(Buffer.concat([bigIntToLE(g, SRP_BYTES), modulus]))) % N;
const v = modExp(g, bigIntFromLE(xBytes), N);
const b = bigIntFromLE(crypto.randomBytes(32));
const serverEphemeral = bigIntToLE((k * v + modExp(g, b, N)) % N, SRP_BYTES);

const proofs = protonGenerateProofs(modulus, xBytes, serverEphemeral);

// Server recomputes S from (A, u, b) and validates M1/M2
const A = bigIntFromLE(proofs.clientEphemeral);
const u = bigIntFromLE(expandHash(Buffer.concat([proofs.clientEphemeral, serverEphemeral])));
const S = modExp((A * modExp(v, u, N)) % N, b, N);
const sBytes = bigIntToLE(S, SRP_BYTES);
const M1 = expandHash(Buffer.concat([proofs.clientEphemeral, serverEphemeral, sBytes]));
assert.deepEqual(M1, proofs.clientProof, 'M1 agrees with server');
const M2 = expandHash(Buffer.concat([proofs.clientEphemeral, M1, sBytes]));
assert.deepEqual(M2, proofs.expectedServerProof, 'M2 agrees with server');

// --- 4. B = 0 and B = N rejected (go-srp checkParams) ---
assert.throws(() => protonGenerateProofs(modulus, xBytes, Buffer.alloc(SRP_BYTES)), /invalid server ephemeral/);
assert.throws(() => protonGenerateProofs(modulus, xBytes, bigIntToLE(N, SRP_BYTES)), /invalid server ephemeral/);

console.log('PASS');