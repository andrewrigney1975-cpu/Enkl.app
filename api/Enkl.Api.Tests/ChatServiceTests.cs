using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Services;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Enkl.Api.Tests;

/// <summary>
/// Org-scoped chat. Create/post: any org user. Update: author-only. Delete: author OR Org Admin
/// (soft delete, text preserved). List: member sees own channels; Org Admin additionally sees every
/// other org channel in a separate bucket. Truncate: hard-deletes messages older than 180 days,
/// regardless of org — scoped by OrganisationId via the channel. Mirrors the PHP tier's
/// ChatServiceTest.php exactly.
/// </summary>
[Collection("Postgres API collection")]
public class ChatServiceTests
{
    private readonly PostgresApiFixture _fixture;

    public ChatServiceTests(PostgresApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task CreateChannelAsync_GroupChannel_AddsCreatorAndRequestedMembers()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, creator) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("creator"));
        var colleague = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, TestDataHelper.Unique("colleague"));

        var result = await chat.CreateChannelAsync(org.Id, creator.Id, creator.DisplayName,
            new CreateChatChannelRequest("General", false, new List<Guid> { colleague.Id }));

        Assert.Equal("General", result.Name);
        Assert.False(result.IsDirectMessage);
        Assert.Equal(2, result.Members.Count);
        Assert.Contains(result.Members, m => m.UserId == creator.Id);
        Assert.Contains(result.Members, m => m.UserId == colleague.Id);
    }

    [Fact]
    public async Task CreateChannelAsync_DirectMessage_ThrowsUnlessExactlyTwoMembers()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, creator) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("creator"));

        // No other members requested -> only the creator -> 1 total, not 2.
        await Assert.ThrowsAsync<ApiValidationException>(() =>
            chat.CreateChannelAsync(org.Id, creator.Id, creator.DisplayName, new CreateChatChannelRequest(null, true, new List<Guid>())));
    }

    [Fact]
    public async Task CreateChannelAsync_DirectMessage_DedupesExistingDmBetweenSamePair()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, userA) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("a"));
        var userB = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, TestDataHelper.Unique("b"));

        var first = await chat.CreateChannelAsync(org.Id, userA.Id, userA.DisplayName,
            new CreateChatChannelRequest(null, true, new List<Guid> { userB.Id }));
        var second = await chat.CreateChannelAsync(org.Id, userB.Id, userB.DisplayName,
            new CreateChatChannelRequest(null, true, new List<Guid> { userA.Id }));

        Assert.Equal(first.Id, second.Id);
        Assert.Equal(1, await db.ChatChannels.CountAsync(c => c.Id == first.Id));
    }

    [Fact]
    public async Task ListChannelsAsync_NonMemberDoesNotSeeChannelUnlessOrgAdmin()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, creator) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("creator"));
        var outsider = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, TestDataHelper.Unique("outsider"), isOrgAdmin: false);
        await chat.CreateChannelAsync(org.Id, creator.Id, creator.DisplayName, new CreateChatChannelRequest("Private", false, new List<Guid>()));

        var outsiderView = await chat.ListChannelsAsync(org.Id, outsider.Id, callerIsOrgAdmin: false);
        Assert.Empty(outsiderView.Channels);
        Assert.Empty(outsiderView.AdminVisibleChannels);
    }

    [Fact]
    public async Task ListChannelsAsync_OrgAdminSeesNonMemberChannelsInAdminBucketOnly()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, creator) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("creator"));
        var admin = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, TestDataHelper.Unique("admin"), isOrgAdmin: true);
        var created = await chat.CreateChannelAsync(org.Id, creator.Id, creator.DisplayName, new CreateChatChannelRequest("Private", false, new List<Guid>()));

        var adminView = await chat.ListChannelsAsync(org.Id, admin.Id, callerIsOrgAdmin: true);

        Assert.Empty(adminView.Channels);
        Assert.Single(adminView.AdminVisibleChannels);
        Assert.Equal(created.Id, adminView.AdminVisibleChannels[0].Id);
    }

    [Fact]
    public async Task ListChannelsAsync_OrgAdminFromDifferentOrgSeesNothing()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, creator) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("creator"));
        var (otherOrg, foreignAdmin) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org2"), TestDataHelper.Unique("foreignadmin"), isOrgAdmin: true);
        await chat.CreateChannelAsync(org.Id, creator.Id, creator.DisplayName, new CreateChatChannelRequest("Private", false, new List<Guid>()));

        // Foreign admin queries scoped to THEIR OWN org, which has no channels — cross-org isolation.
        var foreignView = await chat.ListChannelsAsync(otherOrg.Id, foreignAdmin.Id, callerIsOrgAdmin: true);

        Assert.Empty(foreignView.Channels);
        Assert.Empty(foreignView.AdminVisibleChannels);
    }

    [Fact]
    public async Task PostMessageAsync_NonMemberCannotPost()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, creator) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("creator"));
        var outsider = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, TestDataHelper.Unique("outsider"), isOrgAdmin: false);
        var channel = await chat.CreateChannelAsync(org.Id, creator.Id, creator.DisplayName, new CreateChatChannelRequest("General", false, new List<Guid>()));

        var result = await chat.PostMessageAsync(org.Id, outsider.Id, outsider.DisplayName, channel.Id, new PostChatMessageRequest("Hi"));

        Assert.Null(result);
    }

    [Fact]
    public async Task PostMessageAsync_ParsesMentionsAgainstChannelMembers()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, creator) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("creator"));
        // Unique-suffixed but still space-containing, matching TestDataHelper's shared-Postgres-
        // instance convention (a fixed literal display name collides across runs) while still
        // exercising the "@Full Name" multi-word matching path.
        var mentionedName = "Andrew Rigney " + TestDataHelper.Unique("u");
        var mentioned = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, mentionedName);
        var channel = await chat.CreateChannelAsync(org.Id, creator.Id, creator.DisplayName,
            new CreateChatChannelRequest("General", false, new List<Guid> { mentioned.Id }));

        var result = await chat.PostMessageAsync(org.Id, creator.Id, creator.DisplayName, channel.Id,
            new PostChatMessageRequest($"Hey @{mentionedName}, can you take a look?"));

        Assert.NotNull(result);
        Assert.Contains(mentioned.Id, result!.Value.Message.MentionedUserIds);
    }

    [Fact]
    public async Task UpdateMessageAsync_NonAuthorCannotEdit()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var other = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, TestDataHelper.Unique("other"));
        var channel = await chat.CreateChannelAsync(org.Id, author.Id, author.DisplayName,
            new CreateChatChannelRequest("General", false, new List<Guid> { other.Id }));
        var posted = await chat.PostMessageAsync(org.Id, author.Id, author.DisplayName, channel.Id, new PostChatMessageRequest("Original"));

        var updated = await chat.UpdateMessageAsync(other.Id, channel.Id, posted!.Value.Message.Id, new UpdateChatMessageRequest("Hijacked"));

        Assert.Null(updated);
        var row = await db.ChatMessages.FindAsync(posted.Value.Message.Id);
        Assert.Equal("Original", row!.Text);
    }

    [Fact]
    public async Task DeleteMessageAsync_SoftDeletesAndPreservesText()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var channel = await chat.CreateChannelAsync(org.Id, author.Id, author.DisplayName, new CreateChatChannelRequest("General", false, new List<Guid>()));
        var posted = await chat.PostMessageAsync(org.Id, author.Id, author.DisplayName, channel.Id, new PostChatMessageRequest("Sensitive info"));

        var deleted = await chat.DeleteMessageAsync(org.Id, author.Id, callerIsOrgAdmin: false, channel.Id, posted!.Value.Message.Id);

        Assert.NotNull(deleted);
        var row = await db.ChatMessages.FindAsync(posted.Value.Message.Id);
        Assert.NotNull(row); // still in the DB — soft delete only
        Assert.True(row!.IsDeleted);
        Assert.Equal("Sensitive info", row.Text); // text preserved, never cleared
    }

    [Fact]
    public async Task DeleteMessageAsync_NonAuthorNonAdminCannotDelete()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var other = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, TestDataHelper.Unique("other"), isOrgAdmin: false);
        var channel = await chat.CreateChannelAsync(org.Id, author.Id, author.DisplayName,
            new CreateChatChannelRequest("General", false, new List<Guid> { other.Id }));
        var posted = await chat.PostMessageAsync(org.Id, author.Id, author.DisplayName, channel.Id, new PostChatMessageRequest("Mine"));

        var deleted = await chat.DeleteMessageAsync(org.Id, other.Id, callerIsOrgAdmin: false, channel.Id, posted!.Value.Message.Id);

        Assert.Null(deleted);
        Assert.False((await db.ChatMessages.FindAsync(posted.Value.Message.Id))!.IsDeleted);
    }

    [Fact]
    public async Task DeleteMessageAsync_OrgAdminCanDeleteAnyMessageInTheirOrg()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var admin = await TestDataHelper.SeedUserInOrgAsync(db, org.Id, TestDataHelper.Unique("admin"), isOrgAdmin: true);
        var channel = await chat.CreateChannelAsync(org.Id, author.Id, author.DisplayName, new CreateChatChannelRequest("General", false, new List<Guid>()));
        var posted = await chat.PostMessageAsync(org.Id, author.Id, author.DisplayName, channel.Id, new PostChatMessageRequest("Needs moderation"));

        // Admin has no membership row on this channel at all — proves the admin override, not a
        // membership match.
        var deleted = await chat.DeleteMessageAsync(org.Id, admin.Id, callerIsOrgAdmin: true, channel.Id, posted!.Value.Message.Id);

        Assert.NotNull(deleted);
    }

    [Fact]
    public async Task TruncateOldMessagesAsync_HardDeletesOnlyMessagesOlderThan180Days()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var channel = await chat.CreateChannelAsync(org.Id, author.Id, author.DisplayName, new CreateChatChannelRequest("General", false, new List<Guid>()));

        var recent = new ChatMessage { Id = Guid.NewGuid(), ChannelId = channel.Id, AuthorUserId = author.Id, AuthorName = author.DisplayName, Text = "Recent", DateCreated = DateTime.UtcNow.AddDays(-179) };
        var old = new ChatMessage { Id = Guid.NewGuid(), ChannelId = channel.Id, AuthorUserId = author.Id, AuthorName = author.DisplayName, Text = "Old", DateCreated = DateTime.UtcNow.AddDays(-181) };
        db.ChatMessages.AddRange(recent, old);
        await db.SaveChangesAsync();

        var result = await chat.TruncateOldMessagesAsync(org.Id);

        Assert.Equal(1, result.DeletedCount);
        Assert.NotNull(await db.ChatMessages.FindAsync(recent.Id));
        Assert.Null(await db.ChatMessages.FindAsync(old.Id));
    }

    [Fact]
    public async Task TruncateOldMessagesAsync_DoesNotTouchOtherOrganisationsMessages()
    {
        using var scope = _fixture.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var chat = scope.ServiceProvider.GetRequiredService<ChatService>();

        var (org, author) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org"), TestDataHelper.Unique("author"));
        var (otherOrg, otherAuthor) = await TestDataHelper.SeedOrgAndUserAsync(db, TestDataHelper.Unique("org2"), TestDataHelper.Unique("author2"));
        var channel = await chat.CreateChannelAsync(org.Id, author.Id, author.DisplayName, new CreateChatChannelRequest("General", false, new List<Guid>()));
        var otherChannel = await chat.CreateChannelAsync(otherOrg.Id, otherAuthor.Id, otherAuthor.DisplayName, new CreateChatChannelRequest("General", false, new List<Guid>()));

        var oldInThisOrg = new ChatMessage { Id = Guid.NewGuid(), ChannelId = channel.Id, AuthorUserId = author.Id, AuthorName = author.DisplayName, Text = "Old", DateCreated = DateTime.UtcNow.AddDays(-200) };
        var oldInOtherOrg = new ChatMessage { Id = Guid.NewGuid(), ChannelId = otherChannel.Id, AuthorUserId = otherAuthor.Id, AuthorName = otherAuthor.DisplayName, Text = "Old too", DateCreated = DateTime.UtcNow.AddDays(-200) };
        db.ChatMessages.AddRange(oldInThisOrg, oldInOtherOrg);
        await db.SaveChangesAsync();

        var result = await chat.TruncateOldMessagesAsync(org.Id);

        Assert.Equal(1, result.DeletedCount);
        Assert.Null(await db.ChatMessages.FindAsync(oldInThisOrg.Id));
        Assert.NotNull(await db.ChatMessages.FindAsync(oldInOtherOrg.Id)); // untouched — different org
    }
}
