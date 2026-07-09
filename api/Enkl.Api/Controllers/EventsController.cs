using System.Security.Claims;
using Enkl.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;

namespace Enkl.Api.Controllers;

/// <summary>
/// One long-lived Server-Sent Events stream per browser tab, covering every project the caller is a
/// member of (see SseBroadcaster). Authenticated the same way as every other endpoint (bearer JWT) —
/// deliberately NOT the native EventSource API client-side, since EventSource can't send an
/// Authorization header; src/js/features/live-updates.js drives this via fetch + ReadableStream
/// instead. See web/nginx.conf for the buffering/timeout settings this needs to actually stream
/// through the reverse proxy rather than getting held until the connection closes.
/// </summary>
[ApiController]
[Authorize]
[Route("api/events")]
public class EventsController : ControllerBase
{
    private readonly SseBroadcaster _broadcaster;

    public EventsController(SseBroadcaster broadcaster)
    {
        _broadcaster = broadcaster;
    }

    [HttpGet("stream")]
    public async Task Stream(CancellationToken ct)
    {
        var userId = Guid.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier) ?? User.FindFirstValue("sub")!);
        var clientSessionId = Request.Headers["X-Client-Session-Id"].FirstOrDefault();

        HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
        Response.ContentType = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";
        await Response.Body.FlushAsync(ct);

        using var connection = _broadcaster.Register(userId, clientSessionId);

        // Runs alongside the read loop below, writing a comment frame (ignored by EventSource-style
        // parsers, including live-updates.js's own) into the same channel every 20s — keeps the
        // connection from looking idle to nginx/any intermediary and lets a dead TCP connection surface
        // via a failed write instead of hanging around as a phantom "still open" registration forever.
        var heartbeatLoop = Task.Run(async () =>
        {
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(TimeSpan.FromSeconds(20), ct);
                    connection.Channel.Writer.TryWrite(": ping\n\n");
                }
            }
            catch (OperationCanceledException)
            {
                // request ended — nothing left to do.
            }
        }, ct);

        try
        {
            await foreach (var frame in connection.Channel.Reader.ReadAllAsync(ct))
            {
                await Response.WriteAsync(frame, ct);
                await Response.Body.FlushAsync(ct);
            }
        }
        catch (OperationCanceledException)
        {
            // client disconnected — normal termination, not an error.
        }

        await heartbeatLoop;
    }
}
