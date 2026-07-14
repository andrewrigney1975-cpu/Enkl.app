namespace Enkl.Api.Domain.Entities;

public class Column
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public string Name { get; set; } = "";
    public bool Done { get; set; }
    public string? Color { get; set; }
    public int Order { get; set; }

    /// <summary>WIP limit: -1 (default) means uncapped, any positive integer caps how many active
    /// tasks may sit in this column at once — see workflow-engine.js's evaluateColumnCap.</summary>
    public int Cap { get; set; } = -1;
}
