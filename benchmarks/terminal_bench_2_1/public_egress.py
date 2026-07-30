from __future__ import annotations

import base64
import binascii
import hmac
import ipaddress
import math
import selectors
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Iterable
from urllib.parse import SplitResult, urlsplit

PROXY_POLICY_VERSION = 1
DEFAULT_MAX_CONNECTIONS = 32
DEFAULT_MAX_TOTAL_BYTES = 1_073_741_824
ALLOWED_HTTP_PORTS = (80,)
ALLOWED_CONNECT_PORTS = (443,)
PUBLIC_EGRESS_CONNECTION_TIMEOUT_SEC = 120.0
CONNECT_ATTEMPT_TIMEOUT_SEC = 10.0
CLIENT_HEADER_TIMEOUT_SEC = 15.0
MAX_AUDIT_DECISIONS = 256
MAX_HOST_LENGTH = 253
MAX_TOKEN_LENGTH = 1_024
MAX_TTL_SEC = 12_000.0
TRANSFER_CHUNK_BYTES = 64 * 1024
_HTTP_TOKEN_CHARACTERS = frozenset(
    "!#$%&'*+-.^_`|~"
    "0123456789"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
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
_BLOCKED_IPV6_TRANSITION_NETWORKS = (
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("64:ff9b:1::/48"),
    ipaddress.ip_network("2001::/32"),
    ipaddress.ip_network("2002::/16"),
)

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


def _default_resolver(host: str, port: int) -> Iterable[Any]:
    return socket.getaddrinfo(
        host,
        port,
        family=socket.AF_UNSPEC,
        type=socket.SOCK_STREAM,
        proto=socket.IPPROTO_TCP,
    )


def _default_connector(ip: str, port: int, timeout_sec: float) -> socket.socket:
    address = ipaddress.ip_address(ip)
    family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
    connection = socket.socket(family, socket.SOCK_STREAM)
    connection.settimeout(timeout_sec)
    try:
        if address.version == 6:
            connection.connect((ip, port, 0, 0))
        else:
            connection.connect((ip, port))
    except BaseException:
        connection.close()
        raise
    return connection


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
    if (
        host in _METADATA_NAMES
        or "metadata" in labels
        or "instance-data" in labels
    ):
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
    daemon_threads = True
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

    def process_request(self, request: socket.socket, client_address: Any) -> None:
        if not self.proxy._connection_slots.acquire(blocking=False):
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
                reason="connection_limit",
                byte_count=0,
            )
            return
        try:
            self.proxy._register_socket(request)
        except ProxyRequestError:
            self.proxy._connection_slots.release()
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.proxy._unregister_socket(request)
            self.proxy._connection_slots.release()
            raise

    def process_request_thread(
        self, request: socket.socket, client_address: Any
    ) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.proxy._unregister_socket(request)
            self.proxy._connection_slots.release()


