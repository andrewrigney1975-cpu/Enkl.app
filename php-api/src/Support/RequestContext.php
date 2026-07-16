<?php

declare(strict_types=1);

namespace Enkl\Api\Support;

/**
 * Holds the current request's correlation ID (set once by CorrelationIdMiddleware) so Log::channel()
 * can stamp it onto every log line without threading the PSR-7 request through every call site.
 * A static property is the correct equivalent of .NET's Serilog LogContext here: PHP-FPM has no
 * ambient async-context propagation, but it also has no concurrency within one request's lifecycle,
 * so "one static slot per process, set at the top of the request" is safe and simple.
 */
final class RequestContext
{
    private static ?string $correlationId = null;

    public static function setCorrelationId(string $id): void
    {
        self::$correlationId = $id;
    }

    public static function getCorrelationId(): ?string
    {
        return self::$correlationId;
    }
}
