using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Enkl.Api.Data.Configurations;

public class UserConfiguration : IEntityTypeConfiguration<User>
{
    public void Configure(EntityTypeBuilder<User> b)
    {
        b.HasKey(u => u.Id);
        b.Property(u => u.Username).HasMaxLength(64).IsRequired();
        b.Property(u => u.NormalizedUsername).HasMaxLength(64).IsRequired();
        b.Property(u => u.EmailAddress).HasMaxLength(320);
        b.Property(u => u.NormalizedEmailAddress).HasMaxLength(320);
        b.Property(u => u.DisplayName).HasMaxLength(200).IsRequired();
        b.Property(u => u.PasswordHash).IsRequired();
        b.HasIndex(u => u.NormalizedUsername).IsUnique();
        // Nullable + unique: Postgres treats multiple NULLs as distinct, so users without an email
        // (local-only team members, pre-existing accounts from before this field existed) never
        // collide with each other — only two non-null emails that normalize the same way do.
        b.HasIndex(u => u.NormalizedEmailAddress).IsUnique();

        b.HasOne(u => u.Organisation)
            .WithMany(o => o.Users)
            .HasForeignKey(u => u.OrganisationId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
