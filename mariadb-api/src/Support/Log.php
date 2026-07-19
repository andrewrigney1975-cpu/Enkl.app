<?php

declare(strict_types=1);

namespace Enkl\Api\Support;

use Monolog\Formatter\JsonFormatter;
use Monolog\Handler\StreamHandler;
use Monolog\Logger;
use Monolog\Processor\ProcessorInterface;
use Psr\Log\LoggerInterface;

/**
 * ARCHITECTURE-REVIEW.md finding #5: structured JSON logs to stdout (php://stdout works whether this
 * runs under PHP-FPM/Apache today or a container later — it's captured wherever the process's stdout
 * goes). Mirrors the .NET tier's Serilog-to-console setup: one JSON object per line, correlation ID
 * merged into every record via a processor rather than passed explicitly at each call site.
 */
final class Log
{
    private static ?LoggerInterface $instance = null;

    public static function channel(): LoggerInterface
    {
        if (self::$instance === null) {
            $handler = new StreamHandler('php://stdout', Logger::DEBUG);
            $handler->setFormatter(new JsonFormatter());

            $logger = new Logger('enkl-php-api');
            $logger->pushHandler($handler);
            $logger->pushProcessor(new class implements ProcessorInterface {
                public function __invoke(\Monolog\LogRecord $record): \Monolog\LogRecord
                {
                    $correlationId = RequestContext::getCorrelationId();
                    if ($correlationId === null) {
                        return $record;
                    }
                    return $record->with(extra: $record->extra + ['correlationId' => $correlationId]);
                }
            });

            self::$instance = $logger;
        }

        return self::$instance;
    }
}
