using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Enkl.Api.Data.Configurations;

public class PrincipleConfiguration : IEntityTypeConfiguration<Principle>
{
    public void Configure(EntityTypeBuilder<Principle> b)
    {
        b.HasKey(p => p.Id);
        b.Property(p => p.Key).HasMaxLength(20).IsRequired();
        b.Property(p => p.Title).HasMaxLength(500).IsRequired();

        b.HasOne(p => p.Project)
            .WithMany(pr => pr.Principles)
            .HasForeignKey(p => p.ProjectId)
            .OnDelete(DeleteBehavior.Cascade);

        b.HasIndex(p => new { p.ProjectId, p.Key }).IsUnique();
        // Backs the "Organisation Library" and suggestions queries (WHERE OrganisationId = x AND
        // IsOrganisationWide = true).
        b.HasIndex(p => new { p.OrganisationId, p.IsOrganisationWide });
    }
}
