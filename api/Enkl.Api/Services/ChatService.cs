using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// All chat data is organisation-scoped (no ProjectMember concept applies) — every method takes the
/// caller's own OrganisationId (from the JWT "orgId" claim, never trusted from the request) and
/// re-derives which channels/messages the caller may actually touch, same "never trust the client's
/// id list" standing rule as PortfolioService. Create/post: any org user. Edit: author-only. Delete:
/// author OR Org Admin (soft delete only — Text is preserved, see ChatMessage's own doc comment).
/// Viewing a channel: member OR Org Admin.
/// </summary>
public class ChatService
{
    private readonly AppDbContext _db;
    private readonly SseBroadcaster _broadcaster;

    public ChatService(AppDbContext db, SseBroadcaster broadcaster)
    {
        _db = db;
        _broadcaster = broadcaster;
    }

    // ---- Roster (member picker / @mention autocomplete / presence dots) ----

    public async Task<List<ChatOrgUserDto>> GetOrgRosterAsync(Guid organisationId)
    {
        var online = _broadcaster.GetOnlineUserIds();
        var users = await _db.Users.AsNoTracking()
            .Where(u => u.OrganisationId == organisationId && u.IsActive)
            .OrderBy(u => u.DisplayName)
            .Select(u => new { u.Id, u.DisplayName })
            .ToListAsync();

        return users.Select(u => new ChatOrgUserDto(u.Id, u.DisplayName, online.Contains(u.Id))).ToList();
    }

    // ---- Channels ----

    public async Task<ChatChannelListDto> ListChannelsAsync(Guid organisationId, Guid callerUserId, bool callerIsOrgAdmin)
    {
        var online = _broadcaster.GetOnlineUserIds();

        var allChannels = await _db.ChatChannels.AsNoTracking()
            .Include(c => c.Members).ThenInclude(m => m.User)
            .Where(c => c.OrganisationId == organisationId)
            .OrderByDescending(c => c.DateCreated)
            .ToListAsync();

        var memberChannels = allChannels.Where(c => c.Members.Any(m => m.UserId == callerUserId)).ToList();
        var adminOnlyChannels = callerIsOrgAdmin
            ? allChannels.Where(c => c.Members.All(m => m.UserId != callerUserId)).ToList()
            : new List<ChatChannel>();

        return new ChatChannelListDto(
            memberChannels.Select(c => ToChannelDto(c, online)).ToList(),
            adminOnlyChannels.Select(c => ToChannelDto(c, online)).ToList());
    }

    public async Task<ChatChannelDto> CreateChannelAsync(Guid organisationId, Guid callerUserId, string callerDisplayName, CreateChatChannelRequest request)
    {
        var memberIds = new HashSet<Guid>(request.MemberUserIds ?? new List<Guid>()) { callerUserId };

        // Every requested member must actually belong to the caller's own org — re-derived server-
        // side, never trusted from the client's id list.
        var validMemberIds = await _db.Users.AsNoTracking()
            .Where(u => u.OrganisationId == organisationId && memberIds.Contains(u.Id))
            .Select(u => u.Id)
            .ToListAsync();
        if (validMemberIds.Count == 0) validMemberIds = new List<Guid> { callerUserId };

        if (request.IsDirectMessage)
        {
            if (validMemberIds.Count != 2)
            {
                throw new ApiValidationException("A direct message must have exactly two members.");
            }

            // Dedup: reuse an existing DM between the same pair rather than creating a duplicate.
            var existing = await _db.ChatChannels.AsNoTracking()
                .Include(c => c.Members).ThenInclude(m => m.User)
                .Where(c => c.OrganisationId == organisationId && c.IsDirectMessage
                    && c.Members.Count == 2
                    && c.Members.All(m => validMemberIds.Contains(m.UserId)))
                .FirstOrDefaultAsync();
            if (existing is not null) return ToChannelDto(existing, _broadcaster.GetOnlineUserIds());
        }

        var channel = new ChatChannel
        {
            Id = Guid.NewGuid(),
            OrganisationId = organisationId,
            Name = request.IsDirectMessage ? null : (request.Name ?? "").Trim(),
            IsDirectMessage = request.IsDirectMessage,
            CreatedByUserId = callerUserId,
            DateCreated = DateTime.UtcNow
        };
        if (!request.IsDirectMessage && channel.Name!.Length == 0)
        {
            throw new ApiValidationException("Channel name is required.");
        }

        _db.ChatChannels.Add(channel);
        foreach (var userId in validMemberIds)
        {
            _db.ChatChannelMembers.Add(new ChatChannelMember
            {
                Id = Guid.NewGuid(),
                ChannelId = channel.Id,
                UserId = userId,
                DateJoined = DateTime.UtcNow
            });
        }
        await _db.SaveChangesAsync();

        var reloaded = await _db.ChatChannels.AsNoTracking()
            .Include(c => c.Members).ThenInclude(m => m.User)
            .FirstAsync(c => c.Id == channel.Id);
        return ToChannelDto(reloaded, _broadcaster.GetOnlineUserIds());
    }

