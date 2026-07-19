using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Domain;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// Team member CRUD for an already-migrated project. Unlike every other per-project entity, a
/// ProjectMember isn't a self-contained row — it's a join between the Project and a global User
/// account (see ProjectMember.cs's doc comment), so "add a member" here does the same
/// find-or-create-User-by-name dedup MigrationService.CreateUsersAndMembersAsync does for a whole
/// batch at once, just for one name at a time.
/// </summary>
public class MemberService
{
    private readonly AppDbContext _db;
    private readonly IValidator<CreateMemberRequest> _createValidator;

    // Mirrors MEMBER_PALETTE in src/js/config.js exactly, so a member added from a browser and one
    // added via a fresh migration land on the same color for the same position.
    private static readonly string[] MemberPalette =
    {
        "#0052CC", "#00875A", "#FF8B00", "#974DE2", "#DE350B",
        "#006644", "#5243AA", "#B04632", "#1B5E20", "#8777D9"
    };

    public MemberService(AppDbContext db, IValidator<CreateMemberRequest> createValidator)
    {
        _db = db;
        _createValidator = createValidator;
    }

    /// <summary>Backs the "Add a team member" combobox — the project's whole Organisation roster
    /// (active Users), not just its current ProjectMembers, so someone who's only a member of a
    /// sibling project in the same org still shows up as a pickable candidate here.</summary>
    public async Task<List<OrgUserCandidateDto>?> GetOrgCandidatesAsync(Guid projectId)
    {
        var project = await _db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return null;

        return await _db.Users.AsNoTracking()
            .Where(u => u.OrganisationId == project.OrganisationId && u.IsActive)
            .OrderBy(u => u.DisplayName)
            .Select(u => new OrgUserCandidateDto(u.Id, u.DisplayName, u.EmailAddress))
            .ToListAsync();
    }

    public async Task<MemberDto?> CreateAsync(Guid projectId, CreateMemberRequest request)
    {
        await _createValidator.ValidateAndThrowApiExceptionAsync(request);

        var project = await _db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return null;

        var trimmedName = (request.Name ?? "").Trim();
        if (trimmedName.Length > 60) trimmedName = trimmedName[..60];

        var normalized = UsernameNormalizer.Normalize(trimmedName);
        // Identity dedup is scoped to the Organisation, same rule migration uses — the same name in a
        // different org is a different real person and must never be silently merged.
        var user = await _db.Users.FirstOrDefaultAsync(u => u.NormalizedUsername == normalized && u.OrganisationId == project.OrganisationId);
        if (user is null)
        {
            var usernameToUse = normalized;
            if (await _db.Users.AnyAsync(u => u.NormalizedUsername == normalized))
            {
                usernameToUse = await ResolveUniqueUsernameAsync(normalized);
            }

            // This is a real User account being created, same as OrganisationService.CreateUserAsync —
            // an email is required here too, not just on the explicit OrgAdmin form.
            var (email, normalizedEmail) = await EmailValidation.ValidateAndNormalizeAsync(_db, request.Email, requireEmail: true, excludeUserId: null);

            user = new User
            {
                Id = Guid.NewGuid(),
                OrganisationId = project.OrganisationId,
                Username = usernameToUse,
                NormalizedUsername = usernameToUse,
                EmailAddress = email,
                NormalizedEmailAddress = normalizedEmail,
                PasswordHash = PasswordHasher.Hash("enklUserPassword"),
                DisplayName = trimmedName,
                MustChangePassword = true,
                IsOrgAdmin = false,
                CreatedAt = DateTime.UtcNow
            };
            _db.Users.Add(user);
        }
        else
        {
            if (await _db.ProjectMembers.AnyAsync(m => m.ProjectId == projectId && m.UserId == user.Id))
            {
                throw new ApiValidationException($"\"{user.DisplayName}\" is already a member of this project.");
            }

            // Self-heal a matched user's missing email if one was supplied — same backfill idea as
            // MigrationService's matched-existing-user case. Never blocks adding the member: an
            // invalid/duplicate email here is silently dropped rather than failing the whole request,
            // since the caller's actual intent was "add this person to the project", not "fix their
            // account". An OrgAdmin can still backfill it properly via Manage Users.
            if (user.EmailAddress is null && !string.IsNullOrWhiteSpace(request.Email))
            {
                try
                {
                    var (email, normalizedEmail) = await EmailValidation.ValidateAndNormalizeAsync(_db, request.Email, requireEmail: false, excludeUserId: user.Id);
                    user.EmailAddress = email;
                    user.NormalizedEmailAddress = normalizedEmail;
                }
                catch (ApiValidationException) { /* ignore — not the point of this request */ }
            }
        }

        var memberCount = await _db.ProjectMembers.CountAsync(m => m.ProjectId == projectId);
        var member = new ProjectMember
        {
            Id = Guid.NewGuid(),
            ProjectId = projectId,
            UserId = user.Id,
            Color = MemberPalette[memberCount % MemberPalette.Length]
        };
        _db.ProjectMembers.Add(member);
        await _db.SaveChangesAsync();

        return new MemberDto(member.Id, member.UserId, user.DisplayName, user.EmailAddress, member.Color, member.Role, member.AllocatedFraction, member.ReportsToId, member.IsProjectAdmin);
    }

