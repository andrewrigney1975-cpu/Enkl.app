"use strict";
import { getCurrentProject } from '../store.js';
import { escapeHTML, getTaskById, getDocumentById, getRiskById, getPrincipleById, getObjectiveById, getMemberById, getReleaseById, memberLabel } from '../utils.js';
import { RISK_LIKELIHOOD_META, RISK_IMPACT_META, TEAM_COMMITTEE_TYPES } from '../config.js';
import { riskScore, riskScoreBand, buildTeamCommitteeTree, buildRiskMatrixSvg, getReleaseStatusMeta } from '../mutations.js';
import { markdownToHtml } from '../rich-text/markdown.js';
import { utcISOToLocalDisplayDate, memberInitials } from '../date-utils.js';
import { computeOrgChartLayout, ORGCHART_NODE_W, ORGCHART_NODE_H, ORGCHART_GAP_Y, ORGCHART_TYPE_ACCENT } from '../views/org-chart.js';
import { iconSvg } from '../icons.js';
import { strategyApi } from '../api.js';
import { buildRadarSvg, SERIES_COLORS } from '../views/strategy-radar.js';
import { markdownToDocHtml } from './markdown-doc.js';
import { downloadBlob } from './svg-export.js';

/* =========================================================
   ENTITY REPORTS — a single generic, printable report view shared by Risks/Decisions/Principles/
   Objectives (openReportOverlay(entityType)), rather than four near-identical bespoke views. Each
   entity config below is the only per-entity-type knowledge this module needs: how to list its
   items, how (or whether) to render a ratings block, and which of its own fields are id-links to
   other entities. Printing is the platform's own window.print() — the on-screen overlay is a normal
   .kf-overlay/.kf-modal like every other read-only view in this app; @media print rules in
   styles.css isolate just this overlay's content when the browser's print dialog opens.

   openProjectManagementReportOverlay() below reuses this exact same #reportOverlay/print-CSS
   machinery for a second, composite report — project header + team info + all four entity reports
   concatenated into one document — rather than standing up a second overlay (and a second copy of
   the print-reset CSS) for what is structurally the same "long, possibly multi-page, must-not-be-
   clipped-by-the-on-screen-scroll-container" printable view.
   ========================================================= */

function byKey(a, b){ return a.key.localeCompare(b.key, undefined, {numeric: true}); }

var ENTITY_CONFIGS = {
  risks: {
    title: 'Risks',
    getItems: function(project){ return (project.risks || []).slice().sort(byKey); },
    renderRatings: function(item){
      var score = riskScore(item);
      var band = riskScoreBand(score);
      var likelihoodLabel = (RISK_LIKELIHOOD_META[item.likelihood] || {}).label || item.likelihood;
      var impactLabel = (RISK_IMPACT_META[item.impact] || {}).label || item.impact;
      return '<div class="kf-report-ratings">' +
        '<span class="kf-risk-score-badge ' + band + '">Score ' + score + ' — ' + band.charAt(0).toUpperCase() + band.slice(1) + '</span>' +
        '<span class="kf-report-rating-detail">Likelihood: ' + escapeHTML(String(likelihoodLabel)) + '</span>' +
        '<span class="kf-report-rating-detail">Impact: ' + escapeHTML(String(impactLabel)) + '</span>' +
      '</div>';
    },
    relatedFields: [
      {label: 'Documents', idsField: 'documentIds', resolver: getDocumentById},
      {label: 'Principles', idsField: 'principleIds', resolver: getPrincipleById},
      {label: 'Objectives', idsField: 'objectiveIds', resolver: getObjectiveById},
      {label: 'Task', idField: 'taskId', resolver: getTaskById}
    ]
  },
  decisions: {
    title: 'Decisions',
    getItems: function(project){ return (project.decisions || []).slice().sort(byKey); },
    renderRatings: null,
    relatedFields: [
      {label: 'Documents', idsField: 'documentIds', resolver: getDocumentById},
      {label: 'Risks', idsField: 'riskIds', resolver: getRiskById},
      {label: 'Principles', idsField: 'principleIds', resolver: getPrincipleById},
      {label: 'Objectives', idsField: 'objectiveIds', resolver: getObjectiveById},
      {label: 'Task', idField: 'taskId', resolver: getTaskById}
    ]
  },
  principles: {
    title: 'Principles',
    getItems: function(project){ return (project.principles || []).slice().sort(byKey); },
    renderRatings: null,
    // Principle has no id-link fields at all — its only relational field is a plain external
    // documentUrl string, handled as a special case in renderRelatedEntities below.
    relatedFields: []
  },
  objectives: {
    title: 'Objectives',
    getItems: function(project){ return (project.objectives || []).slice().sort(byKey); },
    renderRatings: null,
    relatedFields: [
      {label: 'Principles', idsField: 'principleIds', resolver: getPrincipleById}
    ]
  }
};

