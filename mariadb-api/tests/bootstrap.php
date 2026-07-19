<?php

declare(strict_types=1);

use Enkl\Api\Db\Database;
use Enkl\Api\Db\Migrator;

require __DIR__ . '/../vendor/autoload.php';

/**
 * Ported from php-api/tests/bootstrap.php — same shape, MariaDB instead of Postgres. Deliberately
 * real MariaDB + a real `php -S` process, not a mocked PDO or a Slim in-process request — same
 * reasoning as the .NET side's PostgresApiFixture ("a lighter substitute would silently test
 * different behavior than production"), and `php -S` is explicitly the
 * DEPLOYMENT-MARIADB.md-documented way to run this app for a quick smoke test, so AuthTest's HTTP
 * calls exercise the exact same public/index.php entry point and middleware stack production uses —
 * no separate test harness reimplementing routing.
 *
 * Nothing here spins up its own MariaDB container — that's started once by the test *runner* (see
 * mariadb-api/CLAUDE.md's own test-run recipe) and reached via DB_HOST/DB_PORT env vars already set
 * before `phpunit` is invoked. This file's job is everything downstream of "a reachable empty
 * MariaDB": wait for it, migrate it, boot a real `php -S` against it, and tear the server (not the
 * DB — the runner owns that) down when the whole run ends.
 */

putenv('APP_ENV=development');
putenv('RUN_MIGRATIONS_ON_STARTUP=false'); // this file runs migrations itself, once, up front — see below
putenv('JWT_SIGNING_KEY=test-signing-key-do-not-use-in-production-32chars');
putenv('JWT_ISSUER=Enkl.Api');
putenv('JWT_AUDIENCE=Enkl.App');
putenv('JWT_EXPIRY_HOURS=8');

const PHP_TEST_SERVER_HOST = '127.0.0.1';
const PHP_TEST_SERVER_PORT = 8097;

// Wait for the MariaDB container the test runner started — same "may not be reachable the instant
// this process starts" reasoning as Database::connectWithRetry(), just checked up front here so a
// slow-starting container fails fast with a clear message instead of a confusing mid-test PDOException.
$deadline = time() + 30;
$lastError = null;
while (time() < $deadline) {
    try {
        Database::connection();
        $lastError = null;
        break;
    } catch (\Throwable $e) {
        $lastError = $e;
        sleep(1);
    }
}
if ($lastError !== null) {
    fwrite(STDERR, "MariaDB never became reachable: {$lastError->getMessage()}\n");
    exit(1);
}

// Same migration code path production uses (Migrator), run once here rather than left to
// RUN_MIGRATIONS_ON_STARTUP — under `php -S`, buildApp() (and therefore migrations) would otherwise
// re-run on every single request, which is wasteful and racy against MigrationServiceTest's direct
// calls that also touch the schema.
(new Migrator(Database::connection(), __DIR__ . '/../src/Db/migrations'))->run();

// A real php -S process, not an in-process Slim request — see this file's own doc comment for why.
$env = array_merge($_ENV, [
    'APP_ENV' => 'development',
    'RUN_MIGRATIONS_ON_STARTUP' => 'false',
    'JWT_SIGNING_KEY' => getenv('JWT_SIGNING_KEY'),
    'JWT_ISSUER' => getenv('JWT_ISSUER'),
    'JWT_AUDIENCE' => getenv('JWT_AUDIENCE'),
    'JWT_EXPIRY_HOURS' => getenv('JWT_EXPIRY_HOURS'),
    'DB_HOST' => getenv('DB_HOST'),
    'DB_PORT' => getenv('DB_PORT'),
    'DB_NAME' => getenv('DB_NAME'),
    'DB_USER' => getenv('DB_USER'),
    'DB_PASSWORD' => getenv('DB_PASSWORD'),
]);

$descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
$serverProcess = proc_open(
    ['php', '-S', PHP_TEST_SERVER_HOST . ':' . PHP_TEST_SERVER_PORT, '-t', __DIR__ . '/../public'],
    $descriptors,
    $pipes,
    __DIR__ . '/..',
    $env
);
if (!is_resource($serverProcess)) {
    fwrite(STDERR, "Failed to start php -S test server\n");
    exit(1);
}
// Neither pipe is read from again — just detached so the child's stdout/stderr don't block on a
// full OS pipe buffer over a long test run.
stream_set_blocking($pipes[1], false);
stream_set_blocking($pipes[2], false);

$serverReady = false;
$deadline = time() + 15;
while (time() < $deadline) {
    $conn = @fsockopen(PHP_TEST_SERVER_HOST, PHP_TEST_SERVER_PORT, $errno, $errstr, 0.5);
    if ($conn !== false) {
        fclose($conn);
        $serverReady = true;
        break;
    }
    usleep(200_000);
}
if (!$serverReady) {
    fwrite(STDERR, "php -S test server never started listening on " . PHP_TEST_SERVER_PORT . "\n");
    proc_terminate($serverProcess);
    exit(1);
}

register_shutdown_function(function () use ($serverProcess, $pipes): void {
    foreach ($pipes as $pipe) {
        if (is_resource($pipe)) {
            fclose($pipe);
        }
    }
    if (is_resource($serverProcess)) {
        proc_terminate($serverProcess);
        proc_close($serverProcess);
    }
});

function testServerBaseUrl(): string
{
    return 'http://' . PHP_TEST_SERVER_HOST . ':' . PHP_TEST_SERVER_PORT;
}
