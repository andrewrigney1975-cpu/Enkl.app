<?php

declare(strict_types=1);

namespace Enkl\Api\Validation;

use RuntimeException;

/**
 * Ported from Validation/ApiValidationException.cs — a caller-facing rejection (cycle checks, bad
 * input, key collisions, etc.), not a bug. The global error handler (see src/bootstrap.php) maps this
 * to a 400 with the message shown as-is, and deliberately does NOT log it as an error, mirroring the
 * .NET side's exception middleware exactly.
 */
final class ApiValidationException extends RuntimeException
{
}
