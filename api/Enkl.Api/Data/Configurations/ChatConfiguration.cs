using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Enkl.Api.Data.Configurations;

public class ChatChannelConfiguration : IEntityTypeConfiguration<ChatChannel>
{
    public void Configure(EntityTypeBuilder<ChatChannel> b)
    {
        b.HasKey(c => c.Id);
        b.Property(c => c.Name).HasMaxLength(200);

        b.HasOne(c => c.Organisation)
            .WithMany()
            .HasForeignKey(c => c.OrganisationId)
            .OnDelete(DeleteBehavior.Cascade);

        // Nullable, SetNull — a channel's history (and its members' access to it) must survive its
        // creator later leaving the org, same resilience pattern as every other "who made this"
        // snapshot FK in this codebase (TaskComment.AuthorId, Document/Risk/Release.OwnerId).
        b.HasOne(c => c.CreatedBy)
            .WithMany()
            .HasForeignKey(c => c.CreatedByUserId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}

public class ChatChannelMemberConfiguration : IEntityTypeConfiguration<ChatChannelMember>
{
    public void Configure(EntityTypeBuilder<ChatChannelMember> b)
    {
        b.HasKey(m => m.Id);
        b.HasIndex(m => new { m.ChannelId, m.UserId }).IsUnique();

        b.HasOne(m => m.Channel)
            .WithMany(c => c.Members)
            .HasForeignKey(m => m.ChannelId)
            .OnDelete(DeleteBehavior.Cascade);

        // A user leaving the org removes their channel memberships outright (unlike a message's
        // AuthorId, there's no "attributable historical record" reason to keep a membership row
        // around once the User row itself is gone).
        b.HasOne(m => m.User)
            .WithMany()
            .HasForeignKey(m => m.UserId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

public class ChatMessageConfiguration : IEntityTypeConfiguration<ChatMessage>
{
    public void Configure(EntityTypeBuilder<ChatMessage> b)
    {
        b.HasKey(m => m.Id);
        b.Property(m => m.Text).IsRequired();
        b.Property(m => m.AuthorName).HasMaxLength(200).IsRequired();

        b.HasOne(m => m.Channel)
            .WithMany(c => c.Messages)
            .HasForeignKey(m => m.ChannelId)
            .OnDelete(DeleteBehavior.Cascade);

        // Nullable, SetNull — see ChatMessage's own doc comment: AuthorName's snapshot keeps the
        // message attributable regardless of whether AuthorUserId still resolves to a live User.
        b.HasOne(m => m.AuthorUser)
            .WithMany()
            .HasForeignKey(m => m.AuthorUserId)
            .OnDelete(DeleteBehavior.SetNull);

        // Truncate's 180-day cutoff query filters/orders on DateCreated for every channel at once —
        // an index keeps that a cheap range scan rather than a full-table scan as message volume grows.
        b.HasIndex(m => m.DateCreated);
    }
}
