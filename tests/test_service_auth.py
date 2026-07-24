from __future__ import annotations

import hashlib
import hmac
import unittest
from unittest.mock import patch

from mon_agent_server.service_auth import (
    ServiceAuthenticationError,
    canonical_service_message,
    verify_service_request,
)


class ServiceAuthenticationTest(unittest.TestCase):
    def _headers(self, body: bytes, nonce: str = "nonce-1") -> dict[str, str]:
        timestamp = "1784688000"
        message = canonical_service_message(
            "monos", "self_awake:submit", timestamp, nonce, "POST", "/internal/self-awake/run", body
        )
        signature = hmac.new(b"test-secret", message, hashlib.sha256).hexdigest()
        return {
            "X-Mon-Service-ID": "monos",
            "X-Mon-Service-Scope": "self_awake:submit",
            "X-Mon-Service-Timestamp": timestamp,
            "X-Mon-Service-Nonce": nonce,
            "X-Mon-Service-Signature": signature,
        }

    @patch.dict("os.environ", {"MON_SERVICE_SHARED_SECRET": "test-secret"})
    @patch("mon_agent_server.service_auth.time.time", return_value=1784688000)
    def test_valid_signed_request_is_accepted(self, _time):
        body = b'{"job_id":"job-1"}'
        service_id = verify_service_request(
            self._headers(body, "valid-nonce"), "POST", "/internal/self-awake/run", body, "self_awake:submit"
        )
        self.assertEqual(service_id, "monos")

    @patch.dict("os.environ", {"MON_SERVICE_SHARED_SECRET": "test-secret"})
    @patch("mon_agent_server.service_auth.time.time", return_value=1784688000)
    def test_nonce_cannot_be_replayed(self, _time):
        body = b"{}"
        headers = self._headers(body, "replayed-nonce")
        verify_service_request(headers, "POST", "/internal/self-awake/run", body, "self_awake:submit")
        with self.assertRaises(ServiceAuthenticationError):
            verify_service_request(headers, "POST", "/internal/self-awake/run", body, "self_awake:submit")


if __name__ == "__main__":
    unittest.main()
