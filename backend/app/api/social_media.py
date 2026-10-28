"""Only locally authenticated, user-uploaded QQ attachments; no external paths."""
from fastapi import APIRouter, File, UploadFile, HTTPException
from ..services import social_media
from ..services.social import social, SocialError
router=APIRouter(prefix='/api/social/accounts/qq/media')

def allowed():
    if social._account('qq').get('permissions',{}).get('media') is not True:
        raise HTTPException(403,'Enable attachment permission first')

@router.get('')
def items():
    allowed()
    try:return {'items':social_media.listing()}
    except SocialError as error:raise HTTPException(400,str(error)) from error

@router.post('')
async def upload(file:UploadFile=File(...)):
    allowed()
    expected=social_media.binding()
    try:
        data=await file.read(social_media.MAX_BYTES+1)
        allowed()
        return social_media.store(file.filename,file.content_type,data,expected=expected)
    except SocialError as error:raise HTTPException(400,str(error)) from error
    finally:await file.close()

@router.delete('/{media_id}')
def remove(media_id:str):
    allowed()
    try:social_media.remove(media_id);return {'ok':True}
    except SocialError as error:raise HTTPException(400,str(error)) from error