    public async Task<bool> AddMemberAsync(Guid organisationId, Guid callerUserId, bool callerIsOrgAdmin, Guid channelId, Guid targetUserId)
    {
        if (!await CanAccessChannelAsync(channelId, organisationId, callerUserId, callerIsOrgAdmin)) return false;

        var targetInOrg = await _db.Users.AsNoTracking().AnyAsync(u => u.Id == targetUserId && u.OrganisationId == organisationId);
        if (!targetInOrg) return false;

        var alreadyMember = await _db.ChatChannelMembers.AnyAsync(m => m.ChannelId == channelId && m.UserId == targetUserId);
        if (alreadyMember) return true;

        _db.ChatChannelMembers.Add(new ChatChannelMember
        {
            Id = Guid.NewGuid(),
            ChannelId = channelId,
            UserId = targetUserId,
            DateJoined = DateTime.UtcNow
        });
        await _db.SaveChangesAsync();
        return true;
    }

    public async Task<bool> RemoveMemberAsync(Guid organisationId, Guid callerUserId, bool callerIsOrgAdmin, Guid channelId, Guid targetUserId)
    {
        // Removing yourself never needs the membership/admin check below; removing someone else does.
        if (targetUserId != callerUserId && !await CanAccessChannelAsync(channelId, organisationId, callerUserId, callerIsOrgAdmin)) return false;

        var membership = await _db.ChatChannelMembers.FirstOrDefaultAsync(m => m.ChannelId == channelId && m.UserId == targetUserId);
        if (membership is null) return false;

        _db.ChatChannelMembers.Remove(membership);
        await _db.SaveChangesAsync();
        return true;
    }

    public async Task<List<Guid>> GetChannelMemberUserIdsAsync(Guid channelId) =>
        await _db.ChatChannelMembers.AsNoTracking().Where(m => m.ChannelId == channelId).Select(m => m.UserId).ToListAsync();

    // ---- Messages ----

    public async Task<ChatMessagePageDto?> GetMessagesAsync(Guid organisationId, Guid callerUserId, bool callerIsOrgAdmin, Guid channelId, DateTime? before, int limit)
    {
        if (!await CanAccessChannelAsync(channelId, organisationId, callerUserId, callerIsOrgAdmin)) return null;

        limit = Math.Clamp(limit, 1, 200);
        var query = _db.ChatMessages.AsNoTracking().Where(m => m.ChannelId == channelId);
        if (before is not null) query = query.Where(m => m.DateCreated < before);

        var page = await query.OrderByDescending(m => m.DateCreated).Take(limit).ToListAsync();
        page.Reverse(); // oldest-first within the page, matching how a chat thread reads top-to-bottom

        var memberNames = await GetChannelMemberDisplayNamesAsync(channelId);
        var nextCursor = page.Count == limit ? page[0].DateCreated : (DateTime?)null;
        return new ChatMessagePageDto(page.Select(m => ToMessageDto(m, memberNames)).ToList(), nextCursor);
    }

    public async Task<(ChatMessageDto Message, List<Guid> ChannelMemberUserIds)?> PostMessageAsync(
        Guid organisationId, Guid callerUserId, string callerDisplayName, Guid channelId, PostChatMessageRequest request)
    {
        var memberUserIds = await GetChannelMemberUserIdsAsync(channelId);
        if (!memberUserIds.Contains(callerUserId)) return null;

        var text = (request.Text ?? "").Trim();
        if (text.Length == 0)
        {
            throw new ApiValidationException("Message text is required.");
        }

        var message = new ChatMessage
        {
            Id = Guid.NewGuid(),
            ChannelId = channelId,
            AuthorUserId = callerUserId,
            AuthorName = callerDisplayName,
            Text = text,
            DateCreated = DateTime.UtcNow,
            IsDeleted = false
        };
        _db.ChatMessages.Add(message);
        await _db.SaveChangesAsync();

        var memberNames = await GetChannelMemberDisplayNamesAsync(channelId);
        return (ToMessageDto(message, memberNames), memberUserIds);
    }

