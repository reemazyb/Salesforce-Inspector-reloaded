# Permissions (issue #1325)

Temporary design notes. Product docs live in `docs/permission-matrix.md`.

## Problem

Setup still requires several screens to answer:

- What can this user do?
- Which profiles or permission sets grant OLS or FLS on this object?
- What does this profile or permission set grant?

Native User Access Summary and Object Access exist. They are slow to search and they do not export.

## Shape

One page, three lenses, four tabs. One `AccessSnapshot`:

- `parents` (Profile, Permission Set, Permission Set Group as `PermissionSet` rows)
- `objectRows` (OLS per sobject, OR across parents, source labels)
- `fieldRows` (FLS when an object is selected)
- `userPerms` (boolean `Permissions*` on `PermissionSet`)
- `customPerms` (`SetupEntityAccess` + `CustomPermission`)

v1 is read-only. There is no FLS/OLS write, muting editor, or bulk assign.

## Related issues (not duplicates)

- [#688](https://github.com/tprouvot/Salesforce-Inspector-reloaded/issues/688) Copy/Paste FLS/OLS. Editing.
- [#860](https://github.com/tprouvot/Salesforce-Inspector-reloaded/issues/860) Field Creator FLS groups. Write path.
- [#1176](https://github.com/tprouvot/Salesforce-Inspector-reloaded/issues/1176) FLS visibility on Show All Data. Running-user describe vs EntityParticle.

## Queries

All calls use `sfConn.rest` with `method: "GET"`.
