# Build from the repository root:
#   docker build -f services/KPolls.Api/Dockerfile -t kpolls-api .

FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS build
WORKDIR /src

COPY services/KPolls.Api/KPolls.Api.csproj services/KPolls.Api/
RUN dotnet restore services/KPolls.Api/KPolls.Api.csproj

COPY services/KPolls.Api/ services/KPolls.Api/
RUN dotnet publish services/KPolls.Api/KPolls.Api.csproj \
      -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine AS runtime
WORKDIR /app

RUN addgroup -S kpolls && adduser -S kpolls -G kpolls

COPY --from=build /app/publish .
# The API serves the static site too; it looks two levels up from the content
# root, which is why the published app sits at /app/service.
COPY public/ /public/

ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_gcServer=1

USER kpolls
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["dotnet", "KPolls.Api.dll"]