function renderRelatedEntities(project, item, config){
  var groups = [];
  (config.relatedFields || []).forEach(function(f){
    if(f.idsField){
      var resolved = (item[f.idsField] || []).map(function(id){ return f.resolver(project, id); }).filter(Boolean);
      if(resolved.length) groups.push({label: f.label, items: resolved});
    } else if(f.idField && item[f.idField]){
      var single = f.resolver(project, item[f.idField]);
      if(single) groups.push({label: f.label, items: [single]});
    }
  });
  if(item.documentUrl){
    groups.push({label: 'Reference URL', items: [{url: item.documentUrl}]});
  }

  if(groups.length === 0){
    return '<div class="kf-report-related kf-report-related-empty">No related entities.</div>';
  }
  return '<div class="kf-report-related">' + groups.map(function(g){
    var itemsHTML = g.items.map(function(it){
      if(it.url){
        return '<a href="' + escapeHTML(it.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(it.url) + '</a>';
      }
      return '<span class="kf-dep-key">' + escapeHTML(it.key) + '</span><span class="kf-dep-title">' + escapeHTML(it.title) + '</span>';
    }).join(', ');
    return '<div class="kf-report-related-group"><span class="kf-report-related-label">' + escapeHTML(g.label) + ':</span> ' + itemsHTML + '</div>';
  }).join('') + '</div>';
}

/* extraFields (optional): an array of {label, value} shown between the ratings/description and the
   related-entities block — used only by the consolidated Project Management Report (closure dates +
   mitigations per risk, approver per decision), never by the standalone single-entity reports, which
   stick to the plain title/description/ratings/related template they were built to. */
function renderReportItem(project, item, config, extraFields){
  var descHTML = item.description
    ? '<div class="kf-richtext-content">' + markdownToHtml(item.description) + '</div>'
    : '<div class="kf-report-no-desc">No description.</div>';
  var ratingsHTML = config.renderRatings ? config.renderRatings(item) : '';
  var extraHTML = (extraFields && extraFields.length)
    ? '<div class="kf-report-extra-fields">' + extraFields.map(function(f){
        return '<div class="kf-report-extra-field"><span class="kf-report-extra-field-label">' + escapeHTML(f.label) + ':</span> ' + escapeHTML(f.value || '—') + '</div>';
      }).join('') + '</div>'
    : '';
  var relatedHTML = renderRelatedEntities(project, item, config);
  return '<div class="kf-report-item">' +
    '<h3 class="kf-report-item-title"><span class="kf-report-item-key">' + escapeHTML(item.key) + '</span>' + escapeHTML(item.title) + '</h3>' +
    descHTML + ratingsHTML + extraHTML + relatedHTML +
  '</div>';
}

export function openReportOverlay(entityType){
  var config = ENTITY_CONFIGS[entityType];
  var project = getCurrentProject();
  if(!config || !project) return;

  document.getElementById('reportTitle').textContent = project.name + ' - ' + config.title;

  var items = config.getItems(project);
  var bodyEl = document.getElementById('reportBody');
  bodyEl.innerHTML = items.length
    ? items.map(function(item){ return renderReportItem(project, item, config); }).join('')
    : '<div class="kf-health-empty">No ' + config.title.toLowerCase() + ' yet.</div>';

  document.getElementById('reportOverlay').classList.remove('hidden');
}
export function closeReportOverlay(){
  document.getElementById('reportOverlay').classList.add('hidden');
  // Clears openReleaseNotesReportOverlay's own marker class so a later, different report opened
  // against this same shared #reportBody doesn't inherit its page-break CSS scoping.
  document.getElementById('reportBody').classList.remove('kf-release-notes-report');
  // Reset for the next open — same "only the opener that needs it turns it on" convention as the
  // marker class above. Only openGuideOverlay ever unhides this; every other report has nothing
  // meaningful to offer as a raw-document download the way a guide's own source text does.
  document.getElementById('reportDownloadBtn').classList.add('kf-vis-hidden');
}
export function isReportOverlayOpen(){
  return !document.getElementById('reportOverlay').classList.contains('hidden');
}
export function printReport(){
  window.print();
}

/* =========================================================
   GUIDE VIEWER — USER-GUIDE.md / SYSTEMS-INTEGRATOR-GUIDE.md, rendered read-only and printable,
   reusing this exact same #reportOverlay/print-CSS machinery (see the module doc comment above) —
   the whole point of that shared overlay is exactly this: any new "long, printable, read-only"
   content is another consumer, not a reason to stand up a second overlay. Both guides' raw Markdown
   text is embedded into the built bundle at build time (build.js reads the two .md files directly and
   injects them as window.USER_GUIDE_MARKDOWN / window.SYSTEMS_INTEGRATOR_GUIDE_MARKDOWN globals —
   see that file's own comment) rather than fetched at runtime, keeping this a genuinely offline-
   capable, single-file app with no server round trip needed to view either guide.
   ========================================================= */

var GUIDE_CONFIGS = {
  userGuide: {title: 'User Guide', filename: 'Enklr Task User Guide.html', markdownGlobal: 'USER_GUIDE_MARKDOWN'},
  systemsIntegratorGuide: {title: 'Systems Integrator Guide', filename: 'Enklr Task Systems Integrator Guide.html', markdownGlobal: 'SYSTEMS_INTEGRATOR_GUIDE_MARKDOWN'}
};

var _activeGuideConfig = null;

export function openGuideOverlay(which){
  var config = GUIDE_CONFIGS[which];
  var markdown = config && window[config.markdownGlobal];
  if(!config || !markdown) return;
  _activeGuideConfig = config;

  document.getElementById('reportTitle').textContent = config.title;
  document.getElementById('reportBody').innerHTML = '<div class="kf-guide-doc">' + markdownToDocHtml(markdown) + '</div>';
  document.getElementById('reportDownloadBtn').classList.remove('kf-vis-hidden');
  document.getElementById('reportOverlay').classList.remove('hidden');
}

/* Downloads a small, self-contained HTML file — the same rendered markup just shown on screen,
   wrapped in a minimal styled shell — rather than the raw .md source, so a teammate who opens it
   later (in any browser, no app install needed) sees the same formatted guide, not bare Markdown
   syntax. Only ever wired to #reportDownloadBtn while a guide is the open report (see
   closeReportOverlay's own reset), so _activeGuideConfig is always set when this actually runs. */
export function downloadActiveGuide(){
  if(!_activeGuideConfig) return;
  var bodyHtml = document.getElementById('reportBody').innerHTML;
  var html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>' + escapeHTML(_activeGuideConfig.title) + '</title>' +
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;line-height:1.5;color:#172b4d;}' +
    'h1,h2,h3,h4{color:#0c2c52;} table{border-collapse:collapse;width:100%;margin:12px 0;} th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;}' +
    'th{background:#f4f5f7;} pre{background:#f4f5f7;padding:12px;overflow-x:auto;border-radius:4px;} code{background:#f4f5f7;padding:1px 4px;border-radius:3px;}' +
    'blockquote{border-left:3px solid #ddd;margin:0;padding-left:14px;color:#5e6c84;} hr{border:none;border-top:1px solid #ddd;margin:24px 0;}</style>' +
    '</head><body>' + bodyHtml + '</body></html>';
  downloadBlob(new Blob([html], {type: 'text/html'}), _activeGuideConfig.filename);
}

/* =========================================================
   PROJECT MANAGEMENT REPORT — project header + team info + all four entity reports, in that order:
   Principles, Objectives, Risks (matrix + per-risk closure/mitigation detail), Decisions (+approver).
   Launched from the "Projects..." menu rather than an entity modal, but shares the same #reportOverlay
   as the single-entity reports above.
   ========================================================= */

function renderProjectHeader(project){
  var startLabel = project.startDate ? utcISOToLocalDisplayDate(project.startDate) : '—';
  var endLabel = project.endDate ? utcISOToLocalDisplayDate(project.endDate) : '—';
  var descHTML = project.description
    ? '<div class="kf-richtext-content kf-report-project-description">' + markdownToHtml(project.description) + '</div>'
    : '';
  return '<h1 class="kf-report-page-title">' + escapeHTML(project.name) + ' (' + escapeHTML(project.key) + ')</h1>' +
    '<div class="kf-report-project-dates">Start: ' + escapeHTML(startLabel) + '&nbsp;&nbsp;·&nbsp;&nbsp;End: ' + escapeHTML(endLabel) + '</div>' +
    descHTML;
}

/* "Project team members and their roles, derived from the Team hierarchy structure" — walks the
   team/committee tree (not the flat project.members array) and collects the unique set of members
   that actually belong to a team or committee, so a member with no team affiliation at all doesn't
   appear here (their existence is instead implied by not appearing under any node in the Team
   Structure section below). */
function renderTeamMembersSection(project){
  var tree = buildTeamCommitteeTree(project);
  var seen = {};
  var members = [];
  tree.forEach(function(entry){
    (entry.node.memberIds || []).forEach(function(id){
      if(seen[id]) return;
      var m = getMemberById(project, id);
      if(m){ seen[id] = true; members.push(m); }
    });
  });
  members.sort(function(a, b){ return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}); });

  var rowsHTML = members.length
    ? members.map(function(m){
        return '<div class="kf-report-member-row">' +
          '<span class="kf-avatar kf-avatar-sm" style="background:' + m.color + ';">' + escapeHTML(memberInitials(m.name)) + '</span>' +
          '<span class="kf-report-member-name">' + escapeHTML(memberLabel(m)) + '</span>' +
          '<span class="kf-report-member-role">' + escapeHTML(m.role || 'No role set') + '</span>' +
        '</div>';
      }).join('')
    : '<div class="kf-health-empty">No members are part of the team structure yet.</div>';

  return '<div class="kf-report-section">' +
    '<h2 class="kf-report-section-heading">Team Members</h2>' +
    '<div class="kf-report-member-list">' + rowsHTML + '</div>' +
  '</div>';
}

