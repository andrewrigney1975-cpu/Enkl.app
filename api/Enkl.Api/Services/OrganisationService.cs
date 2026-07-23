using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Domain;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

public class OrganisationService
{
    private readonly AppDbContext _db;
    private readonly IValidator<CreateUserRequest> _createUserValidator;
    private readonly SseBroadcaster _broadcaster;

    public OrganisationService(AppDbContext db, IValidator<CreateUserRequest> createUserValidator, SseBroadcaster broadcaster)
    {
        _db = db;
        _createUserValidator = createUserValidator;
        _broadcaster = broadcaster;
    }

    public async Task<OrganisationDetailDto?> GetOrganisationAsync(Guid organisationId)
    {
        var org = await _db.Organisations
            .AsNoTracking()
            .Include(o => o.Users)
            .FirstOrDefaultAsync(o => o.Id == organisationId);
        if (org is null) return null;

        var online = _broadcaster.GetOnlineUserIds();
        return new OrganisationDetailDto(
            org.Id, org.Name,
            org.DefaultNewUserPasswordHash is not null,
            org.Users.Select(u => new OrgUserDto(u.Id, u.Username, u.EmailAddress, u.DisplayName, u.IsOrgAdmin, u.IsActive, u.CreatedAt, online.Contains(u.Id), u.PasswordHash is not null)).ToList());
    }

