"use strict";
import { toast } from '../ui.js';
import { escapeHTML, renderBoard, renderAssigneeFilterChips } from '../views/board.js';
import { getSsoConfigApi, updateSsoConfigApi, generateScimTokenApi, getOrgTeamsApi, applyOrgTeamToProjectApi, isOrgAdmin, getApiKeyApi, generateApiKeyApi, revokeApiKeyApi } from '../api.js';
import { getCurrentProject } from '../store.js';
import { isServerAuthoritative, refreshProjectFromServer } from '../features/migration.js';

/* Org Admin's SAML SSO + SCIM provisioning configuration screen — separate from
   modals/organisation.js's "Manage Users" (that manages the org's User accounts; this manages how
   they authenticate and how an identity provider can provision them). */

export function openSsoConfigModal(){
  if(!isOrgAdmin()){ toast('Only an organisation admin can manage SSO settings.'); return; }
  document.getElementById('ssoScimTokenReveal').classList.add('hidden');
  document.getElementById('ssoApiKeyReveal').classList.add('hidden');
  renderSsoConfig();
  renderOrgTeams();
  renderApiKeyStatus();
  document.getElementById('ssoConfigOverlay').classList.remove('hidden');
}
export function closeSsoConfigModal(){
  document.getElementById('ssoConfigOverlay').classList.add('hidden');
}

export function renderSsoConfig(){
  getSsoConfigApi().then(function(cfg){
    document.getElementById('ssoSamlEnabledInput').checked = cfg.samlEnabled;
    document.getElementById('ssoIdpEntityIdInput').value = cfg.idpEntityId || '';
    document.getElementById('ssoIdpSsoUrlInput').value = cfg.idpSsoUrl || '';
    document.getElementById('ssoIdpCertificateInput').value = '';
    document.getElementById('ssoCertificateStatus').textContent = cfg.hasIdpSigningCertificate
      ? 'A certificate is already configured. Paste a new one above only to replace it.'
      : 'No certificate configured yet.';
    document.getElementById('ssoJitProvisioningInput').checked = cfg.samlJitProvisioning;
    document.getElementById('ssoRequireSsoInput').checked = cfg.requireSso;
    document.getElementById('ssoSpEntityIdOutput').value = cfg.spEntityId;
    document.getElementById('ssoSpAcsUrlOutput').value = cfg.spAcsUrl;

    document.getElementById('ssoScimEnabledInput').checked = cfg.scimEnabled;
    document.getElementById('ssoScimBaseUrlOutput').value = cfg.scimBaseUrl;
    document.getElementById('ssoScimTokenStatus').textContent = cfg.hasScimToken
      ? 'A bearer token is already configured.'
      : 'No bearer token generated yet — SCIM cannot be enabled until you generate one.';
  }, function(e){
    toast('Could not load SSO settings: ' + (e.message || 'unknown error'));
  });
}

export function saveSsoConfigFromModal(){
  var samlEnabled = document.getElementById('ssoSamlEnabledInput').checked;
  var requireSso = document.getElementById('ssoRequireSsoInput').checked;
  var idpEntityId = document.getElementById('ssoIdpEntityIdInput').value.trim();
  var idpSsoUrl = document.getElementById('ssoIdpSsoUrlInput').value.trim();
  var idpSigningCertificate = document.getElementById('ssoIdpCertificateInput').value.trim();
  var samlJitProvisioning = document.getElementById('ssoJitProvisioningInput').checked;
  var scimEnabled = document.getElementById('ssoScimEnabledInput').checked;

  if(requireSso && !samlEnabled){ toast('Enable SAML before requiring it.'); return; }

  updateSsoConfigApi({
    samlEnabled: samlEnabled,
    idpEntityId: idpEntityId || null,
    idpSsoUrl: idpSsoUrl || null,
    idpSigningCertificate: idpSigningCertificate || null,
    samlJitProvisioning: samlJitProvisioning,
    requireSso: requireSso,
    scimEnabled: scimEnabled
  }).then(function(){
    toast('SSO settings saved.');
    renderSsoConfig();
  }, function(e){
    toast('Could not save SSO settings: ' + (e.message || 'unknown error'));
  });
}

