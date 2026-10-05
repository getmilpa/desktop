#!/usr/bin/env python3
# Writes test/pin-vectors.json: what Yubico's python-fido2 computes for the PIN/UV auth protocols, over random
# inputs. security-key/pin.js must produce the same bytes (test/security-key.js) — an independent implementation
# agreeing is what stands between a bug there and a person's PIN attempts. Touches no device: only the math.
#
#   python3 test/pin-vectors.py > test/pin-vectors.json      (needs python-fido2 and cryptography)
import json, os, sys
import fido2
from hashlib import sha256
from cryptography.hazmat.primitives.asymmetric import ec
from fido2.ctap2.pin import PinProtocolV1, PinProtocolV2

h = lambda b: b.hex()
def keypair():
    k = ec.generate_private_key(ec.SECP256R1())
    n = k.public_key().public_numbers()
    return k, k.private_numbers().private_value.to_bytes(32, 'big'), n.x.to_bytes(32, 'big'), n.y.to_bytes(32, 'big')

cases = []
for version, proto in ((1, PinProtocolV1()), (2, PinProtocolV2())):
    for pin in ('1234', '123456', 'correct horse battery staple', 'ñandú-0000', 'été 2026'):
        key, _, kx, ky = keypair()                      # the security key's side
        platform, pd, _, _ = keypair()                  # this process's side
        z = key.exchange(ec.ECDH(), platform.public_key())
        secret = proto.kdf(z)
        import unicodedata
        pin_hash = sha256(unicodedata.normalize('NFC', pin).encode()).digest()[:16]
        enc = proto.encrypt(secret, pin_hash)
        token = os.urandom(32)
        token_enc = proto.encrypt(secret, token)
        message = os.urandom(32)
        cases.append({
            'protocol': version, 'pin': pin, 'key_x': h(kx), 'key_y': h(ky), 'platform_private': h(pd),
            'secret': h(secret), 'iv': h(enc[:16]) if version == 2 else None, 'pin_hash_enc': h(enc),
            'token': h(token), 'token_enc': h(token_enc), 'message': h(message), 'auth': h(proto.authenticate(token, message)),
        })
json.dump({'from': 'python-fido2 ' + fido2.__version__, 'cases': cases}, sys.stdout, indent=1, ensure_ascii=False)
print()
