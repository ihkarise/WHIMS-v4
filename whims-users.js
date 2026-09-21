/*
 * WHIMS v4.5 — User Management panel (frontend, additive)
 * ------------------------------------------------------------------
 * Renders a "User Management" card inside the existing Settings view for
 * ADMIN and MASTER_ADMIN only. It is a thin UI over the authorised backend
 * actions (listusers/createuser/updateuser/changerole/activate/deactivate/
 * resetpassword). Every authority decision is enforced server-side in Code.gs
 * — this module hides controls purely for usability and NEVER for security.
 * A tampered role in localStorage only changes what buttons show; the backend
 * still rejects any forbidden request.
 *
 * MASTER_ADMIN is a protected security level: it is never shown as a
 * selectable role and the frontend can never create or modify one.
 */
(function () {
  'use strict';
  if (window.WHIMSUsers) return;

  var D = document;
  function $(s, r) { return (r || D).querySelector(s); }
  function G(n) { try { return window[n]; } catch (e) { return undefined; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function toast(m, e) { if (typeof G('toast') === 'function') G('toast')(m, e); }
  function role() { return (typeof G('whimsRole') === 'function') ? G('whimsRole')() : ''; }
  function isUserAdmin() { return role() === 'ADMIN' || role() === 'MASTER_ADMIN'; }

  async function apiPost(body) {
    var ap = G('apiPost');
    if (typeof ap !== 'function') throw new Error('WHIMS API not ready');
    return ap(body);
  }

  // Roles this actor may assign — mirrors the backend canAssignRole exactly.
  // The backend is the enforcer; this only shapes the dropdown.
  function assignableRoles() {
    if (role() === 'MASTER_ADMIN') return ['ADMIN', 'OPERATOR', 'VIEWER'];
    if (role() === 'ADMIN') return ['OPERATOR', 'VIEWER'];
    return [];   // OPERATOR / VIEWER never see the panel at all
  }
  function canManage(targetRole) {
    targetRole = String(targetRole || '').toUpperCase();
    if (targetRole === 'MASTER_ADMIN') return false;
    if (role() === 'MASTER_ADMIN') return true;
    if (role() === 'ADMIN') return targetRole === 'OPERATOR' || targetRole === 'VIEWER';
    return false;
  }

  /* ---------------- mount / visibility ---------------- */
  function mount() {
    var view = $('#view-settings');
    if (!view) return;
    var card = $('#v45Users');
    if (!isUserAdmin()) { if (card) card.style.display = 'none'; return; }
    if (!card) {
      card = D.createElement('div');
      card.className = 'card glass';
      card.id = 'v45Users';
      // place near the top of Settings, after the Account card if present
      var acct = view.querySelector('.card');
      if (acct && acct.nextSibling) view.insertBefore(card, acct.nextSibling);
      else view.appendChild(card);
    }
    card.style.display = '';
    card.innerHTML =
      '<div class="view-title" style="margin:0 0 10px">User Management</div>' +
      '<p class="note" id="v45UAuth" style="margin-top:0"></p>' +
      '<div id="v45UList"><div class="spin"></div></div>' +
      '<div class="v45-u-addwrap">' +
      '<div class="v45-sec-title" style="margin-top:6px">Add user</div>' +
      '<div class="v45-u-form">' +
      '<input class="v45-in" id="v45UName" placeholder="Username" autocomplete="off">' +
      '<input class="v45-in" id="v45UDisplay" placeholder="Display name (optional)" autocomplete="off">' +
      '<input class="v45-in" id="v45UPass" type="password" placeholder="Password (min 8)" autocomplete="new-password">' +
      '<input class="v45-in" id="v45UPass2" type="password" placeholder="Confirm password" autocomplete="new-password">' +
      '<select class="v45-in" id="v45URole">' + roleOptions() + '</select>' +
      '<button class="v45-btn" id="v45UAdd">Create user</button>' +
      '</div></div>';
    $('#v45UAuth', card).textContent = 'You are signed in as ' + role() +
      '. Roles you can assign: ' + assignableRoles().join(', ') + '.';
    $('#v45UAdd', card).onclick = createUser;
    load();
  }

  function roleOptions(selected) {
    return assignableRoles().map(function (r) {
      return '<option value="' + r + '"' + (r === selected ? ' selected' : '') + '>' + r + '</option>';
    }).join('');
  }

  /* ---------------- list ---------------- */
  async function load() {
    var host = $('#v45UList'); if (!host) return;
    try {
      var res = await apiPost({ action: 'listusers' });
      var users = (res && res.users) || [];
      renderList(host, users);
    } catch (e) {
      host.innerHTML = '<div class="v45-var-note">Could not load users: ' + esc(e.message) + '</div>';
    }
  }

  function badge(r) { return '<span class="v45-rolebadge v45-role-' + esc(r) + '">' + esc(r) + '</span>'; }

  function renderList(host, users) {
    if (!users.length) { host.innerHTML = '<div class="v45-var-note">No users yet.</div>'; return; }
    host.innerHTML = '<div class="v45-u-table">' + users.map(function (u) {
      var manageable = canManage(u.role);
      var status = u.active ? '<span class="v45-u-active">Active</span>' : '<span class="v45-u-inactive">Inactive</span>';
      var actions = '';
      if (u.role === 'MASTER_ADMIN') {
        actions = '<span class="v45-u-locked" title="Master admin is managed only from the secure backend">🔒 protected</span>';
      } else if (manageable) {
        actions =
          '<button class="v45-ubtn" data-act="role" data-u="' + esc(u.username) + '" data-r="' + esc(u.role) + '">Change role</button>' +
          '<button class="v45-ubtn" data-act="reset" data-u="' + esc(u.username) + '">Reset password</button>' +
          '<button class="v45-ubtn ' + (u.active ? 'danger' : '') + '" data-act="' + (u.active ? 'deactivate' : 'activate') + '" data-u="' + esc(u.username) + '">' +
          (u.active ? 'Deactivate' : 'Activate') + '</button>';
      } else {
        actions = '<span class="v45-u-locked">—</span>';
      }
      return '<div class="v45-u-row">' +
        '<div class="v45-u-main"><b>' + esc(u.username) + '</b>' + (u.displayName ? ' <span class="v45-u-dn">' + esc(u.displayName) + '</span>' : '') +
        '<div class="v45-u-meta">' + badge(u.role) + ' · ' + status +
        (u.created ? ' · created ' + esc(String(u.created).slice(0, 10)) : '') +
        (u.lastLogin ? ' · last ' + esc(String(u.lastLogin).slice(0, 16)) : '') + '</div></div>' +
        '<div class="v45-u-actions">' + actions + '</div></div>';
    }).join('') + '</div>';

    host.querySelectorAll('.v45-ubtn').forEach(function (b) {
      b.onclick = function () { handleAction(b.dataset.act, b.dataset.u, b.dataset.r); };
    });
  }

  /* ---------------- actions ---------------- */
  async function createUser() {
    var name = ($('#v45UName').value || '').trim();
    var display = ($('#v45UDisplay').value || '').trim();
    var pw = $('#v45UPass').value;
    var pw2 = $('#v45UPass2').value;
    var r = $('#v45URole').value;
    if (!name) return toast('Enter a username', true);
    if (!pw || pw.length < 8) return toast('Password must be at least 8 characters', true);
    if (pw !== pw2) return toast('Passwords do not match', true);
    if (assignableRoles().indexOf(r) < 0) return toast('You cannot assign that role', true);
    $('#v45UAdd').disabled = true;
    try {
      await apiPost({ action: 'createuser', username: name, password: pw, role: r, displayName: display });
      toast('User "' + name + '" created ✓');
      $('#v45UName').value = ''; $('#v45UDisplay').value = ''; $('#v45UPass').value = ''; $('#v45UPass2').value = '';
      load();
    } catch (e) { toast(e.message, true); }
    $('#v45UAdd').disabled = false;
  }

  async function handleAction(act, username, currentRole) {
    try {
      if (act === 'deactivate') {
        if (!confirm('Deactivate "' + username + '"? They will be unable to log in.')) return;
        await apiPost({ action: 'deactivateuser', username: username });
        toast(username + ' deactivated');
      } else if (act === 'activate') {
        await apiPost({ action: 'activateuser', username: username });
        toast(username + ' reactivated');
      } else if (act === 'reset') {
        var np = prompt('New temporary password for "' + username + '" (min 8 chars):');
        if (np == null) return;
        if (String(np).length < 8) return toast('Password must be at least 8 characters', true);
        await apiPost({ action: 'resetpassword', username: username, password: np });
        toast('Password reset for ' + username + ' ✓');
      } else if (act === 'role') {
        var choices = assignableRoles();
        var nr = prompt('New role for "' + username + '" (' + choices.join(' / ') + '):', currentRole);
        if (nr == null) return;
        nr = String(nr).trim().toUpperCase();
        if (choices.indexOf(nr) < 0) return toast('You can only assign: ' + choices.join(', '), true);
        await apiPost({ action: 'changerole', username: username, role: nr });
        toast(username + ' is now ' + nr);
      }
      load();
    } catch (e) { toast(e.message, true); }
  }

  /* ---------------- boot / react to auth changes ---------------- */
  function boot() {
    mount();
    // re-render whenever role/auth changes (login, logout, me-refresh)
    D.addEventListener('whims:auth', function () { mount(); });
    // also re-mount when the user navigates to Settings (nav buttons)
    var nav = $('nav');
    if (nav) nav.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b && b.dataset.v === 'settings') setTimeout(mount, 0);
    });
  }

  window.WHIMSUsers = { version: '4.5.0', refresh: mount, _assignableRoles: assignableRoles, _canManage: canManage };

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
