<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

// .env is optional — in production the host environment (systemd unit, php-fpm pool config, etc.)
// may set these as real env vars instead of shipping a .env file at all. safeLoad() doesn't error if
// the file is missing, so both deployment styles work unmodified.
(\Dotenv\Dotenv::createImmutable(__DIR__ . '/..'))->safeLoad();

require __DIR__ . '/../src/bootstrap.php';

$app = buildApp();
$app->run();