    public async Task<(ChatMessageDto Message, List<Guid> ChannelMemberUserIds)?> UpdateMessageAsync(
        Guid callerUserId, Guid channelId, Guid messageId, UpdateChatMessageRequest request)
    {
        var message = await _db.ChatMessages.FirstOrDefaultAsync(m => m.Id == messageId && m.ChannelId == channelId && m.AuthorUserId == callerUserId && !m.IsDeleted);
        if (message is null) return null;

        var text = (request.Text ?? "").Trim();
        if (text.Length == 0)
        {
            throw new ApiValidationException("Message text is required.");
        }
        message.Text = text;
        await _db.SaveChangesAsync();

        var memberUserIds = await GetChannelMemberUserIdsAsync(channelId);
        var memberNames = await GetChannelMemberDisplayNamesAsync(channelId);
        return (ToMessageDto(message, memberNames), memberUserIds);
    }

    public async Task<(ChatMessageDto Message, List<Guid> ChannelMemberUserIds)?> DeleteMessageAsync(
        Guid organisationId, Guid callerUserId, bool callerIsOrgAdmin, Guid channelId, Guid messageId)
    {
        var message = await _db.ChatMessages.FirstOrDefaultAsync(m => m.Id == messageId && m.ChannelId == channelId);
        if (message is null || message.IsDeleted) return null;

        var isAuthor = message.AuthorUserId == callerUserId;
        var isAdmin = callerIsOrgAdmin && await _db.ChatChannels.AsNoTracking()
            .AnyAsync(c => c.Id == channelId && c.OrganisationId == organisationId);
        if (!isAuthor && !isAdmin) return null;

        message.IsDeleted = true;
        message.DateDeleted = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        var memberUserIds = await GetChannelMemberUserIdsAsync(channelId);
        var memberNames = await GetChannelMemberDisplayNamesAsync(channelId);
        return (ToMessageDto(message, memberNames), memberUserIds);
    }

    // ---- Truncate (Org-Admin-only, manual — see the "no scheduled job" decision) ----

    public async Task<ChatTruncateResultDto> TruncateOldMessagesAsync(Guid organisationId)
    {
        var cutoff = DateTime.UtcNow.AddDays(-180);
        var toDelete = await _db.ChatMessages
            .Where(m => m.Channel.OrganisationId == organisationId && m.DateCreated < cutoff)
            .ToListAsync();
        _db.ChatMessages.RemoveRange(toDelete);
        await _db.SaveChangesAsync();
        return new ChatTruncateResultDto(toDelete.Count, cutoff);
    }

    // ---- Helpers ----

    private async Task<bool> CanAccessChannelAsync(Guid channelId, Guid organisationId, Guid callerUserId, bool callerIsOrgAdmin)
    {
        var channel = await _db.ChatChannels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId && c.OrganisationId == organisationId);
        if (channel is null) return false;
        if (callerIsOrgAdmin) return true;
        return await _db.ChatChannelMembers.AsNoTracking().AnyAsync(m => m.ChannelId == channelId && m.UserId == callerUserId);
    }

    private async Task<Dictionary<Guid, string>> GetChannelMemberDisplayNamesAsync(Guid channelId) =>
        await _db.ChatChannelMembers.AsNoTracking()
            .Where(m => m.ChannelId == channelId)
            .Select(m => new { m.UserId, m.User.DisplayName })
            .ToDictionaryAsync(x => x.UserId, x => x.DisplayName);

    /// <summary>Scans message text for "@FullDisplayName" occurrences against the channel's current
    /// member roster — no separate mention-storage table, derived fresh every time (same philosophy
    /// as features/hashtags.js's tag scanning on the frontend). Longest-name-first so "@Andrew Rigney"
    /// isn't short-circuited by a member literally named "Andrew".</summary>
    private static List<Guid> ParseMentions(string text, Dictionary<Guid, string> memberDisplayNames)
    {
        var mentioned = new List<Guid>();
        foreach (var (userId, displayName) in memberDisplayNames.OrderByDescending(kv => kv.Value.Length))
        {
            if (string.IsNullOrWhiteSpace(displayName)) continue;
            if (text.Contains("@" + displayName, StringComparison.OrdinalIgnoreCase))
            {
                mentioned.Add(userId);
            }
        }
        return mentioned;
    }

    private static ChatMessageDto ToMessageDto(ChatMessage m, Dictionary<Guid, string> memberDisplayNames) =>
        new(m.Id, m.ChannelId, m.AuthorUserId, m.AuthorName, m.Text, m.DateCreated, m.IsDeleted, m.DateDeleted,
            ParseMentions(m.Text, memberDisplayNames));

    private static ChatChannelDto ToChannelDto(ChatChannel c, IReadOnlyCollection<Guid> onlineUserIds) =>
        new(c.Id, c.Name, c.IsDirectMessage, c.DateCreated,
            c.Members.Select(m => new ChatChannelMemberDto(m.UserId, m.User.DisplayName, onlineUserIds.Contains(m.UserId))).ToList());
}
