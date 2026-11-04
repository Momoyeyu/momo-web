"""Bounded public HTTPS reads; the renderer itself has no network access."""
import http.client
import ipaddress
import socket
import ssl
import time
from urllib.parse import urlsplit, urljoin

MAX_BYTES = 2 * 1024 * 1024

class FetchError(ValueError):
    pass


def domains(values):
    if not isinstance(values, list) or len(values) > 20:
        raise FetchError('Choose at most 20 hosts')
    result = set()
    for value in values:
        host = str(value).strip().lower().rstrip('.')
        if not host or any(c in host for c in '/:@?#*'):
            raise FetchError('Use exact domain names, without URLs or wildcards')
        host = host.encode('idna').decode('ascii')
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if '.' not in host or len(host) > 253: raise FetchError('Public domain required')
        else:
            raise FetchError('IP addresses are not allowed')
        result.add(host)
    return sorted(result)


def target(url, allowed):
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or '').encode('idna').decode('ascii').lower().rstrip('.')
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None,443) or host not in allowed:
            raise FetchError('URL outside approved HTTPS hosts')
        if any(ord(c) < 32 for c in url) or len(url) > 4096:
            raise FetchError('Invalid URL')
        addresses = socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)
        if not addresses: raise FetchError('No address')
        # Reject mixed public/private answers, not only the selected address.
        for _,_,_,_,address in addresses:
            ip = ipaddress.ip_address(address[0])
            if not ip.is_global or ip.is_multicast or ip.is_unspecified or getattr(ip,'ipv4_mapped',None):
                raise FetchError('Non-public address')
        return parsed,host,addresses[0]
    except (ValueError,UnicodeError,OSError) as exc:
        raise FetchError('HTTPS target unavailable or disallowed') from exc


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self,host,address):
        super().__init__(host,timeout=8,context=ssl.create_default_context())
        self.address=address
    def connect(self):
        family,kind,proto,_,address=self.address
        sock=socket.socket(family,kind,proto)
        sock.settimeout(self.timeout)
        try:
            sock.connect(address)
            self.sock=self._context.wrap_socket(sock,server_hostname=self.host)
        except Exception:
            sock.close()
            raise


def fetch(url, allowed, validate=lambda: None):
    """No browser cookies, credentials, proxy environment, POST, or arbitrary ports."""
    deadline=time.monotonic()+24
    for _ in range(4):
        if time.monotonic()>=deadline: raise FetchError('Page request timed out')
        validate()
        parsed,host,address=target(url,allowed)
        validate()
        if time.monotonic()>=deadline: raise FetchError('Page request timed out')
        connection=PinnedHTTPS(host,address)
        try:
            path=parsed.path or '/'
            if parsed.query: path+='?'+parsed.query
            connection.request('GET',path,headers={'Accept':'text/html,text/plain','Accept-Encoding':'identity','User-Agent':'momo-browser/1.0'})
            response=connection.getresponse()
            if response.status in (301,302,303,307,308):
                location=response.getheader('Location')
                if not location: raise FetchError('Redirect without location')
                url=urljoin(url,location)
                continue
            if response.status != 200: raise FetchError('Page request failed')
            mime=(response.getheader('Content-Type') or '').split(';')[0].strip().lower()
            if mime not in ('text/html','text/plain'): raise FetchError('Only HTML and text pages are supported')
            if response.getheader('Content-Encoding','identity') != 'identity': raise FetchError('Encoded response unavailable')
            parts=[]
            size=0
            while size<=MAX_BYTES:
                validate()
                remaining=deadline-time.monotonic()
                if remaining<=0: raise FetchError('Page request timed out')
                if connection.sock: connection.sock.settimeout(min(8,remaining))
                chunk=response.read1(min(16384,MAX_BYTES+1-size))
                if not chunk: break
                parts.append(chunk)
                size+=len(chunk)
            body=b''.join(parts)
            if len(body)>MAX_BYTES: raise FetchError('Page too large')
            validate()
            charset=response.headers.get_content_charset() or 'utf-8'
            try: content=body.decode(charset,errors='replace')
            except LookupError: content=body.decode('utf-8',errors='replace')
            if mime=='text/plain':
                import html
                content='<pre style="white-space:pre-wrap">'+html.escape(content)+'</pre>'
            return content,url
        except (OSError,http.client.HTTPException) as exc:
            raise FetchError('Page unavailable') from exc
        finally:
            connection.close()
    raise FetchError('Too many redirects')
