using System.Text.RegularExpressions;

namespace Enkl.Api.Domain;

/// <summary>
/// Shared by every path that sets User.EmailAddress (OrganisationService, MemberService,
/// MigrationService) so uniqueness checks against NormalizedEmailAddress are always comparing
/// apples to apples — same trim+lowercase idiom as UsernameNormalizer, but without stripping
/// punctuation, since that would corrupt a real address.
/// </summary>
public static partial class EmailAddressNormalizer
{
    public static string Normalize(string email) => email.Trim().ToLowerInvariant();

    public static bool IsValidFormat(string email) => SimpleEmailShape().IsMatch(email);

    [GeneratedRegex(@"^[^@\s]+@[^@\s]+\.[^@\s]+$")]
    private static partial Regex SimpleEmailShape();
}
