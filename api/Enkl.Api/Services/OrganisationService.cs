using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Domain;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

public class OrganisationService
{
    private readonly AppDbContext _db;

    public OrganisationService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<OrganisationDetailDto?> GetOrganisationAsync(Guid organisationId)
    {
        var org = await _db.Organisations
            .Include(o => o.Users)
            .FirstOrDefaultAsync(o => o.Id == organisationId);
        if (org is null) return null;

        return new OrganisationDetailDto(
            org.Id, org.Name,
            org.Users.Select(u => new OrgUserDto(u.Id, u.Username, u.DisplayName, u.IsOrgAdmin, u.CreatedAt)).ToList());
    }

    /// <summary>Returns false if the target user doesn't exist or belongs to a different Organisation
    /// than the caller — an OrgAdmin can only manage users within their own org.</summary>
    public async Task<bool> SetUserAdminAsync(Guid callerOrganisationId, Guid targetUserId, bool isOrgAdmin)
    {
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == targetUserId);
        if (user is null || user.OrganisationId != callerOrganisationId) return false;

        user.IsOrgAdmin = isOrgAdmin;
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>
    /// Explicit account creation by an OrgAdmin, distinct from the implicit account-per-name creation
    /// MemberService/MigrationService do when adding a project member — here the admin sets a real
    /// username and an initial password directly (not the hardcoded "enklUserPassword" those other
    /// paths use), and the new user is required to change it on first login, same as everywhere else
    /// a password gets set on someone's behalf. Usernames are unique across the whole system, not
    /// just this Organisation — matches how login (AuthController) resolves a username with no org
    /// scoping at all.
    /// </summary>
    public async Task<OrgUserDto> CreateUserAsync(Guid organisationId, CreateUserRequest request)
    {
        var displayName = (request.DisplayName ?? "").Trim();
        if (displayName.Length == 0) throw new ApiValidationException("Please enter a display name.");
        if (displayName.Length > 200) displayName = displayName[..200];

        if (string.IsNullOrEmpty(request.Password) || request.Password.Length < 8)
        {
            throw new ApiValidationException("Password must be at least 8 characters.");
        }

        var normalized = UsernameNormalizer.Normalize(request.Username ?? "");
        if (normalized.Length == 0) throw new ApiValidationException("Please enter a username.");
        if (await _db.Users.AnyAsync(u => u.NormalizedUsername == normalized))
        {
            throw new ApiValidationException($"Username \"{normalized}\" is already taken.");
        }

        var user = new User
        {
            Id = Guid.NewGuid(),
            OrganisationId = organisationId,
            Username = normalized,
            NormalizedUsername = normalized,
            PasswordHash = PasswordHasher.Hash(request.Password),
            DisplayName = displayName,
            MustChangePassword = true,
            IsOrgAdmin = false,
            CreatedAt = DateTime.UtcNow
        };
        _db.Users.Add(user);
        await _db.SaveChangesAsync();

        return new OrgUserDto(user.Id, user.Username, user.DisplayName, user.IsOrgAdmin, user.CreatedAt);
    }
}
