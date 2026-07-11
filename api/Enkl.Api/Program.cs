using System.Security.Claims;
using System.Text;
using Enkl.Api.Auth;
using Enkl.Api.Data;
using Enkl.Api.Services;
using Enkl.Api.Validation;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

// Defense-in-depth against the checked-in dev placeholders in appsettings.json ever reaching a
// real deployment: docker-compose.yml now fails to even start the container if DB_PASSWORD/
// JWT_SIGNING_KEY aren't set, but a bare (non-Docker) Kestrel deployment reads appsettings.json
// directly, so this catches that path too. Development is exempted since the whole point of the
// checked-in placeholders is a zero-setup local `dotnet run`.
if (!builder.Environment.IsDevelopment())
{
    const string placeholderSigningKey = "dev-only-signing-key-change-me-please-32chars-min";
    var signingKey = builder.Configuration["Jwt:SigningKey"];
    if (string.IsNullOrWhiteSpace(signingKey) || signingKey == placeholderSigningKey || signingKey.Length < 32)
    {
        throw new InvalidOperationException(
            "Jwt:SigningKey is missing, is the checked-in development placeholder, or is shorter than " +
            "32 characters. Set a real, random JWT_SIGNING_KEY before starting outside Development.");
    }

    const string placeholderDbPassword = "enkl_dev_password";
    var connectionString = builder.Configuration.GetConnectionString("Default");
    if (string.IsNullOrWhiteSpace(connectionString) || connectionString.Contains($"Password={placeholderDbPassword}"))
    {
        throw new InvalidOperationException(
            "The database connection string is missing or still uses the checked-in development " +
            "password. Set a real DB_PASSWORD before starting outside Development.");
    }
}

builder.Services.AddControllers();
builder.Services.AddOpenApi();
builder.Services.AddHttpContextAccessor();

// Defense-in-depth (security review finding H4): this API is never exposed directly — nginx
// (web/nginx.conf) is the only thing that can reach it (see docker-compose.yml: the api service
// publishes no host port), so trusting forwarded headers from any caller is safe here. Nothing
// today actually depends on the recovered scheme/IP being correct (SamlService/
// OrganisationSsoConfigService deliberately use the fixed App:PublicBaseUrl config instead — see
// appsettings.json's own comment on why), but this still needs to be wired up so
// HttpContext.Connection.RemoteIpAddress is correct for logging/rate-limiting (see the
// rate-limiting middleware below, which partitions by client IP) instead of always seeing nginx's
// own container IP.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

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
builder.Services.AddScoped<RetrospectiveService>();
builder.Services.AddScoped<DocumentService>();
builder.Services.AddScoped<RiskService>();
builder.Services.AddScoped<ObjectiveService>();
builder.Services.AddScoped<TeamCommitteeService>();
builder.Services.AddScoped<DecisionService>();
builder.Services.AddScoped<MemberService>();
builder.Services.AddScoped<TemplateService>();
builder.Services.AddScoped<ToDoService>();
builder.Services.AddScoped<SamlService>();
builder.Services.AddScoped<OrganisationSsoConfigService>();
builder.Services.AddScoped<ScimUserService>();
builder.Services.AddScoped<ScimGroupService>();
builder.Services.AddSingleton<SseBroadcaster>();
builder.Services.AddSingleton<SsoExchangeCodeStore>();
builder.Services.AddSingleton<SamlRequestIdStore>();

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

// Security review (Low/Informational finding): no CORS policy existed at all anywhere in this
// codebase. Already safe by default — this API is only ever reached through nginx in the same
// origin as the frontend (docker-compose.yml publishes no host port for `api` directly), so a
// cross-origin browser request was already blocked by the browser's own same-origin policy with no
// CORS headers present. This makes that an explicit, reviewable decision instead of an omission:
// the default policy below allows no origins at all (no .WithOrigins()/.AllowAnyOrigin() call), so
// behavior is unchanged — it's the one obvious place to add a real policy if this API is ever
// consumed from a different origin.
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => { }));

