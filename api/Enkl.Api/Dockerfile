FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY Enkl.Api.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
# Installed BEFORE the app is copied in, deliberately: curl itself never changes between builds, but
# this layer sat after COPY --from=build previously, so it was invalidated (and re-hit Ubuntu's
# package mirrors over the network) on nearly every single build purely because of layer ordering,
# not because it ever needed to. Docker's own layer cache now persists this step across app-code
# rebuilds — it only reruns if this Dockerfile or the base image itself changes.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app .
EXPOSE 8080
# Security review finding M8: the base image otherwise runs as root with no USER directive at all.
# Kestrel binds to 8080 (non-privileged), so the aspnet image's built-in non-root "app" user works
# with no other changes needed.
USER app
ENTRYPOINT ["dotnet", "Enkl.Api.dll"]
