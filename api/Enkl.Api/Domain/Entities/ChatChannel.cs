namespace Enkl.Api.Domain.Entities;

/// <summary>
/// An organisation-scoped chat channel (group) or direct message — organisation-scoped rather than
/// project-scoped since colleagues chat across the whole org, not within one project's membership,
/// same "org concept, not a project one" reasoning as PortfolioCategory. A DM is just a channel with
/// IsDirectMessage = true and exactly two ChatChannelMembers — no separate entity, so the messages
/// schema/authorization logic isn't duplicated between "channels" and "DMs". Name is unused (null)
/// for a DM; the frontend derives its display label from the other member's display name instead.
/// </summary>
public class ChatChannel
{
    public Guid Id { get; set; }
    public Guid OrganisationId { get; set; }
    public Organisation Organisation { get; set; } = null!;
    public string? Name { get; set; }
    public bool IsDirectMessage { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public User? CreatedBy { get; set; }
    public DateTime DateCreated { get; set; }

    public List<ChatChannelMember> Members { get; set; } = new();
    public List<ChatMessage> Messages { get; set; } = new();
}
