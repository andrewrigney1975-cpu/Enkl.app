FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY Enkl.Api.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
EXPOSE 8080
# Security review finding M8: the base image otherwise runs as root with no USER directive at all.
# Kestrel binds to 8080 (non-privileged), so the aspnet image's built-in non-root "app" user works
# with no other changes needed.
USER app
ENTRYPOINT ["dotnet", "Enkl.Api.dll"]
