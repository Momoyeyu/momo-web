from typing import Literal
from fastapi import APIRouter,HTTPException
from pydantic import BaseModel
from ..services.app_permissions import permissions
from ..services.coordinator import runtime
router=APIRouter(prefix='/api/computer')
class Owner(BaseModel):
 clientId:str
 leaseId:str
class Decision(Owner):
 decision:Literal['once','always','deny']
 capabilities:list[Literal['observe','interact']]|None=None
def owned(body):
 try:runtime.require_meeting(body.clientId,body.leaseId)
 except Exception:raise HTTPException(409,'Active owner required') from None
@router.get('/approvals')
def status():return permissions.status()
@router.post('/approvals/{request_id}/decision')
def decision(request_id:str,body:Decision):
 owned(body)
 try:return permissions.decide(request_id,body.decision,runtime.epoch,body.capabilities)
 except ValueError as e:raise HTTPException(409,str(e)) from None
@router.delete('/permissions/{app_id}')
def remove(app_id:str,body:Owner):
 owned(body);return permissions.remove(app_id)