/* Static (non-interactive) rendering of one org-chart type's tree — same layout math
   (computeOrgChartLayout) and node/edge markup as views/org-chart.js's own renderOrgChart, just
   without the pan/zoom/popover chrome a printed report has no use for. Returns '' if this project
   has no teams/committees of the given type, so the caller can skip the sub-heading entirely rather
   than printing an empty chart. */
function buildOrgChartSvg(project, filterType){
  var hasAny = (project.teamsCommittees || []).some(function(tc){ return tc.type === filterType; });
  if(!hasAny) return '';

  var layout = computeOrgChartLayout(project, filterType);
  var accent = ORGCHART_TYPE_ACCENT[filterType];

  var edgesHTML = layout.edges.map(function(e){
    var fromPos = layout.positions[e.fromId], toPos = layout.positions[e.toId];
    if(!fromPos || !toPos) return '';
    var px = fromPos.x + ORGCHART_NODE_W / 2, py = fromPos.y + ORGCHART_NODE_H;
    var cx = toPos.x + ORGCHART_NODE_W / 2, cy = toPos.y;
    var midY = py + ORGCHART_GAP_Y / 2;
    var path = 'M ' + px + ' ' + py + ' L ' + px + ' ' + midY + ' L ' + cx + ' ' + midY + ' L ' + cx + ' ' + cy;
    return '<path d="' + path + '" fill="none" stroke="var(--kf-border-strong)" stroke-width="2"></path>';
  }).join('');

  var nodesHTML = layout.nodes.map(function(n){
    var tc = n.tc;
    var members = tc.memberIds || [];
    var name = tc.name.length > 22 ? tc.name.slice(0, 21) + '…' : tc.name;
    return (
      '<g transform="translate(' + n.x + ',' + n.y + ')">' +
        '<rect x="0" y="0" width="' + n.w + '" height="' + n.h + '" rx="6" style="fill:var(--kf-surface);stroke:var(--kf-border);" stroke-width="1.5"></rect>' +
        '<rect x="0" y="0" width="5" height="' + n.h + '" rx="2" fill="' + accent + '"></rect>' +
        '<text x="16" y="18" font-size="10" font-weight="700" style="fill:var(--kf-text-faint);">' + escapeHTML(tc.key) + '</text>' +
        '<text x="16" y="36" font-size="13" font-weight="600" style="fill:var(--kf-text);"><title>' + escapeHTML(tc.name) + '</title>' + escapeHTML(name) + '</text>' +
        '<g transform="translate(16,' + (n.h - 16) + ')" style="color:var(--kf-text-faint);">' + iconSvg('team', 13) + '</g>' +
        '<text x="34" y="' + (n.h - 5) + '" font-size="11" font-weight="600" style="fill:var(--kf-text-faint);">' + members.length + '</text>' +
      '</g>'
    );
  }).join('');

  var svg = '<svg width="' + layout.width + '" height="' + layout.height + '" viewBox="0 0 ' + layout.width + ' ' + layout.height + '" xmlns="http://www.w3.org/2000/svg">' +
    edgesHTML + nodesHTML +
  '</svg>';

  return '<div class="kf-report-org-chart">' + svg + '</div>';
}

