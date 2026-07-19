using Enkl.Api.Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Organisation> Organisations => Set<Organisation>();
    public DbSet<User> Users => Set<User>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ProjectTemplate> ProjectTemplates => Set<ProjectTemplate>();
    public DbSet<ToDoList> ToDoLists => Set<ToDoList>();
    public DbSet<ToDoItem> ToDoItems => Set<ToDoItem>();
    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();
    public DbSet<Column> Columns => Set<Column>();
    public DbSet<TaskItem> Tasks => Set<TaskItem>();
    public DbSet<TaskDependency> TaskDependencies => Set<TaskDependency>();
    public DbSet<TaskAuditLogEntry> TaskAuditLogEntries => Set<TaskAuditLogEntry>();
    public DbSet<TaskComment> TaskComments => Set<TaskComment>();
    public DbSet<Release> Releases => Set<Release>();
    public DbSet<TaskType> TaskTypes => Set<TaskType>();
    public DbSet<Document> Documents => Set<Document>();
    public DbSet<Principle> Principles => Set<Principle>();
    public DbSet<Risk> Risks => Set<Risk>();
    public DbSet<Objective> Objectives => Set<Objective>();
    public DbSet<TeamCommittee> TeamsCommittees => Set<TeamCommittee>();
    public DbSet<Decision> Decisions => Set<Decision>();
    public DbSet<OrganisationSsoConfig> OrganisationSsoConfigs => Set<OrganisationSsoConfig>();
    public DbSet<OrgTeam> OrgTeams => Set<OrgTeam>();
    public DbSet<Retrospective> Retrospectives => Set<Retrospective>();
    public DbSet<RetrospectiveParticipant> RetrospectiveParticipants => Set<RetrospectiveParticipant>();
    public DbSet<RetrospectiveItem> RetrospectiveItems => Set<RetrospectiveItem>();
    public DbSet<RetrospectiveActionItem> RetrospectiveActionItems => Set<RetrospectiveActionItem>();
    public DbSet<PortfolioCategory> PortfolioCategories => Set<PortfolioCategory>();
    public DbSet<PageLoadTiming> PageLoadTimings => Set<PageLoadTiming>();
    public DbSet<ProjectResourcePlaceholder> ProjectResourcePlaceholders => Set<ProjectResourcePlaceholder>();
    public DbSet<SavedQuery> SavedQueries => Set<SavedQuery>();
    public DbSet<OrganisationApiKey> OrganisationApiKeys => Set<OrganisationApiKey>();
    public DbSet<ChatChannel> ChatChannels => Set<ChatChannel>();
    public DbSet<ChatChannelMember> ChatChannelMembers => Set<ChatChannelMember>();
    public DbSet<ChatMessage> ChatMessages => Set<ChatMessage>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
    }
}
