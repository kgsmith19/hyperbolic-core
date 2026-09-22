"""Ephemeral In-Memory Encrypted Storage & Memory Zeroization Buffer.

Enforces zero-data-retention invariants:
- SecureZeroBuffer: Pinned memory buffer that zeroes bytes in-place via ctypes.memset.
- EphemeralEncryptedScratch: Volatile in-memory store encrypted with 256-bit AES-GCM.
"""

import ctypes
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class SecureZeroBuffer:
    """A mutable in-memory byte buffer that is scrubbed with zeros upon release."""

    def __init__(self, initial_data: bytes | str | None = None):
        self._is_zeroized = False
        if initial_data is None:
            self._size = 0
            self._buf = None
        else:
            raw_bytes = initial_data.encode("utf-8") if isinstance(initial_data, str) else bytes(initial_data)
            self._size = len(raw_bytes)
            self._buf = ctypes.create_string_buffer(raw_bytes, self._size)

    def write(self, data: bytes | str) -> None:
        """Write new data to the buffer, zeroizing any previous allocation."""
        if self._buf is not None and not self._is_zeroized:
            self.zeroize()

        raw_bytes = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        self._size = len(raw_bytes)
        self._buf = ctypes.create_string_buffer(raw_bytes, self._size)
        self._is_zeroized = False

    def read(self) -> bytes:
        """Read buffer contents as bytes."""
        if self._is_zeroized or self._buf is None:
            raise ValueError("Buffer has been zeroized and cannot be read.")
        return self._buf.raw[:self._size]

    def read_text(self, encoding: str = "utf-8", errors: str = "replace") -> str:
        """Read buffer contents as a string."""
        return self.read().decode(encoding, errors=errors)

    def zeroize(self) -> None:
        """Explicitly scrub memory bytes in-place with zeros."""
        if self._buf is not None and not self._is_zeroized:
            ctypes.memset(ctypes.addressof(self._buf), 0, len(self._buf))
            self._is_zeroized = True

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.zeroize()

    def __del__(self):
        try:
            self.zeroize()
        except Exception:
            pass


class EphemeralEncryptedScratch:
    """In-memory key-value scratchpad encrypted with a volatile 256-bit AES-GCM key."""

    def __init__(self):
        self._key_bytes = bytearray(AESGCM.generate_key(bit_length=256))
        self._aesgcm = AESGCM(bytes(self._key_bytes))
        self._store: dict[str, tuple[bytes, bytearray]] = {}
        self._is_wiped = False

    def store(self, key: str, data: str | bytes) -> None:
        """Encrypt data and store in memory."""
        if self._is_wiped:
            raise RuntimeError("Scratchpad has been wiped.")
        raw_bytes = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        nonce = os.urandom(12)
        ciphertext = self._aesgcm.encrypt(nonce, raw_bytes, None)
        self._store[key] = (nonce, bytearray(ciphertext))

    def retrieve(self, key: str) -> str:
        """Decrypt data from memory."""
        if self._is_wiped:
            raise RuntimeError("Scratchpad has been wiped.")
        if key not in self._store:
            raise KeyError(f"Key '{key}' not found in scratchpad.")
        nonce, ct_bytes = self._store[key]
        plaintext = self._aesgcm.decrypt(nonce, bytes(ct_bytes), None)
        return plaintext.decode("utf-8", errors="replace")

    def delete(self, key: str) -> None:
        """Zeroize and remove a specific entry from memory."""
        if key in self._store:
            _, ct_bytes = self._store[key]
            buf_ptr = (ctypes.c_char * len(ct_bytes)).from_buffer(ct_bytes)
            ctypes.memset(ctypes.addressof(buf_ptr), 0, len(ct_bytes))
            del self._store[key]

    def wipe(self) -> None:
        """Zeroize all stored ciphertexts, keys, and clear the scratchpad."""
        if self._is_wiped:
            return
        for key in list(self._store.keys()):
            self.delete(key)
        self._store.clear()

        # Zeroize the master AES key in memory
        key_ptr = (ctypes.c_char * len(self._key_bytes)).from_buffer(self._key_bytes)
        ctypes.memset(ctypes.addressof(key_ptr), 0, len(self._key_bytes))
        self._is_wiped = True

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.wipe()

    def __del__(self):
        try:
            self.wipe()
        except Exception:
            pass
