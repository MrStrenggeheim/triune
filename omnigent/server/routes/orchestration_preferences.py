"""Authenticated personal control over new session orchestration actions."""

from functools import partial

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, StrictBool, TypeAdapter, ValidationError

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.preference_sync import Name
from omnigent.server.auth import AuthProvider
from omnigent.server.feature_flags import Feature
from omnigent.server.preference_requests import read_preference_payload, run_preference_work
from omnigent.server.routes._auth_helpers import require_user
from omnigent.server.routes._content_type import require_json_content_type
from omnigent.server.routes._origin import require_trusted_origin
from omnigent.stores.orchestration_preference_store import OrchestrationPreferenceStore

_USER_ID = TypeAdapter(Name)


class OrchestrationPreferenceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool


class OrchestrationPreferenceResponse(BaseModel):
    enabled: bool
    server_enabled: bool


def create_orchestration_preferences_router(
    store: OrchestrationPreferenceStore,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    router = APIRouter()

    def user_id(request: Request) -> str | None:
        authenticated = require_user(request, auth_provider)
        if authenticated is None:
            return None
        try:
            return _USER_ID.validate_python(authenticated)
        except ValidationError as exc:
            raise OmnigentError(
                "Invalid preference user ID", code=ErrorCode.INVALID_INPUT
            ) from exc

    def response(request: Request, enabled: bool) -> OrchestrationPreferenceResponse:
        return OrchestrationPreferenceResponse(
            enabled=enabled,
            server_enabled=request.app.state.feature_flags.enabled(Feature.SESSION_ORCHESTRATION),
        )

    @router.get("/preferences/session-orchestration")
    async def read_preference(request: Request) -> OrchestrationPreferenceResponse:
        authenticated = user_id(request)
        enabled = await run_preference_work(
            authenticated, partial(store.get_enabled, user_id=authenticated)
        )
        return response(request, enabled)

    @router.put(
        "/preferences/session-orchestration",
        dependencies=[Depends(require_json_content_type), Depends(require_trusted_origin)],
    )
    async def save_preference(request: Request) -> OrchestrationPreferenceResponse:
        authenticated = user_id(request)
        payload = await read_preference_payload(request, 1024)
        try:
            body = OrchestrationPreferenceUpdate.model_validate_json(payload)
        except ValidationError as exc:
            raise HTTPException(422, "Invalid session orchestration preference") from exc
        enabled = await run_preference_work(
            authenticated, partial(store.set_enabled, body.enabled, user_id=authenticated)
        )
        return response(request, enabled)

    return router
