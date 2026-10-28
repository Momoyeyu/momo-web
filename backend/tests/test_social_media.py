import os
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.services import social_media
from app.services.social import social,SocialError
from conftest import configured_native_social


def test_user_media_is_private_bounded_and_account_and_audience_scoped():
    configured_native_social(social,permissions={'media':True})
    row=social_media.store('note.txt','text/plain',b'hello')
    assert social_media.payload(row['mediaId'])['dataBase64']=='aGVsbG8='
    assert social_media.listing()==[row]
    with pytest.raises(SocialError):social_media.payload(row['mediaId'],audience='another-contact')
    social.put('qq',{'enabled':False,'expectedSelfId':'12345'})
    assert social_media.listing()==[]
    with pytest.raises(SocialError):social_media.payload(row['mediaId'])


def test_media_rejects_paths_scripts_invalid_sizes_and_symlink_reads(tmp_path):
    configured_native_social(social,permissions={'media':True})
    for name,mime,data in [('../password','text/plain',b'x'),('foo.exe','application/octet-stream',b'x'),('empty.txt','text/plain',b''),('x.txt','text/plain',b'x'*(social_media.MAX_BYTES+1))]:
        with pytest.raises(SocialError):social_media.store(name,mime,data)
    row=social_media.store('note.txt','text/plain',b'hello')
    binary=social_media._root()/(row['mediaId']+'.bin');binary.unlink();binary.symlink_to(tmp_path/'secret')
    with pytest.raises(SocialError):social_media.payload(row['mediaId'])


def test_media_api_requires_permission_and_validates_before_commit():
    configured_native_social(social)
    client=TestClient(app)
    assert client.get('/api/social/accounts/qq/media').status_code==403
    social.put('qq',{'permissions':{'media':True}})
    uploaded=client.post('/api/social/accounts/qq/media',files={'file':('note.txt',b'hello','text/plain')})
    assert uploaded.status_code==200
    item=uploaded.json()
    assert set(item)=={'mediaId','name','mime','size'}
    assert client.get('/api/social/accounts/qq/media').json()=={'items':[item]}
    assert client.delete('/api/social/accounts/qq/media/'+item['mediaId']).status_code==200
    assert client.get('/api/social/accounts/qq/media').json()=={'items':[]}
