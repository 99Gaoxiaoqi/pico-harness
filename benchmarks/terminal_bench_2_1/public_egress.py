from __future__ import annotations

import base64
import binascii
import hmac
import http.client
import ipaddress
import json
import math
import selectors
import socket
import ssl
import threading
import time
from collections.abc import Callable, Iterable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, NamedTuple
from urllib.parse import SplitResult, urlsplit

PROXY_POLICY_VERSION = 1
DEFAULT_MAX_CONNECTIONS = 32
DEFAULT_MAX_TOTAL_BYTES = 1_073_741_824
DEFAULT_MAX_REQUESTS = 4_096
MAX_CONFIGURED_REQUESTS = 1_000_000
ALLOWED_HTTP_PORTS = (80,)
ALLOWED_CONNECT_PORTS = (443,)
PUBLIC_EGRESS_BIND_HOST = "0.0.0.0"  # nosec B104
PUBLIC_EGRESS_CONNECTION_TIMEOUT_SEC = 120.0
CONNECT_ATTEMPT_TIMEOUT_SEC = 10.0
CLIENT_HEADER_TIMEOUT_SEC = 15.0
MAX_AUDIT_DECISIONS = 256
MAX_HOST_LENGTH = 253
MAX_TOKEN_LENGTH = 1_024
MAX_TTL_SEC = 12_000.0
MAX_CONTENT_LENGTH_DIGITS = 20
TRANSFER_CHUNK_BYTES = 64 * 1024
DOH_HOST = "cloudflare-dns.com"
DOH_ENDPOINT_IPS = ("1.1.1.1", "1.0.0.1")
DOH_TIMEOUT_SEC = 5.0
DOH_MAX_RESPONSE_BYTES = 64 * 1024
DOH_MAX_ANSWERS = 64
_DOH_RECORD_NAME = "A"
_DOH_RECORD_CODE = 1
_DOH_ADDRESS_VERSION = 4
_HTTP_TOKEN_CHARACTERS = frozenset(
    "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)

_HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
_METADATA_NAMES = {
    "instance-data",
    "metadata",
    "metadata.aws.internal",
    "metadata.azure.internal",
    "metadata.google.internal",
    "metadata.oraclecloud.com",
    "metadata.packet.net",
}
_BLOCKED_IPV4_NETWORKS = (ipaddress.ip_network("198.18.0.0/15"),)

Resolver = Callable[[str, int], Iterable[Any]]
Connector = Callable[[str, int, float], socket.socket]


class ProxyRequestError(ValueError):
    def __init__(self, reason: str, status: int = 403):
        super().__init__(reason)
        self.reason = reason
        self.status = status


class TransferLimitError(RuntimeError):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class _DoHResponse(NamedTuple):
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes


DoHRequester = Callable[[str, str, str, float], _DoHResponse]
DoHSocketFactory = Callable[[], socket.socket]
DoHSocketConnect = Callable[[socket.socket, tuple[str, int]], None]


def _default_connector(ip: str, port: int, timeout_sec: float) -> socket.socket:
    address = ipaddress.ip_address(ip)
    if not isinstance(address, ipaddress.IPv4Address):
        raise ProxyRequestError("ipv6_address")
    connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    connection.settimeout(timeout_sec)
    try:
        connection.connect((ip, port))
    except BaseException:
        connection.close()
        raise
    return connection


def _new_ipv4_stream_socket() -> socket.socket:
    return socket.socket(socket.AF_INET, socket.SOCK_STREAM)


def _connect_ipv4_socket(
    connection: socket.socket,
    address: tuple[str, int],
) -> None:
    connection.connect(address)


class _PinnedDoHConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        endpoint_ip: str,
        proxy: PublicEgressProxy,
        deadline: float,
    ):
        context = ssl.create_default_context()
        if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
            raise RuntimeError("pinned DoH TLS verification is unavailable")
        self._endpoint_ip = endpoint_ip
        self._proxy = proxy
        self._deadline = deadline
        self._verified_context = context
        super().__init__(
            DOH_HOST,
            443,
            timeout=DOH_TIMEOUT_SEC,
            context=context,
        )

    def connect(self) -> None:
        raw_connection = self._proxy._open_doh_socket(
            self._endpoint_ip,
            self._deadline,
        )
        wrapped_connection: socket.socket | None = None
        try:
            self._proxy._require_live(self._deadline)
            wrapped_connection = self._verified_context.wrap_socket(
                raw_connection,
                server_hostname=DOH_HOST,
                do_handshake_on_connect=False,
            )
            wrapped_connection.settimeout(
                min(
                    DOH_TIMEOUT_SEC,
                    self._proxy._remaining_connection_time(self._deadline),
                )
            )
            self._proxy._replace_registered_socket(
                raw_connection,
                wrapped_connection,
            )
            wrapped_connection.do_handshake()
            self._proxy._require_live(self._deadline)
            self.sock = wrapped_connection
        except BaseException:
            if wrapped_connection is not None:
                self._proxy._unregister_socket(wrapped_connection)
                _safe_close(wrapped_connection)
            self._proxy._unregister_socket(raw_connection)
            raw_connection.close()
            raise

    def apply_deadline(self) -> None:
        self._proxy._require_live(self._deadline)
        if self.sock is not None:
            self.sock.settimeout(
                min(
                    DOH_TIMEOUT_SEC,
                    self._proxy._remaining_connection_time(self._deadline),
                )
            )

    def close(self) -> None:
        active_socket = self.sock
        try:
            super().close()
        finally:
            if active_socket is not None:
                self._proxy._unregister_socket(active_socket)


