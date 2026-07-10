namespace Enkl.Api.Domain.Entities;

public class Organisation
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string NormalizedName { get; set; } = "";
    public DateTime CreatedAt { get; set; }

    public List<User> Users { get; set; } = new();
    public List<Project> Projects { get; set; } = new();
    public List<ProjectTemplate> ProjectTemplates { get; set; } = new();
}
