using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

/// <summary>
/// ARCHITECTURE-REVIEW.md finding 2.1: split out of PortfolioService.cs (was 486 lines mixing
/// project-listing/aggregate, category CRUD, and resource-placeholder concerns) — the
/// PortfolioCategory CRUD seam. Same OrgAdmin-only, org-ownership-re-validated stance as every other
/// Portfolio* class (see PortfolioService's own doc comment for the cross-org isolation guarantee).
/// </summary>
public class PortfolioCategoryService
{
    private readonly AppDbContext _db;

    public PortfolioCategoryService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<List<PortfolioCategoryDto>> ListCategoriesAsync(Guid organisationId)
    {
        return await _db.PortfolioCategories
            .Where(c => c.OrganisationId == organisationId)
            .OrderBy(c => c.SortOrder)
            .Select(c => new PortfolioCategoryDto(c.Id, c.Name, c.SortOrder))
            .ToListAsync();
    }

    public async Task<PortfolioCategoryDto> CreateCategoryAsync(Guid organisationId, string name)
    {
        var trimmedName = string.IsNullOrWhiteSpace(name) ? "Untitled Category" : name.Trim();
        var maxSortOrder = await _db.PortfolioCategories.Where(c => c.OrganisationId == organisationId)
            .Select(c => (int?)c.SortOrder).MaxAsync() ?? -1;

        var category = new PortfolioCategory
        {
            Id = Guid.NewGuid(),
            OrganisationId = organisationId,
            Name = trimmedName,
            SortOrder = maxSortOrder + 1
        };
        _db.PortfolioCategories.Add(category);
        await _db.SaveChangesAsync();
        return new PortfolioCategoryDto(category.Id, category.Name, category.SortOrder);
    }

    public async Task<PortfolioCategoryDto?> UpdateCategoryAsync(Guid organisationId, Guid categoryId, string name)
    {
        var category = await _db.PortfolioCategories.FirstOrDefaultAsync(c => c.Id == categoryId && c.OrganisationId == organisationId);
        if (category is null) return null;

        category.Name = string.IsNullOrWhiteSpace(name) ? category.Name : name.Trim();
        await _db.SaveChangesAsync();
        return new PortfolioCategoryDto(category.Id, category.Name, category.SortOrder);
    }

    /// <summary>Deleting a category is a pure DB-level SetNull cascade (see ProjectConfiguration) —
    /// no application-side fan-out needed to un-categorize its projects.</summary>
    public async Task<bool> DeleteCategoryAsync(Guid organisationId, Guid categoryId)
    {
        var category = await _db.PortfolioCategories.FirstOrDefaultAsync(c => c.Id == categoryId && c.OrganisationId == organisationId);
        if (category is null) return false;

        _db.PortfolioCategories.Remove(category);
        await _db.SaveChangesAsync();
        return true;
    }

    public async Task<bool> UpdateCategorySortOrderAsync(Guid organisationId, Guid categoryId, int sortOrder)
    {
        var category = await _db.PortfolioCategories.FirstOrDefaultAsync(c => c.Id == categoryId && c.OrganisationId == organisationId);
        if (category is null) return false;

        category.SortOrder = sortOrder;
        await _db.SaveChangesAsync();
        return true;
    }
}