/* Renders both the Team and Committee org charts (whichever have data — see buildOrgChartSvg), each
   scaled by CSS (.kf-report-org-chart svg { max-width: 100%; height: auto; }, styles.css) to fit the
   printed page's width, same "shrink an SVG chart to the page" pattern renderRisksSection already
   uses for the Risk Matrix. Only labeled per-type when both are present, so a project with just teams
   (the common case) doesn't get a redundant "Team" sub-heading above its one chart. */
function renderOrgChartsForReport(project){
  var teamSvg = buildOrgChartSvg(project, 'team');
  var committeeSvg = buildOrgChartSvg(project, 'committee');
  if(!teamSvg && !committeeSvg) return '';

  if(teamSvg && committeeSvg){
    return (
      '<h3 class="kf-report-org-chart-subheading">' + escapeHTML(TEAM_COMMITTEE_TYPES.team) + 's</h3>' + teamSvg +
      '<h3 class="kf-report-org-chart-subheading">' + escapeHTML(TEAM_COMMITTEE_TYPES.committee) + 's</h3>' + committeeSvg
    );
  }
  return teamSvg || committeeSvg;
}

/* The indented team/committee hierarchy itself (Teams & Committees), each node showing its own
   members — reuses buildTeamCommitteeTree's flat {node, depth} list exactly as
   modals/teams-committees.js's own renderTeamsCommitteesList does, just without the interactive
   expand/collapse chrome a read-only report doesn't need. */