def _single_doh_header(headers: tuple[tuple[str, str], ...], name: str) -> str | None:
    values: list[str] = []
    for header in headers:
        if (
            not isinstance(header, tuple)
            or len(header) != 2
            or not isinstance(header[0], str)
            or not isinstance(header[1], str)
            or "\r" in header[0]
            or "\n" in header[0]
            or "\r" in header[1]
            or "\n" in header[1]
        ):
            raise ProxyRequestError("resolution_failed", 502)
        if header[0].lower() == name:
            values.append(header[1].strip())
    if len(values) > 1:
        raise ProxyRequestError("resolution_failed", 502)
    return values[0] if values else None


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non-finite JSON value")


def _strict_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _address_rejection_reason(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> str | None:
    if isinstance(address, ipaddress.IPv6Address):
        return "ipv6_address"
    if isinstance(address, ipaddress.IPv4Address) and any(
        address in network for network in _BLOCKED_IPV4_NETWORKS
    ):
        return "non_public_address"
    if (
        not address.is_global
        or address.is_multicast
        or address.is_unspecified
        or address.is_reserved
    ):
        return "non_public_address"
    return None


def _parse_doh_response(
    host: str,
    record_code: int,
    address_version: int,
    response: _DoHResponse,
) -> tuple[str, ...]:
    if record_code != _DOH_RECORD_CODE or address_version != _DOH_ADDRESS_VERSION:
        raise ProxyRequestError("resolution_failed", 502)
    if (
        isinstance(response.status, bool)
        or not isinstance(response.status, int)
        or response.status != 200
        or not response.body
        or len(response.body) > DOH_MAX_RESPONSE_BYTES
    ):
        raise ProxyRequestError("resolution_failed", 502)
    content_type = _single_doh_header(response.headers, "content-type")
    if (
        content_type is None
        or content_type.split(";", 1)[0].strip().lower() != "application/dns-json"
        or _single_doh_header(response.headers, "content-encoding") is not None
    ):
        raise ProxyRequestError("resolution_failed", 502)
    content_length = _single_doh_header(response.headers, "content-length")
    transfer_encoding = _single_doh_header(response.headers, "transfer-encoding")
    if transfer_encoding is not None and (
        transfer_encoding.lower() != "chunked" or content_length is not None
    ):
        raise ProxyRequestError("resolution_failed", 502)
    if content_length is not None and (
        not content_length.isascii()
        or not content_length.isdecimal()
        or int(content_length, 10) != len(response.body)
    ):
        raise ProxyRequestError("resolution_failed", 502)
    try:
        payload = json.loads(
            response.body.decode("utf-8"),
            parse_constant=_reject_json_constant,
            object_pairs_hook=_strict_json_object,
        )
    except (UnicodeDecodeError, ValueError) as error:
        raise ProxyRequestError("resolution_failed", 502) from error
    if not isinstance(payload, dict):
        raise ProxyRequestError("resolution_failed", 502)
    status = payload.get("Status")
    truncated = payload.get("TC")
    questions = payload.get("Question")
    if (
        isinstance(status, bool)
        or not isinstance(status, int)
        or status != 0
        or truncated is not False
        or not isinstance(questions, list)
        or len(questions) != 1
    ):
        raise ProxyRequestError("resolution_failed", 502)
    question = questions[0]
    if not isinstance(question, dict):
        raise ProxyRequestError("resolution_failed", 502)
    question_name = question.get("name")
    question_type = question.get("type")
    if (
        not isinstance(question_name, str)
        or isinstance(question_type, bool)
        or not isinstance(question_type, int)
        or question_type != record_code
    ):
        raise ProxyRequestError("resolution_failed", 502)
    try:
        if _canonical_host(question_name) != host:
            raise ProxyRequestError("resolution_failed", 502)
    except ProxyRequestError as error:
        raise ProxyRequestError("resolution_failed", 502) from error

    answers = payload.get("Answer", [])
    if not isinstance(answers, list) or len(answers) > DOH_MAX_ANSWERS:
        raise ProxyRequestError("resolution_failed", 502)
    cname_edges: dict[str, set[str]] = {}
    address_records: list[tuple[str, ipaddress.IPv4Address]] = []
    for answer in answers:
        if not isinstance(answer, dict):
            raise ProxyRequestError("resolution_failed", 502)
        answer_name = answer.get("name")
        answer_type = answer.get("type")
        ttl = answer.get("TTL")
        data = answer.get("data")
        if (
            not isinstance(answer_name, str)
            or isinstance(answer_type, bool)
            or not isinstance(answer_type, int)
            or isinstance(ttl, bool)
            or not isinstance(ttl, int)
            or ttl < 0
            or ttl > 0xFFFFFFFF
            or not isinstance(data, str)
            or not data
        ):
            raise ProxyRequestError("resolution_failed", 502)
        try:
            owner = _canonical_host(answer_name)
        except ProxyRequestError as error:
            raise ProxyRequestError("resolution_failed", 502) from error
        if answer_type == 5:
            try:
                target = _canonical_host(data)
            except ProxyRequestError as error:
                raise ProxyRequestError("resolution_failed", 502) from error
            cname_edges.setdefault(owner, set()).add(target)
            continue
        if answer_type != record_code:
            raise ProxyRequestError("resolution_failed", 502)
        try:
            address = ipaddress.ip_address(data)
        except ValueError as error:
            raise ProxyRequestError("resolution_failed", 502) from error
        if not isinstance(address, ipaddress.IPv4Address):
            raise ProxyRequestError("resolution_failed", 502)
        rejection_reason = _address_rejection_reason(address)
        if rejection_reason is not None:
            raise ProxyRequestError(rejection_reason, 502)
        address_records.append((owner, address))

    reachable = {host}
    for _sequence in range(DOH_MAX_ANSWERS):
        expanded = reachable | {
            target for owner in reachable for target in cname_edges.get(owner, ())
        }
        if expanded == reachable:
            break
        reachable = expanded
    result: list[str] = []
    seen: set[str] = set()
    for owner, address in address_records:
        canonical_ip = str(address)
        if owner in reachable and canonical_ip not in seen:
            seen.add(canonical_ip)
            result.append(canonical_ip)
    return tuple(result)


def _safe_close(connection: socket.socket) -> None:
    try:
        connection.close()
    except OSError:
        pass


def _canonical_host(value: str) -> str:
    host = value.rstrip(".").lower()
    if not host or len(host) > MAX_HOST_LENGTH:
        raise ProxyRequestError("invalid_host")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ProxyRequestError("ip_literal")
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError as error:
        raise ProxyRequestError("invalid_host") from error
    labels = host.split(".")
    if any(
        not label
        or len(label) > 63
        or label.startswith("-")
        or label.endswith("-")
        or any(not (character.isalnum() or character == "-") for character in label)
        for label in labels
    ):
        raise ProxyRequestError("invalid_host")
    return host


def _blocked_host_reason(host: str) -> str | None:
    labels = host.split(".")
    if host == "localhost" or host.endswith(".localhost"):
        return "localhost"
    if host == "local" or host.endswith(".local"):
        return "local_name"
    if host == "docker.internal" or host.endswith(".docker.internal"):
        return "docker_internal"
    if host in _METADATA_NAMES or "metadata" in labels or "instance-data" in labels:
        return "metadata_name"
    if host == "internal" or host.endswith(".internal"):
        return "internal_name"
    return None


def _extract_resolved_ip(value: Any) -> str:
    if isinstance(value, (str, ipaddress.IPv4Address, ipaddress.IPv6Address)):
        return str(value)
    if (
        isinstance(value, tuple)
        and len(value) >= 5
        and isinstance(value[4], tuple)
        and value[4]
    ):
        return str(value[4][0])
    raise ProxyRequestError("resolution_failed", 502)


def _format_host_header(host: str, port: int) -> str:
    return host if port == 80 else f"{host}:{port}"


def _bounded_wall_time(value: float | None) -> float | None:
    return round(value, 6) if value is not None else None


class _PublicEgressServer(ThreadingHTTPServer):
    daemon_threads = False
    request_queue_size = 64

    def __init__(
        self,
        server_address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        proxy: PublicEgressProxy,
    ):
        self.proxy = proxy
        super().__init__(server_address, handler)

    def get_request(self) -> tuple[socket.socket, Any]:
        request, address = super().get_request()
        request.settimeout(CLIENT_HEADER_TIMEOUT_SEC)
        return request, address

    def process_request(
        self,
        request: socket.socket | tuple[bytes, socket.socket],
        client_address: Any,
    ) -> None:
        if not isinstance(request, socket.socket):
            raise TypeError("public egress server requires a stream socket")
        rejection_reason = self.proxy._accept_request()
        if rejection_reason is not None:
            self._reject_before_thread(request, rejection_reason)
            return
        if not self.proxy._connection_slots.acquire(blocking=False):
            self._reject_before_thread(request, "connection_limit")
            return
        try:
            self.proxy._register_socket(request)
        except ProxyRequestError as error:
            self.proxy._connection_slots.release()
            self._reject_before_thread(request, error.reason)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.proxy._unregister_socket(request)
            self.proxy._connection_slots.release()
            raise

    def process_request_thread(
        self,
        request: socket.socket | tuple[bytes, socket.socket],
        client_address: Any,
    ) -> None:
        if not isinstance(request, socket.socket):
            raise TypeError("public egress server requires a stream socket")
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.proxy._unregister_socket(request)
            self.proxy._connection_slots.release()

    def _reject_before_thread(self, request: socket.socket, reason: str) -> None:
        try:
            request.sendall(
                b"HTTP/1.1 503 Service Unavailable\r\n"
                b"Connection: close\r\n"
                b"Content-Length: 0\r\n\r\n"
            )
        except OSError:
            pass
        finally:
            self.shutdown_request(request)
        self.proxy._record_decision(
            host="",
            port=0,
            decision="deny",
            reason=reason,
            byte_count=0,
        )

    def handle_error(
        self,
        request: socket.socket | tuple[bytes, socket.socket],
        client_address: Any,
    ) -> None:
        del request, client_address
        self.proxy._record_decision(
            host="",
            port=0,
            decision="deny",
            reason="server_error",
            byte_count=0,
        )


class _PublicEgressHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PicoPublicEgress/1"
    sys_version = ""

    @property
    def proxy(self) -> PublicEgressProxy:
        server = self.server
        if not isinstance(server, _PublicEgressServer):
            raise TypeError("public egress handler has an invalid server")
        return server.proxy

    def log_message(self, _format: str, *args: Any) -> None:
        del args

    def version_string(self) -> str:
        return self.server_version

    def handle_expect_100(self) -> bool:
        self._record_denial("", 0, "expectation", 417)
        return False

    def _respond(self, status: int, *, authenticate: bool = False) -> None:
        try:
            self.send_response_only(status)
            if authenticate:
                self.send_header("Proxy-Authenticate", 'Basic realm="pico-egress"')
            self.send_header("Connection", "close")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except OSError:
            pass
        self.close_connection = True

    def _record_denial(
        self, host: str, port: int, reason: str, status: int = 403
    ) -> None:
        self.proxy._record_decision(
            host=host,
            port=port,
            decision="deny",
            reason=reason,
            byte_count=0,
        )
        self._respond(status, authenticate=status == 407)

    def _authenticate(self, host: str, port: int) -> bool:
        values = self.headers.get_all("Proxy-Authorization", failobj=[])
        if len(values) != 1 or not self.proxy._authenticate(values[0]):
            self._record_denial(host, port, "authentication", 407)
            return False
        return True

    def _require_content_length(self) -> int:
        if self.headers.get_all("Transfer-Encoding", failobj=[]):
            raise ProxyRequestError("transfer_encoding", 400)
        values = self.headers.get_all("Content-Length", failobj=[])
        if len(values) > 1:
            raise ProxyRequestError("content_length", 400)
        if not values:
            return 0
        encoded_length = values[0].strip()
        if len(encoded_length) > MAX_CONTENT_LENGTH_DIGITS:
            raise ProxyRequestError("content_length", 413)
        if not encoded_length.isascii() or not encoded_length.isdecimal():
            raise ProxyRequestError("content_length", 400)
        return int(encoded_length, 10)

    def _absolute_target(self) -> tuple[SplitResult, str, int]:
        try:
            target = urlsplit(self.path)
            port = target.port
        except ValueError as error:
            raise ProxyRequestError("invalid_target") from error
        if (
            target.scheme.lower() != "http"
            or not target.hostname
            or target.username is not None
            or target.password is not None
            or target.fragment
        ):
            reason = (
                "https_requires_connect"
                if target.scheme.lower() == "https"
                else "invalid_scheme"
                if target.scheme
                else "absolute_form_required"
            )
            raise ProxyRequestError(reason)
        port = 80 if port is None else port
        if port not in ALLOWED_HTTP_PORTS:
            raise ProxyRequestError("port")
        return target, _canonical_host(target.hostname), port

    def _connect_target(self) -> tuple[str, int]:
        try:
            target = urlsplit(f"//{self.path}")
            port = target.port
        except ValueError as error:
            raise ProxyRequestError("invalid_target") from error
        if (
            not target.hostname
            or target.username is not None
            or target.password is not None
            or target.path
            or target.query
            or target.fragment
            or port is None
        ):
            raise ProxyRequestError("invalid_target")
        if port not in ALLOWED_CONNECT_PORTS:
            raise ProxyRequestError("port")
        return _canonical_host(target.hostname), port

    def _outbound_headers(
        self, host: str, port: int, content_length: int
    ) -> list[tuple[str, str]]:
        inbound_headers = list(self.headers.items())
        if any(
            not name
            or any(character not in _HTTP_TOKEN_CHARACTERS for character in name)
            or "\r" in value
            or "\n" in value
            or "\0" in value
            for name, value in inbound_headers
        ):
            raise ProxyRequestError("headers")
        connection_tokens = {
            token.strip().lower()
            for value in self.headers.get_all("Connection", failobj=[])
            for token in value.split(",")
            if token.strip()
        }
        blocked = _HOP_BY_HOP_HEADERS | connection_tokens | {"host", "content-length"}
        headers = [
            (name, value.strip())
            for name, value in inbound_headers
            if name.lower() not in blocked
        ]
        headers.append(("Host", _format_host_header(host, port)))
        if content_length:
            headers.append(("Content-Length", str(content_length)))
        headers.append(("Connection", "close"))
        return headers

    def _forward_http(self) -> None:
        host = ""
        port = 0
        transferred = 0
        upstream: socket.socket | None = None
        connected = False
        reason = "completed"
        try:
            target, host, port = self._absolute_target()
            if not self._authenticate(host, port):
                return
            self.proxy._require_available()
            if self.headers.get("Expect") is not None:
                raise ProxyRequestError("expectation")
            content_length = self._require_content_length()
            if content_length > self.proxy._remaining_byte_budget():
                raise ProxyRequestError("byte_limit", 413)
            headers = self._outbound_headers(host, port, content_length)
            addresses = self.proxy._resolve_public(host, port)
            deadline = self.proxy._connection_deadline()
            upstream = self.proxy._connect(addresses, port, deadline)
            connected = True
            self.proxy._register_socket(upstream)

            path = target.path or "/"
            if target.query:
                path = f"{path}?{target.query}"
            request_head = (
                f"{self.command} {path} HTTP/1.1\r\n"
                + "".join(f"{name}: {value}\r\n" for name, value in headers)
                + "\r\n"
            ).encode("latin-1", "strict")
            self.proxy._charge("clientToUpstream", len(request_head))
            transferred += len(request_head)
            upstream.sendall(request_head)

            remaining_body = content_length
            while remaining_body:
                self.proxy._require_live(deadline)
                chunk = self.rfile.read(min(TRANSFER_CHUNK_BYTES, remaining_body))
                if not chunk:
                    raise ProxyRequestError("request_body", 400)
                self.proxy._charge("clientToUpstream", len(chunk))
                transferred += len(chunk)
                upstream.sendall(chunk)
                remaining_body -= len(chunk)

            self.connection.settimeout(1.0)
            while True:
                self.proxy._require_live(deadline)
                upstream.settimeout(
                    min(1.0, self.proxy._remaining_connection_time(deadline))
                )
                try:
                    chunk = upstream.recv(TRANSFER_CHUNK_BYTES)
                except TimeoutError:
                    continue
                if not chunk:
                    break
                self.proxy._charge("upstreamToClient", len(chunk))
                transferred += len(chunk)
                self.connection.sendall(chunk)
        except ProxyRequestError as error:
            reason = error.reason
            if not connected:
                self._record_denial(host, port, reason, error.status)
                return
        except TransferLimitError as error:
            reason = error.reason
        except (ConnectionError, OSError, UnicodeError):
            reason = "connection_failed" if not connected else "connection_closed"
            if not connected:
                self._record_denial(host, port, reason, 502)
                return
        finally:
            if upstream is not None:
                self.proxy._unregister_socket(upstream)
                _safe_close(upstream)
            if connected:
                self.proxy._record_decision(
                    host=host,
                    port=port,
                    decision="allow",
                    reason=reason,
                    byte_count=transferred,
                )
            self.close_connection = True

    def _forward_connect(self) -> None:
        host = ""
        port = 0
        transferred = 0
        upstream: socket.socket | None = None
        connected = False
        reason = "completed"
        try:
            host, port = self._connect_target()
            if not self._authenticate(host, port):
                return
            self.proxy._require_available()
            addresses = self.proxy._resolve_public(host, port)
            deadline = self.proxy._connection_deadline()
            upstream = self.proxy._connect(addresses, port, deadline)
            connected = True
            self.proxy._register_socket(upstream)
            self.connection.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            transferred, reason = self._relay_tunnel(upstream, deadline)
        except ProxyRequestError as error:
            reason = error.reason
            if not connected:
                self._record_denial(host, port, reason, error.status)
                return
        except TransferLimitError as error:
            reason = error.reason
        except (ConnectionError, OSError):
            reason = "connection_failed" if not connected else "connection_closed"
            if not connected:
                self._record_denial(host, port, reason, 502)
                return
        finally:
            if upstream is not None:
                self.proxy._unregister_socket(upstream)
                _safe_close(upstream)
            if connected:
                self.proxy._record_decision(
                    host=host,
                    port=port,
                    decision="allow",
                    reason=reason,
                    byte_count=transferred,
                )
            self.close_connection = True

    def _relay_tunnel(
        self, upstream: socket.socket, deadline: float
    ) -> tuple[int, str]:
        selector = selectors.DefaultSelector()
        directions: dict[socket.socket, tuple[socket.socket, str]] = {
            self.connection: (upstream, "clientToUpstream"),
            upstream: (self.connection, "upstreamToClient"),
        }
        transferred = 0
        for source in directions:
            source.setblocking(False)
            selector.register(source, selectors.EVENT_READ)
        try:
            while selector.get_map():
                self.proxy._require_live(deadline)
                events = selector.select(
                    min(0.25, self.proxy._remaining_connection_time(deadline))
                )
                for key, _mask in events:
                    selected = key.fileobj
                    if not isinstance(selected, socket.socket):
                        continue
                    destination, direction = directions[selected]
                    try:
                        chunk = selected.recv(TRANSFER_CHUNK_BYTES)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(selected)
                        try:
                            destination.shutdown(socket.SHUT_WR)
                        except OSError:
                            pass
                        continue
                    self.proxy._charge(direction, len(chunk))
                    transferred += len(chunk)
                    destination.setblocking(True)
                    destination.settimeout(
                        min(1.0, self.proxy._remaining_connection_time(deadline))
                    )
                    destination.sendall(chunk)
                    destination.setblocking(False)
            return transferred, "completed"
        except ProxyRequestError as error:
            return transferred, error.reason
        except TransferLimitError as error:
            return transferred, error.reason
        finally:
            selector.close()

    do_CONNECT = _forward_connect
    do_DELETE = _forward_http
    do_GET = _forward_http
    do_HEAD = _forward_http
    do_OPTIONS = _forward_http
    do_PATCH = _forward_http
    do_POST = _forward_http
    do_PUT = _forward_http


class PublicEgressProxy:
    def __init__(
        self,
        token: str,
        ttl_sec: float,
        max_connections: int = DEFAULT_MAX_CONNECTIONS,
        max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
        max_requests: int = DEFAULT_MAX_REQUESTS,
    ):
        if (
            not isinstance(token, str)
            or not token
            or len(token) > MAX_TOKEN_LENGTH
            or not token.isascii()
            or any(
                ord(character) < 0x21 or ord(character) > 0x7E for character in token
            )
        ):
            raise ValueError("public egress token is invalid")
        if (
            isinstance(ttl_sec, bool)
            or not isinstance(ttl_sec, (int, float))
            or not math.isfinite(ttl_sec)
            or ttl_sec <= 0
            or ttl_sec > MAX_TTL_SEC
        ):
            raise ValueError("public egress TTL is invalid")
        if (
            isinstance(max_connections, bool)
            or not isinstance(max_connections, int)
            or max_connections <= 0
            or max_connections > 256
        ):
            raise ValueError("public egress connection limit is invalid")
        if (
            isinstance(max_total_bytes, bool)
            or not isinstance(max_total_bytes, int)
            or max_total_bytes <= 0
            or max_total_bytes > 4 * DEFAULT_MAX_TOTAL_BYTES
        ):
            raise ValueError("public egress byte limit is invalid")
        if (
            isinstance(max_requests, bool)
            or not isinstance(max_requests, int)
            or max_requests <= 0
            or max_requests > MAX_CONFIGURED_REQUESTS
        ):
            raise ValueError("public egress request limit is invalid")

        self._token = token
        self._ttl_sec = float(ttl_sec)
        self._max_total_bytes = max_total_bytes
        self._max_requests = max_requests
        self._connection_slots = threading.BoundedSemaphore(max_connections)
        self._resolver: Resolver = self._resolve_via_doh
        self._connector: Connector = _default_connector
        self._doh_requester: DoHRequester = self._doh_https_request
        self._doh_socket_factory: DoHSocketFactory = _new_ipv4_stream_socket
        self._doh_socket_connect: DoHSocketConnect = _connect_ipv4_socket
        self._monotonic = time.monotonic
        self._wall_time = time.time

        self._lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._active_sockets: set[socket.socket] = set()
        self._server: _PublicEgressServer | None = None
        self._server_thread: threading.Thread | None = None
        self._expiry_thread: threading.Thread | None = None
        self._expiry_cancel = threading.Event()
        self._expiry_fired = threading.Event()
        self._stop_complete = threading.Event()
        self._started_monotonic: float | None = None
        self._expires_monotonic: float | None = None
        self._started_wall: float | None = None
        self._stopped_wall: float | None = None
        self._stopping = False
        self._revoked = False
        self._expired_by_timer = False
        self._receipt_finalized = False
        self._final_receipt: dict[str, Any] | None = None

        self._allowed = 0
        self._denied = 0
        self._requests_accepted = 0
        self._bytes = {
            "clientToUpstream": 0,
            "upstreamToClient": 0,
            "total": 0,
        }
        self._decisions: list[dict[str, Any]] = []
        self._decisions_truncated = 0

    def start(self) -> int:
        with self._lifecycle_lock:
            if self._server is not None or self._started_monotonic is not None:
                raise RuntimeError("public egress proxy is already started")
            if self._stopping:
                raise RuntimeError("public egress proxy is stopped")
            started_monotonic = self._monotonic()
            self._started_monotonic = started_monotonic
            self._expires_monotonic = started_monotonic + self._ttl_sec
            self._started_wall = self._wall_time()
            server = _PublicEgressServer(
                (PUBLIC_EGRESS_BIND_HOST, 0),
                _PublicEgressHandler,
                self,
            )
            self._server = server
            server_thread = threading.Thread(
                target=server.serve_forever,
                kwargs={"poll_interval": 0.1},
                name="pico-public-egress",
                daemon=True,
            )
            self._server_thread = server_thread
            server_thread.start()
            expiry_thread = threading.Thread(
                target=self._expire_proxy,
                name="pico-public-egress-expiry",
                daemon=True,
            )
            self._expiry_thread = expiry_thread
            expiry_thread.start()
            return int(server.server_address[1])

    def revoke(self) -> None:
        with self._lock:
            self._revoked = True
        self._close_active_sockets()

    def stop(self) -> dict[str, Any]:
        with self._lifecycle_lock:
            if self._final_receipt is not None:
                return self._copy_receipt(self._final_receipt)
            if self._stopping:
                wait_for_stop = True
            else:
                wait_for_stop = False
                with self._lock:
                    self._stopping = True
                self._expiry_cancel.set()
            server = self._server
            server_thread = self._server_thread
            expiry_thread = self._expiry_thread

        if wait_for_stop:
            self._stop_complete.wait()
            with self._lifecycle_lock:
                if self._final_receipt is None:
                    raise RuntimeError("public egress proxy stop failed")
                return self._copy_receipt(self._final_receipt)

        try:
            if server is not None:
                server.shutdown()
            self._close_active_sockets()
            if server is not None:
                server.server_close()
            current = threading.current_thread()
            if server_thread is not None and server_thread is not current:
                server_thread.join()
            if expiry_thread is not None and expiry_thread is not current:
                expiry_thread.join()
            self._close_active_sockets()
            with self._lock:
                if self._active_sockets:
                    raise RuntimeError(
                        "public egress proxy retained active sockets after stop"
                    )
                self._token = ""
                self._stopped_wall = self._wall_time()
                self._receipt_finalized = True
            receipt = self._receipt()
            with self._lifecycle_lock:
                self._final_receipt = receipt
            return self._copy_receipt(receipt)
        finally:
            self._stop_complete.set()

    def _expire_proxy(self) -> None:
        if self._expiry_cancel.wait(self._ttl_sec):
            return
        with self._lock:
            self._expired_by_timer = True
        self._expiry_fired.set()
        self._close_active_sockets()

    @staticmethod
    def _copy_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
        return {
            **receipt,
            "bytes": dict(receipt["bytes"]),
            "decisions": [dict(decision) for decision in receipt["decisions"]],
        }

    def _close_active_sockets(self) -> None:
        with self._lock:
            active = tuple(self._active_sockets)
        for connection in active:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            _safe_close(connection)

    def _inactive_reason_locked(self) -> str | None:
        if self._stopping:
            return "stopped"
        if self._revoked:
            return "revoked"
        expires = self._expires_monotonic
        if self._expired_by_timer or expires is None or self._monotonic() >= expires:
            return "ttl"
        return None

    def _inactive_reason(self) -> str | None:
        with self._lock:
            return self._inactive_reason_locked()

    def _accept_request(self) -> str | None:
        with self._lock:
            inactive_reason = self._inactive_reason_locked()
            if inactive_reason is not None:
                return inactive_reason
            if self._requests_accepted >= self._max_requests:
                return "request_limit"
            self._requests_accepted += 1
            return None

    def _register_socket(self, connection: socket.socket) -> None:
        with self._lock:
            inactive_reason = self._inactive_reason_locked()
            if inactive_reason is not None:
                raise ProxyRequestError(inactive_reason)
            self._active_sockets.add(connection)

    def _replace_registered_socket(
        self,
        previous: socket.socket,
        replacement: socket.socket,
    ) -> None:
        with self._lock:
            self._active_sockets.discard(previous)
            inactive_reason = self._inactive_reason_locked()
            if inactive_reason is not None:
                raise ProxyRequestError(inactive_reason)
            self._active_sockets.add(replacement)

    def _unregister_socket(self, connection: socket.socket) -> None:
        with self._lock:
            self._active_sockets.discard(connection)

    def _authenticate(self, value: str) -> bool:
        scheme, separator, encoded = value.partition(" ")
        if separator != " " or scheme.lower() != "basic" or not encoded:
            return False
        try:
            decoded = base64.b64decode(encoded.strip(), validate=True).decode("ascii")
        except (binascii.Error, UnicodeDecodeError):
            return False
        username, separator, password = decoded.partition(":")
        if separator != ":" or username != "pico":
            return False
        return hmac.compare_digest(password, self._token)

    def _expired(self) -> bool:
        return self._inactive_reason() is not None

    def _require_available(self) -> None:
        inactive_reason = self._inactive_reason()
        if inactive_reason is not None:
            raise ProxyRequestError(inactive_reason)

    def _connection_deadline(self) -> float:
        with self._lock:
            inactive_reason = self._inactive_reason_locked()
            expires = self._expires_monotonic
        if inactive_reason is not None:
            raise ProxyRequestError(inactive_reason)
        if expires is None:
            raise ProxyRequestError("ttl")
        return min(
            expires,
            self._monotonic() + PUBLIC_EGRESS_CONNECTION_TIMEOUT_SEC,
        )

    def _remaining_connection_time(self, deadline: float) -> float:
        remaining = deadline - self._monotonic()
        if remaining <= 0:
            raise ProxyRequestError("connection_timeout")
        return remaining

    def _require_live(self, deadline: float) -> None:
        inactive_reason = self._inactive_reason()
        if inactive_reason is not None:
            raise ProxyRequestError(inactive_reason)
        now = self._monotonic()
        if now >= deadline:
            raise ProxyRequestError("connection_timeout")

    def _open_doh_socket(
        self,
        endpoint_ip: str,
        deadline: float,
    ) -> socket.socket:
        self._require_live(deadline)
        connection = self._doh_socket_factory()
        self._register_socket(connection)
        try:
            connection.settimeout(
                min(
                    DOH_TIMEOUT_SEC,
                    self._remaining_connection_time(deadline),
                )
            )
            self._doh_socket_connect(connection, (endpoint_ip, 443))
            self._require_live(deadline)
            return connection
        except BaseException:
            self._unregister_socket(connection)
            _safe_close(connection)
            raise

    def _doh_https_request(
        self,
        endpoint_ip: str,
        host: str,
        record_name: str,
        deadline: float,
    ) -> _DoHResponse:
        connection = _PinnedDoHConnection(
            endpoint_ip,
            self,
            deadline,
        )
        try:
            connection.request(
                "GET",
                f"/dns-query?name={host}&type={record_name}",
                headers={
                    "Accept": "application/dns-json",
                    "Connection": "keep-alive",
                    "Host": DOH_HOST,
                    "User-Agent": "pico-public-egress/1",
                },
            )
            connection.apply_deadline()
            response = connection.getresponse()
            body = bytearray()
            while len(body) <= DOH_MAX_RESPONSE_BYTES:
                connection.apply_deadline()
                chunk = response.read1(
                    min(
                        8 * 1024,
                        DOH_MAX_RESPONSE_BYTES + 1 - len(body),
                    )
                )
                if not chunk:
                    break
                body.extend(chunk)
            return _DoHResponse(
                status=response.status,
                headers=tuple(response.getheaders()),
                body=bytes(body),
            )
        finally:
            connection.close()

    def _resolve_via_doh(self, host: str, port: int) -> Iterable[Any]:
        del port
        for endpoint_ip in DOH_ENDPOINT_IPS:
            try:
                deadline = min(
                    self._connection_deadline(),
                    self._monotonic() + DOH_TIMEOUT_SEC,
                )
                response = self._doh_requester(
                    endpoint_ip,
                    host,
                    _DOH_RECORD_NAME,
                    deadline,
                )
                addresses = _parse_doh_response(
                    host,
                    _DOH_RECORD_CODE,
                    _DOH_ADDRESS_VERSION,
                    response,
                )
                if not addresses or len(addresses) > DOH_MAX_ANSWERS:
                    raise ProxyRequestError("resolution_failed", 502)
                return addresses
            except ProxyRequestError as error:
                if error.reason in {"revoked", "stopped", "ttl"}:
                    raise
            except (
                OSError,
                RuntimeError,
                ValueError,
                http.client.HTTPException,
            ):
                inactive_reason = self._inactive_reason()
                if inactive_reason is not None:
                    raise ProxyRequestError(inactive_reason) from None
                continue
        raise ProxyRequestError("resolution_failed", 502)

    def _resolve_public(self, host: str, port: int) -> tuple[str, ...]:
        blocked_reason = _blocked_host_reason(host)
        if blocked_reason is not None:
            raise ProxyRequestError(blocked_reason)
        try:
            resolved = tuple(self._resolver(host, port))
        except ProxyRequestError as error:
            if error.reason in {"revoked", "stopped", "ttl"}:
                raise
            raise ProxyRequestError("resolution_failed", 502) from error
        except (OSError, ValueError) as error:
            raise ProxyRequestError("resolution_failed", 502) from error
        if not resolved:
            raise ProxyRequestError("resolution_failed", 502)
        addresses: list[str] = []
        seen: set[str] = set()
        for value in resolved:
            raw_ip = _extract_resolved_ip(value)
            try:
                address = ipaddress.ip_address(raw_ip)
            except ValueError as error:
                raise ProxyRequestError("resolution_failed", 502) from error
            rejection_reason = _address_rejection_reason(address)
            if rejection_reason is not None:
                raise ProxyRequestError(rejection_reason)
            canonical_ip = str(address)
            if canonical_ip not in seen:
                seen.add(canonical_ip)
                addresses.append(canonical_ip)
        if not addresses:
            raise ProxyRequestError("resolution_failed", 502)
        return tuple(addresses)

    def _connect(
        self, addresses: tuple[str, ...], port: int, deadline: float
    ) -> socket.socket:
        for address in addresses:
            try:
                timeout = min(
                    CONNECT_ATTEMPT_TIMEOUT_SEC,
                    self._remaining_connection_time(deadline),
                )
                return self._connector(address, port, timeout)
            except ProxyRequestError:
                raise
            except OSError:
                continue
        raise ProxyRequestError("connection_failed", 502)

    def _remaining_byte_budget(self) -> int:
        with self._lock:
            return self._max_total_bytes - self._bytes["total"]

    def _charge(self, direction: str, byte_count: int) -> None:
        if direction not in {"clientToUpstream", "upstreamToClient"}:
            raise ValueError("invalid public egress byte direction")
        if byte_count < 0:
            raise ValueError("invalid public egress byte count")
        with self._lock:
            if self._bytes["total"] + byte_count > self._max_total_bytes:
                raise TransferLimitError("byte_limit")
            self._bytes[direction] += byte_count
            self._bytes["total"] += byte_count

    def _record_decision(
        self,
        *,
        host: str,
        port: int,
        decision: str,
        reason: str,
        byte_count: int,
    ) -> None:
        entry = {
            "host": host[:MAX_HOST_LENGTH],
            "port": int(port),
            "decision": decision,
            "reason": reason,
            "bytes": max(0, int(byte_count)),
        }
        with self._lock:
            if self._receipt_finalized:
                return
            if decision == "allow":
                self._allowed += 1
            else:
                self._denied += 1
            if len(self._decisions) < MAX_AUDIT_DECISIONS:
                self._decisions.append(entry)
            else:
                self._decisions_truncated += 1

    def _receipt(self) -> dict[str, Any]:
        with self._lock:
            return {
                "schemaVersion": PROXY_POLICY_VERSION,
                "started": _bounded_wall_time(self._started_wall),
                "stopped": _bounded_wall_time(self._stopped_wall),
                "allowed": self._allowed,
                "denied": self._denied,
                "requestsAccepted": self._requests_accepted,
                "bytes": dict(self._bytes),
                "decisions": [dict(decision) for decision in self._decisions],
                "decisionsTruncated": self._decisions_truncated,
            }


__all__ = [
    "ALLOWED_CONNECT_PORTS",
    "ALLOWED_HTTP_PORTS",
    "DEFAULT_MAX_CONNECTIONS",
    "DEFAULT_MAX_REQUESTS",
    "DEFAULT_MAX_TOTAL_BYTES",
    "DOH_ENDPOINT_IPS",
    "DOH_HOST",
    "MAX_AUDIT_DECISIONS",
    "PROXY_POLICY_VERSION",
    "PUBLIC_EGRESS_CONNECTION_TIMEOUT_SEC",
    "PublicEgressProxy",
]
