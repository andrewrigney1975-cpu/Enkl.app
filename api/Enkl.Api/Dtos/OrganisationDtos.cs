namespace Enkl.Api.Dtos;

public record OrgUserDto(Guid Id, string Username, string? EmailAddress, string DisplayName, bool IsOrgAdmin, DateTime CreatedAt);
public record OrganisationDetailDto(Guid Id, string Name, List<OrgUserDto> Users);
public record SetOrgAdminRequest(bool IsOrgAdmin);
public record CreateUserRequest(string Username, string DisplayName, string Password, string EmailAddress);
public record SetUserEmailRequest(string EmailAddress);