function renderTeamHierarchySection(project){
  var tree = buildTeamCommitteeTree(project);
  var rowsHTML = tree.length
    ? tree.map(function(entry){
        var node = entry.node, depth = entry.depth;
        var members = (node.memberIds || []).map(function(id){ return getMemberById(project, id); }).filter(Boolean);
        var typeLabel = node.type === 'committee' ? 'Committee' : 'Team';
        var membersHTML = members.length
          ? '<div class="kf-report-team-tree-members">' + members.map(function(m){ return escapeHTML(memberLabel(m)); }).join(', ') + '</div>'
          : '';
        return '<div class="kf-report-team-tree-row" style="padding-left:' + (depth * 20) + 'px;">' +
          '<span class="kf-report-team-tree-name">' + escapeHTML(node.name) + '</span>' +
          '<span class="kf-report-team-tree-type">' + typeLabel + '</span>' +
          membersHTML +
        '</div>';
      }).join('')
    : '<div class="kf-health-empty">No teams or committees defined yet.</div>';

  return '<div class="kf-report-section">' +
    '<h2 class="kf-report-section-heading">Team Structure</h2>' +
    renderOrgChartsForReport(project) +
    '<div class="kf-report-team-tree">' + rowsHTML + '</div>' +
  '</div>';
}

function renderEntitySection(project, entityType, extraFieldsFn){
  var config = ENTITY_CONFIGS[entityType];
  var items = config.getItems(project);
  var itemsHTML = items.length
    ? items.map(function(item){ return renderReportItem(project, item, config, extraFieldsFn ? extraFieldsFn(item) : null); }).join('')
    : '<div class="kf-health-empty">No ' + config.title.toLowerCase() + ' yet.</div>';
  return '<div class="kf-report-section">' +
    '<h2 class="kf-report-section-heading">' + escapeHTML(config.title) + '</h2>' +
    itemsHTML +
  '</div>';
}

function decisionExtraFields(item){
  return [{label: 'Approver', value: item.approver}];
}

function riskExtraFields(item){
  return [
    {label: 'Mitigations', value: item.mitigations},
    {label: 'Target closure date', value: item.dateToClose ? utcISOToLocalDisplayDate(item.dateToClose) : ''},
    {label: 'Date closed', value: item.dateClosed ? utcISOToLocalDisplayDate(item.dateClosed) : ''}
  ];
}

/* The Risk Matrix is a section-level overview (one chart for all risks), placed above the per-risk
   detail list — same reading order as the Risks modal's own view (summary chart first, detail
   after). buildRiskMatrixSvg is the exact function that view already uses; no reimplementation. */
function renderRisksSection(project){
  var config = ENTITY_CONFIGS.risks;
  var items = config.getItems(project);
  var matrixHTML = items.length ? '<div class="kf-report-risk-matrix">' + buildRiskMatrixSvg(items, 480) + '</div>' : '';
  var itemsHTML = items.length
    ? items.map(function(item){ return renderReportItem(project, item, config, riskExtraFields(item)); }).join('')
    : '<div class="kf-health-empty">No risks yet.</div>';
  return '<div class="kf-report-section">' +
    '<h2 class="kf-report-section-heading">Risks</h2>' +
    matrixHTML + itemsHTML +
  '</div>';
}

