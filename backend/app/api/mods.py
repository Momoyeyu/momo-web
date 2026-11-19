from fastapi import APIRouter, HTTPException, Request, UploadFile, Response
from fastapi.routing import APIRoute
from starlette.formparsers import MultiPartException
from pydantic import BaseModel, ConfigDict, StrictBool
from ..services import mod_bundle, mods


class BoundedUpload(APIRoute):
    def get_route_handler(self):
        handle = super().get_route_handler()
        if self.path != "/api/mods" or "POST" not in self.methods:
            return handle

        async def bounded(request: Request):
            # Check while Starlette spools multipart files, including chunked uploads.
            limit = mod_bundle.MAX_BUNDLE + 65536
            declared = request.headers.get("content-length", "")
            if declared.isdecimal() and int(declared) > limit:
                raise HTTPException(413, "Mod upload exceeds size limit")
            consumed = 0

            async def receive():
                nonlocal consumed
                packet = await request.receive()
                consumed += len(packet.get("body", b""))
                if consumed > limit:
                    # The multipart parser closes its temporary files on this exception.
                    raise MultiPartException("Mod upload exceeds size limit")
                return packet

            return await handle(Request(request.scope, receive))

        return bounded


router = APIRouter(prefix="/api/mods", route_class=BoundedUpload)


class Toggle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool


def invoke(fn, *args):
    try:
        return fn(*args)
    except KeyError:
        raise HTTPException(404, "Mod or resource unavailable") from None
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except mods.ModRuntimeError as error:
        raise HTTPException(409, str(error)) from error


@router.get("")
def listing():
    return {"mods": mods.listing()}


@router.post("")
def install(file: UploadFile):
    if not (file.filename or "").lower().endswith(".momomod"):
        raise HTTPException(400, "Expected .momomod package")
    return invoke(mods.install, file.file)


@router.post("/official/{ident}")
def official(ident: str):
    return invoke(mods.install_official, ident)


@router.patch("/{ident}")
def toggle(ident: str, body: Toggle):
    return invoke(mods.set_enabled, ident, body.enabled)


@router.delete("/{ident}")
def remove(ident: str):
    return invoke(mods.uninstall, ident)


@router.get("/{ident}/assets/{path:path}")
def asset(ident: str, path: str, v: str | None = None):
    content, mime = invoke(mods.asset, ident, path, v)
    return Response(content, media_type=mime, headers={"Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'"})