    public async Task<MemberDto?> UpdateAsync(Guid projectId, Guid memberId, UpdateMemberRequest request)
    {
        var member = await _db.ProjectMembers.Include(m => m.User).FirstOrDefaultAsync(m => m.Id == memberId && m.ProjectId == projectId);
        if (member is null) return null;

        var trimmedName = (request.Name ?? "").Trim();
        if (trimmedName.Length > 0)
        {
            member.User.DisplayName = trimmedName.Length > 60 ? trimmedName[..60] : trimmedName;
        }

        var trimmedRole = (request.Role ?? "").Trim();
        member.Role = trimmedRole.Length == 0 ? null : (trimmedRole.Length > 100 ? trimmedRole[..100] : trimmedRole);

        // Clamped the same way clampAllocatedFraction does client-side (date-utils.js) — null stays
        // null (never assigned an allocation), anything else is rounded and clamped to [0, 100].
        member.AllocatedFraction = request.AllocatedFraction is { } fraction ? Math.Clamp(fraction, 0, 100) : null;

        // Same lenient fallback-to-null as mutations.js's setMemberReportsTo — a self-reference or a
        // target that isn't (or is no longer) a member of this project quietly clears the field
        // rather than erroring, since the dropdown driving this should never offer an invalid option
        // in the first place.
        if (request.ReportsToId is { } reportsToId && reportsToId != memberId &&
            await _db.ProjectMembers.AnyAsync(m => m.Id == reportsToId && m.ProjectId == projectId))
        {
            member.ReportsToId = reportsToId;
        }
        else
        {
            member.ReportsToId = null;
        }

        await _db.SaveChangesAsync();
        return new MemberDto(member.Id, member.UserId, member.User.DisplayName, member.User.EmailAddress, member.Color, member.Role, member.AllocatedFraction, member.ReportsToId, member.IsProjectAdmin);
    }

    public async Task<bool> DeleteAsync(Guid projectId, Guid memberId)
    {
        var member = await _db.ProjectMembers.FirstOrDefaultAsync(m => m.Id == memberId && m.ProjectId == projectId);
        if (member is null) return false;

        if (member.IsProjectAdmin)
        {
            await EnsureNotLastProjectAdminAsync(projectId, memberId);
        }

        // ReportsTo is a Restrict FK (see ProjectMemberConfiguration) — anyone reporting to this
        // member gets orphaned back to "no one" first, same as mutations.js's removeMember. Every
        // other reference (task Assignee, Document/Release/Risk/Decision Owner, TeamCommitteeMember)
        // is already SetNull/Cascade at the DB level, so no further manual cleanup is needed here.
        var reports = await _db.ProjectMembers.Where(m => m.ProjectId == projectId && m.ReportsToId == memberId).ToListAsync();
        foreach (var r in reports) r.ReportsToId = null;

        _db.ProjectMembers.Remove(member);
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>
    /// The Project Admin-assignment half of "manage team members" — promotes or demotes an existing
    /// member. Guards against ever leaving a project with zero Project Admins (see
    /// EnsureNotLastProjectAdminAsync's own doc comment for why that's worth blocking outright rather
    /// than just discouraging in the UI).
    /// </summary>
    public async Task<MemberDto?> SetProjectAdminAsync(Guid projectId, Guid memberId, bool isProjectAdmin)
    {
        var member = await _db.ProjectMembers.Include(m => m.User).FirstOrDefaultAsync(m => m.Id == memberId && m.ProjectId == projectId);
        if (member is null) return null;

        if (!isProjectAdmin && member.IsProjectAdmin)
        {
            await EnsureNotLastProjectAdminAsync(projectId, memberId);
        }

        member.IsProjectAdmin = isProjectAdmin;
        await _db.SaveChangesAsync();
        return new MemberDto(member.Id, member.UserId, member.User.DisplayName, member.User.EmailAddress, member.Color, member.Role, member.AllocatedFraction, member.ReportsToId, member.IsProjectAdmin);
    }

    /// <summary>
    /// A project with zero Project Admins can never have another one assigned again short of direct
    /// DB access — nobody left could reach the "manage team members" capability that grants the role
    /// in the first place. Called before demoting/removing a member who IS currently a Project Admin;
    /// throws if they're the last one, exactly the "one-endpoint-owns-the-flag"-style invariant
    /// OrganisationService/PortfolioService already enforce elsewhere in this tier for similarly
    /// unrecoverable states.
    /// </summary>
    private async Task EnsureNotLastProjectAdminAsync(Guid projectId, Guid excludingMemberId)
    {
        var anotherAdminExists = await _db.ProjectMembers.AnyAsync(m => m.ProjectId == projectId && m.Id != excludingMemberId && m.IsProjectAdmin);
        if (!anotherAdminExists)
        {
            throw new ApiValidationException("A project must always have at least one Project Admin. Assign another member as Project Admin first.");
        }
    }

    private async Task<string> ResolveUniqueUsernameAsync(string baseUsername)
    {
        var candidate = baseUsername;
        var suffix = 1;
        while (await _db.Users.AnyAsync(u => u.NormalizedUsername == candidate))
        {
            candidate = $"{baseUsername}{++suffix}";
        }
        return candidate;
    }
}
