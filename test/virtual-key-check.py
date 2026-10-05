#!/usr/bin/env python3
# The software key (test/virtual-key.js) under Yubico's own client, python-fido2: its CTAPHID framing, its PIN
# protocols and its WebAuthn verification — none of it the Desktop's code. If this passes, the key the Desktop is
# measured against is a key by somebody else's reading of the standard too.
#
#   node test/virtual-key.js /tmp/key.sock 1234 &   then   python3 test/virtual-key-check.py /tmp/key.sock
#
# It opens the socket it is given and nothing else: no hidraw device, no real key.
import socket, sys, os
from fido2.hid import CtapHidDevice
from fido2.hid.base import CtapHidConnection, HidDescriptor
from fido2.ctap import CtapError
from fido2.ctap2 import Ctap2
from fido2.ctap2.pin import ClientPin
from fido2.webauthn import AttestedCredentialData, AuthenticatorData
from fido2.attestation import PackedAttestation
from hashlib import sha256

class SocketConnection(CtapHidConnection):
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); self.s.connect(path)
    def read_packet(self):
        b = b''
        while len(b) < 64:
            c = self.s.recv(64 - len(b))
            if not c: raise OSError('closed')
            b += c
        return b
    def write_packet(self, data): self.s.sendall(data)
    def close(self): self.s.close()

ok = True
def check(name, cond, detail=''):
    global ok; ok = ok and bool(cond)
    print(('PASS' if cond else 'FAIL') + ' · ' + name + ('' if cond or not detail else ' — ' + str(detail)))

path = sys.argv[1]
dev = CtapHidDevice(HidDescriptor(path, 0x1050, 0x0407, 64, 64, 'virtual', None), SocketConnection(path))
ctap = Ctap2(dev)
info = ctap.get_info()
check('getInfo: a CTAP2 key with a PIN and no verification of its own', info.options.get('clientPin') is True and not info.options.get('uv'), info.options)
RP = {'id': 'localhost', 'name': 'Milpa'}; USER = {'id': b'u' * 16, 'name': 'operator'}; PARAMS = [{'type': 'public-key', 'alg': -7}]
for version in info.pin_uv_protocols:
    proto = next(p for p in ClientPin.PROTOCOLS if p.VERSION == version)()
    pin = ClientPin(ctap, proto)
    before = pin.get_pin_retries()[0]
    try:
        pin.get_pin_token('9999', ClientPin.PERMISSION.MAKE_CREDENTIAL, 'localhost'); check(f'v{version}: a wrong PIN is refused', False)
    except CtapError as e:
        check(f'v{version}: a wrong PIN is refused as PIN_INVALID', e.code == CtapError.ERR.PIN_INVALID, e)
    check(f'v{version}: …and cost one attempt', pin.get_pin_retries()[0] == before - 1, (before, pin.get_pin_retries()[0]))
    try:
        ctap.make_credential(sha256(b'x').digest(), RP, USER, PARAMS); check(f'v{version}: no credential without the PIN\'s proof', False)
    except CtapError as e:
        check(f'v{version}: no credential without the PIN\'s proof', e.code == CtapError.ERR.PUAT_REQUIRED, e)
    token = pin.get_pin_token('1234', ClientPin.PERMISSION.MAKE_CREDENTIAL, 'localhost')
    check(f'v{version}: the right PIN restores the attempts', pin.get_pin_retries()[0] == 8)
    cdh = sha256(os.urandom(32)).digest()
    att = ctap.make_credential(cdh, RP, USER, PARAMS, pin_uv_param=proto.authenticate(token, cdh), pin_uv_protocol=version)
    check(f'v{version}: makeCredential answers with user verification set', att.auth_data.flags & AuthenticatorData.FLAG.UV and att.auth_data.flags & AuthenticatorData.FLAG.UP)
    try:
        PackedAttestation().verify(att.att_stmt, att.auth_data, cdh); check(f'v{version}: its attestation verifies (packed, self)', True)
    except Exception as e:
        check(f'v{version}: its attestation verifies (packed, self)', False, e)
    cred = att.auth_data.credential_data
    token = pin.get_pin_token('1234', ClientPin.PERMISSION.GET_ASSERTION, 'localhost')
    cdh = sha256(os.urandom(32)).digest()
    a = ctap.get_assertion('localhost', cdh, [{'type': 'public-key', 'id': cred.credential_id}], pin_uv_param=proto.authenticate(token, cdh), pin_uv_protocol=version)
    try:
        cred.public_key.verify(a.auth_data + cdh, a.signature); check(f'v{version}: its assertion verifies under the credential\'s key, with user verification', bool(a.auth_data.flags & AuthenticatorData.FLAG.UV))
    except Exception as e:
        check(f'v{version}: its assertion verifies under the credential\'s key', False, e)
    try:
        ctap.get_assertion('localhost', cdh, [{'type': 'public-key', 'id': cred.credential_id}], pin_uv_param=proto.authenticate(os.urandom(32), cdh), pin_uv_protocol=version); check(f'v{version}: a proof made with another token is refused', False)
    except CtapError as e:
        check(f'v{version}: a proof made with another token is refused', e.code == CtapError.ERR.PIN_AUTH_INVALID, e)
dev.close()
sys.exit(0 if ok else 1)