class _PublicEgressHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PicoPublicEgress/1"
    sys_version = ""

    @property
    def proxy(self) -> PublicEgressProxy:
        server = self.server
        if not isinstance(server, _PublicEgressServer):
            raise RuntimeError("public egress handler has an invalid server")
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
            raise ProxyRequestError("transfer_encoding")
        values = self.headers.get_all("Content-Length", failobj=[])
        if len(values) > 1:
            raise ProxyRequestError("content_length")
        if not values:
            return 0
        encoded_length = values[0].strip()
        if not encoded_length.isascii() or not encoded_length.isdecimal():
            raise ProxyRequestError("content_length")
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
            if self.proxy._expired():
                raise ProxyRequestError("ttl")
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
                except socket.timeout:
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
            if self.proxy._expired():
                raise ProxyRequestError("ttl")
            addresses = self.proxy._resolve_public(host, port)
            deadline = self.proxy._connection_deadline()
            upstream = self.proxy._connect(addresses, port, deadline)
            connected = True
            self.proxy._register_socket(upstream)
            self.connection.sendall(
                b"HTTP/1.1 200 Connection Established\r\n\r\n"
            )
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
                    source = key.fileobj
                    if not isinstance(source, socket.socket):
                        continue
                    destination, direction = directions[source]
                    try:
                        chunk = source.recv(TRANSFER_CHUNK_BYTES)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(source)
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
    ):
        if (
            not isinstance(token, str)
            or not token
            or len(token) > MAX_TOKEN_LENGTH
            or not token.isascii()
            or any(ord(character) < 0x21 or ord(character) > 0x7E for character in token)
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

        self._token = token
        self._ttl_sec = float(ttl_sec)
        self._max_total_bytes = max_total_bytes
        self._connection_slots = threading.BoundedSemaphore(max_connections)
        self._resolver: Resolver = _default_resolver
        self._connector: Connector = _default_connector
        self._monotonic = time.monotonic
        self._wall_time = time.time

        self._lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._active_sockets: set[socket.socket] = set()
        self._server: _PublicEgressServer | None = None
        self._server_thread: threading.Thread | None = None
        self._expiry_thread: threading.Thread | None = None
        self._expiry_cancel = threading.Event()
        self._started_monotonic: float | None = None
        self._expires_monotonic: float | None = None
        self._started_wall: float | None = None
        self._stopped_wall: float | None = None
        self._stopping = False

        self._allowed = 0
        self._denied = 0
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
                ("0.0.0.0", 0), _PublicEgressHandler, self
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
                target=self._expire_server,
                name="pico-public-egress-expiry",
                daemon=True,
            )
            self._expiry_thread = expiry_thread
            expiry_thread.start()
            return int(server.server_address[1])

    def stop(self) -> dict[str, Any]:
        with self._lifecycle_lock:
            if not self._stopping:
                self._stopping = True
                self._stopped_wall = self._wall_time()
            server = self._server
            server_thread = self._server_thread
            expiry_thread = self._expiry_thread
            self._expiry_cancel.set()

        if server is not None:
            server.shutdown()
            server.server_close()
        self._close_active_sockets()
        current = threading.current_thread()
        if server_thread is not None and server_thread is not current:
            server_thread.join(timeout=2)
        if expiry_thread is not None and expiry_thread is not current:
            expiry_thread.join(timeout=2)
        self._token = ""
        if (
            server_thread is not None
            and server_thread is not current
            and server_thread.is_alive()
        ) or (
            expiry_thread is not None
            and expiry_thread is not current
            and expiry_thread.is_alive()
        ):
            self._close_active_sockets()
            raise RuntimeError("public egress proxy did not stop cleanly")
        return self._receipt()

    def _expire_server(self) -> None:
        if self._expiry_cancel.wait(self._ttl_sec):
            return
        with self._lifecycle_lock:
            server = self._server
        if server is not None:
            server.shutdown()
        self._close_active_sockets()

    def _close_active_sockets(self) -> None:
        with self._lock:
            active = tuple(self._active_sockets)
        for connection in active:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            _safe_close(connection)

    def _register_socket(self, connection: socket.socket) -> None:
        with self._lock:
            if self._stopping:
                raise ProxyRequestError("stopped")
            self._active_sockets.add(connection)

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
        expires = self._expires_monotonic
        return (
            expires is None
            or self._stopping
            or self._monotonic() >= expires
        )

    def _connection_deadline(self) -> float:
        expires = self._expires_monotonic
        if expires is None or self._stopping:
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
        if self._stopping:
            raise ProxyRequestError("stopped")
        expires = self._expires_monotonic
        now = self._monotonic()
        if expires is None or now >= expires:
            raise ProxyRequestError("ttl")
        if now >= deadline:
            raise ProxyRequestError("connection_timeout")

    def _resolve_public(self, host: str, port: int) -> tuple[str, ...]:
        blocked_reason = _blocked_host_reason(host)
        if blocked_reason is not None:
            raise ProxyRequestError(blocked_reason)
        try:
            resolved = tuple(self._resolver(host, port))
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
            if isinstance(address, ipaddress.IPv6Address) and (
                address.ipv4_mapped is not None
                or any(
                    address in network
                    for network in _BLOCKED_IPV6_TRANSITION_NETWORKS
                )
            ):
                raise ProxyRequestError("transition_address")
            if (
                not address.is_global
                or address.is_multicast
                or address.is_unspecified
                or address.is_reserved
            ):
                raise ProxyRequestError("non_public_address")
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
                "bytes": dict(self._bytes),
                "decisions": [dict(decision) for decision in self._decisions],
                "decisionsTruncated": self._decisions_truncated,
            }


__all__ = [
    "ALLOWED_CONNECT_PORTS",
    "ALLOWED_HTTP_PORTS",
    "DEFAULT_MAX_CONNECTIONS",
    "DEFAULT_MAX_TOTAL_BYTES",
    "PROXY_POLICY_VERSION",
    "PUBLIC_EGRESS_CONNECTION_TIMEOUT_SEC",
    "PublicEgressProxy",
]
