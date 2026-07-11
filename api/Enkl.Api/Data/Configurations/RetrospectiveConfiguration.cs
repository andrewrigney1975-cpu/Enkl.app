using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Enkl.Api.Data.Configurations;

public class RetrospectiveConfiguration : IEntityTypeConfiguration<Retrospective>
{
    public void Configure(EntityTypeBuilder<Retrospective> b)
    {
        b.HasKey(r => r.Id);
        b.Property(r => r.Key).HasMaxLength(20).IsRequired();
        b.Property(r => r.Team).HasMaxLength(200);

        b.HasOne(r => r.Project)
            .WithMany(p => p.Retrospectives)
            .HasForeignKey(r => r.ProjectId)
            .OnDelete(DeleteBehavior.Cascade);

        b.HasOne(r => r.Release)
            .WithMany()
            .HasForeignKey(r => r.ReleaseId)
            .OnDelete(DeleteBehavior.SetNull);

        b.HasIndex(r => new { r.ProjectId, r.Key }).IsUnique();
    }
}

public class RetrospectiveParticipantConfiguration : IEntityTypeConfiguration<RetrospectiveParticipant>
{
    public void Configure(EntityTypeBuilder<RetrospectiveParticipant> b)
    {
        b.HasKey(x => new { x.RetrospectiveId, x.ProjectMemberId });
        b.HasOne(x => x.Retrospective).WithMany(r => r.Participants).HasForeignKey(x => x.RetrospectiveId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne(x => x.ProjectMember).WithMany().HasForeignKey(x => x.ProjectMemberId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class RetrospectiveItemConfiguration : IEntityTypeConfiguration<RetrospectiveItem>
{
    public void Configure(EntityTypeBuilder<RetrospectiveItem> b)
    {
        b.HasKey(i => i.Id);
        b.Property(i => i.Column).HasMaxLength(20).IsRequired();
        b.Property(i => i.Text).HasMaxLength(2000).IsRequired();

        b.HasOne(i => i.Retrospective)
            .WithMany(r => r.Items)
            .HasForeignKey(i => i.RetrospectiveId)
            .OnDelete(DeleteBehavior.Cascade);

        b.HasOne(i => i.PromotedPrinciple)
            .WithMany()
            .HasForeignKey(i => i.PromotedPrincipleId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}

public class RetrospectiveActionItemConfiguration : IEntityTypeConfiguration<RetrospectiveActionItem>
{
    public void Configure(EntityTypeBuilder<RetrospectiveActionItem> b)
    {
        b.HasKey(i => i.Id);
        b.Property(i => i.Text).HasMaxLength(2000).IsRequired();

        b.HasOne(i => i.Retrospective)
            .WithMany(r => r.ActionItems)
            .HasForeignKey(i => i.RetrospectiveId)
            .OnDelete(DeleteBehavior.Cascade);

        b.HasOne(i => i.Assignee)
            .WithMany()
            .HasForeignKey(i => i.AssigneeId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}
