using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Enkl.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddRetrospectivesAndPrincipleSharing : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "IsOrganisationWide",
                table: "Principles",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<Guid>(
                name: "OrganisationId",
                table: "Principles",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"));

            // Backfill: every existing Principle row is denormalized from its owning Project's
            // OrganisationId (see Principle.OrganisationId doc comment) — the zero-guid default
            // above only exists to satisfy the NOT NULL constraint during the column add itself.
            migrationBuilder.Sql(
                "UPDATE \"Principles\" p SET \"OrganisationId\" = pr.\"OrganisationId\" " +
                "FROM \"Projects\" pr WHERE pr.\"Id\" = p.\"ProjectId\";");

            migrationBuilder.CreateTable(
                name: "Retrospectives",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    ReleaseId = table.Column<Guid>(type: "uuid", nullable: true),
                    Key = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Team = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Background = table.Column<string>(type: "text", nullable: true),
                    RetroDate = table.Column<DateOnly>(type: "date", nullable: true),
                    LastTimerDurationSeconds = table.Column<int>(type: "integer", nullable: true),
                    DateCreated = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    DateLastModified = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Retrospectives", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Retrospectives_Projects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "Projects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_Retrospectives_Releases_ReleaseId",
                        column: x => x.ReleaseId,
                        principalTable: "Releases",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "RetrospectiveActionItems",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RetrospectiveId = table.Column<Guid>(type: "uuid", nullable: false),
                    Text = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    AssigneeId = table.Column<Guid>(type: "uuid", nullable: true),
                    Completed = table.Column<bool>(type: "boolean", nullable: false),
                    SortOrder = table.Column<int>(type: "integer", nullable: false),
                    DateCreated = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    DateLastModified = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RetrospectiveActionItems", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RetrospectiveActionItems_ProjectMembers_AssigneeId",
                        column: x => x.AssigneeId,
                        principalTable: "ProjectMembers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_RetrospectiveActionItems_Retrospectives_RetrospectiveId",
                        column: x => x.RetrospectiveId,
                        principalTable: "Retrospectives",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "RetrospectiveItems",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RetrospectiveId = table.Column<Guid>(type: "uuid", nullable: false),
                    Column = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Text = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    SortOrder = table.Column<int>(type: "integer", nullable: false),
                    PromotedPrincipleId = table.Column<Guid>(type: "uuid", nullable: true),
                    DateCreated = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    DateLastModified = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RetrospectiveItems", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RetrospectiveItems_Principles_PromotedPrincipleId",
                        column: x => x.PromotedPrincipleId,
                        principalTable: "Principles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_RetrospectiveItems_Retrospectives_RetrospectiveId",
                        column: x => x.RetrospectiveId,
                        principalTable: "Retrospectives",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "RetrospectiveParticipants",
                columns: table => new
                {
                    RetrospectiveId = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectMemberId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RetrospectiveParticipants", x => new { x.RetrospectiveId, x.ProjectMemberId });
                    table.ForeignKey(
                        name: "FK_RetrospectiveParticipants_ProjectMembers_ProjectMemberId",
                        column: x => x.ProjectMemberId,
                        principalTable: "ProjectMembers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_RetrospectiveParticipants_Retrospectives_RetrospectiveId",
                        column: x => x.RetrospectiveId,
                        principalTable: "Retrospectives",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Principles_OrganisationId_IsOrganisationWide",
                table: "Principles",
                columns: new[] { "OrganisationId", "IsOrganisationWide" });

            migrationBuilder.CreateIndex(
                name: "IX_RetrospectiveActionItems_AssigneeId",
                table: "RetrospectiveActionItems",
                column: "AssigneeId");

            migrationBuilder.CreateIndex(
                name: "IX_RetrospectiveActionItems_RetrospectiveId",
                table: "RetrospectiveActionItems",
                column: "RetrospectiveId");

            migrationBuilder.CreateIndex(
                name: "IX_RetrospectiveItems_PromotedPrincipleId",
                table: "RetrospectiveItems",
                column: "PromotedPrincipleId");

            migrationBuilder.CreateIndex(
                name: "IX_RetrospectiveItems_RetrospectiveId",
                table: "RetrospectiveItems",
                column: "RetrospectiveId");

            migrationBuilder.CreateIndex(
                name: "IX_RetrospectiveParticipants_ProjectMemberId",
                table: "RetrospectiveParticipants",
                column: "ProjectMemberId");

            migrationBuilder.CreateIndex(
                name: "IX_Retrospectives_ProjectId_Key",
                table: "Retrospectives",
                columns: new[] { "ProjectId", "Key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Retrospectives_ReleaseId",
                table: "Retrospectives",
                column: "ReleaseId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "RetrospectiveActionItems");

            migrationBuilder.DropTable(
                name: "RetrospectiveItems");

            migrationBuilder.DropTable(
                name: "RetrospectiveParticipants");

            migrationBuilder.DropTable(
                name: "Retrospectives");

            migrationBuilder.DropIndex(
                name: "IX_Principles_OrganisationId_IsOrganisationWide",
                table: "Principles");

            migrationBuilder.DropColumn(
                name: "IsOrganisationWide",
                table: "Principles");

            migrationBuilder.DropColumn(
                name: "OrganisationId",
                table: "Principles");
        }
    }
}
