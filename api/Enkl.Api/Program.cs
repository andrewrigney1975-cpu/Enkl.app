using System.Text;
using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Services;
using Enkl.Api.Validation;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddOpenApi();
builder.Services.AddHttpContextAccessor();

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

builder.Services.AddScoped<JwtTokenService>();
builder.Services.AddScoped<ProjectService>();
builder.Services.AddScoped<ColumnService>();
builder.Services.AddScoped<TaskService>();
builder.Services.AddScoped<MigrationService>();
builder.Services.AddScoped<OrganisationService>();
builder.Services.AddScoped<ReleaseService>();
builder.Services.AddScoped<TaskTypeService>();
builder.Services.AddScoped<PrincipleService>();
builder.Services.AddScoped<DocumentService>();
builder.Services.AddScoped<RiskService>();
builder.Services.AddScoped<ObjectiveService>();
builder.Services.AddScoped<TeamCommitteeService>();
builder.Services.AddScoped<DecisionService>();
builder.Services.AddScoped<MemberService>();
builder.Services.AddSingleton<SseBroadcaster>();

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"],
            ValidateAudience = true,
            ValidAudience = builder.Configuration["Jwt:Audience"],
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(builder.Configuration["Jwt:SigningKey"]!)),
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(1)
        };
    });

builder.Services.AddAuthorizationBuilder()
    .AddPolicy("ProjectMember", policy => policy.Requirements.Add(new ProjectMemberRequirement()))
    .AddPolicy("OrgAdmin", policy => policy.RequireClaim("orgAdmin", "true"));
builder.Services.AddSingleton<IAuthorizationHandler, ProjectMemberAuthorizationHandler>();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

if (app.Configuration.GetValue<bool>("RunMigrationsOnStartup"))
{
    await MigrateDatabaseWithRetryAsync(app);
}

// Unhandled exceptions otherwise reach the client as an empty-bodied 500 in Production (no dev
// exception page, no JSON) — the frontend's toast then has nothing to show the user. This gives
// every endpoint a JSON error body without each controller needing its own try/catch.
app.UseExceptionHandler(errApp => errApp.Run(async context =>
{
    var feature = context.Features.Get<Microsoft.AspNetCore.Diagnostics.IExceptionHandlerFeature>();
    var error = feature?.Error;

    // ApiValidationException carries a caller-facing message (cycle checks, etc. — see
    // Validation/ApiValidationException.cs) and is intentionally not logged as an error: it's
    // expected input rejection, not a bug. Every other exception is logged and hidden from the
    // response body.
    if (error is ApiValidationException validationEx)
    {
        context.Response.ContentType = "application/json";
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsJsonAsync(new { message = validationEx.Message });
        return;
    }

    var logger = context.RequestServices.GetRequiredService<ILogger<Program>>();
    logger.LogError(error, "Unhandled exception");

    context.Response.ContentType = "application/json";
    context.Response.StatusCode = error is DbUpdateException ? StatusCodes.Status409Conflict : StatusCodes.Status500InternalServerError;
    await context.Response.WriteAsJsonAsync(new { message = "An unexpected error occurred. Please try again." });
}));

app.MapGet("/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();

app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();

static async Task MigrateDatabaseWithRetryAsync(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();

    const int maxAttempts = 10;
    for (var attempt = 1; attempt <= maxAttempts; attempt++)
    {
        try
        {
            await db.Database.MigrateAsync();
            return;
        }
        catch (Exception ex) when (attempt < maxAttempts)
        {
            logger.LogWarning(ex, "Database not ready yet (attempt {Attempt}/{MaxAttempts}), retrying...", attempt, maxAttempts);
            await Task.Delay(TimeSpan.FromSeconds(3));
        }
    }
}
