<?php

declare(strict_types=1);

namespace Enkl\Api\Auth;

/**
 * PHP's native password_hash()/password_verify() (PASSWORD_BCRYPT) produces/reads the exact same
 * $2y$ hash format as .NET's BCrypt.Net-Next — a password set via one API tier verifies correctly
 * against the other without any migration step, as long as both point at the same Users table.
 */
final class PasswordHasher
{
    public static function hash(string $plainTextPassword): string
    {
        return password_hash($plainTextPassword, PASSWORD_BCRYPT);
    }

    public static function verify(string $plainTextPassword, string $hash): bool
    {
        return password_verify($plainTextPassword, $hash);
    }
}