export function openProjectManagementReportOverlay(){
  var project = getCurrentProject();
  if(!project) return;

  document.getElementById('reportTitle').textContent = project.name + ' - Project Management Report';

  var bodyEl = document.getElementById('reportBody');
  bodyEl.innerHTML =
    renderProjectHeader(project) +
    renderTeamMembersSection(project) +
    renderTeamHierarchySection(project) +
    renderEntitySection(project, 'principles') +
    renderEntitySection(project, 'objectives') +
    renderRisksSection(project) +
    renderEntitySection(project, 'decisions', decisionExtraFields);

  document.getElementById('reportOverlay').classList.remove('hidden');
}

/* =========================================================
   STRATEGY ON A PAGE — a single printable page showing how the org's WHOLE portfolio maps onto its
   active Strategy, aggregated into exactly two series (never per-project, unlike the interactive
   Strategy dashboard's Compare mode): every currently-active project averaged together, and every
   inactive/planned project averaged together. Deliberately org-wide/cross-project (like the Portfolio
   Dashboard), so — same as that feature — this is only ever reachable by an Org Admin; a regular
   project member has no surface in this app for cross-project aggregates at all.

   Unlike every other report in this file, the data isn't already sitting on the in-memory `project`
   object — it's fetched fresh via strategyApi.getFulfilmentMatrix(null) (the unfiltered, whole-org
   matrix) at open time, so this is the one report function in this module that's asynchronous.
   Reuses the exact same #reportOverlay/print-CSS machinery as every report above.
   ========================================================= */

/* Average of every project's fulfilment value for one pillar, EXCLUDING projects with no value set
   for it at all — same "don't count an absence as 0" rule as StrategyFulfilmentService.BuildMatrixAsync's
   own org-wide aggregate, just recomputed here over a caller-chosen project subset (active-only /
   inactive-only) instead of every project. Returns null (not 0) when nothing in this subset has an
   opinion on this pillar at all. */
function averageFulfilmentForPillar(projects, pillarId){
  var values = projects.map(function(p){ return p.fulfilment[pillarId]; }).filter(function(v){ return v != null; });
  if(values.length === 0) return null;
  return values.reduce(function(a, b){ return a + b; }, 0) / values.length;
}

function pillarValuesForProjects(pillars, projects){
  var values = {};
  pillars.forEach(function(p){
    var avg = averageFulfilmentForPillar(projects, p.id);
    if(avg != null) values[p.id] = avg;
  });
  return values;
}

function renderStrategyOnAPageProjectList(projects, color, label){
  var itemsHTML = projects.length
    ? projects.map(function(p){
        return '<div class="kf-report-strategy-page-project-row"><span class="kf-dep-key">' + escapeHTML(p.projectKey) + '</span><span class="kf-dep-title">' + escapeHTML(p.projectName) + '</span></div>';
      }).join('')
    : '<div class="kf-report-no-desc">None.</div>';
  return '<div class="kf-report-strategy-page-group">' +
    '<h3 class="kf-report-strategy-page-group-heading"><span class="kf-strategy-radar-legend-swatch" style="background:' + color + '"></span>' + escapeHTML(label) + ' (' + projects.length + ')</h3>' +
    itemsHTML +
  '</div>';
}

function bySortOrder(a, b){ return a.sortOrder - b.sortOrder; }

/* Every Metric hanging off the tree, flattened — Pillar-level and Enabler-level alike — so their
   latest recorded values can all be fetched together in one Promise.all rather than nested per level. */
function collectMetricsFromTree(tree){
  var metrics = [];
  (tree || []).forEach(function(p){
    (p.metrics || []).forEach(function(m){ metrics.push(m); });
    (p.enablers || []).forEach(function(en){
      (en.metrics || []).forEach(function(m){ metrics.push(m); });
    });
  });
  return metrics;
}

/* "Current value" for a Metric is its most recently recorded StrategyMetricEntry, not the target —
   the tree read (StrategyPillarService.GetPillarTreeAsync) only returns each Metric's own definition
   (name/target/unit), never its history, so this is a genuinely separate fetch per metric. Returns a
   {metricId: latestEntry|null} map; null means "no value recorded yet", not an error. */
function fetchLatestMetricValues(metrics){
  if(metrics.length === 0) return Promise.resolve({});
  return Promise.all(metrics.map(function(m){
    return strategyApi.getMetricHistory(m.id).then(function(history){
      return {id: m.id, latest: (history && history.length) ? history[history.length - 1] : null};
    }, function(){ return {id: m.id, latest: null}; });
  })).then(function(results){
    var byId = {};
    results.forEach(function(r){ byId[r.id] = r.latest; });
    return byId;
  });
}

function formatMetricValue(value, unitLabel){
  return unitLabel ? (value + ' ' + unitLabel) : String(value);
}

