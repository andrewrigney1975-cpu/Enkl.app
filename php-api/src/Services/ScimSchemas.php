<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

/** Ported from Dtos/ScimDtos.cs's ScimSchemas — SCIM 2.0 (RFC 7643/7644) schema URNs. */
final class ScimSchemas
{
    public const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
    public const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
    public const LIST_RESPONSE = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
    public const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
    public const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
}
