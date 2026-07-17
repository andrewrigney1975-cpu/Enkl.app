<?php

declare(strict_types=1);

namespace Enkl\Api\Tests\Support;

/**
 * A minimal cURL wrapper against the real `php -S` test server (see ../bootstrap.php) — no HTTP
 * client library dependency, matching this repo's existing zero-dependency tooling style
 * (contract-tests/'s own hand-rolled Node fetch usage; CLAUDE.md §10).
 */
final class Http
{
    /** @return array{status:int, body:array<mixed>|null} */
    public static function post(string $path, array $body = [], ?string $token = null, array $headers = []): array
    {
        return self::request('POST', $path, $body, $token, $headers);
    }

    /** @return array{status:int, body:array<mixed>|null} */
    public static function get(string $path, ?string $token = null, array $headers = []): array
    {
        return self::request('GET', $path, null, $token, $headers);
    }

    /** @return array{status:int, body:array<mixed>|null} */
    public static function delete(string $path, ?string $token = null, array $headers = []): array
    {
        return self::request('DELETE', $path, null, $token, $headers);
    }

    /** @return array{status:int, body:array<mixed>|null} */
    private static function request(string $method, string $path, ?array $body, ?string $token, array $headers): array
    {
        $ch = curl_init(testServerBaseUrl() . $path);
        $allHeaders = ['Content-Type: application/json'];
        if ($token !== null) {
            $allHeaders[] = 'Authorization: Bearer ' . $token;
        }
        foreach ($headers as $name => $value) {
            $allHeaders[] = "{$name}: {$value}";
        }

        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $allHeaders,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
        }

        $raw = curl_exec($ch);
        if ($raw === false) {
            throw new \RuntimeException('cURL request failed: ' . curl_error($ch));
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        $decoded = $raw === '' ? null : json_decode($raw, true);
        return ['status' => $status, 'body' => $decoded];
    }
}
