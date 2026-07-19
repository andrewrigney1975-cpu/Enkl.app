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
            org.Users.Select(u => new OrgUserDto(u.Id, u.Username, u.EmailAddress, u.DisplayName, u.IsOrgAdmin, u.IsActive, u.CreatedAt, online.Contains(u.Id))).ToList());
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
    /// Explicit account creation by an OrgAdmin, distinct from the implicit account-per-name creation
    /// MemberService/MigrationService do when adding a project member — here the admin sets a real
    /// username and an initial password directly (not the hardcoded "enklUserPassword" those other
    /// paths use), and the new user is required to change it on first login, same as everywhere else
    /// a password gets set on someone's behalf. Usernames are unique across the whole system, not
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

        return new OrgUserDto(user.Id, user.Username, user.EmailAddress, user.DisplayName, user.IsOrgAdmin, user.IsActive, user.CreatedAt, false);
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
