using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Enkl.Api.Data.Configurations;

public class SavedQueryConfiguration : IEntityTypeConfiguration<SavedQuery>
{
    public void Configure(EntityTypeBuilder<SavedQuery> b)
    {
        b.HasKey(q => q.Id);
        b.Property(q => q.Name).HasMaxLength(200).IsRequired();
        b.Property(q => q.Sql).IsRequired();
        b.Property(q => q.ExposeViaApi).HasDefaultValue(false);

        b.HasOne(q => q.Project)
            .WithMany(p => p.SavedQueries)
            .HasForeignKey(q => q.ProjectId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
