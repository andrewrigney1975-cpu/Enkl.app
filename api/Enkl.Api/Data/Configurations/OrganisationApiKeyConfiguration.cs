using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Enkl.Api.Data.Configurations;

public class OrganisationApiKeyConfiguration : IEntityTypeConfiguration<OrganisationApiKey>
{
    public void Configure(EntityTypeBuilder<OrganisationApiKey> b)
    {
        // OrganisationId doubles as the PK, enforcing the 1:1 at the schema level, same shape as
        // OrganisationSsoConfig.
        b.HasKey(k => k.OrganisationId);

        b.Property(k => k.KeyHash).HasColumnType("text");
        b.Property(k => k.Enabled).HasDefaultValue(false);

        b.HasOne(k => k.Organisation)
            .WithOne(o => o.ApiKey)
            .HasForeignKey<OrganisationApiKey>(k => k.OrganisationId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
