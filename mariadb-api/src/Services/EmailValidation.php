<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Auth\EmailAddressNormalizer;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/**
 * Ported from Services/EmailValidation.cs. Shared by every path that sets Users.EmailAddress
 * (OrganisationService's explicit create/backfill, MemberService's implicit per-project creation,
 * MigrationService's batch import): trims, requires (when $requireEmail), validates format, and
 * pre-checks global uniqueness against NormalizedEmailAddress. $excludeUserId lets an update
 * re-save a user's own unchanged email without tripping over itself.
 */
final class EmailValidation
{
    /** @return array{0: ?string, 1: ?string} [email, normalizedEmail] */
    public static function validateAndNormalize(PDO $db, ?string $rawEmail, bool $requireEmail, ?string $excludeUserId): array
    {
        $trimmed = trim((string) $rawEmail);
        if ($trimmed === '') {
            if ($requireEmail) {
                throw new ApiValidationException('Please enter an email address.');
            }
            return [null, null];
        }
        if (strlen($trimmed) > 320) {
            throw new ApiValidationException('Email address is too long.');
        }
        if (!EmailAddressNormalizer::isValidFormat($trimmed)) {
            throw new ApiValidationException('Please enter a valid email address.');
        }

        $normalized = EmailAddressNormalizer::normalize($trimmed);
        $sql = 'SELECT 1 FROM "Users" WHERE "NormalizedEmailAddress" = :n';
        $params = ['n' => $normalized];
        if ($excludeUserId !== null) {
            $sql .= ' AND "Id" != :excludeId';
            $params['excludeId'] = $excludeUserId;
        }
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        if ($stmt->fetch() !== false) {
            throw new ApiValidationException("Email address \"{$trimmed}\" is already in use.");
        }

        return [$trimmed, $normalized];
    }
}
