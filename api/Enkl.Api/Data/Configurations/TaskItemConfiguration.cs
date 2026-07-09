using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Enkl.Api.Data.Configurations;

public class TaskItemConfiguration : IEntityTypeConfiguration<TaskItem>
{
    public void Configure(EntityTypeBuilder<TaskItem> b)
    {
        b.HasKey(t => t.Id);
        b.Property(t => t.Key).HasMaxLength(20).IsRequired();
        b.Property(t => t.Title).HasMaxLength(500).IsRequired();
        b.Property(t => t.Priority).HasMaxLength(20).IsRequired();

        b.HasOne(t => t.Project)
            .WithMany(p => p.Tasks)
            .HasForeignKey(t => t.ProjectId)
            .OnDelete(DeleteBehavior.Cascade);

        b.HasOne(t => t.Column)
            .WithMany()
            .HasForeignKey(t => t.ColumnId)
            .OnDelete(DeleteBehavior.Restrict);

        b.HasOne(t => t.Assignee)
            .WithMany()
            .HasForeignKey(t => t.AssigneeId)
            .OnDelete(DeleteBehavior.SetNull);

        b.HasOne(t => t.Release)
            .WithMany()
            .HasForeignKey(t => t.ReleaseId)
            .OnDelete(DeleteBehavior.SetNull);

        b.HasOne(t => t.Type)
            .WithMany()
            .HasForeignKey(t => t.TypeId)
            .OnDelete(DeleteBehavior.SetNull);

        b.HasOne(t => t.ParentTask)
            .WithMany()
            .HasForeignKey(t => t.ParentTaskId)
            .OnDelete(DeleteBehavior.Restrict);

        b.HasIndex(t => new { t.ProjectId, t.Key }).IsUnique();
    }
}

public class TaskDependencyConfiguration : IEntityTypeConfiguration<TaskDependency>
{
    public void Configure(EntityTypeBuilder<TaskDependency> b)
    {
        b.HasKey(x => new { x.TaskId, x.DependsOnTaskId });
        b.HasOne(x => x.Task).WithMany(t => t.Dependencies).HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne(x => x.DependsOnTask).WithMany().HasForeignKey(x => x.DependsOnTaskId).OnDelete(DeleteBehavior.Restrict);
    }
}

public class TaskAuditLogEntryConfiguration : IEntityTypeConfiguration<TaskAuditLogEntry>
{
    public void Configure(EntityTypeBuilder<TaskAuditLogEntry> b)
    {
        b.HasKey(e => e.Id);
        b.Property(e => e.Field).HasMaxLength(100).IsRequired();
        b.Property(e => e.ChangedBy).HasMaxLength(200);

        b.HasOne(e => e.Task)
            .WithMany(t => t.AuditLog)
            .HasForeignKey(e => e.TaskId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