    /// <summary>
    /// Lets an OrgAdmin configure the password newly (implicitly) created users in their org get,
    /// instead of the hardcoded PasswordHasher.GlobalDefaultNewUserPassword every org used to share.
    /// Only the bcrypt HASH is ever persisted (see Organisation.DefaultNewUserPasswordHash's own
    /// comment) — there is deliberately no corresponding "get the current default password" endpoint;
    /// an admin who forgets what they set can only overwrite it with a new one, never read it back.
    /// </summary>
    public async Task<bool> SetDefaultNewUserPasswordAsync(Guid organisationId, string password)
    {
        if (string.IsNullOrEmpty(password) || password.Length < 8)
        {
            throw new ApiValidationException("Password must be at least 8 characters.");
        }

        var org = await _db.Organisations.FirstOrDefaultAsync(o => o.Id == organisationId);
        if (org is null) return false;

        org.DefaultNewUserPasswordHash = PasswordHasher.Hash(password);
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>The single place every implicit-account-creation path (MemberService.CreateAsync,
    /// MigrationEntityBuilder) resolves what a new User's PasswordHash should be — the org's own
    /// configured default if an OrgAdmin has set one, otherwise the system-wide fallback. Returns the
    /// HASH directly (never re-hashes an already-hashed value), same as CreateUserAsync's own
    /// PasswordHasher.Hash(request.Password) call one level up.</summary>
    public async Task<string> ResolveDefaultNewUserPasswordHashAsync(Guid organisationId)
    {
        var existingHash = await _db.Organisations
            .Where(o => o.Id == organisationId)
            .Select(o => o.DefaultNewUserPasswordHash)
            .FirstOrDefaultAsync();
        return existingHash ?? PasswordHasher.Hash(PasswordHasher.GlobalDefaultNewUserPassword);
    }

    /// <summary>Returns false if the target user doesn't exist or belongs to a different Organisation
    /// than the caller — an OrgAdmin can only manage users within their own org.</summary>
    public async Task<bool> SetUserAdminAsync(Guid callerOrganisationId, Guid targetUserId, bool isOrgAdmin)
    {
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == targetUserId);
        if (user is null || user.OrganisationId != callerOrganisationId) return false;

        user.IsOrgAdmin = isOrgAdmin;
        // Security review finding H2: without this, a demoted org-admin (or a newly-promoted one
        // whose token still carries the OLD orgAdmin=false claim) keeps using their existing token,
        // with its now-stale orgAdmin claim, until it naturally expires — up to 8 hours.
        user.SecurityStamp = Guid.NewGuid();
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>
    /// OrgAdmin-initiated password reset for an existing user — distinct from
    /// SetDefaultNewUserPasswordAsync (which only affects users created *after* the setting changes)
    /// and CreateUserAsync (which creates a brand-new account). A null/blank <paramref name="password"/>
    /// falls back to the org's configured default via ResolveDefaultNewUserPasswordHashAsync (the same
    /// value a freshly-created implicit user would get), so "reset to default" is just "omit the
    /// field" rather than a separate action. Always sets MustChangePassword, same as every other path
    /// that puts a password on someone's behalf — the admin choosing/generating it isn't the same
    /// person who'll actually use it. Rotates SecurityStamp so any session already open under the old
    /// password is forced to re-authenticate on its very next request (§4/H2's revocation mechanism),
    /// exactly like DeactivateUserAsync/SetUserAdminAsync already do for their own credential-adjacent
    /// changes.
    ///
    /// Rejects outright (ApiValidationException, not a silent no-op) for a User whose PasswordHash is
    /// null — an SSO/SCIM-provisioned account has no password to reset in the first place (see
    /// User.cs's own comment on why that column is nullable). This isn't a cross-org enumeration
    /// concern (the caller already has full visibility into their own org's user list, SSO status
    /// included, via GetOrganisationAsync) — it's just "this action doesn't apply to a user in this
    /// state," same as DeactivateUserAsync's self-deactivation guard being an explicit error too.
    /// </summary>
    public async Task<bool> ResetUserPasswordAsync(Guid callerOrganisationId, Guid targetUserId, string? password)
    {
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == targetUserId);
        if (user is null || user.OrganisationId != callerOrganisationId) return false;

        if (user.PasswordHash is null)
        {
            throw new ApiValidationException("This user signs in via SSO and has no password to reset.");
        }

        if (string.IsNullOrEmpty(password))
        {
            user.PasswordHash = await ResolveDefaultNewUserPasswordHashAsync(callerOrganisationId);
        }
        else
        {
            if (password.Length < 8)
            {
                throw new ApiValidationException("Password must be at least 8 characters.");
            }
            user.PasswordHash = PasswordHasher.Hash(password);
        }

        user.MustChangePassword = true;
        user.SecurityStamp = Guid.NewGuid();
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>
    /// Explicit account creation by an OrgAdmin, distinct from the implicit account-per-name creation
    /// MemberService/MigrationService do when adding a project member — here the admin sets a real
    /// username and an initial password directly (not the org's configured default/global fallback
    /// those other paths use — see ResolveDefaultNewUserPasswordHashAsync), and the new user is
    /// required to change it on first login, same as everywhere else a password gets set on someone's
    /// behalf. Usernames are unique across the whole system, not
    /// just this Organisation — matches how login (AuthController) resolves a username with no org
    /// scoping at all. Email is required here (unlike the implicit-creation paths, which can fall
    /// back to leaving it blank and flagging it for later) since an OrgAdmin explicitly filling out
    /// this form has no excuse not to supply one — it's the planned SAML2 identifier.
    /// </summary>
    public async Task<OrgUserDto> CreateUserAsync(Guid organisationId, CreateUserRequest request)
    {
        await _createUserValidator.ValidateAndThrowApiExceptionAsync(request);

        var displayName = (request.DisplayName ?? "").Trim();
        if (displayName.Length > 200) displayName = displayName[..200];

        var normalized = UsernameNormalizer.Normalize(request.Username ?? "");
        if (await _db.Users.AnyAsync(u => u.NormalizedUsername == normalized))
        {
            throw new ApiValidationException($"Username \"{normalized}\" is already taken.");
        }

        var (email, normalizedEmail) = await EmailValidation.ValidateAndNormalizeAsync(_db, request.EmailAddress, requireEmail: true, excludeUserId: null);

        var user = new User
        {
            Id = Guid.NewGuid(),
            OrganisationId = organisationId,
            Username = normalized,
            NormalizedUsername = normalized,
            EmailAddress = email,
            NormalizedEmailAddress = normalizedEmail,
            PasswordHash = PasswordHasher.Hash(request.Password),
            DisplayName = displayName,
            MustChangePassword = true,
            IsOrgAdmin = false,
            CreatedAt = DateTime.UtcNow
        };
        _db.Users.Add(user);
        await _db.SaveChangesAsync();

        return new OrgUserDto(user.Id, user.Username, user.EmailAddress, user.DisplayName, user.IsOrgAdmin, user.IsActive, user.CreatedAt, false, true);
    }

    /// <summary>
    /// The backfill path for a User created before this field existed (or migrated without one, see
    /// MigrationService's warnings) — same validation as CreateUserAsync, scoped to the caller's own
    /// Organisation the same way SetUserAdminAsync is.
    /// </summary>
    public async Task<bool> SetUserEmailAsync(Guid callerOrganisationId, Guid targetUserId, string emailAddress)
    {
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == targetUserId);
        if (user is null || user.OrganisationId != callerOrganisationId) return false;

        var (email, normalizedEmail) = await EmailValidation.ValidateAndNormalizeAsync(_db, emailAddress, requireEmail: true, excludeUserId: user.Id);
        user.EmailAddress = email;
        user.NormalizedEmailAddress = normalizedEmail;
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>
    /// Org-admin-initiated deprovisioning — flips IsActive false and rotates SecurityStamp, the same
    /// pattern ScimUserService's Active-flag path already uses for SCIM-driven deactivation. Rotating
    /// SecurityStamp means any already-issued JWT for this user is rejected on its very next request
    /// (§4/H2's revocation mechanism), not just at its natural ~8h expiry. An OrgAdmin cannot
    /// deactivate their own account — a guard against a self-lockout misclick, not itself a security
    /// boundary. Idempotent: deactivating an already-inactive user returns true without rotating the
    /// stamp again. Does not touch ProjectMember/OrgTeamMember rows or reassign anything they own —
    /// see the frontend's own handling of an inactive member's still-displayed name/assignments.
    /// </summary>
    public async Task<bool> DeactivateUserAsync(Guid callerOrganisationId, Guid callerUserId, Guid targetUserId)
    {
        if (targetUserId == callerUserId)
        {
            throw new ApiValidationException("You cannot deactivate your own account.");
        }

        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == targetUserId);
        if (user is null || user.OrganisationId != callerOrganisationId) return false;

        if (!user.IsActive) return true;

        user.IsActive = false;
        user.SecurityStamp = Guid.NewGuid();
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>Read-only listing for the SSO & Provisioning modal's Org Teams section — see
    /// OrgTeamSummaryDto's own comment for why there's no corresponding write method here.</summary>
    public async Task<List<OrgTeamSummaryDto>> GetOrgTeamsAsync(Guid organisationId)
    {
        var teams = await _db.OrgTeams
            .AsNoTracking()
            .Include(t => t.Members).ThenInclude(m => m.User)
            .Where(t => t.OrganisationId == organisationId)
            .OrderBy(t => t.Name)
            .ToListAsync();

        return teams.Select(t => new OrgTeamSummaryDto(
            t.Id, t.Name,
            t.Members.Select(m => new OrgTeamMemberSummaryDto(m.UserId, m.User.DisplayName)).ToList()
        )).ToList();
    }
}
