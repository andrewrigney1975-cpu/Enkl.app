using Enkl.Api.Data;
using Enkl.Api.Domain;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// Shared by every path that sets User.EmailAddress (OrganisationService's explicit create/backfill,
/// MemberService's implicit per-project creation, MigrationService's batch import): trims, requires
/// (when requireEmail), validates format, and pre-checks global uniqueness against
/// NormalizedEmailAddress — the same trim -> required -> uniqueness-precheck idiom
/// OrganisationService.CreateUserAsync already used for NormalizedUsername before this existed.
/// excludeUserId lets an update re-save a user's own unchanged email without tripping over itself.
/// </summary>
internal static class EmailValidation
{
    public static async Task<(string? Email, string? NormalizedEmail)> ValidateAndNormalizeAsync(
        AppDbContext db, string? rawEmail, bool requireEmail, Guid? excludeUserId)
    {
        var trimmed = (rawEmail ?? "").Trim();
        if (trimmed.Length == 0)
        {
            if (requireEmail) throw new ApiValidationException("Please enter an email address.");
            return (null, null);
        }
        if (trimmed.Length > 320) throw new ApiValidationException("Email address is too long.");
        if (!EmailAddressNormalizer.IsValidFormat(trimmed)) throw new ApiValidationException("Please enter a valid email address.");

        var normalized = EmailAddressNormalizer.Normalize(trimmed);
        var taken = await db.Users.AnyAsync(u => u.NormalizedEmailAddress == normalized && u.Id != excludeUserId);
        if (taken) throw new ApiValidationException($"Email address \"{trimmed}\" is already in use.");

        return (trimmed, normalized);
    }
}
