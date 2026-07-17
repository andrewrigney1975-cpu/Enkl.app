using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Enkl.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddSavedQueryApiExposure : Migration
    {
        // Dedicated, SELECT-only Postgres role the PublicQueryController executes a saved query's
        // SQL text as — never the app's own high-privilege "enkl" user. It can see nothing except
        // the ten query_* views below, each hard-filtered to one project via a session variable, so
        // "is this SQL safe to run" is enforced by Postgres' own grants, not by parsing the text.
        // Both this migration and php-api's 023_add_saved_query_api_exposure.sql create/grant the
        // identical objects (idempotently — CREATE ROLE/VIEW are guarded, GRANT is naturally
        // idempotent) since both tiers point at the same Postgres and either one may run first in a
        // given environment. The dev password here MUST match the literal in the PHP migration and
        // appsettings.json's ConnectionStrings:PublicQuery — same "duplicated-by-necessity constant,
        // no cross-language enforcement" situation as MemberPalette (CLAUDE.md §12); a real
        // deployment overrides it via ConnectionStrings__PublicQuery same as the main DB password.
        private const string PublicQueryRolePassword = "enkl_public_query_dev_password";

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "ExposeViaApi",
                table: "SavedQueries",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "OrganisationApiKeys",
                columns: table => new
                {
                    OrganisationId = table.Column<Guid>(type: "uuid", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    KeyHash = table.Column<string>(type: "text", nullable: true),
                    GeneratedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastUsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OrganisationApiKeys", x => x.OrganisationId);
                    table.ForeignKey(
                        name: "FK_OrganisationApiKeys_Organisations_OrganisationId",
                        column: x => x.OrganisationId,
                        principalTable: "Organisations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.Sql($@"
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'enkl_public_query') THEN
                        CREATE ROLE enkl_public_query LOGIN PASSWORD '{PublicQueryRolePassword}'
                            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
                    END IF;
                END
                $$;

                CREATE OR REPLACE VIEW query_tasks AS
                    SELECT * FROM ""Tasks"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;
                CREATE OR REPLACE VIEW query_columns AS
                    SELECT * FROM ""Columns"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;
                CREATE OR REPLACE VIEW query_members AS
                    SELECT * FROM ""ProjectMembers"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;
                CREATE OR REPLACE VIEW query_risks AS
                    SELECT * FROM ""Risks"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;
                CREATE OR REPLACE VIEW query_decisions AS
                    SELECT * FROM ""Decisions"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;
                CREATE OR REPLACE VIEW query_principles AS
                    SELECT * FROM ""Principles"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;
                CREATE OR REPLACE VIEW query_objectives AS
                    SELECT * FROM ""Objectives"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;
                CREATE OR REPLACE VIEW query_documents AS
                    SELECT * FROM ""Documents"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;
                CREATE OR REPLACE VIEW query_releases AS
                    SELECT * FROM ""Releases"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;
                CREATE OR REPLACE VIEW query_task_types AS
                    SELECT * FROM ""TaskTypes"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;
                CREATE OR REPLACE VIEW query_teams_committees AS
                    SELECT * FROM ""TeamsCommittees"" WHERE ""ProjectId"" = current_setting('app.query_project_id', true)::uuid;

                GRANT SELECT ON
                    query_tasks, query_columns, query_members, query_risks, query_decisions,
                    query_principles, query_objectives, query_documents, query_releases,
                    query_task_types, query_teams_committees
                TO enkl_public_query;
                GRANT USAGE ON SCHEMA public TO enkl_public_query;
            ");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Views/role deliberately NOT dropped here — php-api's own migration may have created
            // them and still depends on them; either tier's Down() dropping shared Postgres objects
            // out from under the other tier is worse than leaving unused views behind on a rollback.
            migrationBuilder.DropTable(
                name: "OrganisationApiKeys");

            migrationBuilder.DropColumn(
                name: "ExposeViaApi",
                table: "SavedQueries");
        }
    }
}
