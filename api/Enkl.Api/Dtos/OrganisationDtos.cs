namespace Enkl.Api.Dtos;

/// <summary>HasPassword is false only for an SSO/SCIM-provisioned user (see User.PasswordHash's own
/// comment) — the frontend uses it to hide the "Reset Password" action for such a user rather than
/// offering something the server will reject anyway.</summary>
public record OrgUserDto(Guid Id, string Username, string? EmailAddress, string DisplayName, bool IsOrgAdmin, bool IsActive, DateTime CreatedAt, bool IsOnline, bool HasPassword);
public record OrganisationDetailDto(Guid Id, string Name, bool HasCustomDefaultPassword, List<OrgUserDto> Users);
public record SetOrgAdminRequest(bool IsOrgAdmin);
public record CreateUserRequest(string Username, string DisplayName, string Password, string EmailAddress);
public record SetUserEmailRequest(string EmailAddress);
public record SetDefaultNewUserPasswordRequest(string Password);
/// <summary>Password is optional — omit it to reset to the org's configured default (or the global
/// fallback if none is set), same value a brand-new implicitly-created user would get. See
/// OrganisationService.ResetUserPasswordAsync's own doc comment.</summary>
public record ResetUserPasswordRequest(string? Password);
