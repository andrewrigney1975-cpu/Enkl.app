namespace Enkl.Api.Domain.Entities;

/// <summary>A saved Advanced Query SQL snippet (features/query-engine.js on the frontend), shared
/// across every member of the project — same "flat, project-scoped entity" shape as TaskType, not
/// Risk (no owner/task FK, no junction tables, no display-key/counter scheme; Name is the human
/// identifier).</summary>
public class SavedQuery
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public string Name { get; set; } = "";
    public string Sql { get; set; } = "";
    public DateTime DateCreated { get; set; }
    // Off by default — once true, PublicQueryController serves this query's results to any caller
    // presenting a valid API key for this project's Organisation. See OrganisationApiKey.
    public bool ExposeViaApi { get; set; }
}
