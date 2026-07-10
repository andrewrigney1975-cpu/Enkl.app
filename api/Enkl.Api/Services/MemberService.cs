using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Domain;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
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

    // Mirrors MEMBER_PALETTE in src/js/config.js exactly, so a member added from a browser and one
    // added via a fresh migration land on the same color for the same position.
    private static readonly string[] MemberPalette =
    {
        "#0052CC", "#00875A", "#FF8B00", "#974DE2", "#DE350B",
        "#006644", "#5243AA", "#B04632", "#1B5E20", "#8777D9"
    };

    public MemberService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<MemberDto?> CreateAsync(Guid projectId, CreateMemberRequest request)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return null;

        var trimmedName = (request.Name ?? "").Trim();
        if (trimmedName.Length == 0) throw new ApiValidationException("Please enter a name.");
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

        return new MemberDto(member.Id, member.UserId, user.DisplayName, user.EmailAddress, member.Color, member.Role, member.ReportsToId);
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
        return new MemberDto(member.Id, member.UserId, member.User.DisplayName, member.User.EmailAddress, member.Color, member.Role, member.ReportsToId);
    }

    public async Task<bool> DeleteAsync(Guid projectId, Guid memberId)
    {
        var member = await _db.ProjectMembers.FirstOrDefaultAsync(m => m.Id == memberId && m.ProjectId == projectId);
        if (member is null) return false;

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
