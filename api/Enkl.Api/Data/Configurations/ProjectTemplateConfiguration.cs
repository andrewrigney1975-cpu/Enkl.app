using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Enkl.Api.Data.Configurations;

public class ProjectTemplateConfiguration : IEntityTypeConfiguration<ProjectTemplate>
{
    public void Configure(EntityTypeBuilder<ProjectTemplate> b)
    {
        b.HasKey(t => t.Id);
        b.Property(t => t.Name).HasMaxLength(200).IsRequired();
        b.Property(t => t.ColumnsJson).HasColumnType("jsonb");
        b.Property(t => t.TaskTypesJson).HasColumnType("jsonb");
        b.Property(t => t.WorkflowJson).HasColumnType("jsonb");
        b.Property(t => t.SettingsJson).HasColumnType("jsonb");
        b.HasIndex(t => t.OrganisationId);

        b.HasOne(t => t.Organisation)
            .WithMany(o => o.ProjectTemplates)
            .HasForeignKey(t => t.OrganisationId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
