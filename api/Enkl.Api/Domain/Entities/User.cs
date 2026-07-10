namespace Enkl.Api.Domain.Entities;

public class User
{
    public Guid Id { get; set; }
    public Guid OrganisationId { get; set; }
    public Organisation Organisation { get; set; } = null!;
    public string Username { get; set; } = "";
    public string NormalizedUsername { get; set; } = "";
    public string? EmailAddress { get; set; }
    public string? NormalizedEmailAddress { get; set; }
    public string PasswordHash { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public bool MustChangePassword { get; set; }
    public bool IsOrgAdmin { get; set; }
    public DateTime CreatedAt { get; set; }

    public List<ProjectMember> ProjectMemberships { get; set; } = new();
}