function renderStrategyOnAPageMetricRow(m, latestByMetricId){
  var latest = latestByMetricId[m.id];
  var currentText = latest ? formatMetricValue(latest.value, m.unitLabel) : 'No value recorded yet';
  var targetText = m.targetValue != null ? formatMetricValue(m.targetValue, m.unitLabel) : '—';
  return '<div class="kf-report-strategy-page-metric-row">' +
    '<span class="kf-report-strategy-page-metric-name">' + escapeHTML(m.name) + '</span>' +
    '<span class="kf-report-strategy-page-metric-value">Current: ' + escapeHTML(currentText) + '</span>' +
    '<span class="kf-report-strategy-page-metric-target">Target: ' + escapeHTML(targetText) + '</span>' +
  '</div>';
}

function renderStrategyOnAPagePillarDefinition(p, latestByMetricId){
  var metricsHTML = (p.metrics || []).slice().sort(bySortOrder).map(function(m){ return renderStrategyOnAPageMetricRow(m, latestByMetricId); }).join('');
  var enablersHTML = (p.enablers || []).slice().sort(bySortOrder).map(function(en){
    var enMetricsHTML = (en.metrics || []).slice().sort(bySortOrder).map(function(m){ return renderStrategyOnAPageMetricRow(m, latestByMetricId); }).join('');
    return '<div class="kf-report-strategy-page-enabler">' +
      '<h4 class="kf-report-strategy-page-enabler-heading">' + escapeHTML(en.name) + '</h4>' +
      (en.description ? '<div class="kf-report-strategy-page-desc">' + escapeHTML(en.description) + '</div>' : '') +
      (enMetricsHTML || '<div class="kf-report-no-desc">No metrics.</div>') +
    '</div>';
  }).join('');

  return '<div class="kf-report-strategy-page-pillar">' +
    '<h3 class="kf-report-strategy-page-pillar-heading">' + escapeHTML(p.name) + '</h3>' +
    (p.description ? '<div class="kf-report-strategy-page-desc">' + escapeHTML(p.description) + '</div>' : '') +
    (metricsHTML || '<div class="kf-report-no-desc">No metrics directly on this Pillar.</div>') +
    enablersHTML +
  '</div>';
}

/* The full Pillar -> Enabler/Metric definition tree, with each Metric's current (most recently
   recorded) value alongside its target — placed BEFORE the project-based radar/membership section
   below, so a reader sees what the Strategy actually consists of before seeing how the portfolio
   scores against it. */
function renderStrategyDefinitionSection(tree, latestByMetricId){
  if(!tree || tree.length === 0){
    return '<div class="kf-report-section"><h2 class="kf-report-section-heading">Strategy Definition</h2><div class="kf-health-empty">No pillars defined yet.</div></div>';
  }
  var pillarsHTML = tree.slice().sort(bySortOrder).map(function(p){ return renderStrategyOnAPagePillarDefinition(p, latestByMetricId); }).join('');
  return '<div class="kf-report-section"><h2 class="kf-report-section-heading">Strategy Definition</h2>' + pillarsHTML + '</div>';
}

function buildStrategyOnAPageHTML(matrix, tree, latestByMetricId){
  if(!matrix || !matrix.activeStrategy || !matrix.pillars || matrix.pillars.length === 0){
    return '<div class="kf-health-empty">No active strategy with pillars has been defined for this organisation yet.</div>';
  }

  var activeProjects = matrix.projects.filter(function(p){ return p.isActive; });
  var inactiveProjects = matrix.projects.filter(function(p){ return !p.isActive; });
  var activeColor = SERIES_COLORS[0], inactiveColor = SERIES_COLORS[1];

  var series = [
    {label: 'Active Projects', values: pillarValuesForProjects(matrix.pillars, activeProjects), color: activeColor},
    {label: 'Inactive / Planned Projects', values: pillarValuesForProjects(matrix.pillars, inactiveProjects), color: inactiveColor}
  ];

  var definitionHTML = renderStrategyDefinitionSection(tree, latestByMetricId || {});
  var radarHTML = '<div class="kf-report-strategy-page-radar">' + buildRadarSvg(matrix.pillars, series, {size: 480}) + '</div>';
  var membershipHTML = '<div class="kf-report-strategy-page-membership">' +
    renderStrategyOnAPageProjectList(activeProjects, activeColor, 'Active Projects') +
    renderStrategyOnAPageProjectList(inactiveProjects, inactiveColor, 'Inactive / Planned Projects') +
  '</div>';

  return '<h1 class="kf-report-page-title">Strategy on a Page — ' + escapeHTML(matrix.activeStrategy.name) + '</h1>' +
    definitionHTML +
    '<h2 class="kf-report-section-heading">Portfolio vs. Strategy</h2>' +
    '<div class="kf-report-project-dates">Every active project averaged into one series, every inactive/planned project averaged into the other — a project with no fulfilment value set for a given pillar is excluded from that pillar\'s average, not counted as 0%.</div>' +
    radarHTML + membershipHTML;
}