// Security review finding H1: none of login/change-password/sso-exchange/sso-lookup/migration had
// any brute-force protection at all. Partitioned per client IP (see ForwardedHeadersOptions above —
// this API is only ever reached through nginx, so RemoteIpAddress is the real caller once that's
// wired up), a sliding window rejects outright (QueueLimit 0 -> immediate 429) rather than queuing,
// since queuing login attempts would just let an attacker's requests sit and retry automatically.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.OnRejected = async (context, cancellationToken) =>
    {
        context.HttpContext.Response.ContentType = "application/json";
        await context.HttpContext.Response.WriteAsJsonAsync(
            new { message = "Too many attempts. Please wait a moment and try again." },
            cancellationToken);
    };
    options.AddPolicy("auth", httpContext => RateLimitPartition.GetSlidingWindowLimiter(
        partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new SlidingWindowRateLimiterOptions
        {
            PermitLimit = 10,
            Window = TimeSpan.FromMinutes(1),
            SegmentsPerWindow = 4,
            QueueLimit = 0
        }));
});

var app = builder.Build();

// Must run before anything that reads scheme/remote IP. HSTS is skipped in Development so a plain
// `dotnet run` over http://localhost isn't told by its own response to only ever use https next time.
app.UseForwardedHeaders();
if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

// Security review finding M6: defense-in-depth in case this API is ever reached directly without
// nginx in front (which carries the fuller header set, including a CSP — see nginx.conf's own
// comment). Every response here is JSON, never HTML/JS, so no CSP is needed at this layer.
app.Use(async (context, next) =>
{
    context.Response.Headers.Append("X-Content-Type-Options", "nosniff");
    context.Response.Headers.Append("X-Frame-Options", "DENY");
    context.Response.Headers.Append("Referrer-Policy", "strict-origin-when-cross-origin");
    await next();
});

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

app.UseCors();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

// Combines two live, per-request DB-backed checks (one query) for every authenticated request:
//
// 1. Token revocation (security review finding H2): signature/issuer/audience/lifetime were
//    previously the only things ever checked, so deactivating a user (SCIM) or changing their
//    password/org-admin role kept their already-issued token(s) fully valid for up to the full
//    8-hour expiry. User.SecurityStamp is regenerated at each of those points (AuthController.
//    ChangePassword, OrganisationService.SetUserAdminAsync, ScimUserService) and minted into the
//    token as the "securityStamp" claim (JwtTokenService.GenerateToken) — a mismatch against the
//    live DB value (or a token from before this claim existed, which has none) means the token was
//    issued under a state that's since changed, so it's rejected outright.
//
// 2. MustChangePassword enforcement (security review finding C4): the flag was being set at account
//    creation (e.g. MigrationService's default "enklUserPassword" accounts) and returned in the
//    login response, but nothing previously stopped the account from being used indefinitely
//    without ever actually changing it. Only mutating requests (POST/PUT/PATCH/DELETE) are blocked
//    — reads still work so a signed-in client isn't broken while the change-password prompt is up.
//    /api/auth/change-password is the one exempted mutating route — it's the only way to ever clear
//    the flag (and, since it also rotates SecurityStamp, the one route that must keep working under
//    check 1 too using the caller's own current, about-to-be-superseded token).
var mutatingHttpMethods = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "POST", "PUT", "PATCH", "DELETE" };
app.Use(async (context, next) =>
{
    if (context.User.Identity?.IsAuthenticated == true)
    {
        var userIdClaim = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? context.User.FindFirstValue("sub");
        if (userIdClaim is not null && Guid.TryParse(userIdClaim, out var userId))
        {
            var db = context.RequestServices.GetRequiredService<AppDbContext>();
            var current = await db.Users.Where(u => u.Id == userId)
                .Select(u => new { u.IsActive, u.SecurityStamp, u.MustChangePassword })
                .FirstOrDefaultAsync();

            var tokenStampClaim = context.User.FindFirstValue("securityStamp");
            var stampMatches = current is not null && Guid.TryParse(tokenStampClaim, out var tokenStamp) && tokenStamp == current.SecurityStamp;
            if (current is null || !current.IsActive || !stampMatches)
            {
                context.Response.ContentType = "application/json";
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                await context.Response.WriteAsJsonAsync(new { message = "Session expired. Please log in again." });
                return;
            }

            var isMutating = mutatingHttpMethods.Contains(context.Request.Method);
            var isChangePasswordRoute = context.Request.Path.StartsWithSegments("/api/auth/change-password");
            if (isMutating && !isChangePasswordRoute && current.MustChangePassword)
            {
                context.Response.ContentType = "application/json";
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                await context.Response.WriteAsJsonAsync(new { code = "must_change_password", message = "You must change your password before making further changes." });
                return;
            }
        }
    }
    await next();
});

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