export function generateScimTokenFromModal(){
  generateScimTokenApi().then(function(result){
    document.getElementById('ssoScimTokenOutput').value = result.token;
    document.getElementById('ssoScimTokenReveal').classList.remove('hidden');
    toast('New SCIM bearer token generated. Copy it now — it will not be shown again.');
    renderSsoConfig();
  }, function(e){
    toast('Could not generate a SCIM token: ' + (e.message || 'unknown error'));
  });
}

export function renderApiKeyStatus(){
  getApiKeyApi().then(function(key){
    if(!key.hasApiKey){
      document.getElementById('ssoApiKeyStatus').textContent = 'No API key generated yet.';
      return;
    }
    document.getElementById('ssoApiKeyStatus').textContent = key.enabled
      ? 'An API key is active' + (key.lastUsedAt ? ' — last used ' + new Date(key.lastUsedAt).toLocaleString() : ' — not used yet') + '.'
      : 'The API key has been revoked.';
  }, function(e){
    toast('Could not load API key status: ' + (e.message || 'unknown error'));
  });
}

export function generateApiKeyFromModal(){
  generateApiKeyApi().then(function(result){
    document.getElementById('ssoApiKeyOutput').value = result.key;
    document.getElementById('ssoApiKeyReveal').classList.remove('hidden');
    toast('New API key generated. Copy it now — it will not be shown again.');
    renderApiKeyStatus();
  }, function(e){
    toast('Could not generate an API key: ' + (e.message || 'unknown error'));
  });
}

export function revokeApiKeyFromModal(){
  revokeApiKeyApi().then(function(){
    document.getElementById('ssoApiKeyReveal').classList.add('hidden');
    toast('API key revoked.');
    renderApiKeyStatus();
  }, function(e){
    toast('Could not revoke the API key: ' + (e.message || 'unknown error'));
  });
}

/* Read-only — SCIM/the IdP owns Org Team membership, this app never creates/edits it directly (see
   OrgTeam's own server-side doc comment). The one action available per row, "Apply to project",
   only makes sense when a server-authoritative project is currently open — TeamCommitteeService.
   ApplyOrgTeamAsync needs a real Project to attach a TeamCommittee to. */
export function renderOrgTeams(){
  var listEl = document.getElementById('ssoOrgTeamsList');
  listEl.innerHTML = '<div class="kf-member-empty">Loading…</div>';
  var project = getCurrentProject();
  var canApply = isServerAuthoritative(project);

  getOrgTeamsApi().then(function(teams){
    if(!teams || teams.length === 0){
      listEl.innerHTML = '<div class="kf-member-empty">No Org Teams yet — these are created automatically when your identity provider syncs a group via SCIM.</div>';
      return;
    }
    listEl.innerHTML = '';
    teams.forEach(function(team){
      var row = document.createElement('div');
      row.className = 'kf-member-row kf-orguser-row';
      var memberNames = team.members.map(function(m){ return m.displayName; }).join(', ') || 'No members';
      row.innerHTML =
        '<div class="kf-orguser-row-name">' +
          '<div class="kf-orguser-display-name">' + escapeHTML(team.name) + '</div>' +
          '<div class="kf-orguser-username">' + escapeHTML(memberNames) + '</div>' +
        '</div>' +
        '<button class="kf-btn kf-btn-secondary" data-action="apply-org-team"' + (canApply ? '' : ' disabled title="Open a project migrated to the server first"') + '>Apply to project</button>';
      row.querySelector('[data-action="apply-org-team"]').addEventListener('click', function(){
        applyOrgTeamToProjectApi(project.serverProjectId, team.id).then(function(result){
          return refreshProjectFromServer(project.id).then(function(){
            renderBoard();
            renderAssigneeFilterChips();
            var message = 'Applied "' + team.name + '" to "' + project.name + '".';
            if(result.warnings && result.warnings.length){
              message += ' ' + result.warnings.join(' ');
            }
            toast(message);
          });
        }, function(e){
          toast('Could not apply "' + team.name + '": ' + (e.message || 'unknown error'));
        });
      });
      listEl.appendChild(row);
    });
  }, function(e){
    listEl.innerHTML = '<div class="kf-member-empty">Could not load Org Teams.</div>';
    toast('Could not load Org Teams: ' + (e.message || 'unknown error'));
  });
}
