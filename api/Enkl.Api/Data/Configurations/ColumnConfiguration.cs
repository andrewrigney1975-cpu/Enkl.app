using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Enkl.Api.Data.Configurations;

public class ColumnConfiguration : IEntityTypeConfiguration<Column>
{
    public void Configure(EntityTypeBuilder<Column> b)
    {
        b.HasKey(c => c.Id);
        b.Property(c => c.Name).HasMaxLength(100).IsRequired();
        b.Property(c => c.Color).HasMaxLength(20);
        // DB-level default (not just the C# property initializer) so the migration correctly
        // backfills every existing column to "uncapped" — see CLAUDE.md's EF-Core-ignores-property-
        // initializers gotcha.
        b.Property(c => c.Cap).HasDefaultValue(-1);

        b.HasOne(c => c.Project)
            .WithMany(p => p.Columns)
            .HasForeignKey(c => c.ProjectId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
