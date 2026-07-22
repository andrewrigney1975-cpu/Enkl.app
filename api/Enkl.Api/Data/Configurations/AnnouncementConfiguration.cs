using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Enkl.Api.Data.Configurations;

public class AnnouncementConfiguration : IEntityTypeConfiguration<Announcement>
{
    public void Configure(EntityTypeBuilder<Announcement> b)
    {
        b.HasKey(a => a.Id);
        b.Property(a => a.Scope).HasMaxLength(20).IsRequired();
        b.Property(a => a.Kind).HasMaxLength(20).IsRequired();
        b.Property(a => a.Title).HasMaxLength(200).IsRequired();
        b.Property(a => a.Body).IsRequired();
        b.Property(a => a.CreatedByVendor).HasDefaultValue(false);

        // Org-scoped like PortfolioCategory/ChatChannel — FK only, no List<Announcement> back-nav on
        // Organisation (that collection-navigation pattern is reserved for the small set of entities
        // Organisation already exposes directly, not the default for every new org-scoped child).
        // Nullable since Scope="orgs"/"platform" (vendor-authored) rows have no single OrganisationId.
        b.HasOne(a => a.Organisation)
            .WithMany()
            .HasForeignKey(a => a.OrganisationId)
            .OnDelete(DeleteBehavior.Cascade);

        // Nullable, SetNull — an Org Admin who later leaves the org shouldn't take their past
        // announcements down with them, same resilience pattern as TaskComment.AuthorId.
        b.HasOne(a => a.CreatedByUser)
            .WithMany()
            .HasForeignKey(a => a.CreatedByUserId)
            .OnDelete(DeleteBehavior.SetNull);

        // The "active announcements for this user" query filters on Kind/StartAt/EndAt on every
        // request from every signed-in user — worth an index given how often it runs.
        b.HasIndex(a => new { a.StartAt, a.EndAt });
    }
}

public class AnnouncementOrganisationConfiguration : IEntityTypeConfiguration<AnnouncementOrganisation>
{
    public void Configure(EntityTypeBuilder<AnnouncementOrganisation> b)
    {
        b.HasKey(ao => ao.Id);
        b.HasIndex(ao => new { ao.AnnouncementId, ao.OrganisationId }).IsUnique();

        b.HasOne(ao => ao.Announcement)
            .WithMany(a => a.TargetOrganisations)
            .HasForeignKey(ao => ao.AnnouncementId)
            .OnDelete(DeleteBehavior.Cascade);

        b.HasOne(ao => ao.Organisation)
            .WithMany()
            .HasForeignKey(ao => ao.OrganisationId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

public class AnnouncementAcknowledgementConfiguration : IEntityTypeConfiguration<AnnouncementAcknowledgement>
{
    public void Configure(EntityTypeBuilder<AnnouncementAcknowledgement> b)
    {
        b.HasKey(a => a.Id);
        b.HasIndex(a => new { a.AnnouncementId, a.UserId }).IsUnique();

        b.HasOne(a => a.Announcement)
            .WithMany(an => an.Acknowledgements)
            .HasForeignKey(a => a.AnnouncementId)
            .OnDelete(DeleteBehavior.Cascade);

        // A user leaving the org has no reason to keep an acknowledgement row around — no
        // "attributable historical record" need here, same reasoning as ChatChannelMember.UserId.
        b.HasOne(a => a.User)
            .WithMany()
            .HasForeignKey(a => a.UserId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
