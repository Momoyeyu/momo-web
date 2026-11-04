from unittest.mock import patch
import pytest
from app.services.browser_fetch import domains, target, FetchError

PUBLIC=(2,1,6,'',('93.184.216.34',443))
PRIVATE=(2,1,6,'',('127.0.0.1',443))

@pytest.mark.parametrize('url',['http://example.com','https://localhost','https://example.com:444/','https://user:pass@example.com/','https://evil.example.com/'])
def test_scope_rejected_before_dns(url):
    with patch('socket.getaddrinfo') as dns:
        with pytest.raises(FetchError): target(url,['example.com'])
        dns.assert_not_called()

def test_public_ip_is_pinned_and_mixed_private_answers_rejected():
    with patch('socket.getaddrinfo',return_value=[PUBLIC]):
        assert target('https://example.com/a',['example.com'])[2] == PUBLIC
    with patch('socket.getaddrinfo',return_value=[PUBLIC,PRIVATE]):
        with pytest.raises(FetchError): target('https://example.com/a',['example.com'])

@pytest.mark.parametrize('entry',['*.example.com','https://example.com','127.0.0.1','localhost','example.com/path'])
def test_host_configuration_has_no_wildcards_or_local_targets(entry):
    with pytest.raises(FetchError): domains([entry])

def test_host_normalization():
    assert domains(['EXAMPLE.COM','example.com.']) == ['example.com']
