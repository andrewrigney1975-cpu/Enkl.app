namespace Enkl.Api.Dtos;

/// <summary>
/// ARCHITECTURE-REVIEW.md finding 2.2: a generic paging envelope for the targeted, paginated
/// per-resource endpoints the review recommends as an alternative to ProjectService.GetProjectDetailAsync's
/// one all-in-one 19-Include/ThenInclude fetch. Deliberately additive — GetProjectDetailAsync/
/// ProjectDetailDto are unchanged, this is a new, narrower way to fetch just one resource type
/// (starting with Tasks, the largest/most numerous collection in a project) a page at a time, for a
/// future frontend view that doesn't need the whole project graph up front. A full replacement of the
/// detail endpoint (removing it, migrating every frontend call site, porting the same change to the
/// PHP tier for contract parity) is out of scope here — see the review's own §6 sequencing note.
/// </summary>
public record PagedResultDto<T>(List<T> Items, int TotalCount, int Page, int PageSize);