export function openStrategyOnAPageReportOverlay(){
  document.getElementById('reportTitle').textContent = 'Strategy on a Page';
  var bodyEl = document.getElementById('reportBody');
  bodyEl.innerHTML = '<div class="kf-health-empty">Loading…</div>';
  document.getElementById('reportOverlay').classList.remove('hidden');
  var isClosed = function(){ return document.getElementById('reportOverlay').classList.contains('hidden'); };

  strategyApi.getFulfilmentMatrix(null).then(function(matrix){
    if(isClosed()) return; // closed before this resolved
    if(!matrix || !matrix.activeStrategy){
      bodyEl.innerHTML = buildStrategyOnAPageHTML(matrix, [], {});
      return;
    }
    strategyApi.getTree(matrix.activeStrategy.id).then(function(tree){
      if(isClosed()) return;
      fetchLatestMetricValues(collectMetricsFromTree(tree)).then(function(latestByMetricId){
        if(isClosed()) return;
        bodyEl.innerHTML = buildStrategyOnAPageHTML(matrix, tree, latestByMetricId);
      });
    }, function(){
      if(isClosed()) return;
      bodyEl.innerHTML = buildStrategyOnAPageHTML(matrix, [], {});
    });
  }, function(){
    if(isClosed()) return;
    bodyEl.innerHTML = '<div class="kf-health-empty">Could not load strategy data.</div>';
  });
}

/* =========================================================
   RELEASE NOTES PACKAGER — a single Release's printable notes: project title, release title/status/
   dates, "Release Manager" (this is the existing Owner field, just relabeled for this printed
   output — no separate manager field exists), and the release notes themselves. Reuses the same
   #reportOverlay/print-CSS machinery as the reports above (bespoke content, same shape as
   openProjectManagementReportOverlay, since a single fixed-shape item doesn't fit ENTITY_CONFIGS'
   list-of-many-items design at all). A marker class on #reportBody scopes the page-break CSS
   (styles.css) to just this report.
   ========================================================= */
/* liveNotesOverride: the release form's own getCurrentReleaseNotesDraft() — pass the editor's
   current (possibly unsaved) content so "Generate, then Print" without saving first previews what
   was actually just generated, not whatever's still persisted from before. Falls back to the
   persisted release.releaseNotes when null/undefined (e.g. this overlay is ever opened from
   somewhere other than the release form itself). */
export function openReleaseNotesReportOverlay(releaseId, liveNotesOverride){
  var project = getCurrentProject();
  var release = project ? getReleaseById(project, releaseId) : null;
  if(!project || !release) return;

  var notes = liveNotesOverride != null ? liveNotesOverride : release.releaseNotes;

  document.getElementById('reportTitle').textContent = project.name + ' - ' + release.name + ' Release Notes';

  var owner = release.ownerId ? getMemberById(project, release.ownerId) : null;
  var startLabel = release.startDate ? utcISOToLocalDisplayDate(release.startDate) : '—';
  var endLabel = release.endDate ? utcISOToLocalDisplayDate(release.endDate) : '—';
  var notesHTML = notes ? markdownToHtml(notes) : '<div class="kf-health-empty">No release notes yet.</div>';

  var bodyEl = document.getElementById('reportBody');
  bodyEl.classList.add('kf-release-notes-report');
  bodyEl.innerHTML =
    '<h1 class="kf-report-page-title">' + escapeHTML(project.name) + ' — ' + escapeHTML(release.name) + '</h1>' +
    '<div class="kf-report-project-dates">' +
      'Status: ' + escapeHTML(getReleaseStatusMeta(release.status).label) + '&nbsp;&nbsp;·&nbsp;&nbsp;' +
      'Start: ' + escapeHTML(startLabel) + '&nbsp;&nbsp;·&nbsp;&nbsp;' +
      'End: ' + escapeHTML(endLabel) + '&nbsp;&nbsp;·&nbsp;&nbsp;' +
      'Release Manager: ' + escapeHTML(owner ? memberLabel(owner) : 'Unassigned') +
    '</div>' +
    '<div class="kf-richtext-content">' + notesHTML + '</div>';

  document.getElementById('reportOverlay').classList.remove('hidden');
}
